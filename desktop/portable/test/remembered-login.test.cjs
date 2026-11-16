"use strict";

const assert = require("node:assert/strict");
const { createCipheriv, createDecipheriv, randomBytes, randomUUID } = require("node:crypto");
const { mkdtemp, readdir, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRememberedLogin } = require("../remembered-login.cjs");

const origin = "https://rooms.example.test";
const id = randomUUID();
const vault = randomBytes(32).toString("base64url");
const token = randomBytes(32).toString("base64url");
const active = () => true;

function fakeKeychain(tag = "v11") {
  const key = randomBytes(32);
  return {
    async encryptStringAsync(text) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      return Buffer.concat([Buffer.from(tag), nonce, cipher.update(text), cipher.final(), cipher.getAuthTag()]);
    },
    async decryptStringAsync(bytes) {
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(3, 15));
      decipher.setAuthTag(bytes.subarray(-16));
      return { result: Buffer.concat([decipher.update(bytes.subarray(15, -16)), decipher.final()]).toString() };
    },
  };
}

function cookie(value, expirationDate = Date.now() / 1000 + 200) {
  return { domain: "rooms.example.test", hostOnly: true, name: "__Host-zelotez_session", path: "/", secure: true,
    httpOnly: true, sameSite: "strict", value, expirationDate };
}

function jar(initial = null) {
  return {
    cookie: initial,
    async get() { return this.cookie ? [this.cookie] : []; },
    async set(value) { this.cookie = { ...value, hostOnly: true, domain: new URL(value.url).hostname }; },
    async remove() { this.cookie = null; },
  };
}

async function directory(t) {
  const folder = await mkdtemp(path.join(tmpdir(), "rooms-remembered-login-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

test("remembered login restores its same-origin cookie and matching account's unlock key, then discards both", async t => {
  const folder = await directory(t);
  const storage = fakeKeychain();
  const login = createRememberedLogin(folder, storage, "linux", origin, jar(cookie(token)));
  assert.equal(await login.save({ id, vault }, active), true);
  const [file] = await readdir(folder);
  const bytes = await readFile(path.join(folder, file));
  assert(!bytes.includes(token) && !bytes.includes(vault));

  const other = jar();
  await createRememberedLogin(folder, storage, "linux", origin + ":8443", other).restore();
  assert.equal(other.cookie, null);

  const fresh = jar();
  const restarted = createRememberedLogin(folder, storage, "linux", origin, fresh);
  await restarted.restore();
  assert.equal(fresh.cookie.value, token);
  assert.equal(fresh.cookie.httpOnly, true);
  assert.equal(fresh.cookie.secure, true);
  assert.equal(fresh.cookie.sameSite, "strict");
  assert.equal(await restarted.load(randomUUID(), active), null);
  assert.equal(await restarted.load(id, () => false), null);
  assert.equal(await restarted.load(id, active), vault);
  await restarted.discard();
  assert.equal(fresh.cookie, null);
  assert.equal(await restarted.load(id, active), null);
  assert.deepEqual(await readdir(folder), []);
});

test("Linux fallback and invalid session cookies cannot write a saved login", async t => {
  const folder = await directory(t);
  const fallback = createRememberedLogin(folder, fakeKeychain("v10"), "linux", origin, jar(cookie(token)));
  assert.equal(await fallback.save({ id, vault }, active), false);
  const storage = fakeKeychain();
  for (const value of [{ ...cookie(token), httpOnly: false }, { ...cookie(token), hostOnly: false },
    { ...cookie(token), secure: false }, { ...cookie(token), sameSite: "lax" }, cookie(token, Date.now() / 1000 - 1)]) {
    const login = createRememberedLogin(folder, storage, "linux", origin, jar(value));
    assert.equal(await login.save({ id, vault }, active), false);
  }
  assert.deepEqual(await readdir(folder), []);
});

test("forgetting a login does not clear the running session and token rotation prevents a stale vault from loading", async t => {
  const folder = await directory(t);
  const storage = fakeKeychain("v12");
  const current = jar(cookie(token));
  const login = createRememberedLogin(folder, storage, "linux", origin, current);
  assert.equal(await login.save({ id, vault }, active), true);
  current.cookie = cookie(randomBytes(32).toString("base64url"));
  assert.equal(await login.load(id, active), null);
  assert.equal(await login.forget(), true);
  assert.equal(current.cookie.hostOnly, true);
  const fresh = jar();
  await createRememberedLogin(folder, storage, "linux", origin, fresh).restore();
  assert.equal(fresh.cookie, null);
});

test("a restart removes an expired saved login without installing a cookie", async t => {
  const folder = await directory(t);
  const storage = fakeKeychain();
  const now = Date.now();
  const login = createRememberedLogin(folder, storage, "linux", origin, jar(cookie(token, now / 1000 + 100)));
  assert.equal(await login.save({ id, vault }, active), true);

  t.mock.method(Date, "now", () => now + 101000);
  const fresh = jar();
  await createRememberedLogin(folder, storage, "linux", origin, fresh).restore();
  assert.equal(fresh.cookie, null);
  assert.deepEqual(await readdir(folder), []);
});
