import { t } from "./i18n.js";

export const VAULT_EDITOR_LIMITS = Object.freeze({ inputBytes: 128 * 1024 ** 2, textBytes: 2 * 1024 ** 2,
  pdfBytes: 64 * 1024 ** 2, imagePixels: 32 * 1024 ** 2, pdfPages: 500 });

const textExtensions = new Set("txt md markdown csv tsv json jsonl yaml yml xml html htm css js mjs cjs jsx ts tsx py sh bash ini conf config toml sql srt vtt ics vcf svg tex rb go rs c cpp h hpp java php ps1 log env gitignore".split(" "));
const imageExtensions = new Set("png jpg jpeg webp gif bmp avif ico".split(" "));
const videoExtensions = new Set("mp4 webm ogv mov m4v mkv".split(" "));
const audioExtensions = new Set("mp3 wav flac ogg oga m4a aac opus weba mka".split(" "));

export function vaultFileKind(entry = {}) {
  const name = String(entry.name ?? "").toLowerCase();
  const extension = name.split(".").pop();
  const type = String(entry.type ?? "").toLowerCase().split(";", 1)[0].trim();
  if (type === "image/svg+xml" || textExtensions.has(extension) || type.startsWith("text/") ||
      ["application/json", "application/xml", "application/x-yaml", "application/javascript"].includes(type)) return "text";
  if (["docx", "xlsx"].includes(extension) || ["application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"].includes(type)) return "office";
  if (/\.(?:zip|tar|tgz|tar\.gz)$/u.test(name) || ["application/zip", "application/x-zip-compressed", "application/x-tar"].includes(type)) return "archive";
  if (type === "application/pdf" || extension === "pdf") return "pdf";
  if (/^image\/(png|jpeg|webp|gif|bmp|avif|x-icon|vnd\.microsoft\.icon)$/u.test(type)) return "image";
  if (/^video\/(mp4|webm|ogg|quicktime|x-matroska|matroska)$/u.test(type)) return "video";
  if (/^audio\/(mpeg|mp3|wav|x-wav|flac|ogg|mp4|aac|webm|opus|x-matroska|matroska)$/u.test(type)) return "audio";
  if (imageExtensions.has(extension)) return "image";
  if (videoExtensions.has(extension)) return "video";
  if (audioExtensions.has(extension)) return "audio";
  return "other";
}

export function editedFileName(name, extension) {
  let safe = String(name || "file").replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069/\\]/gu, "_").trim();
  const match = /^(.*?)(\.[^.]+)?$/u.exec(safe);
  const encode = new TextEncoder();
  const originalEnding = match?.[2] && encode.encode(match[2]).byteLength <= 21 ? match[2] : "";
  const base = (originalEnding ? safe.slice(0, -originalEnding.length) : safe) || "file";
  const ending = extension ? "." + String(extension).replace(/[^a-z0-9]/giu, "").slice(0, 16).toLowerCase() : originalEnding;
  const tail = "-edited" + ending;
  const budget = 240 - encode.encode(tail).byteLength;
  let prefix = "", bytes = 0;
  for (const point of base) {
    const length = encode.encode(point).byteLength;
    if (bytes + length > budget) break;
    prefix += point; bytes += length;
  }
  return prefix + tail;
}

export function imageCrop(width, height, crop = {}) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > VAULT_EDITOR_LIMITS.imagePixels) {
    throw new Error(t("This image exceeds the local editor’s resolution limit.", "Dieses Bild überschreitet die Auflösungsgrenze des lokalen Editors."));
  }
  const values = [crop.left ?? 0, crop.top ?? 0, crop.right ?? 0, crop.bottom ?? 0].map(Number);
  if (values.some(value => !Number.isFinite(value) || value < 0 || value > 95) || values[0] + values[2] >= 100 || values[1] + values[3] >= 100) {
    throw new Error(t("Keep a non-empty image area when cropping.", "Lasse beim Zuschneiden einen sichtbaren Bildbereich übrig."));
  }
  const x = Math.min(width - 1, Math.floor(width * values[0] / 100));
  const y = Math.min(height - 1, Math.floor(height * values[1] / 100));
  return { x, y, width: Math.max(1, Math.floor(width * (1 - (values[0] + values[2]) / 100))),
    height: Math.max(1, Math.floor(height * (1 - (values[1] + values[3]) / 100))) };
}

export function rasterImageType(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 14 && ascii(0, 2) === "BM") return "image/bmp";
  if (bytes.length >= 16 && ascii(4, 8) === "ftyp") {
    if (["avif", "avis"].includes(ascii(8, 12))) return "image/avif";
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (size >= 16 && size <= 4096 && size % 4 === 0) {
      for (let offset = 16; offset + 4 <= Math.min(size, bytes.length); offset += 4) {
        if (["avif", "avis"].includes(ascii(offset, offset + 4))) return "image/avif";
      }
    }
  }
  if (bytes.length >= 6 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0 &&
      bytes[4] + bytes[5] * 256 >= 1 && bytes[4] + bytes[5] * 256 <= 256) return "image/x-icon";
  return null;
}

export async function validateIconImage(blob, { signal } = {}) {
  const invalid = () => new Error(t("This icon is invalid or exceeds the local image limits.", "Dieses Icon ist ungültig oder überschreitet die lokalen Bildgrenzen."));
  abortEditor(signal);
  if (!(blob instanceof Blob) || blob.size < 22 || blob.size > VAULT_EDITOR_LIMITS.inputBytes) throw invalid();
  const header = new Uint8Array(await blob.slice(0, 4102).arrayBuffer());
  abortEditor(signal);
  if (rasterImageType(header) !== "image/x-icon") throw invalid();
  const view = new DataView(header.buffer), count = view.getUint16(4, true), directorySize = 6 + count * 16;
  if (directorySize > header.byteLength) throw invalid();
  for (let index = 0; index < count; index++) {
    const start = 6 + index * 16, width = header[start] || 256, height = header[start + 1] || 256;
    const size = view.getUint32(start + 8, true), offset = view.getUint32(start + 12, true);
    if (header[start + 3] !== 0 || !size || offset < directorySize || offset + size > blob.size) throw invalid();
    const bytes = new Uint8Array(await blob.slice(offset, offset + Math.min(size, 124)).arrayBuffer());
    abortEditor(signal);
    const image = new DataView(bytes.buffer);
    if (rasterImageType(bytes) === "image/png") {
      if (bytes.length < 24 || String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR" ||
          image.getUint32(16) !== width || image.getUint32(20) !== height) throw invalid();
    } else {
      if (bytes.length < 12) throw invalid();
      const dibSize = image.getUint32(0, true);
      if (![12, 40, 52, 56, 108, 124].includes(dibSize) || bytes.length < dibSize) throw invalid();
      const actualWidth = dibSize === 12 ? image.getUint16(4, true) : image.getInt32(4, true);
      const actualHeight = dibSize === 12 ? image.getUint16(6, true) : image.getInt32(8, true);
      if (actualWidth !== width || actualHeight !== height * 2) throw invalid();
      const bits = image.getUint16(dibSize === 12 ? 10 : 14, true);
      if (![1, 4, 8, 16, 24, 32].includes(bits)) throw invalid();
      if (dibSize >= 40 && (image.getUint32(20, true) > size || ![0, 3].includes(image.getUint32(16, true)))) throw invalid();
    }
  }
  return { images: count };
}

export async function mediaDuration(media, { signal } = {}) {
  if (Number.isFinite(media.duration) && media.duration > 0) return media.duration;
  // Browser-recorded WebM can omit its duration header. Seeking to the end asks
  // the browser's own demuxer to determine it without another parser or upload.
  if (media.duration !== Infinity) throw new Error(t("The playback duration could not be determined.", "Die Wiedergabedauer konnte nicht bestimmt werden."));
  let inspect;
  const discovered = new Promise(resolve => {
    inspect = () => { if (Number.isFinite(media.duration) && media.duration > 0) resolve(media.duration); };
    for (const name of ["durationchange", "timeupdate", "seeked"]) media.addEventListener(name, inspect);
    media.currentTime = 1e12; inspect();
  });
  try {
    const duration = await editorOperation(discovered, { signal, milliseconds: 10000 });
    abortEditor(signal);
    if (Math.abs(media.currentTime) > .001 || media.seeking) {
      const back = editorEvent(media, "seeked", { signal }); media.currentTime = 0; await back;
    }
    return duration;
  } finally { for (const name of ["durationchange", "timeupdate", "seeked"]) media.removeEventListener(name, inspect); }
}

export function abortEditor(signal) {
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
}

export function editorOperation(operation, { signal, milliseconds = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const complete = (error, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener("abort", cancelled);
      if (error) reject(error); else resolve(value);
    };
    const cancelled = () => complete(new DOMException("Cancelled", "AbortError"));
    const timer = setTimeout(() => complete(new Error(t("The local operation timed out.", "Der lokale Vorgang hat zu lange gedauert."))), milliseconds);
    signal?.addEventListener("abort", cancelled, { once: true });
    Promise.resolve(operation).then(value => complete(null, value), error => complete(error));
    if (signal?.aborted) cancelled();
  });
}

export function editorEvent(node, event, { signal, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    abortEditor(signal);
    const clean = () => { clearTimeout(timer); node.removeEventListener(event, success); node.removeEventListener("error", failure); signal?.removeEventListener("abort", aborted); };
    const success = () => { clean(); resolve(); };
    const failure = () => { clean(); reject(new Error(t("This file could not be decoded on this device.", "Diese Datei konnte auf diesem Gerät nicht gelesen werden."))); };
    const aborted = () => { clean(); reject(new DOMException("Cancelled", "AbortError")); };
    const timer = setTimeout(failure, timeout);
    node.addEventListener(event, success, { once: true }); node.addEventListener("error", failure, { once: true });
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

export function canvasBlob(canvas, type = "image/png", quality = .92) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error(t(
    "The image could not be exported.", "Das Bild konnte nicht exportiert werden."))), type, quality));
}

export function formatMediaTime(value) {
  if (!Number.isFinite(value) || value < 0) return "--:--";
  const seconds = Math.floor(value), hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return (hours ? hours + ":" : "") + String(minutes).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
}

export function playbackPosition(duration, value) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(Number(value))) return null;
  return Math.max(0, Math.min(duration, Number(value)));
}

export function createVaultPlayback(media, { signal, onState, onError } = {}) {
  let live = true, desiredPlaying = !media.paused, generation = 0;
  const events = ["timeupdate", "durationchange", "volumechange", "ratechange", "play", "playing", "pause", "ended", "waiting", "loadeddata", "seeking", "seeked", "error"];
  function state() {
    if (!live || signal?.aborted) return;
    onState?.({ paused: media.paused, ended: media.ended, currentTime: Math.max(0, Number(media.currentTime) || 0),
      duration: Number.isFinite(media.duration) && media.duration > 0 ? media.duration : null,
      volume: media.volume, muted: media.muted, rate: media.playbackRate });
  }
  function changed(event) {
    if (!live) return;
    if (event.type === "play" || event.type === "playing") desiredPlaying = true;
    if (event.type === "pause" || event.type === "ended") { desiredPlaying = false; generation++; }
    if (event.type === "error") { desiredPlaying = false; generation++; onError?.(new Error(t("This file could not be decoded on this device.", "Diese Datei konnte auf diesem Gerät nicht gelesen werden."))); }
    state();
  }
  function dispose() {
    if (!live) return;
    live = false; desiredPlaying = false; generation++;
    for (const event of events) media.removeEventListener(event, changed);
    signal?.removeEventListener("abort", dispose);
    media.pause(); media.removeAttribute("src"); media.load();
  }
  for (const event of events) media.addEventListener(event, changed);
  signal?.addEventListener("abort", dispose, { once: true });
  if (signal?.aborted) dispose();
  else state();
  return {
    async toggle() {
      if (!live || signal?.aborted) return;
      const intent = ++generation;
      desiredPlaying = !desiredPlaying;
      if (!desiredPlaying) { media.pause(); state(); return; }
      if (media.ended) media.currentTime = 0;
      try {
        const playing = media.play();
        Promise.resolve(playing).then(() => { if (!live || signal?.aborted || intent !== generation || !desiredPlaying) media.pause(); }, () => {});
        await editorOperation(playing, { signal });
        if (!live || signal?.aborted || intent !== generation || !desiredPlaying) media.pause();
        else state();
      } catch (error) {
        if (live && !signal?.aborted && intent === generation) { desiredPlaying = false; media.pause(); onError?.(error); state(); }
      }
    },
    seek(value) {
      if (!live || signal?.aborted) return;
      const position = playbackPosition(media.duration, value);
      if (position !== null) { media.currentTime = position; state(); }
    },
    volume(value) {
      if (!live || signal?.aborted || !Number.isFinite(Number(value))) return;
      media.volume = Math.max(0, Math.min(1, Number(value))); media.muted = media.volume === 0; state();
    },
    mute() { if (live && !signal?.aborted) { media.muted = !media.muted; state(); } },
    rate(value) {
      if (live && !signal?.aborted && [.5, .75, 1, 1.25, 1.5, 2].includes(Number(value))) { media.playbackRate = Number(value); state(); }
    },
    dispose,
  };
}
