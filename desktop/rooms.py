#!/usr/bin/env python3
"""Launch the same desktop app used by the packaged Rooms releases."""

import argparse
import json
import os
from pathlib import Path
from shlex import quote
import sys


def main():
    argparse.ArgumentParser(description="Start the ZeloteZ Rooms desktop app from source.").parse_args()
    portable = Path(__file__).resolve().parent / "portable"
    electron = portable / "node_modules" / "electron"
    dist = (electron / "dist").resolve()

    try:
        pinned = json.loads((portable / "package.json").read_text(encoding="utf-8"))["devDependencies"]["electron"]
        installed = (dist / "version").read_text(encoding="utf-8").strip()
        executable = (dist / (electron / "path.txt").read_text(encoding="utf-8").strip()).resolve()
        if (installed != pinned or not executable.is_relative_to(dist)
                or not executable.is_file() or not os.access(executable, os.X_OK)):
            raise ValueError("Missing or incompatible Electron binary.")
    except (OSError, ValueError, KeyError):
        sys.exit(f"Install the pinned desktop dependencies first:\n  npm --prefix {quote(str(portable))} ci --include=dev")

    environment = os.environ.copy()
    environment.pop("ELECTRON_RUN_AS_NODE", None)
    environment.pop("NODE_OPTIONS", None)
    try:
        os.execve(executable, [str(executable), str(portable)], environment)
    except OSError as error:
        sys.exit(f"The ZeloteZ Rooms desktop app could not start: {error.strerror}")


if __name__ == "__main__":
    main()
