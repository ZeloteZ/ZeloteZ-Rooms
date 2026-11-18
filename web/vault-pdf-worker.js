import * as library from "/vendor/pdf-lib-1.17.1/pdf-lib.esm.js";
import { exportPdfCopy } from "./vault-pdf-tools.js";

self.onmessage = async event => {
  try {
    const { source, pages, notes } = event.data;
    if (!(source instanceof ArrayBuffer) || !Array.isArray(notes) || notes.length > 500 || notes.reduce((sum, note) => sum + (note?.byteLength || 0), 0) > 64 * 1024 ** 2) throw new Error("Invalid PDF export request");
    const output = await exportPdfCopy(new Uint8Array(source), pages, { library, noteImages: notes.map(note => note ? new Uint8Array(note) : null) });
    self.postMessage({ bytes: output.buffer }, [output.buffer]);
  } catch (error) { self.postMessage({ error: error?.message || "PDF export failed" }); }
};
