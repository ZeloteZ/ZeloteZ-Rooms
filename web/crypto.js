"use strict";

window.ClubCrypto = (() => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const subtle = crypto.subtle;
  const suite = "zelotez-live/1";
  const errorText = (en, de) => globalThis.document?.documentElement?.lang === "de" ? de : en;
  const curve = { name: "ECDH", namedCurve: "P-256" };
  const cacheName = `${suite}/vault`;
  const pinnedKeys = new Map();
  let active = null;

  function base64(bytes) {
    const source = new Uint8Array(bytes);
    let binary = "";
    for (let offset = 0; offset < source.length; offset += 8192) {
      binary += String.fromCharCode(...source.subarray(offset, offset + 8192));
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  }

  function binary(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error(errorText("Invalid key or content.", "Ungültiger Schlüssel oder Inhalt."));
    return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));
  }

  const aad = (...parts) => encoder.encode(JSON.stringify([suite, ...parts]));
  const nonce = () => crypto.getRandomValues(new Uint8Array(12));
  const aesKey = bytes => subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  const aead = (iv, additionalData) => ({ name: "AES-GCM", iv, additionalData, tagLength: 128 });

  async function expand(material, context, label) {
    const hkdf = await subtle.importKey("raw", material, "HKDF", false, ["deriveBits"]);
    return subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: context, info: aad(label) }, hkdf, 256);
  }

  async function accountMaterial(username, passphrase) {
    const account = username.trim().toLowerCase();
    const origin = location.origin;
    const salt = aad("account", origin, account);
    const secret = await subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
    const material = await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 600000 }, secret, 256);
    return { material, salt };
  }

  async function credential(username, passphrase) {
    const { material, salt } = await accountMaterial(username, passphrase);
    return base64(await expand(material, salt, "login"));
  }

  function publicPoint({ kty, crv, x, y }) {
    if (kty !== "EC" || crv !== "P-256" || binary(x).length !== 32 || binary(y).length !== 32) {
      throw new Error(errorText("The public key is invalid.", "Der öffentliche Schlüssel ist ungültig."));
    }
    return { kty, crv, x, y };
  }

  function pin(userId, key) {
    const fingerprint = `${key.x}.${key.y}`;
    const storageName = `${suite}/identity/${userId}`;
    let previous = pinnedKeys.get(userId);
    try {
      previous ||= localStorage.getItem(storageName);
      if (!previous) localStorage.setItem(storageName, fingerprint);
    } catch {
      // Browsers with disabled storage keep keys only for the current tab.
    }
    if (previous && previous !== fingerprint) throw new Error(errorText("A member’s key has changed.", "Der Schlüssel eines Mitglieds hat sich geändert."));
    pinnedKeys.set(userId, fingerprint);
  }

  async function prepareRegistration(username, passphrase) {
    const { material, salt } = await accountMaterial(username, passphrase);
    const [login, vault, pair] = await Promise.all([
      expand(material, salt, "login"), expand(material, salt, "identity"),
      subtle.generateKey(curve, true, ["deriveBits"]),
    ]);
    const pub = publicPoint(await subtle.exportKey("jwk", pair.publicKey));
    const secret = await subtle.exportKey("jwk", pair.privateKey);
    const iv = nonce();
    const encrypted = await subtle.encrypt(aead(iv, aad("identity", pub.x, pub.y)), await aesKey(vault),
      encoder.encode(JSON.stringify(secret)));
    return { password: base64(login), publicKey: pub, identity: { v: 1, nonce: base64(iv), blob: base64(encrypted) } };
  }

  function lock() {
    active = null;
    try { sessionStorage.removeItem(cacheName); } catch { /* Storage may be disabled. */ }
  }

  async function unlock(user, passphrase) {
    try {
      const pub = publicPoint(user.publicKey);
      if (user.identity?.v !== 1) throw new Error(errorText("Unknown key.", "Unbekannter Schlüssel."));
      let vault;
      if (typeof passphrase === "string") {
        const { material, salt } = await accountMaterial(user.username, passphrase);
        vault = await expand(material, salt, "identity");
      } else {
        const cached = JSON.parse(sessionStorage.getItem(cacheName));
        if (cached?.id !== user.id) return false;
        vault = binary(cached.vault);
      }
      const secret = await subtle.decrypt(aead(binary(user.identity.nonce), aad("identity", pub.x, pub.y)),
        await aesKey(vault), binary(user.identity.blob));
      const jwk = JSON.parse(decoder.decode(secret));
      if (jwk.x !== pub.x || jwk.y !== pub.y) throw new Error(errorText("Wrong key.", "Falscher Schlüssel."));
      const key = await subtle.importKey("jwk", jwk, curve, false, ["deriveBits"]);
      pin(user.id, pub);
      active = { id: user.id, key };
      try { sessionStorage.setItem(cacheName, JSON.stringify({ id: user.id, vault: base64(vault) })); } catch { /* Optional cache. */ }
      return true;
    } catch {
      lock();
      return false;
    }
  }

  async function recipientKey(privateKey, publicKey, link) {
    const key = await subtle.importKey("jwk", publicPoint(publicKey), curve, false, []);
    const secret = await subtle.deriveBits({ name: "ECDH", public: key }, privateKey, 256);
    return aesKey(await expand(secret, link, "message key"));
  }

  async function unwrapMessageKey(privateKey, publicKey, link, box) {
    const wrap = await recipientKey(privateKey, publicKey, link);
    return new Uint8Array(await subtle.decrypt(aead(binary(box.nonce), link), wrap, binary(box.blob)));
  }

  async function sealMessage(channelId, messageId, content, recipients) {
    if (!active || !recipients.some(({ id }) => id === active.id)) throw new Error(errorText("Unlock your session again.", "Entsperre deine Sitzung erneut."));
    const pair = await subtle.generateKey(curve, true, ["deriveBits"]);
    const ephemeral = publicPoint(await subtle.exportKey("jwk", pair.publicKey));
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const key = await aesKey(rawKey);
    const iv = nonce();
    const body = await subtle.encrypt(aead(iv, aad("message", channelId, messageId)), key, encoder.encode(JSON.stringify(content)));
    const boxes = await Promise.all(recipients.map(async ({ id, publicKey }) => {
      const pub = publicPoint(publicKey);
      pin(id, pub);
      const link = aad("recipient", channelId, messageId, id);
      const wrap = await recipientKey(pair.privateKey, pub, link);
      const iv = nonce();
      const blob = await subtle.encrypt(aead(iv, link), wrap, rawKey);
      return [id, { nonce: base64(iv), blob: base64(blob) }];
    }));
    rawKey.fill(0);
    return { envelope: { v: 1, ephemeral, nonce: base64(iv), body: base64(body), keys: Object.fromEntries(boxes) }, key };
  }

  async function wrapHistoryKey(channelId, entry, recipient) {
    const identity = active;
    if (!identity) throw new Error(errorText("Unlock your session again.", "Entsperre deine Sitzung erneut."));
    const pub = publicPoint(recipient.publicKey);
    pin(recipient.id, pub);
    const pair = await subtle.generateKey(curve, true, ["deriveBits"]);
    const ephemeral = publicPoint(await subtle.exportKey("jwk", pair.publicKey));
    const link = aad("history recipient", channelId, entry.id, recipient.id, identity.id);
    const wrap = await recipientKey(pair.privateKey, pub, link);
    const source = entry.grantorId ? aad("history recipient", channelId, entry.id, identity.id, entry.grantorId)
      : aad("recipient", channelId, entry.id, identity.id);
    const rawKey = await unwrapMessageKey(identity.key, entry.ephemeral, source, entry);
    try {
      const iv = nonce();
      const blob = await subtle.encrypt(aead(iv, link), wrap, rawKey);
      if (active !== identity) throw new Error(errorText("Unlock your session again.", "Entsperre deine Sitzung erneut."));
      return { v: 1, ephemeral, nonce: base64(iv), blob: base64(blob) };
    } finally {
      rawKey.fill(0);
    }
  }

  async function openMessage(channelId, messageId, envelope) {
    const identity = active;
    if (!identity) throw new Error(errorText("Unlock your session again.", "Entsperre deine Sitzung erneut."));
    const original = envelope?.keys?.[identity.id];
    const grant = envelope?.historyGrant;
    if (!original && !grant) return null;
    if (envelope.v !== 1 || (!original && grant.v !== 1)) throw new Error(errorText("Unknown message format.", "Unbekanntes Nachrichtenformat."));
    const link = original ? aad("recipient", channelId, messageId, identity.id)
      : aad("history recipient", channelId, messageId, identity.id, grant.grantorId);
    const rawKey = await unwrapMessageKey(identity.key, original ? envelope.ephemeral : grant.ephemeral, link, original ?? grant);
    try {
      const key = await aesKey(rawKey);
      const content = await subtle.decrypt(aead(binary(envelope.nonce), aad("message", channelId, messageId)), key, binary(envelope.body));
      if (active !== identity) throw new Error(errorText("Unlock your session again.", "Entsperre deine Sitzung erneut."));
      return { content: JSON.parse(decoder.decode(content)), key };
    } finally {
      rawKey.fill(0);
    }
  }

  async function encryptFile(key, attachmentId, file) {
    const iv = nonce();
    const ciphertext = await subtle.encrypt(aead(iv, aad("attachment", attachmentId)), key, await file.arrayBuffer());
    const result = new Uint8Array(iv.length + ciphertext.byteLength);
    result.set(iv);
    result.set(new Uint8Array(ciphertext), iv.length);
    return result.buffer;
  }

  function decryptFile(key, attachmentId, buffer) {
    const bytes = new Uint8Array(buffer);
    return subtle.decrypt(aead(bytes.subarray(0, 12), aad("attachment", attachmentId)), key, bytes.subarray(12));
  }

  function deletionScope(id) {
    return id + "/deletion";
  }

  return { prepareRegistration, credential, unlock, lock, sealMessage, wrapHistoryKey, openMessage, encryptFile, decryptFile, deletionScope };
})();
