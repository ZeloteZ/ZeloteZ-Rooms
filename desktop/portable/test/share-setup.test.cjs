"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { runInNewContext } = require("node:vm");

const id = "fedcba98-7654-4321-9876-0123456789ab";
const action = { source: 1, height: 1440, fps: 60, region: null, audioMode: "none", audioSource: null };
const snapshot = "data:image/jpeg;base64,/9j/2Q==";
const plain = value => JSON.parse(JSON.stringify(value));

function fixture({ portal = false } = {}) {
  const handlers = new Map();
  const timers = new Set();
  const thumbnail = { isEmpty: () => portal, toJPEG: () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]) };
  const video = [{ id: "screen:1:0", name: "A monitor", thumbnail }, { id: "window:2:0", name: "A private window", thumbnail },
    { id: "window:3:0", name: "The picker itself", thumbnail }];
  const output = { title: "Speakers", serial: "private device", identity: "private identity" };
  const audio = { modes: ["system"], outputs: async () => [output], selected: [], clears: 0,
    select(...args) { this.selected.push(args); return true; }, clear() { this.clears++; },
    revoke() { this.clears++; }, approve() { this.approved = true; } };
  const owners = [];
  const requests = [];
  const module = { exports: {} };
  const filename = path.join(__dirname, "../share-setup.cjs");
  runInNewContext(readFileSync(filename, "utf8"), {
    module,
    require: name => {
      if (name === "node:crypto") return require(name);
      assert.equal(name, "electron");
      return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
        desktopCapturer: { getSources: async options => { requests.push(options); return video; } } };
    },
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimeout: timer => timers.delete(timer),
  }, { filename });

  const web = Object.assign(new EventEmitter(), { id: 1, mainFrame: { url: "https://rooms.example/" } });
  const evt = { sender: web, senderFrame: web.mainFrame };
  const dialogs = [];
  const grants = [];
  const begin = module.exports.installShareSetup(web, {
    portal, audio, allowed: url => url === web.mainFrame.url,
    createOwner({ source, valid, onEnded }) {
      const owner = { source, valid, onEnded, frame: { trustedOutput: true }, configurations: [], closed: false,
        snapshot: async () => ({ thumbnail: snapshot, aspect: 2, width: 1920, height: 960 }),
        configure: async options => { owner.configurations.push(options); return owner.frame; },
        delivered: () => { owner.deliveredToPage = true; }, close: () => { owner.closed = true; } };
      owners.push(owner);
      return owner;
    },
    showDialog(state) {
      const window = new EventEmitter();
      let closed = false;
      window.isDestroyed = () => closed;
      window.getMediaSourceId = () => video[2].id;
      window.close = () => { if (!closed) { closed = true; window.emit("closed"); } };
      const sent = [];
      const local = { state, window, contents: { send: (...args) => sent.push(args) }, sent };
      dialogs.push(local);
      return local;
    },
  });
  const call = (name, ...args) => handlers.get("rooms:share-" + name)(evt, ...args);
  function open() {
    assert.equal(call("arm", id, "de"), true);
    const done = begin(web.mainFrame, reply => grants.push(reply));
    return { local: dialogs.at(-1), done };
  }
  return { web, evt, handlers, begin, open, call, video, output, audio, grants, requests, timers, owners, dialogs };
}

test("one dialog confirms video, audio and quality with a single frame-bound handoff", async () => {
  const f = fixture();
  assert.equal(f.begin({}, () => {}), null);
  assert.equal(f.handlers.get("rooms:share-arm")({ ...f.evt, senderFrame: {} }, id, "de"), false);
  const { local, done } = f.open();
  assert.deepEqual(plain(local.state), { language: "de", portal: false, audioModes: ["system"] });
  assert.deepEqual(plain(await local.share.sources()), { status: "ok", sources: [
    { name: "A monitor", kind: "screen", thumbnail: snapshot },
    { name: "A private window", kind: "window", thumbnail: snapshot },
  ] });
  assert.deepEqual(plain(await local.share.audio("system")), { status: "ok", sources: [{ name: "Speakers" }] });
  assert.equal(await local.share.submit({ ...action, audioMode: "application", audioSource: 0 }), false);
  assert.equal(await local.share.submit({ ...action, height: 2160 }), false);
  assert.equal(await local.share.submit({ ...action, audioMode: "system", audioSource: 0 }), true);
  await done;
  assert.equal(f.grants.length, 1);
  assert.equal(f.grants[0].video, f.owners[0].frame);
  assert.notEqual(f.grants[0].video, f.video[1]);
  assert.equal(f.handlers.get("rooms:share-take")({ ...f.evt, senderFrame: {} }, id), null);
  assert.deepEqual(plain(f.call("take", id)), { height: 1440, fps: 60, region: null, audio: "system" });
  assert.equal(f.call("take", id), null);
  assert.deepEqual(f.audio.selected, [[f.web.mainFrame, id, "system", f.output]]);
  const clears = f.audio.clears;
  f.call("cancel", id);
  assert.equal(f.audio.clears, clears + 1);
  assert.equal(f.owners[0].closed, true);
});

test("the real snapshot supplies crop coordinates in the original dialog", async () => {
  const f = fixture({ portal: true });
  const { local, done } = f.open();
  const { sources } = await local.share.sources();
  assert.equal(sources[1].thumbnail, null);
  assert.deepEqual(plain(f.requests[0].thumbnailSize), { width: 0, height: 0 });
  const region = { x: .1, y: .2, width: .5, height: .6 };
  assert.equal(await local.share.submit({ ...action, region }), false);
  assert.equal(await local.share.submit({ ...action, region: true }), "preview");
  assert.equal(local.window.isDestroyed(), false);
  assert.equal(f.grants.length, 0, "preview never grants any track to the remote page");
  assert.equal(f.call("take", id), null);
  assert.equal(f.call("preview", id, "https://example.net/private.jpg", 2, 1920, 960), null);
  assert.equal(f.call("preview", id, snapshot, 2, 1920, 960), null, "the page cannot provide the local preview");
  assert.deepEqual(plain(local.sent), [["rooms:local-share-preview", { thumbnail: snapshot }]]);
  assert.equal(await local.share.submit({ ...action, source: 0, region }), false);
  assert.equal(await local.share.submit({ ...action, region: { ...region, width: 1 } }), false);
  assert.equal(await local.share.submit({ ...action, region }), true);
  assert.deepEqual(plain(f.call("take", id)), { height: 1440, fps: 60, region: null, audio: "none" });
  assert.deepEqual(plain(f.owners[0].configurations[0].region), { ...region, aspect: 2, sourceWidth: 1920, sourceHeight: 960 });
  await done;
  assert.equal(f.grants.length, 1);
  assert.equal(f.call("take", id), null);
});

test("cancel, a cross-document navigation and snapshot timeout revoke pending capture", async () => {
  const cancel = fixture();
  const first = cancel.open();
  first.local.window.close();
  await first.done;
  assert.deepEqual(cancel.grants, [null]);
  assert.equal(cancel.call("take", id), null);

  const navigating = fixture();
  const second = navigating.open();
  await second.local.share.sources();
  await second.local.share.submit({ ...action, region: true });
  navigating.web.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  await second.done;
  assert.equal(navigating.owners[0].closed, true);
  assert.equal(navigating.audio.selected.length, 0);

  const expiring = fixture();
  const third = expiring.open();
  await third.local.share.sources();
  await third.local.share.submit({ ...action, region: true });
  const timer = [...expiring.timers].find(timeout => timeout.delay === 180_000);
  timer.callback();
  await third.done;
  assert.equal(expiring.call("take", id), null);
  assert.equal(expiring.audio.selected.length, 0);
  assert.equal(expiring.owners[0].closed, true);
});

test("an older server still uses the secure local dialog and separate legacy audio approval", async () => {
  const f = fixture();
  const done = f.begin(f.web.mainFrame, value => f.grants.push(value));
  const local = f.dialogs[0];
  assert.equal(local.state.legacyAudio, true);
  assert.deepEqual(plain(local.state.audioModes), []);
  await local.share.sources();
  assert.equal(await local.share.submit(action), true);
  await done;
  assert.equal(f.grants[0].video, f.owners[0].frame);
  assert.equal(f.audio.approved, true);
  f.owners[0].onEnded();
  assert.equal(f.owners[0].closed, true);
});
