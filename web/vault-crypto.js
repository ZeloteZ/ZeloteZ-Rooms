const SUITE = "zelotez-vault/1";
export const CHUNK_SIZE = 4 * 1024 * 1024;
export const MAX_FILE_SIZE = 1024 ** 4;
const MAX_HEADER_BYTES = 12 * 1024;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const handles = new WeakMap();
const openings = new WeakMap();
const live = new Set();
let generation = 0;

function message(en, de, zh) {
  const language = globalThis.document?.documentElement?.lang;
  return language === "de" ? de : language === "zh-CN" ? zh : en;
}
function invalid() {
  return new Error(message("Vault content could not be authenticated.",
    "Der Vault-Inhalt konnte nicht verifiziert werden.", "无法验证 Vault 内容。"));
}
function locked() {
  return new Error(message("Unlock your session again.", "Entsperre deine Sitzung erneut.", "请重新解锁会话。"));
}
function aborted() { return new DOMException("The operation was cancelled.", "AbortError"); }
function uuid(value) { if (typeof value !== "string" || !UUID.test(value)) throw invalid(); return value; }
function base64(bytes) {
  let value = "";
  for (let i = 0; i < bytes.byteLength; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function binary(value, expected) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) throw invalid();
  let bytes;
  try { bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0)); }
  catch { throw invalid(); }
  if ((expected !== undefined && bytes.byteLength !== expected) || base64(bytes) !== value) throw invalid();
  return bytes;
}
function random(length) { return crypto.getRandomValues(new Uint8Array(length)); }
function data(...parts) { return encoder.encode(JSON.stringify([SUITE, ...parts])); }
function aead(iv, additionalData) { return { name: "AES-GCM", iv, additionalData, tagLength: 128 }; }
function key(bytes) { return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]); }
function bytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw invalid();
}
export function validateDescriptor(input) {
  if (!input || input.v !== 1 || !Number.isSafeInteger(input.size) || input.size < 0 || input.size > MAX_FILE_SIZE ||
      input.chunkSize !== CHUNK_SIZE) throw invalid();
  const id = uuid(input.id);
  binary(input.contentId, 32);
  const chunks = Math.max(1, Math.ceil(input.size / CHUNK_SIZE));
  const cipherSize = input.size + chunks * 28;
  if (input.chunks !== chunks || input.cipherSize !== cipherSize) throw invalid();
  return Object.freeze({ v: 1, id, contentId: input.contentId, size: input.size, chunkSize: CHUNK_SIZE, chunks, cipherSize });
}
function sameDescriptor(first, second) {
  return JSON.stringify(validateDescriptor(first)) === JSON.stringify(validateDescriptor(second));
}
export function validateName(value) {
  if (typeof value !== "string" || !value.trim() || value === "." || value === ".." ||
      /[\/\\\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value) || encoder.encode(value).byteLength > 255) {
    throw new Error(message("Use a file or folder name without path separators or control characters (up to 255 bytes).",
      "Verwende einen Datei- oder Ordnernamen ohne Pfadtrenner und Steuerzeichen (höchstens 255 Bytes).",
      "文件或文件夹名称不能含路径分隔符或控制字符，且不能超过 255 字节。"));
  }
  return value;
}
function mime(value) {
  if (typeof value !== "string" || value.length > 128 || !/^[\x20-\x7e]*$/u.test(value)) throw invalid();
  return value || "application/octet-stream";
}
function active(user) {
  uuid(user?.id);
  const session = globalThis.ClubCrypto?.deviceUnlockKey(user.id);
  if (!session) throw locked();
  const current = generation;
  return () => {
    if (generation !== current || globalThis.ClubCrypto?.deviceUnlockKey(user.id) !== session) throw locked();
  };
}
function createSecret(raw, descriptor, guard, writable = false) {
  if (raw.byteLength !== 32) throw invalid();
  const handle = Object.freeze({});
  const state = { raw, descriptor, guard, generation, used: writable ? new Set() : null, closed: false, imported: null };
  handles.set(handle, state);
  live.add(handle);
  return handle;
}
export function destroySecret(handle) {
  const state = handles.get(handle);
  if (state) { state.closed = true; state.raw.fill(0); state.imported = null; }
  handles.delete(handle);
  live.delete(handle);
}
export function clearVaultKeys() {
  generation += 1;
  for (const handle of live) destroySecret(handle);
}
function secretState(handle, descriptor) {
  const state = handles.get(handle);
  if (!state || state.closed || state.generation !== generation) throw aborted();
  state.guard?.();
  if (!sameDescriptor(descriptor, state.descriptor)) throw invalid();
  return state;
}
function stillCurrent(state) {
  if (state.closed || state.generation !== generation) throw aborted();
  state.guard?.();
}
async function chunkKey(state) {
  stillCurrent(state);
  state.imported ||= key(state.raw);
  const imported = await state.imported;
  stillCurrent(state);
  return imported;
}
function chunkLength(descriptor, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= descriptor.chunks) throw invalid();
  return Math.min(CHUNK_SIZE, descriptor.size - index * CHUNK_SIZE);
}
function chunkData(descriptor, index) {
  return data("chunk", descriptor.id, descriptor.contentId, index, descriptor.chunks, descriptor.size, descriptor.chunkSize, descriptor.cipherSize);
}
export async function encryptChunk(secret, candidate, index, input) {
  const descriptor = validateDescriptor(candidate);
  const state = secretState(secret, descriptor);
  const source = bytes(input);
  if (source.byteLength !== chunkLength(descriptor, index) || !state.used || state.used.has(index)) throw invalid();
  // A retry must resend the same ciphertext. Never re-encrypt alternate content
  // at an existing index under this file's authenticated manifest.
  state.used.add(index);
  const plaintext = Uint8Array.from(source);
  try {
    const imported = await chunkKey(state);
    const iv = random(12);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(aead(iv, chunkData(descriptor, index)), imported, plaintext));
    try { stillCurrent(state); }
    catch (error) { ciphertext.fill(0); throw error; }
    const result = new Uint8Array(ciphertext.byteLength + 12);
    result.set(iv); result.set(ciphertext, 12);
    return result;
  } finally { plaintext.fill(0); }
}
export async function decryptChunk(secret, candidate, index, input) {
  const descriptor = validateDescriptor(candidate);
  const state = secretState(secret, descriptor);
  const ciphertext = bytes(input);
  if (ciphertext.byteLength !== chunkLength(descriptor, index) + 28) throw invalid();
  const imported = await chunkKey(state);
  let plaintext;
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt(aead(ciphertext.subarray(0, 12), chunkData(descriptor, index)), imported, ciphertext.subarray(12)));
    stillCurrent(state);
    return plaintext;
  } catch (error) {
    plaintext?.fill(0);
    if (error.name === "AbortError") throw error;
    throw invalid();
  }
}
function metadata(value, expected, shareId) {
  if (!value || value.v !== 1 || value.ownerId !== expected.ownerId || value.id !== expected.id || value.kind !== expected.kind ||
      (shareId === undefined ? Object.hasOwn(value, "shareId") : value.shareId !== shareId)) throw invalid();
  const name = validateName(value.name);
  if (value.kind === "folder") {
    if (value.descriptor !== null || value.key !== null || value.mime !== "" || value.modifiedAt !== 0) throw invalid();
    return { v: 1, ownerId: value.ownerId, id: value.id, kind: "folder", name, mime: "", modifiedAt: 0, descriptor: null };
  }
  if (!sameDescriptor(value.descriptor, expected.descriptor) || value.descriptor.id !== value.id ||
      !Number.isSafeInteger(value.modifiedAt) || value.modifiedAt < 0) throw invalid();
  binary(value.key, 32);
  return { v: 1, ownerId: value.ownerId, id: value.id, kind: "file", name, mime: mime(value.mime), modifiedAt: value.modifiedAt,
    descriptor: validateDescriptor(value.descriptor) };
}
function makeOpened(meta, raw, guard, writable = false) {
  const secret = meta.kind === "file" ? createSecret(raw, meta.descriptor, guard, writable) : null;
  const opened = Object.freeze({ id: meta.id, ownerId: meta.ownerId, kind: meta.kind, name: meta.name,
    type: meta.mime, modifiedAt: meta.modifiedAt, descriptor: meta.descriptor, secret });
  openings.set(opened, { meta, guard, generation });
  return opened;
}
function content(opened, shareId) {
  const record = openings.get(opened);
  if (!record || record.generation !== generation) throw aborted();
  record.guard?.();
  const raw = opened.kind === "file" ? secretState(opened.secret, opened.descriptor).raw : null;
  return { ...record.meta, key: raw ? base64(raw) : null, ...(shareId === undefined ? {} : { shareId }) };
}
function entryExpectation(user, entry) {
  uuid(user?.id); uuid(entry?.id);
  if (entry.kind !== "file" && entry.kind !== "folder") throw invalid();
  if (entry.ownerId !== undefined && entry.ownerId !== user.id) throw invalid();
  if (entry.kind === "folder" && entry.descriptor !== null) throw invalid();
  return { ownerId: user.id, id: entry.id, kind: entry.kind,
    descriptor: entry.kind === "file" ? validateDescriptor(entry.descriptor) : null };
}
async function sealOwner(user, id, value, guard) {
  guard();
  const result = await ClubCrypto.sealVaultMessage(`${SUITE}/owner/${user.id}`, id, value, [{ id: user.id, publicKey: user.publicKey }]);
  guard();
  return result.envelope;
}
export async function createFile(user, id, file) {
  const guard = active(user);
  uuid(id);
  const descriptor = validateDescriptor({ v: 1, id, contentId: base64(random(32)), size: file.size,
    chunkSize: CHUNK_SIZE, chunks: Math.max(1, Math.ceil(file.size / CHUNK_SIZE)),
    cipherSize: file.size + Math.max(1, Math.ceil(file.size / CHUNK_SIZE)) * 28 });
  const modifiedAt = Number.isSafeInteger(file.lastModified) && file.lastModified >= 0 ? file.lastModified : 0;
  const meta = { v: 1, ownerId: user.id, id, kind: "file", name: validateName(file.name), mime: mime(file.type || ""), modifiedAt, descriptor };
  const opened = makeOpened(meta, random(32), guard, true);
  try {
    const envelope = await sealOwner(user, id, content(opened), guard);
    return { descriptor, envelope, secret: opened.secret, opened };
  } catch (error) { destroySecret(opened.secret); throw error; }
}
export async function createFolder(user, id, name) {
  const guard = active(user); uuid(id);
  const meta = { v: 1, ownerId: user.id, id, kind: "folder", name: validateName(name), mime: "", modifiedAt: 0, descriptor: null };
  const opened = makeOpened(meta, null, guard);
  return { envelope: await sealOwner(user, id, content(opened), guard), opened };
}
export async function openEntry(user, entry) {
  const guard = active(user);
  const expected = entryExpectation(user, entry);
  const result = await ClubCrypto.openVaultMessage(`${SUITE}/owner/${user.id}`, entry.id, entry.envelope, user);
  guard();
  if (!result) throw invalid();
  const meta = metadata(result.content, expected);
  return makeOpened(meta, meta.kind === "file" ? binary(result.content.key, 32) : null, guard);
}
export async function renameEntry(user, entry, opened, name) {
  const guard = active(user);
  const expected = entryExpectation(user, entry);
  const next = { ...content(opened), name: validateName(name) };
  metadata(next, expected);
  return sealOwner(user, entry.id, next, guard);
}
function shareExpectation(share) {
  uuid(share?.id); uuid(share?.entryId); uuid(share?.ownerId);
  return { ownerId: share.ownerId, id: share.entryId, kind: "file", descriptor: validateDescriptor(share.descriptor) };
}
function shareContent(entry, opened, shareId) {
  uuid(shareId); uuid(entry?.id);
  if (entry.kind !== "file" || opened.kind !== "file" || entry.id !== opened.id || !sameDescriptor(entry.descriptor, opened.descriptor)) throw invalid();
  const value = content(opened, shareId);
  metadata(value, { ownerId: opened.ownerId, id: entry.id, kind: "file", descriptor: entry.descriptor }, shareId);
  return value;
}
function publicShareData(shareId, entryId, descriptor) {
  return data("public share", uuid(shareId), uuid(entryId), validateDescriptor(descriptor));
}
function encryptedHeader(envelope) {
  if (envelope?.v !== 1 || typeof envelope.body !== "string" || envelope.body.length > MAX_HEADER_BYTES * 2) throw invalid();
  const iv = binary(envelope.nonce, 12), body = binary(envelope.body);
  if (body.byteLength < 16 || body.byteLength > MAX_HEADER_BYTES) throw invalid();
  return { iv, body };
}
export async function capabilityHash(token) {
  binary(token, 32);
  return base64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token))));
}
export async function createShare(entry, opened, shareId) {
  const value = shareContent(entry, opened, shareId);
  const state = secretState(opened.secret, opened.descriptor);
  const raw = random(32), token = base64(random(32)), keyFragment = base64(raw), iv = random(12);
  if (token === keyFragment) { raw.fill(0); throw invalid(); }
  const plaintext = encoder.encode(JSON.stringify(value));
  try {
    const imported = await key(raw);
    stillCurrent(state);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(aead(iv, publicShareData(shareId, entry.id, entry.descriptor)), imported, plaintext));
    stillCurrent(state);
    const tokenHash = await capabilityHash(token);
    stillCurrent(state);
    return { envelope: { v: 1, nonce: base64(iv), body: base64(ciphertext) }, keyFragment, token, tokenHash };
  } finally { raw.fill(0); plaintext.fill(0); }
}
export async function openShare(share, keyFragment) {
  const expected = shareExpectation(share);
  const { iv, body } = encryptedHeader(share.envelope);
  const raw = binary(keyFragment, 32), current = generation;
  let plaintext;
  try {
    const imported = await key(raw);
    if (generation !== current) throw aborted();
    plaintext = new Uint8Array(await crypto.subtle.decrypt(aead(iv, publicShareData(share.id, share.entryId, share.descriptor)), imported, body));
    if (generation !== current) throw aborted();
    const value = JSON.parse(decoder.decode(plaintext));
    const meta = metadata(value, expected, share.id);
    return makeOpened(meta, binary(value.key, 32), null);
  } catch (error) { if (error.name === "AbortError") throw error; throw invalid(); }
  finally { raw.fill(0); plaintext?.fill(0); }
}
export async function sealMemberShare(user, entry, opened, shareId, recipient) {
  const guard = active(user);
  if (opened.ownerId !== user.id || recipient?.id === user.id) throw invalid();
  uuid(recipient?.id);
  const value = shareContent(entry, opened, shareId);
  const result = await ClubCrypto.sealVaultMessage(`${SUITE}/member/${user.id}/${entry.id}`, shareId, value,
    [{ id: user.id, publicKey: user.publicKey }, { id: recipient.id, publicKey: recipient.publicKey }]);
  guard();
  return result.envelope;
}
export async function openMemberShare(user, share) {
  const guard = active(user), expected = shareExpectation(share);
  if (share.ownerId !== user.id && share.owner?.id !== share.ownerId) throw invalid();
  const result = await ClubCrypto.openVaultMessage(`${SUITE}/member/${share.ownerId}/${share.entryId}`, share.id, share.envelope,
    share.ownerId === user.id ? user : share.owner);
  guard();
  if (!result) throw invalid();
  const meta = metadata(result.content, expected, share.id);
  return makeOpened(meta, binary(result.content.key, 32), guard);
}
export async function sealShareLink(user, entryId, shareId, { token, keyFragment }) {
  const guard = active(user); uuid(entryId); uuid(shareId); binary(token, 32); binary(keyFragment, 32);
  const result = await ClubCrypto.sealVaultMessage(`${SUITE}/public-link/${user.id}/${entryId}`, shareId,
    { v: 1, ownerId: user.id, entryId, shareId, token, keyFragment }, [{ id: user.id, publicKey: user.publicKey }]);
  guard(); return result.envelope;
}
export async function openShareLink(user, share) {
  const guard = active(user); uuid(share?.entryId); uuid(share?.id);
  const result = await ClubCrypto.openVaultMessage(`${SUITE}/public-link/${user.id}/${share.entryId}`, share.id, share.ownerEnvelope, user);
  guard();
  const value = result?.content;
  if (value?.v !== 1 || value.ownerId !== user.id || value.entryId !== share.entryId || value.shareId !== share.id) throw invalid();
  binary(value.token, 32); binary(value.keyFragment, 32);
  return { token: value.token, keyFragment: value.keyFragment };
}
export async function* encryptChunks(file, secret, candidate, { signal } = {}) {
  const descriptor = validateDescriptor(candidate);
  if (file.size !== descriptor.size || typeof file.slice !== "function") throw invalid();
  for (let index = 0; index < descriptor.chunks; index += 1) {
    signal?.throwIfAborted();
    const plaintext = new Uint8Array(await file.slice(index * CHUNK_SIZE, Math.min((index + 1) * CHUNK_SIZE, file.size)).arrayBuffer());
    try {
      signal?.throwIfAborted();
      const ciphertext = await encryptChunk(secret, descriptor, index, plaintext);
      signal?.throwIfAborted();
      yield { index, ciphertext };
    } finally { plaintext.fill(0); }
  }
}
