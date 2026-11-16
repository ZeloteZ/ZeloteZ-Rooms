#!/usr/bin/env python3
"""Launch the same desktop app used by the packaged Rooms releases."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


def installed_electron(portable, version):
    electron = portable / "node_modules" / "electron"
    try:
        if electron.resolve() != electron:
            return None
        dist = electron / "dist"
        if dist.resolve() != dist:
            return None
        installed = (dist / "version").read_text(encoding="utf-8").strip().removeprefix("v")
        executable = (dist / (electron / "path.txt").read_text(encoding="utf-8").strip()).resolve()
        if installed == version and executable.is_relative_to(dist) and executable.is_file() and os.access(executable, os.X_OK):
            return executable
    except (OSError, ValueError, RuntimeError):
        pass
    return None


def launch_environment():
    overrides = {"node_options", "node_path", "electron_run_as_node", "electron_override_dist_path",
                 "electron_install_platform", "electron_install_arch", "electron_custom_version",
                 "electron_use_remote_checksums", "npm_config_arch", "npm_config_platform"}
    return {name: value for name, value in os.environ.items() if name.lower() not in overrides
            and not name.lower().startswith(("npm_config_electron_", "npm_package_config_electron_"))}


def install_electron(portable, lockfile, version, environment):
    try:
        from fcntl import LOCK_EX, flock
    except ImportError:
        raise RuntimeError("Use the Windows installer on Windows.") from None

    # npm ci leaves the lockfile in place, so parallel launcher invocations can share its lock.
    with lockfile.open("rb") as lock:
        flock(lock.fileno(), LOCK_EX)
        if executable := installed_electron(portable, version):
            return executable
        if (portable / "node_modules").is_symlink():
            raise RuntimeError("Electron setup needs a project-local node_modules directory.")

        node, npm = shutil.which("node"), shutil.which("npm")
        if not node or not npm:
            raise RuntimeError("Install Node.js 22.12 or later and npm for the first launch.")
        output = subprocess.run([node, "--version"], env=environment, capture_output=True, text=True, check=True)
        number = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", output.stdout.strip())
        if not number or tuple(map(int, number.groups())) < (22, 12, 0):
            raise RuntimeError("Install Node.js 22.12 or later and run this launcher again.")

        print(f"Setting up the pinned Electron {version} for ZeloteZ Rooms…", flush=True)
        subprocess.run([npm, "--prefix", str(portable), "ci", "--global=false", "--include=dev", "--ignore-scripts",
                        "--no-audit", "--no-fund"], cwd=portable, env=environment, check=True)
        # Electron 45 downloads its release binary on demand using this pinned package's checksums.
        installer = portable / "node_modules" / "electron" / "install.js"
        subprocess.run([node, str(installer)], cwd=portable, env=environment, check=True)
        executable = installed_electron(portable, version)
        if not executable:
            raise RuntimeError("Electron setup did not produce the expected project-local executable.")
        return executable


def main():
    argparse.ArgumentParser(description="Start the ZeloteZ Rooms desktop app from source.").parse_args()
    portable = Path(__file__).resolve().parent / "portable"
    lockfile = portable / "package-lock.json"
    environment = launch_environment()
    try:
        version = json.loads((portable / "package.json").read_text(encoding="utf-8"))["devDependencies"]["electron"]
        locked = json.loads(lockfile.read_text(encoding="utf-8"))["packages"]["node_modules/electron"]["version"]
        if version != locked or not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
            raise ValueError("The Electron version must match the project lockfile.")
        executable = installed_electron(portable, version) or install_electron(portable, lockfile, version, environment)
    except subprocess.CalledProcessError:
        sys.exit("Electron setup failed. Check the error above and run python3 desktop/rooms.py again.")
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
        sys.exit(f"ZeloteZ Rooms setup: {error}")

    try:
        os.execve(executable, [str(executable), str(portable)], environment)
    except OSError as error:
        sys.exit(f"The ZeloteZ Rooms desktop app could not start: {error.strerror}")


if __name__ == "__main__":
    main()
