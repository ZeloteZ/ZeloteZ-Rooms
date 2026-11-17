"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

const filename = resolve(__dirname, "../main.cjs");
const source = readFileSync(filename, "utf8");

async function startup(noSandbox) {
  const calls = [];
  const app = {
    commandLine: { hasSwitch: name => noSandbox && name === "no-sandbox" },
    getLocale: () => "en-US",
    whenReady: () => Promise.resolve(),
    requestSingleInstanceLock() {
      calls.push("instance-lock");
      return false;
    },
    exit: code => calls.push(["exit", code]),
    quit: () => calls.push("quit"),
  };
  const dialog = { showErrorBox: (_title, message) => calls.push(["error", message]) };
  runInNewContext(source, {
    __dirname,
    process: { platform: "linux", argv: [] },
    require(name) {
      if (name === "electron") return { app, dialog, ipcMain: { handle() {} } };
      if (name === "./desktop-notifications.cjs") return { desktopNotifications: () => ({}) };
      if (name === "./share-link.cjs") return require("../share-link.cjs");
      if (name.startsWith("./")) return {};
      return require(name);
    },
    setTimeout,
    clearTimeout,
  }, { filename });
  await new Promise(resolve => setImmediate(resolve));
  return calls;
}

test("Linux refuses to start normal desktop initialization with the Chromium sandbox disabled", async () => {
  const calls = await startup(true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "error");
  assert.match(calls[0][1], /Chromium sandbox is disabled/);
  assert.deepEqual(calls[1], ["exit", 1]);
});

test("Linux attempts normal desktop initialization without the no-sandbox flag", async () => {
  assert.deepEqual(await startup(false), ["instance-lock", "quit"]);
});
