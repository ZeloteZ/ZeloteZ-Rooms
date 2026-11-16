import { renderChat } from "./chat.js";
import { t } from "./i18n.js";
import { api, button, closeDialog, directHref, el, field, form, identifier, localizedTime,
  openDirect, personMark, personName, select, showDialog, status, tell } from "./ui.js";

async function chooseFriend(signal, feedback, trigger) {
  trigger.disabled = true;
  tell(feedback, "");
  try {
    const { people } = await api("people", { signal });
    if (signal.aborted) return;
    const friends = people.filter(person => person.relationship === "friend")
      .sort((first, second) => first.displayName.localeCompare(second.displayName));
    const title = t("New message", "Neue Nachricht");
    if (!friends.length) {
      showDialog(title, el("div", { class: "stack" },
        el("p", { class: "muted" }, t("You can start a conversation with a confirmed friend.",
          "Du kannst mit bestätigten Freunden eine Unterhaltung beginnen.")),
        el("a", { href: "#/friends", class: "button", onclick: closeDialog }, t("Go to friends", "Zu deinen Freunden"))));
      return;
    }
    const picker = select(friends.map(person => [person.id, person.displayName + " · @" + person.username]), friends[0].id);
    showDialog(title, form(field(t("Friend", "Freund"), picker), t("Open chat", "Chat öffnen"), async () => {
      await openDirect(picker.value, signal);
      closeDialog();
    }));
  } catch (error) {
    if (!signal.aborted) tell(feedback, error.message, "error");
  } finally {
    trigger.disabled = false;
  }
}

export async function renderDirect(context, id, messageId) {
  const { signal } = context;
  const endpoint = id ? "direct/" + identifier(id) : null;
  const [{ conversations }, active] = await Promise.all([
    api("direct", { signal }),
    endpoint ? api(endpoint, { signal }).then(result => result.conversation) : null,
  ]);
  signal.throwIfAborted();

  const title = t("Direct messages", "Direktnachrichten");
  const feedback = status();
  const inbox = el("ul", { class: "direct-inbox", tabindex: "0", "aria-label": title });
  const newMessage = button(t("New message", "Neue Nachricht"),
    event => chooseFriend(signal, feedback, event.currentTarget), { class: "primary" });
  const reading = new EventTarget();
  let timer;
  let refreshing = false;
  let marking = false;
  let goal = 0;
  let acknowledged = 0;
  let writable = active?.canSend;
  let signature;

  function syncList(entries) {
    const next = JSON.stringify(entries);
    if (next === signature) return;
    signature = next;
    const focused = inbox.contains(document.activeElement) ? document.activeElement.getAttribute("href") : null;
    const scroll = inbox.scrollTop;
    inbox.replaceChildren(...entries.map(({ id: conversationId, peer, unreadCount, updatedAt }) => {
      const selected = id === conversationId;
      const href = directHref(conversationId);
      return el("li", {}, el("a", { href, class: "direct-entry", "aria-current": selected ? "page" : undefined },
        personMark(peer),
        el("span", { class: "direct-entry-person" }, personName(peer),
          el("span", { class: "subtle" }, "@" + peer.username)),
        el("span", { class: "direct-entry-state" },
          updatedAt && el("time", { datetime: updatedAt, class: "subtle" }, localizedTime(updatedAt)),
          unreadCount > 0 && el("span", { class: "direct-unread",
            "aria-label": t("{count} unread", "{count} ungelesen", { count: unreadCount }) },
          unreadCount > 99 ? "99+" : String(unreadCount)))));
    }));
    if (!entries.length) inbox.append(el("li", { class: "direct-empty subtle" },
      t("Your conversations will appear here.", "Hier erscheinen deine Unterhaltungen.")));
    inbox.scrollTop = scroll;
    if (focused) [...inbox.querySelectorAll("a")].find(link => link.getAttribute("href") === focused)?.focus({ preventScroll: true });
  }

  async function refresh() {
    if (signal.aborted || refreshing) return;
    clearTimeout(timer);
    refreshing = true;
    try {
      const { conversations: next } = await api("direct", { signal });
      if (signal.aborted) return;
      syncList(next);
      const current = id && next.find(entry => entry.id === id);
      if (current && writable !== current.canSend) {
        writable = current.canSend;
        reading.dispatchEvent(new CustomEvent("change", { detail: writable }));
      }
    } catch {
      // Keep the currently rendered inbox available through a brief network outage.
    } finally {
      refreshing = false;
      if (!signal.aborted) timer = setTimeout(refresh, document.hidden ? 20000 : 5000);
    }
  }

  async function markRead(sequence) {
    goal = Math.max(goal, sequence);
    if (marking || goal <= acknowledged || signal.aborted) return;
    marking = true;
    const throughSeq = goal;
    try {
      await api(endpoint, { method: "PATCH", body: { throughSeq }, signal });
      acknowledged = throughSeq;
      void refresh();
    } catch {
      // The next chat poll retries the same rendered sequence.
    } finally {
      marking = false;
    }
    if (acknowledged === throughSeq && goal > throughSeq) void markRead(goal);
  }

  syncList(conversations);
  timer = setTimeout(refresh, 5000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); }, { signal });
  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });

  const chat = active ? renderChat({ ...context, messageId, direct: {
    canSend: writable, events: reading, onRead: markRead, name: active.peer.displayName,
    onUnavailable: () => { location.hash = directHref(); },
  } }, active.channel) : el("section", { class: "panel direct-welcome" },
    el("h2", {}, t("A private chat with a friend", "Ein privater Chat mit einem Freund")),
    el("p", { class: "muted" }, t("Open a conversation or start a new one.", "Öffne eine Unterhaltung oder beginne eine neue.")));

  return el("div", { class: "direct-page", "data-conversation": active ? "" : undefined },
    el("div", { class: "page-heading direct-heading" },
      active && el("a", { href: directHref(), class: "button direct-back", "aria-label": t("Back to messages", "Zurück zu Nachrichten") }, "‹"),
      el("h1", {}, title), newMessage),
    feedback,
    el("div", { class: "direct-layout" },
      el("aside", { class: "panel direct-sidebar", "aria-label": t("Conversations", "Unterhaltungen") }, inbox),
      chat));
}
