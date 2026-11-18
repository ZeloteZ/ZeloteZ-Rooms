"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { runInNewContext } = require("node:vm");
const test = require("node:test");

function fixture() {
  const filename = path.join(__dirname, "../windows-capture.cjs");
  const child = new EventEmitter();
  const writes = [], imports = [], transfers = [], launches = [];
  child.stdin = Object.assign(new EventEmitter(), { writable: true, write: value => writes.push(value),
    end: value => { child.stdin.writable = false; writes.push(value); } });
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  const module = { exports: {} };
  runInNewContext(readFileSync(filename, "utf8"), {
    module, Buffer, process: { pid: 32 }, __dirname: path.dirname(filename),
    setTimeout: () => ({ unref() {} }), clearTimeout() {},
    require(name) {
      if (name === "node:child_process") return { execFile() {}, spawn: (...args) => { launches.push(args); return child; } };
      if (name !== "electron") return require(name);
      return {
        screen: { getAllDisplays: () => [{ id: 71, bounds: { x: -500, y: 0, width: 450, height: 400 } }],
          dipToScreenPoint: point => ({ x: point.x * 2, y: point.y * 2 }) },
        sharedTexture: {
          importSharedTexture(options) {
            const handle = { options, released: false, release() { this.released = true; } };
            imports.push(handle);
            return handle;
          },
          sendSharedTexture(options, sequence) { transfers.push({ ...options, sequence }); return Promise.resolve(); },
        },
      };
    },
  }, { filename });
  return { child, writes, imports, transfers, launches, start: module.exports.startWindowsCapture };
}

test("native Windows frames stay scoped to the local owner and are acknowledged after GPU release", async () => {
  const f = fixture(), target = {};
  const session = f.start("verified.exe", { id: "screen:2:0", display_id: "71" }, () => target, assert.fail);
  assert.deepEqual(Array.from(f.launches[0][1]), ["capture", "32", "monitor", "-550", "400"]);
  f.child.stdout.emit("data", '{"type":"frame","sequence":1,"width":1920,');
  assert.equal(f.imports.length, 0);
  f.child.stdout.emit("data", '"height":1080,"handle":"f0","timestamp":1234}\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.transfers[0].frame, target);
  assert.equal(f.transfers[0].sequence, 1);
  assert.equal(f.imports[0].options.textureInfo.handle.ntHandle.readBigUInt64LE(), 0xf0n);
  assert.equal(f.imports[0].released, true);
  assert.deepEqual(f.writes, []);
  f.imports[0].options.allReferencesReleased();
  session.setFrameRate(30);
  session.close();
  assert.deepEqual(f.writes, ["ack 1\n", "fps 30\n", "stop\n"]);
});

test("a missing approved monitor or malformed frame can never redirect native capture", () => {
  const f = fixture();
  assert.throws(() => f.start("verified.exe", { id: "screen:2:0", display_id: "99" }, () => ({}), assert.fail),
    /no Windows capture target/u);
  let ended = 0;
  f.start("verified.exe", { id: "window:212:0" }, () => ({}), () => { ended++; });
  f.child.stdout.emit("data", '{"type":"frame","sequence":1,"width":999999,"height":1,"handle":"f0","timestamp":0}\n');
  assert.equal(f.imports.length, 0);
  assert.equal(ended, 1);
  assert.deepEqual(f.writes, ["stop\n"]);
});
