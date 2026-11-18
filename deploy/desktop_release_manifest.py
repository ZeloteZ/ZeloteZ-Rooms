"""Offline Ed25519 manifests for the two locally built Rooms installers."""

import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile


OPENSSL = "/usr/bin/openssl"
MANIFEST_NAME = "desktop-release-manifest.json"
SIGNATURE_NAME = "desktop-release-manifest.sig"
MAX_MANIFEST = 8192
MAX_KEY = 16384
MAX_INSTALLER = 256 * 1024**2
VERSION = re.compile(r"(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){2}")
HASH = re.compile(r"[a-f0-9]{64}")
ED25519_SPKI = bytes.fromhex("302a300506032b6570032100")


def version_number(version):
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise ValueError("Expected a stable desktop version, such as 0.1.33")
    return tuple(map(int, version.split(".")))


def artifacts_for(version):
    version_number(version)
    return [
        {"platform": "linux", "arch": "x64", "filename": f"ZeloteZ-Rooms-{version}-x86_64.AppImage"},
        {"platform": "windows", "arch": "x64", "filename": f"ZeloteZ-Rooms-{version}-x64.exe"},
    ]


@contextlib.contextmanager
def regular_file(path, maximum):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= maximum:
            raise ValueError(f"Expected a bounded regular file: {Path(path).name}")
        with os.fdopen(fd, "rb", closefd=False) as file:
            yield file, info
    finally:
        os.close(fd)


def read_small(path, maximum):
    with regular_file(path, maximum) as (file, _):
        data = file.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError(f"File exceeds its size limit: {Path(path).name}")
    return data


def canonical(document):
    return (json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii")


def no_duplicate_fields(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate release manifest field")
        result[key] = value
    return result


def parse_manifest(data, version):
    version_number(version)
    if not 0 < len(data) <= MAX_MANIFEST:
        raise ValueError("Invalid release manifest size")
    document = json.loads(data.decode("utf-8"), object_pairs_hook=no_duplicate_fields)
    if (not isinstance(document, dict) or set(document) != {"product", "schema", "version", "artifacts"}
            or document["product"] != "zelotez-rooms" or type(document["schema"]) is not int
            or document["schema"] != 1 or document["version"] != version
            or not isinstance(document["artifacts"], list) or len(document["artifacts"]) != 2):
        raise ValueError("Invalid desktop release manifest")
    for expected, item in zip(artifacts_for(version), document["artifacts"], strict=True):
        if (not isinstance(item, dict) or set(item) != {"platform", "arch", "filename", "size", "sha256"}
                or any(item[key] != value for key, value in expected.items())
                or type(item["size"]) is not int or not 0 < item["size"] <= MAX_INSTALLER
                or not isinstance(item["sha256"], str) or not HASH.fullmatch(item["sha256"])):
            raise ValueError("Invalid release artifact fields, filename, platform or size")
    if canonical(document) != data:
        raise ValueError("Release manifest must use the canonical JSON encoding")
    return document


def openssl(arguments, *, pass_fds=()):
    result = subprocess.run([OPENSSL, *arguments], input=b"", stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, pass_fds=pass_fds, timeout=15, check=False)
    if result.returncode:
        raise ValueError("OpenSSL could not verify or sign this Ed25519 release")
    return result.stdout


@contextlib.contextmanager
def operator_key(path, source, *, private=False):
    path, source = Path(path), Path(source).resolve(strict=True)
    if path.resolve(strict=True).is_relative_to(source):
        raise ValueError("The operator key must be outside the incoming release directory")
    with regular_file(path, MAX_KEY) as (file, info):
        if info.st_uid not in {0, os.geteuid()} or info.st_mode & (0o077 if private else 0o022):
            raise ValueError("The operator key must be owned and protected by the operator")
        fd = file.fileno()
        key = f"/proc/self/fd/{fd}"
        arguments = ["pkey", "-in", key, "-outform", "DER"]
        arguments += ["-passin", "pass:", "-pubout"] if private else ["-pubin"]
        public = openssl(arguments, pass_fds=(fd,))
        if len(public) != len(ED25519_SPKI) + 32 or not public.startswith(ED25519_SPKI):
            raise ValueError("An Ed25519 operator key is required")
        yield key, (fd,)


def signature_for(data, source, key_path, *, signature=None):
    private = signature is None
    with operator_key(key_path, source, private=private) as (key, descriptors):
        with tempfile.TemporaryDirectory(prefix="rooms-release-signature-") as folder:
            folder = Path(folder)
            manifest, signed = folder / "manifest.json", folder / "manifest.sig"
            manifest.write_bytes(data)
            if private:
                openssl(["pkeyutl", "-sign", "-rawin", "-inkey", key, "-passin", "pass:",
                         "-in", str(manifest), "-out", str(signed)], pass_fds=descriptors)
                result = signed.read_bytes()
                if len(result) != 64:
                    raise ValueError("Invalid Ed25519 signature size")
                return result
            if len(signature) != 64:
                raise ValueError("Invalid Ed25519 signature size")
            signed.write_bytes(signature)
            openssl(["pkeyutl", "-verify", "-pubin", "-rawin", "-inkey", key,
                     "-in", str(manifest), "-sigfile", str(signed)], pass_fds=descriptors)
            return None


def check_installer(source, artifact, destination=None):
    name = artifact["filename"]
    magic = b"\x7fELF" if artifact["platform"] == "linux" else b"MZ"
    digest, size = hashlib.sha256(), 0
    with regular_file(Path(source) / name, MAX_INSTALLER) as (installer, info):
        if "size" in artifact and info.st_size != artifact["size"]:
            raise ValueError(f"Signed installer size mismatch: {name}")
        if installer.read(len(magic)) != magic:
            raise ValueError(f"Invalid installer format: {name}")
        installer.seek(0)
        while chunk := installer.read(1024**2):
            size += len(chunk)
            if size > artifact.get("size", MAX_INSTALLER):
                raise ValueError(f"Installer exceeds its signed size: {name}")
            digest.update(chunk)
            if destination:
                destination.write(chunk)
    checksum = digest.hexdigest()
    if "size" in artifact and (size != artifact["size"] or checksum != artifact["sha256"]):
        raise ValueError(f"Signed installer SHA-256 mismatch: {name}")
    return {**artifact, "size": size, "sha256": checksum}


def load_signed_release(version, source, trusted_key):
    source = Path(source)
    data = read_small(source / MANIFEST_NAME, MAX_MANIFEST)
    signature = read_small(source / SIGNATURE_NAME, 64)
    # Verify the exact buffered bytes, never a second read of a replaceable incoming path.
    signature_for(data, source, trusted_key, signature=signature)
    return parse_manifest(data, version), data, signature


def sign_release(version, source, private_key):
    source = Path(source)
    document = {"product": "zelotez-rooms", "schema": 1, "version": version,
                "artifacts": [check_installer(source, item) for item in artifacts_for(version)]}
    data = canonical(document)
    parse_manifest(data, version)
    signature = signature_for(data, source, private_key)
    with tempfile.TemporaryDirectory(prefix=".signed-release-", dir=source) as temporary:
        for name, content in [(MANIFEST_NAME, data), (SIGNATURE_NAME, signature)]:
            staged = Path(temporary) / name
            staged.write_bytes(content)
            staged.chmod(0o644)
            staged.replace(source / name)
    return document


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ["sign", "verify"]:
        command = commands.add_parser(name)
        command.add_argument("version")
        command.add_argument("--source", type=Path, required=True)
        command.add_argument("--private-key" if name == "sign" else "--trusted-key", type=Path, required=True)
        if name == "verify":
            command.add_argument("--platform", choices=["linux", "windows"],
                                 help="verify only this downloaded installer; the complete manifest is still authenticated")
    args = parser.parse_args()
    try:
        if args.command == "sign":
            sign_release(args.version, args.source, args.private_key)
        else:
            manifest, _, _ = load_signed_release(args.version, args.source, args.trusted_key)
            for artifact in manifest["artifacts"]:
                if args.platform is None or artifact["platform"] == args.platform:
                    check_installer(args.source, artifact)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Desktop release {args.command} failed: {error}\n")
    print(f"Rooms {args.version}: release {args.command} succeeded")
