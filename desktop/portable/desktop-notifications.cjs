"use strict";

const { Notification } = require("electron");

const uuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const direct = new RegExp(`^#/direct/${uuid}$`, "u");
const room = new RegExp(`^#/rooms/${uuid}/${uuid}$`, "u");
const identifier = new RegExp(`^${uuid}$`, "u");
const stream = /^[0-9a-f]{32}$/u;
const allowedKinds = new Set(["mention", "friend-request", "direct-message", "live"]);

function destination(value, kind) {
  if (typeof value !== "string" || value.length > 240) return "";
  if (kind === "friend-request") return value === "#/friends" ? value : "";
  const [route, query, extra] = value.split("?");
  if (extra !== undefined) return "";
  const isDirect = direct.test(route);
  if ((kind === "direct-message" && !isDirect) || (kind === "live" && isDirect) || (!isDirect && !room.test(route))) return "";
  if (query === undefined) return value;
  const keys = new Set();
  for (const term of query.split("&")) {
    const [key, id, surplus] = term.split("=");
    const valid = key === "message" ? identifier.test(id ?? "") : key === "stream" && !isDirect && stream.test(id ?? "");
    if (surplus !== undefined || keys.has(key) || !valid) return "";
    keys.add(key);
  }
  return value;
}

function notificationPayload(input) {
  if (!input || !allowedKinds.has(input.kind) || typeof input.id !== "string" || !/^[a-z0-9:_-]{1,128}$/iu.test(input.id)) return null;
  if (typeof input.title !== "string" || typeof input.body !== "string" || input.title.length > 180 || input.body.length > 360) return null;
  const href = destination(input.href, input.kind);
  const tidy = value => value.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, " ").trim();
  const title = tidy(input.title);
  if (!href || !title) return null;
  return { id: `${input.kind}:${input.id}`, title, body: tidy(input.body), href };
}

function desktopNotifications(icon) {
  const active = new Set();
  const shown = new Map();
  let recent = [];
  const maximumAge = 10 * 60 * 1000;

  function show(payload, click) {
    if (!Notification.isSupported()) return false;
    const data = notificationPayload(payload);
    if (!data) return false;
    const now = Date.now();
    for (const [id, time] of shown) if (time < now - maximumAge) shown.delete(id);
    recent = recent.filter(time => time >= now - 15000);
    if (shown.has(data.id) || recent.length >= 5) return false;
    try {
      const toast = new Notification({ title: data.title, body: data.body, icon });
      const item = { close: () => { toast.close(); release(); } };
      const timer = setTimeout(item.close, maximumAge);
      timer.unref();
      function release() {
        clearTimeout(timer);
        active.delete(item);
      }
      toast.once("click", () => { release(); click(data.href); });
      // Windows can dismiss a toast visually while it remains in Action Center.
      toast.once("failed", release);
      active.add(item);
      try { toast.show(); } catch (error) { release(); throw error; }
      shown.set(data.id, now);
      if (shown.size > 512) shown.delete(shown.keys().next().value);
      recent.push(now);
      return true;
    } catch {
      return false;
    }
  }

  function clear() {
    for (const item of active) item.close();
    shown.clear();
    recent = [];
  }

  return { show, clear };
}

module.exports = { desktopNotifications, notificationPayload };
