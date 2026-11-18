"use strict";

const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { constants: { O_NOFOLLOW, O_NONBLOCK, O_RDONLY, X_OK } } = require("node:fs");
const { access, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } = require("node:fs/promises");
const { homedir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { scheme } = require("./share-link.cjs");

const run = promisify(execFile);
const desktopId = "de.zelotez.rooms.desktop";
const oldHandlerId = "de.zelotez.rooms.AppImage.desktop";
const appName = "ZeloteZ Rooms";
const mimeType = "x-scheme-handler/" + scheme;
const managed = "X-ZeloteZ-Rooms-Managed=true";
const iconName = "de.zelotez.rooms.AppImage";
const versionedEntry = /^zelotez-rooms-(\d+\.\d+\.\d+)-x86_64\.desktop$/u;

function desktopEntry(image, visible, icon) {
  // Escape for Exec argument quoting, then for the desktop key's string value.
  const executable = image.replace(/["`$\\]/gu, character => "\\" + character)
    .replace(/\\/gu, "\\\\").replace(/%/gu, "%%");
  // GIO resolves the first token before unescaping field codes, including literal %%.
  const prefix = image.includes("%") ? "Exec=/usr/bin/env -- " : "Exec=";
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=" + appName,
    prefix + '"' + executable + '" %u',
    "Terminal=false",
    "Icon=" + icon,
    ...(visible ? [] : ["NoDisplay=true"]),
    "StartupWMClass=de.zelotez.rooms",
    "Categories=Network;",
    "MimeType=" + mimeType + ";",
    managed,
    "",
  ].join("\n");
}

function desktopFields(contents) {
  const fields = new Map();
  let group = false;
  for (const line of contents.split(/\r?\n/u)) {
    if (line.startsWith("[")) {
      if (group) break;
      group = line === "[Desktop Entry]";
      continue;
    }
    if (!group || !line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    if (fields.has(key)) return new Map();
    fields.set(key, line.slice(separator + 1));
  }
  return fields;
}

function entryKind(id, fields) {
  if (fields.get("Type") !== "Application" || fields.get("Name") !== appName ||
      !fields.get("MimeType")?.split(";").includes(mimeType)) return null;
  const hasOnlyRoomsMime = fields.get("MimeType") === mimeType + ";";
  if (hasOnlyRoomsMime && (id === desktopId || id === oldHandlerId) &&
      fields.get("X-ZeloteZ-Rooms-Managed") === "true") return "owned";

  // Older builds and installers generated these exact launchers without an
  // ownership marker. Leave entries with custom commands or keys in place.
  const executable = /^"([^"\\]+)" %[uU]$/u.exec(fields.get("Exec") ?? "")?.[1];
  const legacyIcon = fields.get("Icon") ?? "";
  if (hasOnlyRoomsMime && executable && path.isAbsolute(executable) && fields.get("Terminal") === "false" &&
      fields.get("Categories") === "Network;") {
    if (id === desktopId && fields.size === 7 &&
        /^ZeloteZ-Rooms-\d+\.\d+\.\d+-x86_64\.AppImage$/u.test(path.basename(executable)) &&
        path.isAbsolute(legacyIcon) && legacyIcon.endsWith("/desktop/portable/ui/icon.png")) return "legacy";
    const version = versionedEntry.exec(id)?.[1];
    if (version && fields.size === 11 && fields.get("TryExec") === executable &&
        path.basename(executable) === "ZeloteZ-Rooms-" + version + "-x86_64.AppImage" &&
        fields.get("X-AppImage-Version") === version && legacyIcon === id.slice(0, -".desktop".length) &&
        fields.get("StartupWMClass") === "de.zelotez.rooms" &&
        fields.get("Comment") === "ZeloteZ Rooms desktop client") return "legacy";
  }
  if (fields.get("Hidden") !== "true" && fields.get("NoDisplay") !== "true") return "external";
  return null;
}

async function readDesktop(file) {
  const descriptor = await open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK).catch(() => null);
  if (!descriptor) return null;
  try {
    const info = await descriptor.stat();
    return info.isFile() && info.size <= 32 * 1024 ? await descriptor.readFile("utf8") : null;
  } finally {
    await descriptor.close();
  }
}

async function replaceFile(file, contents, previous) {
  if (previous === null) {
    await writeFile(file, contents, { mode: 0o644, flag: "wx" });
    return;
  }
  const temporary = file + "." + randomUUID() + ".new";
  try {
    await writeFile(temporary, contents, { mode: 0o644, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function menuIcon(xdg, appDir) {
  if (typeof appDir !== "string" || !path.isAbsolute(appDir)) return "zelotez-rooms-desktop";
  const icon = await readFile(path.join(appDir, "zelotez-rooms-desktop.png")).catch(() => null);
  if (!icon) return "zelotez-rooms-desktop";
  const directory = path.join(xdg, "icons", "hicolor", "512x512", "apps");
  const target = path.join(directory, iconName + ".png");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const previous = await readFile(target).catch(() => null);
  if (!previous?.equals(icon)) await replaceFile(target, icon, previous);
  return iconName;
}

async function registerLinuxShareLink(env = process.env, execute = run) {
  const image = env.APPIMAGE;
  if (typeof image !== "string" || !path.isAbsolute(image) || /[=\p{Cc}]/u.test(image)) return;
  if (!(await stat(image).catch(() => null))?.isFile()) return;
  await access(image, X_OK);

  const xdg = typeof env.XDG_DATA_HOME === "string" && path.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME : path.join(env.HOME || homedir(), ".local", "share");
  const directory = path.join(xdg, "applications");
  const command = (name, args) => execute(name, args, { env, timeout: 2500, maxBuffer: 4096 });
  const query = async () => (await command("xdg-mime", ["query", "default", mimeType])).stdout.trim();

  const selected = await query();
  const files = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const entries = new Map();
  for (const file of files) {
    if (!file.name.endsWith(".desktop")) continue;
    const candidate = path.join(directory, file.name);
    const contents = file.isFile() ? await readDesktop(candidate).catch(() => null) : null;
    const kind = contents === null ? null : entryKind(file.name, desktopFields(contents));
    if (kind || file.name === desktopId || file.name === oldHandlerId) {
      entries.set(file.name, { candidate, contents, kind });
    }
  }
  const canonical = entries.get(desktopId);
  const canManageCanonical = !canonical || canonical.kind === "owned" || canonical.kind === "legacy";
  const targetId = canManageCanonical ? desktopId : oldHandlerId;
  const target = entries.get(targetId);
  if (target && !["owned", "legacy"].includes(target.kind)) return;
  if (!canManageCanonical && !target && selected && selected !== targetId) return;

  const visible = canManageCanonical && ![...entries.values()].some(entry => entry.kind === "external");
  const icon = await menuIcon(xdg, env.APPDIR).catch(() => "zelotez-rooms-desktop");
  const contents = desktopEntry(image, visible, icon);
  const file = path.join(directory, targetId);
  if (target?.contents !== contents) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (target && await readDesktop(file) !== target.contents) return;
    await replaceFile(file, contents, target?.contents ?? null);
    await command("update-desktop-database", [directory]).catch(() => {});
  }

  const duplicates = canManageCanonical
    ? [...entries].filter(([id, entry]) => id !== targetId && ["owned", "legacy"].includes(entry.kind)) : [];
  const retiringSelection = duplicates.some(([id]) => id === selected);
  let current = selected;
  if (!selected || retiringSelection) {
    current = await query();
    if (!current || current === selected) {
      await command("xdg-mime", ["default", targetId, mimeType]);
      current = retiringSelection ? await query() : targetId;
    }
  }
  let removed = false;
  for (const [id, entry] of duplicates) {
    if (id !== current && await readDesktop(entry.candidate).catch(() => null) === entry.contents) {
      await rm(entry.candidate, { force: true });
      removed = true;
    }
  }
  if (removed) await command("update-desktop-database", [directory]).catch(() => {});
}

module.exports = { registerLinuxShareLink };
