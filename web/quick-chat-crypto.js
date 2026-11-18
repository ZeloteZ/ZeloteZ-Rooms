const suite = "zelotez-rooms/quick-chat/v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const curve = { name: "ECDH", namedCurve: "P-256" };
const keyLifetime = 12 * 60 * 60_000;
const keyStore = "devices";
const resident = new Map();
const messageId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

function encode(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decode(value) {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));
}

function context(...parts) {
  return encoder.encode(JSON.stringify([suite, ...parts]));
}

async function encrypt(key, plaintext, additionalData) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const blob = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, plaintext);
  return { nonce: encode(iv), blob: encode(blob) };
}

function decrypt(key, envelope, additionalData) {
  const iv = decode(envelope.nonce);
  if (iv.length !== 12) throw new Error("Invalid chat nonce");
  return crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData }, key, decode(envelope.blob));
}

function storageKey(roomId, member, accountId) {
  if (!member) return "guest:" + roomId;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(accountId ?? "")) {
    throw new Error("Member chat requires an account");
  }
  return "member:" + accountId + ":" + roomId;
}

const usableDevice = value => value?.expiresAt > Date.now() && value.pair?.privateKey && value.pair.publicKey;

async function newDevice() {
  return { deviceId: crypto.randomUUID(), pair: await crypto.subtle.generateKey(curve, false, ["deriveBits"]), expiresAt: Date.now() + keyLifetime };
}

async function changeDeviceStore(operation, signal) {
  signal?.throwIfAborted();
  if (!globalThis.indexedDB) throw new Error("Local chat key storage is unavailable");
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("zelotez-rooms-quick-chat", 1);
    request.onupgradeneeded = () => request.result.createObjectStore(keyStore);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Local chat key storage is busy"));
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(keyStore, "readwrite");
      let result;
      const abort = () => transaction.abort();
      const cleanup = () => signal?.removeEventListener("abort", abort);
      transaction.oncomplete = () => { cleanup(); resolve(result); };
      transaction.onabort = () => { cleanup(); reject(signal?.aborted ? signal.reason : transaction.error); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      operation(transaction.objectStore(keyStore), value => { result = value; });
    });
  } finally {
    db.close();
  }
}

async function roomDevice(key, { legacyKey, accountId, proveLegacy, signal } = {}) {
  signal?.throwIfAborted();
  if (usableDevice(resident.get(key))) return resident.get(key);
  const saved = await changeDeviceStore((store, finish) => {
    const request = store.get(key);
    request.onsuccess = () => {
      if (usableDevice(request.result) || !legacyKey) finish({ scoped: request.result });
      else {
        const previous = store.get(legacyKey);
        previous.onsuccess = () => finish({ legacy: previous.result });
      }
    };
  }, signal).catch(() => { signal?.throwIfAborted(); return {}; });
  if (usableDevice(saved.scoped)) {
    resident.set(key, saved.scoped);
    return saved.scoped;
  }
  const legacy = saved.legacy ?? resident.get(legacyKey);
  if (usableDevice(legacy) && typeof proveLegacy === "function") {
    const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", legacy.pair.publicKey);
    // An old room-only key has no account label. Claim it only after the server confirms
    // the current account/session owns that exact device and public key.
    if (await proveLegacy({ deviceId: legacy.deviceId, publicKey: { kty, crv, x, y } })) {
      signal?.throwIfAborted();
      const promoted = { ...legacy, accountId };
      const record = await changeDeviceStore((store, finish) => {
        const current = store.get(key);
        current.onsuccess = () => {
          if (usableDevice(current.result)) return finish(current.result);
          const previous = store.get(legacyKey);
          previous.onsuccess = () => {
            if (previous.result?.deviceId === legacy.deviceId) store.delete(legacyKey);
            store.put(promoted, key);
            finish(promoted);
          };
        };
      }, signal).catch(() => { signal?.throwIfAborted(); return promoted; });
      signal?.throwIfAborted();
      resident.delete(legacyKey);
      resident.set(key, record);
      return record;
    }
  }
  // Unclaimed legacy keys stay quarantined until their owner can prove access or they expire.
  const candidate = { ...await newDevice(), ...(accountId && { accountId }) };
  const record = await changeDeviceStore((store, finish) => {
    const request = store.get(key);
    request.onsuccess = () => {
      const existing = request.result;
      if (existing?.expiresAt > Date.now() && existing.pair?.privateKey) finish(existing);
      else {
        store.put(candidate, key);
        finish(candidate);
      }
    };
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) return;
      if (entry.value.expiresAt <= Date.now()) entry.delete();
      entry.continue();
    };
  }, signal).catch(() => { signal?.throwIfAborted(); return usableDevice(resident.get(key)) ? resident.get(key) : candidate; });
  signal?.throwIfAborted();
  resident.set(key, record);
  return record;
}

export async function forgetQuickChatDevice(roomId, member, deviceId, accountId) {
  const key = storageKey(roomId, member, accountId);
  if (deviceId === undefined || resident.get(key)?.deviceId === deviceId) resident.delete(key);
  await changeDeviceStore(store => {
    const request = store.get(key);
    request.onsuccess = () => {
      if (deviceId === undefined || request.result?.deviceId === deviceId) store.delete(key);
    };
  }).catch(() => {});
}

export async function forgetMemberQuickChatDevices(accountId) {
  const prefix = accountId ? "member:" + accountId + ":" : "member:";
  for (const key of resident.keys()) if (key.startsWith(prefix)) resident.delete(key);
  await changeDeviceStore(store => {
    const request = store.openKeyCursor(IDBKeyRange.bound(prefix, prefix + "\uffff"));
    request.onsuccess = () => {
      const current = request.result;
      if (!current) return;
      store.delete(current.primaryKey);
      current.continue();
    };
  }).catch(() => {});
}

export async function createQuickChatCrypto(roomId, options) {
  const { deviceId, pair } = options ? await roomDevice(storageKey(roomId, options.member, options.accountId), {
    signal: options.signal,
    ...(options.member && { legacyKey: "member:" + roomId, accountId: options.accountId, proveLegacy: options.proveLegacy }),
  }) : await newDevice();
  const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const salt = context("room", roomId);

  async function wrappingKey(publicKey, additionalData, usage) {
    const peerKey = await crypto.subtle.importKey("jwk", publicKey, curve, false, []);
    const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: curve.name, public: peerKey }, pair.privateKey, 256));
    try {
      const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
      return await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: additionalData }, material,
        { name: "AES-GCM", length: 256 }, false, [usage]);
    } finally {
      secret.fill(0);
    }
  }

  async function seal(id, text, peers, replyTo) {
    const plaintext = encoder.encode(text);
    if (plaintext.length > 4096) throw new Error("Chat message is too long");
    if (replyTo !== undefined && !messageId.test(replyTo)) throw new Error("Invalid quoted message");
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    try {
      const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
      const ciphertext = await encrypt(key, plaintext, context("message", roomId, id, deviceId));
      const reply = replyTo && await encrypt(key, encoder.encode(replyTo), context("reply", roomId, id, deviceId));
      const wraps = await Promise.all(peers.map(async peer => {
        const additionalData = context("recipient", roomId, id, deviceId, peer.id);
        const key = await wrappingKey(peer.publicKey, additionalData, "encrypt");
        return [peer.id, await encrypt(key, rawKey, additionalData)];
      }));
      return { ...ciphertext, keys: Object.fromEntries(wraps), ...(reply && { reply }) };
    } finally {
      rawKey.fill(0);
      plaintext.fill(0);
    }
  }

  async function open({ id, from, publicKey, envelope }, { includeReply = false } = {}) {
    const additionalData = context("recipient", roomId, id, from, deviceId);
    const wrapping = await wrappingKey(publicKey, additionalData, "decrypt");
    const rawKey = new Uint8Array(await decrypt(wrapping, envelope.key, additionalData));
    try {
      if (rawKey.length !== 32) throw new Error("Invalid chat key");
      const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
      const text = decoder.decode(await decrypt(key, envelope, context("message", roomId, id, from)));
      if (!includeReply) return text;
      let replyTo;
      if (envelope.reply) {
        try {
          const candidate = decoder.decode(await decrypt(key, envelope.reply, context("reply", roomId, id, from)));
          if (messageId.test(candidate) && candidate !== id) replyTo = candidate;
        } catch { /* Keep the text readable if optional reply metadata cannot be authenticated. */ }
      }
      return { text, replyTo };
    } finally {
      rawKey.fill(0);
    }
  }

  return { deviceId, publicKey: { kty, crv, x, y }, seal, open };
}
