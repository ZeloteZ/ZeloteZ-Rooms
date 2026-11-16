import { t } from "./i18n.js";
import { api, button, directHref, el, identifier, localizedTime, personMark, status, tell, topicHref } from "./ui.js";

function describe(entry) {
  const name = entry.actor.displayName;
  if (entry.kind === "friend-request") {
    return { route: "#/friends", title: t("Friend request", "Freundschaftsanfrage"),
      caption: t("{name} sent you a friend request", "{name} hat dir eine Freundschaftsanfrage geschickt", { name }) };
  }
  if (entry.kind === "direct-message") {
    return { route: directHref(entry.conversationId, entry.messageId), title: t("Direct message", "Direktnachricht"),
      caption: t("New message from {name}", "Neue Nachricht von {name}", { name }) };
  }
  const where = entry.roomTitle + " · " + entry.channelTitle;
  if (entry.kind === "live") {
    return { route: topicHref(entry.roomId, entry.channelId, { streamId: entry.streamId }),
      title: t("Live now", "Jetzt live"), caption: t("{name} went live", "{name} ist live gegangen", { name }), where };
  }
  return { route: topicHref(entry.roomId, entry.channelId, {
    messageId: entry.messageId, streamId: entry.source === "stream" ? entry.streamId : undefined,
  }), title: t("Mention", "Erwähnung"), caption: t("{name} mentioned you", "{name} hat dich erwähnt", { name }), where };
}

function desktopDelivery() {
  const electron = window.roomsDesktopNotifications;
  if (typeof electron?.notify === "function") return payload => electron.notify(payload);
  const gtk = window.webkit?.messageHandlers?.roomsCapture;
  if (typeof gtk?.postMessage === "function") return payload => gtk.postMessage({ action: "notification", ...payload });
  return null;
}

export function mountNotifications(dock, signal, openCurrent) {
  const title = t("Notifications", "Benachrichtigungen");
  const badge = el("span", { class: "notifications-badge", hidden: true, "aria-hidden": "true" });
  const trigger = el("summary", { class: "button notification-trigger", "aria-label": title, title },
    el("span", { class: "notification-glyph", "aria-hidden": "true" }), badge);
  const list = el("ul", { class: "notification-list", "aria-label": title });
  const feedback = status(t("Loading notifications …", "Benachrichtigungen werden geladen …"));
  const markAll = button(t("Mark all read", "Alle als gelesen"), () => markRead(), { class: "ghost", disabled: true });
  const panel = el("section", { class: "notification-panel panel", "aria-label": title },
    el("div", { class: "section-heading" }, el("h2", {}, title), markAll), list, feedback);
  const menu = el("details", { class: "notification-menu", name: "header-media" }, trigger, panel);
  dock.replaceChildren(menu);
  dock.hidden = false;

  let timer;
  let loading = false;
  let refreshAgain = false;
  let marking = false;
  let unread = 0;
  let lastList;
  const desktop = desktopDelivery();
  const seen = new Set();
  let ready = false;

  function item(entry) {
    const { caption, route, where } = describe(entry);
    const link = el("a", { href: route, class: "notification-link", "data-notification-id": entry.id,
      "data-unread": entry.readAt ? undefined : "", onclick: event => {
        menu.open = false;
        if (!entry.readAt) markRead(entry.id);
        if (route === location.hash && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
          event.preventDefault();
          openCurrent();
        }
      } },
    personMark(entry.actor),
    el("span", { class: "notification-description" },
      el("strong", {}, caption),
      where && el("span", { class: "notification-location" }, where),
      el("time", { datetime: entry.createdAt }, localizedTime(entry.createdAt))),
    entry.readAt ? null : el("span", { class: "notification-dot", role: "img",
      "aria-label": t("Unread", "Ungelesen") }));
    return el("li", {}, link);
  }

  function deliver(entries) {
    if (!desktop) return;
    for (const entry of [...entries].reverse()) {
      const id = String(entry.id);
      if (seen.has(id)) continue;
      seen.add(id);
      if (!ready || Date.now() - Date.parse(entry.createdAt) > 120000) continue;
      const { caption, title, route, where } = describe(entry);
      const body = where ? caption + " · " + where : caption;
      try {
        Promise.resolve(desktop({ id, kind: entry.kind, title, body: body.slice(0, 180), href: route })).catch(() => {});
      } catch {
        // Native notifications can be unavailable while a desktop window is closing.
      }
    }
    while (seen.size > 512) seen.delete(seen.values().next().value);
    ready = true;
  }

  async function markRead(id) {
    if (!id && marking) return;
    if (!id) {
      marking = true;
      markAll.disabled = true;
    }
    try {
      await api(id ? "notifications/" + identifier(id) : "notifications", { method: "PATCH", signal });
      if (!signal.aborted) refresh();
    } catch (error) {
      if (!signal.aborted) tell(feedback, error.message, "error");
    } finally {
      if (!id) {
        marking = false;
        markAll.disabled = unread === 0;
      }
    }
  }

  async function refresh() {
    clearTimeout(timer);
    if (signal.aborted) return;
    if (loading) {
      refreshAgain = true;
      return;
    }
    loading = true;
    try {
      const data = await api("notifications", { signal });
      if (signal.aborted) return;
      deliver(data.notifications);
      unread = data.unreadCount;
      badge.hidden = unread === 0;
      badge.textContent = unread > 99 ? "99+" : String(unread);
      trigger.setAttribute("aria-label", unread
        ? t("Notifications · {count} unread", "Benachrichtigungen · {count} ungelesen", { count: unread }) : title);
      markAll.disabled = marking || unread === 0;
      const signature = JSON.stringify(data.notifications);
      if (lastList !== signature) {
        lastList = signature;
        const focused = document.activeElement?.dataset.notificationId;
        const scroll = list.scrollTop;
        list.replaceChildren(...data.notifications.map(item));
        list.scrollTop = scroll;
        if (focused) {
          Array.from(list.querySelectorAll("a")).find(link => link.dataset.notificationId === focused)?.focus({ preventScroll: true });
        }
      }
      tell(feedback, data.notifications.length ? "" : t("No notifications yet.", "Noch keine Benachrichtigungen."));
    } catch (error) {
      if (!signal.aborted) tell(feedback, error.message, "error");
    } finally {
      loading = false;
      if (!signal.aborted) timer = setTimeout(refresh, refreshAgain ? 0 : desktop ? 5000 : document.hidden ? 30000 : 7000);
      refreshAgain = false;
    }
  }

  menu.addEventListener("toggle", () => { if (menu.open) refresh(); }, { signal });
  menu.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !menu.open) return;
    event.stopPropagation();
    menu.open = false;
    trigger.focus({ preventScroll: true });
  }, { signal });
  document.addEventListener("click", event => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  }, { signal });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); }, { signal });
  window.addEventListener("hashchange", () => { menu.open = false; }, { signal });
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    dock.replaceChildren();
    dock.hidden = true;
  }, { once: true });
  refresh();
}
