"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { chmod, mkdtemp, mkdir, readlink, readdir, rename, rm, symlink, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createVaultSelection, planSelection, MAX_READ_BYTES } = require("../vault-archive.cjs");

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "rooms-vault-selection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function sources(t, selected, options) {
  const result = await createVaultSelection(await planSelection(selected, options));
  t.after(() => Promise.allSettled(result.map(source => source.cancel())));
  return result;
}

async function consume(source, blockSize = 31) {
  if (!source.size) return source.read(0, 0);
  const chunks = [];
  for (let offset = 0; offset < source.size; offset += blockSize) chunks.push(await source.read(offset, Math.min(blockSize, source.size - offset)));
  return Buffer.concat(chunks);
}

function unzip(bytes) {
  return new Promise((resolve, reject) => {
    const child = execFile("python3", ["-c", "import sys,io,zipfile,json; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps({n:z.read(n).decode('utf-8') for n in z.namelist()}))"],
      { maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout)));
    child.stdin.end(bytes);
  });
}

function safeFailure(directory, code) {
  return error => {
    assert.equal(error.code, code);
    assert.ok(!error.message.includes(directory));
    assert.equal(error.path, undefined);
    assert.equal(error.cause, undefined);
    return true;
  };
}

test("single files retain their original name, MIME type and exact original bytes", async t => {
  const directory = await fixture(t), file = path.join(directory, "Clip 文件.MP4");
  const content = Buffer.from([0, 1, 2, 255, 100, 67, 20]);
  await writeFile(file, content);
  const plan = await planSelection([file]);
  assert.deepEqual(plan.names, ["Clip 文件.MP4"]);
  assert.equal(plan.totalBytes, content.length);
  const [source] = await sources(t, [file]);
  assert.equal(source.kind, "file"); assert.equal(source.name, "Clip 文件.MP4");
  assert.equal(source.type, "video/mp4"); assert.equal(source.size, content.length);
  assert.ok(Number.isSafeInteger(source.lastModified));
  assert.match(source.id, /^[a-f0-9-]{36}$/u);
  assert.deepEqual(await consume(source, 2), content);
});

test("each folder becomes its own named ZIP while mixed individual files stay raw", async t => {
  const directory = await fixture(t), folder = path.join(directory, "Fotos 文件"), second = path.join(directory, "Dokumente");
  await mkdir(folder); await mkdir(path.join(folder, "leer")); await mkdir(second);
  await writeFile(path.join(folder, "Bild.txt"), "picture fixture");
  await writeFile(path.join(second, "Bericht.txt"), "report fixture");
  const plain = path.join(directory, "Eigener Name.pdf"); await writeFile(plain, "raw PDF fixture");
  const plan = await planSelection([folder, plain, second]);
  assert.deepEqual(plan.names, ["Fotos 文件", "Eigener Name.pdf", "Dokumente"]);
  assert.deepEqual(plan.items.map(item => [item.kind, item.name]), [["directory", "Fotos 文件.zip"], ["file", "Eigener Name.pdf"], ["directory", "Dokumente.zip"]]);
  const batch = await createVaultSelection(plan);
  t.after(() => Promise.allSettled(batch.map(source => source.cancel())));
  assert.equal(new Set(batch.map(source => source.id)).size, 3);
  assert.deepEqual(await unzip(await consume(batch[0], 17)), { "Fotos 文件/": "", "Fotos 文件/Bild.txt": "picture fixture", "Fotos 文件/leer/": "" });
  assert.equal((await consume(batch[1])).toString(), "raw PDF fixture");
  assert.deepEqual(await unzip(await consume(batch[2])), { "Dokumente/": "", "Dokumente/Bericht.txt": "report fixture" });
});

test("equal filenames in separate selections do not collide or get renamed", async t => {
  const directory = await fixture(t), first = path.join(directory, "first"), second = path.join(directory, "second");
  await mkdir(first); await mkdir(second);
  const a = path.join(first, "Bericht.txt"), b = path.join(second, "Bericht.txt");
  await writeFile(a, "first"); await writeFile(b, "second");
  const batch = await sources(t, [a, b]);
  assert.deepEqual(batch.map(source => source.name), ["Bericht.txt", "Bericht.txt"]);
  assert.equal((await consume(batch[0])).toString(), "first");
  assert.equal((await consume(batch[1])).toString(), "second");
});

test("raw names use Vault naming rules instead of portable ZIP filename restrictions", { skip: process.platform === "win32" }, async t => {
  const directory = await fixture(t);
  const names = ["CON", "Frage?.txt", "Bericht:2026.txt", "trailing.", "trailing "];
  const selected = names.map(name => path.join(directory, name));
  await Promise.all(selected.map(file => writeFile(file, "original")));
  const batch = await sources(t, selected);
  assert.deepEqual(batch.map(source => source.name), names);
  for (const source of batch) assert.equal((await consume(source)).toString(), "original");
});

test("unknown extensions, including inherited object keys, always get a MIME string", async t => {
  const directory = await fixture(t);
  const names = ["file.constructor", "file.__proto__", "file.unknown", "README"];
  const selected = names.map(name => path.join(directory, name));
  await Promise.all(selected.map(file => writeFile(file, "original")));
  const plan = await planSelection(selected);
  assert.deepEqual(plan.items.map(item => item.type), names.map(() => "application/octet-stream"));
});

test("Vault control and bidi restrictions apply to raw names; generated ZIP names never truncate", async t => {
  const directory = await fixture(t);
  for (const name of ["control\u0001.txt", "hidden\u202e.txt"]) {
    const file = path.join(directory, name); await writeFile(file, "fixture");
    await assert.rejects(planSelection([file]), safeFailure(directory, "VAULT_INVALID_NAME"));
  }
  const folder = path.join(directory, "a".repeat(252)); await mkdir(folder);
  await assert.rejects(planSelection([folder]), safeFailure(directory, "VAULT_INVALID_NAME"));
  const file = path.join(directory, "b".repeat(255)); await writeFile(file, "fixture");
  assert.equal((await planSelection([file])).items[0].name, "b".repeat(255));
});

test("byte and entry limits cover the entire multi-item selection", async t => {
  const directory = await fixture(t), a = path.join(directory, "a.txt"), b = path.join(directory, "b.txt"), folder = path.join(directory, "folder");
  await writeFile(a, "123"); await writeFile(b, "456"); await mkdir(folder); await writeFile(path.join(folder, "child.txt"), "789");
  await assert.rejects(planSelection([a, b], { maxBytes: 5 }), safeFailure(directory, "VAULT_LIMIT"));
  await assert.rejects(planSelection([a, folder], { maxBytes: 5 }), safeFailure(directory, "VAULT_LIMIT"));
  await assert.rejects(planSelection([a, folder], { maxEntries: 2 }), safeFailure(directory, "VAULT_LIMIT"));
  assert.equal((await planSelection([a, b, folder], { maxBytes: 9, maxEntries: 4 })).totalBytes, 9);
});

test("empty files are verified and transferred by the zero-byte read", async t => {
  const directory = await fixture(t), file = path.join(directory, "Empty.txt"); await writeFile(file, "");
  const [source] = await sources(t, [file]);
  assert.equal(source.size, 0);
  assert.deepEqual(await source.read(0, 0), Buffer.alloc(0));
  await assert.rejects(source.read(0, 0), safeFailure(directory, "VAULT_ARCHIVE_FAILED"));
  const [changed] = await sources(t, [file]);
  await writeFile(file, "now nonempty");
  await assert.rejects(changed.read(0, 0), safeFailure(directory, "VAULT_SELECTION_CHANGED"));
});

test("empty folders have a predicted exact ZIP size and keep their name", async t => {
  const directory = await fixture(t), folder = path.join(directory, "Empty Folder"); await mkdir(folder);
  const [source] = await sources(t, [folder]);
  assert.equal(source.name, "Empty Folder.zip");
  const bytes = await consume(source);
  assert.equal(bytes.length, source.size);
  assert.deepEqual(await unzip(bytes), { "Empty Folder/": "" });
});

test("raw files and folder ZIPs open no source descriptors until their first read", { skip: process.platform !== "linux" }, async t => {
  const directory = await fixture(t), file = path.join(directory, "raw.txt"), folder = path.join(directory, "folder");
  await writeFile(file, "raw"); await mkdir(folder); await writeFile(path.join(folder, "child.txt"), "child");
  const batch = await sources(t, [file, folder]);
  const openSources = async () => {
    const targets = await Promise.all((await readdir("/proc/self/fd")).map(fd => readlink("/proc/self/fd/" + fd).catch(() => "")));
    return targets.filter(target => target.startsWith(directory + path.sep));
  };
  assert.deepEqual(await openSources(), []);
  assert.equal((await consume(batch[0])).toString(), "raw");
  await consume(batch[1]);
  assert.deepEqual(await openSources(), []);
});

test("permissions are checked when a raw file is opened, without leaking its path", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async t => {
  const directory = await fixture(t), file = path.join(directory, "private.txt"); await writeFile(file, "private");
  await chmod(file, 0);
  try {
    const [source] = await sources(t, [file]);
    await assert.rejects(source.read(0, 1), safeFailure(directory, "VAULT_UNREADABLE"));
  } finally { await chmod(file, 0o600); }
});

test("symlinks in native files and inside folder ZIPs remain forbidden", { skip: process.platform === "win32" }, async t => {
  const directory = await fixture(t), file = path.join(directory, "file.txt"), link = path.join(directory, "link.txt"), folder = path.join(directory, "folder");
  await writeFile(file, "private"); await symlink(file, link); await mkdir(folder); await symlink(file, path.join(folder, "inside.txt"));
  await assert.rejects(planSelection([link]), safeFailure(directory, "VAULT_SYMLINK"));
  await assert.rejects(planSelection([folder]), safeFailure(directory, "VAULT_SYMLINK"));
});

test("raw replacement after planning cannot substitute another file", async t => {
  const directory = await fixture(t), file = path.join(directory, "selected.txt"), replacement = path.join(directory, "replacement.txt");
  await writeFile(file, "old"); await writeFile(replacement, "new");
  const [source] = await sources(t, [file]);
  await rename(replacement, file);
  await assert.rejects(source.read(0, 3), safeFailure(directory, "VAULT_SELECTION_CHANGED"));
});

test("symlink replacement after raw planning cannot expose another target", { skip: process.platform === "win32" }, async t => {
  const directory = await fixture(t), file = path.join(directory, "selected.txt"), target = path.join(directory, "target.txt");
  await writeFile(file, "old"); await writeFile(target, "new");
  const [source] = await sources(t, [file]);
  await rm(file); await symlink(target, file);
  await assert.rejects(source.read(0, 3), safeFailure(directory, "VAULT_SYMLINK"));
});

test("mutation during raw streaming aborts before the file can complete", async t => {
  const directory = await fixture(t), file = path.join(directory, "selected.txt"); await writeFile(file, "original");
  const [source] = await sources(t, [file]);
  assert.equal((await source.read(0, 2)).toString(), "or");
  await writeFile(file, "modified");
  await assert.rejects(source.read(2, source.size - 2), safeFailure(directory, "VAULT_SELECTION_CHANGED"));
});

test("folder snapshots are checked before starting their lazy ZIP, including empty folders", async t => {
  const directory = await fixture(t), folder = path.join(directory, "folder"); await mkdir(folder);
  const [source] = await sources(t, [folder]);
  await writeFile(path.join(folder, "added.txt"), "new");
  await assert.rejects(source.read(0, 1), safeFailure(directory, "VAULT_SELECTION_CHANGED"));
});

test("raw reads reject random access, parallel reads and oversized ranges", async t => {
  const directory = await fixture(t), file = path.join(directory, "selected.txt"); await writeFile(file, "original");
  const [source] = await sources(t, [file]);
  await assert.rejects(source.read(1, 1), safeFailure(directory, "VAULT_ARCHIVE_FAILED"));
  await assert.rejects(source.read(0, 0), safeFailure(directory, "VAULT_ARCHIVE_FAILED"));
  await assert.rejects(source.read(0, MAX_READ_BYTES + 1), safeFailure(directory, "VAULT_ARCHIVE_FAILED"));
  const first = source.read(0, 1);
  await assert.rejects(source.read(0, 1), safeFailure(directory, "VAULT_ARCHIVE_FAILED"));
  assert.equal((await first).toString(), "o");
  assert.equal((await source.read(1, source.size - 1)).toString(), "riginal");
});

test("cancellation before the first read leaves both raw and directory sources inaccessible", async t => {
  const directory = await fixture(t), file = path.join(directory, "selected.txt"), folder = path.join(directory, "folder");
  await writeFile(file, "original"); await mkdir(folder);
  const batch = await sources(t, [file, folder]);
  for (const source of batch) {
    await source.cancel();
    await assert.rejects(source.read(0, 1), { name: "AbortError" });
  }
  const controller = new AbortController();
  const plan = await planSelection([file, folder]);
  const aborted = await createVaultSelection(plan, { signal: controller.signal });
  controller.abort();
  for (const source of aborted) await assert.rejects(source.read(0, 1), { name: "AbortError" });
  await Promise.all(aborted.map(source => source.cancel()));
});

test("cancelling an active raw or ZIP read closes its source descriptors and rejects the pending bytes", async t => {
  const directory = await fixture(t), file = path.join(directory, "raw.bin"), folder = path.join(directory, "folder");
  await mkdir(folder);
  const payload = Buffer.alloc(12 * 1024 * 1024, 90);
  await writeFile(file, payload); await writeFile(path.join(folder, "child.bin"), payload);
  const batch = await sources(t, [file, folder]);
  const openSources = async () => {
    if (process.platform !== "linux") return [];
    const targets = await Promise.all((await readdir("/proc/self/fd")).map(fd => readlink("/proc/self/fd/" + fd).catch(() => "")));
    return targets.filter(target => target.startsWith(directory + path.sep));
  };
  for (const source of batch) {
    await source.read(0, MAX_READ_BYTES);
    if (process.platform === "linux") assert.ok((await openSources()).length > 0);
    const pending = source.read(MAX_READ_BYTES, MAX_READ_BYTES);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await source.cancel(); await rejected;
    assert.deepEqual(await openSources(), []);
  }
});

test("an empty directory changed after ZIP streaming starts cannot complete its stale snapshot", async t => {
  const directory = await fixture(t), folder = path.join(directory, "folder"); await mkdir(folder);
  const [source] = await sources(t, [folder]);
  await source.read(0, 1);
  await writeFile(path.join(folder, "late.txt"), "new");
  await assert.rejects(source.read(1, source.size - 1), safeFailure(directory, "VAULT_SELECTION_CHANGED"));
});
