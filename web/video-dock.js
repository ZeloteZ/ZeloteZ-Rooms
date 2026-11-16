import { t } from "./i18n.js";
import { button, el } from "./ui.js";

export function createVideoDock({ signal, onSelect }, dock) {
  const label = el("span");
  const summary = el("summary", { class: "button" }, label);
  const returnLink = el("a", { class: "button" }, t("Back to the live room", "Zurück zum Live-Raum"));
  const close = button("×", () => stop(), { class: "icon-button", "aria-label": t("Close player", "Player schließen") });
  const stage = el("div", { class: "video-dock-stage" });
  const popover = el("div", { class: "stream-popover video-dock-popover" },
    el("div", { class: "inline video-dock-actions" }, returnLink, close), stage);
  const details = el("details", { class: "stream-dock", name: "header-media" }, summary, popover);
  dock.replaceChildren(details);
  let active;

  function move(entry, target) {
    const node = entry.instance.player;
    if (node.parentNode === target) return;
    const wasConnected = node.isConnected;
    if (wasConnected && target.isConnected && target.moveBefore) {
      target.moveBefore(node, null);
    } else {
      target.append(node);
      if (wasConnected && target.isConnected) entry.instance.reconnectAfterMove?.();
    }
  }

  function refreshPlacement() {
    if (!active) {
      dock.hidden = true;
      details.open = false;
      return;
    }
    const { slot } = active.view ?? {};
    const inline = Boolean(slot?.isConnected && slot.getClientRects().length);
    const wasInline = active.instance.player.dataset.videoMode === "inline";
    dock.hidden = inline;
    if (inline && active.instance.player.parentNode !== slot) {
      move(active, slot);
      details.open = false;
    } else if (!inline) {
      if (wasInline) details.open = matchMedia("(min-width: 741px) and (min-height: 520px)").matches;
      move(active, stage);
    }
    active.instance.player.dataset.videoMode = inline ? "inline" : "mini";
    returnLink.hidden = inline;
    label.textContent = active.title;
    summary.title = active.title;
    returnLink.href = active.href;
  }

  function stop() {
    active?.instance.stopPlayback();
  }

  function get(key, create) {
    if (active?.key === key) return active;
    const lifetime = new AbortController();
    const entry = {
      key,
      signal: AbortSignal.any([signal, lifetime.signal]),
      view: undefined,
      instance: undefined,
      mount(slot, viewSignal, detach) {
        const view = { slot };
        entry.view = view;
        if (active !== entry) move(entry, slot);
        viewSignal.addEventListener("abort", () => {
          if (entry.view !== view) return;
          entry.view = undefined;
          detach?.();
          if (active === entry) {
            if (document.fullscreenElement === entry.instance.player) void document.exitFullscreen().catch(() => {});
            refreshPlacement();
          } else lifetime.abort();
        }, { once: true });
      },
      activate(title, href) {
        if (entry.signal.aborted) return;
        const previous = active;
        active = entry;
        entry.title = title;
        entry.href = href;
        if (previous !== entry) {
          previous?.instance.stopPlayback();
          if (!previous?.view) previous?.dispose();
          onSelect();
        }
        refreshPlacement();
      },
      deactivate() {
        if (active !== entry) return;
        active = undefined;
        refreshPlacement();
        if (!entry.view) entry.dispose();
      },
      dispose() {
        lifetime.abort();
        entry.instance.player.remove();
      },
    };
    entry.instance = create(entry);
    return entry;
  }

  details.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !details.open || document.fullscreenElement) return;
    event.stopPropagation();
    details.open = false;
    summary.focus({ preventScroll: true });
  }, { signal });
  signal.addEventListener("abort", () => {
    active?.dispose();
    active = undefined;
    dock.hidden = true;
    dock.replaceChildren();
  }, { once: true });
  return { get, stop, refreshPlacement };
}
