#!/usr/bin/env python3
"""Publish two locally built Rooms installers in a self-hosted download directory."""

import argparse
import fcntl
import hashlib
import json
from pathlib import Path
import re
import tempfile


VERSION = re.compile(r"(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){2}")
MAX_INSTALLER = 256 * 1024**2


def version_number(version):
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise ValueError("Expected a stable desktop version, such as 0.1.29")
    return tuple(map(int, version.split(".")))


def stage_installer(source, destination, name, magic):
    checksum = (source / (name + ".sha256")).read_text(encoding="ascii").strip()
    match = re.fullmatch(r"([0-9a-f]{64}) [ *]" + re.escape(name), checksum)
    if not match:
        raise ValueError(f"Invalid SHA-256 file for {name}")
    digest = hashlib.sha256()
    size = 0
    with (source / name).open("rb") as installer, destination.open("xb") as output:
        if installer.read(len(magic)) != magic:
            raise ValueError(f"Invalid installer format for {name}")
        installer.seek(0)
        while chunk := installer.read(1024**2):
            size += len(chunk)
            if size > MAX_INSTALLER:
                raise ValueError(f"Installer too large: {name}")
            digest.update(chunk)
            output.write(chunk)
    if digest.hexdigest() != match[1]:
        raise ValueError(f"SHA-256 mismatch for {name}")
    destination.chmod(0o644)
    return size, match[1]


def publish(version, source, directory):
    target_version = version_number(version)
    directory.mkdir(parents=True, exist_ok=True)
    current = directory / "current.json"
    target = directory / version
    with (directory / ".publish.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if current.exists():
            active = json.loads(current.read_text(encoding="utf-8"))
            if target_version < version_number(active["version"]):
                raise ValueError("Refusing to replace the current release with an older version")

        with tempfile.TemporaryDirectory(prefix=".publish-", dir=directory) as temporary:
            temporary = Path(temporary)
            assets = temporary / version
            assets.mkdir(mode=0o755)
            assets.chmod(0o755)
            downloads = []
            for platform, suffix, magic in [("linux", "x86_64.AppImage", b"\x7fELF"), ("windows", "x64.exe", b"MZ")]:
                name = f"ZeloteZ-Rooms-{version}-{suffix}"
                size, checksum = stage_installer(source, assets / name, name, magic)
                downloads.append({"platform": platform, "arch": "x64", "url": f"/downloads/desktop/{version}/{name}",
                                  "size": size, "sha256": checksum})

            if target.exists():
                for item in downloads:
                    name = item["url"].rsplit("/", 1)[1]
                    with (target / name).open("rb") as existing:
                        if hashlib.file_digest(existing, "sha256").hexdigest() != item["sha256"]:
                            raise ValueError(f"Version {version} already contains a different {name}")
            else:
                assets.rename(target)

            metadata = {
                "current.json": {"version": version, "downloads": downloads},
                "release.json": {"product": "zelotez-rooms", "protocol": 1, "version": version,
                                 "artifacts": [f"{item['platform']}-{item['arch']}" for item in downloads]},
            }
            for name, document in metadata.items():
                output = temporary / name
                output.write_text(json.dumps(document) + "\n", encoding="utf-8")
                output.chmod(0o644)
                output.replace(directory / name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    parser.add_argument("--source", type=Path, required=True, help="directory containing both installers and their .sha256 files")
    parser.add_argument("--directory", type=Path, default=Path("desktop-downloads"), help="download directory mounted by the gateway")
    args = parser.parse_args()
    try:
        publish(args.version, args.source, args.directory)
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, f"Desktop release was not published: {error}\n")
    print(f"Published Rooms {args.version} for Linux and Windows in {args.directory}")


if __name__ == "__main__":
    main()
