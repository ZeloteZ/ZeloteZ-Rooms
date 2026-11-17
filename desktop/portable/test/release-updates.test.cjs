"use strict";

const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { findUpdate, releaseCredential, releasePage } = require("../release-updates.cjs");
const { parseShareLink, shareLinkFromArguments } = require("../share-link.cjs");

const testToken = "github_pat_" + "A".repeat(50);
const releaseRequest = { token: testToken, installed: "0.1.9", platform: "linux", arch: "x64" };
const release = { tag_name: "v0.1.12", draft: false, prerelease: false,
  assets: [{ name: "ZeloteZ-Rooms-0.1.12-x86_64.AppImage", state: "uploaded" }] };

test("desktop update checks use the fixed GitHub repository and validate stable versions", async () => {
  const find = (data, changes = {}) => findUpdate({ ...releaseRequest, ...changes, async fetchRelease(url, init) {
    assert.equal(url, "https://api.github.com/repos/ZeloteZ/ZeloteZ-Rooms/releases/latest");
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, "Bearer " + testToken);
    return Response.json(data);
  } });
  assert.deepEqual(await find(release), { status: "available", version: "0.1.12", installer: true });
  assert.deepEqual(await find(release, { platform: "win32" }), { status: "available", version: "0.1.12", installer: false });
  assert.deepEqual(await find(release, { installed: "0.1.13" }), { status: "current" });
  assert.deepEqual(await find({ ...release, tag_name: "v0.1.12-rc.1" }), { status: "unavailable" });
  assert.deepEqual(await find({ ...release, prerelease: true }), { status: "unavailable" });
  assert.deepEqual(await findUpdate({ ...releaseRequest, token: "", fetchRelease: () => assert.fail("A token is required") }),
    { status: "token" });
  assert.deepEqual(await findUpdate({ ...releaseRequest, fetchRelease: () => new Response(null, { status: 404 }) }),
    { status: "access" });
  assert.equal(releasePage("0.1.12"), "https://github.com/ZeloteZ/ZeloteZ-Rooms/releases/tag/v0.1.12");
  assert.equal(releasePage("../example"), null);
});

test("desktop release credentials are encrypted and the Linux plaintext backend is rejected", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "rooms-release-token-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "token.bin");
  const payload = Buffer.from("v11-system-encrypted-test-data");
  const storage = {
    isAsyncEncryptionAvailable: async () => true,
    async encryptStringAsync(token) { assert.equal(token, testToken); return payload; },
    async decryptStringAsync(bytes) { assert.deepEqual(bytes, payload); return { result: testToken }; },
  };
  const credentials = releaseCredential(file, storage, "linux");
  assert.equal(await credentials.has(), false);
  assert.equal(await credentials.save("ghp_classic_token"), "invalid");
  assert.equal(await credentials.save(testToken), "saved");
  assert.equal(await credentials.has(), true);
  assert.deepEqual(await readFile(file), payload);
  assert.equal(await credentials.get(), testToken);
  const fallback = releaseCredential(file, { ...storage, encryptStringAsync: async () => Buffer.from("v10-known-key") }, "linux");
  assert.equal(await fallback.save(testToken), "secureStorage");
  assert.deepEqual(await readFile(file), payload);
  assert.equal(await credentials.remove(), "removed");
  assert.equal(await credentials.get(), null);
});

test("desktop handoff only parses one canonical instance and an exact YouTube video ID", () => {
  const origin = "https://rooms.example.com";
  const valid = "zelotez-rooms://share/youtube/M7lc1UVf-VE?instance=" + encodeURIComponent(origin);
  const normalize = value => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" ? url.origin : null;
  };
  const expected = { origin, fragment: "#/share/youtube/M7lc1UVf-VE" };
  assert.deepEqual(parseShareLink(valid, normalize), expected);
  assert.deepEqual(shareLinkFromArguments(["electron", "rooms", valid], normalize), expected);
  for (const invalid of [
    valid + "&instance=other", valid + "#elsewhere", valid.replace("://share/", "://name@share/"),
    valid.replace("/youtube/", "/youtube/hidden/../"), valid.replace("M7lc1UVf-VE", "x"),
    valid.replace(encodeURIComponent(origin), encodeURIComponent(origin + "/redirect")),
    valid.replace(encodeURIComponent(origin), encodeURIComponent("javascript:prompt(1)")),
  ]) assert.equal(parseShareLink(invalid, normalize), null);
  assert.equal(shareLinkFromArguments([valid, valid], normalize), null);
});
