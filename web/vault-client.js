import { t } from "./i18n.js";
import { accountHeaders, api, checkAccountResponse } from "./ui.js";
import { CHUNK_SIZE, MAX_FILE_SIZE, validateName, createFile, createFolder, openEntry, renameEntry, encryptChunk, decryptChunk, destroySecret,
  sealMemberShare, openMemberShare, createShare, openShare, sealShareLink, openShareLink, validateDescriptor } from "./vault-crypto.js";
import { vaultFileKind } from "./vault-media-edit.js";

export const BLOB_DOWNLOAD_LIMIT = 128 * 1024 * 1024;
export const MEDIA_BLOB_LIMIT = 10 * 1024 ** 3;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const SECRET = /^[A-Za-z0-9_-]{43}$/u;
const downloads = new Set();
export function downloadVaultLocalBlob(blob, name) {
  if (!(blob instanceof Blob) || blob.size > BLOB_DOWNLOAD_LIMIT) throw new Error(t(
    "The local file is too large for this download.", "Die lokale Datei ist für diesen Download zu groß."));
  const url = URL.createObjectURL(blob); downloads.add(url);
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = safeDownloadName(name); anchor.rel = "noopener noreferrer";
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url); }, 30000);
}
function revokeVaultDownloads() {
  for (const url of downloads) URL.revokeObjectURL(url);
  downloads.clear();
}

function cancelled(signal) { signal?.throwIfAborted(); }
function id(value) {
  if (!UUID.test(value ?? "")) throw new Error(t("This vault item is unavailable.", "Dieses Vault-Element ist nicht verfügbar."));
  return value;
}
function combined(first, second) {
  return first && second ? AbortSignal.any([first, second]) : first ?? second;
}
function localBlobFailure() {
  return Object.assign(new Error(t("Your browser could not prepare this file. Free local temporary storage or download it instead.",
    "Dein Browser konnte diese Datei nicht vorbereiten. Gib lokalen temporären Speicher frei oder lade die Datei stattdessen herunter.")), { code: "VAULT_LOCAL_STORAGE" });
}
function previewLimit(value, media) {
  const maximum = media ? MEDIA_BLOB_LIMIT : BLOB_DOWNLOAD_LIMIT;
  const limit = value ?? maximum;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > maximum) throw new Error(t(
    "The local editor memory limit is invalid.", "Das Speicherlimit des lokalen Editors ist ungültig."));
  return limit;
}
async function blobReady(blob, signal) {
  cancelled(signal);
  if (!blob.size) return;
  let read;
  try { read = blob.slice(blob.size - 1, blob.size).arrayBuffer(); }
  catch { throw localBlobFailure(); }
  // Reading a real byte waits for the browser's Blob construction and storage
  // quota. Do not enqueue the next plaintext chunk while this one is pending.
  await new Promise((resolve, reject) => {
    let finished = false;
    const done = error => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => { try { cancelled(signal); } catch (error) { done(error); } };
    const timer = setTimeout(() => done(localBlobFailure()), 30000);
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve(read).then(buffer => {
      const size = buffer instanceof ArrayBuffer ? buffer.byteLength : -1;
      if (size > 0) new Uint8Array(buffer).fill(0);
      if (!finished) { if (signal?.aborted) abort(); else done(size === 1 ? undefined : localBlobFailure()); }
    }, () => { if (!finished) { if (signal?.aborted) abort(); else done(localBlobFailure()); } });
    if (signal?.aborted) abort();
  });
  cancelled(signal);
}
async function readAuthenticatedBlob(opened, readChunk, { signal, onProgress, limit, media } = {}) {
  const descriptor = validateDescriptor(opened.descriptor);
  if (descriptor.size > limit) throw new Error(t(
    "This file is too large for the local preview. Download it to open it on your device.",
    "Diese Datei ist zu groß für die lokale Vorschau. Lade sie herunter, um sie auf deinem Gerät zu öffnen."));
  if (media && !["image", "video", "audio"].includes(vaultFileKind(opened))) throw new Error(t(
    "Choose an image, video or audio file for the media player.", "Wähle eine Bild-, Video- oder Audiodatei für den Medienplayer."));
  const parts = [];
  let result;
  try {
    let done = 0;
    for (let index = 0; index < descriptor.chunks; index += 1) {
      cancelled(signal);
      const length = Math.min(CHUNK_SIZE, descriptor.size - index * CHUNK_SIZE);
      const encrypted = await readChunk(index, length + 28);
      let plaintext, part;
      try {
        cancelled(signal);
        plaintext = await decryptChunk(opened.secret, descriptor, index, encrypted);
        cancelled(signal);
        try { part = new Blob([plaintext]); } catch { throw localBlobFailure(); }
      } finally { plaintext?.fill(0); encrypted.fill(0); }
      await blobReady(part, signal);
      parts.push(part); done += part.size;
      onProgress?.({ done, total: Math.max(1, descriptor.size) });
    }
    cancelled(signal);
    try { result = new Blob(parts, { type: opened.type || "application/octet-stream" }); }
    catch { throw localBlobFailure(); }
    if (result.size !== descriptor.size) throw new Error(t(
      "The encrypted file is incomplete or damaged.", "Die verschlüsselte Datei ist unvollständig oder beschädigt."));
    await blobReady(result, signal);
    cancelled(signal); return result;
  } finally {
    parts.length = 0; result = null;
  }
}
function safeDownloadName(value, maxBytes = 240) {
  let name = String(value ?? "").replace(/[\/\\:*?"<>|\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, "_");
  if (/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(?:[ .]|$)/iu.test(name)) name = "_" + name;
  const encoder = new TextEncoder();
  let bounded = "", bytes = 0;
  for (const character of name) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > maxBytes) break;
    bounded += character; bytes += size;
  }
  bounded = bounded.replace(/[. ]+$/u, "");
  return bounded && bounded !== "." && bounded !== ".." ? bounded : "Vault-download";
}
export function editedVaultName(value) {
  const original = safeDownloadName(value, 255);
  const dot = original.lastIndexOf(".");
  const extension = dot > 0 && original.length - dot <= 21 ? original.slice(dot) : "";
  const suffix = " (" + t("edited", "bearbeitet") + ")" + extension;
  const encoder = new TextEncoder();
  let stem = "", size = encoder.encode(suffix).byteLength;
  for (const character of extension ? original.slice(0, dot) : original) {
    const length = encoder.encode(character).byteLength;
    if (size + length > 240) break;
    stem += character; size += length;
  }
  return safeDownloadName(stem + suffix);
}
export function publicVaultLink(shareId, token, keyFragment, origin = location.origin) {
  id(shareId);
  if (!SECRET.test(token) || !SECRET.test(keyFragment)) throw new Error(t("The sharing link is invalid.", "Der Freigabelink ist ungültig."));
  return new URL("/vault", origin).href + "#" + shareId + "." + token + "." + keyFragment;
}
export function takePublicVaultLink(address = location.href, clear = () => history.replaceState(history.state, "", location.pathname + location.search)) {
  const url = new URL(address);
  const pieces = url.hash.slice(1).split(".");
  // Remove the entire capability and key before any network request or UI work.
  clear();
  if (pieces.length !== 3 || !UUID.test(pieces[0]) || !SECRET.test(pieces[1]) || !SECRET.test(pieces[2])) return null;
  return { id: pieces[0], token: pieces[1], keyFragment: pieces[2] };
}

export function prepareVaultDownload(entry) {
  const descriptor = validateDescriptor(entry.descriptor);
  const name = safeDownloadName(entry.name);
  const native = globalThis.roomsVault;
  if (native && ["prepareDownload", "writeDownload", "completeDownload", "cancelDownload"].every(method => typeof native[method] === "function")) {
    return native.prepareDownload({ name, size: descriptor.size }).then(result => {
      if (!result) throw new DOMException("Cancelled", "AbortError");
      const handleId = typeof result === "string" ? result : result.id;
      if (typeof handleId !== "string" || !handleId || handleId.length > 128) throw new Error(t("The vault request failed.", "Die Vault-Anfrage ist fehlgeschlagen."));
      let position = 0, created = false, finished = false, writing = false;
      const failure = () => new Error(t("The vault request failed.", "Die Vault-Anfrage ist fehlgeschlagen."));
      const accepted = value => { if (value === false || value === null) throw failure(); };
      async function abort() {
        if (finished) return;
        finished = true; await native.cancelDownload(handleId);
      }
      return { name, abort, handle: { async createWritable() {
        if (created || finished) throw failure();
        created = true;
        return {
          async write(input) {
            const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
            if (finished || writing || bytes.byteLength > CHUNK_SIZE || position + bytes.byteLength > descriptor.size) throw failure();
            if (!bytes.byteLength) return;
            writing = true;
            try { accepted(await native.writeDownload(handleId, position, bytes)); position += bytes.byteLength; }
            finally { writing = false; }
          },
          async close() {
            if (finished || writing || position !== descriptor.size) throw failure();
            accepted(await native.completeDownload(handleId)); finished = true;
          },
          abort,
        };
      } } };
    });
  }
  if (typeof globalThis.showSaveFilePicker === "function") {
    return globalThis.showSaveFilePicker({ suggestedName: name }).then(handle => ({ handle, name }));
  }
  if (descriptor.size > BLOB_DOWNLOAD_LIMIT) {
    return Promise.reject(new Error(t("This browser cannot save files larger than 128 MiB safely. Use a browser with a save-file picker for this download.",
      "Dieser Browser kann Dateien über 128 MiB nicht sicher speichern. Verwende dafür einen Browser mit Dateispeicherdialog.")));
  }
  return Promise.resolve({ name });
}

async function errorResponse(response) {
  const body = await response.json().catch(() => null);
  const error = new Error(body?.error || t("The vault request failed.", "Die Vault-Anfrage ist fehlgeschlagen."));
  error.status = response.status;
  return error;
}
export async function vaultRequest(path, { method = "GET", body, signal, token, publicAccess = false } = {}) {
  const headers = { Accept: "application/json", ...(publicAccess ? {} : accountHeaders()) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  const response = await fetch("/api/" + path, { method, headers, signal, credentials: publicAccess ? "omit" : "same-origin",
    cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", body: body === undefined ? undefined : JSON.stringify(body) });
  if (!publicAccess) checkAccountResponse(response);
  if (!response.ok) throw await errorResponse(response);
  return response.status === 204 ? null : response.json();
}
export async function readVaultChunk(path, expectedBytes, { signal, token, publicAccess = false } = {}) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 28 || expectedBytes > CHUNK_SIZE + 28) {
    throw new Error(t("The encrypted file is incomplete or damaged.", "Die verschlüsselte Datei ist unvollständig oder beschädigt."));
  }
  const response = await fetch("/api/" + path, { signal,
    headers: { Accept: "application/octet-stream", ...(publicAccess ? {} : accountHeaders()), ...(token ? { Authorization: "Bearer " + token } : {}) },
    credentials: publicAccess ? "omit" : "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
  if (!publicAccess) checkAccountResponse(response);
  if (!response.ok) throw await errorResponse(response);
  const declared = response.headers.get("Content-Length");
  if (declared !== null && Number(declared) !== expectedBytes) {
    await response.body?.cancel();
    throw new Error(t("The encrypted file is incomplete or damaged.", "Die verschlüsselte Datei ist unvollständig oder beschädigt."));
  }
  const result = new Uint8Array(expectedBytes);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    for (;;) {
      cancelled(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > expectedBytes) throw new Error(t("The encrypted file is incomplete or damaged.", "Die verschlüsselte Datei ist unvollständig oder beschädigt."));
      result.set(value, offset); offset += value.byteLength;
    }
    if (offset !== expectedBytes) throw new Error(t("The encrypted file is incomplete or damaged.", "Die verschlüsselte Datei ist unvollständig oder beschädigt."));
    return result;
  } finally {
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
export async function saveVaultFile(opened, readChunk, { signal, onProgress, prepared } = {}) {
  const descriptor = validateDescriptor(opened.descriptor);
  const destination = await (prepared ?? prepareVaultDownload(opened));
  let writable;
  const buffers = [];
  let completed = false;
  try {
    cancelled(signal);
    if (!destination.handle && descriptor.size > BLOB_DOWNLOAD_LIMIT) throw new Error(t(
      "This browser cannot save files larger than 128 MiB safely. Use a browser with a save-file picker for this download.",
      "Dieser Browser kann Dateien über 128 MiB nicht sicher speichern. Verwende dafür einen Browser mit Dateispeicherdialog."));
    if (destination.handle) writable = await destination.handle.createWritable();
    cancelled(signal);
    let done = 0;
    for (let index = 0; index < descriptor.chunks; index += 1) {
      cancelled(signal);
      const plainLength = Math.min(CHUNK_SIZE, descriptor.size - index * CHUNK_SIZE);
      const encrypted = await readChunk(index, plainLength + 28);
      cancelled(signal);
      const plaintext = await decryptChunk(opened.secret, descriptor, index, encrypted);
      try {
        cancelled(signal);
        if (writable) await writable.write(plaintext);
        else buffers.push(new Uint8Array(plaintext));
      } finally { plaintext.fill(0); }
      done += plainLength;
      onProgress?.({ done, total: Math.max(1, descriptor.size) });
    }
    cancelled(signal);
    onProgress?.({ done: Math.max(1, descriptor.size), total: Math.max(1, descriptor.size), phase: "saving" });
    if (writable) { await writable.close(); writable = null; }
    else {
      const blob = new Blob(buffers, { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob); downloads.add(url);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = destination.name; anchor.rel = "noopener noreferrer";
      document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url); }, 30000);
    }
    completed = true;
  } finally {
    if (!completed) {
      if (writable) await writable.abort().catch(() => {});
      else await destination.abort?.().catch(() => {});
    }
    for (const buffer of buffers) buffer.fill(0);
  }
}

function pause(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    cancelled(signal);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function uploadNativeVaultSelection(bridge, service, { parentId = null, signal, onProgress, onUploaded } = {}) {
  cancelled(signal);
  if (!["prepareSelection", "readSelection", "cancelSelection"].every(method => typeof bridge?.[method] === "function")) {
    throw new Error(t("Update the desktop app to share files and folders separately via Vault.",
      "Aktualisiere die Desktop-App, um Dateien und Ordner einzeln über Vault zu teilen."));
  }
  let selection;
  const invalid = () => new Error(t("The local selection is unavailable. Select the files again.",
    "Die lokale Auswahl ist nicht verfügbar. Wähle die Dateien erneut aus."));
  const abort = () => { void bridge.cancelSelection(selection?.id).catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    selection = await bridge.prepareSelection();
    if (!selection) throw new DOMException("Cancelled", "AbortError");
    cancelled(signal);
    if (!UUID.test(selection.id ?? "") || !Array.isArray(selection.files) || !selection.files.length || selection.files.length > 256) throw invalid();
    const seen = new Set();
    const files = selection.files.map(item => {
      if (!item || !UUID.test(item.id ?? "") || seen.has(item.id) || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_FILE_SIZE ||
          typeof item.type !== "string" || item.type.length > 128 || !/^[\x20-\x7e]*$/u.test(item.type) ||
          (item.lastModified !== undefined && (!Number.isSafeInteger(item.lastModified) || item.lastModified < 0))) throw invalid();
      seen.add(item.id);
      return Object.freeze({ id: item.id, name: validateName(item.name), type: item.type, size: item.size, lastModified: item.lastModified ?? 0 });
    });
    const total = files.reduce((sum, file) => sum + Math.max(1, file.size), 0);
    const uploaded = [];
    let completedBytes = 0;
    for (const [index, item] of files.entries()) {
      cancelled(signal);
      const progress = done => onProgress?.({ done: completedBytes + Math.min(item.size, Math.max(0, done)), total,
        fileName: item.name, fileIndex: index + 1, fileCount: files.length });
      progress(0);
      const file = { name: item.name, type: item.type, size: item.size, lastModified: item.lastModified,
        slice(start, end) { return { async arrayBuffer() {
          cancelled(signal);
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > item.size || end - start > CHUNK_SIZE) throw invalid();
          const bytes = await bridge.readSelection(item.id, start, end - start);
          let transferred = false;
          try {
            cancelled(signal);
            if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) throw invalid();
            if (bytes.byteLength !== end - start) throw invalid();
            if (bytes instanceof ArrayBuffer) { transferred = true; return bytes; }
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          } finally {
            // The upload encryptor wipes its returned buffer; discard extra IPC
            // copies immediately, including rejected or cancelled reads.
            if (!transferred) {
              if (bytes instanceof ArrayBuffer) new Uint8Array(bytes).fill(0);
              else if (ArrayBuffer.isView(bytes)) new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).fill(0);
            }
          }
        } }; } };
      const entry = await service.upload(file, parentId, { signal, onProgress: value => progress(value.done ?? value.loaded ?? 0) });
      uploaded.push(entry);
      onUploaded?.(entry);
      completedBytes += Math.max(1, item.size);
      onProgress?.({ done: completedBytes, total, fileName: item.name, fileIndex: index + 1, fileCount: files.length });
    }
    cancelled(signal);
    return uploaded;
  } catch (error) { cancelled(signal); throw error; }
  finally {
    signal?.removeEventListener("abort", abort);
    // A declined native confirmation keeps the selection available for retry.
    // Explicit transfer cancellation above discards it even before an ID exists.
    if (selection?.id) await bridge.cancelSelection(selection.id).catch(() => {});
  }
}

export function createVaultClient({ user, signal: lifetime } = {}) {
  const local = new AbortController();
  const lifetimeSignal = combined(lifetime, local.signal);
  const cache = new Map();
  function clearCache() {
    for (const hit of cache.values()) if (hit.opened.secret) destroySecret(hit.opened.secret);
    cache.clear();
  }
  lifetimeSignal.addEventListener("abort", () => { clearCache(); revokeVaultDownloads(); }, { once: true });
  function disabled(config) {
    clearCache(); revokeVaultDownloads();
    return { ...config, enabled: false, usedBytes: 0, reservedBytes: 0, entries: [], receivedShares: [], receivedEntries: [] };
  }
  function operation(options = {}) { return { ...options, signal: combined(lifetimeSignal, options.signal) }; }
  async function opened(entry) {
    cancelled(lifetimeSignal);
    if (entry.receivedShareId && (entry.receivedShareId !== entry.share?.id || entry.id !== entry.share?.entryId ||
        entry.kind !== "file" || entry.ownerId !== entry.share?.ownerId || entry.share?.recipientId !== user.id ||
        entry.share?.owner?.id !== entry.share?.ownerId)) {
      throw new Error(t("This vault item is unavailable.", "Dieses Vault-Element ist nicht verfügbar."));
    }
    const key = entry.receivedShareId ? "share:" + entry.receivedShareId : "entry:" + entry.id;
    // Folder placement does not change the authenticated file descriptor or key.
    // Moving a file must not destroy a secret used by its active preview.
    const fingerprint = JSON.stringify({ id: entry.id, ownerId: entry.ownerId, kind: entry.kind,
      receivedShareId: entry.receivedShareId, envelope: entry.envelope, descriptor: entry.descriptor,
      share: entry.share && { id: entry.share.id, entryId: entry.share.entryId, ownerId: entry.share.ownerId,
        recipientId: entry.share.recipientId, owner: entry.share.owner && { id: entry.share.owner.id, publicKey: entry.share.owner.publicKey } } });
    const hit = cache.get(key);
    if (hit?.fingerprint === fingerprint) return hit.opened;
    if (hit) { if (hit.opened.secret) destroySecret(hit.opened.secret); cache.delete(key); }
    const result = entry.receivedShareId ? await openMemberShare(user, entry.share) : await openEntry(user, entry);
    try { cancelled(lifetimeSignal); } catch (error) { if (result.secret) destroySecret(result.secret); throw error; }
    cache.set(key, { fingerprint, opened: result });
    return result;
  }
  async function list(options = {}) {
    const request = operation(options);
    const config = await api("vault/config", request);
    cancelled(lifetimeSignal);
    if (config.enabled !== true) return disabled(config);
    let result;
    try { result = await api("vault", request); }
    catch (error) {
      if (error.status === 404 || error.status === 403) {
        const latest = await api("vault/config", request);
        cancelled(lifetimeSignal);
        if (latest.enabled !== true) return disabled(latest);
      }
      throw error;
    }
    cancelled(lifetimeSignal);
    const entries = [];
    const receivedEntries = [];
    const present = new Set();
    for (const [items, target, shared] of [[result.entries ?? [], entries, false], [result.receivedShares ?? [], receivedEntries, true]]) {
      for (const value of items) {
        cancelled(lifetimeSignal);
        const entry = shared ? { ...value, id: value.entryId, receivedShareId: value.id, share: value,
          parentId: null, kind: "file", state: "ready" } : value;
        const key = shared ? "share:" + value.id : "entry:" + value.id;
        present.add(key);
        try {
          const details = await opened(entry);
          target.push({ ...entry, name: details.name, type: details.type, plainBytes: details.descriptor?.size,
            modifiedAt: details.modifiedAt, uiId: shared ? "share:" + value.id : value.id });
        } catch (error) {
          cancelled(lifetimeSignal);
          target.push({ ...entry, locked: true, uiId: shared ? "share:" + value.id : value.id });
        }
      }
    }
    for (const [key, hit] of cache) if (!present.has(key)) { if (hit.opened.secret) destroySecret(hit.opened.secret); cache.delete(key); }
    return { ...result, entries, receivedEntries };
  }
  async function upload(file, parentId, options = {}) {
    const request = operation(options);
    cancelled(request.signal);
    const entryId = crypto.randomUUID();
    const created = await createFile(user, entryId, file);
    let reserved = false;
    let completed = false;
    try {
      cancelled(request.signal);
      reserved = true;
      await api("vault/entries", { ...request, method: "POST", body: { id: entryId, parentId, kind: "file",
        descriptor: created.descriptor, envelope: created.envelope } });
      for (let index = 0; index < created.descriptor.chunks; index += 1) {
        cancelled(request.signal);
        const start = index * CHUNK_SIZE;
        const plain = new Uint8Array(await file.slice(start, Math.min(file.size, start + CHUNK_SIZE)).arrayBuffer());
        let encrypted;
        try { encrypted = await encryptChunk(created.secret, created.descriptor, index, plain); }
        finally { plain.fill(0); }
        cancelled(request.signal);
        for (let attempt = 0;; attempt += 1) {
          try {
            await api("vault/entries/" + entryId + "/chunks/" + index, { ...request, method: "PUT", body: encrypted, binary: true });
            break;
          } catch (error) {
            cancelled(request.signal);
            if (attempt >= 2 || (error.status && ![429, 502, 503, 504].includes(error.status))) throw error;
            await pause(500 * 2 ** attempt, request.signal);
          }
        }
        options.onProgress?.({ done: Math.min(file.size, start + CHUNK_SIZE), total: Math.max(1, file.size) });
      }
      await api("vault/entries/" + entryId + "/complete", { ...request, method: "POST", body: {} });
      completed = true;
      return { id: entryId, parentId, kind: "file", envelope: created.envelope, descriptor: created.descriptor,
        state: "ready", name: created.opened.name, type: created.opened.type, plainBytes: created.descriptor.size };
    } finally {
      destroySecret(created.secret);
      if (reserved && !completed) {
        await api("vault/entries/" + entryId, { method: "DELETE", signal: AbortSignal.timeout(5000) }).catch(() => {});
      }
    }
  }
  async function entryDownload(entry, options = {}) {
    const request = operation(options);
    const details = await opened(entry);
    return saveVaultFile(details, (index, size) => readVaultChunk(entry.receivedShareId
      ? "vault/received/" + id(entry.receivedShareId) + "/chunks/" + index
      : "vault/entries/" + id(entry.id) + "/chunks/" + index, size, request), request);
  }
  function editableSource(entry) {
    // Keep the authenticated context and chunk endpoint fixed while a view is
    // refreshed, moved or renamed during an asynchronous editor operation.
    const source = structuredClone(entry);
    if (source?.kind !== "file" || source.state !== "ready" || source.locked) {
      throw new Error(t("This vault item is unavailable.", "Dieses Vault-Element ist nicht verfügbar."));
    }
    id(source.id);
    source.descriptor = validateDescriptor(source.descriptor);
    if (source.receivedShareId) id(source.receivedShareId);
    return source;
  }
  async function readPreview(entry, options = {}, media = false) {
    const request = operation(options);
    cancelled(request.signal);
    const source = editableSource(entry);
    const limit = previewLimit(options.maxBytes, media);
    if (source.descriptor.size > limit) throw new Error(t(
      "This file is too large for the local editor. Download it to edit it on your device.",
      "Diese Datei ist zu groß für den lokalen Editor. Lade sie herunter, um sie auf deinem Gerät zu bearbeiten."));
    const details = await opened(source);
    cancelled(request.signal);
    const path = source.receivedShareId ? "vault/received/" + source.receivedShareId : "vault/entries/" + source.id;
    try {
      return await readAuthenticatedBlob(details, (index, size) => readVaultChunk(path + "/chunks/" + index, size, request),
        { signal: request.signal, onProgress: options.onProgress, limit, media });
    } catch (error) {
      if ([401, 403, 404].includes(error.status)) clearCache();
      throw error;
    }
  }
  async function saveEditedCopy(entry, blob, options = {}) {
    const request = operation(options);
    cancelled(request.signal);
    const source = editableSource(entry);
    if (!(blob instanceof Blob) || blob.size > BLOB_DOWNLOAD_LIMIT) throw new Error(t(
      "The edited file is too large for the local editor.", "Die bearbeitete Datei ist zu groß für den lokalen Editor."));
    const details = await opened(source);
    cancelled(request.signal);
    const parentId = source.receivedShareId ? null : options.parentId === undefined ? source.parentId ?? null : options.parentId;
    if (parentId !== null) id(parentId);
    const file = new File([blob], options.name ?? editedVaultName(details.name), {
      type: blob.type || details.type || "application/octet-stream", lastModified: Date.now(),
    });
    // Upload always creates a fresh entry, content ID, key and nonce set. The
    // original and every existing owner/member/public share remain untouched.
    const result = await upload(file, parentId, request);
    cancelled(request.signal);
    return result;
  }
  return {
    list, upload, readBlob: (entry, options) => readPreview(entry, options),
    readMediaBlob: (entry, options) => readPreview(entry, options, true), saveEditedCopy,
    async createFolder(parentId, name, options = {}) {
      const entryId = crypto.randomUUID(); const prepared = await createFolder(user, entryId, name);
      return api("vault/entries", { ...operation(options), method: "POST", body: { id: entryId, parentId, kind: "folder", descriptor: null, envelope: prepared.envelope } });
    },
    async rename(entry, name, options = {}) {
      const details = await opened(entry);
      const envelope = await renameEntry(user, entry, details, name);
      return api("vault/entries/" + id(entry.id), { ...operation(options), method: "PATCH", body: { envelope } });
    },
    move: (entry, parentId, options) => api("vault/entries/" + id(entry.id), { ...operation(options), method: "PATCH", body: { parentId } }),
    delete: (entry, options) => api("vault/entries/" + id(entry.id), { ...operation(options), method: "DELETE" }),
    prepareDownload: entry => prepareVaultDownload(entry),
    download: entryDownload,
    recipients: (query, options) => api("vault/recipients?query=" + encodeURIComponent(query), operation(options)),
    listShares: (entry, options) => api("vault/entries/" + id(entry.id) + "/shares", operation(options)),
    async createShare(entry, { recipient, expiresIn = 604800, ...options } = {}) {
      const shareId = crypto.randomUUID(); const details = await opened(entry);
      const expiresAt = Date.now() + expiresIn * 1000;
      if (recipient) {
        const envelope = await sealMemberShare(user, entry, details, shareId, recipient);
        await api("vault/entries/" + id(entry.id) + "/shares", { ...operation(options), method: "POST", body: { id: shareId, recipientId: recipient.id, envelope, expiresAt } });
        return { id: shareId, expiresAt, recipientId: recipient.id };
      }
      const share = await createShare(entry, details, shareId);
      const ownerEnvelope = await sealShareLink(user, entry.id, shareId, share);
      await api("vault/entries/" + id(entry.id) + "/shares", { ...operation(options), method: "POST",
        body: { id: shareId, tokenHash: share.tokenHash, envelope: share.envelope, ownerEnvelope, expiresAt } });
      return { id: shareId, expiresAt, url: publicVaultLink(shareId, share.token, share.keyFragment) };
    },
    async shareLink(share) {
      const link = await openShareLink(user, share);
      cancelled(lifetimeSignal);
      return publicVaultLink(share.id, link.token, link.keyFragment);
    },
    revokeShare: (share, options) => api("vault/shares/" + id(share.id), { ...operation(options), method: "DELETE" }),
    close() {
      local.abort();
      clearCache();
      revokeVaultDownloads();
    },
  };
}

export async function openPublicVault(link, { signal } = {}) {
  id(link?.id);
  if (!SECRET.test(link?.token ?? "") || !SECRET.test(link?.keyFragment ?? "")) throw new Error(t("The sharing link is invalid.", "Der Freigabelink ist ungültig."));
  const result = await vaultRequest("vault/public/open", { method: "POST", body: { id: link.id, token: link.token }, signal, publicAccess: true });
  cancelled(signal);
  const opened = await openShare(result.share, link.keyFragment);
  try { cancelled(signal); } catch (error) { destroySecret(opened.secret); throw error; }
  const scope = new AbortController();
  const lifetime = combined(signal, scope.signal);
  lifetime.addEventListener("abort", () => destroySecret(opened.secret), { once: true });
  async function readPreview(options = {}, media = false) {
    const requestSignal = combined(lifetime, options.signal);
    cancelled(requestSignal);
    return readAuthenticatedBlob(opened, (index, size) => readVaultChunk("vault/public/" + id(link.id) + "/chunks/" + index, size,
      { signal: requestSignal, token: link.token, publicAccess: true }),
    { signal: requestSignal, onProgress: options.onProgress, limit: previewLimit(options.maxBytes, media), media });
  }
  return {
    opened, share: result.share,
    readBlob: options => readPreview(options), readMediaBlob: options => readPreview(options, true),
    prepareDownload: () => prepareVaultDownload(opened),
    download: options => saveVaultFile(opened, (index, size) => readVaultChunk("vault/public/" + id(link.id) + "/chunks/" + index,
      size, { signal: options?.signal ?? signal, token: link.token, publicAccess: true }), options),
    close: ({ revokeDownloads = true } = {}) => { scope.abort(); destroySecret(opened.secret); if (revokeDownloads) revokeVaultDownloads(); },
  };
}
