import { createMediaRangeReader } from "./vault-media-ranges.js";

const LIMIT = 128 * 1024 ** 2;
const decoder = new TextDecoder("utf-8", { fatal: true });
const unsupported = () => new Error("This media container cannot provide local track selection.");

export function parseMkvMediaTracks(input, { deadline = performance.now() + 15000, signal } = {}) {
  const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
  if (!bytes || bytes.length > LIMIT || bytes.length < 8 || bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) throw unsupported();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let nodes = 0, cueCount = 0, textBytes = 0;
  function check() { signal?.throwIfAborted(); if (performance.now() > deadline) throw unsupported(); }
  function vint(start, end, id = false) {
    if (start >= end || !bytes[start]) throw unsupported();
    let marker = 128, length = 1;
    while (!(bytes[start] & marker)) { marker >>= 1; length++; }
    if (length > (id ? 4 : 8) || start + length > end) throw unsupported();
    let value = id ? bytes[start] : bytes[start] & (marker - 1), unknown = !id && value === marker - 1;
    for (let index = 1; index < length; index++) { value = value * 256 + bytes[start + index]; unknown &&= bytes[start + index] === 255; }
    if (!unknown && !Number.isSafeInteger(value)) throw unsupported();
    return { value, length, unknown };
  }
  function elements(start, end, visit) {
    let position = start;
    while (position < end) {
      if (++nodes > 200000) throw unsupported();
      if (nodes % 256 === 0) check();
      const id = vint(position, end, true), size = vint(position + id.length, end);
      const body = position + id.length + size.length;
      if (size.unknown && id.value !== 0x18538067) throw unsupported();
      const stop = size.unknown ? end : body + size.value;
      if (stop > end || stop < body) throw unsupported();
      visit({ id: id.value, start: position, body, end: stop }); position = stop;
    }
  }
  function integer(node) {
    if (node.end - node.body < 1 || node.end - node.body > 8) throw unsupported();
    let result = 0;
    for (let position = node.body; position < node.end; position++) result = result * 256 + bytes[position];
    if (!Number.isSafeInteger(result)) throw unsupported();
    return result;
  }
  function text(node, maximum = 1024) {
    if (node.end - node.body > maximum) throw unsupported();
    try { return decoder.decode(bytes.subarray(node.body, node.end)); } catch { throw unsupported(); }
  }
  let segment, documentType, scale = 1000000;
  const tracks = [], clusters = [], crcOffsets = [];
  function rememberCrc(offset) { if (crcOffsets.length >= 128) throw unsupported(); crcOffsets.push(offset); }
  elements(0, bytes.length, node => {
    if (node.id === 0x1a45dfa3) elements(node.body, node.end, field => { if (field.id === 0x4282) documentType = text(field, 32); });
    else if (node.id === 0x18538067) { if (segment) throw unsupported(); segment = node; }
  });
  if (!segment || !["matroska", "webm"].includes(documentType)) throw unsupported();
  function trackEntry(node) {
    if (tracks.length >= 64) throw unsupported();
    const track = { language: "und", label: "", default: true, enabled: true };
    elements(node.body, node.end, field => {
      if (field.id === 0xd7) track.id = String(integer(field));
      else if (field.id === 0x83) { track.type = integer(field); track.typeField = field; }
      else if (field.id === 0x86) track.codec = text(field, 128);
      else if (field.id === 0x22b59c && !track.ietf) track.language = text(field, 64);
      else if (field.id === 0x22b59d) { track.language = text(field, 64); track.ietf = true; }
      else if (field.id === 0x536e) track.label = text(field);
      else if (field.id === 0x88) track.default = integer(field) === 1;
      else if (field.id === 0xb9) { track.enabled = integer(field) === 1; track.enabledField = field; }
      else if (field.id === 0x23e383) track.duration = integer(field) / 1e9;
      else if (field.id === 0x6d80) track.encoded = true;
      else if (field.id === 0xbf) rememberCrc(field.start);
    });
    if (!track.id || track.id === "0" || !track.typeField || tracks.some(item => item.id === track.id)) throw unsupported();
    tracks.push(track);
  }
  elements(segment.body, segment.end, node => {
    if (node.id === 0x1549a966) elements(node.body, node.end, field => { if (field.id === 0x2ad7b1) scale = integer(field); });
    else if (node.id === 0x1654ae6b) elements(node.body, node.end, field => {
      if (field.id === 0xae) trackEntry(field); else if (field.id === 0xbf) rememberCrc(field.start);
    });
    else if (node.id === 0x1f43b675) clusters.push(node);
    else if (node.id === 0xbf) rememberCrc(node.start);
  });
  if (!Number.isSafeInteger(scale) || scale < 1 || scale > 1e9) throw unsupported();
  const audioTracks = tracks.filter(track => track.type === 2), audioPatches = {};
  for (const selected of audioTracks) {
    const patches = crcOffsets.map(offset => ({ offset, bytes: new Uint8Array([0xec]) }));
    for (const track of audioTracks) {
      if (track !== selected) patches.push({ offset: track.typeField.body, bytes: new Uint8Array(track.typeField.end - track.typeField.body) });
      else if (track.enabledField && !track.enabled) {
        const value = new Uint8Array(track.enabledField.end - track.enabledField.body); value[value.length - 1] = 1;
        patches.push({ offset: track.enabledField.body, bytes: value });
      }
    }
    audioPatches[selected.id] = patches;
  }
  const subtitleTracks = tracks.filter(track => track.type === 17);
  const subtitles = subtitleTracks.map(track => ({ id: track.id, language: track.language, label: track.label,
    format: track.codec === "S_TEXT/UTF8" ? "srt" : ["S_TEXT/ASS", "S_TEXT/SSA"].includes(track.codec) ? "ass" : track.codec === "S_TEXT/WEBVTT" ? "vtt" : track.codec,
    supported: !track.encoded && ["S_TEXT/UTF8", "S_TEXT/ASS", "S_TEXT/SSA", "S_TEXT/WEBVTT"].includes(track.codec), cues: [] }));
  const subtitleById = new Map(subtitles.map(track => [track.id, track]));
  function assText(value) {
    const fields = value.split(",");
    if (fields.length < 9) return "";
    value = fields.slice(8).join(",");
    let drawing = false, output = "", offset = 0;
    for (const match of value.matchAll(/\{([^}]*)\}/gu)) {
      if (!drawing) output += value.slice(offset, match.index);
      for (const command of match[1].matchAll(/\\p(\d+)/gu)) drawing = Number(command[1]) > 0;
      offset = match.index + match[0].length;
    }
    if (!drawing) output += value.slice(offset);
    return output.replace(/\\[Nn]/gu, "\n").replace(/\\h/gu, "\u00a0");
  }
  function block(node, clusterTime, duration) {
    const number = vint(node.body, node.end), header = node.body + number.length;
    if (header + 3 > node.end) throw unsupported();
    const track = subtitleById.get(String(number.value));
    if (!track?.supported) return;
    if (bytes[header + 2] & 6) throw unsupported();
    const payload = node.end - header - 3;
    if (payload > 65536 || ++cueCount > 20000 || (textBytes += payload) > 2 * 1024 ** 2) throw unsupported();
    let value;
    try { value = decoder.decode(bytes.subarray(header + 3, node.end)); } catch { throw unsupported(); }
    if (track.format === "ass") value = assText(value);
    const start = Math.max(0, (clusterTime + view.getInt16(header)) * scale / 1e9);
    const fallback = tracks.find(item => item.id === track.id)?.duration;
    const length = duration === undefined ? fallback : duration * scale / 1e9;
    if (!Number.isFinite(start) || start > 7 * 86400 || (length !== undefined && (!Number.isFinite(length) || length < 0 || length > 86400))) throw unsupported();
    if (!value || length === 0) return;
    track.cues.push({ start, end: length === undefined ? null : start + length, text: value });
  }
  if (subtitles.some(track => track.supported)) for (const cluster of clusters) {
    check(); let clusterTime = 0;
    elements(cluster.body, cluster.end, node => { if (node.id === 0xe7) clusterTime = integer(node); });
    elements(cluster.body, cluster.end, node => {
      if (node.id === 0xa3) block(node, clusterTime);
      else if (node.id === 0xa0) {
        let packet, duration;
        elements(node.body, node.end, field => { if (field.id === 0xa1) packet = field; else if (field.id === 0x9b) duration = integer(field); });
        if (packet) block(packet, clusterTime, duration);
      }
    });
  }
  for (const track of subtitles) {
    track.cues.sort((a, b) => a.start - b.start);
    track.cues.forEach((cue, index) => { if (cue.end === null) cue.end = Math.max(cue.start + .001, track.cues[index + 1]?.start ?? cue.start + 5); });
  }
  check();
  return { container: "matroska", audio: audioTracks.map(track => ({ id: track.id, language: track.language, label: track.label, default: track.default && track.enabled })),
    audioPatches, subtitles };
}

function joined(parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  if (length > 16 * 1024 ** 2) throw unsupported();
  const result = new Uint8Array(length); let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function ebmlHeader(id, byteLength) {
  let hex = id.toString(16); if (hex.length % 2) hex = "0" + hex;
  const name = Uint8Array.from(hex.match(/../gu), part => parseInt(part, 16));
  let length = 1;
  while (byteLength >= 2 ** (length * 7) - 1) length++;
  const size = new Uint8Array(length); let remaining = byteLength;
  for (let index = length - 1; index >= 0; index--) { size[index] = remaining % 256; remaining = Math.floor(remaining / 256); }
  size[0] |= 1 << (8 - length);
  return joined([name, size]);
}
const ebmlElement = (id, data) => joined([ebmlHeader(id, data.length), data]);
function uintElement(id, value) {
  const bytes = [];
  do { bytes.unshift(value % 256); value = Math.floor(value / 256); } while (value);
  return ebmlElement(id, new Uint8Array(bytes));
}

export async function parseMkvBlobMediaTracks(blob, { deadline = performance.now() + 14000, signal, subtitleId } = {}) {
  const reader = createMediaRangeReader(blob, { deadline, signal });
  const owned = [], clusters = [], cueNodes = [], globalCrc = [];
  let nodes = 0, ebml, segment, info, tracks, selectedBytes = 0, selectedCount = 0, usedIndex = false;
  async function element(start, end) {
    if (++nodes > 2000000 || start >= end) throw unsupported();
    const bytes = await reader.header(start, Math.min(16, end - start));
    try {
      function vint(offset, id = false) {
        if (offset >= bytes.length || !bytes[offset]) throw unsupported();
        let marker = 128, length = 1;
        while (!(bytes[offset] & marker)) { marker >>= 1; length++; }
        if (length > (id ? 4 : 8) || offset + length > bytes.length) throw unsupported();
        let value = id ? bytes[offset] : bytes[offset] & (marker - 1), unknown = !id && value === marker - 1;
        for (let index = 1; index < length; index++) { value = value * 256 + bytes[offset + index]; unknown &&= bytes[offset + index] === 255; }
        if (!unknown && !Number.isSafeInteger(value)) throw unsupported();
        return { value, length, unknown };
      }
      const id = vint(0, true), size = vint(id.length), body = start + id.length + size.length;
      if (size.unknown && id.value !== 0x18538067) throw unsupported();
      const stop = size.unknown ? end : body + size.value;
      if (!Number.isSafeInteger(stop) || stop > end || stop < body) throw unsupported();
      return { id: id.value, start, body, end: stop };
    } finally { bytes.fill(0); }
  }
  async function walk(start, end, visit) {
    for (let offset = start; offset < end;) {
      reader.check(); const node = await element(offset, end);
      if (await visit(node) === false) return;
      offset = node.end;
    }
  }
  async function copy(node, maximum) {
    if (node.end - node.start > maximum) throw unsupported();
    const bytes = await reader.read(node.start, node.end - node.start); owned.push(bytes); return bytes;
  }
  function compact(captionClusters = []) {
    const body = [...(info ? [info.bytes] : []), tracks.bytes, ...captionClusters];
    const header = ebmlHeader(0x18538067, body.reduce((total, part) => total + part.length, 0));
    const bytes = joined([ebml.bytes, header, ...body]);
    const tracksStart = ebml.bytes.length + header.length + (info?.bytes.length || 0);
    try {
      const result = parseMkvMediaTracks(bytes, { deadline, signal });
      for (const patches of Object.values(result.audioPatches)) {
        for (const patch of patches) {
          if (patch.offset < tracksStart || patch.offset + patch.bytes.length > tracksStart + tracks.bytes.length) throw unsupported();
          patch.offset += tracks.start - tracksStart;
        }
        patches.push(...globalCrc.map(offset => ({ offset, bytes: new Uint8Array([0xec]) })));
        patches.sort((a, b) => a.offset - b.offset);
      }
      return { ...result, lazySubtitles: true, readBytes: reader.readBytes, indexedSubtitles: usedIndex };
    } finally { bytes.fill(0); }
  }
  try {
    await walk(0, reader.size, async node => {
      if (node.id === 0x1a45dfa3) { if (ebml) throw unsupported(); ebml = { ...node, bytes: await copy(node, 4096) }; }
      else if (node.id === 0x18538067) { if (segment) throw unsupported(); segment = node; }
    });
    if (!ebml || !segment) throw unsupported();
    await walk(segment.body, segment.end, async node => {
      if (node.id === 0x1549a966) { if (info) throw unsupported(); info = { ...node, bytes: await copy(node, 1024 ** 2) }; }
      else if (node.id === 0x1654ae6b) { if (tracks) throw unsupported(); tracks = { ...node, bytes: await copy(node, 8 * 1024 ** 2) }; }
      else if (node.id === 0x1f43b675) { if (clusters.length >= 100000) throw unsupported(); clusters.push(node); }
      else if (node.id === 0x1c53bb6b) { if (cueNodes.length >= 4) throw unsupported(); cueNodes.push(node); }
      else if (node.id === 0xbf) { if (globalCrc.length >= 128) throw unsupported(); globalCrc.push(node.start); }
    });
    if (!tracks) throw unsupported();
    const metadata = compact();
    if (subtitleId === undefined) return metadata;
    const selected = metadata.subtitles.find(track => track.id === subtitleId);
    if (!selected?.supported) return metadata;
    const captionClusters = [];
    const clusterByStart = new Map(clusters.map(cluster => [cluster.start, cluster]));
    async function cueIndex() {
      if (cueNodes.length !== 1 || cueNodes[0].end - cueNodes[0].start > 8 * 1024 ** 2) return null;
      const node = cueNodes[0], bytes = await copy(node, 8 * 1024 ** 2), references = [], seen = new Set();
      let incomplete = false;
      function each(start, end, visit) {
        for (let position = start; position < end;) {
          if (++nodes > 2000000) throw unsupported();
          if (nodes % 256 === 0) reader.check();
          function vint(offset, id) {
            if (offset >= end || !bytes[offset]) throw unsupported();
            let marker = 128, length = 1;
            while (!(bytes[offset] & marker)) { marker >>= 1; length++; }
            if (length > (id ? 4 : 8) || offset + length > end) throw unsupported();
            let value = id ? bytes[offset] : bytes[offset] & (marker - 1);
            for (let index = 1; index < length; index++) value = value * 256 + bytes[offset + index];
            if (!Number.isSafeInteger(value)) throw unsupported();
            return { value, length };
          }
          const id = vint(position, true), size = vint(position + id.length, false), body = position + id.length + size.length, stop = body + size.value;
          if (stop > end || stop < body) throw unsupported();
          visit({ id: id.value, body, end: stop }); position = stop;
        }
      }
      function integer(field) {
        if (field.end - field.body < 1 || field.end - field.body > 8) throw unsupported();
        let value = 0;
        for (let offset = field.body; offset < field.end; offset++) value = value * 256 + bytes[offset];
        if (!Number.isSafeInteger(value)) throw unsupported();
        return value;
      }
      each(node.body - node.start, bytes.length, point => {
        if (point.id !== 0xbb) return;
        const positions = []; let time;
        each(point.body, point.end, field => {
          if (field.id === 0xb3) time = integer(field);
          else if (field.id === 0xb7) {
            const value = {};
            each(field.body, field.end, entry => {
              if (entry.id === 0xf7) value.track = String(integer(entry));
              else if (entry.id === 0xf1) value.cluster = integer(entry);
              else if (entry.id === 0xf0) value.relative = integer(entry);
              else if (entry.id === 0xb2) value.duration = integer(entry);
              else if (entry.id === 0xea && integer(entry) !== 0) value.codecState = true;
            });
            if (positions.length >= 64) throw unsupported(); positions.push(value);
          }
        });
        for (const value of positions) if (value.track === subtitleId) {
          if (time === undefined || value.cluster === undefined || value.relative === undefined || value.duration === undefined || value.codecState) { incomplete = true; continue; }
          const clusterStart = segment.body + value.cluster, key = clusterStart + ":" + value.relative;
          if (!Number.isSafeInteger(clusterStart) || !clusterByStart.has(clusterStart)) throw unsupported();
          if (!seen.has(key)) { if (references.length >= 20000) throw unsupported(); references.push({ clusterStart, relative: value.relative }); seen.add(key); }
        }
      });
      return !incomplete && references.length ? references : null;
    }
    const index = await cueIndex(), indexed = index ? new Map() : null;
    usedIndex = indexed !== null;
    if (index) for (const reference of index) {
      const values = indexed.get(reference.clusterStart) || []; values.push(reference.relative); indexed.set(reference.clusterStart, values);
    }
    async function selectedBlock(node) {
      const header = await reader.header(node.body, Math.min(12, node.end - node.body));
      try {
        if (!header[0]) throw unsupported();
        let marker = 128, length = 1;
        while (!(header[0] & marker)) { marker >>= 1; length++; }
        if (length > 8 || length + 3 > header.length) throw unsupported();
        let id = header[0] & (marker - 1);
        for (let index = 1; index < length; index++) id = id * 256 + header[index];
        if (!Number.isSafeInteger(id)) throw unsupported();
        if (String(id) !== subtitleId) return null;
        const size = node.end - node.body - length - 3;
        if (size > 65536 || ++selectedCount > 20000 || (selectedBytes += size) > 2 * 1024 ** 2) throw unsupported();
        return copy(node, 65560);
      } finally { header.fill(0); }
    }
    for (const cluster of clusters) {
      if (indexed && !indexed.has(cluster.start)) continue;
      let timestamp;
      await walk(cluster.body, cluster.end, async node => {
        if (node.id !== 0xe7) return;
        if (node.end - node.body < 1 || node.end - node.body > 7) throw unsupported();
        const bytes = await reader.read(node.body, node.end - node.body);
        try {
          if (!bytes.length || bytes.length > 7) throw unsupported(); timestamp = 0;
          for (const byte of bytes) timestamp = timestamp * 256 + byte;
          if (!Number.isSafeInteger(timestamp)) throw unsupported();
        } finally { bytes.fill(0); }
        return false;
      });
      if (timestamp === undefined) throw unsupported();
      const packets = [];
      const readPacket = async node => {
        if (node.id === 0xa3) { const block = await selectedBlock(node); if (block) packets.push(block); }
        else if (node.id === 0xa0) {
          let block, duration;
          await walk(node.body, node.end, async child => {
            if (child.id === 0xa1) block = await selectedBlock(child);
            else if (child.id === 0x9b) duration = await copy(child, 16);
          });
          if (block) { const parts = joined(duration ? [block, duration] : [block]); const group = ebmlElement(0xa0, parts); owned.push(group); parts.fill(0); packets.push(group); }
        }
      };
      if (indexed) {
        for (const relative of indexed.get(cluster.start)) {
          const offset = cluster.body + relative;
          if (!Number.isSafeInteger(offset) || offset < cluster.body || offset >= cluster.end) throw unsupported();
          const packet = await element(offset, cluster.end);
          if (packet.id !== 0xa0 && packet.id !== 0xa3) throw unsupported();
          const before = selectedCount; await readPacket(packet);
          if (selectedCount === before) throw unsupported();
        }
      } else await walk(cluster.body, cluster.end, readPacket);
      if (packets.length) {
        const time = uintElement(0xe7, timestamp), body = joined([time, ...packets]), result = ebmlElement(0x1f43b675, body);
        owned.push(result); captionClusters.push(result); time.fill(0); body.fill(0);
      }
    }
    return compact(captionClusters);
  } finally { reader.dispose(); for (const bytes of owned) bytes.fill(0); }
}
