"use strict";

const { execFile, spawn } = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");
const { app, ipcMain } = require("electron");

const run = promisify(execFile);
const channels = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const streams = /^[a-f0-9]{32}$/u;
const previewFrameLimit = 128 * 1024;
const sessions = new Map();
const childEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };

async function nativeHelper() {
  if (process.platform !== "linux") return null;
  const script = app.isPackaged ? path.join(process.resourcesPath, "native-capture", "capture_helper.py")
    : path.join(__dirname, "..", "capture_helper.py");
  const probe = flag => run("python3", ["-u", script, flag], { env: childEnv, timeout: 4500, maxBuffer: 4096 })
    .then(({ stdout }) => stdout.trim() === "ok", () => false);
  const [available, embedded] = await Promise.all([probe("--probe"), probe("--probe-embedded")]);
  return available ? { script, embedded } : null;
}

function senderSession(event) {
  const state = sessions.get(event.sender.id);
  const frame = event.senderFrame;
  return state && frame && !frame.detached && frame === event.sender.mainFrame && state.allowed(frame.url) ? state : null;
}

function request(state, resource, method, language) {
  return state.media.fetch(state.origin + resource, {
    method, body: "{}", cache: "no-store", redirect: "error", credentials: "include",
    headers: { "Origin": state.origin, "Content-Type": "application/json", "Accept-Language": language },
    signal: AbortSignal.timeout(12000),
  });
}

function release(state, id, language) {
  return request(state, "/api/streams/" + id, "DELETE", language).catch(() => {});
}

function send(task, message) {
  if (!task.ended && task.child.stdin.writable) task.child.stdin.write(JSON.stringify(message) + "\n");
}

function toPage(state, channel, ...values) {
  if (state.web.isDestroyed()) return;
  const frame = state.web.mainFrame;
  if (!frame || frame.detached || !state.allowed(frame.url)) return;
  try { frame.send(channel, ...values); } catch { /* A closing renderer cannot receive it. */ }
}

function broadcastStatus(state) {
  const task = state.task;
  if (!task?.embedded || task.ended || !task.live || !task.id) return null;
  return { channelId: task.channel, streamId: task.id, startedAt: task.live, ...task.stats };
}

function notifyStatus(state) {
  toPage(state, "rooms:native-capture-status", broadcastStatus(state));
}

function readPreview(state, task) {
  const pipe = task.child.stdio[3];
  let buffer = Buffer.alloc(0);
  pipe.on("error", () => {});
  pipe.on("data", chunk => {
    if (task.ended) return;
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (length < 4 || length > previewFrameLimit) {
        pipe.destroy();
        return;
      }
      if (buffer.length < length + 4) return;
      const frame = buffer.subarray(4, length + 4);
      buffer = buffer.subarray(length + 4);
      if (task.live && task.id && frame[0] === 0xff && frame[1] === 0xd8) {
        toPage(state, "rooms:native-capture-preview", task.id, Uint8Array.from(frame));
      }
    }
  });
}

function close(state, task = state.task) {
  if (!task || task.ended) return;
  task.ended = true;
  if (task.embedded) notifyStatus(state);
  clearTimeout(task.startTimer);
  task.start("unavailable");
  const released = task.id ? release(state, task.id, task.language) : undefined;
  if (task.child.stdin.writable) task.child.stdin.end('{"action":"close"}\n');
  const timer = setTimeout(() => task.child.kill(), 3000);
  timer.unref();
  task.child.once("close", () => clearTimeout(timer));
  return released;
}

async function reserve(state, task, requestId) {
  const unavailable = () => send(task, { action: "reservation", requestId, error: task.language === "de"
    ? "Der Live-Kanal konnte den Stream nicht vorbereiten." : "The live channel couldn’t prepare the stream." });
  let id;
  try {
    const response = await request(state, "/api/channels/" + task.channel + "/streams", "POST", task.language);
    const result = await response.json();
    if (!response.ok) {
      if (typeof result?.error === "string") send(task, { action: "reservation", requestId, error: result.error.slice(0, 240) });
      else unavailable();
      return;
    }
    id = result?.stream?.id;
    if (typeof id !== "string" || !streams.test(id)) id = null;
    if (!id || typeof result.address !== "string" || typeof result.key !== "string" ||
        result.address.length > 500 || result.key.length > 200) {
      unavailable();
      if (id) release(state, id, task.language);
      return;
    }
    if (task.ended) {
      release(state, id, task.language);
      return;
    }
    task.id = id;
    send(task, { action: "reservation", requestId, data: { stream: { id }, address: result.address, key: result.key } });
  } catch {
    unavailable();
  } finally {
    task.reserving = false;
  }
}

function startCapture(state, channel, language, embedded) {
  let finishStarting;
  const started = new Promise(resolve => { finishStarting = resolve; });
  const args = ["-u", state.program.script, state.origin, language];
  if (embedded) args.push("--preview-fd", "3");
  const child = spawn("python3", args, { env: childEnv, stdio: embedded ? ["pipe", "pipe", "ignore", "pipe"] : ["pipe", "pipe", "ignore"] });
  const task = { channel, language, child, start: finishStarting, id: null, ended: false, reserving: false, embedded };
  task.startTimer = setTimeout(() => close(state, task), 8000);
  state.task = task;
  if (embedded) readPreview(state, task);
  child.stdin.on("error", () => close(state, task));
  child.once("error", () => close(state, task));
  child.once("close", () => {
    if (state.task === task) {
      state.task = null;
      if (task.embedded) notifyStatus(state);
    }
    if (!task.ended) {
      task.ended = true;
      clearTimeout(task.startTimer);
      task.start("unavailable");
      if (task.id) release(state, task.id, language);
    }
  });
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    if (buffer.length > 16384) {
      close(state, task);
      return;
    }
    for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
      let message;
      try { message = JSON.parse(buffer.slice(0, end)); } catch { /* Ignore a non-protocol line. */ }
      buffer = buffer.slice(end + 1);
      if (task.ended || !message) continue;
      if (message.action === "ready") {
        clearTimeout(task.startTimer);
        task.start("opened");
      } else if (message.action === "reserve" && Number.isSafeInteger(message.requestId) && !task.reserving && !task.id) {
        task.reserving = true;
        reserve(state, task, message.requestId);
      } else if (task.embedded && message.action === "live" && task.id && message.streamId === task.id) {
        task.live = Date.now();
        notifyStatus(state);
      } else if (task.embedded && task.live && message.action === "stats" && message.streamId === task.id) {
        const { width, height, fps, mbps, elapsed } = message;
        if ([width, height, fps, mbps, elapsed].every(value => Number.isFinite(value) && value >= 0)) {
          task.stats = { width, height, fps, mbps, elapsed };
          notifyStatus(state);
        }
      } else if (message.action === "finish" && typeof task.id === "string" && message.streamId === task.id) {
        release(state, task.id, language);
        task.id = null;
        task.live = null;
        task.stats = null;
        if (task.embedded) notifyStatus(state);
      }
    }
  });
  return started;
}

ipcMain.handle("rooms:native-capture-open", (event, channel, language, embedded) => {
  const state = senderSession(event);
  if (!state || typeof channel !== "string" || !channels.test(channel)) return "unavailable";
  if (state.task) return "busy";
  return startCapture(state, channel, language === "de" ? "de" : "en", embedded === true && state.program.embedded);
});

ipcMain.handle("rooms:native-capture-status", event => {
  const state = senderSession(event);
  return state ? broadcastStatus(state) : null;
});

ipcMain.handle("rooms:native-capture-close", event => {
  const state = senderSession(event);
  return state ? close(state)?.then(() => undefined) : undefined;
});

app.on("before-quit", () => {
  for (const state of sessions.values()) close(state);
});

function installNativeCapture(web, program, origin, media, allowed) {
  if (!program) return;
  const id = web.id;
  const state = { web, origin, media, program, allowed, task: null };
  sessions.set(id, state);
  web.on("did-start-navigation", details => {
    if (details.isMainFrame && !details.isSameDocument) close(state);
  });
  web.on("render-process-gone", () => close(state));
  web.once("destroyed", () => {
    close(state);
    sessions.delete(id);
  });
}

module.exports = { nativeHelper, installNativeCapture };
