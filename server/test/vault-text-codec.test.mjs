import assert from "node:assert/strict";
import test from "node:test";
import { decodeVaultText, encodeVaultText, VAULT_TEXT_BYTES } from "../../web/vault-text-codec.js";

test("UTF-8 and both UTF-16 byte orders preserve BOM, Unicode and line endings", () => {
  for (const encoding of ["utf-8", "utf-16le", "utf-16be"]) for (const bom of [false, true]) {
    for (const lineEnding of ["\n", "\r\n", "\r"]) {
      const value = ["Grüße 计划 🗝️", "<script>unchanged plain text</script>", ""].join(lineEnding);
      const original = encodeVaultText(value, { encoding, bom });
      const copy = original.slice();
      const decoded = decodeVaultText(original, bom || encoding === "utf-8" ? undefined : { encoding });
      assert.deepEqual(decoded, { value, encoding, bom, lineEnding });
      assert.deepEqual(encodeVaultText(decoded.value, decoded), original);
      assert.deepEqual(original, copy);
    }
  }
});

test("byte-order marks identify the encoding without consuming content BOM characters", () => {
  for (const encoding of ["utf-8", "utf-16le", "utf-16be"]) {
    const bytes = encodeVaultText("\ufeffcontent", { encoding, bom: true });
    assert.equal(decodeVaultText(bytes).value, "\ufeffcontent");
    assert.throws(() => decodeVaultText(bytes, { encoding: encoding === "utf-8" ? "utf-16be" : "utf-8" }), { code: "VAULT_TEXT_ENCODING" });
  }
  assert.equal(decodeVaultText(new Uint8Array()).value, "");
});

test("malformed Unicode, unsupported encodings and binary NULs fail without replacement characters", () => {
  for (const bytes of [new Uint8Array([0xc3, 0x28]), new Uint8Array([0xff, 0xfe, 0x61]),
    new Uint8Array([0xff, 0xfe, 0x00, 0xd8]), new Uint8Array([0xfe, 0xff, 0xdc, 0x00])]) {
    assert.throws(() => decodeVaultText(bytes), { code: "VAULT_TEXT_ENCODING" });
  }
  for (const value of ["\ud800", "\udc00", "a\ud800b"]) assert.throws(() => encodeVaultText(value), { code: "VAULT_TEXT_ENCODING" });
  assert.throws(() => decodeVaultText(new Uint8Array([65, 0, 66])), { code: "VAULT_TEXT_BINARY" });
  assert.throws(() => encodeVaultText("a\0b"), { code: "VAULT_TEXT_BINARY" });
  assert.throws(() => decodeVaultText(new Uint8Array([65]), { encoding: "utf-32le" }), { code: "VAULT_TEXT_ENCODING" });
});

test("UTF byte limits include BOMs and output encoding expansion", () => {
  assert.throws(() => decodeVaultText(new Uint8Array(VAULT_TEXT_BYTES + 1)), { code: "VAULT_TEXT_LIMIT" });
  assert.equal(encodeVaultText("a".repeat(VAULT_TEXT_BYTES)).byteLength, VAULT_TEXT_BYTES);
  assert.throws(() => encodeVaultText("a".repeat(VAULT_TEXT_BYTES), { bom: true }), { code: "VAULT_TEXT_LIMIT" });
  assert.throws(() => encodeVaultText("a".repeat(VAULT_TEXT_BYTES / 2), { encoding: "utf-16be", bom: true }), { code: "VAULT_TEXT_LIMIT" });
  assert.throws(() => encodeVaultText("a\nb", { lineEnding: "invalid" }), { code: "VAULT_TEXT_ENCODING" });
});
