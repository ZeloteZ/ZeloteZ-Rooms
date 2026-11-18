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
