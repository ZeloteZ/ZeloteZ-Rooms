"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { mkdtemp, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { planSelection } = require("../vault-archive.cjs");
test("native original files carry supported media, Office and archive MIME without repackaging", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "rooms-vault-format-mime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const expected = { "Film.mkv": "video/x-matroska", "Sound.mka": "audio/x-matroska", "Icon.ico": "image/x-icon",
    "Doc.docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "Sheet.xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Files.tar": "application/x-tar", "Files.tar.gz": "application/gzip" };
  const files = Object.keys(expected).map(name => path.join(directory, name));
  await Promise.all(files.map(file => writeFile(file, "synthetic-original")));
  const plan = await planSelection(files);
  assert.deepEqual(plan.items.map(item => [item.name, item.type, item.kind]), Object.entries(expected).map(([name, type]) => [name, type, "file"]));
});
