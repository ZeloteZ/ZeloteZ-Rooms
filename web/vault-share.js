import { language, languages, locale, setLanguage, t } from "./i18n.js";
import { button, el, status, tell } from "./ui.js";
import { takePublicVaultLink, openPublicVault } from "./vault-client.js";
import { clearVaultKeys, destroySecret } from "./vault-crypto.js";

export function createPublicVaultSession({ takeLink = takePublicVaultLink, openLink = openPublicVault,
  onState = () => {}, clearKeys = clearVaultKeys, destroyKey = destroySecret } = {}) {
  let current = null;
  let disposed = false;
  let version = 0;
  const active = view => !disposed && view === current && !view.controller.signal.aborted;
  const notify = view => { if (active(view)) onState(view); };
  function release(view) {
    if (!view) return;
    view.controller.abort(); view.activeDownload?.abort();
    view.file?.close(); view.file = null;
  }
  async function load() {
    if (disposed) return;
    // Consume the new fragment before closing old state, painting, or requesting
    // data. replaceState itself does not emit another hashchange event.
    let link;
    try { link = takeLink(); } catch { link = null; }
    release(current); clearKeys();
    const view = { version: ++version, controller: new AbortController(), file: null,
      opening: !!link, error: link ? null : "invalid", downloading: false, activeDownload: null, progress: null, downloadNote: null };
    current = view; notify(view);
    if (!link) return;
    try {
      const file = await openLink(link, { signal: view.controller.signal });
      if (!active(view)) {
        // This result never owned a download. Avoid its document-wide close()
        // cleanup, which could otherwise revoke a newer view's download URL.
        if (file.opened?.secret) destroyKey(file.opened.secret);
        return;
      }
      view.file = file; view.opening = false; notify(view);
    } catch {
      if (active(view)) { view.opening = false; view.error = "unavailable"; notify(view); }
    } finally { link = null; }
  }
  async function download() {
    const view = current;
    if (!view || !active(view) || !view.file || view.downloading) return;
    const file = view.file;
    const transfer = new AbortController();
    const ongoing = () => active(view) && view.activeDownload === transfer;
    view.activeDownload = transfer; view.downloading = true; view.progress = { done: 0, total: 1 }; view.downloadNote = "working";
    notify(view);
    try {
      // No await precedes the picker: the initiating click's user activation is
      // preserved for browsers and the optional native desktop save bridge.
      const prepared = file.prepareDownload();
      await file.download({ signal: AbortSignal.any([view.controller.signal, transfer.signal]), prepared,
        onProgress: ({ done, total }) => { if (ongoing()) { view.progress = { done, total }; notify(view); } } });
      if (ongoing()) view.downloadNote = "complete";
    } catch (error) {
      if (ongoing()) view.downloadNote = error.name === "AbortError" ? "cancelled" : { error: error.message };
    } finally {
      if (ongoing()) { view.downloading = false; view.activeDownload = null; notify(view); }
    }
  }
  return {
    load, download,
    cancelDownload() { if (current && active(current)) current.activeDownload?.abort(); },
    repaint() { if (current) notify(current); },
    getState: () => current,
    dispose() {
      if (disposed) return;
      disposed = true; release(current); current = null; clearKeys(); onState(null);
    },
  };
}

function bytes(value) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = value > 0 ? Math.min(4, Math.floor(Math.log(value) / Math.log(1024))) : 0;
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }).format(value / 1024 ** index) + " " + units[index];
}

function mountPublicVault() {
  const host = document.querySelector("#vault-public");
  const chooser = document.querySelector("#vault-language");
  if (!host || !chooser) return;
  let session;
  function paint(view) {
    document.documentElement.lang = language();
    document.querySelector("#vault-language-label").textContent = t("Language", "Sprache");
    chooser.value = language(); chooser.disabled = view?.downloading === true;
    const heading = el("h1", {}, t("An encrypted file was shared with you", "Eine verschlüsselte Datei wurde mit dir geteilt"));
    const note = status();
    const content = el("section", { class: "panel vault-public-card" },
      el("span", { class: "vault-public-icon", "aria-hidden": "true" }, "◇"), heading,
      el("p", { class: "muted" }, t("ZeloteZ Vault decrypts this file on your device. You do not need a Rooms account.",
        "ZeloteZ Vault entschlüsselt diese Datei auf deinem Gerät. Du benötigst kein Rooms-Konto.")), note);
    if (view?.file) {
      const file = view.file, opened = file.opened;
      const name = el("h2", { class: "vault-public-name" }, opened.name);
      const details = el("p", { class: "subtle" }, bytes(opened.descriptor.size), " · ",
        t("Access expires {date}", "Zugriff läuft ab: {date}", { date: new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(file.share.expiresAt)) }));
      const progress = el("progress", { max: view.progress?.total ?? 1, value: view.progress?.done ?? 0,
        hidden: !view.progress, "aria-label": t("Download progress", "Download-Fortschritt") });
      const cancel = button(t("Cancel", "Abbrechen"), () => session.cancelDownload(), { class: "ghost", hidden: !view.downloading });
      const save = button(t("Decrypt and download", "Entschlüsseln und herunterladen"), () => { void session.download(); },
        { class: "primary", disabled: view.downloading });
      const state = view.downloadNote;
      if (state === "working") tell(note, t("Verifying and decrypting the file…", "Die Datei wird geprüft und entschlüsselt …"));
      else if (state === "complete") tell(note, t("Download completed", "Download abgeschlossen"));
      else if (state === "cancelled") tell(note, t("Download cancelled", "Download abgebrochen"));
      else if (state?.error) tell(note, state.error, "error");
      content.append(name, details, el("div", { class: "inline" }, save, cancel), progress,
        el("p", { class: "subtle" }, t("Only download files from people you trust. The download is never opened automatically.",
          "Lade nur Dateien von Personen herunter, denen du vertraust. Der Download wird niemals automatisch geöffnet.")));
    } else if (view?.opening) tell(note, t("Opening encrypted file…", "Die verschlüsselte Datei wird geöffnet …"));
    else if (view?.error === "unavailable") tell(note, t("This file could not be opened. The link may be incomplete, expired, revoked, or the file may be damaged.",
      "Diese Datei konnte nicht geöffnet werden. Der Link könnte unvollständig, abgelaufen oder widerrufen sein, oder die Datei ist beschädigt."), "error");
    else tell(note, t("Open the complete sharing link again. It may be incomplete, expired, or revoked.",
      "Öffne den vollständigen Freigabelink erneut. Er könnte unvollständig, abgelaufen oder widerrufen sein."), "error");
    host.replaceChildren(content);
  }
  session = createPublicVaultSession({ onState: paint });
  chooser.replaceChildren(...languages.map(item => el("option", { value: item.id }, item.label)));
  chooser.addEventListener("change", () => {
    if (!session.getState()?.downloading) { setLanguage(chooser.value); session.repaint(); }
  });
  const onHashChange = () => {
    // Several queued hashchange events can follow rapid link replacement. Once
    // the newest fragment is consumed, an older queued event must not reset it.
    if (location.hash) void session.load();
  };
  window.addEventListener("hashchange", onHashChange);
  window.addEventListener("pagehide", () => {
    window.removeEventListener("hashchange", onHashChange); session.dispose();
  }, { once: true });
  void session.load();
}
mountPublicVault();
