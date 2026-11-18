#!/usr/bin/env python3
"""Publish two locally built Rooms installers in a self-hosted download directory."""

import argparse
import fcntl
import json
from pathlib import Path
import re
import subprocess
import tempfile
from desktop_release_manifest import (MANIFEST_NAME, SIGNATURE_NAME, check_installer, load_signed_release,
                                      read_small, version_number)


def stage_installer(source, destination, artifact):
    name = artifact["filename"]
    checksum = read_small(source / (name + ".sha256"), 256).decode("ascii").strip()
    match = re.fullmatch(r"([0-9a-f]{64}) [ *]" + re.escape(name), checksum)
    if not match or match[1] != artifact["sha256"]:
        raise ValueError(f"Invalid SHA-256 file for {name}")
    with destination.open("xb") as output:
        check_installer(source, artifact, output)
    destination.chmod(0o644)


def publish(version, source, directory, trusted_key):
    target_version = version_number(version)
    if Path(trusted_key).resolve(strict=True).is_relative_to(directory.resolve()):
        raise ValueError("The trusted operator key must be outside the public download directory")
    manifest, manifest_bytes, signature = load_signed_release(version, source, trusted_key)
    directory.mkdir(parents=True, exist_ok=True)
    current = directory / "current.json"
    target = directory / version
    with (directory / ".publish.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if current.exists():
            active = json.loads(read_small(current, 16384).decode("utf-8"))
            if target_version < version_number(active["version"]):
                raise ValueError("Refusing to replace the current release with an older version")

        with tempfile.TemporaryDirectory(prefix=".publish-", dir=directory) as temporary:
            temporary = Path(temporary)
            assets = temporary / version
            assets.mkdir(mode=0o755)
            assets.chmod(0o755)
            downloads = []
            for artifact in manifest["artifacts"]:
                name = artifact["filename"]
                stage_installer(source, assets / name, artifact)
                downloads.append({"platform": artifact["platform"], "arch": artifact["arch"],
                                  "url": f"/downloads/desktop/{version}/{name}",
                                  "size": artifact["size"], "sha256": artifact["sha256"]})
            for name, content in [(MANIFEST_NAME, manifest_bytes), (SIGNATURE_NAME, signature)]:
                (assets / name).write_bytes(content)
                (assets / name).chmod(0o644)

            if target.exists():
                if target.is_symlink() or {path.name for path in target.iterdir()} != {path.name for path in assets.iterdir()}:
                    raise ValueError(f"Version {version} already exists without the same signed release files")
                for artifact in manifest["artifacts"]:
                    check_installer(target, artifact)
                if read_small(target / MANIFEST_NAME, 8192) != manifest_bytes or read_small(target / SIGNATURE_NAME, 64) != signature:
                    raise ValueError(f"Version {version} already contains a different release signature")
            else:
                assets.rename(target)

            metadata = {
                "current.json": {"version": version, "downloads": downloads,
                                 "manifestUrl": f"/downloads/desktop/{version}/{MANIFEST_NAME}",
                                 "signatureUrl": f"/downloads/desktop/{version}/{SIGNATURE_NAME}"},
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
    parser.add_argument("--trusted-key", type=Path, required=True, help="operator-controlled Ed25519 public key outside the incoming release directory")
    args = parser.parse_args()
    try:
        publish(args.version, args.source, args.directory, args.trusted_key)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Desktop release was not published: {error}\n")
    print(f"Published Rooms {args.version} for Linux and Windows in {args.directory}")


if __name__ == "__main__":
    main()
