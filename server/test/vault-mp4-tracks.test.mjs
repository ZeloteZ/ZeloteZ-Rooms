import assert from 'node:assert/strict';
import test from 'node:test';
import { MP4_TRACK_LIMITS, parseMp4MediaTracks, parseMp4BlobMediaTracks } from '../../web/vault-mp4-tracks.js';

const text = value => new TextEncoder().encode(value);
function join(...parts) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
function numbers(...values) { const bytes = new Uint8Array(values.length * 4), view = new DataView(bytes.buffer); values.forEach((value, index) => view.setUint32(index * 4, value)); return bytes; }
function atom(name, ...parts) { const data = join(...parts); return join(numbers(data.length + 8), text(name), data); }
const full = (name, ...parts) => atom(name, numbers(0), ...parts);
const packedLanguage = language => [...language].reduce((value, letter) => value * 32 + letter.charCodeAt(0) - 96, 0);
function tkhd(id, enabled = true) {
  const bytes = new Uint8Array(84), view = new DataView(bytes.buffer);
  view.setUint32(0, enabled ? 3 : 2); view.setUint32(12, id);
  return atom('tkhd', bytes);
}
function mdhd(language, scale = 1000) {
  const bytes = new Uint8Array(24), view = new DataView(bytes.buffer);
  view.setUint32(12, scale); view.setUint32(16, 1000); view.setUint16(20, packedLanguage(language));
  return atom('mdhd', bytes);
}
const hdlr = (kind, name = '') => full('hdlr', numbers(0), text(kind), new Uint8Array(12), text(name + '\0'));
const stsd = codec => full('stsd', numbers(1), atom(codec, new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1])));
const audio = (id, language, name, enabled) => atom('trak', tkhd(id, enabled), atom('mdia', mdhd(language), hdlr('soun', name), atom('minf', atom('stbl', stsd('mp4a')))));
function sample(value, encoding = 'utf-8') {
  let bytes;
  if (encoding === 'utf-16le') {
    bytes = new Uint8Array(value.length * 2 + 2); bytes.set([255, 254]);
    const view = new DataView(bytes.buffer); for (let index = 0; index < value.length; index++) view.setUint16(2 + index * 2, value.charCodeAt(index), true);
  } else bytes = text(value);
  const prefix = new Uint8Array(2); new DataView(prefix.buffer).setUint16(0, bytes.length);
  return join(prefix, bytes);
}
function subtitle(id, language, offset, data, { edits = false, composition, codec = 'tx3g', co64 = false, sampleCount = 1 } = {}) {
  let chunkOffset = numbers(offset);
  if (co64) { chunkOffset = new Uint8Array(8); new DataView(chunkOffset.buffer).setBigUint64(0, BigInt(offset)); }
  const stbl = atom('stbl', stsd(codec), full('stts', numbers(1, sampleCount, 1000)), full('stsz', numbers(0, sampleCount, data.length)),
    full('stsc', numbers(1, 1, 1, 1)), full(co64 ? 'co64' : 'stco', numbers(1), chunkOffset),
    ...(composition === undefined ? [] : [atom('ctts', numbers(0x1000000, 1, sampleCount, composition))]));
  const edit = edits ? atom('edts', full('elst', numbers(2, 500, 0xffffffff, 0x10000, 1000, 0, 0x10000))) : new Uint8Array();
  return atom('trak', tkhd(id), edit, atom('mdia', mdhd(language), hdlr('sbtl', 'SubtitleHandler'), atom('minf', stbl)));
}
function fixture(options = {}) {
  const first = sample(options.firstText ?? 'Deutsch <script>passive()</script>'), second = sample('English 计划', options.encoding);
  const ftyp = atom('ftyp', text('isom'), numbers(0), text('isomiso2'));
  const payload = atom('mdat', first, second), start = ftyp.length + 8;
  const movieHeader = new Uint8Array(100); new DataView(movieHeader.buffer).setUint32(12, 1000);
  const movie = atom('moov', atom('mvhd', movieHeader), audio(2, 'deu', 'Deutsch 440 Hz', true), audio(options.duplicateId ? 2 : 3, 'eng', 'English 880 Hz', false),
    subtitle(4, 'deu', options.offset ?? start, first, options), subtitle(5, 'eng', start + first.length, second, options.second ?? {}),
    ...(options.fragmented ? [atom('mvex')] : []));
  return join(ftyp, payload, movie);
}
const patched = (source, patches) => { const copy = Uint8Array.from(source); for (const patch of patches) copy.set(patch.bytes, patch.offset); return copy; };
function findAtom(bytes, name) {
  const wanted = text(name);
  for (let index = 4; index < bytes.length - 4; index++) if (wanted.every((value, offset) => bytes[index + offset] === value)) return index - 4;
  throw new Error('Missing atom ' + name);
}

test('MP4 metadata exposes language, labels and defaults alongside passive timed mov_text cues', () => {
  const result = parseMp4MediaTracks(fixture());
  assert.equal(result.container, 'mp4');
  assert.deepEqual(result.audio.map(({ id, language, label, default: selected }) => ({ id, language, label, selected })), [
    { id: '2', language: 'deu', label: 'Deutsch 440 Hz', selected: true }, { id: '3', language: 'eng', label: 'English 880 Hz', selected: false },
  ]);
  assert.deepEqual(result.subtitles.map(item => [item.id, item.language, item.format, item.cues]), [
    ['4', 'deu', 'mov_text', [{ start: 0, end: 1, text: 'Deutsch <script>passive()</script>' }]],
    ['5', 'eng', 'mov_text', [{ start: 0, end: 1, text: 'English 计划' }]],
  ]);
});

test('audio patches retain every byte offset, enable the selected track and mask all other audio tracks', () => {
  const source = fixture(), original = Uint8Array.from(source), result = parseMp4MediaTracks(source);
  for (const selected of result.audio) {
    const patches = result.audioPatches[selected.id], changed = patched(source, patches), allowed = new Set();
    for (const patch of patches) {
      assert.ok(patch.bytes.length === 3 || patch.bytes.length === 4);
      for (let offset = patch.offset; offset < patch.offset + patch.bytes.length; offset++) allowed.add(offset);
    }
    assert.equal(changed.length, source.length);
    for (let offset = 0; offset < changed.length; offset++) if (!allowed.has(offset)) assert.equal(changed[offset], source[offset]);
    const parsed = parseMp4MediaTracks(changed);
    assert.deepEqual(parsed.audio.map(item => [item.id, item.default]), [[selected.id, true]]);
    assert.deepEqual(parsed.subtitles, result.subtitles);
  }
  assert.deepEqual(source, original);
});

test('subtitle extraction supports UTF-16, 64-bit chunk offsets, composition time and leading presentation edits', () => {
  const result = parseMp4MediaTracks(fixture({ encoding: 'utf-16le', edits: true, composition: -100, co64: true }));
  assert.deepEqual(result.subtitles[0].cues, [{ start: 0.5, end: 1.4, text: 'Deutsch <script>passive()</script>' }]);
  assert.equal(result.subtitles[1].cues[0].text, 'English 计划');
  const control = parseMp4MediaTracks(fixture({ firstText: 'A\0B\r\nC\u202eD' }));
  assert.equal(control.subtitles[0].cues[0].text, 'AB\nCD');
});

test('malformed atom lengths, duplicate IDs, sample ranges and inconsistent tables fail closed', () => {
  for (const source of [fixture().subarray(0, 20), fixture({ duplicateId: true }), fixture({ offset: 4 })]) {
    assert.throws(() => parseMp4MediaTracks(source), { code: 'VAULT_MEDIA_TRACK_INVALID' });
  }
  const badText = fixture(); new DataView(badText.buffer).setUint16(findAtom(badText, 'mdat') + 8, 65535);
  assert.throws(() => parseMp4MediaTracks(badText), { code: 'VAULT_MEDIA_TRACK_INVALID' });
  const badCount = fixture(); new DataView(badCount.buffer).setUint32(findAtom(badCount, 'stts') + 12, 100);
  assert.throws(() => parseMp4MediaTracks(badCount), { code: 'VAULT_MEDIA_TRACK_INVALID' });
  const badSize = fixture(); new DataView(badSize.buffer).setUint32(findAtom(badSize, 'moov'), 0xffffffff);
  assert.throws(() => parseMp4MediaTracks(badSize), { code: 'VAULT_MEDIA_TRACK_INVALID' });
});

test('fragmented and unknown subtitle formats are handled without pretending to support them', () => {
  assert.throws(() => parseMp4MediaTracks(fixture({ fragmented: true })), { code: 'VAULT_MEDIA_TRACK_UNSUPPORTED' });
  const unknown = parseMp4MediaTracks(fixture({ codec: 'stpp' }));
  assert.deepEqual(unknown.subtitles.map(item => item.id), ['5']);
  assert.equal(unknown.audio.length, 2);
});

test('track parser bounds source bytes, declared samples, atom counts, cancellation and execution time', () => {
  assert.throws(() => parseMp4MediaTracks(new Uint8Array(MP4_TRACK_LIMITS.inputBytes + 1)), { code: 'VAULT_MEDIA_TRACK_LIMIT' });
  const source = fixture(), excessiveSamples = Uint8Array.from(source);
  new DataView(excessiveSamples.buffer).setUint32(findAtom(excessiveSamples, 'stsz') + 16, MP4_TRACK_LIMITS.samples + 1);
  assert.throws(() => parseMp4MediaTracks(excessiveSamples), { code: 'VAULT_MEDIA_TRACK_LIMIT' });
  assert.throws(() => parseMp4MediaTracks(join(...Array.from({ length: MP4_TRACK_LIMITS.boxes + 1 }, () => atom('free')))), { code: 'VAULT_MEDIA_TRACK_LIMIT' });
  const controller = new AbortController(); controller.abort();
  assert.throws(() => parseMp4MediaTracks(source, { signal: controller.signal }), { name: 'AbortError' });
  assert.throws(() => parseMp4MediaTracks(source, { deadline: 0 }), { code: 'VAULT_MEDIA_TRACK_LIMIT' });
});

test('bounded typed-array views use local offsets rather than accidentally inspecting adjacent backing bytes', () => {
  const source = fixture(), backing = new Uint8Array(source.length + 50); backing.fill(99); backing.set(source, 21);
  const result = parseMp4MediaTracks(backing.subarray(21, 21 + source.length));
  assert.equal(result.audio.length, 2);
  assert.deepEqual(parseMp4MediaTracks(patched(source, result.audioPatches['3'])).audio.map(item => item.id), ['3']);
  assert.equal(backing[0], 99); assert.equal(backing.at(-1), 99);
});

class SparseMediaBlob extends Blob {
  constructor(size, segments) { super(); this.length = size; this.segments = segments; this.requests = []; this.buffers = []; }
  get size() { return this.length; }
  arrayBuffer() { throw new Error('The entire media Blob must never be read'); }
  slice(start, end) {
    assert.ok(end - start <= MP4_TRACK_LIMITS.readChunkBytes, 'every media read must be bounded');
    assert.ok(start >= 0 && end <= this.size);
    this.requests.push([start, end]);
    const data = new Uint8Array(end - start);
    for (const segment of this.segments) {
      const first = Math.max(start, segment.position), last = Math.min(end, segment.position + segment.data.length);
      if (last > first) data.set(segment.data.subarray(first - segment.position, last - segment.position), first - start);
    }
    const blob = new Blob([data]), owner = this;
    return { async arrayBuffer() { const result = await blob.arrayBuffer(); owner.buffers.push(new Uint8Array(result)); return result; } };
  }
}
function sparseFixture({ extraMetadataBytes = 0 } = {}) {
  const ftyp = atom('ftyp', text('isom'), numbers(0), text('isomiso2'));
  const mdatSize = 5 * 1024 ** 3 + 16, header = join(numbers(1), text('mdat'), new Uint8Array(8));
  new DataView(header.buffer).setBigUint64(8, BigInt(mdatSize));
  const first = sample('Deutsch beyond 4 GiB'), second = sample('English beyond 4 GiB');
  const position = ftyp.length + 16 + 4 * 1024 ** 3 + 200, moviePosition = ftyp.length + mdatSize;
  const movieHeader = new Uint8Array(100); new DataView(movieHeader.buffer).setUint32(12, 1000);
  const movie = atom('moov', atom('mvhd', movieHeader), audio(2, 'deu', 'Deutsch', true), audio(3, 'eng', 'English', false),
    subtitle(4, 'deu', position, first, { co64: true }), subtitle(5, 'eng', position + first.length, second, { co64: true }),
    ...(extraMetadataBytes ? [atom('free', new Uint8Array(extraMetadataBytes))] : []));
  const blob = new SparseMediaBlob(moviePosition + movie.length, [{ position: 0, data: ftyp }, { position: ftyp.length, data: header },
    { position, data: first }, { position: position + first.length, data: second }, { position: moviePosition, data: movie }]);
  return { blob, moviePosition, position, mdatPayload: ftyp.length + 16 };
}

test('Blob MP4 parsing matches the synchronous API and supports an explicit lazy subtitle filter', async () => {
  const source = fixture(), blob = new SparseMediaBlob(source.length, [{ position: 0, data: source }]);
  assert.deepEqual(await parseMp4BlobMediaTracks(blob), parseMp4MediaTracks(source));
  assert.ok(blob.buffers.every(buffer => buffer.every(byte => byte === 0)), 'all temporary range reads are wiped');
  const filtered = await parseMp4BlobMediaTracks(blob, { subtitleId: '5' });
  assert.equal(filtered.lazySubtitles, true);
  assert.deepEqual(filtered.subtitles.map(track => track.cues.length), [0, 1]);
  await assert.rejects(parseMp4BlobMediaTracks(blob, { subtitleId: 'unknown' }), { code: 'VAULT_MEDIA_TRACK_INVALID' });
});

test('multi-GiB mdat is skipped and tail moov/co64 retain absolute 64-bit file offsets without a full-file allocation', async () => {
  const { blob, moviePosition, position, mdatPayload } = sparseFixture();
  assert.ok(blob.size > 5 * 1024 ** 3);
  const result = await parseMp4BlobMediaTracks(blob);
  assert.deepEqual(result.audio.map(track => [track.id, track.language]), [['2', 'deu'], ['3', 'eng']]);
  assert.deepEqual(result.subtitles.map(track => track.cues[0].text), ['Deutsch beyond 4 GiB', 'English beyond 4 GiB']);
  for (const patches of Object.values(result.audioPatches)) assert.ok(patches.every(patch => patch.offset > moviePosition));
  assert.ok(blob.requests.some(([start]) => start === position));
  assert.ok(!blob.requests.some(([start, end]) => start >= mdatPayload && end <= position && end - start > 8), 'large media payload is not scanned');
  assert.ok(blob.requests.reduce((sum, [start, end]) => sum + end - start, 0) < 10000);
  assert.ok(blob.buffers.every(buffer => buffer.every(byte => byte === 0)));
});

test('large moov metadata is read in bounded windows while preserving absolute audio patch positions', async () => {
  const { blob, moviePosition } = sparseFixture({ extraMetadataBytes: 2 * 1024 ** 2 });
  const result = await parseMp4BlobMediaTracks(blob);
  assert.ok(blob.requests.filter(([start, end]) => start >= moviePosition && end - start > 8).length >= 3);
  assert.ok(blob.requests.every(([start, end]) => end - start <= MP4_TRACK_LIMITS.readChunkBytes));
  assert.ok(result.audioPatches['3'].every(patch => patch.offset > moviePosition));
});

test('Blob MP4 bounds metadata before allocation and rejects late/cancelled reads without retaining their plaintext', async () => {
  const oversized = sparseFixture(), marker = oversized.blob.segments.at(-1).data;
  new DataView(marker.buffer).setUint32(0, MP4_TRACK_LIMITS.metadataBytes + 1);
  oversized.blob.length = oversized.moviePosition + MP4_TRACK_LIMITS.metadataBytes + 1;
  await assert.rejects(parseMp4BlobMediaTracks(oversized.blob), { code: 'VAULT_MEDIA_TRACK_LIMIT' });
  assert.ok(oversized.blob.requests.every(([start, end]) => end - start <= 8));
  const overFile = new SparseMediaBlob(MP4_TRACK_LIMITS.blobBytes + 1, []);
  await assert.rejects(parseMp4BlobMediaTracks(overFile), { code: 'VAULT_MEDIA_TRACK_LIMIT' });
  assert.deepEqual(overFile.requests, []);
  const controller = new AbortController(), cancelled = sparseFixture().blob;
  const slice = cancelled.slice.bind(cancelled);
  cancelled.slice = (start, end) => {
    const range = slice(start, end);
    return { async arrayBuffer() { const data = await range.arrayBuffer(); controller.abort(); return data; } };
  };
  await assert.rejects(parseMp4BlobMediaTracks(cancelled, { signal: controller.signal }), { name: 'AbortError' });
  assert.ok(cancelled.buffers.every(buffer => buffer.every(byte => byte === 0)));
  await assert.rejects(parseMp4BlobMediaTracks(sparseFixture().blob, { deadline: 0 }), { code: 'VAULT_MEDIA_TRACK_LIMIT' });
});

test('UTF-16 subtitle text also obeys the decoded UTF-8 text budget', async () => {
  const data = sample('计'.repeat(20000), 'utf-16le'), count = 40;
  const ftyp = atom('ftyp', text('isom'), numbers(0), text('isomiso2'));
  const samples = Array.from({ length: count }, () => data), mdat = atom('mdat', ...samples);
  const movieHeader = new Uint8Array(100); new DataView(movieHeader.buffer).setUint32(12, 1000);
  const tracks = samples.map((bytes, index) => subtitle(index + 4, 'zho', ftyp.length + 8 + index * data.length, bytes));
  const source = join(ftyp, mdat, atom('moov', atom('mvhd', movieHeader), ...tracks));
  assert.ok(count * data.length < MP4_TRACK_LIMITS.textBytes);
  assert.throws(() => parseMp4MediaTracks(source), { code: 'VAULT_MEDIA_TRACK_LIMIT' });
  await assert.rejects(parseMp4BlobMediaTracks(new Blob([source])), { code: 'VAULT_MEDIA_TRACK_LIMIT' });
});
