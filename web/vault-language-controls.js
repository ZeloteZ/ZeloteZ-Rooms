import { locale, t } from "./i18n.js";
import { attachMediaTracks } from "./vault-media-tracks.js";

const clean = value => String(value ?? "").replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, "").trim().slice(0, 180);

export function vaultMediaLanguageLabel(track, index, subtitles = false) {
  const code = clean(track.language).replaceAll("_", "-");
  let language = "";
  if (code && !["und", "unk", "zxx"].includes(code.toLowerCase())) {
    try { language = new Intl.DisplayNames([locale()], { type: "language" }).of(code) || code; }
    catch { language = code; }
  }
  const title = clean(track.label);
  const fallback = subtitles ? t("Subtitle track {number}", "Untertitelspur {number}", { number: index + 1 })
    : t("Audio track {number}", "Audiospur {number}", { number: index + 1 });
  let label = language && title && language.toLowerCase() !== title.toLowerCase() ? language + " · " + title : title || language || fallback;
  if (track.default) label += " · " + t("default", "Standard");
  if (subtitles && track.supported === false) label += " · " + t("unavailable", "nicht verfügbar");
  return label;
}

export function mountVaultMediaLanguages(media, blob, { signal, ownerDocument = media.ownerDocument, onError, onChange } = {}) {
  const scope = new AbortController(), lifetime = signal ? AbortSignal.any([signal, scope.signal]) : scope.signal;
  const element = ownerDocument.createElement("div");
  element.className = "vault-media-languages"; element.hidden = true;
  element.setAttribute("role", "group"); element.setAttribute("aria-label", t("Playback languages", "Wiedergabesprachen"));
  let controller = null, disposed = false, pending = null, fallback = "", reported = new WeakSet();
  function field(name) {
    const node = ownerDocument.createElement("label"), title = ownerDocument.createElement("span"), select = ownerDocument.createElement("select");
    node.className = "vault-media-language-field"; title.textContent = name;
    select.setAttribute("aria-label", name); node.append(title, select); return { node, select };
  }
  const audio = field(t("Audio", "Audio")), subtitles = field(t("Subtitles", "Untertitel"));
  const note = ownerDocument.createElement("p"); note.className = "subtle vault-media-languages-note"; note.setAttribute("role", "status"); note.hidden = true;
  element.append(audio.node, subtitles.node, note);
  const switching = () => !disposed && (pending === "audio" || controller?.switching === true);
  function changed() {
    if (disposed) return;
    const busy = pending !== null || controller?.switching === true;
    audio.select.disabled = busy; subtitles.select.disabled = busy;
    audio.select.value = controller?.audioId ?? "original"; subtitles.select.value = controller?.subtitleId ?? "off";
    try { onChange?.({ switching: switching(), audioId: audio.select.value, subtitleId: subtitles.select.value }); } catch {}
  }
  function report(error) {
    if (disposed || lifetime.aborted || error?.name === "AbortError") return;
    if (error && typeof error === "object") { if (reported.has(error)) return; reported.add(error); }
    note.textContent = error?.message || t("This track could not be selected on this device.", "Diese Spur konnte auf diesem Gerät nicht ausgewählt werden."); note.hidden = false;
    try { onError?.(error); } catch {}
  }
  function option(select, value, label, disabled = false) {
    const item = ownerDocument.createElement("option"); item.value = value; item.textContent = label; item.disabled = disabled; select.append(item);
  }
  async function select(kind) {
    if (disposed || lifetime.aborted || pending !== null || !controller || controller.switching) return;
    const id = (kind === "audio" ? audio : subtitles).select.value;
    reported = new WeakSet(); note.textContent = fallback; note.hidden = !fallback;
    pending = kind; changed();
    try { await controller[kind === "audio" ? "selectAudio" : "selectSubtitle"](id); if (!disposed) { note.textContent = fallback; note.hidden = !fallback; } }
    catch (error) { report(error); }
    finally { pending = null; changed(); }
  }
  const audioChanged = () => { void select("audio"); }, subtitlesChanged = () => { void select("subtitles"); };
  audio.select.addEventListener("change", audioChanged); subtitles.select.addEventListener("change", subtitlesChanged);
  function dispose() {
    if (disposed) return;
    disposed = true; lifetime.removeEventListener("abort", dispose); scope.abort(); controller?.dispose(); controller = null;
    audio.select.removeEventListener("change", audioChanged); subtitles.select.removeEventListener("change", subtitlesChanged);
    element.hidden = true; element.replaceChildren(); note.textContent = ""; pending = null;
  }
  lifetime.addEventListener("abort", dispose, { once: true });
  const ready = (async () => {
    try {
      if (lifetime.aborted) { dispose(); return false; }
      const attached = await attachMediaTracks(media, blob, { signal: lifetime, onChange: changed, onError: report });
      if (disposed || lifetime.aborted) { attached.dispose(); return false; }
      controller = attached;
      option(audio.select, "original", t("Original audio (default)", "Originalton (Standard)"));
      controller.audio.forEach((track, index) => option(audio.select, track.id, vaultMediaLanguageLabel(track, index)));
      option(subtitles.select, "off", t("Off", "Aus"));
      controller.subtitles.forEach((track, index) => option(subtitles.select, track.id, vaultMediaLanguageLabel(track, index, true), track.supported === false));
      audio.node.hidden = controller.audio.length < 2; subtitles.node.hidden = controller.subtitles.length === 0;
      if (controller.subtitles.some(track => track.supported === false)) {
        fallback = t("Some subtitle formats cannot be displayed as local text captions. Download the file for another player.",
          "Einige Untertitelformate können nicht als lokale Textuntertitel angezeigt werden. Lade die Datei für einen anderen Player herunter.");
        note.textContent = fallback; note.hidden = false;
      }
      element.hidden = audio.node.hidden && subtitles.node.hidden; changed(); return !element.hidden;
    } catch (error) {
      // Track inspection is optional. Unavailable containers keep ordinary
      // device playback without showing an unusable language control.
      if (!disposed && !lifetime.aborted) { element.hidden = true; changed(); }
      return false;
    }
  })();
  return { element, ready, dispose, get switching() { return switching(); } };
}
