from dataclasses import dataclass
import json
import subprocess

from i18n import t


@dataclass(frozen=True)
class AppAudio:
    title: str
    serial: str
    identity: tuple


def list_app_audio():
    try:
        result = subprocess.run(["pw-dump"], capture_output=True, text=True, check=True, timeout=2)
        graph = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        raise RuntimeError(t("Audio apps couldn’t be loaded. Check that PipeWire is running.")) from error

    outputs = []
    for item in graph:
        if item.get("type") != "PipeWire:Interface:Node":
            continue
        props = item.get("info", {}).get("props", {})
        if props.get("media.class") != "Stream/Output/Audio":
            continue
        serial = str(props.get("object.serial", ""))
        name = props.get("application.name") or props.get("application.process.binary")
        process = str(props.get("application.process.id", ""))
        if not serial.isdecimal() or not process.isdecimal() or not name:
            continue
        media = props.get("media.name")
        title = f"{name} · {media}" if media and media != name else str(name)
        identity = (process, props.get("application.id"), props.get("application.process.binary"), props.get("node.name"))
        outputs.append(AppAudio(" ".join(title.split())[:110], serial, identity))
    return tuple(sorted(outputs, key=lambda output: (output.title.casefold(), int(output.serial))))


def validate_app_audio(selection):
    for output in list_app_audio():
        if output.serial == selection.serial and output.identity == selection.identity:
            return output.serial
    raise RuntimeError(t("The selected audio source is unavailable. Choose the app again."))
