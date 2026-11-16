"use strict";

const { execFile } = require("node:child_process");

function linuxTrayHost() {
  // Creating an icon can succeed on Linux even when nobody displays it.
  // Only hide the window when the session has a registered StatusNotifier host.
  return new Promise(resolve => execFile("busctl", ["--user", "--no-pager", "get-property",
    "org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher", "org.kde.StatusNotifierWatcher", "IsStatusNotifierHostRegistered"],
  { timeout: 1000, maxBuffer: 256 }, (error, stdout) => resolve(!error && stdout.trim() === "b true")));
}

async function trayUsable(tray) {
  if (!tray || tray.isDestroyed()) return false;
  return trayHostAvailable();
}

async function trayHostAvailable() {
  return process.platform !== "linux" || await linuxTrayHost();
}

module.exports = { trayHostAvailable, trayUsable };
