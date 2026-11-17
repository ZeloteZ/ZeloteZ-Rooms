"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { findUpdate, releasePage } = require("../release-updates.cjs");
const { parseShareLink, shareLinkFromArguments } = require("../share-link.cjs");

const origin = "https://rooms.example.com";
const releaseRequest = { origin, installed: "0.1.9", platform: "linux", arch: "x64" };
const release = { product: "zelotez-rooms", protocol: 1, version: "0.1.15", artifacts: ["linux-x64"] };

test("desktop update checks use the configured Rooms origin without credentials and validate stable versions", async () => {
  const find = (data, changes = {}) => findUpdate({ ...releaseRequest, ...changes, async fetchRelease(url, init) {
    assert.equal(url, origin + "/api/desktop/release");
    assert.equal(init.method, "GET");
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.deepEqual(init.headers, { Accept: "application/json" });
    return Response.json(data);
  } });
  assert.deepEqual(await find(release), { status: "available", version: "0.1.15", installer: true });
  assert.deepEqual(await find(release, { platform: "win32" }), { status: "available", version: "0.1.15", installer: false });
  assert.deepEqual(await find(release, { installed: "0.1.16" }), { status: "current" });
  for (const invalid of [
    { ...release, version: "0.1.15-rc.1" },
    { ...release, product: "another-app" },
    { ...release, protocol: 2 },
    { ...release, artifacts: ["linux-x64", "linux-x64"] },
    { ...release, artifacts: ["https://example.com/file.exe"] },
    { ...release, url: "https://example.com/file.exe" },
  ]) assert.deepEqual(await find(invalid), { status: "unavailable" });
  assert.deepEqual(await findUpdate({ ...releaseRequest, fetchRelease: () => Response.redirect("https://example.net") }),
    { status: "unavailable" });
  assert.deepEqual(await findUpdate({ ...releaseRequest, fetchRelease: () => new Response(null, { status: 404 }) }),
    { status: "unavailable" });
  assert.equal(releasePage("0.1.15"), "https://github.com/ZeloteZ/ZeloteZ-Rooms/releases/tag/v0.1.15");
  assert.equal(releasePage("../example"), null);
});

test("desktop update checks do not contact an absent or malformed instance and bound the response", async () => {
  for (const address of ["", "http://example.com", origin + "/other", "https://name@" + new URL(origin).host]) {
    const result = await findUpdate({ ...releaseRequest, origin: address, fetchRelease: () => assert.fail("An instance is required") });
    assert.deepEqual(result, { status: "instance" });
  }
  assert.deepEqual(await findUpdate({ ...releaseRequest, fetchRelease: () => Response.json({ ...release, artifacts: ["a".repeat(4096)] }) }),
    { status: "unavailable" });
  assert.deepEqual(await findUpdate({ ...releaseRequest, fetchRelease: () => new Response(JSON.stringify(release)) }),
    { status: "unavailable" });
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
