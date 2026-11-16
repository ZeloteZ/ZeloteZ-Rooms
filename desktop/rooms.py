#!/usr/bin/env python3
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import parse_qs, urlsplit

try:
    import gi

    for namespace, version in (("Gtk", "4.0"), ("Adw", "1"), ("WebKit", "6.0")):
        gi.require_version(namespace, version)
    from gi.repository import Adw, Gio, GLib, Gtk, WebKit
except (ImportError, ValueError) as error:
    sys.exit(f"ZeloteZ Rooms needs GTK, Libadwaita and WebKitGTK. See desktop/README.md. ({error})")

import i18n
from i18n import t
from model import STREAM_ID, capture_reservation, reservation_id, server_origin


CHANNEL_ID = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")


class CaptureSession:
    def __init__(self, owner, channel):
        self._owner = owner
        self._channel = channel
        self._view = owner.web
        self._origin = urlsplit(owner.origin)
        self._closed = False

    @property
    def ready(self):
        return not self._closed and not self._owner.closing and self._owner.is_app_page(self._view.get_uri())

    def reserve(self, callback):
        if not self.ready:
            callback(None, t("Sign in to ZeloteZ Rooms again."))
            return

        def reserved(data, error):
            reason = data.get("error") if isinstance(data, dict) else None
            if error or not isinstance(data, dict) or reason:
                callback(None, error or reason or t("The live channel couldn’t prepare the stream."))
                return
            try:
                destination = capture_reservation(data, self._origin)
            except ValueError:
                self.finish(reservation_id(data))
                callback(None, t("The live channel returned an invalid stream destination."))
                return
            callback(destination, None)

        self._request("/api/channels/" + self._channel + "/streams", "POST", reserved)

    def _request(self, endpoint, method, callback=None):
        if self._owner.web != self._view or not self._owner.is_app_page(self._view.get_uri()):
            if callback:
                callback(None, t("Sign in to ZeloteZ Rooms again."))
            return
        script = (
            "const response = await fetch(" + json.dumps(endpoint) + ", {method:" + json.dumps(method)
            + ", credentials:'same-origin', cache:'no-store', redirect:'error', signal:AbortSignal.timeout(15000),"
            + " headers:{'Content-Type':'application/json','Accept-Language':document.documentElement.lang}, body:'{}'});"
            + "return response.status === 204 ? null : await response.json();"
        )

        def finished(view, result, *_data):
            try:
                value = view.call_async_javascript_function_finish(result)
                payload = json.loads(value.to_json(0)) if callback else None
            except (GLib.Error, TypeError, ValueError):
                if callback:
                    callback(None, t("The live channel didn’t respond. Try again."))
                return
            if callback:
                callback(payload, None)

        self._view.call_async_javascript_function(script, -1, None, None, None, None, finished)

    def set_live(self, _stream_id):
        pass

    def finish(self, stream_id):
        if isinstance(stream_id, str) and STREAM_ID.fullmatch(stream_id):
            self._request("/api/streams/" + stream_id, "DELETE")

    def close(self):
        self._closed = True


class RoomsWindow(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="ZeloteZ Rooms", default_width=1240, default_height=780)
        self.capture = None
        self.capture_channel = None
        self.web = None
        self.origin = ""
        self.closing = False
        self.permission_dialog = None
        self.config = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "zelotez-rooms" / "server"
        self.toolbar = Adw.ToolbarView()
        self.set_content(self.toolbar)
        header = Adw.HeaderBar()
        header.set_title_widget(Gtk.Label(label="ZeloteZ Rooms"))
        server = Gtk.Button(icon_name="emblem-system-symbolic", tooltip_text=t("Server settings"))
        server.connect("clicked", lambda *_: self.stack.set_visible_child_name("server"))
        header.pack_end(server)
        self.toolbar.add_top_bar(header)
        self.stack = Gtk.Stack()
        self.toolbar.set_content(self.stack)
        self._build_server_settings()
        self.connect("close-request", self._close_requested)
        try:
            saved = os.environ.get("ZELOTEZ_ROOMS_ORIGIN") or self.config.read_text()
            self.address.set_text(saved.strip())
            self._connect_server(remember=False)
        except OSError:
            pass

    def _build_server_settings(self):
        container = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14, halign=Gtk.Align.CENTER,
                            valign=Gtk.Align.CENTER, width_request=320, margin_start=20, margin_end=20)
        title = Gtk.Label(label=t("Connect to your server"), xalign=0)
        title.add_css_class("title-2")
        self.address = Gtk.Entry(placeholder_text="https://rooms.example.com", activates_default=False)
        self.address.connect("activate", lambda *_: self._connect_server())
        self.notice = Gtk.Label(xalign=0, wrap=True)
        connect = Gtk.Button(label=t("Connect"), halign=Gtk.Align.START)
        connect.add_css_class("suggested-action")
        connect.connect("clicked", lambda *_: self._connect_server())
        back = Gtk.Button(label=t("Back"), halign=Gtk.Align.START)
        back.connect("clicked", lambda *_: self.stack.set_visible_child_name("rooms" if self.web else "server"))
        for widget in (title, self.address, self.notice, connect, back):
            container.append(widget)
        self.stack.add_named(container, "server")

    def _connect_server(self, remember=True):
        try:
            origin = server_origin(self.address.get_text())
        except ValueError:
            self.notice.set_label(t("Enter an HTTPS server address or a local test URL."))
            return
        if remember:
            try:
                self.config.parent.mkdir(parents=True, exist_ok=True)
                self.config.write_text(origin + "\n")
            except OSError:
                self.notice.set_label(t("The server address couldn’t be saved."))
        self._close_capture()
        if self.web is not None:
            self.web.stop_loading()
            self.stack.remove(self.web)
        self.origin = origin
        network = WebKit.NetworkSession.new_ephemeral()
        network.connect("download-started", self._download_started)
        self.web = WebKit.WebView(network_session=network, hexpand=True, vexpand=True)
        settings = self.web.get_settings()
        settings.set_enable_media_stream(True)
        settings.set_enable_webrtc(True)
        manager = self.web.get_user_content_manager()
        manager.connect("script-message-received::roomsCapture", self._message)
        manager.register_script_message_handler("roomsCapture", None)
        self.web.connect("decide-policy", self._navigation_policy)
        self.web.connect("permission-request", self._permission_request)
        self.web.connect("load-failed", self._load_failed)
        self.web.connect("web-process-terminated", self._load_failed)
        self.stack.add_named(self.web, "rooms")
        self.stack.set_visible_child_name("rooms")
        self.web.load_uri(self.origin + "/?lang=" + i18n.LANGUAGE)

    def is_app_page(self, uri):
        if not uri or not self.origin:
            return False
        try:
            url = urlsplit(uri)
            origin = urlsplit(self.origin)
        except ValueError:
            return False
        query = parse_qs(url.query)
        return ((url.scheme, url.netloc) == (origin.scheme, origin.netloc) and url.path == "/"
                and (not url.query or query in ({"lang": ["en"]}, {"lang": ["de"]})))

    def _navigation_policy(self, _view, decision, kind):
        if kind == WebKit.PolicyDecisionType.RESPONSE and decision.is_main_frame_main_resource():
            if not self.is_app_page(decision.get_response().get_uri()):
                decision.ignore()
                self.notice.set_label(t("The server redirected to a different address."))
                self.stack.set_visible_child_name("server")
                return True
        if kind in (WebKit.PolicyDecisionType.NAVIGATION_ACTION, WebKit.PolicyDecisionType.NEW_WINDOW_ACTION):
            action = decision.get_navigation_action()
            uri = action.get_request().get_uri()
            if kind == WebKit.PolicyDecisionType.NAVIGATION_ACTION and self.is_app_page(uri):
                return False
            if action.is_user_gesture():
                try:
                    url = urlsplit(uri)
                    if url.scheme in ("http", "https") and url.hostname and url.username is None:
                        Gio.AppInfo.launch_default_for_uri(uri, None)
                except (GLib.Error, ValueError):
                    self._alert(t("The link couldn’t open in your browser."))
            decision.ignore()
            return True
        return False

    def _permission_request(self, view, request):
        if (self.permission_dialog is not None or not self.is_app_page(view.get_uri())
                or not isinstance(request, WebKit.UserMediaPermissionRequest)
                or not request.props.is_for_audio_device or request.props.is_for_video_device):
            request.deny()
            return True
        dialog = Adw.MessageDialog.new(self, t("Allow microphone access?"), t("The microphone is used for voice chat."))
        self.permission_dialog = dialog
        dialog.add_response("deny", t("Cancel"))
        dialog.add_response("allow", t("Allow"))
        dialog.set_close_response("deny")

        def answered(_dialog, response):
            self.permission_dialog = None
            if response == "allow" and not self.closing and view == self.web and self.is_app_page(view.get_uri()):
                request.allow()
            else:
                request.deny()

        dialog.connect("response", answered)
        dialog.present()
        return True

    def _download_started(self, _network, download):
        def choose(current, filename):
            dialog = Gtk.FileChooserNative.new(t("Save attachment"), self, Gtk.FileChooserAction.SAVE, t("Save"), t("Cancel"))
            dialog.set_current_name(Path(filename).name)

            def selected(picker, response):
                file = picker.get_file() if response == Gtk.ResponseType.ACCEPT else None
                if file is not None:
                    current.set_destination(file.get_uri())
                else:
                    current.cancel()
                picker.destroy()

            dialog.connect("response", selected)
            dialog.show()
            return True
        download.connect("decide-destination", choose)

    def _alert(self, message):
        dialog = Adw.MessageDialog.new(self, message, None)
        dialog.add_response("ok", "OK")
        dialog.present()

    def _load_failed(self, view, *_data):
        if not self.closing and view == self.web:
            self._close_capture()
            self.notice.set_label(t("Couldn’t connect to the server. Check the address and try again."))
            self.stack.set_visible_child_name("server")
        return True

    def _message(self, manager, value):
        if self.closing or self.web is None or manager != self.web.get_user_content_manager() or not self.is_app_page(self.web.get_uri()):
            return
        try:
            data = json.loads(value.to_json(0))
        except (TypeError, ValueError):
            return
        if not isinstance(data, dict):
            return
        action = data.get("action")
        if action == "session-ended":
            self._close_capture()
        if action == "language":
            language = data.get("language")
            if language in dict(i18n.LANGUAGES):
                i18n.LANGUAGE = language
                try:
                    i18n.save_language(language)
                except OSError:
                    pass
        if action != "open" or not isinstance(data.get("channelId"), str) or not CHANNEL_ID.fullmatch(data["channelId"]):
            return
        if self.capture is not None:
            if self.capture_channel == data["channelId"]:
                self.capture.present()
                return
            if self.capture.state in ("connecting", "live"):
                self.capture.present()
                self._alert(t("End your stream in the other live channel before sharing here."))
                return
            self._close_capture()
        if data.get("language") in dict(i18n.LANGUAGES):
            i18n.LANGUAGE = data["language"]
        try:
            from streamer import CaptureWindow
            self.capture = CaptureWindow(self.get_application(), room_session=CaptureSession(self, data["channelId"]), parent=self)
        except (ImportError, SystemExit, ValueError, RuntimeError) as error:
            self._alert(str(error))
            return
        self.capture_channel = data["channelId"]
        self.capture.connect("close-request", self._capture_closed)
        self.capture.present()

    def _capture_closed(self, _capture):
        self.capture = None
        self.capture_channel = None
        return False

    def _close_capture(self):
        if self.capture is not None:
            self.capture.close()

    def _close_requested(self, _window):
        self.closing = True
        self._close_capture()
        return False


class RoomsApp(Adw.Application):
    def __init__(self):
        super().__init__(application_id="de.zelotez.Rooms")
        self.window = None

    def do_activate(self):
        if self.window is None:
            Adw.StyleManager.get_default().set_color_scheme(Adw.ColorScheme.FORCE_DARK)
            self.window = RoomsWindow(self)
        self.window.present()


if __name__ == "__main__":
    sys.exit(RoomsApp().run(sys.argv))
