import { t } from "./i18n.js";
import { button, el } from "./ui.js";
import { mountFloatingVideo, openVideoWindow } from "./floating-video.js";

export function createVideoDock({ signal, onSelect }, dock) {
  const controls = dock.parentElement;
  const miniPlayer = t("Mini player", "Miniplayer");
  const title = el("span", { class: "video-dock-title" });
  const summary = el("summary", { class: "button video-dock-toggle" },
    el("i", { class: "video-dock-icon", "aria-hidden": "true" }),
    el("span", { class: "video-dock-label" }, miniPlayer), title);
  const returnLink = el("a", { class: "button" }, t("Back to the live room", "Zurück zum Live-Raum"));
  const close = button("×", () => stop(), { class: "icon-button", "aria-label": t("Close player", "Player schließen") });
  const caption = el("h2", { class: "video-dock-caption" });
  const detachLabel = t("Open in a separate window", "In eigenem Fenster öffnen");
  const attachLabel = t("Return player to the page", "Player zurück auf die Seite");
  const moveLabel = t("Arrow keys move the player. Shift and arrow keys resize it.",
    "Mit den Pfeiltasten verschiebst du den Player. Mit Umschalt und Pfeiltasten änderst du die Größe.");
  const detach = button("↗", () => void changeWindow(), { class: "icon-button", title: detachLabel, "aria-label": detachLabel });
  const hint = el("span", { id: "video-dock-move-hint", class: "sr-only" }, moveLabel);
  const heading = el("div", { class: "video-dock-heading" }, caption,
    el("div", { class: "inline video-dock-actions" }, returnLink, detach, close), hint);
  const stage = el("div", { class: "video-dock-stage" });
  const feedback = el("p", { class: "status error video-dock-status", role: "status", hidden: true });
  const panel = el("section", { class: "video-dock-panel", "aria-label": miniPlayer, "data-floating": "" }, heading, stage, feedback);
  const details = el("details", { class: "stream-dock", name: "header-media" }, summary, panel);
  dock.replaceChildren(details);
  const floating = mountFloatingVideo(panel, heading, caption, document.querySelector("#content"), signal);
  let active;
  let external;
  let opening = false;

  function updateReturnLink() {
    const roomLink = controls?.querySelector("#quick-room-dock:not([hidden]) a[href]");
    returnLink.hidden = dock.hidden || (!external && roomLink?.href === returnLink.href);
  }

  controls?.addEventListener("rooms:quick-return-changed", updateReturnLink, { signal });

  function move(entry, target) {
    const node = entry.instance.player;
    if (node.parentNode === target) return;
    const wasConnected = node.isConnected;
    if (wasConnected && target.isConnected && node.ownerDocument === target.ownerDocument && target.moveBefore) {
      target.moveBefore(node, null);
    } else {
      target.append(node);
      if (wasConnected && target.isConnected) entry.instance.reconnectAfterMove?.();
    }
  }

  function inlineSlot(entry) {
    const slot = entry?.view?.slot;
    return slot?.isConnected && slot.getClientRects().length ? slot : null;
  }

  function updateWindowControls() {
    const label = external ? attachLabel : detachLabel;
    detach.title = label;
    detach.setAttribute("aria-label", label);
    detach.textContent = external ? "↙" : "↗";
    detach.disabled = opening;
    caption.tabIndex = external ? -1 : 0;
    if (external) caption.removeAttribute("aria-describedby");
    else caption.setAttribute("aria-describedby", hint.id);
  }

  function attachToPage(reopen, closeWindow = true) {
    if (!external) return;
    const popup = external;
    external = undefined;
    const slot = inlineSlot(active);
    if (slot) move(active, slot);
    details.append(panel);
    panel.setAttribute("data-floating", "");
    if (active && !slot && active.instance.player.parentNode === stage) active.instance.reconnectAfterMove?.();
    details.open = Boolean(reopen && active && !slot);
    if (closeWindow && !popup.closed) popup.close();
    updateWindowControls();
    floating.place();
  }

  async function changeWindow() {
    if (external) {
      attachToPage(true);
      refreshPlacement();
      return;
    }
    if (!active || opening || inlineSlot(active)) return;
    const entry = active;
    opening = true;
    feedback.hidden = true;
    updateWindowControls();
    try {
      const popup = await openVideoWindow(panel.getBoundingClientRect());
      if (signal.aborted || active !== entry || !details.open || inlineSlot(entry)) {
        popup.close();
        return;
      }
      external = popup;
      popup.addEventListener("pagehide", () => {
        if (external !== popup || signal.aborted) return;
        attachToPage(true, false);
        refreshPlacement();
      }, { once: true });
      popup.document.title = entry.title || miniPlayer;
      panel.removeAttribute("data-floating");
      for (const name of ["left", "top", "width", "height"]) panel.style.removeProperty(name);
      popup.document.body.append(panel);
      details.open = false;
      entry.instance.reconnectAfterMove?.();
      refreshPlacement();
      popup.focus();
    } catch {
      if (external) attachToPage(true);
      if (active === entry && !signal.aborted) {
        feedback.textContent = t("The separate player window could not open.",
          "Das separate Playerfenster konnte nicht geöffnet werden.");
        feedback.hidden = false;
      }
    } finally {
      opening = false;
      updateWindowControls();
    }
  }

  function refreshPlacement() {
    if (!active) {
      attachToPage(false);
      dock.hidden = true;
      details.open = false;
      return;
    }
    if (external?.closed) attachToPage(true, false);
    const slot = inlineSlot(active);
    const wasInline = active.instance.player.dataset.videoMode === "inline";
    dock.hidden = Boolean(slot);
    if (slot) {
      attachToPage(false);
      move(active, slot);
      details.open = false;
    } else {
      if (wasInline) details.open = matchMedia("(min-width: 741px) and (min-height: 520px)").matches;
      move(active, stage);
      if (!external) floating.place();
    }
    active.instance.player.dataset.videoMode = slot ? "inline" : "mini";
    returnLink.href = active.href;
    updateReturnLink();
    const name = active.title || miniPlayer;
    title.textContent = caption.textContent = name;
    if (external && panel.ownerDocument.title !== name) panel.ownerDocument.title = name;
    const action = external ? t("Show separate player window", "Separates Playerfenster anzeigen") : miniPlayer;
    const description = active.title ? action + " · " + name : action;
    summary.setAttribute("aria-label", description);
    summary.title = description;
  }

  updateWindowControls();

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
        if (previous && previous !== entry) attachToPage(false);
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

  summary.addEventListener("click", event => {
    if (!external) return;
    event.preventDefault();
    if (external.closed) refreshPlacement();
    else external.focus();
  }, { signal });
  returnLink.addEventListener("click", event => {
    if (!external || !active) return;
    event.preventDefault();
    const room = new URL(active.href, location.origin);
    window.focus();
    location.hash = room.hash;
  }, { signal });
  details.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !details.open || document.fullscreenElement) return;
    event.stopPropagation();
    details.open = false;
    summary.focus({ preventScroll: true });
  }, { signal });
  window.addEventListener("pagehide", () => attachToPage(false), { signal });
  signal.addEventListener("abort", () => {
    active?.dispose();
    active = undefined;
    attachToPage(false);
    dock.hidden = true;
    dock.replaceChildren();
  }, { once: true });
  return { get, stop, refreshPlacement };
}
