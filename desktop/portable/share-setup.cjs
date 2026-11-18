"use strict";

const { ipcMain, desktopCapturer } = require("electron");
const { randomUUID } = require("node:crypto");

const sessions = new Map();
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const resolutions = [720, 1080, 1440];
const frameRates = [30, 60];

function current(event, id) {
  const state = sessions.get(event.sender.id);
  const setup = state?.setup;
  const frame = event.senderFrame;
  if (!setup || setup.id !== id || setup.frame !== frame || !state.valid(frame)) return null;
  return { state, setup };
}

function clear(state) {
  const setup = state.setup;
  const owner = state.owner;
  state.owner = null;
  state.setup = null;
  state.issued = null;
  owner?.close();
  if (owner) state.audio.revoke();
  else state.audio.clear();
  if (!setup) return;
  clearTimeout(setup.timer);
  try { setup.grant?.(null); } catch { /* Chromium can discard the request when a frame closes. */ }
  if (setup.local && !setup.local.window.isDestroyed()) setup.local.window.close();
}

function timeout(state, setup, milliseconds) {
  clearTimeout(setup.timer);
  setup.timer = setTimeout(() => { if (state.setup === setup) clear(state); }, milliseconds);
  setup.timer.unref();
}

ipcMain.handle("rooms:share-arm", (event, id, language) => {
  const state = sessions.get(event.sender.id);
  const frame = event.senderFrame;
  if (!state?.valid(frame) || typeof id !== "string" || id.length !== 36 || !uuid.test(id)) return false;
  if (state.setup && !["armed", "ready"].includes(state.setup.phase)) return false;
  clear(state);
  const setup = { id, frame, language: ["de", "zh-CN"].includes(language) ? language : "en", phase: "armed" };
  state.setup = setup;
  timeout(state, setup, 6000);
  return true;
});

function consume(state, setup) {
  if (state.setup !== setup || !state.valid(setup.frame) || setup.phase !== "ready") return null;
  clearTimeout(setup.timer);
  state.setup = null;
  const { options, audioSource } = setup.result;
  if (!state.audio.select(setup.frame, setup.id, options.audio, audioSource)) return null;
  state.issued = { id: setup.id, frame: setup.frame };
  return options;
}

ipcMain.handle("rooms:share-take", (event, id) => {
  const request = current(event, id);
  if (!request) return null;
  const { state, setup } = request;
  return consume(state, setup);
});

// Old desktop versions used a snapshot supplied by the remote page. The new
// capture owner is authoritative; a remote renderer can no longer supply it.
ipcMain.handle("rooms:share-preview", () => null);

ipcMain.handle("rooms:share-cancel", (event, id) => {
  const request = current(event, id);
  if (request) {
    clear(request.state);
    return;
  }
  const state = sessions.get(event.sender.id);
  const frame = event.senderFrame;
  if (state?.issued?.id === id && state.issued.frame === frame && state.valid(frame)) clear(state);
});

function thumbnail(source) {
  if (source.thumbnail.isEmpty()) return null;
  const data = source.thumbnail.toJPEG(72);
  return data.length <= 160_000 ? "data:image/jpeg;base64," + data.toString("base64") : null;
}

function sourceName(name) {
  return String(name ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 180);
}

async function videoSources(state, setup) {
  if (!state.open(setup) || setup.phase !== "configuring" || setup.loadingVideo) return { status: "unavailable", sources: [] };
  setup.loadingVideo = true;
  setup.video = null;
  try {
    const entries = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: state.portal ? { width: 0, height: 0 } : { width: 440, height: 248 },
    });
    if (!state.open(setup)) return { status: "unavailable", sources: [] };
    const ownWindow = setup.local.window.getMediaSourceId();
    setup.video = entries.filter(source => source.id !== ownWindow).slice(0, 80);
    return { status: setup.video.length ? "ok" : "empty", sources: setup.video.map(source => ({
      name: sourceName(source.name), kind: source.id.startsWith("screen:") ? "screen" : "window", thumbnail: thumbnail(source),
    })) };
  } catch {
    return { status: "unavailable", sources: [] };
  } finally {
    setup.loadingVideo = false;
  }
}

async function audioSources(state, setup, mode) {
  if (!state.open(setup) || !state.audio.modes.includes(mode)) return { status: "unavailable", sources: [] };
  const chosen = setup.audio = { mode, sources: null };
  try {
    const entries = await state.audio.outputs(mode);
    if (!state.open(setup) || setup.audio !== chosen) return { status: "unavailable", sources: [] };
    chosen.sources = entries.slice(0, 256);
    return { status: chosen.sources.length ? "ok" : "empty",
      sources: chosen.sources.map(source => ({ name: sourceName(source.title) })) };
  } catch {
    return { status: "unavailable", sources: [] };
  }
}

function regionOptions(value, dimensions) {
  if (!value || typeof value !== "object" || !dimensions) return null;
  const { x, y, width, height } = value;
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || x >= 1 || y >= 1 || width <= 0 || height <= 0
      || x + width > 1.000001 || y + height > 1.000001) return null;
  return { x, y, width: Math.min(1 - x, width), height: Math.min(1 - y, height), ...dimensions };
}

function setVideo(state, setup, selected) {
  const grant = setup.grant;
  setup.grant = null;
  try {
    grant?.({ video: selected });
    return true;
  } catch {
    clear(state);
    return false;
  }
}

function captureOwner(state, setup, video) {
  if (!state.owner) {
    const owner = state.createOwner({ source: video,
      valid: () => (state.setup === setup || state.issued?.id === setup.id) && state.valid(setup.frame),
      onEnded: () => { if (state.owner === owner) clear(state); } });
    state.owner = owner;
  }
  return state.owner;
}

async function submit(state, setup, input) {
  if (!state.open(setup) || !input || typeof input !== "object" || !Number.isInteger(input.source)) return false;
  const video = setup.video?.[input.source];
  if (!video || (setup.selectedVideo && setup.selectedVideo !== video)
      || !resolutions.includes(input.height) || !frameRates.includes(input.fps)) return false;
  if (!["configuring", "cropping"].includes(setup.phase)) return false;

  if (input.region === true && setup.phase === "configuring") {
    setup.selectedVideo = video;
    setup.phase = "preparing-preview";
    timeout(state, setup, 12_000);
    try {
      const preview = await captureOwner(state, setup, video).snapshot();
      if (!state.open(setup)) return false;
      setup.dimensions = { aspect: preview.aspect, sourceWidth: preview.width, sourceHeight: preview.height };
      setup.phase = "cropping";
      timeout(state, setup, 180_000);
      setup.local.contents.send("rooms:local-share-preview", { thumbnail: preview.thumbnail });
      return "preview";
    } catch { clear(state); return false; }
  }

  const region = regionOptions(input.region, setup.dimensions);
  if (input.region !== null && !region) return false;
  const { audioMode, audioSource } = input;
  if (setup.legacy && audioMode !== "none") return false;
  const selectedAudio = audioMode !== "none" && setup.audio?.mode === audioMode && Number.isInteger(audioSource)
    ? setup.audio.sources?.[audioSource] : undefined;
  if (audioMode === "none" ? audioSource !== null : !state.audio.modes.includes(audioMode) || !selectedAudio) return false;
  setup.result = {
    // The remote page receives only already-transformed output, never the raw
    // source or a crop that it is responsible for enforcing.
    options: { height: input.height, fps: input.fps, region: null, audio: audioMode },
    audioSource: selectedAudio,
  };
  setup.phase = "preparing-output";
  timeout(state, setup, 12_000);
  try {
    const owner = captureOwner(state, setup, video);
    const frame = await owner.configure({ height: input.height, fps: input.fps, region });
    if (!state.open(setup)) return false;
    setup.phase = "ready";
    timeout(state, setup, 30_000);
    if (!setVideo(state, setup, frame)) return false;
    owner.delivered();
    if (setup.legacy) {
      clearTimeout(setup.timer);
      state.setup = null;
      state.issued = { id: setup.id, frame: setup.frame };
      state.audio.approve();
    }
    setup.local.window.close();
    return true;
  } catch { clear(state); return false; }
}

function installShareSetup(web, { allowed, audio, portal, showDialog, createOwner, defaultLanguage = () => "en" }) {
  const state = {
    setup: null, issued: null, owner: null, audio, portal, createOwner,
    valid: frame => Boolean(frame && !frame.detached && frame === web.mainFrame && allowed(frame.url)),
    open: setup => state.setup === setup && setup.local && !setup.local.window.isDestroyed() && state.valid(setup.frame),
  };
  sessions.set(web.id, state);
  const revoke = () => clear(state);
  web.on("did-start-navigation", details => { if (details.isMainFrame && !details.isSameDocument) revoke(); });
  web.on("render-process-gone", revoke);
  web.once("destroyed", () => { revoke(); sessions.delete(web.id); });

  return (frame, callback) => {
    if (!state.valid(frame)) return null;
    let setup = state.setup;
    if (!setup) {
      clear(state);
      setup = state.setup = { id: randomUUID(), frame, language: defaultLanguage(), phase: "armed", legacy: true };
    }
    if (setup.phase !== "armed" || setup.frame !== frame) return null;
    setup.phase = "configuring";
    setup.grant = callback;
    timeout(state, setup, 300_000);
    return new Promise(resolve => {
      const local = setup.local = showDialog({ language: setup.language, portal,
        audioModes: setup.legacy ? [] : audio.modes, ...(setup.legacy ? { legacyAudio: true } : {}) });
      local.share = {
        sources: () => videoSources(state, setup),
        audio: mode => audioSources(state, setup, mode),
        submit: input => submit(state, setup, input),
      };
      local.window.once("closed", () => {
        if (state.setup === setup && setup.phase !== "ready") clear(state);
        resolve();
      });
    }).catch(() => clear(state));
  };
}

module.exports = { installShareSetup };
