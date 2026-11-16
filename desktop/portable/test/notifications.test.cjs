"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

class NativeToast extends EventEmitter {
  static shown = [];
  static supported = true;
  static isSupported() { return this.supported; }
  constructor(options) { super(); this.options = options; }
  show() { NativeToast.shown.push(this); }
  close() { this.closed = true; }
}

const moduleShim = { exports: {} };
const source = path.resolve(__dirname, "../desktop-notifications.cjs");
runInNewContext(readFileSync(source, "utf8"), {
  module: moduleShim, setTimeout, clearTimeout, require: name => {
    assert.equal(name, "electron");
    return { Notification: NativeToast };
  },
}, { filename: source });
const { desktopNotifications, notificationPayload } = moduleShim.exports;

const id = "1a234567-1234-1234-1234-123456789abc";
const stream = "d".repeat(32);
const payload = (kind, href) => ({ id, kind, title: "ZeloteZ Rooms", body: "Activity", href });

test("native notification destinations cover Friends, direct messages, rooms and streams", () => {
  for (const [kind, href] of [
    ["friend-request", "#/friends"],
    ["direct-message", `#/direct/${id}?message=${id}`],
    ["mention", `#/rooms/${id}/${id}?message=${id}&stream=${stream}`],
    ["live", `#/rooms/${id}/${id}?stream=${stream}`],
  ]) assert.equal(notificationPayload(payload(kind, href))?.href, href);
});

test("native notifications reject external links, ambiguous routes and unbounded input", () => {
  for (const href of [
    "https://example.invalid/", "//example.invalid/", "#//example.invalid/", "#/friends",
    `#/rooms/${id}/${id}?next=https://example.invalid/`,
    `#/rooms/${id}/${id}?message=${id}&message=${id}`,
    `#/rooms/${id}/${id}?stream=${id}`,
    `#/direct/${id}?stream=${stream}`,
  ]) assert.equal(notificationPayload(payload("mention", href)), null, href);
  assert.equal(notificationPayload({ ...payload("friend-request", "#/friends"), body: "x".repeat(361) }), null);
  assert.equal(notificationPayload({ ...payload("friend-request", "#/friends"), title: "\u202e\u0000" }), null);
});

test("native delivery deduplicates and bounds bursts, and clicks receive only the checked route", () => {
  const native = desktopNotifications("icon.png");
  const friend = payload("friend-request", "#/friends");
  const opened = [];
  try {
    assert(native.show(friend, href => opened.push(href)));
    assert(!native.show(friend, href => opened.push(href)));
    for (let i = 0; i < 4; i++) assert(native.show({ ...friend, id: String(i) }, href => opened.push(href)));
    assert(!native.show({ ...friend, id: "burst" }, href => opened.push(href)));
    assert.equal(NativeToast.shown.length, 5);
    NativeToast.shown[0].emit("click");
    NativeToast.shown[0].emit("click");
    assert.deepEqual(opened, ["#/friends"]);
    native.clear();
    assert(NativeToast.shown.slice(1).every(toast => toast.closed));
    NativeToast.supported = false;
    assert(!native.show(friend, href => opened.push(href)));
  } finally {
    native.clear();
    NativeToast.supported = true;
    NativeToast.shown.length = 0;
  }
});
