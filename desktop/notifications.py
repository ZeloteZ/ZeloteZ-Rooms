from pathlib import Path

from gi.repository import Gio, GLib

from i18n import APP_NAME, t


SERVICE = "org.freedesktop.Notifications"
OBJECT = "/org/freedesktop/Notifications"


class DesktopNotifications:
    def __init__(self, app, activate):
        self.app = app
        self.activate = activate
        desktop_id = app.get_application_id() + ".desktop"
        data_directories = (GLib.get_user_data_dir(), *GLib.get_system_data_dirs())
        self.installed = any((Path(directory) / "applications" / desktop_id).is_file()
                             for directory in data_directories)
        self.bus = None if self.installed else app.get_dbus_connection()
        self.ids = {}
        if self.bus is not None:
            self.bus.signal_subscribe(
                SERVICE, SERVICE, "ActionInvoked", OBJECT, None, Gio.DBusSignalFlags.NONE, self._action_invoked,
            )

    def send(self, key, title, body):
        if self.installed:
            notice = Gio.Notification.new(title)
            notice.set_body(body)
            notice.set_default_action_and_target("app.open-notification", GLib.Variant("s", key))
            self.app.send_notification(key, notice)
        elif self.bus is not None:
            # A source checkout has no installed desktop ID for the GTK notification service.
            self.ids[key] = None
            arguments = GLib.Variant("(susssasa{sv}i)", (
                APP_NAME, 0, "application-x-executable", title, GLib.markup_escape_text(body),
                ["default", t("Open ZeloteZ Rooms")], {}, 0,
            ))
            self.bus.call(
                SERVICE, OBJECT, SERVICE, "Notify", arguments, GLib.VariantType.new("(u)"),
                Gio.DBusCallFlags.NONE, 3000, None, self._notified, key,
            )

    def withdraw(self, key):
        if self.installed:
            self.app.withdraw_notification(key)
        elif (system_id := self.ids.pop(key, None)) is not None:
            self._close(system_id)

    def _notified(self, bus, result, key):
        try:
            system_id, = bus.call_finish(result).unpack()
        except GLib.Error:
            self.ids.pop(key, None)
            return
        if key in self.ids:
            self.ids[key] = system_id
        else:
            self._close(system_id)

    def _close(self, system_id):
        self.bus.call(
            SERVICE, OBJECT, SERVICE, "CloseNotification", GLib.Variant("(u)", (system_id,)),
            None, Gio.DBusCallFlags.NONE, 3000,
        )

    def _action_invoked(self, _bus, _sender, _path, _interface, _member, parameters):
        system_id, action = parameters.unpack()
        if action == "default":
            key = next((key for key, identifier in self.ids.items() if identifier == system_id), None)
            if key is not None:
                self.activate(key)
