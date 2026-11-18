"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { runInNewContext } = require("node:vm");
const test = require("node:test");

test("capture owners share one session and session handlers retain only live trusted owners", () => {
  const filename = path.join(__dirname, "../capture-owner.cjs");
  const address = pathToFileURL(path.join(__dirname, "../ui/capture-owner.html")).href;
  let sessionCount = 0, sequence = 0;
  const windows = [], handlers = {}, media = {
    setPermissionCheckHandler: fn => { handlers.permission = fn; },
    setPermissionRequestHandler() {},
    setDisplayMediaRequestHandler: fn => { handlers.display = fn; },
    webRequest: { onBeforeRequest: fn => { handlers.network = fn; } },
  };
  class Window extends EventEmitter {
    constructor() {
      super();
      this.closed = false;
      const contents = this.webContents = new EventEmitter();
      contents.id = ++sequence;
      contents.mainFrame = { url: address, detached: false };
      contents.getURL = () => address;
      contents.setWindowOpenHandler = () => {};
      this.isDestroyed = () => this.closed;
      this.loadFile = () => new Promise(() => {});
      this.destroy = () => { this.closed = true; this.emit("closed"); };
      windows.push(this);
    }
  }
  const module = { exports: {} };
  runInNewContext(readFileSync(filename, "utf8"), {
    module, __dirname: path.dirname(filename),
    require(name) {
      if (name === "electron") return { BrowserWindow: Window, ipcMain: { on() {} },
        session: { fromPartition: () => { sessionCount++; return media; } } };
      if (name === "./capture-geometry.cjs") return require("../capture-geometry.cjs");
      return require(name);
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
  }, { filename });
  const make = source => module.exports.createCaptureOwner({ source, valid: () => true, onEnded() {} });
  const first = make({ id: "first source" }), second = make({ id: "second source" });
  assert.equal(sessionCount, 1);
  const request = window => ({ frame: window.webContents.mainFrame, videoRequested: true, audioRequested: false, userGesture: true });
  let grant;
  handlers.display(request(windows[0]), value => { grant = value; });
  assert.equal(grant.video.id, "first source");
  handlers.display(request(windows[1]), value => { grant = value; });
  assert.equal(grant.video.id, "second source");
  first.close();
  assert.equal(handlers.permission(windows[0].webContents, "display-capture", "file://", { isMainFrame: true }), false);
  assert.equal(handlers.permission(windows[1].webContents, "display-capture", "file://", { isMainFrame: true }), true);
  handlers.display(request(windows[0]), value => { grant = value; });
  assert.equal(grant, null);
  let network;
  handlers.network({ webContentsId: windows[1].webContents.id, url: "https://outside.example/" }, value => { network = value; });
  assert.equal(network.cancel, true);
  second.close();
  const third = make({ id: "third source" });
  assert.equal(sessionCount, 1);
  third.close();
});
