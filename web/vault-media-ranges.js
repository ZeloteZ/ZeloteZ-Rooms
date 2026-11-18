export const MEDIA_RANGE_LIMITS = Object.freeze({ inputBytes: 10 * 1024 ** 3, readBytes: 32 * 1024 ** 2,
  rangeBytes: 1024 ** 2, metadataBytes: 16 * 1024 ** 2, milliseconds: 14000 });
const failure = () => Object.assign(new Error("The media track metadata exceeds the local safety limits."), { code: "VAULT_MEDIA_TRACK_LIMIT" });

export function createMediaRangeReader(blob, { deadline = performance.now() + MEDIA_RANGE_LIMITS.milliseconds, signal } = {}) {
  if (!(blob instanceof Blob) || !Number.isSafeInteger(blob.size) || !blob.size || blob.size > MEDIA_RANGE_LIMITS.inputBytes) throw failure();
  const fileSize = blob.size;
  let total = 0, disposed = false;
  const pages = new Map();
  function check() { signal?.throwIfAborted(); if (disposed || performance.now() > deadline) throw failure(); }
  function range(offset, length) {
    check();
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > fileSize) throw failure();
  }
  async function exact(offset, length) {
    range(offset, length);
    if (length > MEDIA_RANGE_LIMITS.rangeBytes || total + length > MEDIA_RANGE_LIMITS.readBytes) throw failure();
    total += length;
    const result = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    try { check(); if (result.length !== length) throw failure(); return result; }
    catch (error) { result.fill(0); throw error; }
  }
  return { size: fileSize, check, get readBytes() { return total; },
    async header(offset, length = 16) {
      range(offset, length);
      const pageStart = Math.floor(offset / 64) * 64, pageEnd = Math.min(fileSize, pageStart + 64);
      if (offset + length > pageEnd) return exact(offset, length);
      let page = pages.get(pageStart);
      if (!page) {
        page = await exact(pageStart, pageEnd - pageStart);
        if (pages.size === 16) { const first = pages.keys().next().value; pages.get(first).fill(0); pages.delete(first); }
        pages.set(pageStart, page);
      }
      return page.slice(offset - pageStart, offset - pageStart + length);
    },
    async read(offset, length) {
      range(offset, length);
      if (length > MEDIA_RANGE_LIMITS.metadataBytes || total + length > MEDIA_RANGE_LIMITS.readBytes) throw failure();
      const result = new Uint8Array(length);
      try {
        for (let position = 0; position < length; position += MEDIA_RANGE_LIMITS.rangeBytes) {
          const part = await exact(offset + position, Math.min(MEDIA_RANGE_LIMITS.rangeBytes, length - position));
          result.set(part, position); part.fill(0);
        }
        return result;
      } catch (error) { result.fill(0); throw error; }
    },
    dispose() { if (disposed) return; disposed = true; for (const page of pages.values()) page.fill(0); pages.clear(); blob = null; },
  };
}
