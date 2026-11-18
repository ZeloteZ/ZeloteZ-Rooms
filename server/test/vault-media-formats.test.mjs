import assert from "node:assert/strict";
import test from "node:test";
globalThis.location = new URL("https://rooms.example.test/#/vault");
globalThis.localStorage = { getItem: () => "en" };
const { vaultFileKind, rasterImageType, validateIconImage } = await import("../../web/vault-media-edit.js");

test("new supported containers route to passive local tools while markup and unsupported binaries remain safe", () => {
  for (const [name, kind] of [["Film.MKV", "video"], ["sound.mka", "audio"], ["icon.ico", "image"], ["doc.docx", "office"],
    ["sheet.xlsx", "office"], ["files.zip", "archive"], ["files.tar", "archive"], ["files.tar.gz", "archive"], ["files.tgz", "archive"],
    ["data.csv", "text"], ["data.tsv", "text"], ["script.svg", "text"], ["page.html", "text"], ["image.heic", "other"], ["image.tiff", "other"],
    ["archive.rar", "other"], ["old.doc", "other"], ["old.avi", "other"]]) assert.equal(vaultFileKind({ name }), kind, name);
  assert.equal(vaultFileKind({ name: "private.mkv", type: "application/octet-stream" }), "video");
  assert.equal(vaultFileKind({ name: "data.csv", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "text");
  assert.equal(vaultFileKind({ name: "page.html", type: "video/x-matroska" }), "text");
  assert.equal(vaultFileKind({ name: "backup.tar.gz.exe" }), "other");
});

test("AVIF compatible brands are recognized without treating HEIC or arbitrary ftyp files as raster images", () => {
  const bytes = new Uint8Array(32), view = new DataView(bytes.buffer);
  view.setUint32(0, 32); bytes.set(new TextEncoder().encode("ftypmif1"), 4); bytes.set(new TextEncoder().encode("mif1avif"), 16);
  assert.equal(rasterImageType(bytes), "image/avif");
  bytes.set(new TextEncoder().encode("heic"), 20); assert.equal(rasterImageType(bytes), null);
});

function icon() {
  const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
  const bytes = new Uint8Array(22 + png.length), view = new DataView(bytes.buffer);
  view.setUint16(2, 1, true); view.setUint16(4, 1, true); bytes[6] = 1; bytes[7] = 1;
  view.setUint32(14, png.length, true); view.setUint32(18, 22, true); bytes.set(png, 22);
  return bytes;
}
test("ICO preflight bounds every directory frame and its real PNG or DIB dimensions before native decoding", async () => {
  assert.deepEqual(await validateIconImage(new Blob([icon()])), { images: 1 });
  for (const mutate of [bytes => new DataView(bytes.buffer).setUint32(18, 0, true),
    bytes => new DataView(bytes.buffer).setUint32(14, 0xffffffff, true),
    bytes => new DataView(bytes.buffer).setUint32(38, 1000000), bytes => new DataView(bytes.buffer).setUint16(4, 257, true)]) {
    const bytes = icon(); mutate(bytes); await assert.rejects(validateIconImage(new Blob([bytes])));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(validateIconImage(new Blob([icon()]), { signal: controller.signal }), { name: "AbortError" });
});
