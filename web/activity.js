import { api, el, identifier, localizedTime, personMark, personName, status, tell, topicHref } from "./ui.js";
import { t } from "./i18n.js";

const interval = 8000;
const previewLimit = 12;

async function preview(entry) {
  try {
    const decoded = await globalThis.ClubCrypto.openMessage(entry.cryptoChannelId ?? entry.channelId, entry.id, entry.envelope, entry.channelId);
    if (!decoded) return t("Encrypted message", "Verschlüsselte Nachricht");
    const content = decoded.content;
    const text = typeof content?.text === "string" ? content.text.trim().replace(/\s+/gu, " ") : "";
    if (text) {
      const characters = [...text];
      return characters.length > 150 ? characters.slice(0, 150).join("") + "…" : text;
    }
    if (Array.isArray(content?.attachments) && content.attachments.length) {
      return content.attachments.length === 1 ? t("One attachment", "Ein Anhang")
        : t("{count} attachments", "{count} Anhänge", { count: content.attachments.length });
    }
  } catch {
    return t("Encrypted message", "Verschlüsselte Nachricht");
  }
  return t("Message", "Nachricht");
}

function activityRow(topicId, entry, text) {
  const time = new Date(entry.at);
  const channel = entry.channelTitle || "Channel";
  return el("li", { class: "activity-row" },
    el("a", { class: "activity-link", href: topicHref(topicId, entry.channelId) },
      el("span", { class: "activity-channel" }, "#" + channel),
      el("p", { class: "activity-snippet" }, text),
      el("span", { class: "activity-meta" },
        personMark(entry.author),
        personName(entry.author, { class: "activity-author" }),
        Number.isFinite(time.getTime())
          ? el("time", { datetime: time.toISOString() }, localizedTime(time))
          : null)));
}

export function renderActivity({ signal }, topic) {
  const list = el("ol", { class: "activity-list", "aria-label": t("Latest messages in this room", "Letzte Nachrichten im Raum") });
  const feedback = status(t("Loading activity…", "Aktivität wird geladen …"));
  const panel = el("section", { class: "panel topic-activity" },
    el("h2", {}, t("Recent activity", "Letzte Aktivität")), feedback, list);
  let rows = new Map();
  let timer;

  async function refresh() {
    if (signal.aborted) return;
    try {
      const { activities } = await api("topics/" + identifier(topic.id) + "/activity", { signal });
      if (signal.aborted) return;
      const entries = Array.isArray(activities) ? activities.slice(0, previewLimit) : [];
      const nextRows = new Map();
      for (const entry of entries) {
        if (signal.aborted) return;
        const id = entry.channelId + "/" + entry.id;
        if (nextRows.has(id)) continue;
        const display = JSON.stringify([entry.channelTitle, entry.author, entry.at, entry.envelope?.body]);
        const cached = rows.get(id);
        const row = cached?.display === display
          ? cached
          : { display, element: activityRow(topic.id, entry, await preview(entry)) };
        nextRows.set(id, row);
      }
      if (signal.aborted) return;
      for (const [id, row] of rows) {
        if (nextRows.get(id) !== row) row.element.remove();
      }
      let current = list.firstElementChild;
      for (const row of nextRows.values()) {
        if (row.element === current) current = current.nextElementSibling;
        else list.insertBefore(row.element, current);
      }
      rows = nextRows;
      tell(feedback, rows.size ? "" : t("No messages in this room yet.", "In diesem Raum wurde noch nichts geschrieben."));
    } catch {
      if (signal.aborted) return;
      rows.clear();
      list.replaceChildren();
      tell(feedback, t("Activity is unavailable right now.", "Aktivität ist gerade nicht verfügbar."), "error");
    } finally {
      if (!signal.aborted) timer = setTimeout(refresh, interval);
    }
  }

  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    rows.clear();
    list.replaceChildren();
  }, { once: true });
  refresh();
  return panel;
}
