"use strict";

const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, chmod, rm, symlink } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { createVaultArchive, planArchive, parseVaultArguments } = require("../vault-archive.cjs");

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "rooms-vault-archive-regression-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function consume(plan) {
  const archive = await createVaultArchive(plan);
  try {
    let size = 0;
    for (let offset = 0; offset < archive.size; offset += 31) {
      size += (await archive.read(offset, Math.min(31, archive.size - offset))).length;
    }
    assert.equal(size, archive.size);
  } finally { await archive.cancel(); }
}

test("local file URIs resolve to the selected files before archive planning", async t => {
  const directory = await fixture(t), selected = path.join(directory, "Übersicht 文件 # 100%.txt");
  await writeFile(selected, "synthetic");
  const uri = pathToFileURL(selected).href;
  const args = parseVaultArguments(["app", "--vault-share", "--", uri], directory);
  assert.deepEqual(args, [selected]);
  await consume(await planArchive(args));
  assert.deepEqual(parseVaultArguments(["app", "--vault-share", "--", selected, uri], directory), [selected]);
  const folder = path.join(directory, "Folder with spaces");
  await mkdir(folder);
  await consume(await planArchive(parseVaultArguments(["app", "--vault-share", "--", pathToFileURL(folder).href], directory)));
});

test("URI decoding preserves literal encoded punctuation and Windows drive paths", () => {
  const args = values => ["app", "--vault-share", "--", ...values];
  assert.deepEqual(parseVaultArguments(args(["file:///tmp/hash%23question%3Fpercent%25.txt"]), "/tmp"), ["/tmp/hash#question?percent%.txt"]);
  assert.deepEqual(parseVaultArguments(args(["file://localhost/tmp/local.txt"]), "/tmp"), ["/tmp/local.txt"]);
  assert.deepEqual(parseVaultArguments(args(["file:///C:/Selected/Datei%20%E6%96%87%E4%BB%B6.txt"]), "C:\\Launch", "win32"), ["C:\\Selected\\Datei 文件.txt"]);
  assert.deepEqual(parseVaultArguments(args(["C:\\Selected\\plain.txt"]), "C:\\Launch", "win32"), ["C:\\Selected\\plain.txt"]);
  assert.deepEqual(parseVaultArguments(args(["relative file.txt"]), "/selection"), ["/selection/relative file.txt"]);
});

test("non-local or ambiguous file URIs cannot become native selections", () => {
  const invalid = ["https://example.test/file.txt", "smb://server/share/file.txt", "data:text/plain,content", "file://server/share/file.txt",
    "file://user@localhost/tmp/file.txt", "file://localhost:99/tmp/file.txt", "file:/tmp/file.txt", "file:relative.txt", "file:////server/share/file.txt",
    "file:///tmp/file.txt?query", "file:///tmp/file.txt?", "file:///tmp/file.txt#fragment", "file:///tmp/file.txt#", "file:///tmp/%2Fetc",
    "file:///tmp/%5Cwindows", "file:///tmp/%00name", "file:///tmp/%0aname", "file:///tmp/%ZZname", "file:///tmp/%c0%afname"];
  for (const uri of invalid) assert.equal(parseVaultArguments(["app", "--vault-share", "--", uri], "/selection"), null, uri);
  assert.equal(parseVaultArguments(["app", "--vault-share", "--", "file:///tmp/posix.txt"], "C:\\Launch", "win32"), null);
});

function safeFailure(directory, code) {
  return error => {
    assert.equal(error.code, code);
    assert.equal(error.name, "Error");
    assert.ok(!error.message.includes(directory));
    assert.equal(error.path, undefined);
    assert.equal(error.cause, undefined);
    return true;
  };
}

test("unchanged Unicode files and folders archive through the real filesystem", async t => {
  const directory = await fixture(t);
  const selected = path.join(directory, "Private 文件");
  await mkdir(selected);
  await writeFile(path.join(selected, "Übersicht 计划.txt"), "synthetic private data");
  await mkdir(path.join(selected, "empty"));
  await consume(await planArchive([selected]));
});

test("missing selections, unsafe names and size limits retain distinct safe error codes", async t => {
  const directory = await fixture(t);
  await assert.rejects(planArchive([path.join(directory, "missing.txt")]), safeFailure(directory, "VAULT_SELECTION_CHANGED"));
  const unsafe = path.join(directory, "report:2026.txt");
  await writeFile(unsafe, "synthetic");
  await assert.rejects(planArchive([unsafe]), safeFailure(directory, "VAULT_INVALID_NAME"));
  const selected = path.join(directory, "selected.txt");
  await writeFile(selected, "synthetic");
  await assert.rejects(planArchive([selected], { maxBytes: 1 }), safeFailure(directory, "VAULT_LIMIT"));
});

test("symlinks remain blocked with a specific safe code", { skip: process.platform === "win32" }, async t => {
  const directory = await fixture(t);
  const target = path.join(directory, "target.txt"), link = path.join(directory, "link.txt");
  await writeFile(target, "synthetic");
  await symlink(target, link);
  await assert.rejects(planArchive([link]), safeFailure(directory, "VAULT_SYMLINK"));
});

test("changed content is still rejected after planning", async t => {
  const directory = await fixture(t), selected = path.join(directory, "selected.txt");
  await writeFile(selected, "before");
  const plan = await planArchive([selected]);
  await writeFile(selected, "different after planning");
  await assert.rejects(consume(plan), safeFailure(directory, "VAULT_SELECTION_CHANGED"));
});

test("unreadable inputs are reported as unreadable rather than cancelled", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async t => {
  const directory = await fixture(t), selected = path.join(directory, "selected.txt");
  await writeFile(selected, "synthetic");
  await chmod(selected, 0);
  try {
    await assert.rejects(consume(await planArchive([selected])), safeFailure(directory, "VAULT_UNREADABLE"));
  } finally { await chmod(selected, 0o600); }
});

test("explicit cancellation retains AbortError", async t => {
  const directory = await fixture(t), selected = path.join(directory, "selected.txt");
  await writeFile(selected, "synthetic");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(planArchive([selected], { signal: controller.signal }), { name: "AbortError" });
  const archive = await createVaultArchive(await planArchive([selected]));
  await archive.cancel();
  await assert.rejects(archive.read(0, 1), { name: "AbortError" });
});
