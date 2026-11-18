"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

function verifyAppImageLauncher(launcher, desktopEntry) {
  assert.equal(launcher, readFileSync(path.join(__dirname, "AppRun"), "utf8"), "The packaged AppRun must be the checked repository launcher");
  assert(!launcher.includes("--no-sandbox"), "The launcher must never disable the Chromium sandbox");
  assert(!launcher.includes("unshare"), "The launcher must leave sandbox availability decisions to Chromium");
  assert.equal(desktopEntry.split(/\r?\n/u).find(line => line.startsWith("Exec=")), "Exec=AppRun %U");
}

module.exports = { verifyAppImageLauncher };
