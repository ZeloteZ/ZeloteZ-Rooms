import os
from pathlib import Path
from threading import Thread
import time

import gi

gi.require_foreign("cairo")
for namespace, version in (("Gtk", "4.0"), ("Adw", "1"), ("Graphene", "1.0"),
                           ("Pango", "1.0"), ("Xdp", "1.0"), ("XdpGtk4", "1.0")):
    gi.require_version(namespace, version)
from gi.repository import Adw, Gdk, Gio, GLib, Graphene, Gtk, Pango, Xdp, XdpGtk4

from app_audio import list_audio_outputs, validate_audio_output
from i18n import decimal, t
from media import CapturePipeline, CaptureWorker, Gst
from model import QUALITY_PRESETS, Quality, parse_destination, picture_bounds, region_from_drag, validate_key


AUDIO_MODES = ("off", "application", "system")


def initialize_media(embedded_preview=False):
    Gst.init(None)
    # Protocol debug output can contain RTMP authentication arguments.
    Gst.debug_set_active(False)
    required = ("pipewiresrc", "gtk4paintablesink", "videoconvertscale", "videorate", "videocrop",
                "x264enc", "h264parse", "flvmux", "rtmp2sink")
    if embedded_preview:
        required += ("jpegenc", "appsink")
    missing = [name for name in required if not Gst.ElementFactory.find(name)]
    if missing:
        raise RuntimeError(t("Missing GStreamer elements. {elements}. See desktop/README.md.",
                             elements=", ".join(missing)))


def add_capture_style():
    provider = Gtk.CssProvider()
    provider.load_from_path(str(Path(__file__).with_name("capture.css")))
    Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
    )
    return provider


def label(text, style=None):
    widget = Gtk.Label(label=text, xalign=0, wrap=True)
    if style:
        widget.add_css_class(style)
    return widget


def field(parent, name, control):
    caption = Gtk.Label.new_with_mnemonic(name)
    caption.set_xalign(0)
    caption.add_css_class("field-caption")
    caption.set_mnemonic_widget(control)
    group = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
    group.append(caption)
    group.append(control)
    parent.append(group)


class CroppedPreview(Gtk.Widget):
    def __init__(self):
        super().__init__(can_target=False, hexpand=True, vexpand=True)
        self.paintable = None
        self.frame = None
        self.handler = None

    def set_frame(self, paintable=None, source_size=None, region=None):
        if self.paintable is not None:
            self.paintable.disconnect(self.handler)
        self.paintable = paintable
        self.frame = (source_size, region)
        self.handler = paintable.connect("invalidate-contents", lambda _paintable: self.queue_draw()) if paintable else None
        self.queue_draw()

    def do_snapshot(self, snapshot):
        if not self.paintable:
            return
        (source_width, source_height), region = self.frame
        x, y, scale = picture_bounds(self.get_width(), self.get_height(), region.width, region.height)
        if scale <= 0:
            return
        bounds = Graphene.Rect().init(x, y, region.width * scale, region.height * scale)
        offset = Graphene.Point().init(x - region.x * scale, y - region.y * scale)
        snapshot.save()
        snapshot.push_clip(bounds)
        snapshot.translate(offset)
        self.paintable.snapshot(snapshot, source_width * scale, source_height * scale)
        snapshot.pop()
        snapshot.restore()


class CaptureWindow(Adw.ApplicationWindow):
    def __init__(self, app, room_session, *, parent=None, preview_frame=None, on_metrics=None):
        initialize_media(preview_frame is not None)
        title = t("Screen sharing")
        super().__init__(application=app, title=title, default_width=860, default_height=650)
        if parent is not None:
            self.set_transient_for(parent)
        self.style_provider = add_capture_style()
        self.request = None
        self.session = None
        self.capture = None
        self.capture_worker = None
        self.inspect_pending = False
        self.latency_dirty = False
        self.latest_stats = None
        self.latest_size = None
        self.fd = None
        self.bus = None
        self.bus_handler = None
        self.state = "idle"
        self.since = time.monotonic()
        self.region = None
        self.drag_start = None
        self.source_dimensions = None
        self.capture_type = None
        self.audio_sources = ()
        self.audio_scan = None
        self.audio_output = None
        self.output_quality = None
        self.metric_sample = None
        self.room_session = room_session
        self.preview_frame = preview_frame
        self.on_metrics = on_metrics
        self.reservation = None
        self.stream_id = None
        self.closing = False
        self.connect("close-request", self.close_requested)

        layout = Adw.ToolbarView()
        self.set_content(layout)
        header = Adw.HeaderBar()
        wordmark = Gtk.Box(spacing=8, valign=Gtk.Align.CENTER)
        icon_path = Path(__file__).parent.parent / "app.asar.unpacked" / "ui" / "icon.png"
        if not icon_path.is_file():
            icon_path = Path(__file__).with_name("portable") / "ui" / "icon.png"
        icon = Gtk.Image.new_from_file(str(icon_path))
        icon.set_pixel_size(24)
        wordmark.append(icon)
        wordmark.append(label(title, "wordmark"))
        header.set_title_widget(wordmark)
        self.badge = label(t("Offline"), "state")
        header.pack_start(self.badge)
        layout.add_top_bar(header)
        layout.set_content(self.build_preview())
        self.set_state("idle")
        self.timer = GLib.timeout_add(200, self.update_status)

    def build_preview(self):
        pane = Gtk.Box(spacing=12, hexpand=True, vexpand=True)
        pane.add_css_class("workspace")
        preview = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10, hexpand=True, vexpand=True)
        preview.add_css_class("preview-panel")
        pane.append(preview)
        toolbar = Gtk.Box(spacing=12)
        self.preview_heading = label(t("Capture preview"), "preview-title")
        self.preview_heading.set_hexpand(True)
        toolbar.append(self.preview_heading)
        self.source_summary = label("", "muted")
        toolbar.append(self.source_summary)
        preview.append(toolbar)

        stack = Gtk.Stack(hexpand=True, vexpand=True, overflow=Gtk.Overflow.HIDDEN, vhomogeneous=False)
        stack.add_css_class("viewfinder")
        stack.set_size_request(-1, 260)
        stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)
        stack.set_transition_duration(160)
        preview.append(stack)
        self.preview_stack = stack

        empty = Gtk.Box(
            orientation=Gtk.Orientation.VERTICAL, spacing=14, valign=Gtk.Align.CENTER, halign=Gtk.Align.CENTER
        )
        icon = Gtk.Image.new_from_icon_name("video-display-symbolic")
        icon.set_halign(Gtk.Align.CENTER)
        icon.set_pixel_size(32)
        icon.add_css_class("display-icon")
        empty.append(icon)
        self.preview_title = label(t("Choose a monitor"), "empty-title")
        self.preview_title.set_xalign(0.5)
        empty.append(self.preview_title)
        self.preview_note = label(t("Preview your capture here before going live."), "muted")
        self.preview_note.set_xalign(0.5)
        empty.append(self.preview_note)
        stack.add_named(empty, "placeholder")

        private = label(t("Preview hidden. Your stream is still running."), "muted")
        private.set_justify(Gtk.Justification.CENTER)
        private.set_halign(Gtk.Align.CENTER)
        private.set_margin_start(16)
        private.set_margin_end(16)
        stack.add_named(private, "private")

        view = Gtk.Overlay()
        self.picture = Gtk.Picture(content_fit=Gtk.ContentFit.CONTAIN, can_shrink=True)
        view.set_child(self.picture)
        self.selection = Gtk.DrawingArea(hexpand=True, vexpand=True, can_target=False)
        self.selection.set_draw_func(self.draw_region)
        self.selection.set_cursor_from_name("crosshair")
        view.add_overlay(self.selection)
        drag = Gtk.GestureDrag(button=Gdk.BUTTON_PRIMARY)
        drag.connect("drag-begin", self.drag_begin)
        drag.connect("drag-update", self.drag_update)
        drag.connect("drag-end", self.drag_end)
        self.selection.add_controller(drag)
        stack.add_named(view, "capture")
        self.cropped_preview = CroppedPreview()
        stack.add_named(self.cropped_preview, "cropped")

        self.message = label("", "muted")
        self.message.set_visible(False)
        self.message.add_css_class("stream-status")
        preview.append(self.message)
        self.controls = Gtk.Stack(vhomogeneous=False, hhomogeneous=False)
        self.controls.set_size_request(340, -1)
        self.controls.set_hexpand(False)
        self.controls.set_valign(Gtk.Align.START)
        self.controls.set_transition_type(Gtk.StackTransitionType.CROSSFADE)
        self.controls.set_transition_duration(150)
        self.controls.add_named(self.build_setup_controls(), "setup")
        self.controls.add_named(self.build_live_controls(), "live")
        control_column = Adw.Clamp(child=self.controls, maximum_size=340, tightening_threshold=340)
        control_column.set_valign(Gtk.Align.START)
        pane.append(control_column)

        compact = Adw.Breakpoint.new(Adw.BreakpointCondition.parse("max-width: 740sp"))
        compact.add_setter(pane, "orientation", Gtk.Orientation.VERTICAL)
        compact.add_setter(stack, "height-request", 210)
        compact.add_setter(stack, "vexpand", False)
        compact.add_setter(preview, "vexpand", False)
        compact.add_setter(self.controls, "width-request", -1)
        compact.add_setter(self.controls, "hexpand", True)
        compact.add_setter(control_column, "maximum-size", 740)
        compact.add_setter(control_column, "hexpand", True)
        compact.add_setter(self.setup_actions, "orientation", Gtk.Orientation.VERTICAL)
        compact.add_setter(self.setup_actions, "halign", Gtk.Align.FILL)
        compact.add_setter(self.live_actions, "orientation", Gtk.Orientation.VERTICAL)
        compact.add_setter(self.live_spacer, "visible", False)
        self.add_breakpoint(compact)

        scroll = Gtk.ScrolledWindow(hexpand=True, vexpand=True)
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroll.set_child(pane)
        return scroll

    def build_setup_controls(self):
        controls = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        controls.add_css_class("control-panel")
        options = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        source = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6, hexpand=True)
        source.append(label(t("Capture source"), "section-title"))
        modes = Gtk.Box(homogeneous=True)
        modes.add_css_class("linked")
        self.monitor = Gtk.ToggleButton(label=t("Monitor"), active=True)
        self.area = Gtk.ToggleButton(label=t("Region"), group=self.monitor)
        self.app_source = Gtk.ToggleButton(label=t("App window"), group=self.monitor)
        for mode in (self.monitor, self.area, self.app_source):
            mode.connect("toggled", self.mode_toggled)
            modes.append(mode)
        source.append(modes)
        self.pick = Gtk.Button(label=t("Choose a monitor"))
        self.pick.connect("clicked", self.choose_monitor)
        source.append(self.pick)
        options.append(source)

        output = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        output.append(label(t("Video quality"), "section-title"))
        row = Gtk.Box(spacing=8, homogeneous=True)
        self.resolution = Gtk.DropDown.new_from_strings(["720p", "1080p", "1440p"])
        self.resolution.set_selected(1)
        self.rate = Gtk.DropDown.new_from_strings([t("{rate} FPS", rate=30), t("{rate} FPS", rate=60)])
        field(row, t("_Resolution"), self.resolution)
        field(row, t("_Frame rate"), self.rate)
        output.append(row)
        options.append(output)
        controls.append(options)
        controls.append(self.build_audio_controls())

        actions = Gtk.Box(spacing=8, halign=Gtk.Align.END)
        self.setup_actions = actions
        self.start = Gtk.Button(label=t("Start stream"))
        self.start.add_css_class("suggested-action")
        self.start.add_css_class("primary-action")
        self.start.connect("clicked", self.start_stream)
        actions.append(self.start)
        self.stop = Gtk.Button(label=t("Close preview"))
        self.stop.add_css_class("primary-action")
        self.stop.connect("clicked", self.stop_clicked)
        actions.append(self.stop)
        controls.append(actions)
        return controls

    def build_audio_controls(self):
        self.audio_panel = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.audio_panel.add_css_class("audio-panel")
        self.audio_mode = Gtk.DropDown.new_from_strings([t("No audio"), t("Application audio"), t("System audio")])
        self.audio_mode.set_selected(0)
        field(self.audio_panel, t("_Audio to share"), self.audio_mode)
        self.audio_details = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=7, visible=False)
        self.audio_panel.append(self.audio_details)
        row = Gtk.Box(spacing=8)
        self.audio_picker = Gtk.DropDown.new_from_strings([t("Choose an audio output")])
        self.audio_picker.set_hexpand(True)
        source_factory = Gtk.SignalListItemFactory()

        def setup_source(_factory, item):
            item.set_child(Gtk.Label(xalign=0, ellipsize=Pango.EllipsizeMode.END, max_width_chars=26))

        def bind_source(_factory, item):
            title = item.get_item().get_string()
            item.get_child().set_label(title)
            item.get_child().set_tooltip_text(title)

        source_factory.connect("setup", setup_source)
        source_factory.connect("bind", bind_source)
        self.audio_picker.set_factory(source_factory)
        self.audio_picker.update_property([Gtk.AccessibleProperty.LABEL], [t("Audio output to share")])
        self.audio_picker.connect("notify::selected", self.update_start)
        row.append(self.audio_picker)
        self.audio_refresh = Gtk.Button(icon_name="view-refresh-symbolic", tooltip_text=t("Refresh audio sources"))
        self.audio_refresh.update_property([Gtk.AccessibleProperty.LABEL], [t("Refresh audio sources")])
        self.audio_refresh.connect("clicked", self.refresh_audio)
        row.append(self.audio_refresh)
        self.audio_details.append(row)
        self.audio_hint = label("", "muted")
        self.audio_hint.add_css_class("field-caption")
        self.audio_details.append(self.audio_hint)
        self.audio_mode.connect("notify::selected", self.audio_mode_changed)
        return self.audio_panel

    def selected_audio_mode(self):
        index = self.audio_mode.get_selected()
        return AUDIO_MODES[index] if index < len(AUDIO_MODES) else "off"

    def has_audio_request(self):
        return self.selected_audio_mode() != "off"

    def selected_audio(self):
        index = self.audio_picker.get_selected()
        return self.audio_sources[index - 1] if 1 <= index <= len(self.audio_sources) else None

    @staticmethod
    def sound_task(operation, callback):
        def run():
            try:
                result = operation()
            except RuntimeError as error:
                GLib.idle_add(callback, None, str(error))
            else:
                GLib.idle_add(callback, result, None)
        Thread(target=run, daemon=True).start()

    def audio_mode_changed(self, *_args):
        self.audio_scan = None
        self.audio_sources = ()
        self.audio_picker.set_model(Gtk.StringList.new([t("Choose an audio output")]))
        requested = self.has_audio_request()
        self.audio_details.set_visible(requested)
        if requested:
            self.refresh_audio()
        self.update_start()

    def refresh_audio(self, _button=None):
        if not self.has_audio_request() or self.audio_scan is not None:
            return
        mode = self.selected_audio_mode()
        previous = self.selected_audio()
        token = object()
        self.audio_scan = token
        self.audio_picker.set_sensitive(False)
        self.audio_refresh.set_sensitive(False)
        self.audio_hint.set_label(t("Looking for audio outputs …"))
        self.update_start()

        def scanned(sources, error):
            if self.closing or self.audio_scan is not token:
                return
            self.audio_scan = None
            self.audio_sources = sources or ()
            labels = [t("Choose an audio output"), *(source.title for source in self.audio_sources)]
            self.audio_picker.set_model(Gtk.StringList.new(labels))
            selection = next((index for index, source in enumerate(self.audio_sources, 1)
                              if previous and source.serial == previous.serial), 0)
            self.audio_picker.set_selected(selection)
            self.audio_picker.set_sensitive(bool(self.audio_sources))
            self.audio_refresh.set_sensitive(True)
            if mode == "system":
                hint = (t("All sound playing through this output will be shared.") if self.audio_sources
                        else t("No PipeWire playback output is available."))
            else:
                hint = (t("Choose the application audio you want to share.") if self.audio_sources
                        else t("Play some audio in the app and refresh the list."))
            self.audio_hint.set_label(error or hint)
            self.update_start()

        self.sound_task(lambda: list_audio_outputs(mode), scanned)

    def build_live_controls(self):
        controls = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        controls.add_css_class("control-panel")
        actions = Gtk.Box(spacing=8)
        self.live_actions = actions
        self.hide_preview = Gtk.ToggleButton(label=t("Hide preview"))
        self.hide_preview.connect("toggled", self.toggle_preview)
        actions.append(self.hide_preview)
        spacer = Gtk.Box(hexpand=True)
        self.live_spacer = spacer
        actions.append(spacer)
        finish = Gtk.Button(label=t("End stream"))
        finish.add_css_class("destructive-action")
        finish.add_css_class("primary-action")
        finish.connect("clicked", self.stop_clicked)
        actions.append(finish)
        controls.append(actions)

        metrics = Gtk.FlowBox(
            selection_mode=Gtk.SelectionMode.NONE, column_spacing=8, row_spacing=8, homogeneous=True,
            min_children_per_line=2, max_children_per_line=4,
        )
        self.metrics = {}
        for metric, caption in (("time", t("Time live")), ("resolution", t("Resolution")),
                                ("fps", t("Frame rate")), ("upload", t("Upload"))):
            card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
            card.add_css_class("metric")
            value = label("–", "metric-value")
            self.metrics[metric] = value
            card.append(value)
            card.append(label(caption, "field-caption"))
            metrics.append(card)
        controls.append(metrics)
        return controls

    def toggle_preview(self, button):
        if self.state != "live":
            return
        hidden = button.get_active()
        button.set_label(t("Show preview") if hidden else t("Hide preview"))
        self.preview_stack.set_visible_child_name("private" if hidden else self.live_preview_page())

    def live_preview_page(self):
        return "cropped" if self.region is not None else "capture"

    def notice(self, text="", error=False):
        self.message.set_label(text)
        self.message.set_visible(bool(text))
        if error:
            self.message.add_css_class("error")
        else:
            self.message.remove_css_class("error")

    def update_start(self, *_args):
        if not hasattr(self, "start"):
            return
        has_crop = not self.area.get_active() or self.region is not None
        has_audio = not self.has_audio_request() or (self.audio_scan is None and self.selected_audio() is not None)
        self.start.set_sensitive(self.state == "ready" and has_crop and has_audio and self.room_session.ready)

    def refresh_room(self):
        self.update_start()

    def selected_capture_type(self):
        return Xdp.OutputType.WINDOW if self.app_source.get_active() else Xdp.OutputType.MONITOR

    def set_state(self, state):
        self.state = state
        self.since = time.monotonic()
        busy = state in ("connecting", "live")
        can_pick = state in ("idle", "ready")
        self.pick.set_sensitive(can_pick)
        window_source = self.app_source.get_active()
        if window_source:
            pick_label = t("Choose another window") if state == "ready" else t("Choose a window")
        else:
            pick_label = t("Choose another monitor") if state == "ready" else t("Choose a monitor")
        self.pick.set_label(pick_label)
        self.monitor.set_sensitive(can_pick)
        self.area.set_sensitive(can_pick)
        self.app_source.set_sensitive(can_pick)
        for widget in (self.resolution, self.rate):
            widget.set_sensitive(not busy)
        self.audio_panel.set_sensitive(not busy)
        self.controls.set_visible_child_name("live" if state == "live" else "setup")
        self.preview_heading.set_label(t("Live preview") if state == "live" else t("Capture preview"))
        self.start.set_visible(not busy)
        self.update_start()
        self.stop.set_visible(state != "idle")
        self.stop.remove_css_class("destructive-action")
        if busy:
            self.stop.set_label(t("End stream") if state == "live" else t("Cancel"))
            self.stop.add_css_class("destructive-action")
        elif state in ("picking", "preparing"):
            self.stop.set_label(t("Cancel"))
        else:
            self.stop.set_label(t("Close preview"))

        self.selection.set_can_target(state == "ready" and self.area.get_active())
        self.badge.remove_css_class("live")
        self.badge.set_label({
            "idle": t("Offline"), "picking": t("Selecting source"), "preparing": t("Loading"),
            "ready": t("Preview"), "connecting": t("Connecting"), "live": t("Live"),
        }[state])
        if state == "live":
            self.badge.add_css_class("live")
            self.metric_sample = None
            quality = self.output_quality
            self.metrics["time"].set_label("00:00")
            self.metrics["resolution"].set_label(f"{quality.width} × {quality.height}" if quality else "–")
            self.metrics["fps"].set_label("–")
            self.metrics["upload"].set_label("–")
            self.hide_preview.set_active(False)
            self.hide_preview.set_label(t("Hide preview"))
            if self.region is not None:
                self.cropped_preview.set_frame(self.capture.paintable, self.source_dimensions, self.region)
            if self.stream_id:
                self.room_session.set_live(self.stream_id)

        if state in ("idle", "picking", "preparing"):
            self.preview_stack.set_visible_child_name("placeholder")
            if state == "idle":
                self.preview_title.set_label(t("Choose a window") if window_source else t("Choose a monitor"))
                self.preview_note.set_label(t("Preview your capture here before going live."))
            elif state == "picking":
                self.preview_title.set_label(t("Screen sharing"))
                self.preview_note.set_label(t("Select an app window in the system dialog.") if window_source
                                            else t("Select a monitor in the system dialog."))
            else:
                self.preview_title.set_label(t("Loading preview"))
                self.preview_note.set_label("")
        else:
            self.preview_stack.set_visible_child_name(self.live_preview_page() if state == "live" else "capture")

    def mode_toggled(self, button):
        if not button.get_active() or not hasattr(self, "start"):
            return
        if self.capture_type is not None and self.capture_type != self.selected_capture_type():
            self.cleanup(preserve_audio=True)
            self.set_state("idle")
            self.notice()
            return
        self.region = None
        self.selection.queue_draw()
        self.set_state(self.state)
        if self.state == "ready":
            self.notice(t("Drag a rectangle in the preview.") if self.area.get_active() else "")

    def choose_monitor(self, _button):
        self.cleanup(preserve_audio=True)
        self.capture_type = self.selected_capture_type()
        self.notice()
        self.set_state("picking")
        request = Gio.Cancellable()
        self.request = request
        portal = Xdp.Portal.new()
        if portal is None:
            self.fail(t("The screen sharing portal is unavailable."))
            return
        portal.create_screencast_session(
            self.capture_type, Xdp.ScreencastFlags(0), Xdp.CursorMode.EMBEDDED,
            Xdp.PersistMode.NONE, None, request, self.portal_created, request,
        )

    def portal_created(self, portal, result, request):
        try:
            session = portal.create_screencast_session_finish(result)
        except GLib.Error:
            if request == self.request:
                self.fail(t("The screen sharing portal is unavailable."))
            return

        if request != self.request:
            session.close()
            return

        self.session = session
        session.connect("closed", self.portal_closed)
        parent = XdpGtk4.parent_new_gtk(self)
        session.start(parent, request, self.portal_started, request)

    def portal_started(self, session, result, request):
        if request != self.request:
            return
        try:
            if not session.start_finish(result):
                self.fail(t("Screen sharing was canceled."))
                return
            streams = session.get_streams().unpack()
            if len(streams) != 1:
                self.fail(t("Choose exactly one window to capture.") if self.capture_type == Xdp.OutputType.WINDOW
                          else t("Choose exactly one monitor to capture."))
                return
            node_id, properties = streams[0]
            self.fd = session.open_pipewire_remote()
            if self.fd < 0:
                self.fd = None
                self.fail(t("PipeWire couldn’t open a capture connection."))
                return
            capture = CapturePipeline.from_portal(self.fd, node_id, properties.get("pipewire-serial"))
            self.begin_preview(capture, self.fd)
        except GLib.Error:
            self.fail(t("Screen sharing couldn’t start."))
            return
        except RuntimeError as error:
            self.fail(str(error))
            return

    def begin_preview(self, capture, fd=None):
        self.capture_worker = worker = CaptureWorker(capture, fd)
        self.fd = None
        self.capture = capture
        self.bus = capture.pipeline.get_bus()
        self.bus.add_signal_watch()
        self.bus_handler = self.bus.connect("message", self.media_message)
        self.picture.set_paintable(capture.paintable)
        self.set_state("preparing")

        def started(_result, error):
            if worker is self.capture_worker and error:
                self.fail(t("The capture preview couldn’t start."))

        worker.submit(capture.start_preview, started)

    def portal_closed(self, session):
        if session == self.session:
            self.session = None
            self.fail(t("Screen sharing ended."))

    def drag_begin(self, _gesture, x, y):
        self.drag_start = (x, y)
        self.region = None
        self.start.set_sensitive(False)
        self.selection.queue_draw()

    def drag_update(self, _gesture, dx, dy):
        if self.drag_start is None or self.source_dimensions is None:
            return
        x, y = self.drag_start
        self.region = region_from_drag(
            self.drag_start, (x + dx, y + dy),
            (self.selection.get_width(), self.selection.get_height()), self.source_dimensions,
        )
        self.selection.queue_draw()

    def drag_end(self, gesture, dx, dy):
        self.drag_update(gesture, dx, dy)
        self.drag_start = None
        self.update_start()
        if self.region is None:
            self.notice(t("Drag a rectangle in the preview."))
        else:
            self.notice(t("Selected region · {width} × {height} px", width=self.region.width, height=self.region.height))

    def draw_region(self, _widget, cr, width, height):
        if self.region is None or self.source_dimensions is None:
            return
        left, top, scale = picture_bounds(width, height, *self.source_dimensions)
        region = self.region
        x, y = left + region.x * scale, top + region.y * scale
        region_width, region_height = region.width * scale, region.height * scale
        cr.rectangle(left, top, self.source_dimensions[0] * scale, self.source_dimensions[1] * scale)
        cr.rectangle(x, y, region_width, region_height)
        cr.set_fill_rule(1)
        cr.set_source_rgba(0.015, 0.025, 0.05, 0.68)
        cr.fill()
        cr.rectangle(x, y, region_width, region_height)
        cr.set_source_rgb(0.55, 0.71, 1.0)
        cr.set_line_width(2)
        cr.stroke()

    def start_stream(self, _button):
        if self.state != "ready" or (self.area.get_active() and self.region is None):
            return

        width, height, at_30, at_60 = QUALITY_PRESETS[self.resolution.get_selected()]
        fps = 60 if self.rate.get_selected() == 1 else 30
        self.output_quality = Quality(width, height, fps, at_60 if fps == 60 else at_30)
        self.audio_output = None
        if self.has_audio_request():
            source = self.selected_audio()
            if source is None or self.audio_scan is not None:
                return
            token = object()
            self.reservation = token
            self.set_state("connecting")
            self.notice(t("Checking the selected audio source."))

            def verified(output, error):
                if self.closing or self.reservation is not token:
                    return
                self.reservation = None
                if error or not output:
                    self.set_state("ready")
                    self.notice(error or t("The selected audio output is unavailable. Choose it again."), error=True)
                    self.refresh_audio()
                    return
                self.audio_output = output
                self.start_output()

            self.sound_task(lambda: validate_audio_output(source), verified)
        else:
            self.start_output()

    def start_output(self):
        if self.room_session.ready:
            token = object()
            self.reservation = token
            self.set_state("connecting")
            self.notice(t("Preparing the stream in the live room."))
            self.room_session.reserve(lambda result, error: self.reserved(token, result, error))
        else:
            self.set_state("ready")
            self.notice(t("The live room didn’t respond. Try again."), error=True)

    def reserved(self, token, result, error):
        stream_id = result.get("id") if result else None
        if self.closing or self.reservation is not token:
            if stream_id:
                self.room_session.finish(stream_id)
            return
        self.reservation = None
        if error or not stream_id:
            self.set_state("ready")
            self.notice(str(error) if error else t("The live room didn’t provide a stream."), error=True)
            return
        self.stream_id = stream_id
        self.publish_with(result.get("address", ""), result.get("key", ""))

    def publish_with(self, address, key):
        try:
            destination = parse_destination(address)
            key = validate_key(key)
        except ValueError as error:
            self.finish_room_stream()
            self.set_state("ready")
            self.notice(str(error), error=True)
            return

        self.set_state("connecting")
        self.notice(t("Connecting to the streaming server."))
        capture, worker = self.capture, self.capture_worker
        dimensions = self.source_dimensions
        quality, region, audio = self.output_quality, self.region, self.audio_output

        def publish():
            if capture.source_size() != dimensions:
                return False
            capture.publish(destination, key, quality, region, audio_serial=audio.serial if audio else None,
                            cancelled=worker.closed.is_set, audio_monitor=audio is not None and audio.mode == "system",
                            preview_frame=self.preview_frame)
            return True

        def published(result, error):
            if worker is not self.capture_worker:
                return
            if error:
                self.fail(str(error) if isinstance(error, RuntimeError) else t("Video output couldn’t start."))
            elif not result:
                self.finish_room_stream()
                self.region = None
                self.selection.queue_draw()
                self.set_state("ready")
                self.notice(t("The capture source changed size. Check your selection."), error=True)

        worker.submit(publish, published)

    def media_message(self, bus, message):
        if self.capture is None or bus != self.bus:
            return
        if message.type == Gst.MessageType.ERROR:
            if self.capture.is_audio_error(message.src):
                self.fail(t("The selected audio source is unavailable. Choose it again or stream without audio."))
            elif self.capture.sender is not None and message.src == self.capture.sender:
                self.fail(t("Connection failed. Check the server address, TLS certificate and stream key."))
            else:
                self.fail(t("Capture was interrupted. Choose the source again."))
        elif message.type == Gst.MessageType.EOS:
            self.fail(t("Capture ended."))
        elif message.type == Gst.MessageType.LATENCY:
            self.latency_dirty = True

    def inspect_capture(self):
        worker, capture = self.capture_worker, self.capture
        if worker is None or self.inspect_pending:
            return
        check_preview = self.state in ("preparing", "ready")
        check_output = self.state == "live" or (self.state == "connecting" and self.reservation is None)
        recalculate = self.latency_dirty
        self.latency_dirty = False
        self.inspect_pending = True

        def inspect():
            if recalculate:
                capture.pipeline.recalculate_latency()
            size = capture.source_size() if check_preview else None
            stats = capture.publisher_stats() if check_output else None
            return size, (time.monotonic(), stats) if stats is not None else None

        def inspected(result, error):
            if worker is self.capture_worker:
                self.inspect_pending = False
                if not error:
                    size, stats = result
                    if size is not None:
                        self.latest_size = size
                    if stats is not None:
                        self.latest_stats = stats

        worker.submit(inspect, inspected)

    def update_status(self):
        self.inspect_capture()
        now = time.monotonic()
        elapsed = int(now - self.since)
        if self.state in ("preparing", "ready"):
            size = self.latest_size
            if size and self.capture.paintable.get_intrinsic_width() > 0:
                changed = self.source_dimensions not in (None, size)
                self.source_dimensions = size
                self.source_summary.set_label(f"{size[0]} × {size[1]} px")
                if self.state == "preparing" or changed:
                    self.region = None
                    self.selection.queue_draw()
                    self.set_state("ready")
                    self.notice(t("Drag a rectangle in the preview.") if self.area.get_active() else "")
            elif self.state == "preparing" and elapsed >= 12:
                self.fail(t("The selected source didn’t provide a preview. Choose it again."))
        elif self.state == "connecting":
            if self.reservation is not None:
                if elapsed >= 18:
                    self.reservation = None
                    self.set_state("ready")
                    self.notice(t("The live room didn’t respond. Try again."), error=True)
            elif self.latest_stats is not None and self.latest_stats[1].frames >= 4:
                self.set_state("live")
                self.notice()
            elif elapsed >= 12:
                self.fail(t("The streaming server didn’t confirm the connection in time."))
        elif self.state == "live":
            hours, remainder = divmod(elapsed, 3600)
            minutes, seconds = divmod(remainder, 60)
            duration = f"{hours}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes:02d}:{seconds:02d}"
            self.metrics["time"].set_label(duration)
            self.update_metrics()
        return GLib.SOURCE_CONTINUE

    def update_metrics(self):
        if self.latest_stats is None:
            return
        now, stats = self.latest_stats
        sample = self.metric_sample
        if sample and now - sample[0] < 1:
            return
        self.metric_sample = self.latest_stats
        if not sample:
            return
        previous_time, previous_stats = sample
        seconds = now - previous_time
        fps = max(0, stats.frames - previous_stats.frames) / seconds
        mbps = max(0, stats.bytes_sent - previous_stats.bytes_sent) * 8 / seconds / 1_000_000
        self.metrics["fps"].set_label(t("{rate} FPS", rate=decimal(fps, 0)))
        self.metrics["upload"].set_label(t("{speed} Mbps", speed=decimal(mbps, 2)))
        if self.on_metrics is not None and self.stream_id:
            self.on_metrics(self.stream_id, self.output_quality, fps, mbps, int(now - self.since))

    def finish_room_stream(self):
        self.reservation = None
        if self.stream_id:
            stream_id, self.stream_id = self.stream_id, None
            self.room_session.finish(stream_id)
            self.room_session.set_live(None)

    def fail(self, message):
        self.cleanup()
        self.set_state("idle")
        self.notice(message, error=True)

    def stop_clicked(self, _button):
        live = self.state == "live"
        self.cleanup()
        self.set_state("idle")
        self.notice(t("Stream ended.") if live else "")

    def cleanup(self, *, preserve_audio=False):
        self.finish_room_stream()
        self.cropped_preview.set_frame()
        if not preserve_audio:
            self.audio_mode.set_selected(0)
        self.audio_output = None
        if self.request is not None:
            request, self.request = self.request, None
            request.cancel()
        if self.bus is not None:
            self.bus.disconnect(self.bus_handler)
            self.bus.remove_signal_watch()
            self.bus = None
            self.bus_handler = None
        if self.capture_worker is not None:
            worker, self.capture_worker = self.capture_worker, None
            worker.close()
        self.capture = None
        self.inspect_pending = False
        self.latency_dirty = False
        self.latest_size = None
        self.latest_stats = None
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        if self.session is not None:
            session, self.session = self.session, None
            session.close()
        self.picture.set_paintable(None)
        self.source_summary.set_label("")
        self.source_dimensions = None
        self.capture_type = None
        self.output_quality = None
        self.metric_sample = None
        self.region = None
        self.drag_start = None
        self.selection.queue_draw()

    def close_requested(self, _window):
        if self.closing:
            return False
        self.closing = True
        GLib.source_remove(self.timer)
        self.cleanup()
        self.room_session.close()
        Gtk.StyleContext.remove_provider_for_display(self.get_display(), self.style_provider)
        return False
