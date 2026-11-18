"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdtemp, mkdir, writeFile, rm } = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { runInNewContext } = require("node:vm");
const test = require("node:test");
const { installVaultIpc } = require("../vault-ipc.cjs");

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "rooms-vault-selection-ipc-"));
  const handlers = new Map(), dialogs = [], window = {}, contents = { isDestroyed: () => false, send() {} };
  let context = { contents, origin: "https://rooms.example.test", window, active: true };
  const event = { sender: contents };
  const bridge = installVaultIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showMessageBox: async (parent, input) => { dialogs.push({ parent, ...input }); return { response: 0 }; } },
    allowed: value => value.sender === contents && context.active,
    current: () => context, initialArgs: [], cwd: directory, platform: "linux", ...overrides });
  t.after(async () => { await bridge.reset(); await rm(directory, { recursive: true, force: true }); });
  return { directory, bridge, dialogs, window, event,
    select: files => bridge.receiveArguments(["app", "--vault-share", "--", ...files], directory),
    call: (name, ...args) => handlers.get("rooms:vault-" + name)(event, ...args),
    foreign: (name, ...args) => handlers.get("rooms:vault-" + name)({ sender: {} }, ...args),
    change: values => { context = { ...context, ...values }; } };
}
async function read(f, file) {
  if (!file.size) return Buffer.from(await f.call("selection-read", file.id, 0, 0));
  const chunks = [];
  for (let offset = 0; offset < file.size; offset += 137) {
    chunks.push(await f.call("selection-read", file.id, offset, Math.min(137, file.size - offset)));
  }
  return Buffer.concat(chunks);
}

test("mixed native selections confirm once and expose original raw files plus separately named folder ZIPs", async t => {
  const f = await fixture(t), movie = path.join(f.directory, "Clip 计划.mp4"), pdf = path.join(f.directory, "Document.pdf"),
    folder = path.join(f.directory, "My project"), empty = path.join(f.directory, "Empty.txt");
  const movieBytes = Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 255]), pdfBytes = Buffer.from("%PDF-private-fixture");
  await mkdir(folder); await writeFile(path.join(folder, "Note.txt"), "folder contents");
  await writeFile(movie, movieBytes); await writeFile(pdf, pdfBytes); await writeFile(empty, "");
  f.select([movie, pdf, folder, empty]);
  const batch = await f.call("selection-prepare");
  assert.equal(f.dialogs.length, 1); assert.equal(f.dialogs[0].parent, f.window);
  assert.match(f.dialogs[0].detail, /Only folders/u);
  assert.ok(!f.dialogs[0].detail.includes(f.directory));
  assert.deepEqual(batch.files.map(file => file.name), ["Clip 计划.mp4", "Document.pdf", "My project.zip", "Empty.txt"]);
  assert.deepEqual(batch.files.map(file => file.type), ["video/mp4", "application/pdf", "application/zip", "text/plain"]);
  assert.ok(!JSON.stringify(batch).includes(f.directory));
  assert.deepEqual(await read(f, batch.files[0]), movieBytes);
  assert.deepEqual(await read(f, batch.files[1]), pdfBytes);
  const zip = await read(f, batch.files[2]); assert.equal(zip.readUInt32LE(), 0x04034b50);
  assert.equal((await read(f, batch.files[3])).length, 0);
  assert.equal(await f.call("selection-cancel", randomUUID()), false);
  assert.equal(await f.call("selection-cancel", batch.id), true);
  await assert.rejects(f.call("selection-read", batch.files[0].id, 0, 1));
});

test("all native batch readers share one read lock and wipe results after an origin switch", async t => {
  let finish;
  const first = randomUUID(), second = randomUUID(), bytes = Buffer.from([7, 8]);
  const f = await fixture(t, { selectionPlanner: async () => ({ names: ["a.txt", "b.txt"] }),
    createSelection: async () => [first, second].map(id => ({ id, name: id + ".txt", type: "text/plain", size: 2,
      read: () => new Promise(resolve => { finish = resolve; }), cancel: async () => true })) });
  f.select(["/native/a.txt", "/native/b.txt"]);
  const batch = await f.call("selection-prepare");
  assert.equal(await f.foreign("selection-read", first, 0, 2), null);
  await assert.rejects(f.call("selection-read", randomUUID(), 0, 1));
  await assert.rejects(f.call("selection-read", first, 0, 0));
  await assert.rejects(f.call("selection-read", first, 0, 3));
  await assert.rejects(f.call("selection-read", first, 0, 4 * 1024 * 1024 + 1));
  const pending = f.call("selection-read", first, 0, 2);
  await assert.rejects(f.call("selection-read", second, 0, 2));
  f.change({ origin: "https://other.example.test" }); finish(bytes);
  await assert.rejects(pending); assert.deepEqual(bytes, Buffer.from([0, 0]));
  assert.equal(await f.call("selection-cancel", batch.id), true);
});

test("cancelling the native confirmation prevents every batch source from being created", async t => {
  let approve, created = 0;
  const f = await fixture(t, { selectionPlanner: async () => ({ names: ["a.txt"] }),
    dialog: { showMessageBox: () => new Promise(resolve => { approve = resolve; }) },
    createSelection: async () => { created++; return []; } });
  f.select(["/native/a.txt"]);
  const pending = f.call("selection-prepare");
  await new Promise(resolve => setTimeout(resolve, 280));
  assert.equal(await f.call("selection-cancel"), true);
  approve({ response: 0 }); assert.equal(await pending, null); assert.equal(created, 0);
});

test("older instance pages receive a raw single file and cannot silently combine a multiple selection", async t => {
  const f = await fixture(t), file = path.join(f.directory, "Original.pdf"); await writeFile(file, "%PDF-raw");
  f.select([file]);
  const single = await f.call("archive-prepare");
  assert.equal(single.name, "Original.pdf"); assert.equal(single.type, "application/pdf");
  assert.equal((await f.call("archive-read", single.id, 0, single.size)).toString(), "%PDF-raw");
  await f.call("archive-cancel", single.id);
  f.select([file, path.join(f.directory, "other.txt")]);
  await assert.rejects(f.call("archive-prepare"), /Update your Rooms instance/u);
  assert.equal(f.dialogs.length, 1);
});

test("the new preload bridge validates UUIDs and shares the read lock with older transfer methods", async () => {
  const exposed = new Map(), calls = []; let resolve;
  runInNewContext(readFileSync(path.join(__dirname, "../rooms-preload.cjs"), "utf8"), {
    process: { isMainFrame: true, platform: "linux", argv: [] }, navigator: { userActivation: { isActive: false } },
    require: () => ({ contextBridge: { exposeInMainWorld: (key, value) => exposed.set(key, value) }, ipcRenderer: {
      invoke: (...args) => { calls.push(args); return new Promise(done => { resolve = done; }); }, on() {}, off() {} } }) });
  const bridge = exposed.get("roomsVault"), id = randomUUID();
  await assert.rejects(bridge.readSelection({}, 0, 1));
  await assert.rejects(bridge.cancelSelection({}));
  const pending = bridge.readSelection(id, 0, 0);
  assert.deepEqual(calls[0], ["rooms:vault-selection-read", id, 0, 0]);
  await assert.rejects(bridge.readSelection(id, 0, 1));
  await assert.rejects(bridge.readArchive(id, 0, 1));
  resolve(new Uint8Array()); await pending;
});
