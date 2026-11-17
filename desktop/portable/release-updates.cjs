"use strict";

const { randomUUID } = require("node:crypto");
const { mkdir, open, rename, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");

const repository = "ZeloteZ/ZeloteZ-Rooms";
const endpoint = "https://api.github.com/repos/" + repository + "/releases/latest";
const versionPattern = /^(?:0|[1-9]\d{0,8})(?:\.(?:0|[1-9]\d{0,8})){2}$/u;
const tokenPattern = /^github_pat_[A-Za-z0-9_]{30,200}$/u;
const maxResponse = 512 * 1024;
const maxCredential = 1024;
const checkIntervals = ["1", "6", "24", "168"];

function releasePage(version) {
  return typeof version === "string" && versionPattern.test(version)
    ? "https://github.com/" + repository + "/releases/tag/v" + version : null;
}

function newerVersion(candidate, installed) {
  if (typeof candidate !== "string" || typeof installed !== "string" ||
      !versionPattern.test(candidate) || !versionPattern.test(installed)) return false;
  const current = installed.split(".").map(Number);
  const difference = candidate.split(".").map((part, index) => Number(part) - current[index]).find(part => part !== 0);
  return difference > 0;
}

function installerName(version, platform, arch) {
  if (arch !== "x64") return null;
  if (platform === "linux") return "ZeloteZ-Rooms-" + version + "-x86_64.AppImage";
  if (platform === "win32") return "ZeloteZ-Rooms-" + version + "-x64.exe";
  return null;
}

async function readMetadata(response) {
  if (!response.body || Number(response.headers.get("content-length")) > maxResponse) {
    void response.body?.cancel().catch(() => {});
    throw new Error("Invalid release metadata");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxResponse) throw new Error("Release metadata is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
}

async function findUpdate({ token, installed, platform, arch, signal, fetchRelease = fetch }) {
  if (typeof token !== "string" || !tokenPattern.test(token)) return { status: "token" };
  const deadline = AbortSignal.timeout(10000);
  try {
    const response = await fetchRelease(endpoint, {
      method: "GET", redirect: "error", credentials: "omit", cache: "no-store",
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      headers: {
        Accept: "application/vnd.github+json", Authorization: "Bearer " + token,
        "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "ZeloteZ-Rooms-Desktop",
      },
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return { status: [401, 403, 404].includes(response.status) ? "access" : "unavailable" };
    }
    const release = await readMetadata(response);
    const version = typeof release?.tag_name === "string" && release.tag_name.startsWith("v") ? release.tag_name.slice(1) : "";
    if (!releasePage(version) || release.draft !== false || release.prerelease !== false) {
      return { status: "unavailable" };
    }
    if (!newerVersion(version, installed)) return { status: "current" };
    const asset = installerName(version, platform, arch);
    const installer = Boolean(asset && Array.isArray(release.assets) &&
      release.assets.some(item => item?.name === asset && item.state === "uploaded"));
    return { status: "available", version, installer };
  } catch {
    return { status: signal?.aborted ? "cancelled" : "unavailable" };
  }
}

function bounded(operation) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("System credential storage did not finish")), 8000);
    timer.unref();
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

function releaseCredential(file, safeStorage, platform) {
  let queue = Promise.resolve();
  function serialized(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  function protectedBytes(bytes) {
    return Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maxCredential &&
      (platform !== "linux" || ["v11", "v12"].includes(bytes.toString("ascii", 0, 3)));
  }
  async function read() {
    try {
      const handle = await open(file, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > maxCredential) return null;
        const buffer = Buffer.alloc(maxCredential + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const bytes = buffer.subarray(0, bytesRead);
        return protectedBytes(bytes) ? bytes : null;
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }
  async function save(token) {
    if (typeof token !== "string" || !tokenPattern.test(token)) return "invalid";
    try {
      if (!await bounded(safeStorage.isAsyncEncryptionAvailable())) return "secureStorage";
      const encrypted = await bounded(safeStorage.encryptStringAsync(token));
      if (!protectedBytes(encrypted)) return "secureStorage";
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = file + "." + randomUUID() + ".new";
      try {
        await writeFile(temporary, encrypted, { mode: 0o600, flag: "wx" });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
      return "saved";
    } catch {
      return "secureStorage";
    }
  }
  return {
    has: () => serialized(async () => Boolean(await read())),
    get: () => serialized(async () => {
      const bytes = await read();
      if (!bytes) return null;
      const { result } = await bounded(safeStorage.decryptStringAsync(bytes));
      return typeof result === "string" && tokenPattern.test(result) ? result : null;
    }).catch(() => null),
    save: token => serialized(() => save(token)),
    remove: () => serialized(async () => { await rm(file, { force: true }); return "removed"; })
      .catch(() => "secureStorage"),
  };
}

module.exports = { checkIntervals, findUpdate, releaseCredential, releasePage };
