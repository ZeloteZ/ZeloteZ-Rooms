export const VAULT_TEXT_BYTES = 2 * 1024 ** 2;

export class VaultTextCodecError extends Error {
  constructor(code, message) { super(message); this.name = "VaultTextCodecError"; this.code = code; }
}

const invalid = () => new VaultTextCodecError("VAULT_TEXT_ENCODING", "This file is not valid UTF-8 or UTF-16 text.");
const limit = () => new VaultTextCodecError("VAULT_TEXT_LIMIT", "Text editing supports files up to 2 MiB.");
const binary = () => new VaultTextCodecError("VAULT_TEXT_BINARY", "This file contains binary data and cannot be edited as text.");
function encodingName(value) {
  const label = String(value).toLowerCase();
  if (label === "utf-8" || label === "utf8") return "utf-8";
  if (label === "utf-16le" || label === "utf16le") return "utf-16le";
  if (label === "utf-16be" || label === "utf16be") return "utf-16be";
  throw invalid();
}

export function decodeVaultText(bytes, { encoding } = {}) {
  if (!(bytes instanceof Uint8Array)) throw invalid();
  if (bytes.byteLength > VAULT_TEXT_BYTES) throw limit();
  let detected, prefix = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { detected = "utf-8"; prefix = 3; }
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) { detected = "utf-16le"; prefix = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { detected = "utf-16be"; prefix = 2; }
  const selected = encoding === undefined ? detected || "utf-8" : encodingName(encoding);
  if (detected && detected !== selected) throw invalid();
  let value;
  try { value = new TextDecoder(selected, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(prefix)); }
  catch { throw invalid(); }
  if (value.includes("\0")) throw binary();
  return { value, encoding: selected, bom: prefix !== 0, lineEnding: /\r\n|\r|\n/u.exec(value)?.[0] || "\n" };
}

function validUnicode(value) {
  for (let index = 0; index < value.length; index++) {
    const point = value.charCodeAt(index);
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw invalid();
    } else if (point >= 0xdc00 && point <= 0xdfff) throw invalid();
  }
}

export function encodeVaultText(value, { encoding = "utf-8", bom = false, lineEnding } = {}) {
  if (typeof value !== "string" || typeof bom !== "boolean") throw invalid();
  if (value.length > VAULT_TEXT_BYTES) throw limit();
  const selected = encodingName(encoding);
  if (lineEnding !== undefined) {
    if (!["\n", "\r\n", "\r"].includes(lineEnding)) throw invalid();
    value = value.replace(/\r\n|\r|\n/gu, lineEnding);
  }
  if (value.includes("\0")) throw binary();
  validUnicode(value);
  if (selected === "utf-8") {
    const body = new TextEncoder().encode(value);
    if (body.byteLength + (bom ? 3 : 0) > VAULT_TEXT_BYTES) { body.fill(0); throw limit(); }
    if (!bom) return body;
    const result = new Uint8Array(body.byteLength + 3);
    result.set([0xef, 0xbb, 0xbf]); result.set(body, 3); body.fill(0);
    return result;
  }
  const prefix = bom ? 2 : 0, length = prefix + value.length * 2;
  if (length > VAULT_TEXT_BYTES) throw limit();
  const result = new Uint8Array(length), view = new DataView(result.buffer);
  const littleEndian = selected === "utf-16le";
  if (bom) result.set(littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]);
  for (let index = 0; index < value.length; index++) view.setUint16(prefix + index * 2, value.charCodeAt(index), littleEndian);
  return result;
}
