import json
from pathlib import Path
import secrets
import subprocess
import sys
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from model import server_origin


ERROR_CODES = ("invalid", "unreachable", "not_rooms", "incompatible")


class InstanceVerificationError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def has_media_type(value, media_type):
    return bool(value and "," not in value and value.split(";", 1)[0].strip().lower() == media_type)


def has_rooms_page_headers(status, content_type, marker):
    return status == 200 and has_media_type(content_type, "text/html") and marker == "1"


def single_header(response, key):
    values = response.headers.get_all(key, [])
    return values[0] if len(values) == 1 else None


def probe(origin):
    nonce = secrets.token_hex(16)
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        request = Request(
            f"{origin}/api/desktop/instance?nonce={nonce}",
            headers={"Accept-Encoding": "identity", "Cache-Control": "no-store"},
        )
        with opener.open(request, timeout=6) as response:
            encoding = response.headers.get_all("Content-Encoding", [])
            if (response.status != 200
                    or not has_media_type(single_header(response, "Content-Type"), "application/json")
                    or encoding not in ([], ["identity"])):
                raise InstanceVerificationError("not_rooms")
            data = response.read(1025)
        if len(data) > 1024:
            raise InstanceVerificationError("not_rooms")
        try:
            descriptor = json.loads(data)
        except (ValueError, RecursionError):
            raise InstanceVerificationError("not_rooms") from None
        if (not isinstance(descriptor, dict) or descriptor.get("product") != "zelotez-rooms"
                or descriptor.get("origin") != origin or descriptor.get("nonce") != nonce
                or type(descriptor.get("protocol")) is not int):
            raise InstanceVerificationError("not_rooms")
        if descriptor["protocol"] != 1:
            raise InstanceVerificationError("incompatible")
        with opener.open(Request(f"{origin}/", method="HEAD"), timeout=6) as response:
            if not has_rooms_page_headers(
                response.status,
                single_header(response, "Content-Type"),
                single_header(response, "X-ZeloteZ-Rooms-Client"),
            ):
                raise InstanceVerificationError("not_rooms")
    except HTTPError as error:
        error.close()
        raise InstanceVerificationError("not_rooms") from None
    except (URLError, OSError):
        raise InstanceVerificationError("unreachable") from None


def verify_instance(address):
    try:
        origin = server_origin(address)
    except (ValueError, AttributeError):
        raise InstanceVerificationError("invalid") from None
    # A wall-clock limit also covers DNS and a server slowly sending its headers.
    try:
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), origin],
            check=False, timeout=8, capture_output=True,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise InstanceVerificationError("unreachable") from None
    if result.returncode:
        code = result.returncode - 10
        raise InstanceVerificationError(ERROR_CODES[code] if 0 <= code < len(ERROR_CODES) else "unreachable")
    return origin


if __name__ == "__main__":
    try:
        probe(server_origin(sys.argv[1]))
    except ValueError:
        sys.exit(10)
    except InstanceVerificationError as error:
        sys.exit(10 + ERROR_CODES.index(error.code))
