"use strict";

window.ClubCrypto = (() => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const subtle = crypto.subtle;
  const suite = "zelotez-live/1";
  const errorText = (en, de, zh) => {
    const language = globalThis.document?.documentElement?.lang;
    if (language === "de") return de;
    return language === "zh-CN" ? zh : en;
  };
  const curve = { name: "ECDH", namedCurve: "P-256" };
  const cacheName = `${suite}/vault`;
  const pinnedKeys = new Map();
  const reactionKeys = new WeakMap();
  const failedHistoryKeys = new EventTarget();
  let active = null;
  const commonPasswords = new Set([
    "password", "password1", "password123", "password1234", "password12345", "password123456", "password12345678",
    "password123456789", "password1234567890", "passwordpassword123", "passw0rd", "passwort", "passwort123",
    "passwort12345678", "meinpasswort12345", "diesistmeinpasswort", "sicherespasswort", "geheimespasswort",
    "qwerty", "qwerty123", "qwertyuiop", "qwertyuiopasdfgh", "qwertyuiopasdfghjkl", "qwertyuiop123456",
    "123456", "123456789", "123456789012345", "1234567890123456", "12345678901234567890", "0123456789012345",
    "123451234512345", "123456789123456789", "abcdefghijklmnopqrstuvwxyz", "abcdefghijklmnopqrstuvwxyz1234567890",
    "letmein", "welcome", "welcome123", "welcometotheclub", "admin", "administrator", "administrator123",
    "changeme", "changeme123456789", "iloveyou", "iloveyou123456789", "thisismypassword", "thisisasecretpassword",
    "mysecurepassword", "supersecretpassword", "securepassword123", "verysecurepassword", "verystrongpassword",
    "correcthorsebatterystaple", "zelotezrooms12345", "zelotezroomspassword", "woaini", "woaini1314520",
  ]);
  const repeatedPasswords = ["password", "passwort", "qwerty", "12345", "123456", "1234567890", "letmein", "iloveyou", "welcome", "admin", "woaini"];

  function assertNewPassword(passphrase) {
    if (typeof passphrase !== "string" || [...passphrase].length < 15) {
      throw new Error(errorText("Use at least 15 characters for your new password.",
        "Verwende mindestens 15 Zeichen für dein neues Passwort.", "新密码至少需要 15 个字符。"));
    }
    // Normalize only for the local denylist, never for encryption or existing sign-in.
    const comparison = passphrase.normalize("NFKC").toLowerCase().replace(/\s/gu, "");
    const base = comparison.replace(/[.!?_-]+$/u, "");
    if (!comparison || /^(.)\1{14,}$/u.test(comparison) || commonPasswords.has(base) ||
        repeatedPasswords.some(word => base.length >= word.length * 2 && base === word.repeat(base.length / word.length))) {
      throw new Error(errorText("This password is too common. Choose a different password or passphrase.",
        "Dieses Passwort ist zu häufig. Wähle ein anderes Passwort oder eine andere Passphrase.",
        "此密码过于常见。请选择其他密码或密码短语。"));
    }
  }

  function base64(bytes) {
    const source = new Uint8Array(bytes);
    let binary = "";
    for (let offset = 0; offset < source.length; offset += 8192) {
      binary += String.fromCharCode(...source.subarray(offset, offset + 8192));
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  }

  function binary(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error(errorText("Invalid key or content.", "Ungültiger Schlüssel oder Inhalt.", "密钥或内容无效。"));
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
      throw new Error(errorText("The public key is invalid.", "Der öffentliche Schlüssel ist ungültig.", "公钥无效。"));
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
    if (previous && previous !== fingerprint) throw new Error(errorText("A member’s key has changed.", "Der Schlüssel eines Mitglieds hat sich geändert.", "一位成员的密钥已更改。"));
    pinnedKeys.set(userId, fingerprint);
  }

  async function prepareRegistration(username, passphrase) {
    assertNewPassword(passphrase);
    const { material, salt } = await accountMaterial(username, passphrase);
    const [login, vault, pair] = await Promise.all([
      expand(material, salt, "login"), expand(material, salt, "identity"),
      subtle.generateKey(curve, true, ["deriveBits"]),
    ]);
    const pub = publicPoint(await subtle.exportKey("jwk", pair.publicKey));
    const secret = await subtle.exportKey("jwk", pair.privateKey);
    return { password: base64(login), publicKey: pub, identity: await wrapIdentity(pub, secret, vault) };
  }

  async function wrapIdentity(pub, secret, vault) {
    const iv = nonce();
    const encrypted = await subtle.encrypt(aead(iv, aad("identity", pub.x, pub.y)), await aesKey(vault),
      encoder.encode(JSON.stringify(secret)));
    return { v: 1, nonce: base64(iv), blob: base64(encrypted) };
  }

  async function unwrapIdentity(user, pub, vault) {
    if (user.identity?.v !== 1) throw new Error(errorText("Unknown key.", "Unbekannter Schlüssel.", "未知密钥。"));
    const secret = new Uint8Array(await subtle.decrypt(aead(binary(user.identity.nonce), aad("identity", pub.x, pub.y)),
      await aesKey(vault), binary(user.identity.blob)));
    try {
      const jwk = JSON.parse(decoder.decode(secret));
      if (jwk.x !== pub.x || jwk.y !== pub.y) throw new Error(errorText("Wrong key.", "Falscher Schlüssel.", "密钥错误。"));
      return jwk;
    } finally {
      secret.fill(0);
    }
  }

  async function rewrapIdentity(user, previousChatPassword, newPassword) {
    assertNewPassword(newPassword);
    const pub = publicPoint(user.publicKey);
    const previous = await accountMaterial(user.username, previousChatPassword);
    let secret;
    try {
      secret = await unwrapIdentity(user, pub, await expand(previous.material, previous.salt, "identity"));
    } catch {
      throw new Error(errorText("The previous password could not unlock the chat key.", "Das bisherige Passwort konnte den Chatschlüssel nicht entsperren.", "原密码无法解锁聊天密钥。"));
    }
    const next = await accountMaterial(user.username, newPassword);
    const [login, vault] = await Promise.all([
      expand(next.material, next.salt, "login"), expand(next.material, next.salt, "identity"),
    ]);
    return { password: base64(login), identity: await wrapIdentity(pub, secret, vault) };
  }

  function lock() {
    active = null;
    try { sessionStorage.removeItem(cacheName); } catch { /* Storage may be disabled. */ }
  }

  async function unlock(user, passphrase, savedVault, current = () => true) {
    try {
      const pub = publicPoint(user.publicKey);
      let vault;
      if (typeof passphrase === "string") {
        const { material, salt } = await accountMaterial(user.username, passphrase);
        vault = await expand(material, salt, "identity");
      } else if (typeof savedVault === "string") {
        vault = binary(savedVault);
      } else {
        const cached = JSON.parse(sessionStorage.getItem(cacheName));
        if (cached?.id !== user.id) return false;
        vault = binary(cached.vault);
      }
      const jwk = await unwrapIdentity(user, pub, vault);
      const key = await subtle.importKey("jwk", jwk, curve, false, ["deriveBits"]);
      if (!current()) return false;
      pin(user.id, pub);
      const encodedVault = base64(vault);
      active = { id: user.id, key, publicKey: pub, vault: encodedVault };
      try { sessionStorage.setItem(cacheName, JSON.stringify({ id: user.id, vault: encodedVault })); } catch { /* Optional cache. */ }
      return true;
    } catch {
      if (current()) lock();
      return false;
    }
  }

  function deviceUnlockKey(userId) {
    return active?.id === userId ? active?.vault : null;
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
    if (!active || !recipients.some(({ id }) => id === active.id)) throw new Error(errorText("Unlock your session again.", "Entsperre deine Sitzung erneut.", "请重新解锁会话。"));
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

  function vaultContext(scope, ownerId) {
    if (typeof scope !== "string") return false;
    const match = /^zelotez-vault\/1\/(owner|member|public-link)\/([a-f0-9-]{36})(?:\/([a-f0-9-]{36}))?$/u.exec(scope);
    return Boolean(match && match[2] === ownerId && ((match[1] === "owner") === !match[3]));
  }

  async function sealVaultMessage(scope, messageId, content, recipients) {
    const identity = active;
    if (!identity || !vaultContext(scope, identity.id) || !recipients.some(({ id }) => id === identity.id)) {
      throw new Error(errorText("Unlock your session again.", "Entsperre deine Sitzung erneut.", "请重新解锁会话。"));
    }
    const current = () => {
      if (active !== identity) throw new Error(errorText("Unlock your session again.", "Entsperre deine Sitzung erneut.", "请重新解锁会话。"));
    };
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    try {
      const encryptionKey = await aesKey(rawKey);
      const iv = nonce();
      const body = await subtle.encrypt(aead(iv, aad("message", scope, messageId)), encryptionKey,
        encoder.encode(JSON.stringify(content)));
      const boxes = await Promise.all(recipients.map(async recipient => {
        const pub = publicPoint(recipient.id === identity.id ? identity.publicKey : recipient.publicKey);
        pin(recipient.id, pub);
        const link = aad("recipient", scope, messageId, recipient.id);
        const wrap = await recipientKey(identity.key, pub, link);
        const iv = nonce();
        const blob = await subtle.encrypt(aead(iv, link), wrap, rawKey);
        current();
        return [recipient.id, { nonce: base64(iv), blob: base64(blob) }];
      }));
      current();
      return { envelope: { v: 1, ephemeral: identity.publicKey, nonce: base64(iv), body: base64(body),
        keys: Object.fromEntries(boxes) } };
    } finally {
      rawKey.fill(0);
    }
  }

  async function openVaultMessage(scope, messageId, envelope, owner) {
    const invalidVault = () => new Error(errorText("Vault content could not be authenticated.",
      "Der Vault-Inhalt konnte nicht verifiziert werden.", "无法验证 Vault 内容。"));
    if (!active || !owner?.id || !vaultContext(scope, owner.id) || !owner.publicKey || !envelope?.ephemeral ||
        Object.hasOwn(envelope, "historyGrant") || !envelope.keys || !Object.hasOwn(envelope.keys, active.id)) throw invalidVault();
    const pub = publicPoint(owner.publicKey);
    const sender = publicPoint(envelope?.ephemeral ?? {});
    if (sender.x !== pub.x || sender.y !== pub.y) throw invalidVault();
    pin(owner.id, pub);
    return openMessage(scope, messageId, envelope);
  }

  async function wrapHistoryKey(channelId, entry, recipient, routeChannelId) {
    const identity = active;
    if (!identity) throw new Error(errorText("Unlock your session again.", "Entsperre deine Sitzung erneut.", "请重新解锁会话。"));
    const pub = publicPoint(recipient.publicKey);
    const link = aad("history recipient", channelId, entry.id, recipient.id, identity.id);
    const source = entry.grantorId ? aad("history recipient", channelId, entry.id, identity.id, entry.grantorId)
      : aad("recipient", channelId, entry.id, identity.id);
    let rawKey;
    try {
      try {
        rawKey = await unwrapMessageKey(identity.key, entry.ephemeral, source, entry);
        await verifyHistoryKey(channelId, entry, rawKey);
      } catch (error) {
        reportHistoryFailure(identity, channelId, entry.id, entry.grantRevision, error, routeChannelId);
        throw error;
      }
      if (active !== identity) throw new Error(errorText("Unlock your session again.", "Entsperre deine Sitzung erneut.", "请重新解锁会话。"));
      pin(recipient.id, pub);
      const pair = await subtle.generateKey(curve, true, ["deriveBits"]);
      const ephemeral = publicPoint(await subtle.exportKey("jwk", pair.publicKey));
      const wrap = await recipientKey(pair.privateKey, pub, link);
      const iv = nonce();
      const blob = await subtle.encrypt(aead(iv, link), wrap, rawKey);
      if (active !== identity) throw new Error(errorText("Unlock your session again.", "Entsperre deine Sitzung erneut.", "请重新解锁会话。"));
      return { v: 1, ephemeral, nonce: base64(iv), blob: base64(blob) };
    } finally {
      rawKey?.fill(0);
    }
  }

  async function verifyHistoryKey(scope, entry, rawKey) {
    const plain = new Uint8Array(await subtle.decrypt(aead(binary(entry.messageNonce), aad("message", scope, entry.id)),
      await aesKey(rawKey), binary(entry.messageBody)));
    plain.fill(0);
  }

  function onHistoryKeyFailure(listener, signal) {
    failedHistoryKeys.addEventListener("failure", event => listener(event.detail), { signal });
  }

  function reportHistoryFailure(identity, scope, messageId, revision, error, routeChannelId) {
    if (active !== identity || !Number.isSafeInteger(revision) || revision < 1 ||
        (error.name !== "OperationError" && error.name !== "DataError")) return;
    const channelId = routeChannelId ?? (scope.endsWith("/deletion") ? scope.slice(0, -"/deletion".length) : scope);
    failedHistoryKeys.dispatchEvent(new CustomEvent("failure", {
      detail: { channelId, messageId, revision, recipientId: identity.id },
    }));
  }

  async function openMessage(channelId, messageId, envelope, routeChannelId) {
    const identity = active;
    if (!identity) throw new Error(errorText("Unlock your session again.", "Entsperre deine Sitzung erneut.", "请重新解锁会话。"));
    const original = envelope?.keys?.[identity.id];
    const grant = envelope?.historyGrant;
    if (!original && !grant) return null;
    if (envelope.v !== 1 || (!original && grant.v !== 1)) throw new Error(errorText("Unknown message format.", "Unbekanntes Nachrichtenformat.", "未知消息格式。"));
    const link = original ? aad("recipient", channelId, messageId, identity.id)
      : aad("history recipient", channelId, messageId, identity.id, grant.grantorId);
    let rawKey;
    try {
      rawKey = await unwrapMessageKey(identity.key, original ? envelope.ephemeral : grant.ephemeral, link, original ?? grant);
      const [key, reactionKey] = await Promise.all([
        aesKey(rawKey), subtle.importKey("raw", rawKey, "HKDF", false, ["deriveKey"]),
      ]);
      const content = await subtle.decrypt(aead(binary(envelope.nonce), aad("message", channelId, messageId)), key, binary(envelope.body));
      if (active !== identity) throw new Error(errorText("Unlock your session again.", "Entsperre deine Sitzung erneut.", "请重新解锁会话。"));
      reactionKeys.set(key, reactionKey);
      return { content: JSON.parse(decoder.decode(content)), key };
    } catch (error) {
      if (!original) reportHistoryFailure(identity, channelId, messageId, grant.revision, error, routeChannelId);
      throw error;
    } finally {
      rawKey?.fill(0);
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

  async function sealReaction(key, scope, messageId, userId, emoji) {
    const text = encoder.encode(emoji);
    const padded = new Uint8Array(32);
    if (!text.length || text.length > padded.length) throw new Error(errorText("Invalid reaction.", "Ungültige Reaktion.", "回应无效。"));
    padded.set(text);
    const signer = await subtle.deriveKey({
      name: "HKDF", hash: "SHA-256", salt: aad("reaction ids", scope, messageId), info: aad("reaction id"),
    }, reactionKeys.get(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const id = base64(await subtle.sign("HMAC", signer, aad(userId, emoji)));
    const iv = nonce();
    const ciphertext = await subtle.encrypt(aead(iv, aad("reaction", scope, messageId, userId, id)), key, padded);
    return { id, nonce: base64(iv), body: base64(ciphertext) };
  }

  async function openReaction(key, scope, messageId, { id, userId, nonce, body }) {
    const plaintext = await subtle.decrypt(aead(binary(nonce), aad("reaction", scope, messageId, userId, id)), key, binary(body));
    const bytes = new Uint8Array(plaintext);
    const end = bytes.indexOf(0);
    return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
  }

  function deletionScope(id) {
    return id + "/deletion";
  }

  return { assertNewPassword, prepareRegistration, rewrapIdentity, credential, unlock, lock, deviceUnlockKey, sealMessage, wrapHistoryKey, openMessage, encryptFile, decryptFile,
    sealReaction, openReaction, deletionScope, onHistoryKeyFailure, sealVaultMessage, openVaultMessage };
})();
