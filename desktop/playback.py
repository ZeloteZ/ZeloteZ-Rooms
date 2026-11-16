"""Play one verified chat attachment with a local FFplay process."""

import os
from dataclasses import dataclass
from pathlib import Path
from shutil import which
from tempfile import TemporaryDirectory

from gi.repository import Gio, GLib

from i18n import t


CONTAINERS = ("mp4", "webm", "ogg")
FORMAT_WHITELIST = "matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,ogg"
MAX_MEDIA_BYTES = 12 * 1024 * 1024
PLAYBACK_ERROR = "The local player couldn’t open this attachment. You can still download it from the chat."


@dataclass
class Transfer:
    view: object
    uri: str
    format: str
    directory: TemporaryDirectory
    download: object = None
    timeout: int = 0

    @property
    def path(self):
        return Path(self.directory.name) / "attachment"

    def clean_up(self):
        if self.timeout:
            GLib.source_remove(self.timeout)
            self.timeout = 0
        self.directory.cleanup()


class LocalPlayback:
    def __init__(self, alert):
        self.ffplay = which("ffplay")
        self.alert = alert
        self.transfer = None
        self.player = None

    def play(self, view, uri, format):
        if not self.ffplay or format not in CONTAINERS:
            return
        if self.transfer is not None or self.player is not None:
            self.alert(t("Close the current local video before playing another one."))
            return
        try:
            directory = TemporaryDirectory(prefix="rooms-playback-", dir=os.environ.get("XDG_RUNTIME_DIR"),
                                           ignore_cleanup_errors=True)
        except OSError:
            self.alert(t(PLAYBACK_ERROR))
            return
        transfer = self.transfer = Transfer(view, uri, format, directory)
        transfer.timeout = GLib.timeout_add_seconds(8, self._timeout, transfer)
        try:
            transfer.download = view.download_uri(uri)
        except GLib.Error:
            self._failed(transfer)

    def handle_download(self, download):
        transfer = self.transfer
        if (transfer is None or download.get_web_view() != transfer.view
                or download.get_request().get_uri() != transfer.uri
                or (transfer.download is not None and download != transfer.download)):
            return False
        transfer.download = download

        def choose_destination(current, _filename):
            response = current.get_response()
            if (response is None or response.get_content_length() > MAX_MEDIA_BYTES
                    or response.get_mime_type() not in ("video/" + transfer.format, "audio/" + transfer.format)):
                self._failed(transfer)
            else:
                current.set_destination(str(transfer.path))
            return True

        def received(current, _length):
            if current.get_received_data_length() > MAX_MEDIA_BYTES:
                self._failed(transfer)

        download.connect("decide-destination", choose_destination)
        download.connect("received-data", received)
        download.connect("failed", lambda _download, _error: self._failed(transfer))
        download.connect("finished", lambda _download: self._play_finished_download(transfer))
        return True

    def _play_finished_download(self, transfer):
        if self.transfer is not transfer:
            return
        self.transfer = None
        try:
            with transfer.path.open("rb") as clip:
                if not 0 < os.fstat(clip.fileno()).st_size <= MAX_MEDIA_BYTES:
                    raise ValueError("Invalid chat media size")
                # FFplay reads a seekable file descriptor. Remove the directory before launching it.
                transfer.clean_up()
                launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE)
                try:
                    launcher.take_stdin_fd(os.dup(clip.fileno()))
                    self.player = launcher.spawnv([
                        self.ffplay, "-hide_banner", "-loglevel", "error", "-autoexit", "-sn",
                        "-window_title", "ZeloteZ Rooms", "-protocol_whitelist", "fd",
                        "-format_whitelist", FORMAT_WHITELIST, "-i", "fd:",
                    ])
                finally:
                    launcher.close()
        except (OSError, ValueError, GLib.Error):
            transfer.clean_up()
            self.alert(t(PLAYBACK_ERROR))
            return
        self.player.wait_async(None, self._player_exited)

    def _player_exited(self, player, result):
        if player is not self.player:
            return
        self.player = None
        try:
            if player.wait_finish(result) and player.get_successful():
                return
        except GLib.Error:
            pass
        self.alert(t(PLAYBACK_ERROR))

    def _timeout(self, transfer):
        transfer.timeout = 0
        self._failed(transfer)
        return GLib.SOURCE_REMOVE

    def _failed(self, transfer):
        if self.transfer is transfer:
            self.stop()
            self.alert(t(PLAYBACK_ERROR))

    def stop(self):
        transfer, self.transfer = self.transfer, None
        player, self.player = self.player, None
        if transfer is not None:
            if transfer.download is not None:
                transfer.download.cancel()
            transfer.clean_up()
        if player is not None:
            player.force_exit()
