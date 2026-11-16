import { t } from "./i18n.js";
import { button, el } from "./ui.js";

function step(selector, title, titleDe, description, descriptionDe) {
  return { selector, title: t(title, titleDe), description: t(description, descriptionDe) };
}

const pages = {
  home: [
    step(".home-heading h1", "Your rooms", "Deine Räume",
      "Open a room from new rooms, your favorites, or your recent visits.", "Öffne einen Raum aus den neuen Räumen, deinen Favoriten oder den zuletzt besuchten Räumen."),
    step(".home-heading .primary", "Create a room", "Raum erstellen",
      "Choose whether everyone in your group can join or whether access is by invitation.", "Wähle, ob alle in deinem Freundeskreis beitreten können oder eine Einladung brauchen."),
    step(".home-activity-panel h2, .home-tabs button:last-child", "See what’s happening", "Sieh, was gerade los ist",
      "Activity shows recent messages, active voice chats, and live streams you can access.", "Unter Aktivität findest du neue Nachrichten, laufende Sprachchats und Streams, auf die du Zugriff hast."),
  ],
  join: [
    step('[data-tutorial="room-hero"] h1', "Inside a room", "In einem Raum",
      "A room groups channels around a shared interest. Join it before opening its channels.", "Ein Raum bündelt Channels zu einem gemeinsamen Thema. Tritt dem Raum bei, um seine Channels zu öffnen."),
    step(":scope:not([data-joined]) > section h2", "Join the room", "Dem Raum beitreten",
      "Join here when you have access. If you need an invitation, ask the room owner.", "Wenn du Zugriff hast, kannst du hier beitreten. Falls du eine Einladung brauchst, frag den Raumersteller."),
  ],
  room: [
    step('[data-tutorial="room-hero"] h1', "Inside a room", "In einem Raum",
      "Room details, members, and settings are in the header.", "In der Kopfzeile findest du Raumdetails, Mitglieder und Einstellungen."),
    step('[data-tutorial="channel-picker"]', "Choose a channel", "Channel auswählen",
      "Text channels hold conversations. Live channels bring together voice chats, streams, and stream chat.", "In Textchannels schreibst du Nachrichten. Live-Channels vereinen Sprachchat, Streams und Streamchat."),
    step('[data-tutorial="room-activity"]', "Find recent activity", "Aktivität finden",
      "Open Activity to jump to recent posts in this room.", "Öffne die Aktivität, um zu den neuesten Beiträgen in diesem Raum zu springen."),
  ],
  chat: [
    step(".conversation-heading .tag", "Private conversations", "Private Unterhaltungen",
      "Your browser encrypts chat messages and attachments before they are sent. Room members with access can read them.", "Dein Browser verschlüsselt Nachrichten und Anhänge vor dem Senden. Mitglieder mit Zugriff können sie lesen."),
    step(".message-form textarea", "Write and mention", "Schreiben und erwähnen",
      "Type @ to find a person, room, or channel. A personal mention appears in the recipient’s notifications.", "Tippe @, um Personen, Räume oder Channels zu finden. Eine persönliche Erwähnung erscheint in den Benachrichtigungen der Person."),
    step(".composer-attach", "Share an attachment", "Anhänge teilen",
      "Use the paperclip to choose a file. Add a link by pasting it into your message.", "Über die Büroklammer wählst du eine Datei aus. Links fügst du direkt in deine Nachricht ein."),
  ],
  live: [
    step('[data-tutorial="live-people"]', "Watch or listen", "Zuschauen oder zuhören",
      "Select an active stream or choose Join voice chat. Your microphone starts off.", "Wähle einen aktiven Stream oder tritt dem Sprachchat bei. Dein Mikrofon bleibt zunächst aus."),
    step('[data-tutorial="live-share"], .live-channel-toolbar h2', "Share your screen", "Bildschirm teilen",
      "If you can broadcast here, use Share screen to choose a screen, window, or tab. Audio options depend on your browser or desktop app.", "Wenn du hier streamen darfst, wählst du über „Bildschirm teilen“ einen Bildschirm, ein Fenster oder einen Tab. Die Tonoptionen hängen von deinem Browser oder deiner Desktop-App ab."),
    step('[data-tutorial="live-chat"] h2, [aria-controls="live-channel-chat"]', "Write in the stream chat", "Im Streamchat schreiben",
      "Select a live stream to open its chat. Voice and playback controls follow you in the header as you browse.", "Wähle einen Livestream, um seinen Chat zu öffnen. Sprachchat und Wiedergabesteuerung bleiben beim Navigieren im Header erreichbar."),
  ],
  friends: [
    step(".friend-search h2, .friend-views label:nth-of-type(3)", "Find someone", "Personen finden",
      "Search for a name or username and send a friend request.", "Suche nach einem Namen oder Benutzernamen und sende eine Freundschaftsanfrage."),
    step(".friend-requests h2, .friend-views label:nth-of-type(2)", "Manage requests", "Anfragen verwalten",
      "Accept or decline incoming requests here. Confirmed friends can be invited into your private rooms.", "Hier nimmst du Anfragen an oder lehnst sie ab. Bestätigte Freunde kannst du in deine privaten Räume einladen."),
  ],
  direct: [
    step(".direct-heading .primary", "Start a private conversation", "Eine private Unterhaltung beginnen",
      "Choose a friend here or use Message on your friends page. Only the two of you receive the keys to open the chat.",
      "Wähle hier einen Freund oder nutze „Nachricht“ auf der Freundeseite. Nur ihr beide bekommt die Schlüssel für den Chat."),
  ],
  invites: [
    step(".invite-create select", "Create a link", "Link erstellen",
      "Set how long the invite is valid. Each link lets one person create an account.", "Wähle, wie lange die Einladung gültig ist. Mit jedem Link kann eine Person ein Konto erstellen."),
    step(".invite-list h2", "Manage links", "Links verwalten",
      "Check which invites have been used and revoke any active link you no longer need.", "Sieh nach, welche Einladungen verwendet wurden, und widerrufe aktive Links, die du nicht mehr brauchst."),
  ],
  help: [
    step(".help-header select", "Find an explanation", "Eine Erklärung finden",
      "Choose what you want to read about, from chat encryption and history to voice and screen sharing.", "Wähle ein Thema aus, von Chatverschlüsselung und Verlauf bis zu Sprachchat und Bildschirmfreigabe."),
  ],
  profile: [
    step(".appearance-profile-preview", "Make it yours", "Dein Profil gestalten",
      "Choose a profile picture and name color. Save your changes to apply them.", "Wähle ein Profilbild und eine Namensfarbe. Speichere deine Änderungen, um sie zu übernehmen."),
    step('[data-tutorial="reset"]', "See the tutorials again", "Rundgänge wieder anzeigen",
      "Reset tutorials to see these guides again on this device.", "Setze die Rundgänge zurück, um sie auf diesem Gerät erneut zu sehen."),
  ],
};

function readCompleted(key) {
  try {
    const stored = JSON.parse(localStorage.getItem(key));
    return Array.isArray(stored) ? stored.filter(page => Object.hasOwn(pages, page)) : [];
  } catch {
    return [];
  }
}

function targetIn(scope, selector) {
  for (const choice of selector.split(", ")) {
    for (const target of scope.querySelectorAll(choice)) {
      if (target.getClientRects().length && getComputedStyle(target).visibility === "visible") return target;
    }
  }
  return null;
}

function visibleBounds(target, viewport) {
  const rect = target.getBoundingClientRect();
  let left = Math.max(rect.left - 4, viewport.left + 2);
  let top = Math.max(rect.top - 4, viewport.top + 2);
  let right = Math.min(rect.right + 4, viewport.right - 2);
  let bottom = Math.min(rect.bottom + 4, viewport.bottom - 2);
  for (let parent = target.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const css = getComputedStyle(parent);
    const clips = value => ["hidden", "clip", "scroll", "auto"].includes(value);
    if (!clips(css.overflowX) && !clips(css.overflowY)) continue;
    const bounds = parent.getBoundingClientRect();
    if (clips(css.overflowX)) {
      left = Math.max(left, bounds.left);
      right = Math.min(right, bounds.right);
    }
    if (clips(css.overflowY)) {
      top = Math.max(top, bounds.top);
      bottom = Math.min(bottom, bounds.bottom);
    }
  }
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

export function createTutorials(accountId, signal) {
  const storageKey = "zelotez-rooms-tutorials:" + accountId;
  const completed = new Set(readCompleted(storageKey));
  const spotlight = el("div", { class: "tutorial-spotlight", "aria-hidden": "true", hidden: true });
  const heading = el("h2", { id: "tutorial-title", tabindex: "-1" });
  const text = el("p", { id: "tutorial-text" });
  const count = el("p", { class: "tutorial-count" });
  const skip = button(t("Skip", "Überspringen"), finish, { class: "ghost" });
  const previous = button(t("Back", "Zurück"), () => move(-1));
  const next = button("", () => move(1), { class: "primary" });
  const card = el("section", { class: "tutorial-card" }, count, heading, text,
    el("div", { class: "tutorial-actions" }, skip, previous, next));
  const dialog = el("dialog", { class: "tutorial-overlay", "aria-labelledby": heading.id, "aria-describedby": text.id }, spotlight, card);
  document.body.append(dialog);
  let page;
  let profile;
  let guide;
  let frame;

  const resize = new ResizeObserver(schedule);
  const mutation = new MutationObserver(schedule);
  resize.observe(card);

  function writeCompleted() {
    try { localStorage.setItem(storageKey, JSON.stringify([...completed])); } catch { /* Storage may be blocked. */ }
  }

  function finish() {
    if (!guide) return;
    for (const page of readCompleted(storageKey)) completed.add(page);
    completed.add(guide.key);
    writeCompleted();
    close();
  }

  function close() {
    guide = null;
    mutation.disconnect();
    if (dialog.open) dialog.close();
  }

  function layout() {
    if (!guide || !dialog.open) return;
    const visible = window.visualViewport;
    const left = visible?.offsetLeft ?? 0;
    const top = visible?.offsetTop ?? 0;
    const width = visible?.width ?? window.innerWidth;
    const height = visible?.height ?? window.innerHeight;
    const viewport = { left, top, right: left + width, bottom: top + height };
    const margin = 12;
    card.style.maxWidth = Math.max(0, width - margin * 2) + "px";
    card.style.maxHeight = Math.max(0, height - margin * 2) + "px";
    const target = targetIn(guide.scope, guide.steps[guide.index].selector);
    const rect = target && visibleBounds(target, viewport);
    spotlight.hidden = !rect;
    if (rect) {
      spotlight.style.left = rect.left + "px";
      spotlight.style.top = rect.top + "px";
      spotlight.style.width = rect.right - rect.left + "px";
      spotlight.style.height = rect.bottom - rect.top + "px";
    }
    const { offsetWidth: cardWidth, offsetHeight: cardHeight } = card;
    const gap = 12;
    let x = left + (width - cardWidth) / 2;
    let y = top + (height - cardHeight) / 2;
    if (rect) {
      x = (rect.left + rect.right - cardWidth) / 2;
      if (rect.bottom + gap + cardHeight <= viewport.bottom - margin) y = rect.bottom + gap;
      else if (rect.top - gap - cardHeight >= top + margin) y = rect.top - gap - cardHeight;
      else if (rect.right + gap + cardWidth <= viewport.right - margin) x = rect.right + gap;
      else if (rect.left - gap - cardWidth >= left + margin) x = rect.left - gap - cardWidth;
      else y = viewport.bottom - cardHeight - margin;
    }
    card.style.left = clamp(x, left + margin, viewport.right - cardWidth - margin) + "px";
    card.style.top = clamp(y, top + margin, viewport.bottom - cardHeight - margin) + "px";
  }

  function schedule() {
    if (!guide || frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      layout();
    });
  }

  function paint() {
    const { steps, index, scope } = guide;
    const current = steps[index];
    heading.textContent = current.title;
    text.textContent = current.description;
    count.textContent = t("Step {step} of {total}", "Schritt {step} von {total}", { step: index + 1, total: steps.length });
    previous.disabled = index === 0;
    next.textContent = index + 1 === steps.length ? t("Done", "Fertig") : t("Next", "Weiter");
    card.scrollTop = 0;
    targetIn(scope, current.selector)?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    if (!dialog.open) dialog.showModal();
    layout();
    heading.focus({ preventScroll: true });
  }

  function move(direction) {
    if (!guide) return;
    const index = guide.index + direction;
    if (index >= guide.steps.length) finish();
    else if (index >= 0) {
      guide.index = index;
      paint();
    }
  }

  function refresh() {
    if (signal.aborted) return;
    const openProfile = profile?.isConnected && profile.closest("dialog")?.open;
    const requested = openProfile ? { key: "profile", scope: profile } : page;
    if (guide?.key === requested?.key && guide) {
      if (guide.scope !== requested.scope) {
        guide.scope = requested.scope;
        watch(requested.scope);
      }
      schedule();
      return;
    }
    close();
    if (!requested || completed.has(requested.key) || !requested.scope.isConnected) return;
    if (!openProfile && document.querySelector("dialog[open]")) return;
    const steps = pages[requested.key].filter(step => targetIn(requested.scope, step.selector));
    if (!steps.length) return;
    guide = { ...requested, steps, index: 0 };
    watch(requested.scope);
    paint();
  }

  function watch(scope) {
    mutation.disconnect();
    mutation.observe(scope, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class", "open"] });
  }

  dialog.addEventListener("cancel", event => {
    event.preventDefault();
    finish();
  }, { signal });
  dialog.addEventListener("keydown", event => {
    if (event.key === "Escape") finish();
    else if (event.key === "ArrowLeft") move(-1);
    else if (event.key === "ArrowRight") move(1);
    else return;
    event.preventDefault();
    event.stopPropagation();
  }, { signal });
  document.addEventListener("close", event => {
    if (event.target !== dialog) refresh();
  }, { capture: true, signal });
  document.addEventListener("scroll", schedule, { capture: true, passive: true, signal });
  window.addEventListener("resize", schedule, { signal });
  window.visualViewport?.addEventListener("resize", schedule, { signal });
  window.visualViewport?.addEventListener("scroll", schedule, { signal });
  signal.addEventListener("abort", () => {
    close();
    resize.disconnect();
    cancelAnimationFrame(frame);
    dialog.remove();
  }, { once: true });

  return {
    visit(key, scope) {
      page = Object.hasOwn(pages, key) ? { key, scope } : null;
      refresh();
    },
    leave() {
      page = null;
      profile = null;
      close();
    },
    openProfile(scope) {
      profile = scope;
      refresh();
    },
    reset() {
      completed.clear();
      writeCompleted();
      profile = null;
      close();
      refresh();
    },
  };
}
