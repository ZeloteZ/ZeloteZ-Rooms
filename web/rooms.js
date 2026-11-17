import { t } from "./i18n.js";
import { renderActivity } from "./activity.js";
import { applyTopicCover, applyTopicDesign, editTopicDesign } from "./appearance.js";
import { renderChat } from "./chat.js";
import { renderHomeActivity } from "./home-activity.js";
import { renderGuestViewer } from "./guest-viewer.js";
import { renderLive } from "./live.js";
import { createQuickScreen } from "./quick-screen.js";
import { openStreamNow, quickRoomActions } from "./quick-start.js";
import { createWatchParty } from "./watch-party.js";
import { api, button, closeDialog, el, field, form, identifier, notify, personRow, sameId, select, showDialog, status, tell, topicHref } from "./ui.js";

const visibilityOptions = [["public", t("Everyone in the group", "Für alle im Freundeskreis")], ["private", t("Private · invite only", "Privat · nur auf Einladung")]];
const channelOptions = [["chat", "Chat"], ["live", "Live"]];
const streamPolicies = [["all", t("All room members", "Alle Raummitglieder")], ["admins", t("Room owner and admins", "Raumersteller und Raum-Admins")]];
const topicPolicies = [...streamPolicies, ["disabled", t("Streaming disabled in this room", "Streaming in diesem Raum aus")]];
const roleNames = { owner: t("Owner", "Ersteller"), admin: "Admin", member: t("Member", "Mitglied") };

function timeOrder(key) {
  return (first, second) => (Date.parse(second[key]) || 0) - (Date.parse(first[key]) || 0);
}

function tag(topic) {
  return el("span", { class: "tag" }, topic.visibility === "private" ? t("Private", "Privat") : t("Everyone", "Für alle"));
}

function refreshAfter(context, message) {
  closeDialog();
  if (!context.signal.aborted) {
    notify(message);
    context.refresh();
  }
}

function newTopic(context) {
  const title = el("input", { required: true, maxlength: "72", name: "title", autocomplete: "off" });
  const visibility = select(visibilityOptions, "public");
  showDialog(t("Create room", "Raum erstellen"), form([
    field(t("Room name", "Name des Raums"), title), field(t("Who can join?", "Wer kann beitreten?"), visibility),
  ], t("Create", "Erstellen"), async () => {
    const { topic } = await api("topics", {
      method: "POST", body: { title: title.value.trim(), visibility: visibility.value }, signal: context.signal,
    });
    closeDialog();
    location.hash = topicHref(topic.id);
  }));
}

function roomActions(context) {
  const actions = el("div", { class: "inline" }, button(t("Create room", "Raum erstellen"), () => newTopic(context), { class: "primary" }));
  showDialog(t("Room actions", "Raumaktionen"), actions);
  void api("quick-rooms", { signal: context.signal }).then(({ room }) => {
    if (!room || !actions.isConnected || context.signal.aborted) return;
    actions.append(el("a", {
      class: "button", href: topicHref(room.topicId, room.channelId),
    }, t("Return to temporary room", "Zum temporären Raum zurück")));
  }).catch(() => {});
}

function favoriteControl(topic, context, card = false) {
  const isFavorite = Boolean(topic.favorite);
  const accessibleName = isFavorite ? t("Remove from favorites", "Aus Favoriten entfernen") : t("Add to favorites", "Zu Favoriten hinzufügen");
  const star = isFavorite ? "★" : "☆";
  return button(card ? star : [
    el("span", { "aria-hidden": "true" }, star),
    el("span", { class: "room-action-label" }, t("Favorite", "Favorit")),
  ],
    async event => {
      const control = event.currentTarget;
      control.disabled = true;
      try {
        await api("topics/" + identifier(topic.id) + "/favorite", {
          method: "POST", body: { favorite: !isFavorite }, signal: context.signal,
        });
        await context.refresh();
      } catch (error) {
        if (!context.signal.aborted) notify(error.message);
      } finally {
        control.disabled = false;
      }
    },
    {
      class: card ? "icon-button favorite" : "", "aria-pressed": String(isFavorite),
      "aria-label": accessibleName + " · " + topic.title, title: accessibleName,
    });
}

function topicCard(topic, context) {
  const tone = Array.from(String(topic.id)).reduce((sum, char) => sum + char.codePointAt(0), 0) % 5;
  const nav = el("a", { class: "topic-link", href: topicHref(topic.id), title: topic.title, draggable: "false" },
    el("strong", {}, topic.title),
    el("span", {}, topic.invited && !topic.joined ? t("Invited", "Einladung erhalten") : topic.joined ? roleNames[topic.role] || t("Member", "Mitglied") : t("Join", "Beitreten")));
  const card = el("article", { class: "topic-card", "data-tone": tone },
    nav, tag(topic), topic.joined && favoriteControl(topic, context, true));
  applyTopicCover(card, topic.appearance);
  return card;
}

function enableShelfScrolling(shelf, grid, signal) {
  let pointer;
  let dragged = false;

  shelf.addEventListener("wheel", event => {
    if (event.ctrlKey || event.metaKey || !event.cancelable || event.defaultPrevented) return;
    const unit = event.deltaMode;
    const vertical = Math.abs(event.deltaY) > Math.abs(event.deltaX);
    // Let browsers handle horizontal trackpad gestures inside the scrollport.
    if (!vertical && grid.contains(event.target)) return;
    const delta = (vertical ? event.deltaY : event.deltaX) *
      (unit === 1 ? 16 : unit === 2 ? grid.clientWidth : 1);
    const left = grid.scrollLeft;
    const next = Math.max(0, Math.min(grid.scrollWidth - grid.clientWidth, left + delta));
    if (!delta || (delta > 0 ? next <= left : next >= left)) return;
    event.preventDefault();
    grid.scrollLeft = next;
  }, { passive: false, signal });

  shelf.addEventListener("pointerdown", event => {
    dragged = false;
    if (event.pointerType !== "mouse" || event.button !== 0 || !event.isPrimary ||
        event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
        !shelf.hasAttribute("data-scrollable")) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, left: grid.scrollLeft };
  }, { signal });

  function finishDrag(event) {
    if (!pointer || (event.pointerId !== undefined && event.pointerId !== pointer.id)) return;
    pointer = undefined;
    shelf.removeAttribute("data-dragging");
  }

  window.addEventListener("pointermove", event => {
    if (pointer?.id !== event.pointerId) return;
    if (!(event.buttons & 1)) return finishDrag(event);
    const distance = event.clientX - pointer.x;
    if (!dragged) {
      if (Math.hypot(distance, event.clientY - pointer.y) < 6) return;
      dragged = true;
      shelf.setPointerCapture(event.pointerId);
      shelf.setAttribute("data-dragging", "");
    }
    grid.scrollLeft = pointer.left - distance;
  }, { signal });
  window.addEventListener("pointerup", finishDrag, { signal });
  window.addEventListener("pointercancel", finishDrag, { signal });
  window.addEventListener("blur", finishDrag, { signal });
  shelf.addEventListener("lostpointercapture", finishDrag, { signal });
  shelf.addEventListener("click", event => {
    if (!dragged || event.detail === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    dragged = false;
  }, { capture: true, signal });
}

function collection(title, topics, empty, context, nextPage = null) {
  const heading = el("h2", {}, title);
  if (!topics.length) {
    return el("section", { class: "home-shelf" }, heading, el("p", { class: "panel collection-empty muted" }, empty));
  }
  const grid = el("div", { class: "topic-grid" }, topics.map(topic => topicCard(topic, context)));
  let loading = false;
  function atEnd() {
    return grid.scrollWidth - grid.clientWidth - grid.scrollLeft < 2;
  }
  async function loadNextPage() {
    if (loading || !nextPage) return false;
    loading = true;
    updateControls();
    try {
      const page = await api("topics?before=" + encodeURIComponent(nextPage), { signal: context.signal });
      if (context.signal.aborted) return false;
      nextPage = page.next ?? null;
      grid.append(...page.topics.map(topic => topicCard(topic, context)));
      return true;
    } catch (error) {
      if (!context.signal.aborted) notify(error.message);
      return false;
    } finally {
      loading = false;
      updateControls();
    }
  }
  async function turn(direction) {
    if (loading || (direction > 0 && atEnd() && nextPage && !await loadNextPage())) return;
    grid.scrollBy({ left: direction * grid.clientWidth,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }
  const back = button("‹", () => turn(-1), { "aria-label": t("Previous in “{title}”", "In „{title}“ zurückblättern", { title }), class: "icon-button" });
  const forward = button("›", () => turn(1), { "aria-label": t("Next in “{title}”", "In „{title}“ weiterblättern", { title }), class: "icon-button" });
  const controls = el("div", { class: "shelf-controls", hidden: true }, back, forward);
  const shelf = el("section", { class: "home-shelf" },
    el("div", { class: "shelf-heading" }, heading, controls), grid);
  function updateControls() {
    const scrollable = grid.scrollWidth - grid.clientWidth >= 2;
    shelf.toggleAttribute("data-scrollable", scrollable);
    controls.hidden = !scrollable && !nextPage;
    back.disabled = grid.scrollLeft < 2;
    forward.disabled = loading || (atEnd() && !nextPage);
  }
  const resize = new ResizeObserver(updateControls);
  resize.observe(grid);
  grid.addEventListener("scroll", () => {
    updateControls();
    if (grid.scrollLeft > 0 && atEnd()) void loadNextPage();
  }, { passive: true, signal: context.signal });
  context.signal.addEventListener("abort", () => resize.disconnect(), { once: true });
  enableShelfScrolling(shelf, grid, context.signal);
  return shelf;
}

function greeting(name) {
  const hour = new Date().getHours();
  if (hour < 5) return t("Hello, {name}", "Hallo, {name}", { name });
  if (hour < 12) return t("Good morning, {name}", "Guten Morgen, {name}", { name });
  if (hour < 18) return t("Good afternoon, {name}", "Guten Tag, {name}", { name });
  return t("Good evening, {name}", "Guten Abend, {name}", { name });
}

export async function renderTopics(context) {
  const { topics, next, recent = topics.filter(topic => topic.joined && topic.visitedAt).sort(timeOrder("visitedAt")).slice(0, 8),
    favorites = topics.filter(topic => topic.favorite).sort(timeOrder("visitedAt")) } = await api("topics", { signal: context.signal });
  const newest = [...topics].sort(timeOrder("createdAt"));
  const tabs = [
    button(t("Rooms", "Räume"), () => selectPane("topics"), { "aria-pressed": "true" }),
    button(t("Activity", "Aktivität"), () => selectPane("activity"), { "aria-pressed": "false" }),
  ];
  const dashboard = el("div", { class: "home-dashboard", "data-pane": "topics" },
    el("header", { class: "home-heading page-heading" },
      el("h1", {}, greeting(context.user.displayName)),
      el("div", { class: "inline home-room-actions" },
        button(t("Stream Now", "Jetzt streamen"), () => openStreamNow(context), { class: "primary", "aria-haspopup": "dialog" }),
        button("⚙", () => roomActions(context), {
          class: "icon-button", title: t("Room actions", "Raumaktionen"), "aria-label": t("Room actions", "Raumaktionen"), "aria-haspopup": "dialog",
        }))),
    el("div", { class: "home-tabs", role: "group", "aria-label": t("Room overview", "Raumübersicht") }, tabs),
    el("div", { class: "home-content" },
      el("div", { class: "home-topics" },
        collection(t("Your favorites", "Deine Favoriten"), favorites, t("Star rooms to see them here.", "Markiere Räume mit einem Stern, damit sie hier erscheinen."), context),
        collection(t("New rooms", "Neue Räume"), newest, t("Create the first room for your group.", "Erstelle den ersten Raum für deinen Freundeskreis."), context, next),
        collection(t("Recently opened", "Zuletzt geöffnet"), recent, t("Find the rooms you opened recently.", "Hier findest du die Räume wieder, die du zuletzt geöffnet hast."), context)),
      renderHomeActivity(context)));
  function selectPane(pane) {
    dashboard.dataset.pane = pane;
    tabs[0].setAttribute("aria-pressed", String(pane === "topics"));
    tabs[1].setAttribute("aria-pressed", String(pane === "activity"));
  }
  return dashboard;
}

function topicSettings(context, topic, onDelete) {
  const endpoint = "topics/" + identifier(topic.id);
  const title = el("input", { required: true, value: topic.title, name: "title", maxlength: "72", autocomplete: "off" });
  const visibility = select(visibilityOptions, topic.visibility);
  const streamPolicy = select(topicPolicies, topic.streamPolicy ?? "all");
  const settings = form([
    field(t("Room name", "Name des Raums"), title),
    field(t("Who can join?", "Wer kann beitreten?"), visibility),
    field(t("Who can stream in this room?", "Wer darf in diesem Raum streamen?"), streamPolicy),
  ], t("Save", "Speichern"), async () => {
    await api(endpoint, {
      method: "PATCH", body: { title: title.value.trim(), visibility: visibility.value, streamPolicy: streamPolicy.value }, signal: context.signal,
    });
    refreshAfter(context, t("Room saved.", "Raum gespeichert."));
  });
  const removeRoom = button(t("Delete room", "Raum löschen"), confirmDelete, { class: "danger" });
  const panel = el("div", { class: "stack" }, settings, el("div", { class: "inline room-settings-delete" }, removeRoom));

  function open() {
    showDialog(t("Edit room", "Raum bearbeiten"), panel);
  }

  function confirmDelete() {
    if (settings.getAttribute("aria-busy") === "true") return;
    const feedback = status();
    const cancel = button(t("Cancel", "Abbrechen"), () => {
      open();
      removeRoom.focus();
    });
    const remove = button(t("Permanently delete room", "Raum endgültig löschen"), async () => {
      cancel.disabled = true;
      remove.disabled = true;
      tell(feedback, "");
      try {
        await api(endpoint, { method: "DELETE", signal: context.signal });
        if (context.signal.aborted) return;
        onDelete();
        closeDialog();
        notify(t("Room deleted.", "Raum gelöscht."));
        location.replace("#/rooms");
      } catch (error) {
        if (!context.signal.aborted) tell(feedback, error.message, "error");
      } finally {
        cancel.disabled = false;
        remove.disabled = false;
      }
    }, { class: "danger" });
    showDialog(t("Delete room", "Raum löschen"), el("div", { class: "stack" },
      el("p", {}, t("Permanently delete “{name}”?", "Möchtest du „{name}“ dauerhaft löschen?", { name: topic.title })),
      el("p", { class: "muted" }, t(
        "This deletes the room and all its channels, messages and attachments for everyone. Active voice chats and streams will end.",
        "Der Raum und alle seine Channels, Nachrichten und Anhänge werden für alle gelöscht. Laufende Sprachchats und Streams werden beendet.")),
      feedback,
      el("div", { class: "inline" }, cancel, remove)));
    cancel.focus();
  }

  open();
}

async function membersDialog(context, topic, members) {
  const panel = el("div", { class: "stack" });
  const feedback = status();
  const owner = topic.role === "owner";
  const endpoint = "topics/" + identifier(topic.id) + "/members";

  function mutate(member, action, label, classes = "") {
    return button(label, async event => {
      const control = event.currentTarget;
      control.disabled = true;
      tell(feedback, "");
      try {
        await api(endpoint, { method: "POST", body: { userId: member.id, action }, signal: context.signal });
        const fresh = await api("topics/" + identifier(topic.id), { signal: context.signal });
        await membersDialog(context, fresh.topic, fresh.members);
      } catch (error) {
        if (!context.signal.aborted) tell(feedback, error.message, "error");
      } finally {
        control.disabled = false;
      }
    }, { class: classes });
  }

  panel.append(el("ul", { class: "person-list" }, members.map(member => {
    const controls = [];
    if (owner && member.role !== "owner") {
      if (member.joined !== false) {
        controls.push(member.role === "admin"
          ? mutate(member, "demote", t("Remove admin role", "Admin-Rechte entziehen"))
          : mutate(member, "promote", t("Make admin", "Admin ernennen")));
        controls.push(member.canDesign
          ? mutate(member, "revoke-design", t("Remove design access", "Designrecht entziehen"))
          : mutate(member, "grant-design", t("Allow design changes", "Design erlauben")));
      }
      controls.push(mutate(member, "remove", member.joined === false ? t("Withdraw invitation", "Einladung zurückziehen") : t("Remove", "Entfernen"), "danger"));
    }
    const membership = member.joined === false ? t("Invited", "Eingeladen") : roleNames[member.role] || t("Member", "Mitglied");
    return personRow(member, controls, membership + (member.canDesign && member.role !== "owner" ? t(" · Can edit design", " · Designrecht") : ""));
  })));
  if (owner) {
    panel.append(el("p", { class: "subtle" }, t("Invite friends individually to a private room.", "Lade Freunde einzeln in einen privaten Raum ein.")), feedback);
    if (topic.visibility === "private") {
      try {
        const { people } = await api("people", { signal: context.signal });
        const candidates = people.filter(person => person.relationship === "friend"
          && !members.some(member => sameId(person.id, member.id)));
        if (candidates.length) {
          const invitee = select(candidates.map(person => [person.id, person.displayName + " (@" + person.username + ")"]), String(candidates[0].id));
          panel.append(form(field(t("Choose a friend", "Freund auswählen"), invitee), t("Invite", "Einladen"), async () => {
            const person = candidates.find(candidate => sameId(candidate.id, invitee.value));
            if (!person) return;
            await api(endpoint, { method: "POST", body: { userId: person.id, action: "invite" }, signal: context.signal });
            const fresh = await api("topics/" + identifier(topic.id), { signal: context.signal });
            await membersDialog(context, fresh.topic, fresh.members);
          }));
        } else {
          panel.append(el("a", { href: "#/friends" }, t("Go to friends", "Zu deinen Freunden")));
        }
      } catch (error) {
        if (!context.signal.aborted) tell(feedback, error.message, "error");
      }
    }
  }
  if (!context.signal.aborted) showDialog(t("Members", "Mitglieder"), panel);
}

function channelDialog(context, topic, channel = null) {
  const name = el("input", { required: true, maxlength: "72", value: channel?.title ?? "", name: "title", autocomplete: "off" });
  const type = select(channelOptions, channel?.type ?? "chat");
  const policy = select(streamPolicies, channel?.streamPolicy ?? "all");
  const streamField = field(t("Who can stream?", "Wer darf streamen?"), policy);
  const updatePolicy = () => { streamField.hidden = type.value !== "live"; };
  type.addEventListener("change", updatePolicy);
  updatePolicy();
  showDialog(channel ? t("Edit channel", "Channel bearbeiten") : t("Create channel", "Channel erstellen"), form([
    field(t("Channel name", "Name des Channels"), name), !channel && field(t("Type", "Typ"), type), streamField,
  ], channel ? t("Save", "Speichern") : t("Create", "Erstellen"), async () => {
    const live = type.value === "live";
    const body = { title: name.value.trim(), ...(channel ? {} : { type: type.value }), ...(live ? { streamPolicy: policy.value } : {}) };
    const result = await api(channel ? "channels/" + identifier(channel.id) : "topics/" + identifier(topic.id) + "/channels", {
      method: channel ? "PATCH" : "POST", body, signal: context.signal,
    });
    if (channel) refreshAfter(context, t("Channel saved.", "Channel gespeichert."));
    else {
      closeDialog();
      location.hash = topicHref(topic.id, result.channel.id);
    }
  }));
}

function manageChannels(context, topic, channels, updateChannels) {
  let saved = channels;
  let draft = [...channels];
  let busy = false;
  const feedback = status();
  const list = el("ol", { class: "channel-manager-list", role: "list", "aria-label": t("Channel order", "Channel-Reihenfolge") });
  const empty = el("p", { class: "muted", hidden: draft.length > 0 }, t("This room has no channels yet.", "Dieser Raum hat noch keine Channels."));
  const save = button(t("Save order", "Reihenfolge speichern"), saveOrder, { class: "primary" });
  const panel = el("div", { class: "stack" }, list, empty, feedback,
    el("div", { class: "inline channel-manager-footer" }, save));

  function move(channel, direction) {
    const index = draft.indexOf(channel);
    const target = index + direction;
    if (busy || index < 0 || target < 0 || target >= draft.length) return;
    [draft[index], draft[target]] = [draft[target], draft[index]];
    tell(feedback, "");
    draw(channel.id, direction < 0 ? "up" : "down");
  }

  function draw(focusId, action) {
    let focus;
    list.replaceChildren(...draft.map((channel, index) => {
      const up = button("↑", () => move(channel, -1), {
        class: "icon-button", disabled: busy, "aria-disabled": index === 0 ? "true" : undefined,
        "aria-label": t("Move “{name}” up", "„{name}“ nach oben verschieben", { name: channel.title }), title: t("Move up", "Nach oben verschieben"),
      });
      const down = button("↓", () => move(channel, 1), {
        class: "icon-button", disabled: busy, "aria-disabled": index === draft.length - 1 ? "true" : undefined,
        "aria-label": t("Move “{name}” down", "„{name}“ nach unten verschieben", { name: channel.title }), title: t("Move down", "Nach unten verschieben"),
      });
      const remove = button(t("Delete", "Löschen"), () => confirmDelete(channel), {
        class: "danger", disabled: busy, "aria-label": t("Delete “{name}”", "„{name}“ löschen", { name: channel.title }),
      });
      if (sameId(channel.id, focusId)) {
        const preferred = { up, down, remove }[action];
        focus = [preferred, up, down, remove].find(control => control && !control.disabled);
      }
      return el("li", { class: "channel-manager-row" },
        el("div", { class: "channel-manager-title" },
          el("strong", {}, channel.title),
          el("span", { class: "subtle" }, channel.type === "live" ? t("Live channel", "Live-Channel") : "Chat")),
        el("div", { class: "inline channel-manager-controls" }, up, down, remove));
    }));
    list.hidden = draft.length === 0;
    empty.hidden = draft.length > 0;
    save.hidden = draft.length < 2;
    save.disabled = busy || draft.every((channel, index) => sameId(channel.id, saved[index]?.id));
    if (focus) focus.focus();
  }

  function open(focusId, action) {
    showDialog(t("Manage channels", "Channels verwalten"), panel);
    draw(focusId, action);
  }

  async function saveOrder() {
    if (busy || save.disabled) return;
    busy = true;
    draw();
    tell(feedback, "");
    try {
      const result = await api("topics/" + identifier(topic.id) + "/channels", {
        method: "PATCH", body: { channelIds: draft.map(channel => channel.id) }, signal: context.signal,
      });
      if (context.signal.aborted) return;
      saved = result.channels;
      draft = [...saved];
      updateChannels(saved);
      tell(feedback, t("Order saved.", "Reihenfolge gespeichert."), "success");
    } catch (error) {
      if (context.signal.aborted) return;
      if (error.status === 409) {
        try {
          const current = await api("topics/" + identifier(topic.id), { signal: context.signal });
          if (context.signal.aborted) return;
          saved = current.channels;
          draft = [...saved];
          updateChannels(saved);
          tell(feedback, t("The channel list has changed. Review the list and try reordering it again.", "Die Channels wurden inzwischen geändert. Prüfe die Reihenfolge und passe sie erneut an."), "error");
        } catch (reloadError) {
          if (!context.signal.aborted) tell(feedback, reloadError.message, "error");
        }
      } else tell(feedback, error.message, "error");
    } finally {
      busy = false;
      if (!context.signal.aborted) draw();
    }
  }

  function confirmDelete(channel) {
    if (busy) return;
    const note = status();
    const cancel = button(t("Cancel", "Abbrechen"), () => open(channel.id, "remove"));
    const remove = button(t("Permanently delete channel", "Channel endgültig löschen"), async () => {
      if (busy) return;
      busy = true;
      cancel.disabled = true;
      remove.disabled = true;
      tell(note, "");
      try {
        await api("channels/" + identifier(channel.id), { method: "DELETE", signal: context.signal });
        if (context.signal.aborted) return;
        const index = draft.indexOf(channel);
        saved = saved.filter(entry => !sameId(entry.id, channel.id));
        draft = draft.filter(entry => !sameId(entry.id, channel.id));
        updateChannels(saved);
        tell(feedback, t("Channel deleted.", "Channel gelöscht."), "success");
        busy = false;
        if (confirmation.closest("dialog")?.open) {
          open(draft[Math.min(index, draft.length - 1)]?.id, "remove");
        }
      } catch (error) {
        if (!context.signal.aborted) tell(note, error.message, "error");
      } finally {
        busy = false;
        cancel.disabled = false;
        remove.disabled = false;
      }
    }, { class: "danger" });
    const confirmation = el("div", { class: "stack" },
      el("p", {}, t("Permanently delete “{name}”?", "Möchtest du „{name}“ dauerhaft löschen?", { name: channel.title })),
      el("p", { class: "muted" }, channel.type === "chat"
        ? t("This deletes every message and attachment in this channel.", "Dabei werden alle Nachrichten und Anhänge dieses Channels gelöscht.")
        : t("Active voice chats and streams will end. Stream chats in this channel will be deleted.", "Laufende Talks und Übertragungen werden beendet. Stream-Chats dieses Channels werden gelöscht.")),
      note,
      el("div", { class: "inline" }, cancel, remove));
    showDialog(t("Delete channel", "Channel löschen"), confirmation);
    cancel.focus();
  }

  open();
}

function joinPanel(context, topic) {
  const feedback = status();
  const canJoin = topic.visibility === "public" || topic.invited;
  return el("section", { class: "panel stack" },
    el("h2", {}, canJoin ? t("Join room", "Raum beitreten") : t("Invitation required", "Einladung erforderlich")),
    el("p", { class: "muted" }, canJoin
      ? t("Join the room to open its channels.", "Nach dem Beitritt kannst du die Channels öffnen.")
      : t("Ask the room owner for an invitation.", "Bitte den Raumersteller um eine Einladung.")),
    canJoin && el("div", { class: "inline" }, button(topic.invited ? t("Accept invitation", "Einladung annehmen") : t("Join", "Beitreten"), async event => {
      const control = event.currentTarget;
      control.disabled = true;
      try {
        await api("topics/" + identifier(topic.id) + "/join", { method: "POST", body: {}, signal: context.signal });
        await context.refresh();
      } catch (error) {
        if (!context.signal.aborted) tell(feedback, error.message, "error");
      } finally {
        control.disabled = false;
      }
    }, { class: "primary" })),
    feedback);
}

function leaveDialog(context, topic) {
  const feedback = status();
  showDialog(t("Leave room", "Raum verlassen"), el("div", { class: "stack" },
    el("p", { class: "muted" }, topic.visibility === "private"
      ? t("You’ll need another invitation to rejoin.", "Für einen neuen Beitritt brauchst du wieder eine Einladung.")
      : t("You can rejoin this room later.", "Du kannst diesem Raum später wieder beitreten.")),
    feedback,
    el("div", { class: "inline" },
      button(t("Cancel", "Abbrechen"), closeDialog),
      button(t("Leave", "Verlassen"), async event => {
        const control = event.currentTarget;
        control.disabled = true;
        try {
          await api("topics/" + identifier(topic.id) + "/join", { method: "DELETE", signal: context.signal });
          closeDialog();
          location.hash = "#/rooms";
        } catch (error) {
          if (!context.signal.aborted) tell(feedback, error.message, "error");
        } finally {
          control.disabled = false;
        }
      }, { class: "danger" }))));
}

function renderQuickPreview(context, topic, channel, signal) {
  const nativePreview = context.nativeBroadcast?.mount(topic, channel, signal, { previewOnly: true });
  const video = el("video", { autoplay: true, playsinline: true, hidden: true });
  video.muted = true;

  function update() {
    const capture = context.screenShare.active();
    const media = capture?.phase === "live" && sameId(capture.channel.id, channel.id) ? capture.media : null;
    if (video.srcObject !== media) video.srcObject = media;
    video.hidden = !media;
  }

  context.screenShare.whenChanged(update, { signal });
  signal.addEventListener("abort", () => { video.srcObject = null; }, { once: true });
  update();
  return el("div", { class: "quick-capture-preview", "aria-hidden": "true" }, video, nativePreview);
}

function renderQuickTopic(context, topic, channels, selectedId, target) {
  const channel = channels.find(item => item.type === "live");
  if (!channel) throw new Error(t("This temporary room has ended.", "Dieser temporäre Raum wurde beendet."));
  const stopCapture = () => {
    if (sameId(context.screenShare.active()?.room.id, topic.id)) context.screenShare.stop();
    if (sameId(context.nativeBroadcast?.active()?.channelId, channel.id)) context.nativeBroadcast.stop().catch(() => {});
  };
  const child = { ...context, room: topic, shareSource: sameId(channel.id, selectedId) ? target?.shareSource : undefined };
  const screenRoom = topic.quickSource === "screen";
  const screen = screenRoom ? createQuickScreen(child, channel) : null;
  const setup = screenRoom ? null : createWatchParty(child, channel, {
    setupOnly: true,
    onShareUnavailable: () => notify(t("Video sharing is unavailable in this room.", "Hier kannst du gerade kein Video teilen.")),
  });
  if (child.shareSource === "screen") screen?.prepare();
  else if (child.shareSource) setup?.prepareSource(child.shareSource);
  const actions = el("div", { class: "quick-view-actions" }, screen?.actions, setup?.share, quickRoomActions(context, topic, stopCapture));
  const node = renderGuestViewer({ publicId: topic.id, signal: context.signal, member: true, videoDock: context.videoDock,
    host: {
      actions, channelId: channel.id, href: topicHref(topic.id, channel.id), queue: setup?.queue,
      createPreview: screenRoom ? signal => renderQuickPreview(context, topic, channel, signal) : undefined,
      onUnavailable() {
        context.quickRoomHeader.ended(topic.id);
        location.hash = "#/rooms";
      },
    },
  });
  node.dataset.temporary = "true";
  context.player.setLocation(topic, channel, null);
  context.voice.setLocation(null);
  return { node, select(id, next) {
    if (!sameId(id, channel.id) || !next?.shareSource) return;
    if (next.shareSource === "screen") screen?.prepare();
    else setup?.prepareSource(next.shareSource);
  } };
}

export async function renderTopic(context, topicId, selectedId, target) {
  const { topic, channels: initialChannels = [], members = [] } = await api("topics/" + identifier(topicId), { signal: context.signal });
  context.signal.throwIfAborted();
  if (!topic) throw new Error(t("This room is unavailable.", "Dieser Raum ist nicht verfügbar."));
  if (topic.temporary) return renderQuickTopic(context, topic, initialChannels, selectedId, target);
  const owner = topic.role === "owner";
  const manager = owner || topic.role === "admin";
  const room = el("div", { class: "topic-view", "data-joined": topic.joined === true });
  applyTopicDesign(room, topic.appearance);
  const hero = el("div", { class: "panel room-hero section-heading", "data-tutorial": "room-hero" },
    el("div", { class: "room-title" },
      el("div", { class: "inline" }, el("a", { href: "#/rooms", class: "subtle" }, t("All rooms", "Alle Räume")), tag(topic)),
      el("h1", { title: topic.title }, topic.title)),
    topic.joined && el("div", { class: "inline room-actions" }, favoriteControl(topic, context),
      button(t("Members", "Mitglieder"), () => membersDialog(context, topic, members)),
      topic.canDesign && button("Design", () => editTopicDesign(context, topic, appearance => {
        topic.appearance = appearance;
        applyTopicDesign(room, appearance);
      }), { "aria-haspopup": "dialog", title: t("Edit room design", "Raumdesign bearbeiten") }),
      owner ? button([
        el("span", { class: "room-action-label" }, t("Settings", "Einstellungen")),
        el("span", { class: "room-action-icon", "aria-hidden": "true" }, "⚙"),
      ], () => topicSettings(context, topic, stopRoomCapture), { "aria-label": t("Settings", "Einstellungen"), title: t("Settings", "Einstellungen") })
        : button(t("Leave", "Verlassen"), () => leaveDialog(context, topic))));
  room.append(hero);
  if (!topic.joined) {
    context.voice.setLocation(null);
    context.player.setLocation(topic, null, null);
    room.append(joinPanel(context, topic));
    return { node: room, select() {} };
  }

  let channels = initialChannels;

  function stopRoomCapture() {
    if (sameId(context.screenShare.active()?.room.id, topic.id)) context.screenShare.stop();
    const nativeChannel = context.nativeBroadcast?.active()?.channelId;
    if (channels.some(channel => sameId(channel.id, nativeChannel))) context.nativeBroadcast.stop().catch(() => {});
  }

  const channelList = el("nav", { "aria-label": "Channels", class: "channel-list" });
  const picker = el("select", { class: "room-channel-picker", "aria-label": t("Switch channel", "Channel wechseln") });
  let links;
  function drawChannels() {
    links = channels.map(channel => el("a", {
      href: topicHref(topic.id, channel.id), class: "channel-link", "data-channel-id": channel.id,
    },
    el("span", { class: "channel-symbol", "aria-hidden": "true" }, channel.type === "live" ? "◉" : "#"),
    el("span", {}, channel.title), channel.type === "live" && el("span", { class: "sr-only" }, t("Live channel", "Live-Channel"))));
    channelList.replaceChildren(...links);
    picker.replaceChildren(...(channels.length ? channels.map(channel =>
      el("option", { value: channel.id }, (channel.type === "live" ? "◉ " : "# ") + channel.title)) :
      [el("option", {}, t("No channels", "Keine Channels"))]));
    picker.disabled = channels.length === 0;
  }
  drawChannels();
  picker.addEventListener("change", () => { location.hash = topicHref(topic.id, picker.value); });
  const activityToggle = button(t("Activity", "Aktivität"), () => showActivity(!layout.hasAttribute("data-activity-view")), {
    class: "room-activity-toggle", "aria-pressed": "false", "aria-controls": "room-activity", "data-tutorial": "room-activity",
  });
  const sidebar = el("aside", { class: "panel channel-sidebar", "data-tutorial": "channel-picker" },
    el("div", { class: "section-heading room-channel-tools" }, el("h2", {}, "Channels"),
      picker, activityToggle,
      manager && el("div", { class: "room-channel-manage" },
        button("+", () => channelDialog(context, topic), { "aria-label": t("Create channel", "Channel erstellen"), class: "icon-button", title: t("Create channel", "Channel erstellen") }),
        button("⋯", () => manageChannels(context, topic, channels, updateChannels), {
          "aria-label": t("Manage channels", "Channels verwalten"), "aria-haspopup": "dialog", class: "icon-button", title: t("Manage channels", "Channels verwalten"),
        }))),
    channelList);
  const content = el("div", { class: "channel-content" });
  const activity = el("aside", { class: "room-activity", id: "room-activity", "aria-label": t("Recent activity in this room", "Letzte Aktivität im Raum") }, renderActivity(context, topic));
  const supportSlot = el("div", { class: "live-support-slot", hidden: true });
  const sidebarColumn = el("div", { class: "room-sidebar-column" }, sidebar, supportSlot);
  const layout = el("div", { class: "room-layout" }, sidebarColumn, content, activity);
  activity.addEventListener("click", event => {
    if (layout.hasAttribute("data-activity-view") && event.target.closest(".activity-link")) {
      showActivity(false);
      if (event.detail === 0) activityToggle.focus({ preventScroll: true });
    }
  });
  let selected;
  let channelView;
  let channelNode;
  let livePlayerMount;
  let liveSupport;
  let liveSupportAnchor;
  const sidebarSpace = matchMedia("(width > 900px) and (height > 500px)");
  sidebarSpace.addEventListener("change", placeLiveSupport, { signal: context.signal });

  function placeLiveSupport() {
    if (!liveSupport || !liveSupportAnchor?.parentNode) return;
    const inSidebar = sidebarSpace.matches;
    const target = inSidebar ? supportSlot : liveSupportAnchor.parentNode;
    const before = inSidebar ? null : liveSupportAnchor.nextSibling;
    if (liveSupport.parentNode !== target) {
      if (target.isConnected && liveSupport.isConnected && target.moveBefore) target.moveBefore(liveSupport, before);
      else target.insertBefore(liveSupport, before);
    }
    supportSlot.hidden = !inSidebar;
    channelNode.toggleAttribute("data-support-sidebar", inSidebar);
    const playback = channelNode.querySelector(".live-channel-watch");
    const tab = channelNode.querySelector(".live-channel-switch button:first-child");
    if (tab && playback) {
      playback.id = "live-channel-playback";
      tab.textContent = inSidebar ? t("Player", "Player") : t("Voice & streams", "Sprache & Streams");
      tab.setAttribute("aria-controls", inSidebar ? playback.id : liveSupport.id);
    }
  }

  function updateChannels(nextChannels) {
    const previousIndex = channels.findIndex(channel => sameId(channel.id, selected?.id));
    const stillSelected = nextChannels.find(channel => sameId(channel.id, selected?.id));
    channels = nextChannels;
    drawChannels();
    if (stillSelected) {
      markSelected(stillSelected);
      return;
    }
    const fallback = channels[Math.min(Math.max(previousIndex, 0), channels.length - 1)];
    if (selected) history.replaceState(null, "", topicHref(topic.id, fallback?.id));
    select(fallback?.id);
  }

  function showActivity(visible) {
    layout.toggleAttribute("data-activity-view", visible);
    activityToggle.setAttribute("aria-pressed", String(visible));
    if (livePlayerMount) context.player.setLocation(topic, selected, visible ? null : livePlayerMount);
    context.videoDock?.refreshPlacement();
  }

  function markSelected(channel) {
    if (channel) picker.value = channel.id;
    for (const link of links) {
      if (sameId(link.dataset.channelId, channel?.id)) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }

  function select(requestedId, destination) {
    const channel = channels.find(candidate => sameId(candidate.id, requestedId)) ?? channels[0];
    const message = channel && sameId(channel.id, requestedId) ? destination : undefined;
    showActivity(false);
    if (channelView && (selected === channel || sameId(selected?.id, channel?.id))) {
      if (message?.messageId || message?.streamId || message?.watchId || message?.shareSource) {
        channelNode?.dispatchEvent(new CustomEvent("open-message", { detail: message }));
      }
      return;
    }
    channelView?.abort();
    supportSlot.replaceChildren();
    supportSlot.hidden = true;
    liveSupport = null;
    liveSupportAnchor = null;
    channelView = new AbortController();
    channelNode = null;
    livePlayerMount = null;
    selected = channel;
    markSelected(channel);
    layout.toggleAttribute("data-live-channel", channel?.type === "live");
    if (channel?.type !== "live") {
      context.player.setLocation(topic, channel, null);
      context.voice.setLocation(null);
    }
    if (!channel) {
      content.replaceChildren(el("section", { class: "panel stack" }, el("h2", {}, t("No channels", "Keine Channels")),
        el("p", { class: "muted" }, manager ? t("Create a chat or a live channel.", "Erstelle einen Chat oder einen Live-Channel.") : t("This room has no channels yet.", "In diesem Raum wurden noch keine Channels erstellt."))));
      return;
    }
    const childContext = { ...context, room: topic, signal: channelView.signal,
      messageId: message?.messageId, streamId: message?.streamId, watchId: message?.watchId, shareSource: message?.shareSource };
    const edit = manager ? button(t("Edit", "Bearbeiten"), () => channelDialog(childContext, topic, channel)) : null;
    if (channel.type === "live") {
      const voiceMount = el("div", { class: "voice-inline" });
      livePlayerMount = el("div", { class: "live-channel-player" });
      channelNode = renderLive(childContext, channel, edit, context.player, voiceMount, livePlayerMount);
      liveSupport = channelNode.querySelector(".live-channel-people");
      if (liveSupport) {
        liveSupportAnchor = document.createComment("Voice and streams position in compact layout");
        liveSupport.before(liveSupportAnchor);
        placeLiveSupport();
      }
      context.player.setLocation(topic, channel, livePlayerMount);
      content.replaceChildren(channelNode);
      context.player.refreshPlacement();
      context.videoDock?.refreshPlacement();
      context.voice.setLocation(channel, topic, voiceMount);
    } else {
      const moveDestinations = manager ? () => channels.filter(candidate =>
        candidate.type === "chat" && !sameId(candidate.id, channel.id)) : undefined;
      channelNode = renderChat({ ...childContext, moveDestinations }, channel, edit);
      content.replaceChildren(channelNode);
    }
  }
  context.signal.addEventListener("abort", () => channelView?.abort(), { once: true });
  room.append(layout);
  select(selectedId, target);
  return { node: room, select };
}
