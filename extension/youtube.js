(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const action = document.createElement("button");
  action.type = "button";
  action.className = "zelotez-create-room";
  action.textContent = api.i18n.getMessage("createRoom");
  action.title = action.textContent;
  let observing = false;
  let queued = false;
  let launching = false;

  function isWatchPage() {
    const url = new URL(location.href);
    const ids = url.searchParams.getAll("v");
    return url.pathname === "/watch" && ids.length === 1 && /^[A-Za-z0-9_-]{11}$/u.test(ids[0]);
  }

  function placeButton() {
    if (!isWatchPage()) return;
    const row = document.querySelector("ytd-watch-flexy:not([hidden]) #actions #top-level-buttons-computed")
      ?? document.querySelector("ytd-watch-flexy:not([hidden]) #actions .top-level-buttons");
    if (!row || action.parentElement === row) return;
    const shareLabel = /^(share|teilen|partager|compartir|compartilhar|condividi|delen|udostępnij|поделиться|共有|공유|分享|分享影片|分享视频)(?:[ .…]|$)/iu;
    const share = [...row.querySelectorAll("button")].find(button => shareLabel.test(
      (button.getAttribute("aria-label") || button.title || button.textContent).trim()));
    let anchor = share;
    if (anchor) while (anchor.parentElement && anchor.parentElement !== row) anchor = anchor.parentElement;
    if (anchor?.parentElement === row) anchor.after(action);
    else row.append(action);
  }

  function queue() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      placeButton();
    });
  }

  const observer = new MutationObserver(queue);
  function navigate() {
    if (!isWatchPage()) {
      observer.disconnect();
      observing = false;
      action.remove();
      return;
    }
    if (!observing && document.body) {
      observer.observe(document.body, { subtree: true, childList: true });
      observing = true;
    }
    queue();
  }

  action.addEventListener("click", async event => {
    if (!event.isTrusted || launching || !isWatchPage()) return;
    launching = true;
    action.disabled = true;
    action.removeAttribute("data-error");
    action.title = api.i18n.getMessage("createRoom");
    try {
      const result = await api.runtime.sendMessage({ type: "rooms-youtube-video" });
      if (!result?.ok) throw new Error("Handoff unavailable");
    } catch {
      action.setAttribute("data-error", "");
      action.title = api.i18n.getMessage("launchFailed");
    } finally {
      launching = false;
      action.disabled = false;
    }
  });
  document.addEventListener("yt-navigate-finish", navigate);
  window.addEventListener("popstate", navigate);
  navigate();
})();
