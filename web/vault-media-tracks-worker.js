import { parseMkvBlobMediaTracks } from "./vault-mkv-tracks.js";

self.onmessage = async event => {
  const blob = event.data?.blob, subtitleId = event.data?.subtitleId;
  if (!(blob instanceof Blob) || blob.size > 10 * 1024 ** 3 || subtitleId !== undefined &&
      (typeof subtitleId !== "string" || !subtitleId || subtitleId.length > 64)) { self.postMessage({ error: true }); return; }
  let header; const deadline = performance.now() + 14000;
  try {
    header = new Uint8Array(await blob.slice(0, Math.min(16, blob.size)).arrayBuffer());
    let result;
    if (header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) result = await parseMkvBlobMediaTracks(blob, { deadline, subtitleId });
    else {
      const { parseMp4BlobMediaTracks } = await import("./vault-mp4-tracks.js");
      result = await parseMp4BlobMediaTracks(blob, { deadline, subtitleId });
    }
    self.postMessage({ result });
  } catch { self.postMessage({ error: true }); }
  finally { header?.fill(0); self.close(); }
};
