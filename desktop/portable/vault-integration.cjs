"use strict";

const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { constants: { O_NOFOLLOW = 0, O_NONBLOCK = 0, O_RDONLY, X_OK } } = require("node:fs");
const { access, lstat, stat, mkdir, open, rename, rm, writeFile } = require("node:fs/promises");
const { homedir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const run = promisify(execFile);
const label = "Share securely via Vault";
const marker = "X-ZeloteZ-Vault-Managed=v1";
const begin = "<!-- ZeloteZ Vault integration BEGIN v1 -->";
const end = "<!-- ZeloteZ Vault integration END v1 -->";
const registryMarker = "ZeloteZVaultManaged";
const registryKeys = ["HKCU\\Software\\Classes\\*\\shell\\ZeloteZVault", "HKCU\\Software\\Classes\\Directory\\shell\\ZeloteZVault"];
const managers = ["nautilus", "nemo", "caja", "dolphin", "thunar"];
const invalid = () => new Error("The Vault desktop integration could not be changed safely.");
function shellQuote(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }
function commandQuote(value) { return '"' + value.replace(/["`$\\]/gu, c => "\\" + c) + '"'; }
function desktopQuote(value) { return commandQuote(value).replaceAll("\\", "\\\\").replaceAll("%", "%%"); }
function xml(value) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
async function contents(file) {
  const handle = await open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK).catch(error => {
    if (error.code === "ENOENT") return null;
    throw invalid();
  });
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) throw invalid();
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}
async function save(file, body, previous, mode) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if (previous === null) { await writeFile(file, body, { flag: "wx", mode }); return; }
  const temporary = file + "." + randomUUID() + ".new";
  try {
    await writeFile(temporary, body, { flag: "wx", mode });
    if (await contents(file) !== previous) throw invalid();
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
function owned(value, manager) {
  if (manager === "thunar") return value.includes(begin) && value.includes(end) && value.split(begin).length === 2 && value.split(end).length === 2;
  return value.split(/\r?\n/u).includes(manager === "nautilus" || manager === "caja" ? "# " + marker : marker);
}
function thunarBlock(command) {
  return `${begin}\n<action>\n<icon>folder-locked</icon>\n<name>${label}</name>\n<unique-id>zelotez-vault-v1</unique-id>\n<command>${xml(command)}</command>\n<description>Share an encrypted ZIP using ZeloteZ Vault</description>\n<patterns>*</patterns>\n<directories/>\n<audio-files/>\n<image-files/>\n<other-files/>\n<text-files/>\n<video-files/>\n</action>\n${end}`;
}
function editThunar(previous, command) {
  let value = previous ?? '<?xml version="1.0" encoding="UTF-8"?>\n<actions>\n</actions>\n';
  if (value.length > 1024 * 1024 || /<!DOCTYPE|<!ENTITY/iu.test(value) ||
      (value.match(/<actions>/gu)?.length !== 1) || (value.match(/<\/actions>/gu)?.length !== 1)) throw invalid();
  if (value.includes(begin) || value.includes(end)) {
    if (!owned(value, "thunar") || value.indexOf(end) < value.indexOf(begin)) throw invalid();
    const first = value.indexOf(begin), last = value.indexOf(end) + end.length;
    value = value.slice(0, first) + value.slice(last);
  }
  return command === null ? value : value.replace("</actions>", thunarBlock(command) + "\n</actions>");
}
function linuxFiles(env) {
  const home = env.HOME || homedir();
  const data = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, ".local", "share");
  const config = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, ".config");
  return {
    nautilus: path.join(data, "nautilus", "scripts", label),
    caja: path.join(config, "caja", "scripts", label),
    nemo: path.join(data, "nemo", "actions", "zelotez-vault.nemo_action"),
    dolphin: path.join(data, "kio", "servicemenus", "zelotez-vault.desktop"),
    thunar: path.join(config, "Thunar", "uca.xml"),
  };
}
function linuxEntry(manager, image) {
  if (manager === "nautilus" || manager === "caja") return `#!/bin/sh\n# ${marker}\nexec ${shellQuote(image)} --vault-share -- "$@"\n`;
  const command = `/usr/bin/env -- ${desktopQuote(image)} --vault-share -- %F`;
  if (manager === "nemo") return `[Nemo Action]\nName=${label}\nComment=Share an encrypted ZIP using ZeloteZ Vault\nExec=${command}\nSelection=notnone\nExtensions=any;\nQuote=double\nUriScheme=file\n${marker}\n`;
  return `[Desktop Entry]\nType=Service\nMimeType=all/all;inode/directory;\nActions=ZeloteZVault;\nX-KDE-Priority=TopLevel\n${marker}\n\n[Desktop Action ZeloteZVault]\nName=${label}\nIcon=folder-locked\nExec=${command}\n`;
}
async function detectedManagers(env) {
  const found = [];
  for (const manager of managers) {
    for (const directory of (env.PATH || "").split(path.delimiter)) {
      if (!directory || !path.isAbsolute(directory)) continue;
      const file = path.join(directory, manager);
      const info = await lstat(file).catch(() => null);
      if (info && (info.isFile() || info.isSymbolicLink()) && await access(file, X_OK).then(() => true, () => false)) { found.push(manager); break; }
    }
  }
  return found;
}
function createVaultIntegration({ platform = process.platform, env = process.env, executable = process.execPath, execute = run } = {}) {
  const registryTool = path.win32.join(env.SystemRoot || env.WINDIR || "C:\\Windows", "System32", "reg.exe");
  const command = (file, args) => execute(file === "reg.exe" ? registryTool : file, args, { windowsHide: true, timeout: 5000, maxBuffer: 16384 });
  async function windowsOwned(registryKey) {
    try {
      const result = await command("reg.exe", ["query", registryKey, "/v", registryMarker]);
      return /ZeloteZVaultManaged[ \t]+REG_SZ[ \t]+([\s\S]*)$/u.exec(result.stdout)?.[1].trim() === "v1";
    } catch { return false; }
  }
  async function windowsExists(registryKey) {
    try { await command("reg.exe", ["query", registryKey]); return true; } catch { return false; }
  }
  async function status() {
    if (platform === "win32") {
      const ownedStates = await Promise.all(registryKeys.map(windowsOwned));
      const existing = await Promise.all(registryKeys.map(windowsExists));
      return { supported: true, installed: ownedStates.every(Boolean), anyInstalled: ownedStates.some(Boolean), managers: ["windows"], conflicts: existing.flatMap((v, i) => v && !ownedStates[i] ? [registryKeys[i]] : []) };
    }
    if (platform !== "linux") return { supported: false, installed: false, managers: [], conflicts: [] };
    const available = await detectedManagers(env), files = linuxFiles(env);
    const conflicts = [], installed = [];
    for (const manager of managers) {
      let body;
      try { body = await contents(files[manager]); }
      catch { conflicts.push(manager); continue; }
      if (body !== null && owned(body, manager)) installed.push(manager);
      else if (body !== null && manager !== "thunar") conflicts.push(manager);
    }
    const image = env.APPIMAGE;
    const supported = typeof image === "string" && path.isAbsolute(image) && !/[\p{Cc}]/u.test(image) && available.length > 0 &&
      (await stat(image).catch(() => null))?.isFile() === true && await access(image, X_OK).then(() => true, () => false);
    return { supported, installed: installed.length > 0, managers: available, installedManagers: installed, conflicts };
  }
  async function install() {
    const current = await status();
    if (!current.supported || current.conflicts.length) throw invalid();
    if (platform === "win32") {
      if (!path.win32.isAbsolute(executable) || /["%\p{Cc}]/u.test(executable)) throw invalid();
      for (const registryKey of registryKeys) {
        if (await windowsExists(registryKey) && !await windowsOwned(registryKey)) throw invalid();
        for (const [name, value] of [[registryMarker, "v1"], ["MUIVerb", label], ["MultiSelectModel", "Document"]]) {
          await command("reg.exe", ["add", registryKey, "/v", name, "/t", "REG_SZ", "/d", value, "/f"]);
        }
        await command("reg.exe", ["add", registryKey + "\\command", "/ve", "/t", "REG_SZ", "/d", `"${executable}" --vault-share -- "%1"`, "/f"]);
      }
      return status();
    }
    const files = linuxFiles(env), image = env.APPIMAGE;
    for (const manager of current.managers) {
      const file = files[manager], previous = await contents(file);
      if (manager !== "thunar" && previous !== null && !owned(previous, manager)) throw invalid();
      const body = manager === "thunar" ? editThunar(previous, `/usr/bin/env -- ${commandQuote(image).replaceAll("%", "%%")} --vault-share -- %F`) : linuxEntry(manager, image);
      if (body !== previous) await save(file, body, previous, manager === "nautilus" || manager === "caja" || manager === "dolphin" ? 0o700 : 0o600);
    }
    return status();
  }
  async function remove() {
    if (platform === "win32") {
      for (const registryKey of registryKeys) if (await windowsOwned(registryKey)) await command("reg.exe", ["delete", registryKey, "/f"]);
      return status();
    }
    if (platform === "linux") {
      for (const [manager, file] of Object.entries(linuxFiles(env))) {
        const previous = await contents(file).catch(() => null);
        if (previous === null || !owned(previous, manager)) continue;
        if (manager === "thunar") await save(file, editThunar(previous, null), previous, 0o600);
        else if (await contents(file) === previous) await rm(file);
      }
    }
    return status();
  }
  return { status, install, remove };
}
module.exports = { createVaultIntegration, detectedManagers, linuxFiles, label, marker, editThunar };
