import { t } from "./i18n.js";
import { button, closeDialog, el, field, notify, select, showDialog, status, tell } from "./ui.js";
import { VAULT_EDITOR_LIMITS, abortEditor, canvasBlob, editedFileName, editorEvent, createVaultPlayback, formatMediaTime, imageCrop, mediaDuration, vaultFileKind } from "./vault-media-edit.js";
import { decodeVaultImage } from "./vault-image-inspect.js";
import { decodeVaultText, encodeVaultText } from "./vault-text-codec.js";
import { officeEditor } from "./vault-office-editor.js";
import { VAULT_OFFICE_LIMITS } from "./vault-office.js";
import { archiveViewer, archiveError } from "./vault-archive-viewer.js";
import { VAULT_ARCHIVE_LIMITS } from "./vault-archive.js";
import { downloadVaultLocalBlob } from "./vault-client.js";
import { mountVaultMediaLanguages } from "./vault-language-controls.js";

export { vaultFileKind, editedFileName } from "./vault-media-edit.js";

function checkedNumber(input) { return Number(input.value); }
function numberControl(value, min, max, step = 1) { return el("input", { type: "number", value, min, max, step, inputmode: "decimal" }); }

export function mountVaultEditor(options = {}) {
  return createVaultEditorSession(options, { inline: true });
}

// Modal callers use the same lifetime and resource ownership as the embedded preview.
export async function openVaultEditor(options = {}) {
  const dialog = document.querySelector("#dialog");
  const close = document.querySelector("#dialog-close");
  if (!dialog || !options.entry || options.signal?.aborted) return;
  let observer;
  const mounted = createVaultEditorSession({ ...options, onClose() {
    observer?.disconnect();
    close?.removeEventListener("click", askClose, true);
    dialog.removeEventListener("cancel", askClose);
    dialog.removeEventListener("close", dispose);
    const active = dialog.querySelector(".vault-editor");
    if (!active || active === mounted.node) dialog.classList.remove("vault-editor-dialog", "vault-player-dialog");
    if (dialog.contains(mounted.node)) closeDialog();
    options.onClose?.();
  } }, { inline: false });
  function askClose(event) {
    event.preventDefault(); event.stopImmediatePropagation();
    mounted.requestClose();
  }
  function dispose() { mounted.dispose(); }
  dialog.classList.add("vault-editor-dialog");
  dialog.classList.toggle("vault-player-dialog", ["video", "audio"].includes(vaultFileKind(options.entry)));
  dialog.addEventListener("close", dispose);
  dialog.addEventListener("cancel", askClose);
  close?.addEventListener("click", askClose, true);
  showDialog(options.entry.name || t("Encrypted file", "Verschlüsselte Datei"), mounted.node);
  observer = typeof MutationObserver === "function" ? new MutationObserver(() => {
    if (!dialog.contains(mounted.node)) mounted.dispose();
  }) : null;
  observer?.observe(document.querySelector("#dialog-content"), { childList: true });
  await mounted.ready;
  return mounted;
}

function createVaultEditorSession({ entry, client, signal, onSaved, onShare, onClose, externalHeader = false, confirmDiscard } = {}, { inline, depth = 0, back = false } = {}) {
  if (!entry || !client) throw new TypeError("A Vault file and client are required.");
  const scope = new AbortController();
  const lifetime = signal ? AbortSignal.any([signal, scope.signal]) : scope.signal;
  const urls = new Set();
  const disposers = [];
  let dirty = false, saving = false, builder = null, alive = true, child = null, closeCheck = null;
  const kind = vaultFileKind(entry);
  const playbackOnly = kind === "video" || kind === "audio";
  const archiveOnly = kind === "archive";
  const filename = el("input", { type: "text", value: playbackOnly ? entry.name : editedFileName(entry.name, kind === "image" ? "png" : undefined),
    maxlength: 255, autocomplete: "off", spellcheck: false, disabled: true, "aria-label": t("Copy name", "Name der Kopie") });
  const feedback = status(t("Decrypting on this device…", "Wird auf diesem Gerät entschlüsselt …"));
  const progress = el("progress", { max: 1, value: 0, "aria-label": t("File progress", "Dateifortschritt") });
  const stage = el("div", { class: "vault-editor-stage", "aria-busy": true });
  const tools = el("aside", { class: "vault-editor-tools", hidden: playbackOnly, "aria-label": t("Editing tools", "Bearbeitungswerkzeuge") });
  const save = button(t("Save encrypted copy", "Verschlüsselte Kopie speichern"), saveCopy, { class: "primary", disabled: true });
  const shell = el("section", { class: "vault-editor" + (playbackOnly ? " vault-editor-player" : archiveOnly ? " vault-editor-browser" : ""), "data-editor-kind": kind },
    !playbackOnly && el("div", { class: "vault-editor-intro" },
      el("span", { class: "vault-editor-kind" }, ({ image: t("Image", "Bild"), video: t("Video", "Video"), audio: t("Audio", "Audio"),
        pdf: "PDF", text: t("Text", "Text"), office: "Office", archive: t("Archive", "Archiv"), other: t("File", "Datei") })[kind]),
      el("p", {}, archiveOnly ? t("Open files locally or save an extracted file to Vault. The original archive stays unchanged.",
        "Öffne Dateien lokal oder speichere entpackte Dateien in Vault. Das Originalarchiv bleibt unverändert.")
        : kind === "office" ? t("Edit text and tables locally. Copies omit complex layout and images; formulas stay text.",
          "Bearbeite Text und Tabellen lokal. Kopien übernehmen kein komplexes Layout und keine Bilder; Formeln bleiben Text.")
          : t("Edit locally. Save an encrypted copy; the original and its shares stay unchanged.",
            "Bearbeite lokal und speichere eine verschlüsselte Kopie. Original und Freigaben bleiben erhalten."))),
    el("div", { class: "vault-editor-workspace" }, stage, tools),
    !playbackOnly && !archiveOnly && el("footer", { class: "vault-editor-footer" }, field(t("Copy name", "Name der Kopie"), filename), save),
    el("div", { class: "vault-editor-feedback", "aria-live": "polite" }, progress, feedback));
  const dismiss = button(back ? t("Back to archive", "Zurück zum Archiv") : "×", () => { void requestClose(); }, {
    class: "vault-editor-dismiss", title: back ? t("Back to archive", "Zurück zum Archiv") : t("Close preview", "Vorschau schließen"),
    "aria-label": back ? t("Back to archive", "Zurück zum Archiv") : t("Close preview", "Vorschau schließen"),
  });
  const heading = el("header", { class: "vault-editor-heading", hidden: inline && depth === 0 && externalHeader },
    el("strong", { title: entry.name || "" }, entry.name || t("Encrypted file", "Verschlüsselte Datei")), dismiss);
  const node = inline ? el("section", { class: "vault-editor-inline", "aria-label": t("File preview", "Dateivorschau") }, heading, shell) : shell;
  const mounted = { node, ready: null, requestClose, close: requestClose, dispose: cleanup,
    get dirty() { return alive && (dirty || !!child?.dirty); }, get saving() { return alive && (saving || !!child?.saving); },
    get closed() { return !alive; } };
  const update = value => {
    if (!alive) return;
    const done = Number(value?.done ?? value?.loaded ?? 0), total = Math.max(1, Number(value?.total ?? 1));
    progress.max = total; progress.value = Math.min(total, done);
    tell(feedback, t("{percent}% complete", "{percent}% abgeschlossen", { percent: Math.round(done / total * 100) }));
  };
  function downloadControl() {
    const control = button(t("Download", "Herunterladen"), async () => {
      control.disabled = true;
      try {
        const prepared = client.prepareDownload?.(entry, { signal: lifetime });
        await client.download(entry, { signal: lifetime, prepared, onProgress: update });
        if (alive) tell(feedback, t("Completed", "Abgeschlossen"));
      } catch (error) { if (alive && error?.name !== "AbortError") tell(feedback, error.message, "error"); }
      finally { if (alive) control.disabled = false; }
    }, { class: "primary" });
    return control;
  }
  function dirtyChanged() { dirty = true; }
  function releasePreview() {
    for (const dispose of disposers) { try { dispose(); } catch {} }
    disposers.length = 0;
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  }
  function cleanup() {
    if (!alive) return;
    alive = false; scope.abort();
    child?.dispose(); child = null;
    releasePreview();
    signal?.removeEventListener("abort", cleanup);
    stage.replaceChildren(); tools.replaceChildren(); filename.value = "";
    builder = null; dirty = false; saving = false;
    node.replaceChildren();
    try { onClose?.(); } catch {}
  }
  // Keep the native confirmation path synchronous for existing modal callers.
  function afterDecision(decision, next) {
    if (decision && typeof decision.then === "function") return Promise.resolve(decision).then(next, () => false);
    return next(decision);
  }
  function canClose() {
    if (!alive) return true;
    if (closeCheck) return closeCheck;
    const activeChild = child;
    let decision;
    try {
      decision = afterDecision(activeChild ? activeChild.canClose() : true, allowed => {
        if (!allowed || !alive || lifetime.aborted || child !== activeChild) return false;
        if (!dirty) return true;
        const answer = typeof confirmDiscard === "function" ? confirmDiscard()
          : globalThis.confirm(t("Discard unsaved changes?", "Ungespeicherte Änderungen verwerfen?"));
        return afterDecision(answer, accepted => accepted === true && alive && !lifetime.aborted && child === activeChild);
      });
    } catch { return false; }
    if (!decision || typeof decision.then !== "function") return decision;
    const pending = new Promise(resolve => {
      let settled = false;
      const complete = value => {
        if (settled) return;
        settled = true; lifetime.removeEventListener("abort", cancelled); resolve(value);
      };
      const cancelled = () => complete(false);
      lifetime.addEventListener("abort", cancelled, { once: true });
      Promise.resolve(decision).then(complete, () => complete(false));
      if (lifetime.aborted) cancelled();
    }).finally(() => { if (closeCheck === pending) closeCheck = null; });
    closeCheck = pending;
    return pending;
  }
  function requestClose() {
    if (!alive) return true;
    return afterDecision(canClose(), allowed => {
      if (!allowed || !alive || lifetime.aborted) return false;
      cleanup(); return true;
    });
  }
  // Nested archives keep their parent preview in the same pane and inherit its lifetime.
  async function previewChild(options) {
    if (!alive) return;
    const previous = child;
    if (previous && !await previous.requestClose()) return;
    if (!alive || (child && child !== previous)) return;
    if (depth >= 4) throw new Error(t("Close a nested archive before opening another one.", "Schließe ein verschachteltes Archiv, bevor du ein weiteres öffnest."));
    const next = createVaultEditorSession({ ...options, signal: lifetime, confirmDiscard, onClose() {
      if (child !== next) return;
      child = null;
      if (alive) node.replaceChildren(heading, shell);
    } }, { inline: true, depth: depth + 1, back: true });
    child = next; node.replaceChildren(next.node);
    return next.ready;
  }
  mounted.canClose = canClose;
  function objectUrl(blob) { const url = URL.createObjectURL(blob); urls.add(url); return url; }
  async function saveCopy() {
    if (!builder || saving || !alive) return;
    const name = filename.value.trim();
    if (!name || new TextEncoder().encode(name).byteLength > 255 || /[\p{Cc}\u202a-\u202e\u2066-\u2069/\\]/u.test(name) || [".", ".."].includes(name)) {
      tell(feedback, t("Use a name of up to 255 bytes without slashes or control characters.", "Verwende einen Namen mit höchstens 255 Bytes ohne Schrägstriche oder Steuerzeichen."), "error");
      return;
    }
    saving = true; save.disabled = true; shell.setAttribute("aria-busy", "true");
    const controls = [...shell.querySelectorAll("input,textarea,select,button")].map(control => [control, control.disabled]);
    for (const [control] of controls) control.disabled = true;
    try {
      abortEditor(lifetime);
      tell(feedback, t("Preparing your edited copy…", "Deine bearbeitete Kopie wird vorbereitet …"));
      const blob = await builder({ signal: lifetime, onProgress: update });
      abortEditor(lifetime);
      if (!(blob instanceof Blob) || blob.size > VAULT_EDITOR_LIMITS.inputBytes) throw new Error(t(
        "The exported file exceeds the local editor’s size limit.", "Die exportierte Datei überschreitet die Größenbegrenzung des lokalen Editors."));
      const saved = await client.saveEditedCopy(entry, blob, { name, signal: lifetime, onProgress: update });
      abortEditor(lifetime);
      dirty = false;
      await onSaved?.(saved);
      if (alive) {
        tell(feedback, t("Encrypted copy saved.", "Verschlüsselte Kopie gespeichert."));
        if (!inline) cleanup();
        notify(t("Encrypted copy saved.", "Verschlüsselte Kopie gespeichert."));
      }
    } catch (error) {
      if (alive && error?.name !== "AbortError") tell(feedback, error.message, "error");
    } finally {
      if (alive) { saving = false; for (const [control, disabled] of controls) control.disabled = disabled; save.disabled = !builder; shell.removeAttribute("aria-busy"); }
    }
  }
  signal?.addEventListener("abort", cleanup, { once: true });
  filename.addEventListener("input", dirtyChanged);
  mounted.ready = Promise.resolve().then(initialize);
  if (signal?.aborted) cleanup();
  return mounted;

  async function initialize() {
    try {
      abortEditor(lifetime);
      if (kind === "other") {
        stage.append(el("div", { class: "vault-editor-unavailable" }, el("strong", {}, t("No local editor for this file type", "Kein lokaler Editor für diesen Dateityp")),
          el("p", {}, t("Download this file to open it in a suitable app.", "Lade diese Datei herunter, um sie in einer passenden App zu öffnen.")), downloadControl()));
        tools.hidden = true; const footer = shell.querySelector(".vault-editor-footer"); if (footer) footer.hidden = true;
        tell(feedback, ""); progress.hidden = true; return;
      }
      const maximum = kind === "text" ? VAULT_EDITOR_LIMITS.textBytes : kind === "pdf" ? VAULT_EDITOR_LIMITS.pdfBytes
        : kind === "office" ? VAULT_OFFICE_LIMITS.inputBytes : archiveOnly ? VAULT_ARCHIVE_LIMITS.inputBytes : VAULT_EDITOR_LIMITS.inputBytes;
      const mediaInput = kind === "image" || playbackOnly;
      const blob = await (mediaInput && client.readMediaBlob ? client.readMediaBlob : client.readBlob)(entry,
        { signal: lifetime, maxBytes: mediaInput ? VAULT_EDITOR_LIMITS.mediaBytes : maximum, onProgress: update });
      abortEditor(lifetime);
      const environment = { signal: lifetime, stage, tools, filename, objectUrl, disposers, dirtyChanged, update, onShare: entry.receivedShareId ? undefined : onShare };
      if (kind === "image") builder = await imageEditor(blob, environment);
      else if (kind === "text") builder = await textEditor(blob, entry, environment);
      else if (kind === "pdf") builder = await pdfEditor(blob, environment);
      else if (kind === "office") builder = await officeEditor(blob, entry, environment);
      else if (archiveOnly) builder = await archiveViewer(blob, entry, { ...environment,
        onDownloadOriginal: async () => {
          try { const prepared = client.prepareDownload?.(entry); await client.download(entry, { signal: lifetime, prepared, onProgress: update }); }
          catch (error) { if (alive && error?.name !== "AbortError") tell(feedback, error.message, "error"); }
        },
        onDownload: ({ entry: member, blob: file }) => downloadVaultLocalBlob(file, member.name),
        onExtract: async ({ entry: member, blob: file }) => {
          const parentId = entry.receivedShareId ? null : entry.parentId ?? null;
          const saved = await client.upload(new File([file], member.name, { type: file.type || "application/octet-stream" }), parentId, { signal: lifetime, onProgress: update });
          await onSaved?.(saved);
          if (alive) notify(t("Extracted file saved with new encryption.", "Entpackte Datei neu verschlüsselt gespeichert."));
        },
        onPreview: async ({ entry: member, blob: file }) => {
          const parentId = entry.receivedShareId ? null : entry.parentId ?? null;
          const nested = { id: crypto.randomUUID(), name: member.name, type: file.type, kind: "file", parentId, descriptor: { size: file.size } };
          const nestedClient = {
            readBlob: async (_entry, options = {}) => {
              abortEditor(options.signal);
              if (file.size > options.maxBytes) throw new Error(t("This file exceeds the preview limit.", "Diese Datei überschreitet die Vorschaugrenze."));
              return file;
            },
            download: async () => downloadVaultLocalBlob(file, member.name),
            upload: (next, destination, options) => client.upload(next, destination, options),
            saveEditedCopy: (_entry, next, options) => client.upload(new File([next], options.name, { type: next.type || file.type }), parentId, options),
          };
          if (inline) await previewChild({ entry: nested, client: nestedClient, onSaved });
          else await openVaultEditor({ entry: nested, client: nestedClient, signal, onSaved, confirmDiscard });
        },
      });
      else { await mediaPlayer(blob, kind, environment); builder = null; }
      abortEditor(lifetime);
      save.disabled = !builder; progress.hidden = true;
      tell(feedback, builder ? t("Ready · changes stay on this device until you save.", "Bereit · Änderungen bleiben bis zum Speichern auf diesem Gerät.") : "");
    } catch (error) {
      if (alive && error?.name !== "AbortError") {
        releasePreview();
        tell(feedback, error?.code?.startsWith("VAULT_ARCHIVE_") ? archiveError(error) : error.message, "error"); progress.hidden = true;
        stage.replaceChildren(el("div", { class: "vault-editor-unavailable" }, el("p", {}, t("Download this file to open it in a suitable app.", "Lade diese Datei herunter, um sie in einer passenden App zu öffnen.")), downloadControl()));
        tools.hidden = true; const footer = shell.querySelector(".vault-editor-footer"); if (footer) footer.hidden = true;
      }
    } finally {
      if (alive) { stage.removeAttribute("aria-busy"); filename.disabled = !builder; }
      else {
        // A browser decoder may finish after the caller has disposed the pane.
        releasePreview(); stage.replaceChildren(); tools.replaceChildren(); builder = null;
      }
    }
  }
}

async function textEditor(blob, entry, { signal, stage, tools, disposers, dirtyChanged }) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let decoded;
  try {
    abortEditor(signal);
    decoded = decodeVaultText(bytes);
  } catch (error) { if (error?.name === "AbortError") throw error; throw new Error(error.code === "VAULT_TEXT_BINARY" ? t("This file contains binary data and cannot be edited as text.", "Diese Datei enthält Binärdaten und kann nicht als Text bearbeitet werden.")
    : t("This file is not supported UTF-8 or UTF-16 text.", "Diese Datei enthält keinen unterstützten UTF-8- oder UTF-16-Text.")); }
  finally { bytes.fill(0); }
  const input = el("textarea", { class: "vault-text-editor", spellcheck: false, autocapitalize: "off", autocomplete: "off",
    "aria-label": t("File text", "Dateitext"), maxlength: VAULT_EDITOR_LIMITS.textBytes });
  input.value = decoded.value; decoded.value = "";
  disposers.push(() => { input.value = ""; });
  const wrap = el("input", { type: "checkbox", checked: true });
  const counter = el("p", { class: "subtle vault-editor-counter" });
  function count() { counter.textContent = t("{lines} lines · {characters} characters", "{lines} Zeilen · {characters} Zeichen",
    { lines: input.value.split("\n").length, characters: input.value.length }); }
  input.addEventListener("input", () => { dirtyChanged(); count(); });
  wrap.addEventListener("change", () => { input.wrap = wrap.checked ? "soft" : "off"; });
  tools.append(el("h3", {}, t("Text tools", "Textwerkzeuge")), field(t("Wrap lines", "Zeilen umbrechen"), wrap), counter,
    el("p", { class: "subtle" }, decoded.encoding.toUpperCase()),
    el("p", { class: "subtle" }, t("HTML, SVG and code stay plain text and are never executed here.", "HTML, SVG und Code bleiben reiner Text und werden hier niemals ausgeführt.")));
  stage.append(input); count();
  return async () => {
    const output = input.value;
    if (/\.json$/iu.test(entry.name ?? "")) {
      try { JSON.parse(output); } catch { throw new Error(t("Fix the JSON syntax before saving.", "Korrigiere vor dem Speichern die JSON-Syntax.")); }
    }
    let encoded;
    try { encoded = encodeVaultText(output, decoded); }
    catch { throw new Error(t("Text editing supports files up to 2 MiB with valid Unicode.", "Textbearbeitung unterstützt gültigen Unicode-Text bis 2 MiB.")); }
    try { return new Blob([encoded], { type: blob.type || "text/plain;charset=" + decoded.encoding }); }
    finally { encoded.fill(0); }
  };
}

async function imageEditor(blob, { signal, stage, tools, filename, disposers, dirtyChanged }) {
  const image = await decodeVaultImage(blob, { signal });
  if (signal?.aborted) { image.close(); abortEditor(signal); }
  disposers.push(() => image.close());
  abortEditor(signal);
  imageCrop(image.width, image.height);
  const canvas = el("canvas", { class: "vault-image-canvas", "aria-label": t("Edited image preview", "Vorschau des bearbeiteten Bildes") });
  const rotation = select([["0", "0°"], ["90", "90°"], ["180", "180°"], ["270", "270°"]], "0");
  const flipX = el("input", { type: "checkbox" }), flipY = el("input", { type: "checkbox" });
  const format = select([["image/png", "PNG"], ["image/jpeg", "JPEG"], ["image/webp", "WebP"]], "image/png");
  const crops = Object.fromEntries(["left", "top", "right", "bottom"].map(key => [key, numberControl(0, 0, 95)]));
  const cropFeedback = status();
  function draw() {
    const crop = imageCrop(image.width, image.height, Object.fromEntries(Object.entries(crops).map(([key, input]) => [key, checkedNumber(input)])));
    const turn = checkedNumber(rotation);
    canvas.width = turn % 180 ? crop.height : crop.width; canvas.height = turn % 180 ? crop.width : crop.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(t("The image could not be exported.", "Das Bild konnte nicht exportiert werden."));
    if (format.value === "image/jpeg") { context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); }
    context.translate(canvas.width / 2, canvas.height / 2); context.rotate(turn * Math.PI / 180);
    context.scale(flipX.checked ? -1 : 1, flipY.checked ? -1 : 1);
    context.drawImage(image, crop.x, crop.y, crop.width, crop.height, -crop.width / 2, -crop.height / 2, crop.width, crop.height);
    tell(cropFeedback, "");
  }
  for (const input of [rotation, flipX, flipY, format, ...Object.values(crops)]) input.addEventListener("change", () => {
    dirtyChanged();
    if (input === format) filename.value = filename.value.replace(/\.[^.]+$/u, "") + "." + (format.value === "image/jpeg" ? "jpg" : format.value.split("/")[1]);
    try { draw(); } catch (error) { tell(cropFeedback, error.message, "error"); }
  });
  tools.append(el("h3", {}, t("Image tools", "Bildwerkzeuge")), field(t("Rotation", "Drehung"), rotation),
    el("div", { class: "vault-editor-pair" }, field(t("Flip horizontally", "Horizontal spiegeln"), flipX), field(t("Flip vertically", "Vertikal spiegeln"), flipY)),
    el("h4", {}, t("Crop edges (%)", "Ränder zuschneiden (%)")), el("div", { class: "vault-editor-pair" },
      field(t("Left", "Links"), crops.left), field(t("Right", "Rechts"), crops.right), field(t("Top", "Oben"), crops.top), field(t("Bottom", "Unten"), crops.bottom)),
    cropFeedback, field(t("Output format", "Ausgabeformat"), format),
    el("p", { class: "subtle" }, t("Export creates a static image and removes the source file’s metadata.", "Der Export erstellt ein statisches Bild und entfernt die Metadaten der Quelldatei.")));
  stage.append(canvas); draw();
  disposers.push(() => { canvas.width = 1; canvas.height = 1; });
  return async () => {
    abortEditor(signal); draw();
    const output = await canvasBlob(canvas, format.value);
    abortEditor(signal);
    if (output.type !== format.value) throw new Error(t("The image could not be exported.", "Das Bild konnte nicht exportiert werden."));
    return output;
  };
}

function playerIcon(kind) {
  const paths = {
    play: ["M8 5v14l11-7z"], pause: ["M7 5h3v14H7z", "M14 5h3v14h-3z"],
    sound: ["M4 9h4l5-4v14l-5-4H4z", "M16 8a6 6 0 0 1 0 8", "M19 5a10 10 0 0 1 0 14"],
    mute: ["M4 9h4l5-4v14l-5-4H4z", "m17 9 5 6", "m22 9-5 6"],
    fullscreen: ["M8 3H3v5", "M16 3h5v5", "M21 16v5h-5", "M8 21H3v-5"],
    pip: ["M3 5h18v14H3z", "M12 11h7v6h-7z"], music: ["M9 18V5l11-2v13", "M9 9l11-2", "M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3z", "M20 16a3 3 0 1 1-3-3 3 3 0 0 1 3 3z"],
    room: ["M3 4h18v13H3z", "M8 21h8", "M12 17v4", "m10 8 5 3-5 3z"],
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
  for (const shape of paths[kind] ?? paths.play) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", shape); svg.append(path);
  }
  return svg;
}

async function mediaPlayer(blob, kind, { signal, stage, tools, objectUrl, disposers, onShare }) {
  tools.hidden = true;
  const media = el(kind, { preload: "auto", playsinline: true, class: "vault-media-preview" });
  media.disableRemotePlayback = true;
  disposers.push(() => { media.pause(); media.removeAttribute("src"); media.load(); });
  const ready = editorEvent(media, "loadedmetadata", { signal }); media.src = objectUrl(blob); await ready;
  abortEditor(signal);
  if (media.readyState < 2) await editorEvent(media, "loadeddata", { signal });
  abortEditor(signal);
  if (kind === "video" && (!media.videoWidth || !media.videoHeight)) throw new Error(t(
    "This device cannot decode the video picture. Download the original to use another player.",
    "Dieses Gerät kann das Videobild nicht dekodieren. Lade das Original für einen anderen Player herunter."));
  try { await mediaDuration(media, { signal }); }
  catch (error) { if (signal.aborted) throw error; try { media.currentTime = 0; } catch {} }
  abortEditor(signal);
  let playback, languages;
  const player = el("section", { class: "vault-player vault-player-" + kind, "data-playing": "false", "aria-label": t("Private media player", "Privater Medienplayer") });
  const visual = el("div", { class: "vault-player-visual", tabindex: 0, "aria-label": kind === "video" ? t("Video playback", "Videowiedergabe") : t("Audio playback", "Audiowiedergabe") }, media);
  if (kind === "audio") visual.append(el("div", { class: "vault-audio-art", "aria-hidden": true }, playerIcon("music"),
    el("div", { class: "vault-audio-bars" }, ...Array.from({ length: 9 }, () => el("span")))));
  const play = button("", () => { void playback?.toggle(); }, { class: "vault-player-play", "aria-label": t("Play", "Abspielen"), title: t("Play", "Abspielen") });
  play.append(playerIcon("play"));
  const seek = el("input", { type: "range", min: 0, max: 1000, step: 1, value: 0, class: "vault-player-seek", "aria-label": t("Playback position", "Wiedergabeposition") });
  const counter = el("span", { class: "vault-player-time", "aria-live": "off" });
  const mute = button("", () => playback?.mute(), { class: "vault-player-mute", "aria-label": t("Mute", "Stummschalten"), title: t("Mute", "Stummschalten") });
  mute.append(playerIcon("sound"));
  const volume = el("input", { type: "range", min: 0, max: 1, step: .05, value: 1, class: "vault-player-volume", "aria-label": t("Volume", "Lautstärke") });
  const speed = select([["0.5", "0.5×"], ["0.75", "0.75×"], ["1", "1×"], ["1.25", "1.25×"], ["1.5", "1.5×"], ["2", "2×"]], "1");
  speed.classList.add("vault-player-speed"); speed.setAttribute("aria-label", t("Playback speed", "Wiedergabegeschwindigkeit"));
  const playerStatus = status();
  const actions = el("div", { class: "vault-player-actions" }, play, counter, el("span", { class: "vault-player-spacer" }), mute, volume, speed);
  const controls = el("div", { class: "vault-player-controls" }, seek, actions);
  player.append(visual, controls, playerStatus);
  playback = createVaultPlayback(media, { signal, onState(value) {
    if (signal.aborted) return;
    const playing = !value.paused && !value.ended;
    player.dataset.playing = String(playing);
    play.replaceChildren(playerIcon(playing ? "pause" : "play"));
    const label = playing ? t("Pause", "Pausieren") : t("Play", "Abspielen");
    play.setAttribute("aria-label", label); play.title = label;
    seek.disabled = languages?.switching || !value.duration;
    play.disabled = languages?.switching === true;
    seek.value = String(value.duration ? Math.max(0, Math.min(1000, value.currentTime / value.duration * 1000)) : 0);
    seek.setAttribute("aria-valuetext", formatMediaTime(value.currentTime) + " / " + formatMediaTime(value.duration));
    counter.textContent = formatMediaTime(value.currentTime) + " / " + formatMediaTime(value.duration);
    const silent = value.muted || value.volume === 0;
    mute.replaceChildren(playerIcon(silent ? "mute" : "sound"));
    mute.setAttribute("aria-label", silent ? t("Unmute", "Ton einschalten") : t("Mute", "Stummschalten"));
    mute.title = mute.getAttribute("aria-label"); volume.value = String(value.muted ? 0 : value.volume); speed.value = String(value.rate);
  }, onError(error) { if (!signal.aborted) tell(playerStatus, error.message, "error"); } });
  disposers.push(() => playback.dispose());
  languages = mountVaultMediaLanguages(media, blob, { signal, onError(error) {
    if (!signal.aborted) tell(playerStatus, error.message, "error");
  }, onChange(value) {
    for (const control of [play, seek, volume, speed, mute]) control.disabled = value.switching;
    if (!value.switching) seek.disabled = !Number.isFinite(media.duration);
  } });
  controls.append(languages.element);
  disposers.push(() => languages.dispose());
  seek.addEventListener("input", () => { if (Number.isFinite(media.duration)) playback.seek(media.duration * checkedNumber(seek) / 1000); });
  volume.addEventListener("input", () => playback.volume(checkedNumber(volume)));
  speed.addEventListener("change", () => playback.rate(checkedNumber(speed)));
  if (kind === "audio") visual.addEventListener("click", () => { void playback.toggle(); });
  else media.addEventListener("click", () => { void playback.toggle(); });
  visual.addEventListener("keydown", event => {
    if (event.altKey || event.ctrlKey || event.metaKey || (event.target !== visual && event.target !== media)) return;
    if ([" ", "Enter", "k"].includes(event.key)) { event.preventDefault(); void playback.toggle(); }
    else if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); playback.seek(media.currentTime + (event.key === "ArrowLeft" ? -5 : 5)); }
    else if (event.key.toLowerCase() === "m") { event.preventDefault(); playback.mute(); }
  });
  if (typeof player.requestFullscreen === "function" && document.fullscreenEnabled) {
    const fullscreen = button("", async () => {
      try {
        if (document.fullscreenElement === player) await document.exitFullscreen();
        else await player.requestFullscreen();
      } catch (error) { if (!signal.aborted) tell(playerStatus, error.message, "error"); }
    }, { class: "vault-player-fullscreen", "aria-label": t("Fullscreen", "Vollbild"), title: t("Fullscreen", "Vollbild") });
    fullscreen.append(playerIcon("fullscreen")); actions.append(fullscreen);
  }
  if (kind === "video" && document.pictureInPictureEnabled && typeof media.requestPictureInPicture === "function") {
    const pip = button("", async () => {
      try {
        if (document.pictureInPictureElement === media) await document.exitPictureInPicture();
        else await media.requestPictureInPicture();
      } catch (error) { if (!signal.aborted) tell(playerStatus, error.message, "error"); }
    }, { class: "vault-player-pip", "aria-label": t("Picture in picture", "Bild im Bild"), title: t("Picture in picture", "Bild im Bild") });
    pip.append(playerIcon("pip")); actions.append(pip);
  }
  if (typeof onShare === "function") {
    const share = button("", async () => {
      try { await onShare(); } catch (error) { if (!signal.aborted && error?.name !== "AbortError") tell(playerStatus, error.message, "error"); }
    }, { class: "vault-player-room", "aria-label": t("Play in a room", "In einem Raum abspielen"), title: t("Play in a room", "In einem Raum abspielen") });
    share.append(playerIcon("room")); actions.append(share);
  }
  disposers.push(() => {
    if (document.pictureInPictureElement === media) void document.exitPictureInPicture().catch(() => {});
    if (document.fullscreenElement === player) void document.exitFullscreen().catch(() => {});
  });
  stage.append(player);
}

async function pdfEditor(blob, { signal, stage, tools, objectUrl, disposers, dirtyChanged }) {
  const signature = new TextDecoder().decode(await blob.slice(0, 5).arrayBuffer());
  if (signature !== "%PDF-") throw new Error(t("This file is not a supported PDF document.", "Diese Datei ist kein unterstütztes PDF-Dokument."));
  const pdfjs = await import("/vendor/pdfjs-6.5.438/pdf.mjs");
  abortEditor(signal);
  pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs-6.5.438/pdf.worker.mjs";
  const loading = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false, enableXfa: false,
    disableFontFace: true, useSystemFonts: true, useWasm: false, isOffscreenCanvasSupported: false, maxImageSize: 16 * 1024 ** 2,
    cMapUrl: "/vendor/pdfjs-6.5.438/cmaps/", cMapPacked: true, standardFontDataUrl: "/vendor/pdfjs-6.5.438/standard_fonts/", useWorkerFetch: true });
  disposers.push(() => { void loading.destroy().catch(() => {}); });
  const pdf = await boundedPdfTask(loading.promise, signal, 30000, error => { if (error) void loading.destroy().catch(() => {}); });
  abortEditor(signal);
  if (pdf.numPages > VAULT_EDITOR_LIMITS.pdfPages) throw new Error(t("The PDF editor supports documents with up to 500 pages.", "Der PDF-Editor unterstützt Dokumente mit bis zu 500 Seiten."));
  const pages = Array.from({ length: pdf.numPages }, (_, original) => ({ original, rotation: 0, note: { text: "", x: 10, y: 10, size: 16 } }));
  let current = 0, renderTask, serial = 0;
  const canvas = el("canvas", { class: "vault-pdf-canvas", "aria-label": t("PDF page preview", "Vorschau der PDF-Seite") });
  const choice = select([], ""); choice.setAttribute("aria-label", t("Page", "Seite"));
  const note = el("textarea", { rows: 3, maxlength: 2000, spellcheck: false, autocomplete: "off", autocapitalize: "off", placeholder: t("Add a text note to this page", "Textnotiz auf dieser Seite ergänzen"),
    "aria-label": t("Page note", "Seitennotiz") });
  const x = numberControl(10, 0, 95), y = numberControl(10, 0, 95), size = numberControl(16, 8, 72);
  const feedback = status();
  const remove = button(t("Delete page", "Seite löschen"), () => {
    if (pages.length <= 1) return;
    pages.splice(current, 1); current = Math.min(current, pages.length - 1); changed();
  }, { class: "danger" });
  const earlier = button("←", () => move(-1), { "aria-label": t("Move page earlier", "Seite nach vorne verschieben"), title: t("Move page earlier", "Seite nach vorne verschieben") });
  const later = button("→", () => move(1), { "aria-label": t("Move page later", "Seite nach hinten verschieben"), title: t("Move page later", "Seite nach hinten verschieben") });
  function move(delta) {
    const target = current + delta;
    if (target < 0 || target >= pages.length) return;
    [pages[current], pages[target]] = [pages[target], pages[current]]; current = target; changed();
  }
  function changed() { dirtyChanged(); paintControls(); void render(); }
  function paintControls() {
    choice.replaceChildren(...pages.map((page, index) => el("option", { value: index }, t("Page {number}", "Seite {number}", { number: index + 1 }))));
    choice.value = String(current);
    const value = pages[current].note;
    note.value = value.text; x.value = value.x; y.value = value.y; size.value = value.size;
    earlier.disabled = current === 0; later.disabled = current === pages.length - 1; remove.disabled = pages.length === 1;
  }
  async function render() {
    const generation = ++serial;
    renderTask?.cancel();
    try {
      const selected = pages[current];
      const page = await pdf.getPage(selected.original + 1);
      if (signal.aborted || serial !== generation) return;
      const base = page.getViewport({ scale: 1, rotation: (page.rotate + selected.rotation) % 360 });
      const scale = Math.min(2, 1800 / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale, rotation: (page.rotate + selected.rotation) % 360 });
      if (!Number.isFinite(viewport.width * viewport.height) || viewport.width * viewport.height > 16 * 1024 ** 2 || Math.min(viewport.width, viewport.height) < 1) throw new Error(t("This PDF page exceeds the local preview limit.", "Diese PDF-Seite überschreitet die lokale Vorschaugrenze."));
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d", { alpha: false });
      renderTask = page.render({ canvasContext: context, viewport, annotationMode: 0 });
      await boundedPdfTask(renderTask.promise, signal, 30000, error => { if (error) renderTask?.cancel(); });
      if (signal.aborted || serial !== generation) return;
      paintNote(context, selected.note, canvas.width, canvas.height, base.width);
      tell(feedback, "");
    } catch (error) { if (!signal.aborted && serial === generation && error.name !== "RenderingCancelledException") tell(feedback, error.message, "error"); }
  }
  choice.addEventListener("change", () => { current = checkedNumber(choice); paintControls(); void render(); });
  for (const control of [note, x, y, size]) control.addEventListener("input", () => {
    pages[current].note = { text: note.value, x: Math.max(0, Math.min(95, checkedNumber(x) || 0)), y: Math.max(0, Math.min(95, checkedNumber(y) || 0)), size: Math.max(8, Math.min(72, checkedNumber(size) || 16)) };
    dirtyChanged(); void render();
  });
  tools.append(el("h3", {}, t("PDF tools", "PDF-Werkzeuge")), field(t("Page", "Seite"), choice),
    el("div", { class: "vault-editor-pair" }, earlier, later), button(t("Rotate page", "Seite drehen"), () => { pages[current].rotation = (pages[current].rotation + 90) % 360; changed(); }), remove,
    field(t("Page note", "Seitennotiz"), note), el("div", { class: "vault-editor-pair" }, field(t("From left (%)", "Von links (%)"), x), field(t("From top (%)", "Von oben (%)"), y)),
    field(t("Text size", "Textgröße"), size), feedback,
    el("p", { class: "subtle" }, t("Page previews are passive. The saved copy removes interactive links, forms, attachments and embedded scripts.", "Die Seitenvorschau ist passiv. Die gespeicherte Kopie entfernt interaktive Links, Formulare, Anhänge und eingebettete Skripte.")));
  stage.append(canvas); paintControls(); await render();
  disposers.push(() => { renderTask?.cancel(); canvas.width = 1; canvas.height = 1; pages.length = 0; });
  return async () => {
    abortEditor(signal);
    const notes = []; let noteBytes = 0;
    for (const settings of pages) {
      abortEditor(signal);
      if (!settings.note.text.trim()) { notes.push(null); continue; }
      const page = await pdf.getPage(settings.original + 1);
      abortEditor(signal);
      const base = page.getViewport({ scale: 1, rotation: (page.rotate + settings.rotation) % 360 });
      const scale = Math.min(2, 1800 / Math.max(base.width, base.height));
      const overlay = documentForCanvas();
      overlay.width = Math.ceil(base.width * scale); overlay.height = Math.ceil(base.height * scale);
      paintNote(overlay.getContext("2d"), settings.note, overlay.width, overlay.height, base.width);
      const png = await canvasBlob(overlay);
      abortEditor(signal);
      noteBytes += png.size;
      if (noteBytes > 64 * 1024 ** 2) throw new Error(t("PDF notes exceed the local editor’s memory limit.", "Die PDF-Notizen überschreiten die Speichergrenze des lokalen Editors."));
      notes.push(await png.arrayBuffer());
      abortEditor(signal);
      overlay.width = 1; overlay.height = 1;
    }
    abortEditor(signal);
    const source = await blob.arrayBuffer();
    abortEditor(signal);
    const worker = new Worker(new URL("./vault-pdf-worker.js", import.meta.url), { type: "module" });
    const operation = new Promise((resolve, reject) => {
      worker.onmessage = event => {
        const { bytes, error } = event.data ?? {};
        if (error || !(bytes instanceof ArrayBuffer) || bytes.byteLength > VAULT_EDITOR_LIMITS.inputBytes) reject(new Error(t("The PDF could not be exported safely.", "Das PDF konnte nicht sicher exportiert werden.")));
        else resolve(new Blob([bytes], { type: "application/pdf" }));
      };
      worker.onerror = () => reject(new Error(t("The PDF could not be exported safely.", "Das PDF konnte nicht sicher exportiert werden.")));
      worker.postMessage({ source, pages: pages.map(value => ({ original: value.original, rotation: value.rotation })), notes }, [source, ...notes.filter(Boolean)]);
    });
    return boundedPdfTask(operation, signal, 60000, () => worker.terminate());
  };
}

function documentForCanvas() { return document.createElement("canvas"); }
function paintNote(context, note, width, height, pageWidth) {
  if (!context || !note.text) return;
  context.save();
  const font = Math.max(1, note.size * width / pageWidth);
  context.font = `${font}px system-ui, sans-serif`; context.fillStyle = "#17213b"; context.textBaseline = "top";
  const x = width * note.x / 100, y = height * note.y / 100;
  const lines = note.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "").split(/\r?\n/u);
  for (let index = 0; index < lines.length && y + index * font * 1.25 < height; index++) context.fillText(lines[index], x, y + index * font * 1.25, Math.max(1, width - x));
  context.restore();
}

function boundedPdfTask(operation, signal, milliseconds, finish) {
  return new Promise((resolve, reject) => {
    let done = false;
    const complete = (error, result) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener("abort", cancelled); finish?.(error);
      if (error) reject(error); else resolve(result);
    };
    const cancelled = () => complete(new DOMException("Cancelled", "AbortError"));
    const timer = setTimeout(() => complete(new Error(t("The PDF operation timed out. Try a smaller document.", "Der PDF-Vorgang hat zu lange gedauert. Versuche ein kleineres Dokument."))), milliseconds);
    signal?.addEventListener("abort", cancelled, { once: true });
    Promise.resolve(operation).then(value => complete(null, value), error => complete(error));
    if (signal?.aborted) cancelled();
  });
}
