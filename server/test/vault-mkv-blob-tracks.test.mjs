import assert from "node:assert/strict";
import test from "node:test";
import { parseMkvBlobMediaTracks } from "../../web/vault-mkv-tracks.js";
import { createMediaRangeReader } from "../../web/vault-media-ranges.js";

const join = (...parts) => new Uint8Array(parts.flatMap(part => Array.from(part)));
const string = value => new TextEncoder().encode(value);
function header(id, length, width = 8) {
  let hex = id.toString(16); if (hex.length % 2) hex = "0" + hex;
  const name = Uint8Array.from(hex.match(/../gu), value => parseInt(value, 16)), size = new Uint8Array(width);
  let remaining = BigInt(length);
  for (let index = width - 1; index >= 0; index--) { size[index] = Number(remaining & 255n); remaining >>= 8n; }
  size[0] |= 1 << (8 - width); return join(name, size);
}
const element = (id, data) => join(header(id, data.length), data);
const uint = (id, value) => element(id, value < 256 ? [value] : [value >> 8, value & 255]);
function largeUint(id, value) { const bytes = []; do { bytes.unshift(value % 256); value = Math.floor(value / 256); } while (value); return element(id, bytes); }
class SparseMediaBlob extends Blob {
  constructor(size, parts) { super([]); this.virtualSize = size; this.parts = parts; this.reads = []; this.wholeReads = 0; }
  get size() { return this.virtualSize; }
  arrayBuffer() { this.wholeReads++; throw new Error("A complete large-media read is forbidden"); }
  slice(start, end) {
    assert.ok(end - start <= 1024 ** 2, "every physical read remains at most 1 MiB");
    this.reads.push([start, end]);
    const result = new Uint8Array(end - start);
    for (const part of this.parts) {
      const left = Math.max(start, part.offset), right = Math.min(end, part.offset + part.bytes.length);
      if (right > left) result.set(part.bytes.subarray(left - part.offset, right - part.offset), left - start);
    }
    return new Blob([result]);
  }
}
function fixture({ tailTracks = false, indexed = false } = {}) {
  const size = 10 * 1024 ** 3, ebml = element(0x1a45dfa3, element(0x4282, string("matroska")));
  const audio = (id, language) => element(0xae, join(uint(0xd7, id), uint(0x83, 2), element(0x86, string("A_AAC")), element(0x22b59c, string(language))));
  const sub = element(0xae, join(uint(0xd7, 4), uint(0x83, 17), element(0x86, string("S_TEXT/UTF8"))));
  const tracks = element(0x1654ae6b, join(audio(2, "deu"), audio(3, "eng"), sub));
  const segmentHeader = header(0x18538067, size - ebml.length - 12), body = ebml.length + segmentHeader.length;
  const parts = [{ offset: 0, bytes: ebml }, { offset: ebml.length, bytes: segmentHeader }];
  let offset = body;
  if (tailTracks) { const gap = 5 * 1024 ** 3, padding = header(0xec, gap - 9); parts.push({ offset, bytes: padding }); offset += gap; }
  parts.push({ offset, bytes: tracks }); offset += tracks.length;
  const time = uint(0xe7, 0), packet = element(0xa1, join([0x84, 0, 100, 0], string("Large-file subtitle")));
  const group = element(0xa0, join(packet, uint(0x9b, 1700)));
  const clusterStart = offset; let relative;
  if (tailTracks) {
    const cluster = element(0x1f43b675, join(time, group)); parts.push({ offset, bytes: cluster }); offset += cluster.length;
  } else {
    const videoSize = 5 * 1024 ** 3, videoHeader = header(0xa3, videoSize);
    const clusterHeader = header(0x1f43b675, time.length + videoHeader.length + videoSize + group.length);
    relative = time.length + videoHeader.length + videoSize;
    parts.push({ offset, bytes: join(clusterHeader, time, videoHeader, [0x81, 0, 0, 128]) });
    offset += clusterHeader.length + time.length + videoHeader.length + videoSize;
    parts.push({ offset, bytes: group }); offset += group.length;
  }
  if (indexed) {
    const cues = element(0x1c53bb6b, element(0xbb, join(uint(0xb3, 100), element(0xb7,
      join(uint(0xf7, 4), largeUint(0xf1, clusterStart - body), largeUint(0xf0, relative), uint(0xb2, 1700))))));
    parts.push({ offset, bytes: cues }); offset += cues.length;
  }
  parts.push({ offset, bytes: header(0xec, size - offset - 9) });
  return new SparseMediaBlob(size, parts);
}

test("10 GiB Matroska metadata and late text captions skip a 5 GiB video payload using bounded random access", async () => {
  const blob = fixture(), metadata = await parseMkvBlobMediaTracks(blob);
  assert.deepEqual(metadata.audio.map(track => [track.id, track.language]), [["2", "deu"], ["3", "eng"]]);
  assert.equal(metadata.lazySubtitles, true); assert.deepEqual(metadata.subtitles[0].cues, []);
  assert.ok(blob.reads.every(([, end]) => end < 65536 || end > 5 * 1024 ** 3), "video payload is skipped");
  const selected = await parseMkvBlobMediaTracks(blob, { subtitleId: "4" });
  assert.deepEqual(selected.subtitles[0].cues, [{ start: .1, end: 1.8, text: "Large-file subtitle" }]);
  assert.equal(blob.wholeReads, 0);
  assert.ok(blob.reads.reduce((total, [start, end]) => total + end - start, 0) < 16384);
});

test("subtitle Cues target late block positions beyond 4 GiB without scanning skipped media payloads", async () => {
  const blob = fixture({ indexed: true }), result = await parseMkvBlobMediaTracks(blob, { subtitleId: "4" });
  assert.equal(result.indexedSubtitles, true);
  assert.deepEqual(result.subtitles[0].cues, [{ start: .1, end: 1.8, text: "Large-file subtitle" }]);
  assert.ok(result.readBytes < 16384); assert.equal(blob.wholeReads, 0);
});

test("audio header patches retain absolute positions beyond 4 GiB when Tracks occur late", async () => {
  const blob = fixture({ tailTracks: true }), metadata = await parseMkvBlobMediaTracks(blob);
  assert.ok(Object.values(metadata.audioPatches).flat().every(patch => patch.offset > 4 * 1024 ** 3 && patch.offset + patch.bytes.length <= blob.size));
  assert.equal(blob.wholeReads, 0); assert.ok(blob.reads.length < 64);
});

test("range reads reject oversized media and erase bytes that arrive after cancellation", async () => {
  const invalid = fixture(); invalid.virtualSize++;
  await assert.rejects(parseMkvBlobMediaTracks(invalid), { code: "VAULT_MEDIA_TRACK_LIMIT" });
  assert.equal(invalid.reads.length, 0);
  const blob = fixture(), scope = new AbortController(); let release;
  const bytes = new Uint8Array([1, 2, 3, 4]);
  blob.slice = () => ({ arrayBuffer: () => new Promise(resolve => { release = () => resolve(bytes.buffer); }) });
  const reader = createMediaRangeReader(blob, { signal: scope.signal }), pending = reader.read(0, 4);
  scope.abort(); release(); await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(bytes, new Uint8Array(4)); reader.dispose();
});
