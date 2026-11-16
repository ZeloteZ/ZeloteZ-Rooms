import { t } from "./i18n.js";
import { api, button, closeDialog, copyField, el, field, form, identifier, notify, showDialog, status, tell, topicHref } from "./ui.js";

const sources = [
  ["screen", "Share screen", "Bildschirm teilen", "Desktop, window, or browser tab", "Desktop, Fenster oder Browser-Tab"],
  ["youtube", "Share YouTube video", "YouTube-Video teilen", "Watch together with a YouTube link", "Gemeinsam über einen YouTube-Link schauen"],
  ["local", "Share local video", "Lokales Video teilen", "Watch an MP4 or WebM file together", "Gemeinsam eine MP4- oder WebM-Datei schauen"],
];
const passwords = new Map();
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;

export function quickSource(value) {
  return sources.find(([source]) => source === value)?.[0];
}

export function clearQuickLinks() {
  passwords.clear();
}

export function mountQuickRoomDock(dock, { signal, screenShare, nativeBroadcast }) {
  const name = el("span", { class: "quick-room-link-name" });
  const link = el("a", { class: "button quick-room-link" }, el("span", { "aria-hidden": "true" }, "▶"), name);
  dock.replaceChildren(link);
  let room;
  let revision = 0;
  let pending = false;
  let timer;

  function paint() {
    const channelId = room?.channelId;
    const hasCaptureLink = channelId && (screenShare.active()?.channel.id === channelId || nativeBroadcast?.active()?.channelId === channelId);
    dock.hidden = !room || Boolean(hasCaptureLink);
    if (!room) {
      link.removeAttribute("href");
      return;
    }
    link.href = topicHref(room.topicId, channelId);
    name.textContent = room.title;
    const label = t("Return to “{title}”", "Zurück zu „{title}“", { title: room.title });
    link.setAttribute("aria-label", label);
    link.title = label;
  }

  function setRoom(value) {
    room = value && uuid.test(value.topicId) && uuid.test(value.channelId) && quickSource(value.source) ? {
      topicId: value.topicId, channelId: value.channelId,
      title: value.title || t("Temporary room", "Temporärer Raum"),
    } : null;
    nativeBroadcast?.setTemporaryLocation(room);
    paint();
  }

  async function refresh() {
    if (pending || signal.aborted) return;
    clearTimeout(timer);
    pending = true;
    const requested = revision;
    try {
      const result = await api("quick-rooms", { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
      if (!signal.aborted && requested === revision) setRoom(result.room);
    } catch {
      // Keep the last known room during a brief connection interruption.
    } finally {
      pending = false;
      if (!signal.aborted) timer = setTimeout(refresh, room ? 6000 : 20000);
    }
  }

  function captureChanged() {
    paint();
    if (room && dock.hidden === false) void refresh();
  }

  screenShare.whenChanged(captureChanged, { signal });
  nativeBroadcast?.whenChanged(captureChanged, { signal });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); }, { signal });
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    dock.hidden = true;
    dock.replaceChildren();
  }, { once: true });
  void refresh();

  return {
    created(value) {
      if (signal.aborted) return;
      revision++;
      setRoom(value);
      void refresh();
    },
    ended(topicId) {
      if (signal.aborted || room?.topicId !== topicId) return;
      revision++;
      setRoom(null);
    },
  };
}

function rememberLink(user, room) {
  if (!uuid.test(room.publicId)) return;
  const key = user.id + ":" + room.publicId;
  if (!room.guestAccess) passwords.delete(key);
  else if (/^[A-Za-z0-9_-]{43}$/u.test(room.secret ?? "")) passwords.set(key, room.secret);
}

function guestUrl(user, id) {
  const password = passwords.get(user.id + ":" + id);
  if (!password || !uuid.test(id)) return "";
  const link = new URL("/guest/" + id, location.origin);
  link.hash = new URLSearchParams({ password }).toString();
  return link.href;
}

function sharingOption(control, title, description) {
  return el("label", { class: "quick-option" }, control,
    el("span", {}, el("strong", {}, title), el("small", { class: "muted" }, description)));
}

function audienceFields(settings = {}) {
  const guest = el("input", { type: "checkbox", checked: settings.guestAccess === true });
  const members = el("input", { type: "checkbox", checked: settings.memberVisibility === true });
  return {
    node: el("div", { class: "quick-options" },
      sharingOption(guest, t("Allow guests with the link", "Gäste mit Link zulassen"),
        t("A password in the link gives guests access to the stream and live chat.", "Das Passwort im Link gibt Gästen Zugriff auf den Stream und Livechat.")),
      sharingOption(members, t("Show in Live Now for members", "Mitgliedern unter „Gerade live“ anzeigen"),
        t("Signed-in members can open this room without a password.", "Angemeldete Mitglieder können diesen Raum ohne Passwort öffnen."))),
    values: () => ({ guestAccess: guest.checked, memberVisibility: members.checked }),
  };
}

export function openStreamNow(context) {
  const heading = t("Stream Now", "Jetzt streamen");
  const destinationHeading = t("Where do you want to stream?", "Wo möchtest du streamen?");

  function showSources() {
    showDialog(heading, el("div", { class: "quick-sources" }, sources.map(([source, en, de, infoEn, infoDe]) =>
      button([el("strong", {}, t(en, de)), el("small", {}, t(infoEn, infoDe))], () => showDestination(source), { class: "quick-choice" }))));
  }

  function go(topicId, channelId, source) {
    closeDialog();
    location.hash = topicHref(topicId, channelId, { shareSource: source });
  }

  function showDestination(source) {
    const content = el("div", { class: "stack quick-destination-content" });
    const temporary = button(t("Temporary room", "Temporärer Raum"), showTemporary, { "aria-pressed": "true" });
    const existing = button(t("Existing live channel", "Vorhandener Live-Kanal"), showExisting, { "aria-pressed": "false" });
    let available;

    function paint(active) {
      temporary.setAttribute("aria-pressed", String(active === "temporary"));
      existing.setAttribute("aria-pressed", String(active === "existing"));
    }

    function showTemporary() {
      paint("temporary");
      const title = el("input", { maxlength: 72, autocomplete: "off" });
      const audience = audienceFields();
      content.replaceChildren(form([
        field(t("Title (optional)", "Titel (optional)"), title), audience.node,
        el("p", { class: "muted subtle" }, t("The room closes when the stream or watch party ends.", "Der Raum schließt sich, wenn der Stream oder die Watchparty endet.")),
      ], t("Continue", "Weiter"), async (_feedback, currentForm) => {
        const name = title.value.trim();
        const room = await api("quick-rooms", {
          method: "POST", body: { source, ...(name && { title: name }), ...audience.values() }, signal: context.signal,
        });
        if (context.signal.aborted) return;
        if (!currentForm.isConnected) {
          await api("quick-rooms/" + identifier(room.publicId), { method: "DELETE", signal: context.signal });
          return;
        }
        rememberLink(context.user, room);
        context.quickRoomHeader.created(room);
        go(room.topicId, room.channelId, source);
      }));
    }

    async function showExisting() {
      paint("existing");
      const loading = status(t("Loading live channels…", "Live-Kanäle werden geladen …"));
      content.replaceChildren(loading);
      try {
        available ??= (await api("quick-rooms/destinations", { signal: context.signal })).channels;
        if (!loading.isConnected || context.signal.aborted) return;
        if (!available.length) {
          tell(loading, t("You don’t have a live channel where you can stream yet.", "Du hast noch keinen Live-Kanal, in dem du streamen darfst."));
          return;
        }
        const select = el("select", { required: true }, available.map((item, index) =>
          el("option", { value: index }, item.topicTitle + " · " + item.channelTitle)));
        content.replaceChildren(form([field(t("Live channel", "Live-Kanal"), select)], t("Continue", "Weiter"), async () => {
          const item = available[select.value];
          if (item) go(item.topicId, item.channelId, source);
        }));
      } catch (error) {
        if (!context.signal.aborted && loading.isConnected) tell(loading, error.message, "error");
      }
    }

    showTemporary();
    showDialog(destinationHeading, el("div", { class: "stack" },
      el("div", { class: "quick-destinations", role: "group", "aria-label": destinationHeading }, temporary, existing),
      content, el("div", { class: "inline" }, button(t("Back", "Zurück"), showSources, { class: "ghost" }))));
  }

  showSources();
}

export function quickRoomActions(context, room, stopCapture) {
  const endpoint = "quick-rooms/" + identifier(room.id);
  const settingsTitle = t("Stream access", "Stream-Zugriff");
  const endTitle = t("End temporary room", "Temporären Raum beenden");

  function openSettings() {
    const loading = status(t("Loading stream access…", "Stream-Zugriff wird geladen …"));
    showDialog(settingsTitle, loading);
    void api(endpoint, { signal: context.signal }).then(settings => {
      if (loading.isConnected && !context.signal.aborted) drawSettings(settings);
    }).catch(error => {
      if (!context.signal.aborted) tell(loading, error.message, "error");
    });
  }

  function drawSettings(settings) {
    rememberLink(context.user, settings);
    const audience = audienceFields(settings);
    const link = settings.guestAccess ? guestUrl(context.user, room.id) : "";
    const note = status();
    const linkField = link && el("input", { type: "text", readonly: true, value: link, spellcheck: "false", autocomplete: "off" });
    const renew = button(t("Create new guest link", "Neuen Gastlink erstellen"), async () => {
      renew.disabled = true;
      try {
        const updated = await api(endpoint, { method: "PATCH", body: { renewPassword: true }, signal: context.signal });
        if (!context.signal.aborted && renew.isConnected) drawSettings(updated);
      } catch (error) {
        if (!context.signal.aborted) tell(note, error.message, "error");
      } finally { renew.disabled = false; }
    });
    const linkPanel = settings.guestAccess && el("div", { class: "quick-guest-link stack" },
      linkField && field(t("Guest link", "Gastlink"), linkField),
      el("div", { class: "inline" }, linkField && button(t("Copy guest link", "Gastlink kopieren"), () => copyField(linkField), { class: "primary" }), renew),
      el("p", { class: "muted subtle" }, t("Creating a new link revokes the old link and its guest access.", "Ein neuer Link widerruft den bisherigen Link und dessen Gastzugriff.")), note);
    showDialog(settingsTitle, el("div", { class: "stack" },
      linkPanel,
      form([audience.node], t("Save access settings", "Zugriff speichern"), async (_feedback, currentForm) => {
        const updated = await api(endpoint, { method: "PATCH", body: audience.values(), signal: context.signal });
        if (context.signal.aborted || !currentForm.isConnected) return;
        drawSettings(updated);
        notify(t("Access settings saved.", "Zugriff gespeichert."));
      })));
  }

  function confirmEnd() {
    showDialog(endTitle, form([
      el("p", {}, t("This ends the live session and closes the viewer link.", "Das beendet die Übertragung und schließt den Zuschauerlink.")),
    ], endTitle, async () => {
      await api(endpoint, { method: "DELETE", signal: context.signal });
      if (context.signal.aborted) return;
      passwords.delete(context.user.id + ":" + room.id);
      context.quickRoomHeader.ended(room.id);
      stopCapture();
      closeDialog();
      location.hash = "#/rooms";
    }));
  }

  return el("div", { class: "inline room-actions" },
    button(settingsTitle, openSettings, { "aria-haspopup": "dialog" }),
    button(endTitle, confirmEnd, { class: "danger", "aria-haspopup": "dialog" }));
}
