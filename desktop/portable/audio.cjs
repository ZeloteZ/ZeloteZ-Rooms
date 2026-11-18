"use strict";

const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { ipcMain } = require("electron");
const { createWindowsAudio } = require("./windows-audio.cjs");

const run = promisify(execFile);
const sessions = new Map();
const modes = { application: "Stream/Output/Audio", system: "Audio/Sink" };
const token = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const windowsAudio = createWindowsAudio();

async function outputs(mode) {
  const { stdout } = await run("pw-dump", [], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 });
  const result = [];
  for (const entry of JSON.parse(stdout)) {
    const props = entry.info?.props;
    if (entry.type !== "PipeWire:Interface:Node" || props?.["media.class"] !== modes[mode]) continue;
    const serial = String(props["object.serial"] ?? "");
    if (!/^[1-9][0-9]{0,19}$/u.test(serial)) continue;
    const node = props["node.name"];
    const pid = props["application.process.id"];
    const name = props["application.name"] ?? props["application.process.binary"];
    const label = mode === "system" ? props["node.description"] ?? props["node.nick"] ?? node : name;
    if (typeof label !== "string" || !label.trim() || (mode === "application" && !/^\d+$/u.test(pid))) continue;
    const media = mode === "application" && props["media.name"] !== label ? props["media.name"] : "";
    const title = (media ? label + " · " + media : label).trim().replace(/\s+/gu, " ").slice(0, 120);
    const identity = JSON.stringify([node, pid, props["application.id"], props["application.process.binary"], props["device.id"]]);
    result.push({ title, serial, identity });
  }
  return result.sort((left, right) => left.title.localeCompare(right.title));
}

function dispose(session) {
  const recording = session.recording;
  session.recording = null;
  if (!recording) return;
  if (recording.picker && !recording.picker.isDestroyed()) recording.picker.close();
  recording.child?.kill();
  recording.finish?.("cancelled");
}

function requestSession(event) {
  const session = sessions.get(event.sender.id);
  const frame = event.senderFrame;
  if (!session || !frame || frame.detached || frame !== event.sender.mainFrame || !session.allowed(frame.url)) return null;
  return { session, frame };
}

const linuxAudio = {
  modes: ["application", "system"],
  error: "pipewire",
  outputs,
  record(mode, selected) {
    return spawn("pw-record", [
      "--raw", "--format", "s16", "--channels", "2", "--rate", "48000", "--latency", "20ms", "--target", selected.serial,
      "--properties", JSON.stringify({
        "node.dont-fallback": true, "node.dont-move": true, "node.dont-reconnect": true, "stream.restore-target": false,
        "stream.capture.sink": mode === "system",
      }), "-",
    ], { stdio: ["ignore", "pipe", "ignore"] });
  },
};

function recordAudio(session, recording, frame, mode, selected) {
  return new Promise(resolve => {
    let pending = true;
    let partial = Buffer.alloc(0);
    let timer;
    recording.finish = result => {
      if (!pending) return;
      pending = false;
      clearTimeout(timer);
      resolve(result);
    };
    const child = session.backend.record(mode, selected);
    recording.child = child;
    function send(channel, ...payload) {
      if (frame.detached || !session.allowed(frame.url)) return false;
      try {
        frame.send(channel, recording.id, ...payload);
        return true;
      } catch {
        return false;
      }
    }
    function end(reason) {
      if (session.recording !== recording) return;
      if (!pending) send("rooms:audio-ended");
      recording.finish(reason);
      dispose(session);
    }
    timer = setTimeout(() => end("unavailable"), 4500);
    child.once("error", () => end(session.backend.error));
    child.once("close", () => end("unavailable"));
    child.stdout.on("data", packet => {
      if (session.recording !== recording) return;
      if (frame.detached || !session.allowed(frame.url)) {
        dispose(session);
        return;
      }
      const data = partial.length ? Buffer.concat([partial, packet]) : packet;
      const usable = data.length - (data.length % 4);
      partial = data.subarray(usable);
      if (!usable) return;
      if (send("rooms:audio-data", Uint8Array.from(data.subarray(0, usable)))) recording.finish("ok");
      else dispose(session);
    });
  });
}

ipcMain.handle("rooms:audio-open", async (event, id, mode) => {
  const request = requestSession(event);
  if (!request || typeof id !== "string" || id.length !== 36 || !token.test(id) || typeof mode !== "string" || !request.session.backend.modes.includes(mode)) {
    return "unavailable";
  }
  const { session, frame } = request;
  if (session.recording) return "unavailable";
  const selection = session.selection;
  if (selection) {
    if (performance.now() >= selection.expiresAt) {
      session.selection = null;
      return "unavailable";
    }
    if (selection.frame !== frame || selection.id !== id || selection.mode !== mode) return "unavailable";
    session.selection = null;
  } else if (Date.now() >= session.approvedUntil) return "unavailable";
  session.approvedUntil = 0;
  const recording = { id };
  session.recording = recording;
  const current = () => session.recording === recording && requestSession(event)?.frame === frame;
  try {
    let selected = selection?.source;
    if (!selected) {
      const choices = await session.backend.outputs(mode);
      if (!current()) return "cancelled";
      if (!choices.length) return "empty";
      const picker = session.choose(mode, choices);
      recording.picker = picker.window;
      selected = await picker.result;
    }
    if (!current() || !selected) return "cancelled";
    const fresh = (await session.backend.outputs(mode)).some(candidate =>
      candidate.serial === selected.serial && candidate.identity === selected.identity);
    if (!current()) return "cancelled";
    if (!fresh) return "unavailable";
    return await recordAudio(session, recording, frame, mode, selected);
  } catch {
    return session.backend.error;
  } finally {
    if (session.recording === recording && !recording.child) dispose(session);
  }
});

ipcMain.handle("rooms:audio-close", (event, id) => {
  const request = requestSession(event);
  if (!request) return;
  if (request.session.selection?.id === id) request.session.selection = null;
  if (request.session.recording?.id === id) dispose(request.session);
});

function installAudio(web, allowed, choose) {
  const id = web.id;
  const backend = process.platform === "linux" ? linuxAudio : windowsAudio;
  const session = { allowed, choose, backend, approvedUntil: 0, selection: null, recording: null };
  if (backend) sessions.set(id, session);
  function clear() {
    session.approvedUntil = 0;
    session.selection = null;
  }
  function revoke() {
    clear();
    dispose(session);
  }
  web.on("did-start-navigation", details => {
    if (details.isMainFrame && !details.isSameDocument) revoke();
  });
  web.on("render-process-gone", revoke);
  web.once("destroyed", () => {
    clear();
    dispose(session);
    sessions.delete(id);
  });
  return {
    modes: Object.freeze([...(backend?.modes ?? [])]),
    outputs: mode => backend?.modes.includes(mode) ? backend.outputs(mode) : Promise.resolve([]),
    approve() {
      clear();
      session.approvedUntil = Date.now() + 180_000;
    },
    select(frame, id, mode, source) {
      clear();
      if (session.recording || !frame || frame.detached || frame !== web.mainFrame || !allowed(frame.url) ||
          typeof id !== "string" || id.length !== 36 || !token.test(id)) return false;
      if (mode === "none") return true;
      if (!backend?.modes.includes(mode) || typeof source?.serial !== "string" || !source.serial || source.serial.length > 1024 ||
          typeof source.identity !== "string" || !source.identity || source.identity.length > 1024 ||
          /[\p{Cc}\p{Cf}\p{Cs}]/u.test(source.serial + source.identity)) return false;
      session.selection = { frame, id, mode, source: { serial: source.serial, identity: source.identity },
        expiresAt: performance.now() + 30_000 };
      return true;
    },
    clear,
    revoke,
  };
}

function audioArguments() {
  if (!windowsAudio) return [];
  return ["--rooms-windows-audio", ...(windowsAudio.modes.includes("application") ? ["--rooms-windows-application-audio"] : [])];
}

module.exports = { installAudio, audioArguments };
