"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { TextDecoder } = require("node:util");
const { runInNewContext } = require("node:vm");

const id = "12345678-1234-4234-8234-123456789abc";
const selected = { title: "Audio application", serial: "678", identity: "678:0011223344556677" };
const audioFile = path.resolve(__dirname, "../audio.cjs");
const windowsFile = path.resolve(__dirname, "../windows-audio.cjs");
const preloadFile = path.resolve(__dirname, "../rooms-preload.cjs");

function windowsFixture({ build = "10.0.26100", packaged = true, exists = true } = {}) {
  const moduleShim = { exports: {} };
  const calls = [];
  let entries = [selected];
  let raw;
  const run = async (...values) => {
    calls.push(["list", ...values]);
    return { stdout: raw ?? Buffer.from(JSON.stringify(entries)) };
  };
  runInNewContext(readFileSync(windowsFile, "utf8"), {
    module: moduleShim, __dirname: "C:\\Rooms source", TextDecoder,
    process: { platform: "win32", resourcesPath: "C:\\Installed Rooms\\resources" },
    require(name) {
      if (name === "electron") return { app: { isPackaged: packaged } };
      if (name === "node:child_process") return { execFile() {}, spawn: (...values) => { calls.push(["record", ...values]); return {}; } };
      if (name === "node:util") return { promisify: () => run };
      if (name === "node:fs") return { statSync() { if (!exists) throw new Error("Missing"); return { isFile: () => true }; } };
      if (name === "node:os") return { release: () => build };
      if (name === "node:path") return path.win32;
      throw new Error(name);
    },
  }, { filename: windowsFile });
  return { create: moduleShim.exports.createWindowsAudio, calls, entries(value) { entries = value; }, raw(value) { raw = value; } };
}

test("Windows audio capabilities keep Windows 10 on system output and use an absolute packaged or development executable", async () => {
  const current = windowsFixture();
  const backend = current.create();
  assert.deepEqual([...backend.modes], ["application", "system"]);
  assert.deepEqual(Array.from(await backend.outputs("application"), item => ({ ...item })), [selected]);
  backend.record("application", selected);
  const expected = "C:\\Installed Rooms\\resources\\windows-audio\\rooms-windows-audio.exe";
  assert.equal(current.calls[0][1], expected);
  assert.deepEqual([...current.calls[0][2]], ["list", "application"]);
  assert.equal(current.calls[0][3].shell, false);
  assert.equal(current.calls[0][3].maxBuffer, 512 * 1024);
  assert.deepEqual([...current.calls[1][2]], ["record", "application", selected.serial, selected.identity]);
  assert.equal(current.calls[1][3].shell, false);
  assert.equal(current.calls[1][3].stdio[2], "ignore");

  const previous = windowsFixture({ build: "10.0.19045", packaged: false });
  const older = previous.create();
  assert.deepEqual([...older.modes], ["system"]);
  await older.outputs("system");
  assert.equal(previous.calls[0][1], "C:\\Rooms source\\windows-audio\\rooms-windows-audio.exe");
  await assert.rejects(older.outputs("application"));
  assert.throws(() => older.record("application", selected));
  assert.equal(windowsFixture({ exists: false }).create(), null);
  assert.equal(windowsFixture({ build: "invalid" }).create(), null);
});

test("Windows source parsing sanitizes display labels, keeps opaque identities and rejects invalid or oversized source lists", async () => {
  const fixture = windowsFixture();
  const backend = fixture.create();
  fixture.entries([{ title: "\u202e Player\n  音乐 ", serial: "endpoint {0.0.0.000}", identity: "[\"endpoint\",\"same device\"]" }]);
  const [source] = await backend.outputs("system");
  assert.equal(source.title, "Player 音乐");
  assert.equal(source.identity, "[\"endpoint\",\"same device\"]");
  fixture.entries([{ ...selected, title: "音".repeat(121) }]);
  assert.equal([...(await backend.outputs("application"))[0].title].length, 120);
  for (const entries of [null, {}, Array(257).fill(selected), [selected, selected],
    [{ ...selected, serial: "0" }], [{ ...selected, serial: "4294967296" }],
    [{ ...selected, serial: "678\n" }], [{ ...selected, identity: "\u0000" }], [{ ...selected, identity: "x".repeat(1025) }]]) {
    fixture.entries(entries);
    await assert.rejects(backend.outputs("application"));
  }
  fixture.raw(Buffer.from([0xff]));
  await assert.rejects(backend.outputs("system"));
});

function integration({ platform = "win32", modes = ["application", "system"], fresh = true, failure = false } = {}) {
  const handlers = new Map();
  const moduleShim = { exports: {} };
  const sent = [];
  const commands = [];
  const children = [];
  let reads = 0;
  let picks = 0;
  let changed = false;
  let time = 100;
  let allowed = true;
  const child = () => {
    const process = new EventEmitter();
    process.stdout = new EventEmitter();
    process.kill = () => { process.killed = true; };
    children.push(process);
    return process;
  };
  const backend = { modes, error: "windows", async outputs() {
    if (failure) throw new Error("List unavailable");
    return (reads++ === 0 || fresh) && !changed ? [selected] : [{ ...selected, identity: "new process" }];
  }, record(mode, target) { commands.push([mode, target]); return child(); } };
  runInNewContext(readFileSync(audioFile, "utf8"), {
    module: moduleShim, process: { platform }, Buffer, setTimeout, clearTimeout, performance: { now: () => time },
    require(name) {
      if (name === "electron") return { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } };
      if (name === "./windows-audio.cjs") return { createWindowsAudio: () => platform === "win32" ? backend : null };
      if (name === "node:child_process") return { execFile() {}, spawn: (...values) => { commands.push(values); return child(); } };
      if (name === "node:util") return { promisify: () => async () => ({ stdout: JSON.stringify([{ type: "PipeWire:Interface:Node", info: { props: {
        "media.class": "Stream/Output/Audio", "object.serial": "678", "application.process.id": "123", "application.name": "Player", "node.name": "audio-node",
      } } }]) }) };
      throw new Error(name);
    },
  }, { filename: audioFile });
  const web = new EventEmitter();
  web.id = 10;
  web.mainFrame = { url: "https://rooms.example.test/", detached: false, send: (...args) => sent.push(args) };
  const event = { sender: web, senderFrame: web.mainFrame };
  const audio = moduleShim.exports.installAudio(web, () => allowed, (_mode, choices) => {
    picks++;
    return { result: Promise.resolve(choices[0]) };
  });
  return { handlers, event, web, audio, approve: () => audio.approve(), sent, commands, children, arguments: moduleShim.exports.audioArguments,
    deny() { allowed = false; }, changeSource() { changed = true; }, tick(ms) { time += ms; }, reads: () => reads, picks: () => picks };
}

async function recording(fixture, mode = "application") {
  fixture.approve();
  const pending = fixture.handlers.get("rooms:audio-open")(fixture.event, id, mode);
  for (let attempt = 0; attempt < 10 && !fixture.children.length; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.children.length, 1);
  return { pending, child: fixture.children[0] };
}

test("Windows capture requires current main-frame approval, validates source identity again, and never falls back", async () => {
  const fixture = integration();
  const open = fixture.handlers.get("rooms:audio-open");
  assert.equal(await open(fixture.event, id, "application"), "unavailable");
  fixture.approve();
  assert.equal(await open({ ...fixture.event, senderFrame: { ...fixture.web.mainFrame } }, id, "application"), "unavailable");
  assert.equal(await open(fixture.event, id + "\n", "application"), "unavailable");
  const stale = integration({ fresh: false });
  stale.approve();
  assert.equal(await stale.handlers.get("rooms:audio-open")(stale.event, id, "application"), "unavailable");
  assert.equal(stale.commands.length, 0);
  const older = integration({ modes: ["system"] });
  older.approve();
  assert.equal(await older.handlers.get("rooms:audio-open")(older.event, id, "application"), "unavailable");
  assert.equal(older.reads(), 0);
  assert.deepEqual([...older.arguments()], ["--rooms-windows-audio"]);
  assert.deepEqual([...fixture.arguments()], ["--rooms-windows-audio", "--rooms-windows-application-audio"]);
  const broken = integration({ failure: true });
  broken.approve();
  assert.equal(await broken.handlers.get("rooms:audio-open")(broken.event, id, "system"), "windows");
});

test("main-process audio selection is copied, single-use and opens without a second source picker", async () => {
  const fixture = integration();
  assert.equal(Object.isFrozen(fixture.audio.modes), true);
  assert.deepEqual([...fixture.audio.modes], ["application", "system"]);
  assert.deepEqual(Array.from(await fixture.audio.outputs("unknown")), []);
  const source = { ...selected };
  assert.equal(fixture.audio.select(fixture.web.mainFrame, id, "application", source), true);
  source.serial = "other target";
  source.identity = "other identity";
  const open = fixture.handlers.get("rooms:audio-open");
  assert.equal(await open(fixture.event, "a" + id.slice(1), "application"), "unavailable");
  assert.equal(await open(fixture.event, id, "system"), "unavailable");
  const pending = open(fixture.event, id, "application");
  for (let attempt = 0; attempt < 10 && !fixture.children.length; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.children.length, 1);
  assert.equal(fixture.picks(), 0);
  assert.equal(fixture.reads(), 1);
  assert.deepEqual({ ...fixture.commands[0][1] }, { serial: selected.serial, identity: selected.identity });
  fixture.children[0].stdout.emit("data", Buffer.alloc(4));
  assert.equal(await pending, "ok");
  fixture.handlers.get("rooms:audio-close")(fixture.event, id);
  assert.equal(await open(fixture.event, id, "application"), "unavailable");
  assert.equal(fixture.picks(), 0);
});

test("explicit no-audio choice and invalid or expired selections never use a leftover legacy approval", async () => {
  for (const choice of ["none", "expired", "frame", "id", "mode", "source"]) {
    const fixture = integration();
    fixture.approve();
    let accepted;
    if (choice === "none") accepted = fixture.audio.select(fixture.web.mainFrame, id, "none");
    if (choice === "expired") {
      accepted = fixture.audio.select(fixture.web.mainFrame, id, "application", selected);
      fixture.tick(30_000);
    }
    if (choice === "frame") accepted = fixture.audio.select({ ...fixture.web.mainFrame }, id, "application", selected);
    if (choice === "id") accepted = fixture.audio.select(fixture.web.mainFrame, id + "\n", "application", selected);
    if (choice === "mode") accepted = fixture.audio.select(fixture.web.mainFrame, id, "unknown", selected);
    if (choice === "source") accepted = fixture.audio.select(fixture.web.mainFrame, id, "application", { ...selected, identity: "\u0000" });
    assert.equal(accepted, choice === "none" || choice === "expired", choice);
    assert.equal(await fixture.handlers.get("rooms:audio-open")(fixture.event, id, "application"), "unavailable", choice);
    assert.equal(fixture.picks(), 0);
    assert.equal(fixture.reads(), 0);
    assert.equal(fixture.children.length, 0);
  }
  const unsupported = integration({ modes: ["system"] });
  assert.deepEqual(Array.from(await unsupported.audio.outputs("application")), []);
  assert.equal(unsupported.audio.select(unsupported.web.mainFrame, id, "application", selected), false);
});

test("preselected audio rechecks identity and permissions and cancellation invalidates pending grants", async () => {
  const stale = integration();
  stale.audio.select(stale.web.mainFrame, id, "application", selected);
  stale.changeSource();
  const open = stale.handlers.get("rooms:audio-open");
  assert.equal(await open(stale.event, id, "application"), "unavailable");
  assert.equal(await open(stale.event, id, "application"), "unavailable");
  assert.equal(stale.children.length, 0);
  assert.equal(stale.picks(), 0);
  for (const cancellation of ["close", "clear", "navigation", "renderer", "destroyed", "revoked"]) {
    const fixture = integration();
    fixture.audio.select(fixture.web.mainFrame, id, "application", selected);
    if (cancellation === "close") fixture.handlers.get("rooms:audio-close")(fixture.event, id);
    if (cancellation === "clear") fixture.audio.clear();
    if (cancellation === "navigation") fixture.web.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    if (cancellation === "renderer") fixture.web.emit("render-process-gone");
    if (cancellation === "destroyed") fixture.web.emit("destroyed");
    if (cancellation === "revoked") fixture.deny();
    assert.equal(await fixture.handlers.get("rooms:audio-open")(fixture.event, id, "application"), "unavailable", cancellation);
    assert.equal(fixture.picks(), 0);
    assert.equal(fixture.children.length, 0);
  }
  const cancelled = integration();
  cancelled.audio.select(cancelled.web.mainFrame, id, "application", selected);
  const pending = cancelled.handlers.get("rooms:audio-open")(cancelled.event, id, "application");
  cancelled.handlers.get("rooms:audio-close")(cancelled.event, id);
  assert.equal(await pending, "cancelled");
  assert.equal(cancelled.children.length, 0);
});

test("clearing pending permissions preserves the active recording until its normal close", async () => {
  const fixture = integration();
  const { pending, child } = await recording(fixture);
  child.stdout.emit("data", Buffer.alloc(4));
  assert.equal(await pending, "ok");
  fixture.audio.clear();
  assert.equal(child.killed, undefined);
  child.stdout.emit("data", Buffer.alloc(4));
  assert.equal(fixture.sent.length, 2);
  fixture.handlers.get("rooms:audio-close")(fixture.event, id);
  assert.equal(child.killed, true);
});

test("Windows PCM fragments preserve stereo sample frames and closing, navigation or sender revocation ends recording", async () => {
  for (const action of ["close", "navigation", "renderer", "destroyed", "revoked"]) {
    const fixture = integration();
    const { pending, child } = await recording(fixture);
    child.stdout.emit("data", Buffer.from([0, 1, 2]));
    assert.equal(fixture.sent.length, 0);
    child.stdout.emit("data", Buffer.from([3, 4, 5, 6, 7]));
    assert.equal(await pending, "ok");
    assert.deepEqual(Array.from(fixture.sent[0][2]), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(await fixture.handlers.get("rooms:audio-open")(fixture.event, id, "system"), "unavailable");
    if (action === "close") fixture.handlers.get("rooms:audio-close")(fixture.event, id);
    if (action === "navigation") fixture.web.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    if (action === "renderer") fixture.web.emit("render-process-gone");
    if (action === "destroyed") fixture.web.emit("destroyed");
    if (action === "revoked") { fixture.deny(); child.stdout.emit("data", Buffer.alloc(4)); }
    assert.equal(child.killed, true, action);
    child.stdout.emit("data", Buffer.alloc(4));
    assert.equal(fixture.sent.length, 1);
  }
  const ended = integration();
  const { pending, child } = await recording(ended);
  child.stdout.emit("data", Buffer.alloc(4));
  assert.equal(await pending, "ok");
  child.emit("close");
  assert.equal(ended.sent[1][0], "rooms:audio-ended");
  assert.equal(child.killed, true);
  const failed = integration();
  const startup = await recording(failed);
  startup.child.emit("error", new Error("Unavailable"));
  assert.equal(await startup.pending, "windows");
});

test("Linux audio still launches pw-record with the approved PipeWire target and no fallback", async () => {
  const fixture = integration({ platform: "linux" });
  const { pending, child } = await recording(fixture);
  assert.equal(fixture.commands[0][0], "pw-record");
  const args = fixture.commands[0][1];
  assert.equal(args[args.indexOf("--target") + 1], "678");
  assert.equal(JSON.parse(args[args.indexOf("--properties") + 1])["node.dont-fallback"], true);
  assert.deepEqual([...fixture.arguments()], []);
  child.stdout.emit("data", Buffer.alloc(4));
  assert.equal(await pending, "ok");
  fixture.web.emit("destroyed");
});

test("preload exposes immutable Windows capability modes only in an authorized main frame", () => {
  function bridge(platform, argv, main = true) {
    const exposed = new Map();
    runInNewContext(readFileSync(preloadFile, "utf8"), {
      process: { platform, argv, isMainFrame: main },
      require: () => ({ contextBridge: { exposeInMainWorld: (key, value) => exposed.set(key, value) }, ipcRenderer: { on() {} } }),
    }, { filename: preloadFile });
    return exposed.get("roomsDesktopAudio");
  }
  assert.equal(bridge("win32", []), undefined);
  assert.equal(bridge("win32", ["--rooms-windows-audio"], false), undefined);
  assert.equal(bridge("darwin", ["--rooms-windows-audio"]), undefined);
  assert.deepEqual([...bridge("win32", ["--rooms-windows-audio"]).supportedModes], ["system"]);
  const full = bridge("win32", ["--rooms-windows-audio", "--rooms-windows-application-audio"]);
  assert.deepEqual([...full.supportedModes], ["application", "system"]);
  assert.equal(Object.isFrozen(full.supportedModes), true);
  assert.deepEqual([...bridge("linux", []).supportedModes], ["application", "system"]);
});
