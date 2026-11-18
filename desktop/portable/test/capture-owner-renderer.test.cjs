"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { runInNewContext } = require("node:vm");
const test = require("node:test");

const rendererSource = readFileSync(path.join(__dirname, "../ui/capture-owner.js"), "utf8");
const preloadSource = readFileSync(path.join(__dirname, "../capture-owner-preload.cjs"), "utf8");
const portMessage = "rooms:capture-owner-native-port";

function renderer(chromium = null) {
  const paints = [], replies = [], sent = [], acknowledged = [], ended = [];
  const listeners = new Map(), timers = new Map(), intervals = new Map();
  let command, now = 100;
  let chromiumRequests = 0;
  class Canvas {
    constructor(width, height, label = "crop") {
      this.width = width;
      this.height = height;
      this.label = label;
    }
    getContext() {
      return {
        canvas: this,
        drawImage: (image, ...area) => paints.push([this.label, image.label, ...area]),
        fillRect: (...area) => paints.push([this.label, "black", ...area]),
      };
    }
    toDataURL() { return "data:image/jpeg;base64,preview"; }
  }
  class VideoFrame {
    constructor(label, displayWidth, displayHeight) {
      Object.assign(this, { label, displayWidth, displayHeight, closed: 0 });
    }
    close() { this.closed++; }
  }
  const port = { postMessage: value => acknowledged.push(value), close() { this.closed = true; } };
  const window = {
    roomsCaptureOwner: {
      onCommand(callback) { command = callback; },
      reply(id, value, error) { replies.push([id, value ? { ...value } : null, error]); },
      ended: reason => ended.push(reason),
    },
    addEventListener: (name, callback) => listeners.set(name, callback),
    postMessage: (...args) => sent.push(args),
  };
  const output = new Canvas(2, 2, "output");
  runInNewContext(rendererSource, {
    window, VideoFrame, OffscreenCanvas: Canvas,
    MessageChannel: class { constructor() { this.port1 = port; this.port2 = { other: true }; } },
    MediaStreamTrackProcessor: class { constructor() { this.readable = { getReader: () => chromium.reader }; } },
    document: { getElementById: () => output, createElement: () => new Canvas(1, 1, "preview") },
    navigator: { mediaDevices: { getDisplayMedia() {
      chromiumRequests++;
      if (!chromium) throw new Error("Unexpected display-capture request");
      return chromium.source;
    } } },
    performance: { now: () => now },
    setTimeout(callback, delay) {
      const id = Symbol();
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    setInterval(callback, delay) {
      const id = Symbol();
      intervals.set(id, { callback, delay, due: now + delay });
      return id;
    },
    clearInterval: id => intervals.delete(id),
  });
  return {
    window, output, port, paints, replies, sent, acknowledged, ended, timers, intervals, VideoFrame,
    command: (...args) => command(...args),
    advance(value) {
      now = value;
      for (const [id, task] of timers) {
        if (task.due <= now) {
          timers.delete(id);
          task.callback();
        }
      }
      for (const task of intervals.values()) {
        if (task.due <= now) {
          task.due = now + task.delay;
          task.callback();
        }
      }
    },
    hide: () => listeners.get("pagehide")(),
    chromiumRequests: () => chromiumRequests,
  };
}

test("native owner paints the confirmed region from the newest frame and stops on a source resize", async () => {
  const owner = renderer();
  const ready = owner.window.roomsStartLocalCapture({ native: true });
  assert.equal(owner.sent[0][0], portMessage);
  assert.equal(owner.chromiumRequests(), 0);
  const initial = new owner.VideoFrame("initial", 1920, 1080);
  owner.port.onmessage({ data: initial });
  assert.deepEqual({ ...await ready }, { width: 1920, height: 1080 });
  assert.deepEqual(owner.paints, []);
  await owner.command(1, "snapshot");
  assert.deepEqual(owner.paints.splice(0), [["preview", "initial", 0, 0, 640, 360]]);
  assert.deepEqual(owner.replies[0][1], { thumbnail: "data:image/jpeg;base64,preview", width: 1920, height: 1080, aspect: 1920 / 1080 });
  await owner.command(2, "configure", { cropped: true, sourceWidth: 1920, sourceHeight: 1080,
    x: 24, y: 36, cropWidth: 800, cropHeight: 450, width: 640, height: 360, fps: 30 });
  assert.deepEqual(owner.paints.splice(0), [
    ["output", "black", 0, 0, 640, 360],
    ["crop", "initial", 24, 36, 800, 450, 0, 0, 800, 450],
    ["output", "crop", 0, 0, 640, 360],
  ]);
  assert.equal(owner.timers.size, 0);
  assert.deepEqual([...owner.intervals.values()].map(timer => timer.delay), [1000]);

  owner.advance(110);
  const intermediate = new owner.VideoFrame("intermediate", 1920, 1080);
  const newest = new owner.VideoFrame("newest", 1920, 1080);
  owner.port.onmessage({ data: intermediate });
  owner.port.onmessage({ data: newest });
  assert.equal(owner.timers.size, 1);
  assert.equal(initial.closed, 1);
  assert.equal(intermediate.closed, 1);
  assert.deepEqual(owner.paints, []);
  owner.advance(134);
  assert.deepEqual(owner.paints.splice(0), [
    ["output", "black", 0, 0, 640, 360],
    ["crop", "newest", 24, 36, 800, 450, 0, 0, 800, 450],
    ["output", "crop", 0, 0, 640, 360],
  ]);
  owner.advance(1000);
  assert.deepEqual(owner.paints, []);
  owner.advance(1134);
  assert.deepEqual(owner.paints.splice(0), [
    ["output", "black", 0, 0, 640, 360],
    ["crop", "newest", 24, 36, 800, 450, 0, 0, 800, 450],
    ["output", "crop", 0, 0, 640, 360],
  ]);
  owner.advance(1169);
  assert.deepEqual(owner.paints, []);

  const resized = new owner.VideoFrame("different size", 1280, 720);
  owner.port.onmessage({ data: resized });
  assert.equal(newest.closed, 1);
  assert.equal(resized.closed, 1);
  assert.deepEqual(owner.paints, [["output", "black", 0, 0, 640, 360]]);
  assert.deepEqual(owner.ended, ["resized"]);
  assert.deepEqual(owner.acknowledged, ["received", "received", "received"]);
  assert.equal(owner.port.closed, true);
  assert.equal(owner.intervals.size, 0);
  owner.hide();
  assert.deepEqual(owner.ended, ["resized"]);
});

test("Chromium capture still refreshes a static source at the selected frame interval", async () => {
  let deliver;
  const reader = {
    read: () => new Promise(resolve => { deliver = resolve; }),
    async cancel() { deliver({ done: true }); },
  };
  let trackStopped = false;
  const track = { addEventListener() {}, async applyConstraints() {}, stop() { trackStopped = true; } };
  const source = { getVideoTracks: () => [track], getTracks: () => [track] };
  const owner = renderer({ reader, source });
  const ready = owner.window.roomsStartLocalCapture();
  await Promise.resolve();
  const frame = new owner.VideoFrame("still", 640, 360);
  deliver({ value: frame });
  await ready;
  assert.equal(owner.chromiumRequests(), 1);
  assert.deepEqual(owner.sent, []);
  await owner.command(1, "configure", { cropped: false, width: 640, height: 360, fps: 30 });
  const draws = owner.paints.splice(0);
  assert.equal(draws.length, 2);
  owner.advance(135);
  assert.deepEqual(owner.paints.splice(0), draws);
  owner.hide();
  assert.equal(trackStopped, true);
  assert.equal(frame.closed, 1);
  assert.equal(owner.intervals.size, 0);
});

test("native owner rejects startup if its private frame channel ends before a frame", async () => {
  const owner = renderer();
  const ready = owner.window.roomsStartLocalCapture({ native: true });
  owner.port.onmessageerror();
  await assert.rejects(ready, /source ended/u);
  assert.equal(owner.port.closed, true);
  assert.deepEqual(owner.ended, ["unavailable"]);
});

test("private preload only sends one frame at a time and releases stale and dropped textures", async () => {
  let receive;
  const listeners = new Map(), sent = [], transfer = [];
  const port = {
    postMessage: (frame, list) => { transfer.push(frame.id); assert.equal(list[0], frame); },
    close() { this.closed = true; },
  };
  const window = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: name => listeners.delete(name),
  };
  runInNewContext(preloadSource, {
    process: { isMainFrame: true }, window,
    require() {
      return {
        contextBridge: { exposeInMainWorld() {} },
        ipcRenderer: { send: (...values) => sent.push(values) },
        sharedTexture: { setSharedTextureReceiver: callback => { receive = callback; } },
      };
    },
  });
  const connect = listeners.get("message");
  connect({ source: {}, data: portMessage, ports: [port] });
  assert.equal(receive, undefined);
  connect({ source: window, data: portMessage, ports: [port] });
  assert.deepEqual(sent, [["rooms:capture-owner-native-ready"]]);
  async function offer(sequence, expectedRead) {
    let closed = 0, released = 0, reads = 0;
    await receive({ importedSharedTexture: {
      release: () => { released++; },
      getVideoFrame: () => {
        reads++;
        return { id: sequence, close() { closed++; } };
      },
    } }, sequence);
    assert.equal(released, 1);
    assert.equal(reads, expectedRead);
    assert.equal(closed, expectedRead);
  }
  await offer(1, 1);
  await offer(3, 0);
  port.onmessage({ data: "received" });
  await offer(2, 0);
  await offer(4, 1);
  listeners.get("pagehide")();
  await offer(5, 0);
  assert.deepEqual(transfer, [1, 4]);
  assert.equal(port.closed, true);
});
