import json
import os
import socket
import stat
import sys
from urllib.parse import urlsplit

import i18n
from i18n import t
from model import STREAM_ID, capture_reservation, reservation_id, server_origin

try:
    from streamer import Adw, CaptureWindow, Gio, GLib, Gtk, initialize_media
except (ImportError, ValueError) as error:
    sys.exit(f"ZeloteZ Rooms native capture needs GTK, Libadwaita, libportal and GStreamer. ({error})")


MAX_MESSAGE = 4096


class PreviewPipe:
    def __init__(self, fd):
        mode = os.fstat(fd).st_mode
        if stat.S_ISSOCK(mode):
            with socket.socket(fileno=os.dup(fd)) as connection:
                if connection.family != socket.AF_UNIX:
                    raise RuntimeError("The preview requires a local pipe.")
        elif not stat.S_ISFIFO(mode):
            raise RuntimeError("The preview requires a local pipe.")
        os.set_blocking(fd, False)
        self.fd = fd
        self.enabled = False
        self.pending = None

    def send_frame(self, jpeg):
        if not self.enabled:
            return
        # Complete a partially written frame before sending any newer one.
        packet = self.pending
        if packet is None:
            packet = memoryview(len(jpeg).to_bytes(4, "big") + jpeg)
        try:
            written = os.write(self.fd, packet)
        except BlockingIOError:
            written = 0
        except OSError:
            self.enabled = False
            self.pending = None
            return
        self.pending = packet[written:] or None


class CaptureSession:
    def __init__(self, origin):
        self.origin = urlsplit(origin)
        self.ready = True
        self.request_id = 0
        self.pending = {}
        self.live_id = None
        self.on_live = None
        self.on_finish = None

    @staticmethod
    def send(action, **payload):
        try:
            print(json.dumps({"action": action, **payload}, separators=(",", ":")), flush=True)
        except OSError:
            return False
        return True

    def reserve(self, callback):
        if not self.ready or len(self.pending) >= 4:
            callback(None, t("The live channel couldn’t prepare the stream."))
            return
        self.request_id += 1
        if self.send("reserve", requestId=self.request_id):
            self.pending[self.request_id] = callback
        else:
            callback(None, t("The live channel didn’t respond. Try again."))

    def reserved(self, message):
        request_id = message.get("requestId")
        if type(request_id) is not int:
            return
        callback = self.pending.pop(request_id, None)
        if callback is None:
            return
        data = message.get("data")
        error = message.get("error")
        if isinstance(error, str) and error:
            callback(None, error[:240])
            return
        try:
            destination = capture_reservation(data, self.origin)
        except ValueError:
            self.finish(reservation_id(data))
            callback(None, t("The live channel returned an invalid stream destination."))
            return
        callback(destination, None)

    def finish(self, stream_id):
        if isinstance(stream_id, str) and STREAM_ID.fullmatch(stream_id):
            self.send("finish", streamId=stream_id)
            if stream_id == self.live_id:
                self.live_id = None
                if self.on_finish is not None:
                    self.on_finish()

    def set_live(self, stream_id):
        if stream_id:
            self.live_id = stream_id
            self.send("live", streamId=stream_id)
            if self.on_live is not None:
                self.on_live()

    def send_metrics(self, stream_id, quality, fps, mbps, elapsed):
        self.send("stats", streamId=stream_id, width=quality.width, height=quality.height,
                  fps=round(fps, 1), mbps=round(mbps, 2), elapsed=max(0, elapsed))

    def close(self):
        self.ready = False
        self.pending.clear()


class CaptureApp(Adw.Application):
    def __init__(self, session, preview=None, *, engine="standard"):
        super().__init__(application_id="de.zelotez.Rooms.Capture", flags=Gio.ApplicationFlags.NON_UNIQUE)
        self.session = session
        self.preview = preview
        self.engine = engine
        self.window = None
        self.stdin = sys.stdin.fileno()
        self.buffer = b""

    def do_activate(self):
        if self.window is None:
            Adw.StyleManager.get_default().set_color_scheme(Adw.ColorScheme.FORCE_DARK)
            if self.preview is None:
                self.window = CaptureWindow(self, self.session, engine=self.engine)
            else:
                self.session.on_live = self.hide_capture
                self.session.on_finish = self.finish_embedded
                self.window = CaptureWindow(self, self.session, preview_frame=self.preview.send_frame, engine=self.engine,
                                            on_metrics=self.session.send_metrics)
            GLib.io_add_watch(self.stdin, GLib.PRIORITY_DEFAULT,
                              GLib.IOCondition.IN | GLib.IOCondition.HUP | GLib.IOCondition.ERR, self.read_command)
            self.window.present()
            if not self.session.send("ready"):
                self.stop_capture()

    def hide_capture(self):
        self.preview.enabled = True
        self.window.set_visible(False)

    def finish_embedded(self):
        self.preview.enabled = False
        GLib.idle_add(self.stop_capture)

    def stop_capture(self):
        if self.window is not None:
            window, self.window = self.window, None
            # Hidden GTK windows have no mapped surface to deliver a close request to.
            window.close_requested(window)
            window.destroy()
            self.quit()
        return GLib.SOURCE_REMOVE

    def read_command(self, _source, _condition):
        try:
            received = os.read(self.stdin, MAX_MESSAGE + 1)
        except OSError:
            received = b""
        if received:
            lines = (self.buffer + received).split(b"\n")
            self.buffer = lines.pop()
            if len(self.buffer) <= MAX_MESSAGE and all(len(line) <= MAX_MESSAGE for line in lines):
                for line in lines:
                    try:
                        message = json.loads(line)
                    except (UnicodeError, ValueError, RecursionError):
                        continue
                    if isinstance(message, dict):
                        action = message.get("action")
                        if action == "close":
                            break
                        if action == "reservation":
                            self.session.reserved(message)
                else:
                    return GLib.SOURCE_CONTINUE
        return self.stop_capture()


def main(argv):
    engine = "rooms" if argv[-1:] == ["--engine=rooms"] else "standard"
    if engine == "rooms":
        argv = argv[:-1]
    probe = argv in (["--probe"], ["--probe-embedded"])
    embedded = argv[2:] == ["--preview-fd", "3"]
    if not probe:
        if len(argv) != (4 if embedded else 2) or argv[1] not in dict(i18n.LANGUAGES):
            return 2
        try:
            origin = server_origin(argv[0])
        except ValueError:
            return 2
        i18n.LANGUAGE = argv[1]
    try:
        if not Gtk.init_check():
            raise RuntimeError("A graphical session is required for native capture.")
        initialize_media(embedded or argv == ["--probe-embedded"], engine=engine)
        preview = PreviewPipe(3) if embedded else None
    except (GLib.Error, OSError, RuntimeError) as error:
        print(error, file=sys.stderr)
        return 1
    if probe:
        print("ok", flush=True)
        return 0
    GLib.set_application_name(i18n.APP_NAME)
    return CaptureApp(CaptureSession(origin), preview, engine=engine).run([sys.argv[0]])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
