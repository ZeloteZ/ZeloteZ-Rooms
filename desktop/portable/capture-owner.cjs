"use strict";

const { BrowserWindow, ipcMain, session } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { captureGeometry } = require("./capture-geometry.cjs");

const page = path.join(__dirname, "ui", "capture-owner.html");
const address = pathToFileURL(page).href;
const owners = new Map();
const files = new Set(["capture-owner.html", "capture-owner.js", "capture-owner.css"].map(name => pathToFileURL(path.join(__dirname, "ui", name)).href));
let ownerSession;

function trustedSession() {
  if (ownerSession) return ownerSession;
  ownerSession = session.fromPartition("rooms-trusted-capture-owner");
  const permission = (contents, name, details) => {
    const owner = owners.get(contents?.id);
    return Boolean(owner?.displayMedia && name === "display-capture" && details.isMainFrame && owner.owns(contents.mainFrame));
  };
  ownerSession.setPermissionCheckHandler((contents, name, _origin, details) => permission(contents, name, details));
  ownerSession.setPermissionRequestHandler((contents, name, callback, details) => callback(permission(contents, name, details)));
  ownerSession.setDisplayMediaRequestHandler((event, callback) => {
    const owner = [...owners.values()].find(candidate => candidate.owns(event.frame));
    if (!owner) return callback(null);
    owner.grant(event, callback);
  });
  ownerSession.webRequest.onBeforeRequest((event, callback) => callback({ cancel: !owners.has(event.webContentsId) || !files.has(event.url) }));
  return ownerSession;
}

function sender(event) {
  const owner = owners.get(event.sender.id), frame = event.senderFrame;
  return owner && frame && !frame.detached && frame === event.sender.mainFrame && frame.url === address ? owner : null;
}

ipcMain.on("rooms:capture-owner-reply", (event, id, value, error) => sender(event)?.reply(id, value, error));
ipcMain.on("rooms:capture-owner-ended", event => sender(event)?.ended());
ipcMain.on("rooms:capture-owner-native-ready", event => sender(event)?.nativeReady());

function createCaptureOwner({ source, valid, onEnded, startNative }) {
  const media = trustedSession();
  const window = new BrowserWindow({ width: 2, height: 2, useContentSize: true, show: false, frame: false,
    skipTaskbar: true, focusable: false, backgroundColor: "#000000",
    webPreferences: { session: media, preload: path.join(__dirname, "capture-owner-preload.cjs"),
      sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, backgroundThrottling: false } });
  const contents = window.webContents, contentsId = contents.id, pending = new Map();
  let closed = false, request = 0, granted = false, monitor, nativeCapture;
  const owns = frame => !closed && valid() && frame && !frame.detached && frame === contents.mainFrame && frame.url === address;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-frame-navigate", event => event.preventDefault());
  contents.on("will-redirect", event => event.preventDefault());

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(monitor);
    nativeCapture?.close();
    owners.delete(contentsId);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Capture cancelled")); }
    pending.clear();
    if (!window.isDestroyed()) window.destroy();
  }
  function ended() { if (!closed) { close(); onEnded(); } }
  contents.once("render-process-gone", ended);
  window.once("closed", ended);
  const owner = {
    close, ended, owns, displayMedia: !startNative,
    nativeReady() {
      if (!startNative || nativeCapture || !owns(contents.mainFrame)) return;
      const target = () => owns(contents.mainFrame) ? contents.mainFrame : null;
      try {
        const capture = startNative(source, target, ended);
        if (closed) capture.close();
        else nativeCapture = capture;
      } catch { ended(); }
    },
    grant(event, callback) {
      if (startNative || granted || !event.videoRequested || event.audioRequested || !event.userGesture || !owns(event.frame)) return callback(null);
      granted = true;
      callback({ video: source });
    },
    reply(id, value, error) {
      const item = pending.get(id);
      if (!item) return;
      pending.delete(id);
      clearTimeout(item.timer);
      if (error) item.reject(new Error("The local capture source failed"));
      else item.resolve(value);
    },
  };
  owners.set(contentsId, owner);
  const ready = (async () => {
    await window.loadFile(page);
    if (closed || !valid()) throw new Error("Capture cancelled");
    return contents.executeJavaScript(startNative ? "window.roomsStartLocalCapture({ native: true })" : "window.roomsStartLocalCapture()", true);
  })();
  // The UI can cancel while the operating system is still opening a source.
  ready.catch(ended);
  function command(operation, value) {
    if (closed || !valid()) return Promise.reject(new Error("Capture cancelled"));
    return new Promise((resolve, reject) => {
      const id = ++request;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("The local capture source timed out")); ended(); }, 10000);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      contents.send("rooms:capture-owner-command", id, operation, value);
    });
  }
  return Object.assign(owner, {
    ready,
    async snapshot() { await ready; return command("snapshot"); },
    async configure(options) {
      await ready;
      const dimensions = await command("dimensions");
      const geometry = captureGeometry(dimensions, options);
      if (closed || !valid()) throw new Error("Capture cancelled");
      nativeCapture?.setFrameRate(geometry.fps);
      window.setContentSize(geometry.width, geometry.height);
      await command("configure", geometry);
      return contents.mainFrame;
    },
    delivered() {
      let captured = false;
      const deadline = performance.now() + 5000;
      monitor = setInterval(() => {
        if (closed) return;
        if (!valid() || contents.isDestroyed()) return ended();
        const active = contents.isBeingCaptured();
        captured ||= active;
        if (!active && (captured || performance.now() > deadline)) ended();
      }, 250);
      monitor.unref();
    },
  });
}

module.exports = { createCaptureOwner };
