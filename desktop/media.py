from dataclasses import dataclass
import os
from queue import SimpleQueue
from threading import Event, Thread

import gi

gi.require_version("Gst", "1.0")
gi.require_version("GstBase", "1.0")

from gi.repository import Gio, GLib, Gst, GstBase

from i18n import t


PREVIEW_PIPELINE = (
    "video/x-raw,pixel-aspect-ratio=1/1 ! tee name=video "
    "! queue leaky=downstream max-size-buffers=2 max-size-bytes=0 max-size-time=0 "
    "! gtk4paintablesink name=preview sync=false async=false qos=false enable-last-sample=false"
)
AAC_ENCODERS = ("fdkaacenc", "avenc_aac", "voaacenc", "faac")


@dataclass(frozen=True)
class PublisherStats:
    frames: int = 0
    bytes_sent: int = 0
    dropped: int = 0


class CaptureWorker:
    """Serialize native state changes and queries off the GTK main loop."""

    def __init__(self, capture, fd):
        self.capture = capture
        self.fd = fd
        self.tasks = SimpleQueue()
        self.closed = Event()
        Thread(target=self.run, name="screen-capture", daemon=True).start()

    def submit(self, operation, callback=None):
        self.tasks.put((operation, callback))

    def close(self):
        self.closed.set()
        self.tasks.put(None)

    def run(self):
        # Keep GLib invocations for the GTK sink queued on the GTK context even
        # before the application has entered its main loop or while it exits.
        context = GLib.MainContext.new()
        context.push_thread_default()
        try:
            self.run_tasks()
        finally:
            self.capture = None
            context.pop_thread_default()

    def run_tasks(self):
        try:
            while (task := self.tasks.get()) is not None:
                if self.closed.is_set():
                    continue
                operation, callback = task
                try:
                    result = operation()
                except (RuntimeError, GLib.Error) as error:
                    if callback is not None and not self.closed.is_set():
                        GLib.idle_add(callback, None, error)
                else:
                    if callback is not None and not self.closed.is_set():
                        GLib.idle_add(callback, result, None)
        finally:
            try:
                self.capture.stop()
            finally:
                if self.fd is not None:
                    os.close(self.fd)


def hold_pad(_pad, _info):
    return Gst.PadProbeReturn.OK


def keep_capture_format(_pad, info):
    if info.get_event().type == Gst.EventType.RECONFIGURE:
        return Gst.PadProbeReturn.DROP
    return Gst.PadProbeReturn.OK


class CapturePipeline:
    def __init__(self, source_description):
        self.pipeline = Gst.parse_launch(f"{source_description} ! {PREVIEW_PIPELINE}")
        self.source = self.pipeline.get_by_name("source")
        self.tee = self.pipeline.get_by_name("video")
        self.paintable = self.pipeline.get_by_name("preview").get_property("paintable")
        self.sender = None
        self.frame_counter = None
        self.audio_source = None
        self.publish_branch = None
        self.publish_pad = None

    @classmethod
    def from_portal(cls, fd, node_id, serial):
        capture = cls("pipewiresrc name=source client-name=ZeloteZ on-disconnect=error keepalive-time=125")
        capture.source.set_property("fd", fd)
        if serial and capture.source.find_property("target-object"):
            capture.source.set_property("target-object", str(serial))
        else:
            capture.source.set_property("path", str(node_id))
        return capture

    def start_preview(self):
        if self.pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            raise RuntimeError(t("The capture preview couldn’t start."))

    def source_size(self):
        caps = self.tee.get_static_pad("sink").get_current_caps()
        if caps is None or caps.is_empty():
            return None
        structure = caps.get_structure(0)
        width, height = structure.get_value("width"), structure.get_value("height")
        if isinstance(width, int) and isinstance(height, int) and width > 0 and height > 0:
            return width, height
        return None

    def publish(self, destination, key, quality, region=None, audio_serial=None, cancelled=None, *, audio_monitor=False):
        if self.publish_branch is not None:
            raise RuntimeError(t("A stream is already active."))
        size = self.source_size()
        if size is None:
            raise RuntimeError(t("The capture source hasn’t provided a frame yet."))
        width, height = size
        video = "queue leaky=downstream max-size-buffers=3 max-size-bytes=0 max-size-time=0 ! "
        if region is not None:
            right = width - region.x - region.width
            bottom = height - region.y - region.height
            if min(region.x, region.y, right, bottom) < 0 or min(region.width, region.height) < 32:
                raise RuntimeError(t("The selected region is outside the shared area."))
            # Pin the original dimensions so a monitor mode change cannot move the selected crop.
            video += (
                f"video/x-raw,width={width},height={height} ! videoconvert ! video/x-raw,format=BGRx ! "
                f"videocrop left={region.x} right={right} top={region.y} bottom={bottom} ! "
            )
        video += (
            "videorate skip-to-first=true max-duplication-time=250000000 ! "
            "videoconvertscale add-borders=true ! "
            f"video/x-raw,format=I420,pixel-aspect-ratio=1/1,width={quality.width},height={quality.height},"
            f"framerate={quality.fps}/1 ! "
            f"x264enc speed-preset=veryfast tune=zerolatency bitrate={quality.bitrate} "
            f"key-int-max={quality.fps} bframes=0 ! "
            "h264parse ! video/x-h264,stream-format=avc,alignment=au,profile=high ! "
            "identity name=encoded_frames silent=true"
        )
        output = (
            "flvmux name=stream_mux streamable=true ! "
            "rtmp2sink name=publisher sync=false timeout=5 enable-last-sample=false"
        )
        description = f"{video} ! {output}"
        if audio_serial is not None:
            description = f"{video} ! stream_mux.video {output} {self._audio_output(audio_serial)}"
        branch = Gst.parse_bin_from_description(description, True)
        audio_source = branch.get_by_name("capture_audio")
        if audio_source is not None:
            if not audio_source.find_property("target-object"):
                raise RuntimeError(t("This PipeWire version can’t target the selected audio output."))
            audio_source.set_property("target-object", str(int(audio_serial)))
            properties = Gst.Structure.new_empty("properties")
            for name in ("node.dont-fallback", "node.dont-reconnect", "node.dont-move"):
                properties.set_value(name, True)
            properties.set_value("stream.restore-target", False)
            if audio_monitor:
                properties.set_value("stream.capture.sink", True)
            audio_source.set_property("stream-properties", properties)
        sender = branch.get_by_name("publisher")
        sender.set_property("scheme", 1 if destination.secure else 0)
        sender.set_property("host", destination.host)
        sender.set_property("port", destination.port)
        sender.set_property("tls-validation-flags", Gio.TlsCertificateFlags.VALIDATE_ALL)
        sender.set_property("authmod", 0)
        credentials = f"?user=streamer&pass={key}"
        if destination.stream:
            sender.set_property("application", "live")
            sender.set_property("stream", destination.stream + credentials)
        else:
            # The original single-segment endpoint carries credentials in tcUrl.
            sender.set_property("application", "live" + credentials)
            sender.set_property("stream", "")

        if not self.pipeline.add(branch):
            raise RuntimeError(t("Video output couldn’t be added."))
        pad = self.tee.request_pad_simple("src_%u")
        if pad is None:
            self.pipeline.remove(branch)
            raise RuntimeError(t("Video output couldn’t be connected."))

        # The preview is already playing. Hold data on the new pad until the
        # streaming branch belongs to the pipeline and is ready for its first frame.
        sink_pad = branch.get_static_pad("sink")
        probe = pad.add_probe(Gst.PadProbeType.IDLE, hold_pad)
        # Publishing converts the existing preview format itself. Renegotiating
        # upstream would disconnect PipeWire from the active portal source.
        pad.add_probe(Gst.PadProbeType.EVENT_UPSTREAM, keep_capture_format)
        self.audio_source = audio_source
        try:
            if not branch.sync_state_with_parent():
                raise RuntimeError(t("Video output couldn’t be connected."))
            if cancelled is not None and cancelled():
                return
            caps = self.tee.get_static_pad("sink").get_current_caps()
            if caps is None or not sink_pad.query_accept_caps(caps):
                raise RuntimeError(t("Video output couldn’t be connected."))
            flags = Gst.PadLinkCheck.DEFAULT | Gst.PadLinkCheck.NO_RECONFIGURE
            if pad.link_full(sink_pad, flags) != Gst.PadLinkReturn.OK:
                raise RuntimeError(t("Video output couldn’t be connected."))
            self.publish_branch = branch
            self.publish_pad = pad
            self.sender = sender
            self.frame_counter = branch.get_by_name("encoded_frames")
        finally:
            if self.publish_branch is None:
                self._remove_publish_branch(branch, pad)
            pad.remove_probe(probe)

    @staticmethod
    def _audio_output(audio_serial):
        identifier = str(audio_serial)
        if not identifier.isascii() or not identifier.isdecimal() or len(identifier) > 20:
            raise RuntimeError(t("Choose an audio output."))
        if not 0 < int(identifier) < 2**64 - 1:
            raise RuntimeError(t("Choose an audio output."))
        encoder = next((item for item in AAC_ENCODERS if Gst.ElementFactory.find(item)), None)
        if encoder is None:
            raise RuntimeError(t("Screen share audio needs a GStreamer AAC encoder."))
        return (
            "pipewiresrc name=capture_audio client-name=ZeloteZ-Audio on-disconnect=error provide-clock=false ! "
            "queue leaky=downstream max-size-buffers=0 max-size-bytes=0 max-size-time=300000000 ! "
            "audioconvert ! audioresample ! audio/x-raw,rate=48000,channels=2 ! "
            f"{encoder} bitrate=128000 ! aacparse ! audio/mpeg,mpegversion=4,stream-format=raw ! stream_mux.audio"
        )

    def is_audio_error(self, element):
        return self.audio_source is not None and element == self.audio_source

    def publisher_stats(self):
        if self.sender is None:
            return PublisherStats()
        transport = self.sender.get_property("stats")
        bytes_sent = transport.get_value("out-bytes-total") if transport else 0
        if not bytes_sent:
            return PublisherStats()
        frames = self.frame_counter.get_property("stats").get_value("num-buffers")
        dropped = GstBase.BaseSink.get_stats(self.sender).get_value("dropped")
        return PublisherStats(frames or 0, bytes_sent, dropped or 0)

    def frames_sent(self):
        return self.publisher_stats().frames

    def _remove_publish_branch(self, branch, pad):
        branch.set_state(Gst.State.NULL)
        if pad.is_linked():
            pad.unlink(branch.get_static_pad("sink"))
        self.tee.release_request_pad(pad)
        self.pipeline.remove(branch)

    def stop(self):
        self.pipeline.set_state(Gst.State.NULL)
        if self.publish_branch is not None:
            self._remove_publish_branch(self.publish_branch, self.publish_pad)
        self.publish_branch = None
        self.publish_pad = None
        self.sender = None
        self.frame_counter = None
        self.audio_source = None
