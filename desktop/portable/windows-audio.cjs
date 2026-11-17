"use strict";

const { execFile, spawn } = require("node:child_process");
const { statSync } = require("node:fs");
const { release } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { app } = require("electron");

const run = promisify(execFile);
const controls = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const outputLimit = 512 * 1024;

function sources(stdout, mode) {
  const entries = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout));
  if (!Array.isArray(entries) || entries.length > 256) throw new Error("Invalid Windows audio source list");
  const seen = new Set();
  const result = [];
  for (const source of entries) {
    const { title, serial, identity } = source ?? {};
    if (typeof title !== "string" || title.length > 4096 || typeof serial !== "string" || !serial || serial.length > 1024 ||
        controls.test(serial) || typeof identity !== "string" || !identity || identity.length > 1024 || controls.test(identity) ||
        (mode === "application" && (!/^[1-9][0-9]{0,9}$/u.test(serial) || Number(serial) > 0xffffffff)) || seen.has(serial)) {
      throw new Error("Invalid Windows audio source");
    }
    seen.add(serial);
    const name = title.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, " ").replace(/\s+/gu, " ").trim();
    if (!name) continue;
    result.push({ title: [...name].slice(0, 120).join(""), serial, identity });
  }
  return result.sort((left, right) => left.title.localeCompare(right.title));
}

function createWindowsAudio() {
  if (process.platform !== "win32") return null;
  const executable = path.join(app.isPackaged ? process.resourcesPath : __dirname, "windows-audio", "rooms-windows-audio.exe");
  try {
    if (!path.isAbsolute(executable) || !statSync(executable).isFile()) return null;
    const [major, minor, build] = release().split(".").map(Number);
    if (![major, minor, build].every(Number.isSafeInteger) || major < 10 || build < 10240) return null;
    const modes = Object.freeze(build >= 22000 ? ["application", "system"] : ["system"]);
    return {
      modes,
      error: "windows",
      async outputs(mode) {
        if (!modes.includes(mode)) throw new Error("Unsupported Windows audio mode");
        const { stdout } = await run(executable, ["list", mode], {
          timeout: 3000, maxBuffer: outputLimit, encoding: "buffer", windowsHide: true, shell: false,
        });
        return sources(stdout, mode);
      },
      record(mode, selected) {
        if (!modes.includes(mode)) throw new Error("Unsupported Windows audio mode");
        return spawn(executable, ["record", mode, selected.serial, selected.identity], {
          stdio: ["ignore", "pipe", "ignore"], windowsHide: true, shell: false,
        });
      },
    };
  } catch {
    return null;
  }
}

module.exports = { createWindowsAudio };
