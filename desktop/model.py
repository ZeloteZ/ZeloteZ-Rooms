from dataclasses import dataclass
from ipaddress import ip_address
from math import ceil, floor
import re
from urllib.parse import urlsplit

from i18n import t


STREAM_ID = re.compile(r"[a-f0-9]{32}")


def server_origin(text):
    value = text.strip().rstrip("/")
    if any(char.isspace() or char in "\\%" for char in value):
        raise ValueError
    url = urlsplit(value)
    port = url.port
    if (not url.hostname or port == 0 or url.username is not None or url.path or url.query or url.fragment
            or (url.scheme != "https" and
                (url.scheme != "http" or url.hostname not in ("localhost", "127.0.0.1", "::1")))):
        raise ValueError
    host = url.hostname.encode("idna").decode("ascii")
    host = f"[{host}]" if ":" in host else host
    if port and port != (443 if url.scheme == "https" else 80):
        host += f":{port}"
    return f"{url.scheme}://{host}"


@dataclass(frozen=True)
class Destination:
    host: str
    port: int
    secure: bool
    stream: str = ""


def parse_destination(address):
    address = address.strip()
    if any(char.isspace() or ord(char) < 32 for char in address) or any(
        char in address for char in "?#\\%"
    ):
        raise ValueError(t("Enter the server address without extra parameters."))
    try:
        url = urlsplit(address)
        port = url.port
        host = url.hostname
    except ValueError:
        raise ValueError(t("The server address is invalid.")) from None

    stream_match = re.fullmatch(r"/live/([a-f0-9]{32})/?", url.path)
    if (
        url.scheme not in ("rtmp", "rtmps")
        or not host
        or url.username is not None
        or not (url.path in ("", "/", "/live", "/live/") or stream_match)
        or port == 0
        or url.netloc.endswith(":")
    ):
        raise ValueError(t("Copy the RTMPS address from your live channel."))

    secure = url.scheme == "rtmps"
    try:
        address_ip = ip_address(host)
    except ValueError:
        address_ip = None
        try:
            host = host.encode("idna").decode("ascii")
        except UnicodeError:
            raise ValueError(t("The server name is invalid.")) from None
        labels = host.rstrip(".").split(".")
        if len(host) > 253 or any(
            not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
            for label in labels
        ):
            raise ValueError(t("The server name is invalid."))

    if not secure and not (address_ip and address_ip.is_loopback):
        raise ValueError(t("RTMP without TLS is available only for local tests on 127.0.0.1 or [::1]."))
    stream = stream_match.group(1) if stream_match else ""
    return Destination(host, port or (1936 if secure else 1935), secure, stream)


def validate_key(key):
    key = key.strip()
    if not re.fullmatch(r"[a-fA-F0-9]{64}", key):
        raise ValueError(t("The stream key must contain 64 hexadecimal characters."))
    return key


def reservation_id(data):
    stream = data.get("stream") if isinstance(data, dict) else None
    stream_id = stream.get("id") if isinstance(stream, dict) else None
    return stream_id if isinstance(stream_id, str) and STREAM_ID.fullmatch(stream_id) else None


def capture_reservation(data, origin):
    stream_id = reservation_id(data)
    if stream_id is None or not isinstance(data.get("address"), str) or not isinstance(data.get("key"), str):
        raise ValueError
    target = parse_destination(data["address"])
    key = validate_key(data["key"])
    if (target.host != origin.hostname or target.stream != stream_id or (origin.scheme == "https" and not target.secure)):
        raise ValueError
    return {"id": stream_id, "address": data["address"], "key": key}


@dataclass(frozen=True)
class Region:
    x: int
    y: int
    width: int
    height: int


def picture_bounds(view_width, view_height, source_width, source_height):
    scale = min(view_width / source_width, view_height / source_height)
    left = (view_width - source_width * scale) / 2
    top = (view_height - source_height * scale) / 2
    return left, top, scale


def region_from_drag(start, end, view_size, source_size):
    width, height = source_size
    left, top, scale = picture_bounds(*view_size, width, height)
    if scale <= 0:
        return None
    x1, x2 = sorted((start[0], end[0]))
    y1, y2 = sorted((start[1], end[1]))
    x1 = max(0, ceil((x1 - left) / scale))
    y1 = max(0, ceil((y1 - top) / scale))
    x2 = min(width, floor((x2 - left) / scale))
    y2 = min(height, floor((y2 - top) / scale))
    if x2 - x1 < 32 or y2 - y1 < 32:
        return None
    return Region(x1, y1, x2 - x1, y2 - y1)


@dataclass(frozen=True)
class Quality:
    width: int
    height: int
    fps: int
    bitrate: int


QUALITY_PRESETS = (
    (1280, 720, 3000, 4500),
    (1920, 1080, 5000, 7500),
    (2560, 1440, 8000, 11000),
)
