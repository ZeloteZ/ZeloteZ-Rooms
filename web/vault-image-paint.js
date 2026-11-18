import { t } from "./i18n.js";
import { decodeVaultImage } from "./vault-image-inspect.js";
import { abortEditor, canvasBlob, imageCrop, VAULT_EDITOR_LIMITS } from "./vault-media-edit.js";

export const VAULT_PAINT_LIMITS = Object.freeze({ historyBytes: 32 * 1024 ** 2, historyEntries: 32,
  tileSize: 256, fillStack: 1024 ** 2, operationMs: 15000, textCharacters: 256 });
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const wipe = record => { for (const patch of record.patches.values()) patch.data.data.fill(0); record.patches.clear(); record.bytes = 0; };

export function paintSelectionRect(a, b, width, height) {
  if (![a?.x, a?.y, b?.x, b?.y].every(Number.isFinite)) return null;
  const x = clamp(Math.floor(Math.min(a.x, b.x)), 0, width - 1), y = clamp(Math.floor(Math.min(a.y, b.y)), 0, height - 1);
  return { x, y, width: Math.max(1, clamp(Math.ceil(Math.max(a.x, b.x)) + 1, x + 1, width) - x),
    height: Math.max(1, clamp(Math.ceil(Math.max(a.y, b.y)) + 1, y + 1, height) - y) };
}

// Each history item owns one set of BEFORE pixels. Undo/redo swap those pixels
// with the canvas instead of retaining both versions. Public state exposes no
// pixel arrays. Temporary swaps add at most one history budget to peak memory.
export function createPaintHistory({ maxBytes = VAULT_PAINT_LIMITS.historyBytes } = {}) {
  const budget = Number.isSafeInteger(maxBytes) && maxBytes >= 0 && maxBytes <= VAULT_PAINT_LIMITS.historyBytes ? maxBytes : VAULT_PAINT_LIMITS.historyBytes;
  const undo = [], redo = []; let bytes = 0;
  const discard = stack => { for (const item of stack) { bytes -= item.bytes; wipe(item); } stack.length = 0; };
  function capture(record, context, rect) {
    if (record.barrier) return;
    const size = VAULT_PAINT_LIMITS.tileSize;
    const x0 = clamp(Math.floor(rect.x), 0, context.canvas.width), y0 = clamp(Math.floor(rect.y), 0, context.canvas.height);
    const x1 = clamp(Math.ceil(rect.x + rect.width), 0, context.canvas.width), y1 = clamp(Math.ceil(rect.y + rect.height), 0, context.canvas.height);
    for (let y = Math.floor(y0 / size) * size; y < y1; y += size) for (let x = Math.floor(x0 / size) * size; x < x1; x += size) {
      const key = x + ":" + y;
      if (record.patches.has(key)) continue;
      const width = Math.min(size, context.canvas.width - x), height = Math.min(size, context.canvas.height - y), count = width * height * 4;
      if (record.bytes + count > budget) { wipe(record); record.barrier = true; return; }
      record.patches.set(key, { x, y, data: context.getImageData(x, y, width, height) }); record.bytes += count;
    }
  }
  function begin(context, rect, target) {
    const record = { width: context.canvas.width, height: context.canvas.height, patches: new Map(), bytes: 0, barrier: false, whole: !!target };
    if (target) {
      if (Math.max(record.width * record.height, target.width * target.height) * 4 > budget) record.barrier = true;
      else {
        const data = context.getImageData(0, 0, record.width, record.height);
        record.patches.set("whole", { x: 0, y: 0, data }); record.bytes = data.data.byteLength;
      }
    } else if (rect) capture(record, context, rect);
    return record;
  }
  function commit(record) {
    discard(redo);
    if (record.barrier) { discard(undo); wipe(record); return false; }
    if (!record.bytes) return true;
    while (undo.length && (bytes + record.bytes > budget || undo.length >= VAULT_PAINT_LIMITS.historyEntries)) {
      const old = undo.shift(); bytes -= old.bytes; wipe(old);
    }
    undo.push(record); bytes += record.bytes; return true;
  }
  function swap(context, from, to) {
    const record = from.pop(); if (!record) return false;
    bytes -= record.bytes;
    const width = context.canvas.width, height = context.canvas.height;
    if (!record.whole && (record.width !== width || record.height !== height)) { wipe(record); discard(undo); discard(redo); return false; }
    const replacements = new Map();
    try {
      for (const [key, patch] of record.patches) replacements.set(key, { x: patch.x, y: patch.y,
        data: context.getImageData(patch.x, patch.y, record.whole ? width : patch.data.width, record.whole ? height : patch.data.height) });
      if (record.whole) { context.canvas.width = record.width; context.canvas.height = record.height; }
      for (const patch of record.patches.values()) context.putImageData(patch.data, patch.x, patch.y);
    } catch (error) {
      for (const patch of replacements.values()) patch.data.data.fill(0);
      wipe(record); discard(undo); discard(redo); throw error;
    }
    wipe(record); record.width = width; record.height = height; record.patches = replacements;
    record.bytes = [...replacements.values()].reduce((sum, patch) => sum + patch.data.data.byteLength, 0);
    while (undo.length && bytes + record.bytes > budget) { const old = undo.shift(); bytes -= old.bytes; wipe(old); }
    while (redo.length && bytes + record.bytes > budget) { const old = redo.shift(); bytes -= old.bytes; wipe(old); }
    to.push(record); bytes += record.bytes; return true;
  }
  return Object.freeze({ begin, capture, commit, cancel: wipe,
    undo: context => swap(context, undo, redo), redo: context => swap(context, redo, undo),
    clear() { discard(undo); discard(redo); },
    get state() { return Object.freeze({ undo: undo.length, redo: redo.length, bytes, budget }); } });
}

// The fill edits a bounded local pixel buffer, publishing only on success.
// The canvas is unchanged on cancellation, timeout or pathological stack growth.
export async function floodPaintPixels(image, x, y, color, { signal } = {}) {
  const { width, height, data } = image;
  imageCrop(width, height);
  abortEditor(signal);
  if (!(data instanceof Uint8ClampedArray) || data.length !== width * height * 4 || !Number.isFinite(x) || !Number.isFinite(y) ||
      !Array.isArray(color) || color.length !== 4 || !color.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) throw new TypeError("Invalid local fill pixels");
  const start = (clamp(Math.floor(y), 0, height - 1) * width + clamp(Math.floor(x), 0, width - 1)) * 4;
  const original = data.slice(start, start + 4);
  if (original.every((value, index) => value === color[index])) { original.fill(0); return false; }
  const stack = new Uint32Array(Math.min(width * height, VAULT_PAINT_LIMITS.fillStack));
  let top = 0, writes = 0, checkpoint = performance.now(), deadline = checkpoint + VAULT_PAINT_LIMITS.operationMs;
  const matches = index => original.every((value, channel) => data[index * 4 + channel] === value);
  const push = index => { if (top >= stack.length) throw new Error(t("This fill exceeds the local safety limit.", "Diese Füllung überschreitet die lokale Sicherheitsgrenze.")); stack[top++] = index; };
  push(start / 4);
  try {
    while (top) {
      const at = stack[--top]; if (!matches(at)) continue;
      const row = Math.floor(at / width), column = at % width;
      let left = column, right = column;
      while (left > 0 && matches(row * width + left - 1)) left--;
      while (right + 1 < width && matches(row * width + right + 1)) right++;
      for (let next = left; next <= right; next++) {
        data.set(color, (row * width + next) * 4);
        if (++writes % 65536 === 0) {
          abortEditor(signal);
          const now = performance.now();
          if (now > deadline) throw new Error(t("The local operation timed out.", "Der lokale Vorgang hat zu lange gedauert."));
          if (now - checkpoint > 8) { await new Promise(resolve => setTimeout(resolve, 0)); checkpoint = performance.now(); abortEditor(signal); }
        }
      }
      for (const neighbor of [row - 1, row + 1]) if (neighbor >= 0 && neighbor < height) {
        let span = false;
        for (let next = left; next <= right; next++) {
          const hit = matches(neighbor * width + next);
          if (hit && !span) push(neighbor * width + next);
          span = hit;
        }
      }
    }
    abortEditor(signal); return true;
  } finally { original.fill(0); stack.fill(0); }
}

export async function paintVaultImage(blob, { signal: outerSignal, stage, filename, disposers, dirtyChanged }) {
  const local = new AbortController();
  const signal = outerSignal ? AbortSignal.any([outerSignal, local.signal]) : local.signal;
  const { button, el, field, select, status, tell } = await import("./ui.js");
  abortEditor(signal);
  const image = await decodeVaultImage(blob, { signal });
  const canvas = el("canvas", { class: "vault-paint-canvas", tabindex: 0, "aria-label": t("Drawing canvas", "Zeichenfläche") });
  let context;
  try {
    abortEditor(signal); imageCrop(image.width, image.height);
    canvas.width = image.width; canvas.height = image.height; context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error(t("The image could not be opened.", "Das Bild konnte nicht geöffnet werden."));
    context.drawImage(image, 0, 0);
  } catch (error) { canvas.width = canvas.height = 1; throw error; }
  finally { image.close(); }
  const history = createPaintHistory();
  let alive = true, busy = false, pending = null, gesture = null, selection = null, zoom = 1;
  const tool = select([["pencil", t("Pencil", "Bleistift")], ["brush", t("Brush", "Pinsel")], ["eraser", t("Eraser", "Radierer")],
    ["fill", t("Fill", "Füllen")], ["picker", t("Eyedropper", "Pipette")], ["line", t("Line", "Linie")],
    ["rectangle", t("Rectangle", "Rechteck")], ["ellipse", t("Ellipse", "Ellipse")], ["text", t("Text", "Text")], ["select", t("Select", "Auswahl")]], "brush");
  tool.setAttribute("aria-label", t("Drawing tool", "Zeichenwerkzeug"));
  const color = el("input", { type: "color", value: "#222222", "aria-label": t("Color", "Farbe") });
  const palette = el("div", { class: "vault-paint-palette", role: "group", "aria-label": t("Color palette", "Farbpalette") });
  const swatches = ["#000000", "#777777", "#ffffff", "#a52a2a", "#e53935", "#ff9800", "#ffeb3b", "#8bc34a",
    "#2e7d32", "#00bcd4", "#1565c0", "#3949ab", "#7b1fa2", "#e91e63", "#f8bbd0", "#795548"].map(value => {
    const control = button("", () => { color.value = value; paintPalette(); }, { class: "vault-paint-swatch", "aria-label":
      t("Choose color {color}", "Farbe {color} wählen", { color: value }), "aria-pressed": "false", title: value });
    control.style.backgroundColor = value; palette.append(control); return [control, value];
  });
  function paintPalette() { for (const [control, value] of swatches) control.setAttribute("aria-pressed", String(color.value.toLowerCase() === value)); }
  color.addEventListener("input", paintPalette);
  const width = el("input", { type: "number", min: 1, max: 128, value: 5, "aria-label": t("Stroke width", "Strichbreite") });
  const text = el("input", { type: "text", maxlength: VAULT_PAINT_LIMITS.textCharacters, placeholder: t("Text", "Text"), "aria-label": t("Text", "Text") });
  const fontSize = el("input", { type: "number", min: 6, max: 256, value: 24, "aria-label": t("Text size", "Textgröße") });
  const format = select([["image/png", "PNG"], ["image/jpeg", "JPEG"], ["image/webp", "WebP"]], "image/png");
  format.setAttribute("aria-label", t("Output format", "Ausgabeformat"));
  const zoomChoice = select([["0.1", "10%"], ["0.25", "25%"], ["0.5", "50%"], ["1", "100%"], ["2", "200%"], ["4", "400%"]], "1");
  zoomChoice.setAttribute("aria-label", t("Zoom", "Zoom"));
  const note = status(), dimensions = el("span", { class: "subtle vault-paint-dimensions" });
  const overlay = el("div", { class: "vault-paint-selection", hidden: true, "aria-hidden": "true" });
  const paper = el("div", { class: "vault-paint-paper" }, canvas, overlay);
  const viewport = el("div", { class: "vault-paint-viewport", tabindex: 0, "aria-label": t("Image workspace", "Bildarbeitsfläche") }, paper);
  const undo = button(t("Undo", "Rückgängig"), () => historyAction("undo"), { class: "ghost" });
  const redo = button(t("Redo", "Wiederholen"), () => historyAction("redo"), { class: "ghost" });
  const crop = button(t("Crop selection", "Auswahl zuschneiden"), () => transform("crop"), { class: "ghost" });
  const targetWidth = el("input", { type: "number", min: 1, max: VAULT_EDITOR_LIMITS.imagePixels, value: canvas.width, "aria-label": t("Width", "Breite") });
  const targetHeight = el("input", { type: "number", min: 1, max: VAULT_EDITOR_LIMITS.imagePixels, value: canvas.height, "aria-label": t("Height", "Höhe") });
  const resize = button(t("Resize", "Größe ändern"), () => transform("resize"), { class: "ghost" });
  const rotate = button(t("Rotate 90°", "90° drehen"), () => transform("rotate"), { class: "ghost" });
  const flipX = button(t("Flip horizontally", "Horizontal spiegeln"), () => transform("flipX"), { class: "ghost" });
  const flipY = button(t("Flip vertically", "Vertikal spiegeln"), () => transform("flipY"), { class: "ghost" });
  const textOptions = el("div", { class: "vault-paint-text-options", hidden: true }, text, fontSize);
  const ribbon = el("div", { class: "vault-paint-ribbon", "aria-label": t("Image tools", "Bildwerkzeuge") },
    el("div", { class: "vault-paint-toolbar" }, tool, undo, redo, zoomChoice, format),
    el("div", { class: "vault-paint-options" }, field(t("Color", "Farbe"), color), palette, field(t("Width", "Breite"), width), textOptions,
      crop, rotate, flipX, flipY),
    el("div", { class: "vault-paint-resize" }, field(t("Width", "Breite"), targetWidth), field(t("Height", "Höhe"), targetHeight), resize));
  const host = el("section", { class: "vault-paint", "aria-label": t("Image editor", "Bildeditor") }, ribbon,
    viewport, el("div", { class: "vault-paint-status", "aria-live": "polite" }, dimensions, note));

  const current = () => alive && !signal?.aborted;
  const strokeWidth = chosen => chosen === "pencil" ? 1 : clamp(Number(width.value) || 1, 1, 128);
  function controls() {
    undo.disabled = busy || !!gesture || !history.state.undo; redo.disabled = busy || !!gesture || !history.state.redo;
    crop.disabled = busy || !!gesture || !selection;
    for (const control of [resize, rotate, flipX, flipY]) control.disabled = busy || !!gesture;
    dimensions.textContent = canvas.width + " × " + canvas.height + " px";
    paper.style.width = canvas.width * zoom + "px"; paper.style.height = canvas.height * zoom + "px";
    canvas.style.width = "100%"; canvas.style.height = "100%";
  }
  function selectionOverlay(rect, shape = "select") {
    overlay.hidden = !rect;
    if (!rect) return;
    Object.assign(overlay.style, { left: rect.x * zoom + "px", top: rect.y * zoom + "px", width: rect.width * zoom + "px", height: rect.height * zoom + "px" });
    overlay.dataset.shape = shape;
  }
  function changed(record) {
    const retained = history.commit(record); selection = null; selectionOverlay(null); dirtyChanged();
    targetWidth.value = String(canvas.width); targetHeight.value = String(canvas.height); controls();
    tell(note, retained ? "" : t("This operation exceeds the undo budget. Earlier undo steps were cleared.", "Dieser Vorgang überschreitet das Rückgängig-Budget. Frühere Schritte wurden verworfen."));
  }
  function historyAction(action) {
    if (!current() || busy || gesture) return;
    try { if (history[action](context)) { selection = null; selectionOverlay(null); dirtyChanged(); targetWidth.value = String(canvas.width); targetHeight.value = String(canvas.height); controls(); tell(note, ""); } }
    catch (error) { tell(note, error.message, "error"); }
  }
  function rgba() {
    const value = /^#[0-9a-f]{6}$/iu.test(color.value) ? color.value : "#222222";
    return [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16), 255];
  }
  async function fill(at) {
    busy = true; controls(); let pixels;
    try {
      pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      if (await floodPaintPixels(pixels, at.x, at.y, rgba(), { signal })) {
        abortEditor(signal); if (!current()) return;
        const record = history.begin(context, null, { width: canvas.width, height: canvas.height });
        context.putImageData(pixels, 0, 0); changed(record);
      }
    } catch (error) { if (current() && error.name !== "AbortError") tell(note, error.message, "error"); }
    finally { pixels?.data.fill(0); busy = false; pending = null; if (current()) controls(); }
  }
  function transform(action) {
    if (!current() || busy || gesture || action === "crop" && !selection) return;
    let temporary, record, mutated = false;
    const oldWidth = canvas.width, oldHeight = canvas.height;
    try {
      const nextWidth = action === "crop" ? selection.width : action === "resize" ? Number(targetWidth.value) : action === "rotate" ? oldHeight : oldWidth;
      const nextHeight = action === "crop" ? selection.height : action === "resize" ? Number(targetHeight.value) : action === "rotate" ? oldWidth : oldHeight;
      imageCrop(nextWidth, nextHeight);
      temporary = document.createElement("canvas"); temporary.width = oldWidth; temporary.height = oldHeight;
      const copy = temporary.getContext("2d"); if (!copy) throw new Error(t("The image could not be opened.", "Das Bild konnte nicht geöffnet werden."));
      copy.drawImage(canvas, 0, 0); record = history.begin(context, null, { width: nextWidth, height: nextHeight });
      canvas.width = nextWidth; canvas.height = nextHeight; mutated = true;
      context.save();
      if (action === "rotate") { context.translate(nextWidth, 0); context.rotate(Math.PI / 2); }
      if (action === "flipX") { context.translate(nextWidth, 0); context.scale(-1, 1); }
      if (action === "flipY") { context.translate(0, nextHeight); context.scale(1, -1); }
      if (action === "crop") context.drawImage(temporary, selection.x, selection.y, selection.width, selection.height, 0, 0, nextWidth, nextHeight);
      else if (action === "resize") context.drawImage(temporary, 0, 0, nextWidth, nextHeight);
      else context.drawImage(temporary, 0, 0);
      context.restore(); changed(record); record = null;
    } catch (error) {
      if (mutated && temporary) { try { canvas.width = oldWidth; canvas.height = oldHeight; context.drawImage(temporary, 0, 0); } catch {} }
      if (record) history.cancel(record); tell(note, error.message, "error");
    }
    finally { if (temporary) temporary.width = temporary.height = 1; }
  }
  function point(event) {
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null;
    return { x: clamp((event.clientX - box.left) * canvas.width / box.width, 0, canvas.width - 1),
      y: clamp((event.clientY - box.top) * canvas.height / box.height, 0, canvas.height - 1) };
  }
  function captureLine(record, a, b, radius) {
    history.capture(record, context, { x: Math.min(a.x, b.x) - radius, y: Math.min(a.y, b.y) - radius,
      width: Math.abs(b.x - a.x) + radius * 2 + 1, height: Math.abs(b.y - a.y) + radius * 2 + 1 });
  }
  function line(a, b, chosen, size) {
    context.save(); context.globalCompositeOperation = chosen === "eraser" ? "destination-out" : "source-over";
    context.strokeStyle = color.value; context.fillStyle = color.value; context.lineWidth = size; context.lineCap = "round"; context.lineJoin = "round";
    if (a.x === b.x && a.y === b.y) { context.beginPath(); context.arc(a.x, a.y, size / 2, 0, Math.PI * 2); context.fill(); }
    else { context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke(); }
    context.restore();
  }
  function finish() {
    const active = gesture; if (!active) return; gesture = null;
    try {
      if (["brush", "pencil", "eraser"].includes(active.tool)) changed(active.record);
      else if (active.tool === "select") { selection = paintSelectionRect(active.start, active.last, canvas.width, canvas.height); selectionOverlay(selection); }
      else {
        const rect = paintSelectionRect(active.start, active.last, canvas.width, canvas.height), padding = active.size + 2;
        const record = history.begin(context, { x: rect.x - padding, y: rect.y - padding, width: rect.width + padding * 2, height: rect.height + padding * 2 });
        context.save(); context.strokeStyle = color.value; context.lineWidth = active.size;
        if (active.tool === "line") { context.beginPath(); context.moveTo(active.start.x, active.start.y); context.lineTo(active.last.x, active.last.y); context.stroke(); }
        else if (active.tool === "rectangle") context.strokeRect(rect.x, rect.y, rect.width, rect.height);
        else { context.beginPath(); context.ellipse(rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width / 2, rect.height / 2, 0, 0, Math.PI * 2); context.stroke(); }
        context.restore(); changed(record);
      }
    } catch (error) { if (active.record) history.cancel(active.record); tell(note, error.message, "error"); }
    finally { controls(); }
  }
  canvas.addEventListener("pointerdown", event => {
    if (!current() || busy || gesture || event.button !== 0) return;
    const at = point(event); if (!at) return;
    event.preventDefault(); canvas.focus({ preventScroll: true });
    if (tool.value === "fill") { pending = fill(at); return; }
    if (tool.value === "picker") {
      const sample = context.getImageData(Math.floor(at.x), Math.floor(at.y), 1, 1);
      try { color.value = "#" + [...sample.data.slice(0, 3)].map(value => value.toString(16).padStart(2, "0")).join(""); }
      finally { sample.data.fill(0); } return;
    }
    if (tool.value === "text") {
      const value = text.value.slice(0, VAULT_PAINT_LIMITS.textCharacters); if (!value) return;
      const size = clamp(Number(fontSize.value) || 24, 6, 256); context.font = size + "px sans-serif";
      const record = history.begin(context, { x: at.x - size, y: at.y - size, width: context.measureText(value).width + size * 2, height: size * 3 });
      context.fillStyle = color.value; context.textBaseline = "top"; context.fillText(value, at.x, at.y); changed(record); return;
    }
    const size = strokeWidth(tool.value), record = history.begin(context);
    gesture = { start: at, last: at, tool: tool.value, size, record, pointerId: event.pointerId };
    if (["brush", "pencil", "eraser"].includes(tool.value)) { captureLine(record, at, at, size + 2); line(at, at, tool.value, size); }
    try { canvas.setPointerCapture(event.pointerId); } catch {}
    controls();
  });
  canvas.addEventListener("pointermove", event => {
    if (!current() || !gesture || event.pointerId !== gesture.pointerId) return;
    const at = point(event); if (!at) return;
    if (["brush", "pencil", "eraser"].includes(gesture.tool)) { captureLine(gesture.record, gesture.last, at, gesture.size + 2); line(gesture.last, at, gesture.tool, gesture.size); }
    else selectionOverlay(paintSelectionRect(gesture.start, at, canvas.width, canvas.height), gesture.tool);
    gesture.last = at;
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) canvas.addEventListener(name, event => {
    if (gesture && event.pointerId === gesture.pointerId) finish();
  });
  tool.addEventListener("change", () => { textOptions.hidden = tool.value !== "text"; });
  zoomChoice.addEventListener("change", () => { zoom = clamp(Number(zoomChoice.value) || 1, .1, 4); controls(); selectionOverlay(selection); });
  format.addEventListener("change", () => {
    if (!["image/png", "image/jpeg", "image/webp"].includes(format.value)) format.value = "image/png";
    filename.value = filename.value.replace(/\.[^.]+$/u, "") + "." + (format.value === "image/jpeg" ? "jpg" : format.value.split("/")[1]); dirtyChanged();
  });
  host.addEventListener("keydown", event => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
    if ((event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key.toLowerCase())) {
      event.preventDefault(); historyAction(event.key.toLowerCase() === "y" || event.shiftKey ? "redo" : "undo");
    }
    if (event.key === "Escape") { finish(); selection = null; selectionOverlay(null); controls(); }
  });
  function cleanup() {
    if (!alive) return; alive = false; signal.removeEventListener("abort", cleanup); local.abort();
    if (gesture) history.cancel(gesture.record); gesture = null; selection = null; history.clear();
    text.value = ""; canvas.width = canvas.height = 1; host.replaceChildren();
  }
  disposers.push(cleanup); signal?.addEventListener("abort", cleanup, { once: true });
  if (signal?.aborted) { cleanup(); abortEditor(signal); }
  stage.append(host); controls(); paintPalette();
  return async ({ signal: exportSignal } = {}) => {
    if (pending) await pending;
    const lifetime = exportSignal && signal ? AbortSignal.any([signal, exportSignal]) : exportSignal ?? signal;
    abortEditor(lifetime); if (!alive) throw new DOMException("Cancelled", "AbortError");
    finish(); busy = true; controls(); let background;
    try {
      let source = canvas;
      if (format.value === "image/jpeg") {
        background = document.createElement("canvas"); background.width = canvas.width; background.height = canvas.height;
        const drawing = background.getContext("2d"); drawing.fillStyle = "#ffffff"; drawing.fillRect(0, 0, canvas.width, canvas.height); drawing.drawImage(canvas, 0, 0); source = background;
      }
      const output = await canvasBlob(source, format.value); abortEditor(lifetime);
      if (!alive) throw new DOMException("Cancelled", "AbortError");
      if (output.type !== format.value || output.size > VAULT_EDITOR_LIMITS.inputBytes) throw new Error(t("The image could not be exported safely.", "Das Bild konnte nicht sicher exportiert werden."));
      return output;
    } finally { if (background) background.width = background.height = 1; busy = false; if (current()) controls(); }
  };
}
