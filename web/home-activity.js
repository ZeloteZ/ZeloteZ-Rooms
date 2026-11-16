import { api, el, localizedTime, personMark, personName, status, tell, topicHref } from "./ui.js";
import { t } from "./i18n.js";
import { wasVoiceReleased } from "./voice.js";

function activityLink(item, snippet) {
  return el("li", {}, el("a", {
    class: "home-activity-card", href: topicHref(item.topicId, item.channelId), "data-feed-id": item.id,
  },
    personMark(item.author),
    el("span", { class: "home-activity-copy" },
      el("span", { class: "home-activity-location" }, item.topicTitle + " · #" + item.channelTitle),
      el("span", { class: "home-activity-snippet" }, snippet),
      el("span", { class: "home-activity-meta" }, personName(item.author), " · ",
        el("time", { datetime: item.at }, localizedTime(item.at))))));
}

function streamLink(stream) {
  const person = { ...stream, id: stream.userId };
  return el("li", {}, el("a", {
    class: "home-activity-card", href: topicHref(stream.topicId, stream.channelId), "data-feed-id": stream.id,
  },
    personMark(person),
    el("span", { class: "home-activity-copy" },
      personName(person, { class: "home-live-person" }),
      el("span", { class: "home-activity-location" }, stream.topicTitle + " · " + stream.channelTitle)),
    el("span", { class: "tag live" }, "Live")));
}

function talkLink(room) {
  const names = room.members.slice(0, 3).map(member => personName({ ...member, id: member.userId }));
  const extra = room.members.length - names.length;
  return el("li", {}, el("a", {
    class: "home-activity-card", href: topicHref(room.topicId, room.channelId), "data-feed-id": "talk-" + room.channelId,
  }, el("span", { class: "avatar", "aria-hidden": "true" }, "♪"),
    el("span", { class: "home-activity-copy" },
      el("span", { class: "home-activity-location" }, room.topicTitle + " · " + room.channelTitle),
      el("span", { class: "home-activity-snippet" }, names.flatMap((name, index) => [index ? ", " : "", name]),
        extra > 0 ? " +" + extra : "")),
    el("span", { class: "tag" }, t("Voice chat", "Sprachchat"))));
}

async function activityCard(item) {
  try {
    const message = await ClubCrypto.openMessage(item.channelId, item.id, item.envelope);
    if (!message) return null;
    const { text, attachments } = message.content ?? {};
    const snippet = typeof text === "string" && text.trim()
      ? text.trim().replace(/\s+/gu, " ").slice(0, 220)
      : Array.isArray(attachments) && attachments.length ? t("Shared an attachment", "Anhang geteilt") : t("New message", "Neue Nachricht");
    return activityLink(item, snippet);
  } catch {
    return null;
  }
}

export function renderHomeActivity({ signal }) {
  const activity = el("ul", { class: "home-activity-list", hidden: true });
  const streams = el("ul", { class: "home-activity-list", hidden: true });
  const activityNote = status(t("Loading activity…", "Aktivität wird geladen …"));
  const streamNote = status(t("Loading live status…", "Live-Status wird geladen …"));
  let timer;
  let snapshot;

  function setList(list, note, cards, empty) {
    const active = document.activeElement;
    const focused = list.contains(active) ? active.dataset.feedId : null;
    list.replaceChildren(...cards);
    list.hidden = !cards.length;
    tell(note, cards.length ? "" : empty);
    if (focused) {
      [...list.querySelectorAll("[data-feed-id]")].find(card => card.dataset.feedId === focused)?.focus({ preventScroll: true });
    }
  }

  async function refresh() {
    try {
      const result = await api("home/activity", { signal });
      const next = JSON.stringify(result);
      if (next === snapshot) return;
      const feed = await Promise.all(result.activities.map(activityCard));
      if (signal.aborted) return;
      snapshot = next;
      setList(activity, activityNote, feed.filter(Boolean), t("No new messages in your rooms yet.", "Noch keine neuen Nachrichten in deinen Räumen."));
      const talkRooms = (result.talkRooms ?? []).flatMap(room => {
        const members = room.members.filter(member => !wasVoiceReleased(member.id));
        return members.length ? [{ ...room, members }] : [];
      });
      const liveCards = [...result.streams.map(streamLink), ...talkRooms.map(talkLink)];
      setList(streams, streamNote, liveCards, result.streamsAvailable
        ? t("Nobody is streaming or talking in your rooms right now.", "In deinen Räumen streamt oder spricht gerade niemand.")
        : t("Live status is unavailable right now.", "Der Live-Status ist gerade nicht erreichbar."));
    } catch (error) {
      if (!signal.aborted) {
        snapshot = null;
        tell(activityNote, t("Activity could not be refreshed.", "Aktivität konnte nicht aktualisiert werden."), "error");
        tell(streamNote, t("Live status could not be refreshed.", "Live-Status konnte nicht aktualisiert werden."), "error");
      }
    } finally {
      if (!signal.aborted) timer = setTimeout(refresh, 12000);
    }
  }

  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  refresh();
  return el("div", { class: "home-activity-grid" },
    el("section", { class: "panel home-activity-panel" }, el("h2", {}, t("Recent activity", "Letzte Aktivität")), activityNote, activity),
    el("section", { class: "panel home-activity-panel" }, el("h2", {}, t("Live now", "Gerade live")), streamNote, streams));
}
