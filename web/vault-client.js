import { t } from "./i18n.js";
import { accountHeaders, api, checkAccountResponse } from "./ui.js";
import { CHUNK_SIZE, createFile, createFolder, openEntry, renameEntry, encryptChunk, decryptChunk, destroySecret,
  sealMemberShare, openMemberShare, createShare, openShare, sealShareLink, openShareLink, validateDescriptor } from "./vault-crypto.js";

export const BLOB_DOWNLOAD_LIMIT = 128 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const SECRET = /^[A-Za-z0-9_-]{43}$/u;
const downloads = new Set();
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
function safeDownloadName(value) {
  let name = String(value ?? "").replace(/[\/\\:*?"<>|\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, "_");
  if (/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(?:[ .]|$)/iu.test(name)) name = "_" + name;
  const encoder = new TextEncoder();
  let bounded = "", bytes = 0;
  for (const character of name) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > 240) break;
    bounded += character; bytes += size;
  }
  bounded = bounded.replace(/[. ]+$/u, "");
  return bounded && bounded !== "." && bounded !== ".." ? bounded : "Vault-download";
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

export async function uploadNativeVaultSelection(bridge, service, { parentId = null, signal, onProgress } = {}) {
  cancelled(signal);
  let archive;
  const abort = () => { void bridge.cancelArchive(archive?.id).catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    archive = await bridge.prepareArchive();
    if (!archive) throw new DOMException("Cancelled", "AbortError");
    cancelled(signal);
    const file = { name: archive.name, type: archive.type, size: archive.size, lastModified: 0,
      slice(start, end) { return { async arrayBuffer() {
        cancelled(signal);
        const bytes = await bridge.readArchive(archive.id, start, end - start);
        cancelled(signal);
        return bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      } }; } };
    return await service.upload(file, parentId, { signal, onProgress });
  } catch (error) { cancelled(signal); throw error; }
  finally {
    signal?.removeEventListener("abort", abort);
    // A declined native confirmation keeps the selection available for retry.
    // Explicit transfer cancellation above discards it even before an ID exists.
    if (archive?.id) await bridge.cancelArchive(archive.id).catch(() => {});
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
    const fingerprint = JSON.stringify({ id: entry.id, ownerId: entry.ownerId, kind: entry.kind, parentId: entry.parentId,
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
  return {
    list, upload,
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
  return {
    opened, share: result.share,
    prepareDownload: () => prepareVaultDownload(opened),
    download: options => saveVaultFile(opened, (index, size) => readVaultChunk("vault/public/" + id(link.id) + "/chunks/" + index,
      size, { signal: options?.signal ?? signal, token: link.token, publicAccess: true }), options),
    close: () => { destroySecret(opened.secret); revokeVaultDownloads(); },
  };
}
