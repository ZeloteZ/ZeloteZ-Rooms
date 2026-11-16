"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { mkdir, open, rename, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");

const accountId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const key = /^[a-zA-Z0-9_-]{43}$/u;
const maxSavedBytes = 4096;
const maxLifetime = 8 * 86400;
const allowedPlatforms = new Set(["darwin", "linux", "win32"]);

function bounded(operation) {
  let timer;
  return Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("System credential storage did not finish.")), 10000);
    timer.unref();
  })]).finally(() => clearTimeout(timer));
}

function createRememberedLogin(directory, safeStorage, platform, origin, cookies) {
  const url = new URL(origin);
  const { protocol, hostname } = url;
  const secure = protocol === "https:";
  if (url.origin !== origin || !allowedPlatforms.has(platform) || typeof safeStorage.encryptStringAsync !== "function" ||
      (!secure && (protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(hostname)))) return null;
  const name = secure ? "__Host-zelotez_session" : "zelotez_session";
  const file = path.join(directory, createHash("sha256").update(origin).digest("hex") + ".bin");
  let queue = Promise.resolve();
  let remembered;

  function serialize(operation) {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  }

  function protectedBytes(bytes) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxSavedBytes) return false;
    // Chromium's Linux v10 provider uses a public, fixed key. Only system-backed v11/v12 are accepted.
    return platform !== "linux" || ["v11", "v12"].includes(bytes.toString("ascii", 0, 3));
  }

  function validExpiry(expires) {
    const now = Date.now() / 1000;
    return Number.isFinite(expires) && expires > now && expires <= now + maxLifetime;
  }

  async function read() {
    const handle = await open(file, "r");
    try {
      if (!(await handle.stat()).isFile()) return null;
      const buffer = Buffer.alloc(maxSavedBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async function write(data, valid) {
    const encrypted = await bounded(safeStorage.encryptStringAsync(JSON.stringify(data)));
    if (!protectedBytes(encrypted) || !await valid()) return false;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = file + "." + randomUUID() + ".new";
    try {
      await writeFile(temporary, encrypted, { mode: 0o600, flag: "wx" });
      if (!await valid()) return false;
      await rename(temporary, file);
      return true;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async function sessionCookie() {
    const entries = await cookies.get({ url: origin, name });
    if (entries.length !== 1) return null;
    const [cookie] = entries;
    return cookie.httpOnly && cookie.hostOnly && cookie.secure === secure && cookie.sameSite === "strict" &&
      cookie.domain === hostname && cookie.path === "/" && key.test(cookie.value) && validExpiry(cookie.expirationDate)
      ? cookie : null;
  }

  async function restore() {
    const bytes = await read().catch(() => null);
    if (!bytes) return;
    if (!protectedBytes(bytes)) {
      await rm(file, { force: true });
      return;
    }
    const { result } = await bounded(safeStorage.decryptStringAsync(bytes));
    const record = JSON.parse(result);
    if (record?.version !== 1 || record.origin !== origin || typeof record.id !== "string" || !accountId.test(record.id) ||
        typeof record.vault !== "string" || !key.test(record.vault) || typeof record.token !== "string" ||
        !key.test(record.token) || !validExpiry(record.expirationDate)) {
      await rm(file, { force: true });
      return;
    }
    await cookies.set({ url: origin, name, value: record.token, path: "/", httpOnly: true,
      secure, sameSite: "strict", expirationDate: record.expirationDate });
    remembered = record;
  }

  return {
    // A temporarily locked keychain leaves the entry intact and the app can sign in manually.
    restore: () => serialize(restore).catch(() => {}),
    load: (id, valid) => serialize(async () => {
      if (!remembered || id !== remembered.id || remembered.token !== (await sessionCookie())?.value || !valid()) return null;
      return remembered.vault;
    }).catch(() => null),
    save: (input, valid) => serialize(async () => {
      if (typeof input?.id !== "string" || !accountId.test(input.id) ||
          typeof input.vault !== "string" || !key.test(input.vault)) return false;
      remembered = null;
      await rm(file, { force: true });
      const cookie = await sessionCookie();
      if (!cookie || !valid()) return false;
      const record = { version: 1, origin, id: input.id, vault: input.vault, token: cookie.value,
        expirationDate: cookie.expirationDate };
      const saved = await write(record, async () => (await sessionCookie())?.value === cookie.value && valid());
      if (saved) remembered = record;
      return saved;
    }).catch(() => false),
    forget: () => serialize(async () => {
      remembered = null;
      await rm(file, { force: true });
      return true;
    }).catch(() => false),
    discard: () => serialize(async () => {
      if (!remembered) return;
      const record = remembered;
      remembered = null;
      await rm(file, { force: true });
      if (record.token === (await sessionCookie())?.value) await cookies.remove(origin, name);
    }).catch(() => {}),
  };
}

module.exports = { createRememberedLogin };
