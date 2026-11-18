"use strict";

const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { registerLinuxShareLink } = require("../linux-share-link.cjs");

const handler = "de.zelotez.rooms.desktop";
const oldHandler = "de.zelotez.rooms.AppImage.desktop";
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
  const addDesktop = async (id, contents) => {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, id), contents);
  };
  return { env, directory, file: path.join(directory, handler), commands, execute, addDesktop,
    select: value => { selected = value; } };
}

test("Linux AppImage registers its actual file and refreshes an owned handler after a move", async t => {
  const { env, directory, file, commands, execute } = await fixture(t);
  await registerLinuxShareLink(env, execute);
  const first = await readFile(file, "utf8");
  assert.ok(first.includes('Exec=/usr/bin/env -- "' + env.APPIMAGE + '" %u\n'));
  assert.ok(first.includes("MimeType=" + mime + ";\n"));
  assert.ok(!first.includes("NoDisplay=true"));
  assert.deepEqual(commands.splice(0), [
    ["xdg-mime", "query", "default", mime],
    ["update-desktop-database", directory],
    ["xdg-mime", "query", "default", mime],
    ["xdg-mime", "default", handler, mime],
  ]);

  env.APPIMAGE = path.join(env.HOME, "Rooms 0.2.AppImage");
  await writeFile(env.APPIMAGE, "", { mode: 0o700 });
  await registerLinuxShareLink(env, execute);
  assert.ok((await readFile(file, "utf8")).includes('Exec=/usr/bin/env -- "' + env.APPIMAGE + '" %u\n'));
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
  select("custom.desktop");
  await registerLinuxShareLink(env, execute);
  assert.deepEqual(commands, [["xdg-mime", "query", "default", mime]]);
  assert.equal(await readFile(file, "utf8"), first);
});

test("Linux AppImage preserves a custom menu entry and the existing default", async t => {
  const { env, directory, file, commands, execute, select } = await fixture(t);
  select("other.desktop");
  await registerLinuxShareLink(env, execute);
  assert.ok((await readFile(file, "utf8")).includes("Name=ZeloteZ Rooms"));
  assert.ok(!commands.some(([tool, action]) => tool === "xdg-mime" && action === "default"));
  commands.length = 0;
  select("");
  const existing = "[Desktop Entry]\nType=Application\nName=User-defined launch\nExec=custom\n";
  await mkdir(directory, { recursive: true });
  await writeFile(file, existing);
  await registerLinuxShareLink(env, execute);
  assert.equal(await readFile(file, "utf8"), existing);
  assert.ok((await readFile(path.join(directory, oldHandler), "utf8")).includes("NoDisplay=true"));
  assert.deepEqual(commands, [
    ["xdg-mime", "query", "default", mime],
    ["update-desktop-database", directory],
    ["xdg-mime", "query", "default", mime],
    ["xdg-mime", "default", oldHandler, mime],
  ]);
});

test("Linux AppImage keeps literal percent signs separate from URI field codes", async t => {
  const { env, file, execute } = await fixture(t);
  env.APPIMAGE = path.join(env.HOME, "Rooms 100%.AppImage");
  await writeFile(env.APPIMAGE, "", { mode: 0o700 });
  await registerLinuxShareLink(env, execute);
  assert.ok((await readFile(file, "utf8")).includes(
    'Exec=/usr/bin/env -- "' + env.APPIMAGE.replace("%", "%%") + '" %u\n'));
});

function oldReleaseEntry(image, version) {
  return `[Desktop Entry]
Name=ZeloteZ Rooms
Exec="${image}" %U
Terminal=false
Type=Application
Icon=zelotez-rooms-${version}-x86_64
StartupWMClass=de.zelotez.rooms
X-AppImage-Version=${version}
Comment=ZeloteZ Rooms desktop client
MimeType=${mime};
Categories=Network;

TryExec=${image}
`;
}

test("Linux AppImage updates the legacy stable launcher and removes verified versioned duplicates", async t => {
  const { env, directory, file, commands, execute, addDesktop, select } = await fixture(t);
  const version = "0.1.35";
  const previousImage = path.join(env.HOME, "ZeloteZ-Rooms-" + version + "-x86_64.AppImage");
  const versioned = "zelotez-rooms-" + version + "-x86_64.desktop";
  const bundledIcon = path.join(__dirname, "../ui/icon.png");
  env.APPDIR = path.join(env.HOME, "AppDir");
  await mkdir(env.APPDIR);
  await symlink(bundledIcon, path.join(env.APPDIR, "zelotez-rooms-desktop.png"));
  await addDesktop(handler, `[Desktop Entry]
Type=Application
Name=ZeloteZ Rooms
Exec="${previousImage}" %u
Icon=${env.HOME}/desktop/portable/ui/icon.png
Terminal=false
Categories=Network;
MimeType=${mime};
`);
  await addDesktop(oldHandler, `[Desktop Entry]
Type=Application
Name=ZeloteZ Rooms
Exec="${previousImage}" %u
Terminal=false
NoDisplay=true
MimeType=${mime};
X-ZeloteZ-Rooms-Managed=true
`);
  await addDesktop(versioned, oldReleaseEntry(previousImage, version));
  select(versioned);
  await registerLinuxShareLink(env, execute);
  assert.deepEqual(await readdir(directory), [handler]);
  const registered = await readFile(file, "utf8");
  assert.ok(registered.includes('Exec=/usr/bin/env -- "' + env.APPIMAGE + '" %u'));
  assert.ok(registered.includes("Icon=de.zelotez.rooms.AppImage"));
  const localIcon = path.join(env.XDG_DATA_HOME, "icons/hicolor/512x512/apps/de.zelotez.rooms.AppImage.png");
  assert.deepEqual(await readFile(localIcon), await readFile(bundledIcon));
  assert.ok(commands.some(([tool, action, selected]) => tool === "xdg-mime" && action === "default" && selected === handler));
});

test("Linux AppImage leaves one launcher provided by an integration tool and preserves custom entries", async t => {
  const { env, directory, file, commands, execute, addDesktop, select } = await fixture(t);
  const version = "0.1.35";
  const entry = "zelotez-rooms-" + version + "-x86_64.desktop";
  const appImage = path.join(env.HOME, "ZeloteZ-Rooms-" + version + "-x86_64.AppImage");
  const external = oldReleaseEntry(appImage, version) + "X-External-Manager=true\n";
  const symlinkId = "zelotez-rooms-0.1.34-x86_64.desktop";
  const userApp = "[Desktop Entry]\nName=Custom program\nType=Application\nExec=custom\n";
  await addDesktop(entry, external);
  await addDesktop("custom.desktop", userApp);
  await symlink("custom.desktop", path.join(directory, symlinkId));
  select(entry);
  await registerLinuxShareLink(env, execute);
  assert.ok((await readFile(file, "utf8")).includes("NoDisplay=true"));
  assert.equal(await readFile(path.join(directory, entry), "utf8"), external);
  assert.equal(await readFile(path.join(directory, "custom.desktop"), "utf8"), userApp);
  assert.equal(await readFile(path.join(directory, symlinkId), "utf8"), userApp);
  assert.ok(!commands.some(([tool, action]) => tool === "xdg-mime" && action === "default"));
});
