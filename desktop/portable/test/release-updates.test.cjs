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
  assert.equal(releasePage(origin, "0.1.15"), origin + "/#/downloads");
  assert.equal(releasePage(origin, "../example"), null);
});

test("Windows x64 and Linux x64 recognize their server-hosted installers and preserve other platforms", async () => {
  const data = { ...release, artifacts: ["linux-x64", "windows-x64"] };
  for (const [platform, arch, installer] of [
    ["win32", "x64", true], ["linux", "x64", true], ["win32", "arm64", false], ["darwin", "x64", false],
  ]) {
    assert.deepEqual(await findUpdate({ ...releaseRequest, platform, arch, fetchRelease: () => Response.json(data) }),
      { status: "available", version: release.version, installer });
  }
  for (const invalid of ["", "http://example.com", origin + "/path", origin + "/", origin + "/?next=evil", "https://name@rooms.example.com"]) {
    assert.equal(releasePage(invalid, release.version), null);
  }
  assert.equal(releasePage("http://127.0.0.1:8080", release.version), "http://127.0.0.1:8080/#/downloads");
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
    valid.replace(encodeURIComponent(origin), encodeURIComponent("https://ROOMS.example.com")),
    valid + "\n",
  ]) assert.equal(parseShareLink(invalid, normalize), null);
  assert.equal(shareLinkFromArguments([valid, valid], normalize), null);
});

test("desktop handoff forwards only explicit guest and live flags in a canonical order", () => {
  const origin = "https://rooms.example.com";
  const allow = value => value === origin ? origin : null;
  const prefix = "zelotez-rooms://share/youtube/M7lc1UVf-VE?";
  const fragment = "#/share/youtube/M7lc1UVf-VE";
  const instance = "instance=" + encodeURIComponent(origin);
  const valid = prefix + instance;
  assert.deepEqual(parseShareLink(valid + "&guests=0", allow), { origin, fragment: fragment + "?guests=0" });
  assert.deepEqual(parseShareLink(valid + "&live=1", allow), { origin, fragment: fragment + "?live=1" });
  assert.deepEqual(shareLinkFromArguments(["rooms", prefix + "live=0&" + instance + "&guests=1"], allow),
    { origin, fragment: fragment + "?guests=1&live=0" });

  for (const suffix of [
    "&guests=0&guests=0", "&live=1&live=0", "&visibility=1", "&guests=false", "&live=2",
    "&guests=%30", "&g%75ests=0", "&live=", "&guests=1=0", "&guests=1&", "&live=0#elsewhere",
  ]) assert.equal(parseShareLink(valid + suffix, allow), null);
  assert.equal(parseShareLink(prefix + "guests=0&live=1", allow), null);
});

test("desktop handoff accepts one lowercase hexadecimal receipt ID and keeps it out of the renderer route", () => {
  const allow = value => value === origin ? origin : null;
  const valid = "zelotez-rooms://share/youtube/M7lc1UVf-VE?instance=" + encodeURIComponent(origin);
  const handoffId = "0123456789abcdef0123456789abcdef";
  const receipt = "&handoff=" + handoffId;
  assert.deepEqual(parseShareLink(valid + "&live=0" + receipt + "&guests=1", allow),
    { origin, fragment: "#/share/youtube/M7lc1UVf-VE?guests=1&live=0", handoffId });
  assert.deepEqual(shareLinkFromArguments(["rooms", valid + receipt], allow),
    { origin, fragment: "#/share/youtube/M7lc1UVf-VE", handoffId });
  for (const invalid of [
    receipt + receipt, receipt + "&other=1", receipt + "=1", receipt.slice(0, -1), receipt + "0",
    "&handoff=", "&handoff=" + handoffId.toUpperCase(), "&handoff=%30" + handoffId.slice(1), "&h%61ndoff=" + handoffId,
  ]) assert.equal(parseShareLink(valid + invalid, allow), null);
});
