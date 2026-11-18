import { locale, t } from "./i18n.js";
import { api, button, el, field, identifier, select, status, tell, topicHref } from "./ui.js";
import { VAULT_EDITOR_LIMITS, vaultFileKind } from "./vault-media-edit.js";
import { startVaultWatch } from "./vault-watch.js";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;

export function canShareVaultPlayback(entry, user) {
  const size = entry?.descriptor?.size ?? entry?.plainBytes ?? entry?.size;
  return !!user?.id && entry?.ownerId === user.id && !entry.receivedShareId && !entry.locked && entry.kind === "file" && entry.state === "ready"
    && Number.isSafeInteger(size) && size >= 0 && size <= VAULT_EDITOR_LIMITS.inputBytes && ["audio", "video"].includes(vaultFileKind(entry));
}

export async function loadVaultPlaybackRooms({ signal, request = api } = {}) {
  const rooms = new Map();
  const seen = new Set();
  let before = null;
  for (let page = 0; page < 20; page++) {
    signal?.throwIfAborted();
    const data = await request(before === null ? "topics" : "topics?before=" + encodeURIComponent(before), { signal });
    signal?.throwIfAborted();
    if (!Array.isArray(data?.topics)) throw new Error(t("Rooms could not be loaded.", "Die Räume konnten nicht geladen werden."));
    for (const room of data.topics) {
      if (room?.joined === true && !room.temporary && uuid.test(room.id ?? "") && typeof room.title === "string") rooms.set(room.id, room);
    }
    if (!data.next) return [...rooms.values()].sort((a, b) => a.title.localeCompare(b.title, locale(), { numeric: true }));
    if (typeof data.next !== "string" || data.next.length > 256 || seen.has(data.next)) break;
    seen.add(data.next); before = data.next;
  }
  throw new Error(t("The room list could not be completed. Try again.", "Die Raumliste konnte nicht vollständig geladen werden. Versuche es erneut."));
}

export async function openVaultRoomShare({ entry, client, user, signal, onShared, onSharedCallback } = {}) {
  signal?.throwIfAborted();
  if (!canShareVaultPlayback(entry, user)) throw new Error(t(
    "Only media in your own Vault can be played in a room. Save your own copy first.",
    "Nur Medien in deinem eigenen Vault können in einem Raum abgespielt werden. Speichere zuerst eine eigene Kopie."));
  const scope = new AbortController();
  const lifetime = signal ? AbortSignal.any([signal, scope.signal]) : scope.signal;
  const roomChoice = select([["", t("Choose a room", "Raum auswählen")]], "");
  const channelChoice = select([["", t("Choose a live channel", "Live-Kanal auswählen")]], "");
  roomChoice.disabled = channelChoice.disabled = true;
  const feedback = status(t("Loading rooms…", "Räume werden geladen …"));
  const stateNote = status();
  const action = button(t("Play together here", "Hier gemeinsam abspielen"), () => void start(), { class: "primary", disabled: true });
  const result = el("div", { class: "stack vault-room-share-result", hidden: true });
  const close = button("×", () => dialog.close(), { class: "ghost icon-button", "aria-label": t("Close", "Schließen") });
  const dialog = el("dialog", { class: "dialog vault-room-share-dialog", "aria-labelledby": "vault-room-share-heading" },
    el("div", { class: "dialog-body" },
      el("header", { class: "section-heading" }, el("h2", { id: "vault-room-share-heading" }, t("Play in a room", "In einem Raum abspielen")), close),
      el("p", { class: "vault-room-share-file" }, entry.name || t("Encrypted file", "Verschlüsselte Datei")),
      el("p", { class: "muted" }, t(
        "This creates a revocable encrypted share for 24 hours. Current room members can decrypt and play the file. The original stays in your Vault.",
        "Dabei entsteht eine widerrufbare verschlüsselte Freigabe für 24 Stunden. Aktuelle Raummitglieder können die Datei entschlüsseln und abspielen. Das Original bleibt in deinem Vault.")),
      el("p", { class: "subtle" }, t("Room playback supports Vault files up to 128 MiB.", "Die Raumwiedergabe unterstützt Vault-Dateien bis 128 MiB.")),
      el("div", { class: "stack vault-room-share-fields" }, field(t("Room", "Raum"), roomChoice),
        field(t("Live channel", "Live-Kanal"), channelChoice), stateNote, action),
      feedback, result));
  let rooms = [];
  let channels = [];
  let snapshot = null;
  let selection = 0;
  let busy = false;
  let done = false;
  const current = () => !lifetime.aborted && dialog.isConnected;

  function cleanup() {
    scope.abort(); signal?.removeEventListener("abort", leave); dialog.remove();
  }
  function leave() { if (dialog.open) dialog.close(); else cleanup(); }
  dialog.addEventListener("close", cleanup, { once: true });
  signal?.addEventListener("abort", leave, { once: true });
  document.body.append(dialog); dialog.showModal();

  function paintState() {
    const canShare = snapshot?.canShare === true;
    const party = snapshot?.party;
    action.disabled = busy || done || !canShare || !!party && party.state !== "ready";
    action.textContent = party ? t("Add to queue", "Zur Warteschlange hinzufügen") : t("Play together here", "Hier gemeinsam abspielen");
    if (!canShare) tell(stateNote, snapshot ? t("You cannot start playback in this channel.", "Du darfst in diesem Kanal keine Wiedergabe starten.") : "");
    else if (party) tell(stateNote, party.state === "ready" ? t(
      "A watch party is already active. Your file will be added to its queue.",
      "Eine Watchparty ist bereits aktiv. Deine Datei wird ihrer Warteschlange hinzugefügt.") : t(
      "A watch party is being prepared. Choose another channel or try again later.",
      "Eine Watchparty wird gerade vorbereitet. Wähle einen anderen Kanal oder versuche es später erneut."));
    else tell(stateNote, t("Your file will start a new synchronized watch party.", "Deine Datei startet eine neue synchronisierte Watchparty."));
  }

  async function readChannel() {
    const generation = ++selection;
    snapshot = null; paintState();
    const channel = channels.find(value => value.id === channelChoice.value);
    if (!channel) { tell(feedback, ""); return; }
    tell(feedback, t("Checking playback permissions…", "Wiedergabeberechtigung wird geprüft …"));
    try {
      const data = await api("channels/" + identifier(channel.id) + "/watch", { signal: lifetime });
      if (!current() || generation !== selection) return;
      snapshot = data; tell(feedback, ""); paintState();
    } catch (error) { if (current() && generation === selection) tell(feedback, error.message, "error"); }
  }

  async function readRoom() {
    const generation = ++selection;
    snapshot = null; channels = []; paintState();
    channelChoice.replaceChildren(el("option", { value: "" }, t("Choose a live channel", "Live-Kanal auswählen")));
    channelChoice.disabled = true;
    const room = rooms.find(value => value.id === roomChoice.value);
    if (!room) { tell(feedback, ""); return; }
    tell(feedback, t("Loading live channels…", "Live-Kanäle werden geladen …"));
    try {
      const data = await api("topics/" + identifier(room.id), { signal: lifetime });
      if (!current() || generation !== selection) return;
      if (data.topic?.id !== room.id || data.topic.joined !== true || data.topic.temporary) throw new Error(t("This room is unavailable.", "Dieser Raum ist nicht verfügbar."));
      channels = Array.isArray(data.channels) ? data.channels.filter(value => value?.type === "live" && uuid.test(value.id ?? "") && typeof value.title === "string") : [];
      channelChoice.append(...channels.map(value => el("option", { value: value.id }, value.title)));
      channelChoice.disabled = !channels.length;
      tell(feedback, channels.length ? "" : t("This room has no live channels.", "Dieser Raum hat keine Live-Kanäle."));
    } catch (error) { if (current() && generation === selection) tell(feedback, error.message, "error"); }
  }

  async function start() {
    if (!current() || busy || done || action.disabled) return;
    const room = rooms.find(value => value.id === roomChoice.value);
    const channel = channels.find(value => value.id === channelChoice.value);
    if (!room || !channel || !snapshot?.canShare) return;
    const expectedParty = snapshot.party?.id ?? null;
    busy = true; roomChoice.disabled = channelChoice.disabled = true; paintState(); tell(feedback, "");
    try {
      const fresh = await api("channels/" + identifier(channel.id) + "/watch", { signal: lifetime });
      lifetime.throwIfAborted();
      if (fresh?.canShare !== true) throw new Error(t("You cannot start playback in this channel.", "Du darfst in diesem Kanal keine Wiedergabe starten."));
      if ((fresh.party?.id ?? null) !== expectedParty || fresh.party && fresh.party.state !== "ready") {
        snapshot = fresh;
        throw new Error(t("Playback changed in this channel. Review the action and confirm again.", "Die Wiedergabe in diesem Kanal hat sich geändert. Prüfe die Aktion und bestätige erneut."));
      }
      tell(feedback, t("Creating encrypted room playback…", "Verschlüsselte Raumwiedergabe wird erstellt …"));
      const data = await startVaultWatch({ entry, client, user, channelId: channel.id, signal: lifetime,
        ...(expectedParty ? { enqueueBehind: expectedParty } : {}) });
      lifetime.throwIfAborted();
      const party = data.party ?? data;
      const watchId = party.sessionId ?? party.id;
      if (!uuid.test(watchId ?? "")) throw new Error(t("The room could not confirm playback.", "Der Raum konnte die Wiedergabe nicht bestätigen."));
      done = true;
      const link = el("a", { class: "button primary", href: topicHref(room.id, channel.id, { watchId }) }, t("Go to room", "Zum Raum wechseln"));
      link.addEventListener("click", () => dialog.close());
      result.replaceChildren(status(expectedParty ? t("Added to the room’s queue.", "Zur Warteschlange des Raums hinzugefügt.")
        : t("Encrypted watch party ready.", "Verschlüsselte Watchparty ist bereit.")), link,
        el("p", { class: "subtle" }, t("Ending playback does not revoke the share. Revoke it in Vault when needed; otherwise it expires after 24 hours.",
          "Das Beenden der Wiedergabe widerruft die Freigabe nicht. Widerrufe sie bei Bedarf im Vault; sonst läuft sie nach 24 Stunden ab.")));
      result.hidden = false; tell(feedback, "");
      action.hidden = true;
      await (onShared ?? onSharedCallback)?.({ topic: room, channel, party, queued: !!expectedParty });
    } catch (error) { if (current() && error?.name !== "AbortError") tell(feedback, error.message, "error"); }
    finally { if (current()) { busy = false; roomChoice.disabled = channelChoice.disabled = done; paintState(); } }
  }

  roomChoice.addEventListener("change", () => void readRoom());
  channelChoice.addEventListener("change", () => void readChannel());
  try {
    rooms = await loadVaultPlaybackRooms({ signal: lifetime });
    if (current()) {
      roomChoice.append(...rooms.map(room => el("option", { value: room.id }, room.title)));
      roomChoice.disabled = !rooms.length;
      tell(feedback, rooms.length ? "" : t("Join a room with a live channel to play this file together.", "Tritt einem Raum mit Live-Kanal bei, um diese Datei gemeinsam abzuspielen."));
    }
  } catch (error) { if (current() && error?.name !== "AbortError") tell(feedback, error.message, "error"); }
  return { dialog, close: leave };
}
