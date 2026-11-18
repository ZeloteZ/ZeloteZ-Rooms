import { t } from "./i18n.js";

export const VAULT_MEDIA_TRACK_LIMITS = Object.freeze({ inputBytes: 10 * 1024 ** 3, milliseconds: 15000, tracks: 64, cues: 20000, textBytes: 2 * 1024 ** 2 });
const subtitleHandles = new WeakMap();
const unavailable = () => new Error(t("Track selection is unavailable for this media container. Playback can still use the device’s default tracks.",
  "Die Spurauswahl ist für diesen Mediencontainer nicht verfügbar. Die Wiedergabe kann weiterhin die Standardspuren des Geräts verwenden."));
const aborted = () => new DOMException("Cancelled", "AbortError");
function wipeParsedResult(result) {
  if (!result || typeof result !== "object") return;
  for (const track of Array.isArray(result.subtitles) ? result.subtitles : []) {
    if (Array.isArray(track?.cues)) {
      for (const cue of track.cues) if (cue && typeof cue === "object") cue.text = "";
      track.cues.length = 0;
    }
    if (track && typeof track === "object") { track.label = ""; track.language = ""; }
  }
  for (const track of Array.isArray(result.audio) ? result.audio : []) if (track && typeof track === "object") { track.label = ""; track.language = ""; }
  for (const patches of Object.values(result.audioPatches || {})) if (Array.isArray(patches)) {
    for (const patch of patches) if (patch?.bytes instanceof Uint8Array) patch.bytes.fill(0);
    patches.length = 0;
  }
  if (Array.isArray(result.subtitles)) result.subtitles.length = 0;
  if (Array.isArray(result.audio)) result.audio.length = 0;
}
function validate(result, size) {
  if (!result || !Array.isArray(result.audio) || !Array.isArray(result.subtitles) || result.audio.length + result.subtitles.length > 64) throw unavailable();
  const ids = new Set(); let cueCount = 0, textBytes = 0;
  for (const track of [...result.audio, ...result.subtitles]) {
    if (typeof track.id !== "string" || !track.id || track.id.length > 64 || ids.has(track.id) ||
        typeof track.language !== "string" || track.language.length > 64 || typeof track.label !== "string" || track.label.length > 1024) throw unavailable();
    ids.add(track.id);
  }
  for (const track of result.audio) {
    const patches = result.audioPatches?.[track.id];
    if (!Array.isArray(patches) || patches.length > 256) throw unavailable();
    let previous = 0;
    patches.sort((a, b) => a.offset - b.offset);
    for (const patch of patches) {
      if (!Number.isSafeInteger(patch.offset) || patch.offset < previous || !(patch.bytes instanceof Uint8Array) ||
          patch.bytes.length < 1 || patch.bytes.length > 16 || patch.offset + patch.bytes.length > size) throw unavailable();
      previous = patch.offset + patch.bytes.length;
    }
  }
  for (const track of result.subtitles) {
    if (!Array.isArray(track.cues)) throw unavailable();
    if ((cueCount += track.cues.length) > 20000) throw unavailable();
    for (const cue of track.cues) {
      if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start ||
          cue.end > 8 * 86400 || typeof cue.text !== "string" || cue.text.length > 65536) throw unavailable();
      textBytes += new TextEncoder().encode(cue.text).byteLength;
      if (textBytes > VAULT_MEDIA_TRACK_LIMITS.textBytes) throw unavailable();
    }
  }
  return result;
}

async function readTrackWorker(blob, { signal, subtitleId } = {}) {
  signal?.throwIfAborted();
  if (!(blob instanceof Blob) || !blob.size || blob.size > VAULT_MEDIA_TRACK_LIMITS.inputBytes || typeof Worker !== "function") throw unavailable();
  return new Promise((resolve, reject) => {
    let worker, timer, finished = false;
    const done = (error, value) => {
      if (finished) { wipeParsedResult(value); return; } finished = true;
      clearTimeout(timer); signal?.removeEventListener("abort", cancel); worker?.terminate();
      if (error) reject(error); else resolve(value);
    };
    const cancel = () => done(aborted());
    signal?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => done(unavailable()), VAULT_MEDIA_TRACK_LIMITS.milliseconds);
    try {
      worker = new Worker(new URL("./vault-media-tracks-worker.js", import.meta.url), { type: "module" });
      worker.onmessage = event => {
        const result = event.data?.result;
        if (finished) { wipeParsedResult(result); return; }
        try { if (event.data?.error) throw unavailable(); done(null, validate(result, blob.size)); }
        catch (error) { wipeParsedResult(result); done(error); }
      };
      worker.onerror = () => done(unavailable());
      worker.postMessage({ blob, ...(subtitleId === undefined ? {} : { subtitleId }) });
    } catch { done(unavailable()); }
    if (signal?.aborted) cancel();
  });
}

export async function inspectMediaTracks(blob, { signal } = {}) {
  let parsed = await readTrackWorker(blob, { signal });
  let disposed = false, subtitleLoading = null;
  const loadedSubtitles = new Set();
  const check = () => { if (disposed || signal?.aborted) throw aborted(); };
  const audio = parsed.audio.map(({ id, language, label, default: primary }) => ({ id, language, label, default: Boolean(primary) }));
  const subtitles = parsed.subtitles.map(({ id, language, label, format, supported }) => ({ id, language, label, format, supported: supported !== false }));
  function dispose() {
    if (disposed) return; disposed = true; signal?.removeEventListener("abort", dispose);
    subtitleLoading?.controller.abort(); subtitleLoading = null;
    wipeParsedResult(parsed); parsed = null;
    for (const track of [...audio, ...subtitles]) { track.label = ""; track.language = ""; }
    audio.length = 0; subtitles.length = 0; loadedSubtitles.clear(); blob = null;
  }
  signal?.addEventListener("abort", dispose, { once: true });
  if (signal?.aborted) { dispose(); throw aborted(); }
  return { audio, subtitles,
    async selectAudio(id) {
      check(); if (id === "original") return blob;
      if (!audio.some(track => track.id === id)) throw unavailable();
      let position = 0; const parts = [];
      for (const patch of parsed.audioPatches[id]) {
        parts.push(blob.slice(position, patch.offset), patch.bytes.slice()); position = patch.offset + patch.bytes.length;
      }
      parts.push(blob.slice(position));
      const result = new Blob(parts, { type: blob.type || (parsed.container === "mp4" ? "video/mp4" : "video/x-matroska") });
      check(); return result;
    },
    async readSubtitles(id) {
      check(); let track = parsed.subtitles.find(value => value.id === id);
      if (!track || track.supported === false) throw new Error(t("This subtitle format cannot be displayed as local text captions.", "Dieses Untertitelformat kann nicht als lokale Textuntertitel angezeigt werden."));
      if (parsed.lazySubtitles && !loadedSubtitles.has(id)) {
        if (subtitleLoading?.id !== id) {
          subtitleLoading?.controller.abort();
          const controller = new AbortController(), lifetime = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
          const promise = (async () => {
            let result;
            try {
              result = await readTrackWorker(blob, { signal: lifetime, subtitleId: id }); lifetime.throwIfAborted(); check();
              const selected = result.subtitles.find(value => value.id === id);
              if (!selected || selected.supported === false) throw unavailable();
              const bytes = cues => cues.reduce((total, cue) => total + new TextEncoder().encode(cue.text).byteLength, 0);
              let totalCues = selected.cues.length, totalBytes = bytes(selected.cues);
              for (const previous of parsed.subtitles) if (previous.id !== id) { totalCues += previous.cues.length; totalBytes += bytes(previous.cues); }
              if (totalCues > VAULT_MEDIA_TRACK_LIMITS.cues || totalBytes > VAULT_MEDIA_TRACK_LIMITS.textBytes) {
                for (const previous of parsed.subtitles) if (previous.id !== id) {
                  for (const cue of previous.cues) cue.text = ""; previous.cues.length = 0; loadedSubtitles.delete(previous.id);
                }
              }
              track = parsed.subtitles.find(value => value.id === id); track.cues = selected.cues; selected.cues = [];
              loadedSubtitles.add(id);
            } catch (error) {
              if (!disposed && error?.name !== "AbortError") {
                const current = parsed.subtitles.find(value => value.id === id), shown = subtitles.find(value => value.id === id);
                if (current) current.supported = false; if (shown) shown.supported = false;
              }
              if (error?.name === "AbortError") throw error;
              throw new Error(t("This subtitle track exceeds the local extraction limits or cannot be read on this device.",
                "Diese Untertitelspur überschreitet die lokalen Lesegrenzen oder kann auf diesem Gerät nicht gelesen werden."));
            } finally { wipeParsedResult(result); }
          })();
          subtitleLoading = { id, controller, promise };
        }
        const pending = subtitleLoading;
        try { await pending.promise; } finally { if (subtitleLoading === pending) subtitleLoading = null; }
        check(); track = parsed.subtitles.find(value => value.id === id);
      }
      return track.cues.map(cue => ({ ...cue }));
    }, dispose };
}

function waitEvent(node, event, signal, milliseconds = 12000) {
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); node.removeEventListener(event, ready); node.removeEventListener("error", error); signal?.removeEventListener("abort", cancel); };
    const ready = () => { clean(); resolve(); };
    const error = () => { clean(); reject(unavailable()); };
    const cancel = () => { clean(); reject(aborted()); };
    const timer = setTimeout(error, milliseconds);
    node.addEventListener(event, ready, { once: true }); node.addEventListener("error", error, { once: true });
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
function decodedAudioAvailable(media) {
  if (media.audioTracks) return media.audioTracks.length > 0;
  const capture = media.captureStream || media.mozCaptureStream;
  if (typeof capture !== "function") return null;
  let stream;
  try { stream = capture.call(media); return stream.getAudioTracks().length > 0; }
  catch { return null; }
  finally { for (const track of stream?.getTracks() || []) track.stop(); }
}
const passiveCue = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\0", "");

export async function attachMediaTracks(media, blob, { signal, onChange, onError } = {}) {
  const scope = new AbortController(), lifetime = signal ? AbortSignal.any([signal, scope.signal]) : scope.signal;
  const source = await inspectMediaTracks(blob, { signal: lifetime });
  let disposed = false, switching = false, audioUrl = null, pendingAudioUrl = null, subtitleHandle = null;
  let subtitleGeneration = 0;
  let audioId = "original", subtitleId = "off";
  const owner = Symbol("Vault subtitle owner");
  for (const track of Array.from(media.textTracks || [])) track.mode = "disabled";
  const check = () => { if (disposed || lifetime.aborted) throw aborted(); };
  function changed() { if (!disposed) onChange?.(); }
  function removeSubtitle() {
    if (subtitleHandle?.owner === owner) {
      subtitleHandle.track.mode = "disabled";
      for (const cue of Array.from(subtitleHandle.track.cues || [])) subtitleHandle.track.removeCue(cue);
      subtitleHandle.owner = null;
    }
  }
  async function subtitle(id) {
    check();
    const generation = ++subtitleGeneration;
    if (id === "off") {
      removeSubtitle(); for (const track of Array.from(media.textTracks || [])) track.mode = "disabled";
      subtitleId = "off"; changed(); return true;
    }
    const entry = source.subtitles.find(track => track.id === id);
    if (!entry || entry.supported === false) throw unavailable();
    let cues;
    try { cues = await source.readSubtitles(id); }
    catch (error) { changed(); throw error; }
    check();
    if (generation !== subtitleGeneration) return false;
    subtitleHandle = subtitleHandles.get(media);
    if (!subtitleHandle) {
      if (typeof media.addTextTrack !== "function" || typeof VTTCue !== "function") throw unavailable();
      subtitleHandle = { track: media.addTextTrack("subtitles", "Vault", "und"), owner: null };
      subtitleHandles.set(media, subtitleHandle);
    }
    subtitleHandle.owner = owner; subtitleHandle.track.mode = "hidden";
    for (const cue of Array.from(subtitleHandle.track.cues || [])) subtitleHandle.track.removeCue(cue);
    for (const track of Array.from(media.textTracks || [])) if (track !== subtitleHandle.track) track.mode = "disabled";
    try {
      for (let index = 0; index < cues.length; index++) {
        if (index && index % 256 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        check(); if (generation !== subtitleGeneration) return false;
        const cue = cues[index]; subtitleHandle.track.addCue(new VTTCue(cue.start, cue.end, passiveCue(cue.text)));
      }
      subtitleHandle.track.mode = "showing";
    } catch (error) { removeSubtitle(); throw error; }
    subtitleId = id; changed(); return true;
  }
  async function load(url, snapshot, requireAudio = false) {
    const metadata = waitEvent(media, "loadedmetadata", lifetime), data = waitEvent(media, "loadeddata", lifetime);
    data.catch(() => {}); media.src = url; media.load();
    await metadata; check();
    media.volume = snapshot.volume; media.muted = snapshot.muted; media.playbackRate = snapshot.rate;
    let seeking;
    if (snapshot.time > 0) {
      seeking = waitEvent(media, "seeked", lifetime); seeking.catch(() => {});
      media.currentTime = Number.isFinite(media.duration) ? Math.min(snapshot.time, Math.max(0, media.duration - .001)) : snapshot.time;
    }
    await data; if (seeking) await seeking; check();
    if (requireAudio && decodedAudioAvailable(media) === false) throw new Error(t(
      "The selected audio track cannot be decoded on this device. The previous playback has been restored.",
      "Die gewählte Audiospur kann auf diesem Gerät nicht dekodiert werden. Die vorherige Wiedergabe wurde wiederhergestellt."));
    if (subtitleId !== "off") await subtitle(subtitleId);
    if (!snapshot.paused) await media.play();
    check();
  }
  function dispose() {
    if (disposed) return; disposed = true; scope.abort(); lifetime.removeEventListener("abort", dispose); source.dispose();
    removeSubtitle();
    for (const url of new Set([pendingAudioUrl, audioUrl].filter(Boolean))) {
      if (media.src === url) { media.pause(); media.removeAttribute("src"); media.load(); }
      URL.revokeObjectURL(url);
    }
    audioUrl = null; pendingAudioUrl = null;
  }
  lifetime.addEventListener("abort", dispose, { once: true });
  if (lifetime.aborted) { dispose(); throw aborted(); }
  return { audio: source.audio, subtitles: source.subtitles,
    get switching() { return switching; }, get audioId() { return audioId; }, get subtitleId() { return subtitleId; },
    async selectAudio(id) {
      check(); if (switching) return false;
      if (id !== "original" && !source.audio.some(track => track.id === id)) throw unavailable();
      if (id === audioId) return true;
      switching = true; changed();
      const previous = media.currentSrc || media.src, oldUrl = audioUrl;
      const snapshot = { time: media.currentTime || 0, paused: media.paused, rate: media.playbackRate, volume: media.volume, muted: media.muted };
      let url;
      try {
        const selected = await source.selectAudio(id); check(); url = URL.createObjectURL(selected); pendingAudioUrl = url;
        media.pause(); await load(url, snapshot, id !== "original"); check();
        audioUrl = url; audioId = id; if (oldUrl) URL.revokeObjectURL(oldUrl); return true;
      } catch (error) {
        if (url) URL.revokeObjectURL(url);
        if (!disposed && !lifetime.aborted && previous) { try { await load(previous, snapshot); } catch {} }
        if (!disposed && error.name !== "AbortError") onError?.(error);
        throw error;
      } finally { if (pendingAudioUrl === url) pendingAudioUrl = null; switching = false; changed(); }
    },
    async selectSubtitle(id) { check(); if (switching) return false; return subtitle(id); }, dispose };
}
