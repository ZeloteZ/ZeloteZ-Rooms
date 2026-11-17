"use strict";

const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { registerLinuxShareLink } = require("../linux-share-link.cjs");

const handler = "de.zelotez.rooms.AppImage.desktop";
const mime = "x-scheme-handler/zelotez-rooms";

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "rooms-protocol-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = path.join(home, "share", "applications");
  const env = { HOME: home, XDG_DATA_HOME: path.join(home, "share"), APPIMAGE: path.join(home, "Rooms 0.1.AppImage") };
  await writeFile(env.APPIMAGE, "", { mode: 0o700 });
  const commands = [];
  let selected = "";
  async function execute(command, args, options) {
    commands.push([command, ...args]);
    assert.equal(options.env, env);
    if (command === "xdg-mime" && args[0] === "query") return { stdout: selected };
    if (command === "xdg-mime" && args[0] === "default") selected = args[1];
    return { stdout: "" };
  }
  return { env, directory, file: path.join(directory, handler), commands, execute, select: value => { selected = value; } };
}

test("Linux AppImage registers its actual file and refreshes an owned handler after a move", async t => {
  const { env, directory, file, commands, execute } = await fixture(t);
  await registerLinuxShareLink(env, execute);
  const first = await readFile(file, "utf8");
  assert.ok(first.includes('Exec="' + env.APPIMAGE + '" %u\n'));
  assert.ok(first.includes("MimeType=" + mime + ";\n"));
  assert.deepEqual(commands.splice(0), [
    ["xdg-mime", "query", "default", mime],
    ["update-desktop-database", directory],
    ["xdg-mime", "query", "default", mime],
    ["xdg-mime", "default", handler, mime],
  ]);

  env.APPIMAGE = path.join(env.HOME, "Rooms 0.2.AppImage");
  await writeFile(env.APPIMAGE, "", { mode: 0o700 });
  await registerLinuxShareLink(env, execute);
  assert.ok((await readFile(file, "utf8")).includes('Exec="' + env.APPIMAGE + '" %u\n'));
  assert.deepEqual(commands, [["xdg-mime", "query", "default", mime], ["update-desktop-database", directory]]);
});

test("Linux AppImage retries a missing default and preserves a different selection", async t => {
  const { env, file, commands, execute, select } = await fixture(t);
  await registerLinuxShareLink(env, execute);
  const first = await readFile(file, "utf8");
  commands.length = 0;
  select("");
  await registerLinuxShareLink(env, execute);
  assert.deepEqual(commands.splice(0), [
    ["xdg-mime", "query", "default", mime],
    ["xdg-mime", "query", "default", mime],
    ["xdg-mime", "default", handler, mime],
  ]);
  select("de.zelotez.rooms.desktop");
  await registerLinuxShareLink(env, execute);
  assert.deepEqual(commands, [["xdg-mime", "query", "default", mime]]);
  assert.equal(await readFile(file, "utf8"), first);
});

test("Linux AppImage leaves an existing default or an unmanaged file in place", async t => {
  const { env, directory, file, commands, execute, select } = await fixture(t);
  select("other.desktop");
  await registerLinuxShareLink(env, execute);
  await assert.rejects(readFile(file), { code: "ENOENT" });
  select("");
  const existing = "[Desktop Entry]\nType=Application\nName=User-defined launch\nExec=custom\n";
  await mkdir(directory, { recursive: true });
  await writeFile(file, existing);
  await registerLinuxShareLink(env, execute);
  assert.equal(await readFile(file, "utf8"), existing);
  assert.deepEqual(commands, [["xdg-mime", "query", "default", mime], ["xdg-mime", "query", "default", mime]]);
});

test("Linux AppImage keeps literal percent signs separate from URI field codes", async t => {
  const { env, file, execute } = await fixture(t);
  env.APPIMAGE = path.join(env.HOME, "Rooms 100%.AppImage");
  await writeFile(env.APPIMAGE, "", { mode: 0o700 });
  await registerLinuxShareLink(env, execute);
  assert.ok((await readFile(file, "utf8")).includes(
    'Exec=/usr/bin/env -- "' + env.APPIMAGE.replace("%", "%%") + '" %u\n'));
});
