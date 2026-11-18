import assert from "node:assert/strict";
import test from "node:test";
import { parseMkvMediaTracks } from "../../web/vault-mkv-tracks.js";
const join = (...parts) => new Uint8Array(parts.flatMap(part => Array.from(part)));
const string = value => new TextEncoder().encode(value);
function element(id, body) {
  let hex = id.toString(16); if (hex.length % 2) hex = "0" + hex;
  const bytes = Uint8Array.from(hex.match(/../gu), value => parseInt(value, 16));
  const size = body.length < 127 ? [body.length | 128] : [(body.length >> 8) | 64, body.length & 255];
  return join(bytes, size, body);
}
const uint = (id, value) => element(id, value < 256 ? [value] : [value >> 8, value & 255]);
function fixture({ codec = "S_TEXT/UTF8", payload = "<img src=x> remains text", duplicate = false, many = false } = {}) {
  const audio = (id, language) => element(0xae, join(uint(0xd7, id), uint(0x83, 2), element(0x86, string("A_AAC")), element(0x22b59c, string(language))));
  const subtitles = element(0xae, join(uint(0xd7, 4), uint(0x83, 17), element(0x86, string(codec)), element(0x22b59c, string("eng"))));
  const tracks = element(0x1654ae6b, join(element(0xbf, [1, 2, 3, 4]),
    ...(many ? Array.from({ length: 65 }, (_, index) => audio(index + 10, "eng")) : [audio(2, "deu"), audio(duplicate ? 2 : 3, "eng"), subtitles])));
  const packet = element(0xa1, join([0x84, 0, 100, 0], string(payload)));
  const cluster = element(0x1f43b675, join(element(0xa0, join(packet, uint(0x9b, 1700))), uint(0xe7, 0)));
  return join(element(0x1a45dfa3, element(0x4282, string("matroska"))), element(0x18538067, join(tracks, cluster)));
}

test("Matroska languages, duration and offset-stable audio masking retain the selected stream only", () => {
  const original = fixture(), saved = original.slice(), parsed = parseMkvMediaTracks(original);
  assert.deepEqual(parsed.audio.map(track => [track.id, track.language]), [["2", "deu"], ["3", "eng"]]);
  assert.deepEqual(parsed.subtitles[0].cues, [{ start: .1, end: 1.8, text: "<img src=x> remains text" }]);
  for (const track of parsed.audio) {
    const selected = original.slice(); for (const patch of parsed.audioPatches[track.id]) selected.set(patch.bytes, patch.offset);
    assert.equal(selected.length, original.length);
    assert.deepEqual(parseMkvMediaTracks(selected).audio.map(value => value.id), [track.id]);
  }
  assert.deepEqual(original, saved);
});

test("ASS formatting and vector drawing commands are removed while literal Unicode text remains passive", () => {
  const result = parseMkvMediaTracks(fixture({ codec: "S_TEXT/ASS", payload: "0,0,Default,,0,0,0,,{\\pos(1,1)}Grüße\\N{\\p1}m 0 0 l 10 10{\\p0}计划" }));
  assert.equal(result.subtitles[0].format, "ass");
  assert.equal(result.subtitles[0].cues[0].text, "Grüße\n计划");
  const bitmap = parseMkvMediaTracks(fixture({ codec: "S_HDMV/PGS" }));
  assert.equal(bitmap.subtitles[0].supported, false); assert.deepEqual(bitmap.subtitles[0].cues, []);
});

test("truncation, duplicate identities, excessive tracks and deadline/abort inputs fail closed", () => {
  const bytes = fixture();
  for (let length = 0; length < bytes.length; length += 7) assert.throws(() => parseMkvMediaTracks(bytes.slice(0, length)));
  assert.throws(() => parseMkvMediaTracks(fixture({ duplicate: true })));
  assert.throws(() => parseMkvMediaTracks(fixture({ many: true })));
  assert.throws(() => parseMkvMediaTracks(bytes, { deadline: -1 }));
  const controller = new AbortController(); controller.abort();
  assert.throws(() => parseMkvMediaTracks(bytes, { signal: controller.signal }), { name: "AbortError" });
});
