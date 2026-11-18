"use strict";
const assert = require("node:assert/strict");
const { mkdtemp, writeFile, rm } = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { setTimeout: pause } = require("node:timers/promises");
const { runInNewContext } = require("node:vm");
const test = require("node:test");
const { installVaultIpc } = require("../vault-ipc.cjs");

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "rooms-vault-retry-"));
  const good = path.join(directory, "Good.txt"); await writeFile(good, "private test content");
  const handlers = new Map(), dialogs = [], window = {}, contents = { isDestroyed: () => false, send() {} };
  const event = { sender: contents };
  let approve = true;
  const bridge = installVaultIpc({ ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    dialog: { showMessageBox: async (_window, input) => { dialogs.push(input); return { response: approve ? 0 : 1 }; } },
    allowed: value => value.sender === contents,
    current: () => ({ contents, origin: "https://rooms.example.test", window, active: true }),
    initialArgs: [], cwd: directory, platform: "linux", ...options });
  t.after(async () => { await bridge.reset(); await rm(directory, { recursive: true, force: true }); });
  return { good, directory, bridge, dialogs, approve: value => { approve = value; },
    select: files => bridge.receiveArguments(["app", "--vault-share", "--", ...files], directory),
    call: (name, ...args) => handlers.get("rooms:vault-" + name)(event, ...args) };
}

test("a failed ZIP selection cannot poison the next separate context-menu action", async t => {
  const f = await fixture(t);
  f.select([path.join(f.directory, "Missing.txt")]); await pause(280);
  await assert.rejects(f.call("archive-prepare")); assert.equal(f.dialogs.length, 0);
  f.select([f.good]); await pause(280);
  assert.deepEqual(await f.call("pending"), { available: true, count: 1 });
  const prepared = await f.call("archive-prepare");
  assert.ok(prepared.size > 0); assert.equal(f.dialogs.length, 1);
  const bytes = await f.call("archive-read", prepared.id, 0, prepared.size);
  assert.ok(bytes.includes(Buffer.from("private test content")));
  assert.ok(!f.dialogs[0].detail.includes("Missing.txt"));
});

test("a declined confirmation can retry, while a new selection replaces the declined one", async t => {
  const f = await fixture(t); f.approve(false);
  f.select([f.good]); await pause(280);
  assert.equal(await f.call("archive-prepare"), null);
  assert.deepEqual(await f.call("pending"), { available: true, count: 1 });
  const next = path.join(f.directory, "Next.txt"); await writeFile(next, "next");
  f.select([next]); await pause(280); f.approve(true);
  await f.call("archive-prepare");
  assert.match(f.dialogs[1].detail, /Next\.txt/u);
  assert.ok(!f.dialogs[1].detail.includes("Good.txt"));
});

test("one immediate multi-launch burst still combines selections", async t => {
  const f = await fixture(t); const next = path.join(f.directory, "Next.txt"); await writeFile(next, "next");
  f.select([f.good]); f.select([next]); await pause(280);
  assert.deepEqual(await f.call("pending"), { available: true, count: 2 });
  const prepared = await f.call("archive-prepare"); assert.ok(prepared.size > 0);
});

test("native errors expose only recognized categories, never private paths or raw causes", async t => {
  const hidden = "/private/secret-folder/hidden-name.txt";
  const f = await fixture(t, { planner: async () => { throw Object.assign(new Error("EACCES " + hidden), { code: "VAULT_UNREADABLE" }); } });
  f.select([f.good]); await pause(280);
  await assert.rejects(f.call("archive-prepare"), error => /cannot be read/u.test(error.message) && !error.message.includes(hidden));
});

test("synchronous native dialog failures are classified without leaking native internals", async t => {
  const f = await fixture(t, { dialog: { showMessageBox() { throw new Error("private native stack /home/private"); } } });
  f.select([f.good]); await pause(280);
  await assert.rejects(f.call("archive-prepare"), error => /confirmation could not be opened/u.test(error.message) && !error.message.includes("/home/private"));
});

test("the preload shows a clean safe error instead of Electron IPC implementation text", async () => {
  const exposed = new Map();
  const source = readFileSync(path.join(__dirname, "../rooms-preload.cjs"), "utf8");
  runInNewContext(source, { process: { isMainFrame: true, platform: "linux", argv: [] }, navigator: { userActivation: { isActive: true } },
    require: () => ({ contextBridge: { exposeInMainWorld: (key, value) => exposed.set(key, value) },
      ipcRenderer: { invoke: async name => { throw new Error("Error invoking remote method '" + name + "': Error: A selected file cannot be read."); }, on() {}, off() {} } }) });
  await assert.rejects(exposed.get("roomsVault").prepareArchive(), error => error.message === "A selected file cannot be read.");
});
