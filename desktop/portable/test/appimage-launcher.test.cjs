"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { verifyAppImageLauncher } = require("../build/appimage-policy.cjs");

test("the repository launcher preserves literal URI arguments without probing or disabling sandboxing", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "rooms-launcher-test-"));
  try {
    const launcher = readFileSync(path.join(__dirname, "../build/AppRun"), "utf8");
    verifyAppImageLauncher(launcher, "[Desktop Entry]\nExec=AppRun %U\n");
    writeFileSync(path.join(directory, "AppRun"), launcher, { mode: 0o755 });
    writeFileSync(path.join(directory, "unshare"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    writeFileSync(path.join(directory, "zelotez-rooms-desktop"), "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n", { mode: 0o755 });
    const args = ["zelotez-rooms://share/youtube/abcdefghijk?instance=https%3A%2F%2Frooms.example", "literal spaces % $ ` words"];
    const output = execFileSync("bash", [path.join(directory, "AppRun"), ...args], {
      encoding: "utf8", env: { ...process.env, APPDIR: directory, PATH: directory + ":" + process.env.PATH },
    });
    assert.deepEqual(JSON.parse(output), args);
    assert.throws(() => verifyAppImageLauncher(launcher + "\nNO_SANDBOX=(--no-sandbox)\n", "Exec=AppRun %U\n"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
