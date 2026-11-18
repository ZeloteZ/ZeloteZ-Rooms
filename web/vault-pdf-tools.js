const passiveAnnotations = new Set(["Text", "FreeText", "Line", "Square", "Circle", "Polygon", "PolyLine", "Highlight", "Underline", "Squiggly", "StrikeOut", "Stamp", "Caret", "Ink", "Popup"]);

export function sanitizePdfPage(page, library) {
  const { PDFName, PDFArray, PDFDict } = library;
  const name = key => PDFName.of(key);
  for (const key of ["AA", "PresSteps", "AF", "PieceInfo"]) page.node.delete(name(key));
  const annotations = page.node.lookupMaybe(name("Annots"), PDFArray);
  if (!annotations) return;
  const safe = page.doc.context.obj([]);
  for (const reference of annotations.asArray()) {
    let annotation;
    try { annotation = page.doc.context.lookup(reference, PDFDict); } catch { continue; }
    const subtype = annotation.lookupMaybe(name("Subtype"), PDFName)?.decodeText();
    if (!passiveAnnotations.has(subtype)) continue;
    for (const key of ["A", "AA", "FS", "RichMediaContent", "RichMediaSettings", "Sound", "Movie", "3DD", "3DA", "JS", "OpenAction", "AF"]) annotation.delete(name(key));
    // A passive popup must not retain an otherwise removed active annotation.
    for (const key of ["Parent", "Popup", "IRT"]) annotation.delete(name(key));
    safe.push(reference);
  }
  if (safe.size()) page.node.set(name("Annots"), safe);
  else page.node.delete(name("Annots"));
}

export async function exportPdfCopy(source, settings, { library, signal, noteImages = [] } = {}) {
  const aborted = () => { if (signal?.aborted) throw new DOMException("Cancelled", "AbortError"); };
  aborted();
  if (!Array.isArray(settings) || !settings.length || settings.length > 500 || source.byteLength > 64 * 1024 ** 2) throw new Error("Invalid PDF editor bounds");
  const original = await library.PDFDocument.load(source, { updateMetadata: false });
  aborted();
  if (original.getPageCount() > 500 || settings.some(value => !Number.isSafeInteger(value.original) || value.original < 0 || value.original >= original.getPageCount() || ![0, 90, 180, 270].includes(value.rotation))) throw new Error("Invalid PDF page selection");
  for (const page of original.getPages()) sanitizePdfPage(page, library);
  for (const key of ["OpenAction", "AA", "Names", "AcroForm", "AF", "Collection", "Perms"]) original.catalog.delete(library.PDFName.of(key));
  const output = await library.PDFDocument.create();
  const copied = await output.copyPages(original, settings.map(page => page.original));
  for (let index = 0; index < copied.length; index++) {
    aborted();
    const page = copied[index], selected = settings[index];
    page.setRotation(library.degrees((page.getRotation().angle + selected.rotation) % 360));
    output.addPage(page);
    const overlay = noteImages[index];
    if (overlay) {
      if (!(overlay instanceof Uint8Array) || overlay.byteLength > 16 * 1024 ** 2) throw new Error("Invalid PDF note image");
      const image = await output.embedPng(overlay);
      const bounds = page.getCropBox();
      const angle = ((page.getRotation().angle % 360) + 360) % 360;
      const quarter = angle % 180 !== 0;
      const placement = angle === 90 ? { x: bounds.x + bounds.width, y: bounds.y, rotate: library.degrees(90) }
        : angle === 180 ? { x: bounds.x + bounds.width, y: bounds.y + bounds.height, rotate: library.degrees(180) }
          : angle === 270 ? { x: bounds.x, y: bounds.y + bounds.height, rotate: library.degrees(270) } : { x: bounds.x, y: bounds.y };
      page.drawImage(image, { width: quarter ? bounds.height : bounds.width, height: quarter ? bounds.width : bounds.height, ...placement });
    }
  }
  aborted();
  const result = await output.save();
  aborted();
  if (result.byteLength > 128 * 1024 ** 2) throw new Error("PDF output exceeds editor size limit");
  return result;
}
