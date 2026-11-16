from dataclasses import dataclass
import json
import subprocess

from i18n import t


@dataclass(frozen=True)
class AudioOutput:
    title: str
    serial: str
    identity: tuple
    mode: str


def list_audio_outputs(mode):
    try:
        result = subprocess.run(["pw-dump"], capture_output=True, text=True, check=True, timeout=2)
        graph = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        raise RuntimeError(t("Audio outputs couldn’t be loaded. Check that PipeWire is running.")) from error

    outputs = []
    media_class = "Audio/Sink" if mode == "system" else "Stream/Output/Audio"
    for item in graph:
        if item.get("type") != "PipeWire:Interface:Node":
            continue
        props = item.get("info", {}).get("props", {})
        if props.get("media.class") != media_class:
            continue
        serial = str(props.get("object.serial", ""))
        if not serial.isascii() or not serial.isdecimal():
            continue
        node = props.get("node.name")
        if mode == "system":
            if not node:
                continue
            title = props.get("node.description") or props.get("node.nick") or node
            identity = (node, props.get("device.id"))
        else:
            name = props.get("application.name") or props.get("application.process.binary")
            process = str(props.get("application.process.id", ""))
            if not process.isdecimal() or not name:
                continue
            media = props.get("media.name")
            title = f"{name} · {media}" if media and media != name else name
            identity = (process, props.get("application.id"), props.get("application.process.binary"), node)
        outputs.append(AudioOutput(" ".join(str(title).split())[:110], serial, identity, mode))
    return tuple(sorted(outputs, key=lambda output: (output.title.casefold(), int(output.serial))))


def validate_audio_output(selection):
    for output in list_audio_outputs(selection.mode):
        if output.serial == selection.serial and output.identity == selection.identity:
            return output
    raise RuntimeError(t("The selected audio output is unavailable. Choose it again."))
