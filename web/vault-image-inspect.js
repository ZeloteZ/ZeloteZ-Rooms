import { t } from "./i18n.js";
import { VAULT_EDITOR_LIMITS, abortEditor, editorOperation, imageCrop, rasterImageType, validateIconImage } from "./vault-media-edit.js";

export const VAULT_IMAGE_DECODE_BYTES = 512 * 1024 ** 2;

// Decode the first frame from a bounded stream. Blob-based createImageBitmap
// implementations may buffer the entire encoded source before decoding it.
export async function decodeVaultImage(blob, { signal } = {}) {
  const { type } = await inspectVaultImage(blob, { signal });
  const scope = new AbortController(), lifetime = signal ? AbortSignal.any([signal, scope.signal]) : scope.signal;
  const exceeded = () => new Error(t("The image’s first frame exceeds the local decoding safety limit.",
    "Das erste Bild überschreitet die lokale Sicherheitsgrenze für das Dekodieren."));
  let decoder, controller, stopped = false, streamFailure;
  function stop() {
    stopped = true;
    try { controller?.close(); } catch {}
    try { decoder?.close(); } catch {}
    controller = null; decoder = null;
  }
  lifetime.addEventListener("abort", stop, { once: true });
  async function bitmap(input) {
    if (typeof createImageBitmap !== "function") throw new Error(t("This file could not be decoded on this device.", "Diese Datei konnte auf diesem Gerät nicht gelesen werden."));
    const pending = createImageBitmap(input).then(value => {
      if (lifetime.aborted) { value.close(); throw new DOMException("Cancelled", "AbortError"); }
      return value;
    });
    return editorOperation(pending, { signal: lifetime, milliseconds: 30000 });
  }
  try {
    abortEditor(lifetime);
    const streaming = typeof ImageDecoder === "function" && typeof ImageDecoder.isTypeSupported === "function"
      && await editorOperation(ImageDecoder.isTypeSupported(type), { signal: lifetime });
    if (!streaming) {
      if (blob.size > VAULT_EDITOR_LIMITS.inputBytes) throw exceeded();
      return await bitmap(new Blob([blob], { type }));
    }
    let offset = 0;
    const data = new ReadableStream({ type: "bytes", start(value) { controller = value; }, async pull(value) {
      if (stopped || lifetime.aborted) { try { value.close(); } catch {} return; }
      if (offset === blob.size) { value.close(); return; }
      if (offset >= VAULT_IMAGE_DECODE_BYTES) { streamFailure = exceeded(); value.error(streamFailure); return; }
      let bytes;
      try {
        const length = Math.min(256 * 1024, blob.size - offset, VAULT_IMAGE_DECODE_BYTES - offset);
        bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
        if (stopped || lifetime.aborted) { bytes.fill(0); try { value.close(); } catch {} return; }
        if (bytes.length !== length) throw exceeded();
        offset += length;
        // A byte stream transfers the backing buffer to the consumer.
        value.enqueue(bytes); bytes = null;
      } catch (error) {
        if (bytes?.byteLength) bytes.fill(0);
        streamFailure = error; try { value.error(error); } catch {}
      }
    }, cancel() { stopped = true; controller = null; } });
    decoder = new ImageDecoder({ type, data, preferAnimation: false });
    const pending = decoder.decode({ frameIndex: 0, completeFramesOnly: true }).then(value => {
      if (lifetime.aborted) { value.image.close(); throw new DOMException("Cancelled", "AbortError"); }
      return value;
    });
    const decoded = await editorOperation(pending,
      { signal: lifetime, milliseconds: 30000 });
    stop();
    try {
      imageCrop(decoded.image.displayWidth, decoded.image.displayHeight);
      return await bitmap(decoded.image);
    } finally { decoded.image.close(); }
  } catch (error) {
    abortEditor(lifetime);
    if (streamFailure) throw streamFailure;
    if (error instanceof DOMException) throw new Error(t("This file could not be decoded on this device.", "Diese Datei konnte auf diesem Gerät nicht gelesen werden."));
    throw error;
  }
  finally { scope.abort(); lifetime.removeEventListener("abort", stop); stop(); }
}

// Only headers enter JavaScript memory. Compressed image data stays in the
// browser-managed Blob, and dimensions are checked before invoking a decoder.
export async function inspectVaultImage(blob, { signal } = {}) {
  const invalid = () => new Error(t("This image has invalid or unsupported dimension metadata.",
    "Dieses Bild enthält ungültige oder nicht unterstützte Größenangaben."));
  abortEditor(signal);
  if (!(blob instanceof Blob) || !blob.size || blob.size > VAULT_EDITOR_LIMITS.mediaBytes) throw invalid();
  let bytesRead = 0, nodes = 0;
  async function read(offset, length) {
    abortEditor(signal);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 ||
        length > 4 * 1024 ** 2 || offset + length > blob.size || (bytesRead += length) > 8 * 1024 ** 2 || ++nodes > 10000) throw invalid();
    const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    if (signal?.aborted) { bytes.fill(0); abortEditor(signal); }
    if (bytes.length !== length) throw invalid();
    return bytes;
  }
  const ascii = (bytes, start, end) => String.fromCharCode(...bytes.subarray(start, end));
  const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const checked = (width, height) => { imageCrop(width, height); return { type, width, height }; };
  const header = await read(0, Math.min(blob.size, 4096)), type = rasterImageType(header);
  if (!type) throw new Error(t("This file is not a supported raster image.", "Diese Datei ist kein unterstütztes Rasterbild."));
  if (type === "image/x-icon") { await validateIconImage(blob, { signal }); return { type }; }
  if (type === "image/png") {
    if (header.length < 33 || view(header).getUint32(8) !== 13 || ascii(header, 12, 16) !== "IHDR") throw invalid();
    return checked(view(header).getUint32(16), view(header).getUint32(20));
  }
  if (type === "image/gif") {
    if (header.length < 13) throw invalid();
    return checked(view(header).getUint16(6, true), view(header).getUint16(8, true));
  }
  if (type === "image/bmp") {
    if (header.length < 26) throw invalid();
    const size = view(header).getUint32(14, true);
    if (size === 12) return checked(view(header).getUint16(18, true), view(header).getUint16(20, true));
    if (![40, 52, 56, 108, 124].includes(size) || header.length < 14 + size) throw invalid();
    return checked(view(header).getInt32(18, true), Math.abs(view(header).getInt32(22, true)));
  }
  if (type === "image/jpeg") {
    let offset = 2;
    const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset < blob.size) {
      const prefix = await read(offset, Math.min(4, blob.size - offset));
      if (prefix.length < 2 || prefix[0] !== 0xff) throw invalid();
      if (prefix[1] === 0xff) { offset++; continue; }
      const marker = prefix[1];
      if (marker === 0xd9 || marker === 0xda || marker === 0 || marker === 0xd8) throw invalid();
      if (marker === 1 || marker >= 0xd0 && marker <= 0xd7) { offset += 2; continue; }
      if (prefix.length < 4) throw invalid();
      const length = view(prefix).getUint16(2);
      if (length < 2 || offset + length + 2 > blob.size) throw invalid();
      if (frames.has(marker)) {
        if (length < 8) throw invalid();
        const frame = await read(offset + 4, 5);
        return checked(view(frame).getUint16(3), view(frame).getUint16(1));
      }
      offset += length + 2;
    }
    throw invalid();
  }
  if (type === "image/webp") {
    const end = view(header).getUint32(4, true) + 8;
    if (end > blob.size || end < 20) throw invalid();
    for (let offset = 12; offset + 8 <= end;) {
      const chunk = await read(offset, 8), kind = ascii(chunk, 0, 4), size = view(chunk).getUint32(4, true);
      if (offset + 8 + size > end) throw invalid();
      if (["VP8X", "VP8L", "VP8 "].includes(kind)) {
        const bytes = await read(offset + 8, Math.min(size, 10));
        if (kind === "VP8X") {
          if (size !== 10) throw invalid();
          const u24 = start => bytes[start] + bytes[start + 1] * 256 + bytes[start + 2] * 65536;
          return checked(u24(4) + 1, u24(7) + 1);
        }
        if (kind === "VP8L") {
          if (bytes.length < 5 || bytes[0] !== 0x2f) throw invalid();
          return checked(1 + ((bytes[2] & 0x3f) << 8 | bytes[1]), 1 + ((bytes[4] & 15) << 10 | bytes[3] << 2 | bytes[2] >> 6));
        }
        if (bytes.length < 10 || bytes[3] !== 0x9d || bytes[4] !== 1 || bytes[5] !== 0x2a) throw invalid();
        return checked(view(bytes).getUint16(6, true) & 0x3fff, view(bytes).getUint16(8, true) & 0x3fff);
      }
      offset += 8 + size + (size & 1);
    }
    throw invalid();
  }
  if (type === "image/avif") {
    // AVIF's primary item's ispe property provides the output dimensions,
    // including derived grid images. Never feed an unbounded meta/mdat to JS.
    async function box(offset, end) {
      if (offset + 8 > end) throw invalid();
      const bytes = await read(offset, Math.min(16, end - offset));
      let size = view(bytes).getUint32(0), head = 8;
      if (size === 1) {
        if (bytes.length < 16) throw invalid();
        const large = view(bytes).getBigUint64(8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
        size = Number(large); head = 16;
      } else if (size === 0) size = end - offset;
      if (size < head || offset + size > end) throw invalid();
      return { type: ascii(bytes, 4, 8), start: offset + head, end: offset + size };
    }
    let meta;
    for (let offset = 0; offset < blob.size;) {
      const item = await box(offset, blob.size);
      if (item.type === "meta") { if (meta) throw invalid(); meta = item; }
      offset = item.end;
    }
    if (!meta || meta.end - meta.start > 4 * 1024 ** 2) throw invalid();
    const data = await read(meta.start, meta.end - meta.start), dv = view(data);
    if (data.length < 4 || dv.getUint32(0) !== 0) throw invalid();
    let count = 0;
    function children(start, end) {
      const result = [];
      for (let offset = start; offset < end;) {
        if (++count > 4096 || offset + 8 > end) throw invalid();
        const size = dv.getUint32(offset), head = size === 1 ? 16 : 8;
        let length = size;
        if (size === 1) {
          if (offset + 16 > end) throw invalid();
          const large = dv.getBigUint64(offset + 8);
          if (large > BigInt(data.length)) throw invalid();
          length = Number(large);
        } else if (size === 0) length = end - offset;
        if (length < head || offset + length > end) throw invalid();
        result.push({ type: ascii(data, offset + 4, offset + 8), start: offset + head, end: offset + length });
        offset += length;
      }
      return result;
    }
    const items = children(4, data.length), pitm = items.filter(item => item.type === "pitm"), iprp = items.filter(item => item.type === "iprp");
    if (pitm.length !== 1 || iprp.length !== 1) throw invalid();
    const primary = pitm[0];
    if (primary.end - primary.start < 6 || data[primary.start] > 1) throw invalid();
    const primaryId = data[primary.start] === 0 ? dv.getUint16(primary.start + 4) : primary.end - primary.start >= 8 ? dv.getUint32(primary.start + 4) : null;
    const groups = children(iprp[0].start, iprp[0].end), ipco = groups.filter(item => item.type === "ipco"), ipma = groups.filter(item => item.type === "ipma");
    if (primaryId === null || ipco.length !== 1 || ipma.length !== 1) throw invalid();
    const properties = children(ipco[0].start, ipco[0].end);
    const dimensions = new Map();
    properties.forEach((property, index) => {
      if (property.type !== "ispe") return;
      if (property.end - property.start !== 12 || dv.getUint32(property.start) !== 0) throw invalid();
      dimensions.set(index + 1, checked(dv.getUint32(property.start + 4), dv.getUint32(property.start + 8)));
    });
    const associations = ipma[0], start = associations.start;
    if (associations.end - start < 8 || data[start] > 1 || (dv.getUint32(start) & 0xffffff) > 1) throw invalid();
    const wide = Boolean(data[start + 3] & 1), entries = dv.getUint32(start + 4);
    if (entries > 4096) throw invalid();
    let offset = start + 8, found;
    for (let index = 0; index < entries; index++) {
      const idBytes = data[start] ? 4 : 2;
      if (offset + idBytes + 1 > associations.end) throw invalid();
      const itemId = idBytes === 4 ? dv.getUint32(offset) : dv.getUint16(offset); offset += idBytes;
      const length = data[offset++];
      for (let association = 0; association < length; association++) {
        if (offset + (wide ? 2 : 1) > associations.end) throw invalid();
        const property = wide ? dv.getUint16(offset) & 0x7fff : data[offset] & 0x7f; offset += wide ? 2 : 1;
        if (property > properties.length) throw invalid();
        if (itemId === primaryId && dimensions.has(property)) { if (found) throw invalid(); found = dimensions.get(property); }
      }
    }
    if (!found || offset !== associations.end) throw invalid();
    return found;
  }
  throw invalid();
}
