import json
import os
import socket
import stat
import sys
from threading import Lock
from urllib.parse import urlsplit

import i18n
from i18n import t
from model import STREAM_ID, capture_reservation, reservation_id, server_origin

try:
    from media import PREVIEW_MAX_BYTES
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
        self.lock = Lock()
        self._enabled = False
        self.watch = 0
        self.pending = None
        self.started = False
        self.latest = None

    @property
    def enabled(self):
        with self.lock:
            return self._enabled

    @enabled.setter
    def enabled(self, value):
        with self.lock:
            self._enabled = bool(value)
            if not self._enabled:
                self.latest = None
                # The receiver may already hold the packet's header. Finish
                # that packet even when no more preview frames are requested.
                if not self.started:
                    self.pending = None
                if self.pending is None and self.watch:
                    GLib.source_remove(self.watch)
                    self.watch = 0

    def send_frame(self, jpeg):
        if not 0 < len(jpeg) <= PREVIEW_MAX_BYTES:
            return
        packet = memoryview(len(jpeg).to_bytes(4, "big") + jpeg)
        with self.lock:
            if not self._enabled:
                return
            # Finish a started packet to preserve framing, then use the newest
            # frame. An unsent packet can be replaced without adding latency.
            if self.pending is not None and self.started:
                self.latest = packet
            else:
                self.pending = packet
            self._flush_locked()
            if self.pending is not None and not self.watch:
                self.watch = GLib.io_add_watch(self.fd, GLib.PRIORITY_DEFAULT,
                    GLib.IOCondition.OUT | GLib.IOCondition.HUP | GLib.IOCondition.ERR, self._writable)

    def _flush_locked(self):
        while self.pending is not None:
            try:
                written = os.write(self.fd, self.pending)
            except BlockingIOError:
                return
            except OSError:
                self._enabled = False
                self.pending = self.latest = None
                self.started = False
                return
            if written == 0:
                return
            self.pending = self.pending[written:] or None
            self.started = self.pending is not None
            if self.pending is None:
                self.pending, self.latest = self.latest, None

    def _writable(self, _source, condition):
        with self.lock:
            if condition & (GLib.IOCondition.HUP | GLib.IOCondition.ERR):
                self._enabled = False
                self.pending = self.latest = None
                self.started = False
            else:
                self._flush_locked()
            if self.pending is None:
                self.watch = 0
                return GLib.SOURCE_REMOVE
            return GLib.SOURCE_CONTINUE


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

    def send_metrics(self, stream_id, quality, fps, mbps, elapsed, *, codec=None):
        # RTMP over TCP supplies no RTP loss/jitter reports. BaseSink.dropped counts
        # muxed output buffers, so it cannot describe dropped video frames either.
        self.send("stats", streamId=stream_id, width=quality.width, height=quality.height,
                  fps=round(fps, 1), mbps=round(mbps, 2), elapsed=max(0, elapsed),
                  packetLoss=None, jitterMs=None, framesDropped=None, codec=codec)

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
