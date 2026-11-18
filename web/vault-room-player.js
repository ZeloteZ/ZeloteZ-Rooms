import { t } from "./i18n.js";
import { openVaultWatch } from "./vault-watch.js";
import { editorEvent, mediaDuration } from "./vault-media-edit.js";

export function createVaultRoomPlayer(party, channelId, handlers, ownerDocument, signal) {
  const scope = new AbortController();
  const lifetime = AbortSignal.any([scope.signal, ...(signal ? [signal] : [])]);
  const element = ownerDocument.createElement("div");
  element.className = "vault-room-media";
  const note = ownerDocument.createElement("p");
  note.className = "subtle";
  note.setAttribute("role", "status");
  note.textContent = t("Decrypting Vault media on this device…", "Vault-Medium wird auf diesem Gerät entschlüsselt …");
  element.append(note);
  let media, url, source, name = "", duration = 0, volume = 1, muted = false, stopped = false;
  const visible = () => {
    const bounds = element.getBoundingClientRect();
    const view = element.ownerDocument.defaultView;
    handlers.onVisibility?.(!ownerDocument.hidden && !stopped && Boolean(media) && element.isConnected
      && bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.right > 0
      && bounds.top < view.innerHeight && bounds.left < view.innerWidth
      && view.getComputedStyle(element).visibility !== "hidden");
  };
  const Observer = ownerDocument.defaultView.IntersectionObserver;
  const visibility = Observer ? new Observer(visible) : null;
  visibility?.observe(element);
  ownerDocument.addEventListener("visibilitychange", visible);
  function destroy() {
    if (stopped) return;
    stopped = true;
    scope.abort();
    visibility?.disconnect();
    ownerDocument.removeEventListener("visibilitychange", visible);
    source?.close(); source = null;
    if (media) { media.pause(); media.removeAttribute("src"); media.load(); }
    if (url) URL.revokeObjectURL(url);
    url = null; name = ""; media = null;
    element.replaceChildren();
  }
  lifetime.addEventListener("abort", destroy, { once: true });
  if (lifetime.aborted) destroy();
  void (async () => {
    try {
      source = await openVaultWatch({ party, channelId, signal: lifetime, onProgress({ done, total }) {
        if (!stopped) note.textContent = t("Decrypting Vault media · {percent}%", "Vault-Medium entschlüsseln · {percent}%",
          { percent: Math.min(100, Math.round(done / Math.max(1, total) * 100)) });
      } });
      if (lifetime.aborted) { source.close(); source = null; return; }
      name = source.name;
      const audio = source.type.startsWith("audio/");
      media = ownerDocument.createElement(audio ? "audio" : "video");
      media.className = "vault-room-file";
      media.setAttribute("aria-label", name);
      media.preload = "auto"; media.playsInline = true;
      media.volume = volume; media.muted = muted;
      const ready = editorEvent(media, "loadedmetadata", { signal: lifetime });
      url = URL.createObjectURL(source.blob);
      media.src = url;
      source.close(); source = null;
      if (audio) {
        element.classList.add("vault-room-audio");
        const cover = ownerDocument.createElement("div");
        cover.className = "vault-room-audio-cover"; cover.setAttribute("aria-hidden", "true"); cover.textContent = "♫";
        const title = ownerDocument.createElement("strong"); title.textContent = name;
        element.replaceChildren(cover, title, media);
      } else element.replaceChildren(media);
      await ready;
      if (lifetime.aborted) return;
      duration = await mediaDuration(media, { signal: lifetime });
      if (lifetime.aborted) return;
      media.addEventListener("ended", () => { if (!stopped) handlers.onEnded?.(); });
      media.addEventListener("error", () => { if (!stopped) handlers.onError?.(); });
      handlers.onReady?.(); visible();
    } catch (error) {
      if (lifetime.aborted) return;
      source?.close(); source = null;
      if (media) { media.pause(); media.removeAttribute("src"); media.load(); media = null; }
      if (url) { URL.revokeObjectURL(url); url = null; }
      element.replaceChildren(note);
      note.className = "error";
      note.textContent = error.message || t("The Vault media could not be opened.", "Das Vault-Medium konnte nicht geöffnet werden.");
      handlers.onVisibility?.(false);
      handlers.onError?.(error);
    }
  })();
  return {
    element, vaultId: party.id, privateTitle: () => name,
    play: () => media?.play().catch(error => { if (!stopped && error.name === "NotAllowedError") handlers.onBlocked?.(); }),
    pause: () => media?.pause(),
    seek(seconds) { if (media && Number.isFinite(seconds)) media.currentTime = Math.max(0, Math.min(seconds, duration || seconds)); },
    setVolume(value, nextMuted) { volume = value; muted = nextMuted; if (media) { media.volume = value; media.muted = nextMuted; } },
    getTime: () => media?.currentTime ?? 0, getDuration: () => duration, destroy,
  };
}
