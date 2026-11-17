"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const windows = process.platform === "win32";
const program = windows ? "powershell.exe" : "bash";
const args = windows
  ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File", path.join(__dirname, "build.ps1")]
  : [path.join(__dirname, "build.sh")];
const result = spawnSync(program, args, { cwd: __dirname, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
