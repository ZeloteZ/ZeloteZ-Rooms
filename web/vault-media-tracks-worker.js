import { parseMkvMediaTracks } from "./vault-mkv-tracks.js";

self.onmessage = async event => {
  const bytes = event.data?.bytes;
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > 128 * 1024 ** 2) { self.postMessage({ error: true }); return; }
  const input = new Uint8Array(bytes), deadline = performance.now() + 14000;
  try {
    let result;
    if (input[0] === 0x1a && input[1] === 0x45 && input[2] === 0xdf && input[3] === 0xa3) result = parseMkvMediaTracks(input, { deadline });
    else {
      const { parseMp4MediaTracks } = await import("./vault-mp4-tracks.js");
      result = parseMp4MediaTracks(input, { deadline });
    }
    self.postMessage({ result });
  } catch { self.postMessage({ error: true }); }
  finally { input.fill(0); self.close(); }
};
