"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { findUpdate, latestReleasePage, releasePage } = require("../release-updates.cjs");
const { parseShareLink, shareLinkFromArguments } = require("../share-link.cjs");

const origin = "https://rooms.example.com";
const releaseRequest = { origin, installed: "0.1.9", platform: "linux", arch: "x64" };
const release = { tag_name: "v0.1.15", draft: false, prerelease: false,
  assets: [{ name: "ZeloteZ-Rooms-0.1.15-x86_64.AppImage", state: "uploaded" }] };

test("desktop update checks use the official GitHub API without credentials and validate stable versions", async () => {
  const find = (data, changes = {}) => findUpdate({ ...releaseRequest, ...changes, async fetchRelease(url, init) {
    assert.equal(url, "https://api.github.com/repos/ZeloteZ/ZeloteZ-Rooms/releases/latest");
    assert.equal(init.method, "GET");
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.deepEqual(init.headers, { Accept: "application/vnd.github+json" });
    return Response.json(data);
  } });
  assert.deepEqual(await find({ ...release, html_url: "https://example.net/update" }, { origin: "https://malicious-instance.example" }),
    { status: "available", version: "0.1.15", installer: true });
  assert.deepEqual(await find(release, { platform: "win32" }), { status: "available", version: "0.1.15", installer: false });
  assert.deepEqual(await find(release, { installed: "0.1.15" }), { status: "current" });
  assert.deepEqual(await find(release, { installed: "0.1.16" }), { status: "current" });
  for (const invalid of [
    null, { ...release, tag_name: "v0.1.15-rc.1" }, { ...release, tag_name: "0.1.15" },
    { ...release, tag_name: "v../other" }, { ...release, tag_name: "v0.1.15\n" },
    { ...release, draft: true }, { ...release, prerelease: true }, { ...release, assets: {} },
  ]) assert.deepEqual(await find(invalid), { status: "unavailable" });
  assert.deepEqual(await findUpdate({ ...releaseRequest, fetchRelease: () => Response.redirect("https://example.net") }),
    { status: "unavailable" });
  assert.deepEqual(await findUpdate({ ...releaseRequest, fetchRelease: () => new Response(null, { status: 404 }) }),
    { status: "unavailable" });
  assert.equal(latestReleasePage, "https://github.com/ZeloteZ/ZeloteZ-Rooms/releases/latest");
  assert.equal(releasePage("0.1.15"), "https://github.com/ZeloteZ/ZeloteZ-Rooms/releases/tag/v0.1.15");
  assert.equal(releasePage("../example"), null);
});

test("Windows x64 and Linux x64 recognize exact uploaded release assets", async () => {
  const data = { ...release, assets: [...release.assets, { name: "ZeloteZ-Rooms-0.1.15-x64.exe", state: "uploaded" }] };
  for (const [platform, arch, installer] of [
    ["win32", "x64", true], ["linux", "x64", true], ["win32", "arm64", false], ["darwin", "x64", false],
  ]) {
    assert.deepEqual(await findUpdate({ ...releaseRequest, platform, arch, fetchRelease: () => Response.json(data) }),
      { status: "available", version: "0.1.15", installer });
  }
  const incomplete = { ...release, assets: [
    null, { name: "ZeloteZ-Rooms-0.1.14-x86_64.AppImage", state: "uploaded" },
    { ...release.assets[0], state: "starter" },
  ] };
  assert.deepEqual(await findUpdate({ ...releaseRequest, fetchRelease: () => Response.json(incomplete) }),
    { status: "available", version: "0.1.15", installer: false });
});

test("desktop update checks bound the GitHub response and respect cancellation", async () => {
  assert.deepEqual(await findUpdate({ ...releaseRequest,
    fetchRelease: () => Response.json({ ...release, body: "a".repeat(256 * 1024) }) }),
    { status: "unavailable" });
  assert.deepEqual(await findUpdate({ ...releaseRequest, fetchRelease: () => new Response(JSON.stringify(release)) }),
    { status: "unavailable" });
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await findUpdate({ ...releaseRequest, signal: controller.signal, fetchRelease: (_url, init) => {
    init.signal.throwIfAborted();
    return Response.json(release);
  } }), { status: "cancelled" });
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
