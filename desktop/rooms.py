#!/usr/bin/env python3
import json
import os
import re
import sys
from collections import deque
from pathlib import Path
from threading import Thread
from time import monotonic
from urllib.parse import urlsplit
from uuid import uuid4

try:
    import gi

    for namespace, version in (("Gtk", "4.0"), ("Adw", "1"), ("WebKit", "6.0")):
        gi.require_version(namespace, version)
    from gi.repository import Adw, Gio, GLib, Gtk, WebKit
except (ImportError, ValueError) as error:
    sys.exit(f"ZeloteZ Rooms needs GTK, Libadwaita and WebKitGTK. See desktop/README.md. ({error})")

import i18n
from i18n import t
from instance import InstanceVerificationError, has_rooms_page_headers, verify_instance
from model import STREAM_ID, capture_reservation, reservation_id, server_origin
from notifications import DesktopNotifications


CHANNEL_ID = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")
VERIFICATION_ERRORS = {
    "invalid": "Enter an HTTPS server address or a local test URL.",
    "unreachable": "Couldn’t verify the server. Check the address, certificate and connection.",
    "not_rooms": "This address did not identify itself as a ZeloteZ Rooms instance.",
    "incompatible": "This Rooms instance uses an unsupported desktop protocol.",
}
THEMES = ("dark", "system", "light")
THEME_LABELS = ("Dark", "System", "Light")
COLOR_SCHEMES = (Adw.ColorScheme.FORCE_DARK, Adw.ColorScheme.DEFAULT, Adw.ColorScheme.FORCE_LIGHT)
LANGUAGES = ("system", *(key for key, _label in i18n.LANGUAGES))
NOTIFICATION_KINDS = ("mention", "friend-request", "direct-message", "live")
NOTIFICATION_ID = re.compile(r"[a-zA-Z0-9:_-]{1,128}")
NOTIFICATION_PATH = re.compile(rf"#/(?:direct/{CHANNEL_ID.pattern}|rooms/{CHANNEL_ID.pattern}/{CHANNEL_ID.pattern})")
NOTIFICATION_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\ud800-\udfff]")
BRIDGE_WORLD = "ZeloteZRooms"
BRIDGE_EVENT = "zelotez-rooms-native"
BRIDGE_PUBLIC = f"""
const webkit = window.webkit ??= {{}};
const handlers = webkit.messageHandlers ??= {{}};
handlers.roomsCapture = Object.freeze({{
    postMessage(value) {{
        if (!value || typeof value !== 'object') return;
        const detail = JSON.stringify(value);
        if (typeof detail === 'string' && detail.length <= 4096)
            document.dispatchEvent(new CustomEvent('{BRIDGE_EVENT}', {{ detail }}));
    }}
}});
"""
BRIDGE_PRIVATE = f"""
document.addEventListener('{BRIDGE_EVENT}', event => {{
    if (event.target === document && typeof event.detail === 'string' && event.detail.length <= 4096)
        window.webkit.messageHandlers.roomsCapture.postMessage(event.detail);
}});
"""


def notification_route(href, kind):
    if not isinstance(href, str) or len(href) > 250:
        return None
    if kind == "friend-request":
        return href if href == "#/friends" else None
    path, separator, query = href.partition("?")
    if not NOTIFICATION_PATH.fullmatch(path):
        return None
    direct = path.startswith("#/direct/")
    if (kind == "direct-message" and not direct) or (kind == "live" and direct):
        return None
    if not separator:
        return href
    parameters = {}
    for pair in query.split("&"):
        key, _, value = pair.partition("=")
        if key in parameters:
            return None
        parameters[key] = value
    for key, value in parameters.items():
        if key == "message" and CHANNEL_ID.fullmatch(value):
            continue
        if key == "stream" and not direct and STREAM_ID.fullmatch(value):
            continue
        return None
    return href


class CaptureSession:
    def __init__(self, owner, channel):
        self._owner = owner
        self._channel = channel
        self._view = owner.web
        self._origin = urlsplit(owner.origin)
        self._closed = False

    @property
    def ready(self):
        return (not self._closed and not self._owner.closing and self._owner.web_ready
                and self._owner.web == self._view and self._owner.is_app_page(self._view.get_uri()))

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
        if (self._owner.web != self._view or not self._owner.web_ready
                or not self._owner.is_app_page(self._view.get_uri())):
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


class InstanceControls(Gtk.Box):
    def __init__(self, owner, address="", on_connect=None):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=14)
        self.owner = owner
        self.on_connect = on_connect
        self.active = True
        self.pending = False
        self.checked = None
        self.revision = 0
        self.message = ("Check the address, then connect when you’re ready.", {})
        self.address = Gtk.Entry(placeholder_text="https://rooms.example.com", activates_default=False,
                                 max_length=2048, text=address)
        self.address.connect("changed", self._address_changed)
        self.address.connect("activate", lambda *_: self.check())
        self.status = Gtk.Label(xalign=0, wrap=True)
        self.status.add_css_class("dim-label")
        self.check_button = Gtk.Button()
        self.check_button.connect("clicked", lambda *_: self.check())
        self.connect_button = Gtk.Button()
        self.connect_button.add_css_class("suggested-action")
        self.connect_button.connect("clicked", lambda *_: self.check(connect=True))
        buttons = Gtk.Box(spacing=10)
        buttons.append(self.check_button)
        buttons.append(self.connect_button)
        for widget in (self.address, buttons, self.status):
            self.append(widget)
        self.translate()
        self._sync()

    def translate(self):
        self.address.update_property([Gtk.AccessibleProperty.LABEL], [t("Server address")])
        self.check_button.set_label(t("Check address"))
        self.connect_button.set_label(t("Connect"))
        self.status.set_label(t(self.message[0], **self.message[1]))

    def show_status(self, message, **values):
        self.message = message, values
        self.status.set_label(t(message, **values))

    def _sync(self):
        self.check_button.set_sensitive(not self.pending and bool(self.address.get_text().strip()))
        self.connect_button.set_sensitive(not self.pending and self.checked is not None)

    def _address_changed(self, _entry):
        self.revision += 1
        self.checked = None
        self.show_status("Check the address, then connect when you’re ready.")
        self._sync()

    def check(self, connect=False, saved=False, remember=True):
        if self.pending or not self.active:
            return
        try:
            address = server_origin(self.address.get_text())
        except ValueError:
            self.show_status(VERIFICATION_ERRORS["invalid"])
            return
        if connect and not saved and self.checked != address:
            self.show_status("Check this server before connecting.")
            return
        self.pending = True
        self.checked = None
        revision = self.revision
        self.show_status("Checking server …")
        self._sync()

        def finished(origin, error):
            self.pending = False
            if not self.active:
                return
            if self.revision == revision:
                if error is not None:
                    self.show_status(VERIFICATION_ERRORS.get(error, VERIFICATION_ERRORS["unreachable"]))
                elif connect:
                    self.owner._connect_verified(origin, remember)
                    if self.on_connect:
                        self.on_connect()
                else:
                    self.checked = origin
                    if origin == self.owner.origin and self.owner.web_ready:
                        self.show_status("This Rooms instance is already open.")
                    else:
                        self.show_status("Rooms instance verified. You can connect now.")
            self._sync()

        if not self.owner._verify_server(address, finished):
            self.pending = False
            self.show_status("Checking another address. Try again in a moment.")
            self._sync()


class RoomsWindow(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="ZeloteZ Rooms", default_width=1240, default_height=780)
        self.capture = None
        self.capture_channel = None
        self.web = None
        self.web_ready = False
        self.page_approved = False
        self.page_rejected = False
        self.pending_remember = False
        self.origin = ""
        self.closing = False
        self.verifying = False
        self.preferences = None
        self.permission_dialog = None
        self.notification_targets = {}
        self.notification_times = deque()
        self.notification_presenter = DesktopNotifications(app, self._open_notification)
        self.desktop_notifications = i18n.read_setting("desktop-notifications", "true") != "false"
        self.minimize_on_close = i18n.read_setting("minimize-on-close", "true") != "false"
        self.minimize_hint_seen = i18n.read_setting("minimize-hint", "") == "seen"
        self.minimize_hint = None
        self.theme = i18n.read_setting("appearance", "dark")
        if self.theme not in THEMES:
            self.theme = "dark"
        self.language_choice = i18n.read_setting("desktop-language", "")
        self.prefer_desktop_language = self.language_choice in LANGUAGES
        if not self.prefer_desktop_language:
            self.language_choice = i18n.configured_language()
        self._apply_language()
        self._apply_theme()
        self.toolbar = Adw.ToolbarView()
        self.set_content(self.toolbar)
        header = Adw.HeaderBar()
        header.set_title_widget(Gtk.Label(label="ZeloteZ Rooms"))
        self.settings_button = Gtk.Button(icon_name="emblem-system-symbolic", tooltip_text=t("Desktop settings"))
        preferences_action = Gio.SimpleAction.new("preferences", None)
        preferences_action.connect("activate", lambda *_: self._open_preferences())
        self.add_action(preferences_action)
        self.settings_button.set_action_name("win.preferences")
        app.set_accels_for_action("win.preferences", ["<Primary>comma"])
        header.pack_end(self.settings_button)
        self.toolbar.add_top_bar(header)
        self.stack = Gtk.Stack()
        self.toolbar.set_content(self.stack)
        self._build_setup()
        self.connect("close-request", self._close_requested)
        self._open_saved_server()

    def _open_saved_server(self):
        explicit = os.environ.get("ZELOTEZ_ROOMS_ORIGIN")
        if explicit:
            self.setup.address.set_text(explicit.strip())
            self.setup.check(connect=True, saved=True, remember=False)
            return
        saved = i18n.read_setting("server", "")
        if not saved:
            return
        try:
            saved_profile = json.loads(saved)
        except (ValueError, RecursionError):
            self.setup.address.set_text(saved)
            self.setup.show_status("Check your saved server before connecting.")
            return
        if (isinstance(saved_profile, dict) and saved_profile.get("protocol") == 1
                and isinstance(saved_profile.get("origin"), str)):
            self.setup.address.set_text(saved_profile["origin"])
            self.setup.check(connect=True, saved=True, remember=False)

    def _build_setup(self):
        container = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14, halign=Gtk.Align.CENTER,
                            valign=Gtk.Align.CENTER, width_request=340, margin_start=20, margin_end=20)
        self.setup_title = Gtk.Label(label=t("Connect to your server"), xalign=0)
        self.setup_title.add_css_class("title-2")
        self.setup = InstanceControls(self)
        container.append(self.setup_title)
        container.append(self.setup)
        self.stack.add_named(container, "server")

    def _apply_theme(self):
        Adw.StyleManager.get_default().set_color_scheme(COLOR_SCHEMES[THEMES.index(self.theme)])

    def _apply_language(self):
        if self.language_choice == "system":
            system = GLib.get_language_names()[0].split("_")[0].split(".")[0].lower()
            i18n.LANGUAGE = system if system in dict(i18n.LANGUAGES) else i18n.DEFAULT_LANGUAGE
        else:
            i18n.LANGUAGE = self.language_choice

    def _open_preferences(self):
        if self.preferences is not None:
            self.preferences.present()
            return
        window = Adw.PreferencesWindow(application=self.get_application(), transient_for=self, modal=True,
                                       default_width=545, default_height=505, search_enabled=False)
        page = Adw.PreferencesPage()
        desktop = Adw.PreferencesGroup()
        appearance_model = Gtk.StringList.new([t(name) for name in THEME_LABELS])
        language_model = Gtk.StringList.new([t("System"), *(label for _key, label in i18n.LANGUAGES)])
        appearance = Adw.ComboRow(model=appearance_model, selected=THEMES.index(self.theme))
        language = Adw.ComboRow(model=language_model, selected=LANGUAGES.index(self.language_choice))
        desktop.add(appearance)
        desktop.add(language)
        notifications = Adw.SwitchRow(active=self.desktop_notifications)
        desktop.add(notifications)
        close_behavior = Adw.SwitchRow(active=self.minimize_on_close)
        desktop.add(close_behavior)
        quit_row = Adw.ActionRow(activatable=True, action_name="app.quit")
        quit_row.add_suffix(Gtk.Image(icon_name="application-exit-symbolic"))
        desktop.add(quit_row)
        server = Adw.PreferencesGroup()
        address = self.origin or self.setup.address.get_text()
        controls = InstanceControls(self, address, window.close)
        server.add(controls)
        page.add(desktop)
        page.add(server)
        window.add(page)
        window.set_visible_page(page)
        self.preferences = window
        translating = False

        def translate():
            nonlocal translating
            translating = True
            try:
                window.set_title(t("Desktop settings"))
                desktop.set_title(t("Desktop app"))
                appearance.set_title(t("Appearance"))
                appearance.set_subtitle(t("Appearance for desktop settings and capture windows."))
                appearance_model.splice(0, appearance_model.get_n_items(), [t(name) for name in THEME_LABELS])
                appearance.set_selected(THEMES.index(self.theme))
                language.set_title(t("Language"))
                language.set_subtitle(t("Language for the desktop controls."))
                labels = [t("System"), *(label for _key, label in i18n.LANGUAGES)]
                language_model.splice(0, language_model.get_n_items(), labels)
                language.set_selected(LANGUAGES.index(self.language_choice))
                notifications.set_title(t("Desktop notifications"))
                notifications.set_subtitle(t("Show system notifications for activity in Rooms."))
                server.set_title(t("Your Rooms instance"))
                close_behavior.set_title(t("Minimize when closing"))
                close_behavior.set_subtitle(t("Keep ZeloteZ Rooms running in the taskbar when you close the window."))
                quit_row.set_title(t("Quit ZeloteZ Rooms"))
                server.set_description(t("Current server · {origin}", origin=self.origin) if self.origin else "")
                controls.translate()
                self.setup.translate()
                self.settings_button.set_tooltip_text(t("Desktop settings"))
                self.setup_title.set_label(t("Connect to your server"))
            finally:
                translating = False

        def changed_theme(row, _property):
            if translating or row.get_selected() >= len(THEMES):
                return
            self.theme = THEMES[row.get_selected()]
            self._apply_theme()
            try:
                i18n.save_setting("appearance", self.theme)
            except OSError:
                controls.show_status("The desktop settings couldn’t be saved.")

        def changed_language(row, _property):
            if translating or row.get_selected() >= len(LANGUAGES):
                return
            self.language_choice = LANGUAGES[row.get_selected()]
            self.prefer_desktop_language = True
            self._apply_language()
            translate()
            try:
                i18n.save_setting("desktop-language", self.language_choice)
            except OSError:
                controls.show_status("The desktop settings couldn’t be saved.")

        def changed_close_behavior(row, _property):
            self.minimize_on_close = row.get_active()
            try:
                i18n.save_setting("minimize-on-close", "true" if self.minimize_on_close else "false")
            except OSError:
                controls.show_status("The desktop settings couldn’t be saved.")

        def changed_notifications(row, _property):
            self.desktop_notifications = row.get_active()
            if not self.desktop_notifications:
                self._clear_notifications()
            try:
                i18n.save_setting("desktop-notifications", "true" if self.desktop_notifications else "false")
            except OSError:
                controls.show_status("The desktop settings couldn’t be saved.")

        def closed(_window):
            controls.active = False
            self.preferences = None
            return False

        appearance.connect("notify::selected", changed_theme)
        language.connect("notify::selected", changed_language)
        notifications.connect("notify::active", changed_notifications)
        close_behavior.connect("notify::active", changed_close_behavior)
        window.connect("close-request", closed)
        translate()
        window.present()

    def _verify_server(self, origin, callback):
        if self.verifying:
            return False
        self.verifying = True

        def deliver(result, error):
            self.verifying = False
            if not self.closing:
                callback(result, error)
            return GLib.SOURCE_REMOVE

        def work():
            try:
                result = verify_instance(origin)
            except InstanceVerificationError as error:
                GLib.idle_add(deliver, None, error.code)
            else:
                GLib.idle_add(deliver, result, None)

        Thread(target=work, daemon=True).start()
        return True

    def _remember_server(self):
        try:
            i18n.save_setting("server", json.dumps({"origin": self.origin, "protocol": 1}))
        except OSError:
            self._alert(t("The server address couldn’t be saved."))

    def _connect_verified(self, origin, remember):
        if self.closing:
            return
        if self.web is not None and origin == self.origin and self.web_ready:
            if remember:
                self._remember_server()
            return
        self._close_capture()
        self._clear_notifications()
        self.pending_remember = remember
        self.web_ready = False
        self.page_approved = False
        self.page_rejected = False
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
        manager.register_script_message_handler("roomsCapture", BRIDGE_WORLD)
        frames = WebKit.UserContentInjectedFrames.TOP_FRAME
        time = WebKit.UserScriptInjectionTime.START
        # A same-document relay preserves the web API without exposing the native handler to page frames.
        guard = "if (location.origin !== " + json.dumps(self.origin) + ") return;"
        public = f"(() => {{ {guard} {BRIDGE_PUBLIC} }})();"
        private = f"(() => {{ {guard} {BRIDGE_PRIVATE} }})();"
        manager.add_script(WebKit.UserScript.new_for_world(private, frames, time, BRIDGE_WORLD))
        manager.add_script(WebKit.UserScript.new(public, frames, time))
        self.web.connect("decide-policy", self._navigation_policy)
        self.web.connect("permission-request", self._permission_request)
        self.web.connect("load-failed", self._load_failed)
        self.web.connect("load-changed", self._load_changed)
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
        return ((url.scheme, url.netloc) == (origin.scheme, origin.netloc) and url.path == "/"
                and url.query in ("", "lang=en", "lang=de"))

    def _navigation_policy(self, view, decision, kind):
        if view != self.web:
            decision.ignore()
            return True
        if kind == WebKit.PolicyDecisionType.RESPONSE and decision.is_main_frame_main_resource():
            response = decision.get_response()
            headers = response.get_http_headers()
            self.page_approved = (self.is_app_page(response.get_uri()) and headers is not None
                                  and has_rooms_page_headers(response.get_status_code(), headers.get_list("Content-Type"),
                                                             headers.get_list("X-ZeloteZ-Rooms-Client")))
            if not self.page_approved:
                decision.ignore()
                self._connection_error("The server sent an unexpected page.")
                return True
        if kind in (WebKit.PolicyDecisionType.NAVIGATION_ACTION, WebKit.PolicyDecisionType.NEW_WINDOW_ACTION):
            action = decision.get_navigation_action()
            uri = action.get_request().get_uri()
            if action.is_redirect():
                decision.ignore()
                self._connection_error("The server tried to redirect the connection.")
                return True
            if kind == WebKit.PolicyDecisionType.NAVIGATION_ACTION and self.is_app_page(uri):
                return False
            if self.web_ready and action.is_user_gesture():
                blob_id = uri.removeprefix("blob:" + self.origin + "/")
                if (kind == WebKit.PolicyDecisionType.NAVIGATION_ACTION
                        and action.get_navigation_type() == WebKit.NavigationType.LINK_CLICKED
                        and self.is_app_page(view.get_uri())
                        and blob_id != uri and CHANNEL_ID.fullmatch(blob_id)):
                    # Chat attachments are decrypted to same-origin blobs and downloaded explicitly.
                    decision.download()
                    return True
                try:
                    url = urlsplit(uri)
                    if url.scheme in ("http", "https") and url.hostname and url.username is None:
                        Gio.AppInfo.launch_default_for_uri(uri, None)
                except (GLib.Error, ValueError):
                    self._alert(t("The link couldn’t open in your browser."))
            decision.ignore()
            return True
        return False

    def _load_changed(self, view, event):
        if view != self.web:
            return
        if event == WebKit.LoadEvent.STARTED:
            self.web_ready = False
            self.page_approved = False
            self.page_rejected = False
        elif event == WebKit.LoadEvent.COMMITTED and self.page_approved:
            self.web_ready = True
            if self.pending_remember:
                self.pending_remember = False
                self._remember_server()

    def _permission_request(self, view, request):
        if (self.permission_dialog is not None or not self.web_ready or view != self.web
                or not self.is_app_page(view.get_uri())
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
            if (response == "allow" and not self.closing and self.web_ready
                    and view == self.web and self.is_app_page(view.get_uri())):
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
                path = file.get_path() if file is not None else None
                if path is not None:
                    current.set_destination(path)
                else:
                    current.cancel()
                    if file is not None:
                        self._alert(t("Choose a local location to save the attachment."))
                picker.destroy()

            dialog.connect("response", selected)
            dialog.show()
            return True
        download.connect("decide-destination", choose)

    def _alert(self, message):
        dialog = Adw.MessageDialog.new(self, message, None)
        dialog.add_response("ok", "OK")
        dialog.present()

    def _connection_error(self, message):
        self.web_ready = False
        self.page_approved = False
        self.page_rejected = True
        self.pending_remember = False
        self._close_capture()
        if self.setup.address.get_text() != self.origin:
            self.setup.address.set_text(self.origin)
        self.setup.show_status(message)
        self.stack.set_visible_child_name("server")

    def _load_failed(self, view, *_data):
        if not self.closing and view == self.web and not self.page_rejected:
            self._connection_error("Couldn’t connect to the server. Check the address and try again.")
        return True

    def _message(self, manager, value):
        if (self.closing or self.web is None or not self.web_ready
                or manager != self.web.get_user_content_manager() or not self.is_app_page(self.web.get_uri())):
            return
        try:
            raw = value.to_string() if value.is_string() else None
            data = json.loads(raw) if raw and len(raw) <= 4096 else None
        except (TypeError, ValueError, RecursionError):
            return
        if not isinstance(data, dict):
            return
        action = data.get("action")
        if action == "session-ended":
            self._close_capture()
            self._clear_notifications()
            return
        if action == "notification":
            self._notify(data)
            return
        if action == "language":
            language = data.get("language")
            if isinstance(language, str) and language in dict(i18n.LANGUAGES):
                if not self.prefer_desktop_language:
                    self.language_choice = language
                    self._apply_language()
                    self.settings_button.set_tooltip_text(t("Desktop settings"))
                    self.setup_title.set_label(t("Connect to your server"))
                    self.setup.translate()
                try:
                    i18n.save_language(language)
                except OSError:
                    pass
            return
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

    def _notify(self, data):
        if not self.desktop_notifications:
            return
        identifier, kind = data.get("id"), data.get("kind")
        title, body = data.get("title"), data.get("body")
        href = notification_route(data.get("href"), kind)
        if (kind not in NOTIFICATION_KINDS or not href
                or not isinstance(identifier, str) or not NOTIFICATION_ID.fullmatch(identifier)
                or not isinstance(title, str) or len(title) > 180
                or not isinstance(body, str) or len(body) > 360):
            return
        title = " ".join(NOTIFICATION_CONTROL.sub(" ", title).split())
        body = " ".join(NOTIFICATION_CONTROL.sub(" ", body).split())
        if not title:
            return
        identifier = f"{kind}:{identifier}"
        if any(item[0] == identifier for item in self.notification_targets.values()):
            return
        now = monotonic()
        while self.notification_times and self.notification_times[0] <= now - 15:
            self.notification_times.popleft()
        if len(self.notification_times) >= 5:
            return
        self.notification_times.append(now)
        if len(self.notification_targets) >= 128:
            oldest = next(iter(self.notification_targets))
            del self.notification_targets[oldest]
            self.notification_presenter.withdraw(oldest)
        key = uuid4().hex
        self.notification_targets[key] = identifier, href
        self.notification_presenter.send(key, title, body)

    def _clear_notifications(self):
        for key in self.notification_targets:
            self.notification_presenter.withdraw(key)
        self.notification_targets.clear()
        self.notification_times.clear()

    def _open_notification(self, key):
        if self.closing or not self.web_ready or not self.is_app_page(self.web.get_uri()):
            return
        target = self.notification_targets.get(key)
        if target:
            self.present()
            self.web.evaluate_javascript("location.hash = " + json.dumps(target[1]), -1)

    def prepare_quit(self):
        self.closing = True
        self._close_capture()
        self._clear_notifications()

    def _move_to_background(self):
        if self.minimize_hint is not None:
            self.minimize_hint.present()
            return
        if self.minimize_hint_seen:
            self.minimize()
            return
        self.minimize_hint_seen = True
        try:
            i18n.save_setting("minimize-hint", "seen")
        except OSError:
            pass
        hint = Adw.MessageDialog.new(
            self, t("Keep ZeloteZ Rooms running?"),
            t("Open it from the taskbar. To quit, use Desktop settings or Ctrl+Q."),
        )
        self.minimize_hint = hint
        hint.add_response("cancel", t("Cancel"))
        hint.add_response("minimize", t("Minimize"))
        hint.set_default_response("minimize")
        hint.set_close_response("cancel")
        hint.set_response_appearance("minimize", Adw.ResponseAppearance.SUGGESTED)

        def answered(_dialog, action):
            self.minimize_hint = None
            if action == "minimize" and not self.closing:
                self.minimize()

        hint.connect("response", answered)
        hint.present()

    def _close_requested(self, _window):
        if self.minimize_on_close and self.stack.get_visible_child_name() == "rooms" and not self.closing:
            self._move_to_background()
            return True
        self.prepare_quit()
        return False


class RoomsApp(Adw.Application):
    def __init__(self):
        super().__init__(application_id="de.zelotez.Rooms")
        self.window = None
        quit_action = Gio.SimpleAction.new("quit", None)
        quit_action.connect("activate", self._quit_requested)
        self.add_action(quit_action)
        self.set_accels_for_action("app.quit", ["<Primary>q"])
        open_notification = Gio.SimpleAction.new("open-notification", GLib.VariantType.new("s"))
        open_notification.connect("activate", self._open_notification)
        self.add_action(open_notification)

    def do_activate(self):
        if self.window is None:
            self.window = RoomsWindow(self)
        self.window.present()

    def _open_notification(self, _action, key):
        if self.window is not None:
            self.window._open_notification(key.get_string())

    def _quit_requested(self, *_data):
        if self.window is not None:
            self.window.prepare_quit()
        self.quit()


if __name__ == "__main__":
    sys.exit(RoomsApp().run(sys.argv))
