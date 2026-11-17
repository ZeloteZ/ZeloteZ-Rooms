"use strict";

const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { constants: { X_OK } } = require("node:fs");
const { access, mkdir, readFile, rename, rm, stat, writeFile } = require("node:fs/promises");
const { homedir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { scheme } = require("./share-link.cjs");

const run = promisify(execFile);
const desktopId = "de.zelotez.rooms.AppImage.desktop";
const mimeType = "x-scheme-handler/" + scheme;
const managed = "X-ZeloteZ-Rooms-Managed=true";

function desktopEntry(image) {
  // Escape for Exec argument quoting, then for the desktop key's string value.
  const executable = image.replace(/["`$\\]/gu, character => "\\" + character)
    .replace(/\\/gu, "\\\\").replace(/%/gu, "%%");
  // GIO resolves the first token before unescaping field codes, including literal %%.
  const prefix = image.includes("%") ? "Exec=/usr/bin/env -- " : "Exec=";
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=ZeloteZ Rooms",
    prefix + '"' + executable + '" %u',
    "Terminal=false",
    "NoDisplay=true",
    "MimeType=" + mimeType + ";",
    managed,
    "",
  ].join("\n");
}

async function registerLinuxShareLink(env = process.env, execute = run) {
  const image = env.APPIMAGE;
  if (typeof image !== "string" || !path.isAbsolute(image) || /[=\p{Cc}]/u.test(image)) return;
  if (!(await stat(image).catch(() => null))?.isFile()) return;
  await access(image, X_OK);

  const xdg = typeof env.XDG_DATA_HOME === "string" && path.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME : path.join(env.HOME || homedir(), ".local", "share");
  const directory = path.join(xdg, "applications");
  const file = path.join(directory, desktopId);
  const command = (name, args) => execute(name, args, { env, timeout: 2500, maxBuffer: 4096 });
  const query = async () => (await command("xdg-mime", ["query", "default", mimeType])).stdout.trim();

  const selected = await query();
  const existing = await readFile(file, "utf8").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null && !existing.split(/\r?\n/u).includes(managed)) return;
  if (existing === null && selected && selected !== desktopId) return;

  const contents = desktopEntry(image);
  if (existing !== contents) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (existing === null) {
      await writeFile(file, contents, { mode: 0o644, flag: "wx" });
    } else {
      const temporary = file + "." + randomUUID() + ".new";
      try {
        await writeFile(temporary, contents, { mode: 0o644, flag: "wx" });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    await command("update-desktop-database", [directory]).catch(() => {});
  }

  if (!selected) {
    const latest = await query();
    if (!latest || latest === desktopId) await command("xdg-mime", ["default", desktopId, mimeType]);
  }
}

module.exports = { registerLinuxShareLink };
