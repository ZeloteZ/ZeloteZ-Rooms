self.onmessage = async event => {
  const { bytes, size, maximum, format = "deflate-raw" } = event.data ?? {};
  let reader, input, result;
  try {
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > 64 * 1024 ** 2 || !Number.isSafeInteger(size) || size < 0 ||
        !["deflate-raw", "gzip"].includes(format) || !Number.isSafeInteger(maximum) || maximum < 0 ||
        maximum > (format === "gzip" ? 128 : 32) * 1024 ** 2 || size > maximum) throw new Error("limit");
    input = new Uint8Array(bytes);
    let stream;
    try { stream = new DecompressionStream(format); } catch { throw new Error("unsupported"); }
    let position = 0;
    // Small compressed chunks prevent the decoder from expanding a complete
    // compression bomb in one native transform before the output limit runs.
    const source = new ReadableStream({ pull(controller) {
      if (position === input.length) { controller.close(); return; }
      const end = Math.min(input.length, position + 512);
      controller.enqueue(input.subarray(position, end)); position = end;
    } });
    reader = source.pipeThrough(stream).getReader();
    result = new Uint8Array(size);
    let total = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const offset = total; total += next.value.byteLength;
      if (total > size || total > maximum) { next.value.fill(0); throw new Error(total > maximum ? "limit" : "invalid"); }
      result.set(next.value, offset); next.value.fill(0);
    }
    if (total !== size) throw new Error("invalid");
    self.postMessage({ bytes: result.buffer }, [result.buffer]);
  } catch (error) {
    void reader?.cancel().catch(() => {});
    self.postMessage({ error: ["limit", "unsupported"].includes(error?.message) ? error.message : "invalid" });
  } finally { input?.fill(0); if (result?.byteLength) result.fill(0); }
};
