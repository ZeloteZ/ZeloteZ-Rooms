export const VAULT_ARCHIVE_LIMITS = Object.freeze({ inputBytes: 64 * 1024 ** 2, entryBytes: 32 * 1024 ** 2,
  expandedBytes: 128 * 1024 ** 2, entries: 2000, metadataBytes: 4 * 1024 ** 2, pathBytes: 1024, depth: 32, milliseconds: 15000 });

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const cp437 = Array.from("ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ");
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const invalid = () => Object.assign(new Error("This archive is damaged or contains unsafe entries."), { code: "VAULT_ARCHIVE_INVALID" });
const unsupported = () => Object.assign(new Error("This archive format or feature is not supported. Download it to open it locally."), { code: "VAULT_ARCHIVE_UNSUPPORTED" });
const exceeded = () => Object.assign(new Error("This archive exceeds the local safety limits. Download it to open it locally."), { code: "VAULT_ARCHIVE_LIMIT" });
const aborted = () => new DOMException("Cancelled", "AbortError");
const clock = () => globalThis.performance?.now() ?? Date.now();
function check(signal, deadline = Infinity) { if (signal?.aborted) throw aborted(); if (clock() > deadline) throw exceeded(); }
function bounds(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(VAULT_ARCHIVE_LIMITS, key))) throw invalid();
  const result = { ...VAULT_ARCHIVE_LIMITS, ...value };
  for (const key of Object.keys(result)) if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > VAULT_ARCHIVE_LIMITS[key]) throw exceeded();
  return result;
}
function utf8(bytes) { try { return decoder.decode(bytes); } catch { throw invalid(); } }
function ascii(bytes) { return Array.from(bytes, byte => String.fromCharCode(byte)).join(""); }
function equal(a, b) { return a.length === b.length && a.every((value, index) => value === b[index]); }
function zero(bytes, start, end) { for (let index = start; index < end; index++) if (bytes[index]) return false; return true; }
function crcUpdate(crc, bytes) { for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return crc; }
function crc32(bytes) { return (crcUpdate(0xffffffff, bytes) ^ 0xffffffff) >>> 0; }
async function checkedCrc(bytes, signal, deadline) {
  let crc = 0xffffffff;
  for (let offset = 0; offset < bytes.length; offset += 1024 ** 2) {
    check(signal, deadline); crc = crcUpdate(crc, bytes.subarray(offset, offset + 1024 ** 2));
    if (offset + 1024 ** 2 < bytes.length) await new Promise(resolve => setTimeout(resolve, 0));
  }
  check(signal, deadline); return (crc ^ 0xffffffff) >>> 0;
}
function archivePath(input, directory, limits) {
  if (typeof input !== "string" || !input || encoder.encode(input).length > limits.pathBytes ||
      /[\\\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(input) || input.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(input)) throw invalid();
  while (input.startsWith("./")) input = input.slice(2);
  if (input.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(input)) throw invalid();
  if (directory && (input === "." || input === "")) return null;
  if (directory && input.endsWith("/")) input = input.slice(0, -1);
  const parts = input.split("/");
  if (parts.length > limits.depth || parts.some(part => !part.trim() || part === "." || part === ".." || encoder.encode(part).length > 255)) throw invalid();
  return input;
}
const fold = value => value.normalize("NFC").toLocaleLowerCase("en-US");
function validateEntries(entries, limits) {
  if (entries.length > limits.entries) throw exceeded();
  const paths = new Map(); let total = 0;
  for (const entry of entries) {
    const key = fold(entry.path);
    if (paths.has(key)) throw invalid();
    paths.set(key, entry.kind); total += entry.size;
    if (!Number.isSafeInteger(total) || total > limits.expandedBytes) throw exceeded();
  }
  for (const key of paths.keys()) {
    const parts = key.split("/"); parts.pop();
    while (parts.length) { if (paths.get(parts.join("/")) === "file") throw invalid(); parts.pop(); }
  }
}
function zipExtra(bytes, rawName) {
  let unicode;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const seen = new Set();
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) throw invalid();
    const tag = view.getUint16(offset, true), length = view.getUint16(offset + 2, true); offset += 4;
    if (offset + length > bytes.length || seen.has(tag)) throw invalid();
    seen.add(tag);
    if ([0x0001, 0x756e].includes(tag) || tag === 0x000d && length > 12) throw unsupported();
    if (tag === 0x7075) {
      if (length < 5 || bytes[offset] !== 1 || view.getUint32(offset + 1, true) !== crc32(rawName)) throw invalid();
      unicode = utf8(bytes.subarray(offset + 5, offset + length));
    }
    offset += length;
  }
  return unicode;
}
function zipName(bytes, flags, extra) {
  const unicode = zipExtra(extra, bytes);
  const name = flags & 0x800 ? utf8(bytes) : Array.from(bytes, byte => byte < 128 ? String.fromCharCode(byte) : cp437[byte - 128]).join("");
  if (flags & 0x800 && unicode !== undefined && unicode !== name) throw invalid();
  return unicode ?? name;
}
function parseZip(bytes, limits, signal, deadline) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), size = bytes.length;
  const u16 = offset => view.getUint16(offset, true), u32 = offset => view.getUint32(offset, true);
  let end = -1;
  for (let offset = size - 22; offset >= Math.max(0, size - 65557); offset--) {
    if (u32(offset) === 0x06054b50 && offset + 22 + u16(offset + 20) === size) { end = offset; break; }
  }
  if (end < 0) throw invalid();
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) throw unsupported();
  const count = u16(end + 10), centralSize = u32(end + 12), centralOffset = u32(end + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw unsupported();
  if (count > limits.entries || centralSize > limits.metadataBytes) throw exceeded();
  if (centralOffset + centralSize !== end) throw invalid();
  const entries = [], ranges = []; let offset = centralOffset;
  for (let index = 0; index < count; index++) {
    check(signal, deadline);
    if (offset + 46 > end || u32(offset) !== 0x02014b50) throw invalid();
    const flags = u16(offset + 8), method = u16(offset + 10), crc = u32(offset + 16), compressed = u32(offset + 20), expanded = u32(offset + 24);
    const nameBytes = u16(offset + 28), extraBytes = u16(offset + 30), commentBytes = u16(offset + 32), local = u32(offset + 42), attributes = u32(offset + 38);
    if (u16(offset + 6) > 20 || flags & ~0x80e || ![0, 8].includes(method) || u16(offset + 34) || [compressed, expanded, local].includes(0xffffffff)) throw unsupported();
    const mode = attributes >>> 16 & 0xf000;
    if (mode && ![0x4000, 0x8000].includes(mode) || attributes & 0x400) throw unsupported();
    if (!nameBytes || offset + 46 + nameBytes + extraBytes + commentBytes > end) throw invalid();
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameBytes);
    const named = zipName(rawName, flags, bytes.subarray(offset + 46 + nameBytes, offset + 46 + nameBytes + extraBytes));
    const directory = named.endsWith("/") || mode === 0x4000 || (attributes & 0x10) !== 0;
    const path = archivePath(named, directory, limits);
    if (compressed > limits.inputBytes) throw exceeded();
    if (directory && (expanded !== 0 || crc !== 0) || method === 0 && expanded !== compressed) throw invalid();
    if (local + 30 > centralOffset || u32(local) !== 0x04034b50 || u16(local + 4) !== u16(offset + 6) || u16(local + 6) !== flags || u16(local + 8) !== method) throw invalid();
    const localNameLength = u16(local + 26), localExtraLength = u16(local + 28), start = local + 30 + localNameLength + localExtraLength;
    if (start + compressed > centralOffset || !equal(rawName, bytes.subarray(local + 30, local + 30 + localNameLength))) throw invalid();
    const localUnicode = zipExtra(bytes.subarray(local + 30 + localNameLength, start), rawName);
    if (localUnicode !== undefined && localUnicode !== named) throw invalid();
    if (directory && method === 8 && !equal(bytes.subarray(start, start + compressed), new Uint8Array([3, 0])) &&
        !equal(bytes.subarray(start, start + compressed), new Uint8Array([1, 0, 0, 255, 255]))) throw unsupported();
    const localCrc = u32(local + 14), localCompressed = u32(local + 18), localExpanded = u32(local + 22);
    let rangeEnd = start + compressed;
    if (flags & 8) {
      if (![0, crc].includes(localCrc) || ![0, compressed].includes(localCompressed) || ![0, expanded].includes(localExpanded)) throw invalid();
      let descriptor = rangeEnd;
      if (descriptor + 16 <= centralOffset && u32(descriptor) === 0x08074b50 && u32(descriptor + 4) === crc) descriptor += 4;
      if (descriptor + 12 > centralOffset || u32(descriptor) !== crc || u32(descriptor + 4) !== compressed || u32(descriptor + 8) !== expanded) throw invalid();
      rangeEnd = descriptor + 12;
    } else if (localCrc !== crc || localCompressed !== compressed || localExpanded !== expanded) throw invalid();
    ranges.push([local, rangeEnd]);
    if (path !== null) entries.push({ path, name: path.split("/").pop(), kind: directory ? "directory" : "file", size: expanded,
      compressedSize: compressed, method, crc, offset: start });
    offset += 46 + nameBytes + extraBytes + commentBytes;
  }
  if (offset !== end) throw invalid();
  ranges.sort((a, b) => a[0] - b[0]); let covered = 0;
  for (const [start, finish] of ranges) { if (start !== covered || finish < start) throw invalid(); covered = finish; }
  if (covered !== centralOffset) throw invalid();
  validateEntries(entries, limits); return entries;
}
function tarNumber(bytes) {
  let value = 0n;
  if (bytes[0] & 0x80) {
    if (bytes[0] & 0x40) throw invalid();
    for (let index = 0; index < bytes.length; index++) value = value * 256n + BigInt(index ? bytes[index] : bytes[index] & 0x7f);
  } else {
    const field = ascii(bytes);
    if (!/^[0-7 \0]*$/u.test(field)) throw invalid();
    const text = field.replace(/\0.*$/su, "").trim();
    if (text && !/^[0-7]+$/u.test(text)) throw invalid();
    value = text ? BigInt("0o" + text) : 0n;
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw exceeded();
  return Number(value);
}
function tarString(bytes) {
  const end = bytes.indexOf(0);
  if (end >= 0 && !zero(bytes, end, bytes.length)) throw invalid();
  return utf8(end < 0 ? bytes : bytes.subarray(0, end));
}
function paxRecords(bytes) {
  const result = new Map();
  for (let offset = 0; offset < bytes.length;) {
    let space = offset;
    while (space < Math.min(bytes.length, offset + 16) && bytes[space] !== 32) space++;
    const digits = ascii(bytes.subarray(offset, space));
    if (space >= bytes.length || !/^[1-9][0-9]*$/u.test(digits)) throw invalid();
    const length = Number(digits), end = offset + length;
    if (!Number.isSafeInteger(length) || length < space - offset + 4 || end > bytes.length || bytes[end - 1] !== 10) throw invalid();
    const record = utf8(bytes.subarray(space + 1, end - 1)), equals = record.indexOf("=");
    if (equals < 1) throw invalid();
    const key = record.slice(0, equals), value = record.slice(equals + 1);
    if (result.has(key) || key === "linkpath" || /sparse/iu.test(key) || /\0/u.test(record)) throw unsupported();
    result.set(key, value); offset = end;
  }
  return result;
}
function parseTar(bytes, limits, signal, deadline) {
  const entries = []; let offset = 0, metadata = 0, headers = 0, pax = null, longName = null, ended = false;
  while (offset + 512 <= bytes.length) {
    check(signal, deadline);
    const header = bytes.subarray(offset, offset + 512);
    if (zero(header, 0, 512)) {
      if (offset + 1024 > bytes.length || !zero(bytes, offset + 512, bytes.length) || pax || longName !== null) throw invalid();
      ended = true; break;
    }
    if (++headers > limits.entries * 3 + 16) throw exceeded();
    metadata += 512;
    let checksum = 0;
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (tarNumber(header.subarray(148, 156)) !== checksum) throw invalid();
    const magic = ascii(header.subarray(257, 263));
    if (magic !== "ustar\0" && magic !== "ustar " && !zero(header, 257, 263)) throw unsupported();
    let size = tarNumber(header.subarray(124, 136));
    const type = header[156], start = offset + 512;
    if ([120, 103, 76].includes(type)) {
      if (size > Math.min(limits.metadataBytes, 65536) || start + size > bytes.length) throw exceeded();
      metadata += size;
      const data = bytes.subarray(start, start + size);
      if (type === 76) {
        if (longName !== null || pax?.has("path")) throw invalid();
        longName = tarString(data);
      } else {
        const attributes = paxRecords(data);
        if (type === 103) { if (attributes.has("path") || attributes.has("size")) throw unsupported(); }
        else { if (pax) throw invalid(); pax = attributes; if (longName !== null && pax.has("path")) throw invalid(); }
      }
    } else {
      if (![0, 48, 53].includes(type) || !zero(header, 157, 257)) throw unsupported();
      if (pax?.has("size")) {
        const number = pax.get("size");
        if (!/^(?:0|[1-9][0-9]*)$/u.test(number)) throw invalid();
        size = Number(number); if (!Number.isSafeInteger(size)) throw exceeded();
      }
      const directory = type === 53;
      if (start + size > bytes.length) throw exceeded();
      if (directory && size !== 0) throw invalid();
      const prefix = magic === "ustar\0" ? tarString(header.subarray(345, 500)) : "";
      const storedName = tarString(header.subarray(0, 100));
      const name = pax?.get("path") ?? longName ?? (prefix ? prefix + "/" + storedName : storedName);
      const path = archivePath(name, directory, limits);
      if (path !== null) entries.push({ path, name: path.split("/").pop(), kind: directory ? "directory" : "file", size, compressedSize: size, method: 0, offset: start });
      if (entries.length > limits.entries) throw exceeded();
      pax = null; longName = null;
    }
    if (metadata > limits.metadataBytes) throw exceeded();
    const next = start + Math.ceil(size / 512) * 512;
    if (next > bytes.length || !zero(bytes, start + size, next)) throw invalid();
    offset = next;
  }
  if (!ended) throw invalid();
  validateEntries(entries, limits); return entries;
}
function inflate(bytes, expected, signal, limits, format = "deflate-raw", maximum = limits.entryBytes) {
  check(signal);
  if (typeof Worker !== "function") throw unsupported();
  return new Promise((resolve, reject) => {
    let worker;
    try { worker = new Worker(new URL("./vault-archive-worker.js", import.meta.url), { type: "module" }); }
    catch { reject(unsupported()); return; }
    let finished = false;
    const done = (error, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener("abort", cancel); worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    const cancel = () => done(aborted());
    const timer = setTimeout(() => done(exceeded()), limits.milliseconds);
    signal?.addEventListener("abort", cancel, { once: true });
    worker.onerror = () => done(invalid());
    worker.onmessage = event => {
      const result = event.data;
      const wipe = () => {
        if (result?.bytes instanceof ArrayBuffer) { if (result.bytes.byteLength) new Uint8Array(result.bytes).fill(0); }
        else if (ArrayBuffer.isView(result?.bytes)) new Uint8Array(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength).fill(0);
      };
      if (finished || signal?.aborted) { wipe(); if (!finished) done(aborted()); return; }
      if (result?.error) { wipe(); done(result.error === "unsupported" ? unsupported() : result.error === "limit" ? exceeded() : invalid()); return; }
      if (!(result?.bytes instanceof ArrayBuffer) || result.bytes.byteLength !== expected) { wipe(); done(invalid()); return; }
      done(null, new Uint8Array(result.bytes));
    };
    try { worker.postMessage({ bytes: bytes.buffer, size: expected, maximum, format }, [bytes.buffer]); }
    catch { done(invalid()); }
    if (signal?.aborted) cancel();
  });
}

export async function openVaultArchive(blob, { signal, limits: options } = {}) {
  const limits = bounds(options); check(signal);
  if (!(blob instanceof Blob)) throw invalid();
  if (blob.size > limits.inputBytes) throw exceeded();
  let bytes = new Uint8Array(await blob.arrayBuffer()); blob = null;
  const controller = new AbortController(), lifetime = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const deadline = clock() + limits.milliseconds;
  let descriptors, format;
  try {
    check(lifetime, deadline);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (bytes.length < 18 || bytes[2] !== 8 || bytes[3] & 0xe0) throw unsupported();
      const size = new DataView(bytes.buffer).getUint32(bytes.length - 4, true);
      if (size > limits.expandedBytes) throw exceeded();
      try { bytes = await inflate(bytes, size, lifetime, limits, "gzip", limits.expandedBytes); }
      catch (error) { if (error?.code === "VAULT_ARCHIVE_INVALID") throw unsupported(); throw error; }
      check(lifetime, deadline); format = "tar.gz"; descriptors = parseTar(bytes, limits, lifetime, deadline);
    } else {
    const signature = bytes.length >= 4 ? new DataView(bytes.buffer).getUint32(0, true) : 0;
    if ([0x04034b50, 0x06054b50].includes(signature)) { format = "zip"; descriptors = parseZip(bytes, limits, lifetime, deadline); }
    else { format = "tar"; descriptors = parseTar(bytes, limits, lifetime, deadline); }
    }
    check(lifetime, deadline);
  } catch (error) { if (bytes.byteLength) bytes.fill(0); throw error; }
  const records = new Map(descriptors.map(entry => [entry.path, entry]));
  const entries = Object.freeze(descriptors.map(entry => Object.freeze({ path: entry.path, name: entry.name, kind: entry.kind, size: entry.size,
    compressedSize: entry.compressedSize, readable: entry.kind === "file" && entry.size <= limits.entryBytes })));
  let closed = false, queue = Promise.resolve(), returned = 0;
  function close() { if (!closed) { closed = true; controller.abort(); bytes.fill(0); bytes = null; } }
  signal?.addEventListener("abort", close, { once: true });
  return {
    format, entries, limits: Object.freeze(limits),
    read(input, { signal: requestSignal, maxBytes = limits.entryBytes } = {}) {
      const operation = queue.then(async () => {
        const active = requestSignal ? AbortSignal.any([lifetime, requestSignal]) : lifetime;
        check(active);
        if (closed) throw aborted();
        const entry = records.get(typeof input === "string" ? input : input?.path);
        if (!entry || entry.kind !== "file") throw invalid();
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > limits.entryBytes || entry.size > maxBytes || returned + entry.size > limits.expandedBytes) throw exceeded();
        returned += entry.size;
        const until = clock() + limits.milliseconds;
        let result, data;
        try {
          data = bytes.slice(entry.offset, entry.offset + entry.compressedSize);
          result = entry.method === 8 ? await inflate(data, entry.size, active, limits) : data;
          if (result.length !== entry.size || entry.crc !== undefined && await checkedCrc(result, active, until) !== entry.crc) throw invalid();
          check(active, until); return result;
        } catch (error) { result?.fill(0); if (data?.byteLength) data.fill(0); throw error; }
      });
      queue = operation.catch(() => {});
      return operation;
    },
    close() { signal?.removeEventListener("abort", close); close(); },
  };
}

export async function writeVaultZip(input, { signal, limits: options } = {}) {
  const limits = bounds(options), deadline = clock() + limits.milliseconds;
  if (!Array.isArray(input) || input.length > limits.entries) throw exceeded();
  check(signal, deadline);
  const files = [], local = [], central = [], payloads = []; let cursor = 0, total = 0, metadata = 0;
  try {
    for (const item of input) {
      check(signal, deadline);
      if (!item || typeof item.name !== "string") throw invalid();
      const directory = item.kind === "directory" || item.name.endsWith("/");
      const path = archivePath(item.name, directory, limits); if (path === null) throw invalid();
      if (!directory && !(item.data instanceof Uint8Array) && typeof item.data !== "string" || directory && item.data !== undefined && item.data?.length !== 0) throw invalid();
      if ((item.data?.length ?? 0) > limits.entryBytes) throw exceeded();
      const data = directory ? new Uint8Array() : typeof item.data === "string" ? encoder.encode(item.data) : Uint8Array.from(item.data);
      payloads.push(data);
      if (data.length > limits.entryBytes) throw exceeded();
      files.push({ path, kind: directory ? "directory" : "file", size: data.length });
      total += data.length; metadata += encoder.encode(path).length;
      if (total > limits.expandedBytes || metadata > limits.metadataBytes) throw exceeded();
      const name = encoder.encode(path + (directory ? "/" : ""));
      const crc = await checkedCrc(data, signal, deadline);
      const header = new Uint8Array(30 + name.length), h = new DataView(header.buffer);
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true); h.setUint16(12, 33, true);
      h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); header.set(name, 30);
      const record = new Uint8Array(46 + name.length), c = new DataView(record.buffer);
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 0x314, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true); c.setUint16(14, 33, true);
      c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
      c.setUint32(38, ((directory ? 0o40755 : 0o100600) << 16 | (directory ? 0x10 : 0)) >>> 0, true); c.setUint32(42, cursor, true); record.set(name, 46);
      local.push(header, data); central.push(record); cursor += header.length + data.length;
      if (cursor + central.reduce((sum, part) => sum + part.length, 0) + 22 > limits.inputBytes) throw exceeded();
    }
    validateEntries(files, limits);
    const centralSize = central.reduce((sum, part) => sum + part.length, 0), end = new Uint8Array(22), e = new DataView(end.buffer);
    if (centralSize > limits.metadataBytes) throw exceeded();
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, centralSize, true); e.setUint32(16, cursor, true);
    const result = new Blob([...local, ...central, end], { type: "application/zip" }); check(signal, deadline);
    return result;
  } finally { for (const payload of payloads) payload.fill(0); }
}
