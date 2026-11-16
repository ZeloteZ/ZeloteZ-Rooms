const suite = "zelotez-rooms/quick-chat/v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const curve = { name: "ECDH", namedCurve: "P-256" };

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

export async function createQuickChatCrypto(roomId) {
  const deviceId = crypto.randomUUID();
  const pair = await crypto.subtle.generateKey(curve, false, ["deriveBits"]);
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

  async function seal(id, text, peers) {
    const plaintext = encoder.encode(text);
    if (plaintext.length > 4096) throw new Error("Chat message is too long");
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    try {
      const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
      const ciphertext = await encrypt(key, plaintext, context("message", roomId, id, deviceId));
      const wraps = await Promise.all(peers.map(async peer => {
        const additionalData = context("recipient", roomId, id, deviceId, peer.id);
        const key = await wrappingKey(peer.publicKey, additionalData, "encrypt");
        return [peer.id, await encrypt(key, rawKey, additionalData)];
      }));
      return { ...ciphertext, keys: Object.fromEntries(wraps) };
    } finally {
      rawKey.fill(0);
      plaintext.fill(0);
    }
  }

  async function open({ id, from, publicKey, envelope }) {
    const additionalData = context("recipient", roomId, id, from, deviceId);
    const wrapping = await wrappingKey(publicKey, additionalData, "decrypt");
    const rawKey = new Uint8Array(await decrypt(wrapping, envelope.key, additionalData));
    try {
      if (rawKey.length !== 32) throw new Error("Invalid chat key");
      const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
      return decoder.decode(await decrypt(key, envelope, context("message", roomId, id, from)));
    } finally {
      rawKey.fill(0);
    }
  }

  return { deviceId, publicKey: { kty, crv, x, y }, seal, open };
}
