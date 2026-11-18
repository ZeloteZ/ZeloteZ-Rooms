"use strict";
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { mkdtemp, mkdir, readFile, rm, symlink, unlink, utimes, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const { test } = require("node:test");
const { createVaultIntegration, linuxFiles, label, marker } = require("../vault-integration.cjs");
const { createVaultArchive, parseVaultArguments, planArchive, MAX_READ_BYTES } = require("../vault-archive.cjs");
const { installVaultIpc } = require("../vault-ipc.cjs");
const execute = promisify(execFile);
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "rooms-vault-native-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = path.join(home, "bin"); await mkdir(bin);
  const env = { HOME: home, XDG_DATA_HOME: path.join(home, "share"), XDG_CONFIG_HOME: path.join(home, "config"), PATH: bin,
    APPIMAGE: path.join(home, "Rooms's $literal `text` 100%.AppImage") };
  await writeFile(env.APPIMAGE, "#!/bin/sh\nprintf '%s\\0' \"$@\" > \"$VAULT_ARGUMENTS\"\n", { mode: 0o700 });
  const addManager = name => writeFile(path.join(bin, name), "", { mode: 0o700 });
  return { home, env, addManager };
}
async function consume(archive, blockSize = 137) {
  const chunks = [];
  for (let offset = 0; offset < archive.size; offset += blockSize) chunks.push(await archive.read(offset, Math.min(blockSize, archive.size - offset)));
  return Buffer.concat(chunks);
}
function unzip(data) {
  return new Promise((resolve, reject) => {
    const child = execFile("python3", ["-c", "import sys,io,zipfile,json; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps({n:z.read(n).decode('utf-8') for n in z.namelist()}))"],
      { maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout)));
    child.stdin.end(data);
  });
}

test("CLI requires an explicit separator and resolves second-instance relative paths against its cwd", () => {
  assert.deepEqual(parseVaultArguments(["app", "--vault-share", "--", "a ; $(touch never)", "-leading"], "/selected"),
    ["/selected/a ; $(touch never)", "/selected/-leading"]);
  assert.deepEqual(parseVaultArguments(["app", "--vault-share", "--", "one.txt"], "C:\\Selected", "win32"), ["C:\\Selected\\one.txt"]);
  assert.equal(parseVaultArguments(["app", "--vault-share", "--", "file"], null), null);
  for (const args of [["app", "--vault-share", "file"], ["app", "--vault-share", "--"], ["app", "--vault-share", "--", "a\nb"],
    ["app", "--vault-share", "--", ...Array(257).fill("a")]]) assert.equal(parseVaultArguments(args, "/selected"), null);
});

test("Linux integration detects all installed managers and preserves exact hostile path arguments", async t => {
  const f = await fixture(t);
  for (const manager of ["nautilus", "nemo", "caja", "dolphin", "thunar"]) await f.addManager(manager);
  const integration = createVaultIntegration({ platform: "linux", env: f.env });
  const status = await integration.install();
  assert.deepEqual(status.managers, ["nautilus", "nemo", "caja", "dolphin", "thunar"]);
  assert.equal(status.installed, true);
  const files = linuxFiles(f.env), argsFile = path.join(f.home, "args");
  const supplied = ["/tmp/a space", "/tmp/$(touch NEVER)", "/tmp/a'quote", "/tmp/a\"quote", "/tmp/back\\slash"];
  await execute(files.nautilus, supplied, { env: { ...process.env, VAULT_ARGUMENTS: argsFile } });
  assert.deepEqual((await readFile(argsFile)).toString().split("\0").slice(0, -1), ["--vault-share", "--", ...supplied]);
  assert.ok((await readFile(files.dolphin, "utf8")).includes(" %F\n"));
  assert.ok((await readFile(files.dolphin, "utf8")).includes("100%%.AppImage"));
  assert.ok((await readFile(files.nemo, "utf8")).includes("Quote=double"));
  assert.ok((await readFile(files.thunar, "utf8")).includes("<unique-id>zelotez-vault-v1</unique-id>"));
  await integration.remove();
  for (const manager of ["nautilus", "nemo", "caja", "dolphin"]) await assert.rejects(readFile(files[manager]));
  assert.ok(!(await readFile(files.thunar, "utf8")).includes(label));
});

test("foreign manager files, symlinks and unrelated Thunar actions are preserved", async t => {
  const f = await fixture(t); await f.addManager("nemo"); await f.addManager("thunar");
  const files = linuxFiles(f.env);
  await mkdir(path.dirname(files.nemo), { recursive: true });
  await writeFile(files.nemo, "[Nemo Action]\nName=My action\n");
  const integration = createVaultIntegration({ platform: "linux", env: f.env });
  assert.deepEqual((await integration.status()).conflicts, ["nemo"]);
  await assert.rejects(integration.install());
  await integration.remove();
  assert.equal(await readFile(files.nemo, "utf8"), "[Nemo Action]\nName=My action\n");
  await unlink(files.nemo);
  const other = '<action><name>Keep me</name><command>echo untouched</command></action>';
  await mkdir(path.dirname(files.thunar), { recursive: true });
  await writeFile(files.thunar, '<?xml version="1.0"?>\n<actions>\n' + other + '\n</actions>\n');
  await integration.install(); await integration.remove();
  assert.ok((await readFile(files.thunar, "utf8")).includes(other));
  await symlink(files.thunar, files.nemo);
  await assert.rejects(integration.install());
  assert.ok((await readFile(files.thunar, "utf8")).includes(other));
});

test("removal also cleans owned entries for managers no longer present", async t => {
  const f = await fixture(t); await f.addManager("nautilus");
  const integration = createVaultIntegration({ platform: "linux", env: f.env });
  await integration.install();
  await unlink(path.join(f.env.PATH, "nautilus"));
  await integration.remove();
  await assert.rejects(readFile(linuxFiles(f.env).nautilus));
});

function registryFixture() {
  const keys = new Map(), calls = [];
  async function execute(file, args) {
    assert.equal(file, "C:\\Windows\\System32\\reg.exe");
    calls.push([file, ...args]);
    const [action, registryKey] = args;
    if (action === "query") {
      if (!keys.has(registryKey)) throw new Error("not found");
      const name = args.includes("/v") ? args[args.indexOf("/v") + 1] : null;
      if (name && !keys.get(registryKey).has(name)) throw new Error("not found");
      return { stdout: name ? `${name}    REG_SZ    ${keys.get(registryKey).get(name)}\r\n` : registryKey };
    }
    if (action === "add") {
      if (!keys.has(registryKey)) keys.set(registryKey, new Map());
      const name = args.includes("/ve") ? "" : args[args.indexOf("/v") + 1];
      keys.get(registryKey).set(name, args[args.indexOf("/d") + 1]);
      return { stdout: "" };
    }
    if (action === "delete") { for (const key of keys.keys()) if (key === registryKey || key.startsWith(registryKey + "\\")) keys.delete(key); return { stdout: "" }; }
    throw new Error("unexpected command");
  }
  return { keys, calls, execute };
}
test("Windows uses only marked HKCU entries and separate execFile arguments", async () => {
  const f = registryFixture(), executable = "C:\\Users\\Person\\Rooms & literal\\Rooms.exe";
  const integration = createVaultIntegration({ platform: "win32", env: { SystemRoot: "C:\\Windows" }, executable, execute: f.execute });
  assert.equal((await integration.install()).installed, true);
  assert.equal(f.calls.filter(([, action]) => action === "add").length, 8);
  assert.ok(f.calls.every(([, , key]) => key.startsWith("HKCU\\Software\\Classes\\")));
  const command = f.calls.find(([, action, key]) => action === "add" && key.endsWith("\\command"));
  assert.equal(command[command.indexOf("/d") + 1], `"${executable}" --vault-share -- "%1"`);
  for (const key of f.keys.keys()) if (key.startsWith("HKCU\\Software\\Classes\\Directory\\shell\\ZeloteZVault")) f.keys.delete(key);
  assert.equal((await integration.status()).installed, false);
  assert.equal((await integration.status()).anyInstalled, true);
  await integration.remove(); assert.equal(f.keys.size, 0);
  f.keys.set("HKCU\\Software\\Classes\\*\\shell\\ZeloteZVault", new Map([["MUIVerb", "Foreign"]]));
  await assert.rejects(integration.install()); await integration.remove();
  assert.equal(f.keys.get("HKCU\\Software\\Classes\\*\\shell\\ZeloteZVault").get("MUIVerb"), "Foreign");
});

test("ZIP streams remain readable with Unicode, empty directories and sequential tiny reads", async t => {
  const f = await fixture(t), directory = path.join(f.home, "Private 文件");
  await mkdir(path.join(directory, "empty"), { recursive: true });
  await writeFile(path.join(directory, "secret.txt"), "encrypted after ZIP creation");
  const archive = await createVaultArchive(await planArchive([directory]));
  t.after(() => archive.cancel());
  const result = await unzip(await consume(archive, 17));
  assert.deepEqual(result, { "Private 文件/": "", "Private 文件/empty/": "", "Private 文件/secret.txt": "encrypted after ZIP creation" });
});

test("planning rejects symlinks, special files, unsafe names, excess depth, counts and bytes", async t => {
  const f = await fixture(t), file = path.join(f.home, "file.txt"), linked = path.join(f.home, "linked");
  await writeFile(file, "content"); await symlink(file, linked);
  await assert.rejects(planArchive([linked]));
  const odd = path.join(f.home, "bad\\name"); await writeFile(odd, "content"); await assert.rejects(planArchive([odd]));
  const reserved = path.join(f.home, "CON.txt"); await writeFile(reserved, "content"); await assert.rejects(planArchive([reserved]));
  for (const name of ["COM0.txt", "COM¹.txt", "LPT².txt", "bad?name", "bad*name", "bad|name"]) {
    const unsafe = path.join(f.home, name); await writeFile(unsafe, "content"); await assert.rejects(planArchive([unsafe]));
  }
  await assert.rejects(planArchive([file], { maxBytes: 1 }));
  const root = path.join(f.home, "nested"); await mkdir(path.join(root, "deep", "deeper"), { recursive: true });
  await assert.rejects(planArchive([root], { maxDepth: 1 }));
  await assert.rejects(planArchive([root], { maxEntries: 1 }));
  const fifo = path.join(f.home, "fifo"); await execute("mkfifo", [fifo]); await assert.rejects(planArchive([fifo]));
});

test("changed files and symlink replacement fail closed before an archive completes", async t => {
  const f = await fixture(t), file = path.join(f.home, "selected.txt"), outside = path.join(f.home, "outside.txt");
  await writeFile(file, "original"); await writeFile(outside, "outside!");
  const planned = await planArchive([file]);
  await writeFile(file, "changed!"); await utimes(file, new Date(1000), new Date(1000));
  await assert.rejects(async () => { const archive = await createVaultArchive(planned); try { await consume(archive); } finally { await archive.cancel(); } });
  const another = await planArchive([file]);
  await unlink(file); await symlink(outside, file);
  await assert.rejects(async () => { const archive = await createVaultArchive(another); try { await consume(archive); } finally { await archive.cancel(); } });
});

test("archive reads reject random access, excessive buffers, and use after cancellation", async t => {
  const f = await fixture(t), file = path.join(f.home, "selected.txt"); await writeFile(file, "small");
  const archive = await createVaultArchive(await planArchive([file]));
  await assert.rejects(archive.read(1, 1));
  await assert.rejects(archive.read(0, MAX_READ_BYTES + 1));
  await archive.cancel();
  await assert.rejects(archive.read(0, 1), error => error.name === "AbortError");
});

function ipcFixture({ approve = true, archiveFactory, confirmation, initialArgs = [], directory = "/tmp" } = {}) {
  const handlers = new Map(), sent = [], dialogs = [];
  const contents = { isDestroyed: () => false, send: (...args) => sent.push(args) };
  let context = { contents, origin: "https://rooms.example.test", window: {}, active: true };
  const event = { sender: contents };
  const integration = { status: async () => ({ supported: true }), install: async () => ({ installed: true }), remove: async () => ({ installed: false }) };
  let confirmations = approve;
  const bridge = installVaultIpc({ ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    dialog: { showMessageBox: async (_window, input) => { dialogs.push(input); return confirmation ? confirmation(input) : { response: confirmations ? 0 : 1 }; } },
    allowed: entry => entry.sender === context.contents && context.active, current: () => context, initialArgs, cwd: directory, platform: "linux", integration,
    planner: async paths => ({ names: paths.map(file => path.basename(file)) }),
    createArchive: archiveFactory || (async () => ({ id: "archive-id", size: 1, name: "Selection.zip", type: "application/zip", read: async () => Buffer.from([9]), cancel: async () => true })),
  });
  return { bridge, event, sent, dialogs, call: (name, ...args) => handlers.get("rooms:vault-" + name)(event, ...args),
    foreign: name => handlers.get("rooms:vault-" + name)({ sender: {} }), setContext: value => { context = { ...context, ...value }; },
    approve: value => { confirmations = value; } };
}
test("IPC accepts native selections only and confirms the destination without exposing full paths", async () => {
  const f = ipcFixture();
  assert.equal(await f.call("archive-prepare", ["/not/from/native"]), null);
  assert.equal(await f.foreign("pending"), null);
  f.bridge.receiveArguments(["app", "--vault-share", "--", "private.txt"], "/private/root");
  const pending = await f.call("pending"); assert.deepEqual(pending, { available: true, count: 1 });
  assert.ok(!JSON.stringify(pending).includes("/private/root"));
  const prepared = await f.call("archive-prepare"); assert.equal(prepared.id, "archive-id");
  assert.ok(f.dialogs[0].detail.includes("https://rooms.example.test"));
  assert.ok(!f.dialogs[0].detail.includes("/private/root"));
  assert.deepEqual(await f.call("archive-read", prepared.id, 0, 1), Buffer.from([9]));
  f.setContext({ origin: "https://other.example.test" });
  await assert.rejects(f.call("archive-read", prepared.id, 0, 1));
  await f.bridge.reset();
});

test("native rejection, integration confirmation and cancellation grant no file access", async () => {
  const f = ipcFixture({ approve: false });
  assert.equal(await f.call("integration-install"), null);
  f.bridge.receiveArguments(["app", "--vault-share", "--", "/private/one"], "/tmp");
  assert.equal(await f.call("archive-prepare"), null);
  await assert.rejects(f.call("archive-read", "archive-id", 0, 1));
  f.approve(true);
  assert.deepEqual(await f.call("integration-install"), { installed: true });
  assert.equal(await f.call("archive-cancel"), true);
  assert.equal(await f.call("pending"), null);
});


test("mutation during streaming aborts before a ZIP can complete", async t => {
  const f = await fixture(t), file = path.join(f.home, "changing.bin");
  const payload = Buffer.alloc(6 * 1024 * 1024, 77); await writeFile(file, payload);
  const archive = await createVaultArchive(await planArchive([file]));
  t.after(() => archive.cancel());
  const first = await archive.read(0, MAX_READ_BYTES); assert.equal(first.length, MAX_READ_BYTES);
  payload.fill(78); await writeFile(file, payload); await utimes(file, new Date(2000), new Date(2000));
  await assert.rejects(archive.read(MAX_READ_BYTES, archive.size - MAX_READ_BYTES));
});

test("parallel reads and cancellation cannot expose another range or leave a live reader", async t => {
  const f = await fixture(t), file = path.join(f.home, "read.bin"); await writeFile(file, Buffer.alloc(1024 * 1024, 7));
  const archive = await createVaultArchive(await planArchive([file]));
  const first = archive.read(0, 1);
  await assert.rejects(archive.read(0, 1));
  assert.equal((await first).length, 1);
  const pending = archive.read(1, 1024 * 1024);
  await archive.cancel();
  await assert.rejects(pending);
});

test("an origin switch while a native read is pending wipes its result and denies delivery", async () => {
  let finish;
  const bytes = Buffer.from([8, 9]);
  const f = ipcFixture({ archiveFactory: async () => ({ id: "archive-id", size: 2, name: "Selection.zip", type: "application/zip",
    read: () => new Promise(resolve => { finish = resolve; }), cancel: async () => true }) });
  f.bridge.receiveArguments(["app", "--vault-share", "--", "/selected/file"], "/tmp");
  await f.call("archive-prepare");
  const pending = f.call("archive-read", "archive-id", 0, 2);
  f.setContext({ origin: "https://changed.example.test" }); finish(bytes);
  await assert.rejects(pending); assert.deepEqual(bytes, Buffer.from([0, 0]));
  await f.bridge.reset();
});


test("new OS selections cannot silently cancel an approved active transfer", async () => {
  const f = ipcFixture();
  f.bridge.receiveArguments(["app", "--vault-share", "--", "/selected/first"], "/tmp");
  const prepared = await f.call("archive-prepare");
  assert.equal(f.bridge.receiveArguments(["app", "--vault-share", "--", "/selected/next"], "/tmp"), true);
  assert.equal(await f.call("pending"), null);
  assert.deepEqual(await f.call("archive-read", prepared.id, 0, 1), Buffer.from([9]));
  assert.ok(f.dialogs.some(dialog => dialog.message === "A Vault transfer is already in progress."));
  await f.bridge.reset();
});

test("cancelling during native confirmation invalidates preparation before any reader is made", async () => {
  let approve, created = 0;
  const f = ipcFixture({ confirmation: () => new Promise(resolve => { approve = resolve; }),
    archiveFactory: async () => { created += 1; throw new Error("must never run"); } });
  f.bridge.receiveArguments(["app", "--vault-share", "--", "/selected/file"], "/tmp");
  const preparing = f.call("archive-prepare");
  await new Promise(resolve => setTimeout(resolve, 275));
  await f.bridge.reset(); approve({ response: 0 });
  assert.equal(await preparing, null); assert.equal(created, 0);
});

test("preload allows the OS-initiated preparation after async loading while menu changes need a gesture", async () => {
  const source = readFileSync(path.join(__dirname, "../rooms-preload.cjs"), "utf8");
  function setup(isMainFrame) {
    const exposed = new Map(), calls = [];
    runInNewContext(source, { process: { isMainFrame, platform: "linux", argv: [] }, navigator: { userActivation: { isActive: false } },
      require: () => ({ contextBridge: { exposeInMainWorld: (key, value) => exposed.set(key, value) },
        ipcRenderer: { invoke: async (...args) => { calls.push(args); return null; }, on() {}, off() {} } }) });
    return { exposed, calls };
  }
  const main = setup(true), bridge = main.exposed.get("roomsVault");
  await bridge.prepareArchive(); await bridge.installIntegration(); await bridge.removeIntegration();
  assert.deepEqual(main.calls, [["rooms:vault-archive-prepare"]]);
  assert.equal(setup(false).exposed.has("roomsVault"), false);
});


test("second-instance native selection uses validated additionalData rather than Chromium-mutated argv", async () => {
  const first = ipcFixture({ initialArgs: ["app", "--vault-share", "--", "relative.txt"], directory: "/original/cwd" });
  const supplied = first.bridge.instanceData();
  assert.deepEqual(supplied.zelotezVault.paths, ["/original/cwd/relative.txt"]);
  const running = ipcFixture();
  assert.equal(running.bridge.receiveInstanceData(supplied), true);
  // The Electron event's reordered/appended --original-process-start-time is
  // deliberately absent from the selection payload used by the main process.
  assert.deepEqual(await running.call("pending"), { available: true, count: 1 });
  assert.equal(running.bridge.receiveInstanceData({ zelotezVault: { v: 1, cwd: "/tmp", paths: ["--original-process-start-time=123"] } }), false);
  assert.equal(running.bridge.receiveInstanceData({ zelotezVault: { v: 1, cwd: "/tmp", paths: ["/tmp/file"], extra: true } }), false);
  await first.bridge.reset(); await running.bridge.reset();
});

test("a burst of native file selections produces one settled pending announcement and one confirmation", async () => {
  const f = ipcFixture();
  f.bridge.receiveInstanceData({ zelotezVault: { v: 1, cwd: "/tmp", paths: ["/tmp/first"] } });
  f.bridge.receiveInstanceData({ zelotezVault: { v: 1, cwd: "/tmp", paths: ["/tmp/second"] } });
  const pending = await f.call("pending");
  assert.deepEqual(pending, { available: true, count: 2 });
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0][1], { available: true, count: 2 });
  assert.equal((await f.call("archive-prepare")).id, "archive-id");
  assert.equal(f.dialogs.length, 1);
  await f.bridge.reset();
});
