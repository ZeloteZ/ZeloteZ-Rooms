export const MP4_TRACK_LIMITS = Object.freeze({ inputBytes: 128 * 1024 ** 2, tracks: 64, boxes: 10000,
  samples: 20000, cues: 20000, textBytes: 2 * 1024 ** 2, sampleBytes: 256 * 1024, milliseconds: 15000 });
const now = () => globalThis.performance?.now() ?? Date.now();
const error = (code, message) => Object.assign(new Error(message), { code });
const invalid = () => error("VAULT_MEDIA_TRACK_INVALID", "This media contains invalid track information.");
const unsupported = () => error("VAULT_MEDIA_TRACK_UNSUPPORTED", "This media track format is not supported.");
const exceeded = () => error("VAULT_MEDIA_TRACK_LIMIT", "This media exceeds the local track safety limits.");
const free = new Uint8Array([102, 114, 101, 101]);

export function parseMp4MediaTracks(input, { deadline, signal } = {}) {
  const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
  if (!bytes || bytes.byteLength > MP4_TRACK_LIMITS.inputBytes) throw exceeded();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const until = Number.isFinite(deadline) ? Math.min(deadline, now() + MP4_TRACK_LIMITS.milliseconds) : now() + MP4_TRACK_LIMITS.milliseconds;
  let boxCount = 0, sampleCount = 0, cueCount = 0, textBytes = 0;
  const cache = new Map();
  function check() {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    if (now() > until) throw exceeded();
  }
  function safe64(offset, signed = false) {
    const number = signed ? view.getBigInt64(offset) : view.getBigUint64(offset);
    if (number > BigInt(Number.MAX_SAFE_INTEGER) || number < BigInt(Number.MIN_SAFE_INTEGER)) throw exceeded();
    return Number(number);
  }
  const ascii = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  function boxes(start, end, top = false) {
    const key = start + ":" + end;
    if (cache.has(key)) return cache.get(key);
    const result = [];
    for (let offset = start; offset < end;) {
      check();
      if (++boxCount > MP4_TRACK_LIMITS.boxes) throw exceeded();
      if (offset + 8 > end) throw invalid();
      let size = view.getUint32(offset), header = 8;
      const type = ascii(offset + 4, 4);
      if (size === 1) { if (offset + 16 > end) throw invalid(); size = safe64(offset + 8); header = 16; }
      if (size === 0) { if (!top || !["mdat", "free", "skip"].includes(type)) throw unsupported(); size = end - offset; }
      if (size < header || offset + size > end || !Number.isSafeInteger(offset + size)) throw invalid();
      result.push({ start: offset, end: offset + size, payload: offset + header, type });
      offset += size;
    }
    cache.set(key, result); return result;
  }
  const children = box => boxes(box.payload, box.end);
  function one(items, type, optional = false) {
    const matches = items.filter(box => box.type === type);
    if (matches.length > 1 || !optional && !matches.length) throw invalid();
    return matches[0];
  }
  function payload(box, minimum, versions = [0]) {
    if (!box || box.end - box.payload < minimum || !versions.includes(bytes[box.payload])) throw invalid();
    return box.payload;
  }
  function table(box, stride, maximum = MP4_TRACK_LIMITS.samples, versions = [0]) {
    const start = payload(box, 8, versions), count = view.getUint32(start + 4);
    if (count > maximum) throw exceeded();
    if (start + 8 + count * stride !== box.end) throw invalid();
    return { start: start + 8, count, version: bytes[start] };
  }
  function label(raw) {
    if (raw.length > 1024) return "";
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch { return ""; }
    return text.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, "").trim().slice(0, 256);
  }
  function trackLabel(track, handler) {
    const user = one(children(track), "udta", true);
    const name = user && one(children(user), "name", true);
    if (name) { const title = label(bytes.subarray(name.payload, name.end)); if (title) return title; }
    const title = label(bytes.subarray(handler.payload + 24, handler.end));
    return /^(?:SoundHandler|SubtitleHandler|VideoHandler|Core Media (?:Audio|Video|Subtitle))$/u.test(title) ? "" : title;
  }
  function header(track) {
    const tkhd = one(children(track), "tkhd"), start = payload(tkhd, 4, [0, 1]), version = bytes[start];
    if (tkhd.end - start < (version ? 96 : 84)) throw invalid();
    const id = view.getUint32(start + (version ? 20 : 12));
    if (!id) throw invalid();
    const flags = bytes[start + 1] * 65536 + bytes[start + 2] * 256 + bytes[start + 3];
    return { id: String(id), flags, tkhd };
  }
  function mediaHeader(mdia) {
    const mdhd = one(children(mdia), "mdhd"), start = payload(mdhd, 4, [0, 1]), version = bytes[start];
    if (mdhd.end - start < (version ? 36 : 24)) throw invalid();
    const timescale = view.getUint32(start + (version ? 20 : 12)), packed = view.getUint16(start + (version ? 32 : 20));
    if (!timescale || timescale > 1000000000) throw invalid();
    const parts = [(packed >>> 10) & 31, (packed >>> 5) & 31, packed & 31];
    const language = !(packed & 0x8000) && parts.every(part => part >= 1 && part <= 26)
      ? String.fromCharCode(...parts.map(part => part + 96)) : "und";
    return { timescale, language };
  }
  function descriptions(stbl) {
    const stsd = one(children(stbl), "stsd"), start = payload(stsd, 8), count = view.getUint32(start + 4);
    if (!count || count > 64) throw exceeded();
    const entries = boxes(start + 8, stsd.end);
    if (entries.length !== count || entries.some(entry => entry.end - entry.payload < 8)) throw invalid();
    return entries;
  }
  function presentation(track, movieTimescale, mediaTimescale) {
    const edts = one(children(track), "edts", true), elst = edts && one(children(edts), "elst", true);
    if (!elst) return { offset: 0, start: 0, end: Infinity };
    const start = payload(elst, 8, [0, 1]), version = bytes[start], count = view.getUint32(start + 4), stride = version ? 20 : 12;
    if (count > 2) throw unsupported();
    if (start + 8 + count * stride !== elst.end) throw invalid();
    let lead = 0, active;
    for (let index = 0; index < count; index++) {
      const position = start + 8 + index * stride;
      const duration = version ? safe64(position) : view.getUint32(position);
      const mediaTime = version ? safe64(position + 8, true) : view.getInt32(position + 4);
      const rate = position + (version ? 16 : 8);
      if (view.getInt16(rate) !== 1 || view.getInt16(rate + 2) !== 0) throw unsupported();
      if (mediaTime === -1 && !active) { lead += duration / movieTimescale; continue; }
      if (mediaTime < 0 || active) throw unsupported();
      active = { offset: lead - mediaTime / mediaTimescale, start: lead, end: lead + duration / movieTimescale };
    }
    return active ?? (count ? { offset: 0, start: 0, end: 0 } : { offset: 0, start: 0, end: Infinity });
  }
  function sampleSizes(stbl) {
    const stsz = one(children(stbl), "stsz"), start = payload(stsz, 12), uniform = view.getUint32(start + 4), count = view.getUint32(start + 8);
    sampleCount += count;
    if (sampleCount > MP4_TRACK_LIMITS.samples || uniform > MP4_TRACK_LIMITS.sampleBytes) throw exceeded();
    if (start + 12 + (uniform ? 0 : count * 4) !== stsz.end) throw invalid();
    return Array.from({ length: count }, (_, index) => {
      const size = uniform || view.getUint32(start + 12 + index * 4);
      if (size > MP4_TRACK_LIMITS.sampleBytes) throw exceeded();
      return size;
    });
  }
  function sampleTimes(stbl, sizes) {
    const stts = table(one(children(stbl), "stts"), 8), times = [];
    let timestamp = 0;
    for (let index = 0; index < stts.count; index++) {
      check();
      const count = view.getUint32(stts.start + index * 8), duration = view.getUint32(stts.start + index * 8 + 4);
      if (!count || times.length + count > sizes.length) throw invalid();
      for (let sample = 0; sample < count; sample++) {
        if (!Number.isSafeInteger(timestamp + duration)) throw exceeded();
        times.push({ timestamp, duration, composition: 0 }); timestamp += duration;
      }
    }
    if (times.length !== sizes.length) throw invalid();
    const ctts = one(children(stbl), "ctts", true);
    if (ctts) {
      const entries = table(ctts, 8, MP4_TRACK_LIMITS.samples, [0, 1]); let sample = 0;
      for (let index = 0; index < entries.count; index++) {
        const position = entries.start + index * 8, count = view.getUint32(position);
        const offset = entries.version ? view.getInt32(position + 4) : view.getUint32(position + 4);
        if (!count || sample + count > times.length) throw invalid();
        for (let item = 0; item < count; item++) times[sample++].composition = offset;
      }
      if (sample !== times.length) throw invalid();
    }
    return times;
  }
  function samplePositions(stbl, sizes, entries, mediaRanges) {
    const stco = one(children(stbl), "stco", true), co64 = one(children(stbl), "co64", true);
    if ((!stco && !co64) || (stco && co64)) throw invalid();
    const offsets = table(stco ?? co64, stco ? 4 : 8);
    const mapping = table(one(children(stbl), "stsc"), 12), runs = [];
    for (let index = 0; index < mapping.count; index++) {
      const position = mapping.start + index * 12, firstChunk = view.getUint32(position), samples = view.getUint32(position + 4), description = view.getUint32(position + 8);
      if (!firstChunk || firstChunk > offsets.count || !samples || samples > sizes.length || description !== 1 || entries[description - 1]?.type !== "tx3g" ||
          index === 0 && firstChunk !== 1 || index && firstChunk <= runs.at(-1).firstChunk) throw invalid();
      runs.push({ firstChunk, samples });
    }
    if (sizes.length && (!runs.length || !offsets.count)) throw invalid();
    function insideMedia(position, size) {
      let low = 0, high = mediaRanges.length - 1;
      while (low <= high) {
        const middle = low + high >>> 1;
        if (mediaRanges[middle].payload <= position) low = middle + 1;
        else high = middle - 1;
      }
      return high >= 0 && position + size <= mediaRanges[high].end;
    }
    const positions = []; let run = 0;
    for (let chunk = 0; chunk < offsets.count; chunk++) {
      check();
      while (run + 1 < runs.length && runs[run + 1].firstChunk <= chunk + 1) run++;
      if (!runs[run] || positions.length + runs[run].samples > sizes.length) throw invalid();
      let position = stco ? view.getUint32(offsets.start + chunk * 4) : safe64(offsets.start + chunk * 8);
      for (let index = 0; index < runs[run].samples; index++) {
        const size = sizes[positions.length];
        if (!Number.isSafeInteger(position + size) || !insideMedia(position, size)) throw invalid();
        positions.push(position); position += size;
      }
    }
    if (positions.length !== sizes.length) throw invalid();
    const ordered = positions.map((position, index) => ({ position, end: position + sizes[index] })).sort((a, b) => a.position - b.position);
    for (let index = 1; index < ordered.length; index++) if (ordered[index].position < ordered[index - 1].end) throw invalid();
    return positions;
  }
  function subtitleText(position, size) {
    if (size < 2) throw invalid();
    const length = view.getUint16(position);
    if (length + 2 > size) throw invalid();
    textBytes += length;
    if (textBytes > MP4_TRACK_LIMITS.textBytes) throw exceeded();
    const data = bytes.subarray(position + 2, position + 2 + length);
    const encoding = data[0] === 0xff && data[1] === 0xfe ? "utf-16le" : data[0] === 0xfe && data[1] === 0xff ? "utf-16be" : "utf-8";
    let text;
    try { text = new TextDecoder(encoding, { fatal: true }).decode(data); } catch { throw invalid(); }
    return text.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "");
  }

  check();
  const top = boxes(0, bytes.length, true), moov = one(top, "moov"), movie = children(moov);
  if (top.some(box => box.type === "moof") || movie.some(box => box.type === "mvex" || box.type === "cmov")) throw unsupported();
  const mvhd = one(movie, "mvhd"), movieStart = payload(mvhd, 4, [0, 1]), movieVersion = bytes[movieStart];
  if (mvhd.end - movieStart < (movieVersion ? 32 : 20)) throw invalid();
  const movieTimescale = view.getUint32(movieStart + (movieVersion ? 20 : 12));
  if (!movieTimescale || movieTimescale > 1000000000) throw invalid();
  const tracks = movie.filter(box => box.type === "trak"), mediaRanges = top.filter(box => box.type === "mdat");
  if (tracks.length > MP4_TRACK_LIMITS.tracks) throw exceeded();
  if (!tracks.length || !mediaRanges.length) throw invalid();
  const audio = [], subtitles = [], trackData = new Map(), ids = new Set();
  for (const track of tracks) {
    check();
    const metadata = header(track);
    if (ids.has(metadata.id)) throw invalid();
    ids.add(metadata.id);
    const mdia = one(children(track), "mdia"), handler = one(children(mdia), "hdlr");
    const handlerStart = payload(handler, 24), kind = ascii(handlerStart + 8, 4), media = mediaHeader(mdia);
    if (kind !== "soun" && !["text", "sbtl", "subt", "clcp"].includes(kind)) continue;
    const minf = one(children(mdia), "minf"), stbl = one(children(minf), "stbl"), entries = descriptions(stbl);
    const info = { id: metadata.id, language: media.language, label: trackLabel(track, handler), default: !!(metadata.flags & 1) };
    if (kind === "soun") { audio.push({ ...info, codec: entries[0].type }); trackData.set(info.id, { track, ...metadata }); continue; }
    if (entries.length !== 1 || entries[0].type !== "tx3g") continue;
    let edit;
    try { edit = presentation(track, movieTimescale, media.timescale); }
    catch (error) { if (error.code === "VAULT_MEDIA_TRACK_UNSUPPORTED") continue; throw error; }
    const sizes = sampleSizes(stbl), times = sampleTimes(stbl, sizes), positions = samplePositions(stbl, sizes, entries, mediaRanges), cues = [];
    for (const [index, sample] of times.entries()) {
      check();
      const text = subtitleText(positions[index], sizes[index]);
      if (!text.trim()) continue;
      const start = Math.max(0, edit.start, (sample.timestamp + sample.composition) / media.timescale + edit.offset);
      const end = Math.min(edit.end, (sample.timestamp + sample.composition + sample.duration) / media.timescale + edit.offset);
      if (!Number.isFinite(start) || !Number.isFinite(end) || Math.max(start, end) > 8 * 86400) throw exceeded();
      if (end <= start) continue;
      if (++cueCount > MP4_TRACK_LIMITS.cues) throw exceeded();
      cues.push({ start, end, text });
    }
    subtitles.push({ ...info, format: "mov_text", cues });
  }
  const audioPatches = {};
  for (const item of audio) {
    const selected = trackData.get(item.id), patches = [];
    for (const other of audio) if (other.id !== item.id) patches.push({ offset: trackData.get(other.id).track.start + 4, bytes: Uint8Array.from(free) });
    // A nondefault track can be disabled in tkhd; enable the selected track in
    // addition to masking others. No atom sizes or media offsets change.
    const flags = selected.flags | 3;
    patches.push({ offset: selected.tkhd.payload + 1, bytes: new Uint8Array([flags >>> 16 & 255, flags >>> 8 & 255, flags & 255]) });
    audioPatches[item.id] = patches.sort((a, b) => a.offset - b.offset);
  }
  check(); return { container: "mp4", audio, audioPatches, subtitles };
}
