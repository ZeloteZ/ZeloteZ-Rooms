import { t } from "./i18n.js";

export function createWatchCinema({ signal, target, trigger, onChange }) {
  let active;

  function close(restoreFocus = true) {
    const entry = active;
    if (!entry) return;
    active = undefined;
    entry.events.abort();
    if (entry.popover && entry.player.matches(":popover-open")) entry.player.hidePopover();
    entry.player.removeAttribute("data-watch-cinema");
    for (const [name, value] of entry.attributes) {
      if (value === null) entry.player.removeAttribute(name);
      else entry.player.setAttribute(name, value);
    }
    for (const node of entry.inert) node.removeAttribute("inert");
    for (const node of entry.ancestors) node.removeAttribute("data-watch-cinema-ancestor");
    entry.backdrop?.remove();
    onChange?.(false);
    if (restoreFocus && !signal.aborted && entry.opener?.isConnected) entry.opener.focus({ preventScroll: true });
  }

  function open() {
    const player = target?.();
    if (signal.aborted || !player?.isConnected || document.fullscreenElement || !player.getClientRects().length) return;

    const entry = { player, opener: trigger?.() ?? document.activeElement, events: new AbortController(),
      attributes: new Map(["role", "aria-modal", "aria-label", "popover"].map(name => [name, player.getAttribute(name)])),
      inert: [], ancestors: [] };
    active = entry;
    const options = { signal: entry.events.signal };
    player.setAttribute("role", "dialog");
    player.setAttribute("aria-modal", "true");
    if (!player.hasAttribute("aria-label")) player.setAttribute("aria-label", t("Cinema mode", "Kinomodus"));

    if (typeof player.showPopover === "function" && !player.hasAttribute("popover")) {
      player.dataset.watchCinema = "popover";
      player.setAttribute("popover", "auto");
      try {
        player.showPopover();
        entry.popover = true;
        player.addEventListener("toggle", event => {
          if (event.newState === "closed" && active === entry) close();
        }, options);
      } catch {
        player.removeAttribute("popover");
      }
    }
    if (!entry.popover) {
      player.dataset.watchCinema = "fallback";
      entry.backdrop = document.createElement("div");
      entry.backdrop.className = "watch-cinema-backdrop";
      entry.backdrop.setAttribute("aria-hidden", "true");
      entry.backdrop.addEventListener("click", () => close(), options);
      document.body.append(entry.backdrop);
    }

    for (let branch = player; branch.parentElement && branch !== document.body; branch = branch.parentElement) {
      const parent = branch.parentElement;
      for (const sibling of parent.children) {
        if (sibling === branch || sibling === entry.backdrop || sibling.hasAttribute("inert")) continue;
        sibling.setAttribute("inert", "");
        entry.inert.push(sibling);
      }
      if (!entry.popover && parent !== document.body) {
        parent.setAttribute("data-watch-cinema-ancestor", "");
        entry.ancestors.push(parent);
      }
    }

    document.addEventListener("keydown", event => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      close();
    }, options);
    document.addEventListener("fullscreenchange", () => {
      if (document.fullscreenElement) close(false);
    }, options);
    window.addEventListener("hashchange", () => close(false), options);
    window.addEventListener("popstate", () => close(false), options);
    onChange?.(true);
    entry.opener?.focus({ preventScroll: true });
  }

  signal.addEventListener("abort", () => close(false), { once: true });
  return { toggle() { if (active) close(); else open(); }, close };
}
