import { t } from "./i18n.js";
import { button, el, field, select, status, tell } from "./ui.js";

export const VAULT_PDF_VIEWER_LIMITS = Object.freeze({ pages: 500, pagePixels: 16 * 1024 ** 2,
  residentPixels: 48 * 1024 ** 2, canvases: 4, canvasSide: 8192, milliseconds: 30000 });
const GAP = 16, PADDING = 16;
const aborted = () => new DOMException("Cancelled", "AbortError");
const pageError = () => new Error(t("This PDF page exceeds the local preview limit.", "Diese PDF-Seite überschreitet die lokale Vorschaugrenze."));
function cleanPage(page) { try { page?.cleanup(); } catch { /* The document owner handles final destruction. */ } }

function bounded(operation, signal, onStop, onLate) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (error) { try { onStop?.(); } catch { /* A failed cancel must not keep an await alive. */ } reject(error); } else resolve(value);
    };
    const abort = () => finish(aborted());
    const timer = setTimeout(() => {
      const error = new Error(t("The PDF operation timed out. Try a smaller document.", "Der PDF-Vorgang hat zu lange gedauert. Versuche ein kleineres Dokument."));
      error.code = "VAULT_PDF_TIMEOUT"; finish(error);
    }, VAULT_PDF_VIEWER_LIMITS.milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then(value => { if (finished) onLate?.(value); else finish(null, value); }, error => { if (finished) onLate?.(); else finish(error); });
    if (signal.aborted) abort();
  });
}

// The caller owns PDFDocumentProxy.destroy(); this viewer owns only its pages,
// passive render tasks, canvas surfaces, listeners and detached DOM.
export async function mountVaultPdfViewer(pdf, { signal, stage, disposers } = {}) {
  if (signal?.aborted) return null;
  if (!Number.isSafeInteger(pdf?.numPages) || pdf.numPages < 1 || pdf.numPages > VAULT_PDF_VIEWER_LIMITS.pages) throw pageError();
  const scope = new AbortController(), lifetime = signal ? AbortSignal.any([signal, scope.signal]) : scope.signal;
  let alive = true, revision = 0, resident = 0, current = 0, zoom = "fit", pumping = null, again = false, paused = false, resizeFrame = null;
  const records = new Map(), failed = new Set();
  const dimensions = Array.from({ length: pdf.numPages }, () => null), layouts = [];
  const jump = el("input", { type: "number", min: 1, max: pdf.numPages, step: 1, value: 1,
    inputmode: "numeric", class: "vault-pdf-page-input", "aria-label": t("Page", "Seite") });
  const previous = button("‹", () => go(current - 1), { class: "ghost", "aria-label": t("Previous page", "Vorherige Seite") });
  const next = button("›", () => go(current + 1), { class: "ghost", "aria-label": t("Next page", "Nächste Seite") });
  const zoomControl = select([["fit", t("Fit width", "Breite anpassen")], ...[25, 50, 75, 100, 125, 150, 200, 300].map(value => [String(value / 100), value + "%"])], "fit");
  zoomControl.className = "vault-pdf-zoom";
  const note = status(); note.className += " vault-pdf-status";
  const pages = el("div", { class: "vault-pdf-pages" });
  const scroller = el("div", { class: "vault-pdf-scroller", tabindex: 0, role: "region", "aria-label": t("PDF pages", "PDF-Seiten") }, pages);
  const slots = Array.from({ length: pdf.numPages }, (_, index) => {
    const placeholder = el("span", { class: "vault-pdf-placeholder" }, t("Page {number}", "Seite {number}", { number: index + 1 }));
    const slot = el("div", { class: "vault-pdf-page", "data-page": index + 1,
      role: "img", "aria-label": t("Page {number}", "Seite {number}", { number: index + 1 }) }, placeholder);
    pages.append(slot); return { node: slot, placeholder };
  });
  const toolbar = el("div", { class: "vault-pdf-toolbar" },
    el("div", { class: "vault-pdf-navigation" }, previous, field(t("Page", "Seite"), jump), el("span", { class: "subtle" }, "/ " + pdf.numPages), next),
    field(t("Zoom", "Zoom"), zoomControl), note);
  const root = el("section", { class: "vault-pdf-reader", "aria-label": t("PDF preview", "PDF-Vorschau") }, toolbar, scroller);
  const active = () => alive && !lifetime.aborted;
  function wipe(record) {
    if (!record.canvas) return;
    record.canvas.width = 0; record.canvas.height = 0; record.canvas.remove();
    resident -= record.pixels; record.pixels = 0;
  }
  function release(record) {
    record.cancelled = true;
    try { record.task?.cancel(); } catch { /* Always release the surface even if cancellation fails. */ }
    wipe(record); cleanPage(record.page);
    if (records.get(record.index) === record) records.delete(record.index);
    slots[record.index].placeholder.hidden = false;
  }
  function dispose() {
    if (!alive) return;
    alive = false; revision++; scope.abort(); observer?.disconnect();
    if (resizeFrame !== null) globalThis.cancelAnimationFrame?.(resizeFrame);
    resizeFrame = null;
    lifetime.removeEventListener("abort", dispose); scroller.removeEventListener("scroll", onScroll);
    globalThis.removeEventListener?.("resize", onResize);
    jump.removeEventListener("change", onJump); jump.removeEventListener("keydown", onJumpKey);
    zoomControl.removeEventListener("change", onZoom);
    for (const record of [...records.values()]) release(record);
    dimensions.fill(null); layouts.length = 0; failed.clear(); root.replaceChildren(); root.remove();
  }
  let observer;
  disposers?.push(dispose); lifetime.addEventListener("abort", dispose, { once: true });
  function viewSize() { return { width: Math.max(64, scroller.clientWidth || stage.clientWidth || 800), height: Math.max(64, scroller.clientHeight || stage.clientHeight || 600) }; }
  function anchor() {
    const top = scroller.scrollTop || 0;
    const index = Math.max(0, layouts.findIndex(layout => layout.top + layout.height > top));
    return { index, fraction: layouts[index] ? (top - layouts[index].top) / layouts[index].height : 0 };
  }
  function layout(keep) {
    const { width } = viewSize(), fallback = dimensions[0] || { width: 612, height: 792 };
    let top = PADDING, maximum = width;
    for (let index = 0; index < slots.length; index++) {
      const base = dimensions[index] || fallback;
      const scale = Math.min(zoom === "fit" ? Math.max(32, width - PADDING * 2) / base.width : Number(zoom), 32768 / Math.max(base.width, base.height));
      const size = { top, width: Math.max(1, base.width * scale), height: Math.max(1, base.height * scale), scale };
      layouts[index] = size;
      Object.assign(slots[index].node.style, { top: size.top + "px", width: size.width + "px", height: size.height + "px" });
      top += size.height + GAP; maximum = Math.max(maximum, size.width + PADDING * 2);
    }
    pages.style.width = maximum + "px"; pages.style.height = top - GAP + PADDING + "px";
    if (keep) scroller.scrollTop = Math.max(0, layouts[keep.index].top + keep.fraction * layouts[keep.index].height);
  }
  function wanted() {
    const { height } = viewSize(), top = scroller.scrollTop || 0, middle = top + height / 2;
    const visible = layouts.map((value, index) => ({ index, distance: Math.abs(value.top + value.height / 2 - middle),
      visible: value.top < top + height && value.top + value.height > top }))
      .sort((a, b) => Number(b.visible) - Number(a.visible) || a.distance - b.distance).slice(0, VAULT_PDF_VIEWER_LIMITS.canvases);
    return visible.map(value => value.index);
  }
  function navigation() {
    const top = (scroller.scrollTop || 0) + 1;
    const found = layouts.findIndex(value => value.top + value.height > top);
    current = found < 0 ? slots.length - 1 : found;
    if (document.activeElement !== jump) jump.value = String(current + 1);
    previous.disabled = current === 0; next.disabled = current === slots.length - 1;
  }
  function go(index) {
    if (!active()) return;
    current = Math.max(0, Math.min(slots.length - 1, index));
    jump.value = String(current + 1); scroller.scrollTop = Math.max(0, layouts[current].top - PADDING);
    navigation(); void request();
  }
  function onJump() { const value = Number(jump.value); if (Number.isSafeInteger(value) && value >= 1 && value <= slots.length) go(value - 1); else jump.value = String(current + 1); }
  function onJumpKey(event) { if (event.key === "Enter") { event.preventDefault(); onJump(); } }
  function onScroll() { if (active()) { navigation(); void request(); } }
  function invalidate() {
    const keep = anchor(); revision++;
    for (const record of [...records.values()]) release(record);
    failed.clear(); layout(keep); navigation(); void request();
  }
  function onZoom() {
    if (!active() || !["fit", ".25", "0.25", "0.5", "0.75", "1", "1.25", "1.5", "2", "3"].includes(zoomControl.value)) return;
    zoom = zoomControl.value; invalidate();
  }
  let lastWidth = 0, lastHeight = 0;
  function onResize() {
    if (!active() || resizeFrame !== null) return;
    const updateSize = () => {
      resizeFrame = null;
      if (!active()) return;
      const size = viewSize();
      if (size.width === lastWidth && size.height === lastHeight) return;
      lastWidth = size.width; lastHeight = size.height; invalidate();
    };
    if (typeof globalThis.requestAnimationFrame === "function") resizeFrame = globalThis.requestAnimationFrame(updateSize);
    else updateSize();
  }
  function validBase(base) {
    if (![base.width, base.height].every(value => Number.isFinite(value) && value >= 1 / 64 && value <= 1000000) ||
      Math.max(base.width / base.height, base.height / base.width) > 10000) throw pageError();
  }
  async function render(index) {
    const record = { index, cancelled: false, page: null, canvas: null, pixels: 0, task: null };
    records.set(index, record); const version = revision;
    try {
      record.page = await bounded(pdf.getPage(index + 1), lifetime, null, cleanPage);
      if (!active() || record.cancelled || version !== revision || !wanted().includes(index)) { release(record); return; }
      const base = record.page.getViewport({ scale: 1 }); validBase(base);
      const keep = anchor(); dimensions[index] = { width: base.width, height: base.height }; layout(keep);
      // Four resident surfaces share the aggregate budget even for high-DPI zoom.
      const cap = Math.min(VAULT_PDF_VIEWER_LIMITS.pagePixels, Math.floor(VAULT_PDF_VIEWER_LIMITS.residentPixels / VAULT_PDF_VIEWER_LIMITS.canvases));
      let scale = layouts[index].scale * Math.min(2, Math.max(1, Number(globalThis.devicePixelRatio) || 1));
      scale = Math.min(scale, VAULT_PDF_VIEWER_LIMITS.canvasSide / Math.max(base.width, base.height), Math.sqrt(cap / (base.width * base.height)));
      let viewport = record.page.getViewport({ scale });
      let width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
      if (width * height > cap) { scale *= Math.sqrt(cap / (width * height)) * .999; viewport = record.page.getViewport({ scale }); width = Math.ceil(viewport.width); height = Math.ceil(viewport.height); }
      if (![width, height].every(value => Number.isSafeInteger(value) && value >= 1 && value <= VAULT_PDF_VIEWER_LIMITS.canvasSide) ||
        width * height > cap || resident + width * height > VAULT_PDF_VIEWER_LIMITS.residentPixels) throw pageError();
      const canvas = el("canvas", { class: "vault-pdf-page-canvas", "aria-hidden": true });
      record.canvas = canvas; record.pixels = width * height; resident += record.pixels;
      canvas.width = width; canvas.height = height; slots[index].node.append(canvas);
      const context = canvas.getContext("2d", { alpha: false }); if (!context) throw pageError();
      record.task = record.page.render({ canvasContext: context, viewport, annotationMode: 0 });
      await bounded(record.task.promise, lifetime, () => { try { record.task.cancel(); } finally { wipe(record); } }, () => { if (record.cancelled || !active()) { wipe(record); cleanPage(record.page); } });
      if (!active() || record.cancelled || version !== revision || !wanted().includes(index)) { release(record); return; }
      slots[index].placeholder.hidden = true;
    } catch (error) {
      release(record);
      if (active() && version === revision) {
        if (error.code === "VAULT_PDF_TIMEOUT") paused = true;
        if (error.name !== "RenderingCancelledException") { failed.add(index); tell(note, error.code === "VAULT_PDF_TIMEOUT" ? error.message : t("This PDF page could not be displayed.", "Diese PDF-Seite konnte nicht angezeigt werden."), "error vault-pdf-status"); }
      }
    } finally { if (record.cancelled || !active()) { wipe(record); cleanPage(record.page); } }
  }
  async function update() {
    for (;;) {
      if (!active() || paused) return;
      const target = wanted();
      for (const record of [...records.values()]) if (!target.includes(record.index)) release(record);
      const index = target.find(value => !records.has(value) && !failed.has(value));
      if (index === undefined) return;
      await render(index);
    }
  }
  function request() {
    if (!active() || paused) return Promise.resolve();
    const target = wanted();
    for (const record of [...records.values()]) if (!target.includes(record.index)) release(record);
    again = true;
    if (!pumping) pumping = (async () => {
      do { again = false; await update(); } while (again && active() && !paused);
    })().catch(() => { if (active()) tell(note, t("This PDF page could not be displayed.", "Diese PDF-Seite konnte nicht angezeigt werden."), "error vault-pdf-status"); })
      .finally(() => { pumping = null; });
    return pumping;
  }
  jump.addEventListener("change", onJump); jump.addEventListener("keydown", onJumpKey);
  zoomControl.addEventListener("change", onZoom); scroller.addEventListener("scroll", onScroll, { passive: true });
  if (typeof ResizeObserver === "function") { observer = new ResizeObserver(onResize); observer.observe(scroller); }
  else globalThis.addEventListener?.("resize", onResize);
  stage.append(root); layout(); navigation(); await request();
  return null;
}
