"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { link, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");
const { createVaultSave, validateDownload, MAX_DOWNLOAD_BYTES, MAX_WRITE_BYTES } = require("../vault-save.cjs");
const { installVaultIpc } = require("../vault-ipc.cjs");
async function fixture(t) {
  const folder = await mkdtemp(path.join(tmpdir(), "rooms-vault-save-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return { folder, file: path.join(folder, "download.txt"), temporary: async () => (await readdir(folder)).filter(file => file.startsWith(".zelotez-vault-")) };
}

test("native save keeps plaintext private in a fresh temp and commits only the complete sequential file", async t => {
  const f = await fixture(t), save = await createVaultSave(f.file, 6);
  const [temporary] = await f.temporary();
  assert.equal((await stat(path.join(f.folder, temporary))).mode & 0o777, 0o600);
  await save.write(0, Uint8Array.from([1, 2]));
  await assert.rejects(readFile(f.file));
  await save.write(2, Uint8Array.from([3, 4, 5, 6]));
  await assert.rejects(readFile(f.file));
  assert.equal(await save.complete(), true);
  assert.deepEqual(await readFile(f.file), Buffer.from([1, 2, 3, 4, 5, 6]));
  assert.deepEqual(await f.temporary(), []);
  await save.cancel();
  assert.equal((await readFile(f.file)).length, 6);
});

test("confirmed overwrite is atomic and cancellation or incomplete content preserves the previous file", async t => {
  const f = await fixture(t); await writeFile(f.file, "previous");
  const cancelled = await createVaultSave(f.file, 3); await cancelled.write(0, Buffer.from("new"));
  assert.equal((await readFile(f.file)).toString(), "previous");
  await cancelled.cancel(); assert.equal((await readFile(f.file)).toString(), "previous");
  assert.deepEqual(await f.temporary(), []);
  const incomplete = await createVaultSave(f.file, 3); await incomplete.write(0, Buffer.from("ne"));
  await assert.rejects(incomplete.complete()); assert.equal((await readFile(f.file)).toString(), "previous");
  assert.deepEqual(await f.temporary(), []);
  const complete = await createVaultSave(f.file, 3); await complete.write(0, Buffer.from("new"));
  await complete.complete(); assert.equal((await readFile(f.file)).toString(), "new");
});

test("zero-byte downloads commit without writes and unsafe metadata is rejected", async t => {
  const f = await fixture(t), save = await createVaultSave(f.file, 0);
  assert.equal(await save.complete(), true); assert.equal((await stat(f.file)).size, 0);
  for (const name of ["../escape", "a/b", "a\\b", "CON.txt", "COM0.txt", "COM¹.txt", "LPT²", "bad?name", "bad*name", "bad\"name", "bad|name", "bad<name", "bad>name", "a\nname", "x".repeat(256)]) {
    assert.throws(() => validateDownload({ name, size: 0 }));
  }
  for (const size of [-1, 0.5, MAX_DOWNLOAD_BYTES + 1, Number.MAX_SAFE_INTEGER, Infinity]) assert.throws(() => validateDownload({ name: "file", size }));
  assert.throws(() => validateDownload({ name: "file", size: 1, path: f.file }));
});

test("invalid write offsets, large chunks, overflow, and overlapping writes fail closed", async t => {
  const f = await fixture(t);
  for (const [offset, bytes] of [[1, Buffer.from([1])], [0, Buffer.alloc(MAX_WRITE_BYTES + 1)], [0, Buffer.from([1, 2])], [0, {}]]) {
    const save = await createVaultSave(f.file, 1);
    await assert.rejects(save.write(offset, bytes));
    assert.deepEqual(await f.temporary(), []); await assert.rejects(readFile(f.file));
  }
  const save = await createVaultSave(f.file, 2), first = save.write(0, Buffer.from([1]));
  const firstRejected = assert.rejects(first);
  await assert.rejects(save.write(0, Buffer.from([1]))); await firstRejected;
  assert.deepEqual(await f.temporary(), []);
});

test("existing target mutation, newly created targets, symlinks and hardlinks are preserved", async t => {
  const f = await fixture(t); await writeFile(f.file, "before");
  const save = await createVaultSave(f.file, 3); await save.write(0, Buffer.from("new"));
  await writeFile(f.file, "edited"); await utimes(f.file, new Date(1000), new Date(1000));
  await assert.rejects(save.complete()); assert.equal((await readFile(f.file)).toString(), "edited");
  const other = path.join(f.folder, "other"); await writeFile(other, "outside");
  const linked = path.join(f.folder, "linked"); await symlink(other, linked);
  await assert.rejects(createVaultSave(linked, 1)); assert.equal((await readFile(other)).toString(), "outside");
  const hard = path.join(f.folder, "hard"); await link(other, hard); await assert.rejects(createVaultSave(hard, 1));
  const fresh = path.join(f.folder, "fresh"), created = await createVaultSave(fresh, 1); await created.write(0, Buffer.from([3]));
  await writeFile(fresh, "someone else's file"); await assert.rejects(created.complete());
  assert.equal((await readFile(fresh)).toString(), "someone else's file"); assert.deepEqual(await f.temporary(), []);
});

test("origin revocation before commit cancels the temp and cannot replace a previous file", async t => {
  const f = await fixture(t); await writeFile(f.file, "original"); let allowed = true;
  const save = await createVaultSave(f.file, 1, { valid: () => allowed }); await save.write(0, Buffer.from([3]));
  allowed = false; await assert.rejects(save.complete());
  assert.equal((await readFile(f.file)).toString(), "original"); assert.deepEqual(await f.temporary(), []);
});

function bridgeFixture(destination, { picker, factory } = {}) {
  const handlers = new Map(), dialogs = [], contents = {}, window = {};
  let origin = "https://rooms.example.test";
  const event = { sender: contents };
  const bridge = installVaultIpc({ ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    dialog: { showSaveDialog: async (_window, input) => { dialogs.push(input); return picker ? picker() : { canceled: false, filePath: destination }; } },
    allowed: caller => caller.sender === contents, current: () => ({ contents, window, origin, active: true }),
    initialArgs: [], cwd: "/tmp", integration: {}, ...(factory ? { createSave: factory } : {}) });
  return { bridge, dialogs, origin: value => { origin = value; }, call: (name, ...args) => handlers.get("rooms:vault-download-" + name)(event, ...args),
    foreign: (name, ...args) => handlers.get("rooms:vault-download-" + name)({ sender: {} }, ...args) };
}

test("IPC picker alone selects a destination, binds it to the exact origin, and does not reveal its path", async t => {
  const f = await fixture(t), bridge = bridgeFixture(f.file);
  assert.equal(await bridge.foreign("prepare", { name: "requested.txt", size: 3 }), null);
  await assert.rejects(bridge.call("prepare", { name: "requested.txt", size: 3, path: "/not/native" }));
  assert.equal(bridge.dialogs.length, 0);
  const prepared = await bridge.call("prepare", { name: "requested.txt", size: 3 });
  assert.equal(prepared.name, "requested.txt"); assert.ok(!JSON.stringify(prepared).includes(f.file));
  assert.ok(bridge.dialogs[0].title.includes("https://rooms.example.test"));
  assert.equal(await bridge.call("prepare", { name: "another.txt", size: 3 }), null);
  await bridge.call("write", prepared.id, 0, Buffer.from("new"));
  bridge.origin("https://other.example.test");
  await assert.rejects(bridge.call("complete", prepared.id)); await bridge.bridge.reset();
  await assert.rejects(readFile(f.file)); assert.deepEqual(await f.temporary(), []);
});

test("cancellation while a native save picker is pending cannot create a temp or stack new pickers", async t => {
  const f = await fixture(t); let choose, made = 0;
  const bridge = bridgeFixture(f.file, { picker: () => new Promise(resolve => { choose = resolve; }),
    factory: async () => { made++; throw new Error("unexpected"); } });
  const preparing = bridge.call("prepare", { name: "file.txt", size: 1 });
  await bridge.call("cancel");
  assert.equal(await bridge.call("prepare", { name: "other.txt", size: 1 }), null);
  choose({ canceled: false, filePath: f.file });
  assert.equal(await preparing, null); assert.equal(made, 0); assert.deepEqual(await f.temporary(), []);
});

test("IPC saves a complete verified stream and cancellation leaves no new target", async t => {
  const f = await fixture(t), bridge = bridgeFixture(f.file);
  let prepared = await bridge.call("prepare", { name: "file.txt", size: 2 });
  await bridge.call("write", prepared.id, 0, Buffer.from([1, 2]));
  assert.equal(await bridge.call("complete", prepared.id), true); assert.deepEqual(await readFile(f.file), Buffer.from([1, 2]));
  prepared = await bridge.call("prepare", { name: "file.txt", size: 3 });
  await bridge.call("write", prepared.id, 0, Buffer.from([8])); await bridge.call("cancel", prepared.id);
  assert.deepEqual(await readFile(f.file), Buffer.from([1, 2])); assert.deepEqual(await f.temporary(), []);
});

function preload() {
  const exposed = new Map(), calls = [], deferred = [];
  const source = readFileSync(path.join(__dirname, "../rooms-preload.cjs"), "utf8");
  const activation = { isActive: true };
  runInNewContext(source, { process: { isMainFrame: true, platform: "linux", argv: [] }, navigator: { userActivation: activation }, TextEncoder,
    require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => exposed.set(name, value) },
      ipcRenderer: { on() {}, off() {}, invoke: (...args) => { calls.push(args); return new Promise(resolve => deferred.push(resolve)); } } }) });
  return { bridge: exposed.get("roomsVault"), calls, deferred, activation };
}

test("preload rejects oversized or nonprimitive arguments before Main IPC and requires a save gesture", async () => {
  const f = preload(), id = randomUUID();
  for (const operation of [() => f.bridge.readArchive({}, 0, 1), () => f.bridge.readArchive(id, 0, MAX_WRITE_BYTES + 1),
    () => f.bridge.readArchive(id, {}, 1), () => f.bridge.cancelArchive({ giant: "x".repeat(1000) }),
    () => f.bridge.prepareDownload({ name: "../escape", size: 1 }), () => f.bridge.prepareDownload({ name: "x".repeat(1000), size: 1 }),
    () => f.bridge.prepareDownload({ name: "file", size: MAX_DOWNLOAD_BYTES + 1 }),
    () => f.bridge.writeDownload({}, 0, new Uint8Array(1)), () => f.bridge.completeDownload({}), () => f.bridge.cancelDownload({})]) await assert.rejects(operation());
  assert.equal(f.calls.length, 0);
  f.activation.isActive = false;
  assert.equal(await f.bridge.prepareDownload({ name: "file", size: 1 }), null); assert.equal(f.calls.length, 0);
});

test("preload sends only the visible bytes and bounds pending write/read IPC to one each", async () => {
  const f = preload(), id = randomUUID(), backing = new Uint8Array(1024 * 1024); backing[100] = 24;
  const first = f.bridge.writeDownload(id, 0, backing.subarray(100, 101));
  const copy = f.calls[0][3]; assert.equal(copy.byteLength, 1); assert.equal(copy.buffer.byteLength, 1); assert.equal(copy[0], 24);
  await assert.rejects(f.bridge.writeDownload(id, 1, new Uint8Array(1))); assert.equal(f.calls.length, 1);
  f.deferred.shift()(true); assert.equal(await first, true); assert.equal(copy[0], 0); assert.equal(backing[100], 24);
  const reading = f.bridge.readArchive(id, 0, 1);
  await assert.rejects(f.bridge.readArchive(id, 0, 1)); assert.equal(f.calls.length, 2);
  f.deferred.shift()(new Uint8Array(1)); await reading;
});
