import { language, t } from "./i18n.js";
import { guestPassword, guestRoomId, guestSource, openGuestMedia } from "./guest-media.js";
import { renderQuickChat } from "./quick-chat.js";
import { watchQueue } from "./watch-queue.js";
import { createWatchControls } from "./watch-controls.js";
import { createWatchViewerLease, reportWatchViewer } from "./watch-viewers.js";

const messages = {
  opening: ["Opening the live room…", "Live-Raum wird geöffnet …"],
  checking: ["Checking the password…", "Passwort wird geprüft …"],
  required: ["Enter the password from your invitation.", "Gib das Passwort aus deiner Einladung ein."],
  invalid: ["The password is incorrect. Check the invitation link or enter the password again.",
    "Das Passwort ist falsch. Prüfe den Einladungslink oder gib das Passwort erneut ein."],
  limited: ["Too many attempts. Try again in a moment.", "Zu viele Versuche. Versuche es in Kürze erneut."],
  unavailable: ["This live room is unavailable. It may have ended or the link may have expired.",
    "Dieser Live-Raum ist nicht verfügbar. Er wurde möglicherweise beendet oder der Link ist abgelaufen."],
  waiting: ["The host hasn’t started sharing yet.", "Die Freigabe hat noch nicht begonnen."],
  loading: ["Loading playback…", "Wiedergabe wird geladen …"],
  reconnecting: ["Connection interrupted. Reconnecting…", "Verbindung unterbrochen. Erneuter Verbindungsversuch …"],
  gesture: ["Enable playback to start watching on this device.",
    "Erlaube die Wiedergabe, um auf diesem Gerät zuzuschauen."],
  playbackError: ["The video couldn’t be played.", "Das Video konnte nicht wiedergegeben werden."],
  conflict: ["Someone else changed playback. The player is catching up.",
    "Jemand hat die Wiedergabe geändert. Der Player gleicht sich ab."],
  commandError: ["The playback change couldn’t be sent. Try again.", "Die Steuerung konnte nicht übertragen werden. Versuche es erneut."],
  visibleRequired: ["Open the video player to start playback.", "Öffne den Videoplayer, um die Wiedergabe zu starten."],
};

function copy(key) {
  const message = messages[key];
  return message ? t(...message) : "";
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

let supportId = 0;

export function renderGuestViewer(options) {
  const { publicId, videoDock, signal, member, host, onRoom } = options;
  if (!member || !videoDock) return createGuestViewer(options).viewer;
  const entry = videoDock.get("temporary:" + publicId, entry => createGuestViewer({ ...options, signal: entry.signal }, entry));
  entry.instance.connectView(host, onRoom);
  entry.mount(entry.instance.slot, signal, entry.instance.disconnectView);
  return entry.instance.viewer;
}

function createGuestViewer({ publicId, signal, member = false, password, host, onRoom }, dockEntry) {
  const viewer = document.createElement("div");
  viewer.className = "guest-viewer";
  viewer.innerHTML = `
    <section class="panel stack guest-gate">
      <h1 class="guest-gate-title"></h1>
      <p class="status guest-gate-status" role="status"></p>
      <form class="stack guest-access-form" method="post" hidden>
        <label class="field">
          <span class="guest-password-label"></span>
          <input type="password" required maxlength="128" autocomplete="off" autocapitalize="none" spellcheck="false">
        </label>
        <button class="button primary" type="submit"></button>
      </form>
    </section>
    <section class="guest-room" hidden>
      <header class="guest-heading">
        <h1 class="guest-room-title"></h1>
      </header>
      <div class="quick-view-layout">
        <div class="guest-player-slot"><section class="panel guest-player">
          <div class="guest-media" data-watch-media>
            <p class="status guest-waiting" role="status"></p>
          </div>
          <div class="watch-party-footer">
            <p class="status guest-playback-status" role="status" hidden></p>
            <p class="status guest-command-status" role="status" hidden></p>
            <button class="button primary guest-play" type="button" hidden></button>
          </div>
        </section></div>
        <aside class="quick-view-support" data-pane="chat">
          <div class="quick-view-support-toolbar">
            <div class="quick-view-support-tabs" role="tablist" hidden>
              <button type="button" class="button" role="tab" data-pane="chat" aria-selected="true"></button>
              <button type="button" class="button" role="tab" data-pane="queue" aria-selected="false" tabindex="-1"></button>
            </div>
          </div>
          <div class="quick-view-support-panels">
            <div class="quick-view-chat-slot" tabindex="-1"></div>
            <div class="quick-view-queue-slot" role="tabpanel" tabindex="0" inert></div>
          </div>
        </aside>
      </div>
    </section>`;
  const find = selector => viewer.querySelector(selector);
  const gate = find(".guest-gate");
  const gateTitle = find(".guest-gate-title");
  const gateStatus = find(".guest-gate-status");
  const form = find("form");
  const passwordInput = find("input[type=password]");
  const passwordLabel = find(".guest-password-label");
  const enter = find("button[type=submit]");
  const room = find(".guest-room");
  const heading = find(".guest-heading");
  const title = find(".guest-room-title");
  const support = find(".quick-view-support");
  const supportToolbar = find(".quick-view-support-toolbar");
  const supportTabs = find(".quick-view-support-tabs");
  const chatTab = find("button[data-pane=chat]");
  const queueTab = find("button[data-pane=queue]");
  const chatSlot = find(".quick-view-chat-slot");
  const queueSlot = find(".quick-view-queue-slot");
  const viewerQueue = watchQueue();
  const slot = find(".guest-player-slot");
  const player = find(".guest-player");
  const stage = find(".guest-media");
  const waiting = find(".guest-waiting");
  const playbackStatus = find(".guest-playback-status");
  const commandStatus = find(".guest-command-status");
  const play = find(".guest-play");
  const controls = createWatchControls({
    signal, muted: true,
    onToggle() {
      if (watch?.source.playing) void change("pause");
      else if (playing?.ready) {
        const duration = playing.surface.getDuration();
        const restart = Number.isFinite(duration) && duration > 0 && expectedPosition() >= duration - 0.15;
        if (restart) playing.surface.seek(0);
        if (playing.kind !== "youtube") playing.surface.play();
        void change("play", restart ? 0 : undefined);
      }
    },
    onSeek: position => void change("seek", position),
    onVolume: (volume, muted) => playing?.surface.setVolume(volume, muted),
    fullscreenTarget: () => player,
  });
  find(".watch-party-footer").prepend(controls.element);
  mountHost();

  const supportPrefix = "quick-view-" + ++supportId;
  for (const [tab, panel] of [[chatTab, chatSlot], [queueTab, queueSlot]]) {
    tab.id = supportPrefix + "-tab-" + tab.dataset.pane;
    panel.id = supportPrefix + "-panel-" + tab.dataset.pane;
    tab.setAttribute("aria-controls", panel.id);
  }
  queueSlot.setAttribute("aria-labelledby", queueTab.id);

  function mountHost() {
    if (host?.shareActions) heading.append(host.shareActions);
    if (host?.actions) supportToolbar.prepend(host.actions);
    // The shared snapshot is ready before the host's controls may have finished loading.
    queueSlot.replaceChildren(...[host?.queue, viewerQueue.node].filter(Boolean));
  }

  function removeHostActions() {
    host?.shareActions?.remove();
    host?.actions?.remove();
  }

  function showPane(pane) {
    const showChat = pane === "chat";
    support.dataset.pane = pane;
    chatSlot.inert = !showChat;
    queueSlot.inert = showChat;
    chatTab.setAttribute("aria-selected", String(showChat));
    queueTab.setAttribute("aria-selected", String(!showChat));
    chatTab.tabIndex = showChat ? 0 : -1;
    queueTab.tabIndex = showChat ? -1 : 0;
  }

  function setQueueAvailable(available) {
    if (supportTabs.hidden === !available) return;
    const restoreFocus = !available && (supportTabs.contains(document.activeElement) || queueSlot.contains(document.activeElement));
    supportTabs.hidden = !available;
    if (available) {
      chatSlot.setAttribute("role", "tabpanel");
      chatSlot.setAttribute("aria-labelledby", chatTab.id);
      chatSlot.tabIndex = 0;
    } else {
      chatSlot.removeAttribute("role");
      chatSlot.removeAttribute("aria-labelledby");
      chatSlot.tabIndex = -1;
      showPane("chat");
      if (restoreFocus) chatSlot.focus({ preventScroll: true });
    }
  }

  chatTab.addEventListener("click", () => showPane("chat"), { signal });
  queueTab.addEventListener("click", () => showPane("queue"), { signal });
  supportTabs.addEventListener("keydown", event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    let pane;
    if (event.key === "Home") pane = "chat";
    else if (event.key === "End") pane = "queue";
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") pane = support.dataset.pane === "chat" ? "queue" : "chat";
    else return;
    event.preventDefault();
    showPane(pane);
    (pane === "chat" ? chatTab : queueTab).focus();
  }, { signal });

  let gateState = "opening";
  let playbackState;
  let commandState;
  let timer;
  let clock;
  let watch;
  let playing;
  let preview;
  let authorized = false;
  let roomTitle = "";
  let chat;
  let chatScope;
  let pulling = false;
  let writing = false;
  let nativeIntent;
  let generation = 0;
  let mounted = !dockEntry;
  let dismissedSource;
  const base = "/api/guest/" + publicId;

  function updateLabels() {
    gateTitle.textContent = t("Live room", "Live-Raum");
    setText(gateStatus, copy(gateState));
    passwordLabel.textContent = t("Password", "Passwort");
    enter.textContent = t("Open live room", "Live-Raum öffnen");
    const watchParty = room.hasAttribute("data-watch-party");
    const videoTitle = watchParty && watch?.source.title;
    setText(title, videoTitle || roomTitle || t("Live room", "Live-Raum"));
    title.classList.toggle("sr-only", !videoTitle && (member || (watchParty &&
      (!roomTitle || roomTitle === "Temporary watch party" || roomTitle === "Temporäre Watchparty"))));
    chatTab.textContent = t("Live chat", "Livechat");
    queueTab.textContent = t("Queue", "Warteschlange");
    supportTabs.setAttribute("aria-label", t("Watch party panels", "Bereiche der Watchparty"));
    setText(waiting, copy("waiting"));
    setText(playbackStatus, copy(playbackState));
    setText(commandStatus, copy(commandState));
    play.textContent = playbackState === "playbackError" ? t("Retry playback", "Wiedergabe erneut versuchen")
      : t("Enable playback", "Wiedergabe erlauben");
  }

  function setPlayback(state) {
    if (state === playbackState) return;
    playbackState = state;
    playbackStatus.hidden = !state;
    play.hidden = !["playbackError", "gesture"].includes(state);
    updateLabels();
  }

  function setCommand(state) {
    commandState = state;
    commandStatus.hidden = !state;
    setText(commandStatus, copy(state));
  }

  function showGate(state) {
    gateState = state;
    room.hidden = true;
    gate.hidden = false;
    form.hidden = member || !["required", "invalid", "limited", "checking"].includes(state);
    enter.disabled = state === "checking";
    passwordInput.disabled = enter.disabled;
    passwordInput.setAttribute("aria-invalid", String(state === "invalid"));
    if (!form.hidden && !enter.disabled) queueMicrotask(() => passwordInput.focus());
    updateLabels();
  }

  function discardMedia(keepFullscreen = false) {
    const old = playing;
    playing = undefined;
    old?.audience?.stop();
    old?.surface.destroy();
    if (!keepFullscreen) controls.setFullscreenSurface(null);
    clearInterval(clock);
    controls.resetPosition();
    controls.element.hidden = true;
    waiting.hidden = false;
    setPlayback(undefined);
    setCommand(undefined);
  }

  function showPreview() {
    if (preview || !host?.createPreview) return;
    const scope = new AbortController();
    const element = host.createPreview(AbortSignal.any([scope.signal, signal]));
    preview = { scope, element };
    stage.append(element);
  }

  function hidePreview() {
    preview?.scope.abort();
    preview?.element.remove();
    preview = undefined;
  }

  function expectedPosition() {
    const { source, serverTime, received, roundTrip } = watch;
    const age = serverTime - source.updatedAt + roundTrip / 2 + performance.now() - received;
    const expected = source.position + (source.playing ? Math.max(0, age) / 1000 : 0);
    const duration = playing?.surface.getDuration();
    return Number.isFinite(duration) && duration > 0 ? Math.min(expected, duration) : expected;
  }

  function tick() {
    if (watch && playing?.ready && playing.kind !== "screen") {
      controls.setPosition(expectedPosition(), playing.surface.getDuration());
    }
  }

  function applyState(force = false) {
    const current = playing;
    if (!watch || !current?.ready || nativeIntent) return;
    const { source } = watch;
    if (source.kind === "screen") {
      if (force) current.surface.play();
      return;
    }

    const expected = expectedPosition();
    const changed = current.revision !== source.revision;
    // Seeking a cued YouTube player can cancel its pending play command.
    if (source.kind === "youtube" && source.playing && !current.started) {
      if (force || changed) {
        current.revision = source.revision;
        setPlayback("loading");
        current.surface.play();
      }
      return;
    }
    const tolerance = force || changed || !source.playing ? 0.3 : 2.25;
    if (Math.abs(current.surface.getTime() - expected) > tolerance) current.surface.seek(expected);
    current.revision = source.revision;
    if (source.playing) {
      if (force || changed) current.surface.play();
    } else {
      if (!current.surface.isPaused() || force || changed) current.surface.pause();
      setPlayback(undefined);
    }
    tick();
  }

  function renderTransport() {
    controls.setTransport({
      isPlaying: watch?.source.playing,
      enabled: !writing && Boolean(playing?.ready),
      shared: watch?.source.kind !== "screen",
    });
    controls.audio.hidden = !watch?.source.hasAudio;
  }

  function startPlayback(transfer = false) {
    const audience = transfer && playing?.kind === "youtube" && playing.id === watch?.source.id ? playing.audience : undefined;
    if (audience) playing.audience = undefined;
    discardMedia(Boolean(playing && watch && playing.kind !== "screen" && watch.source.kind !== "screen"));
    if (!watch) return;
    const { source } = watch;
    const ownerDocument = stage.ownerDocument;
    const current = { id: source.id, kind: source.kind, ready: false, started: false };
    if (source.kind === "youtube") {
      current.audience = audience ?? createWatchViewerLease({ signal, ownerDocument,
        report: options => reportWatchViewer(base + "/viewers", options, { partyId: source.id }),
      });
      audience?.moveTo(ownerDocument);
    }
    const active = () => playing === current && !signal.aborted;
    current.surface = openGuestMedia(source, {
      onReady() {
        if (!active()) return;
        current.ready = true;
        applyState(true);
        renderTransport();
      },
      onPlaying() {
        if (!active()) return;
        const started = current.started;
        current.started = true;
        hidePreview();
        setPlayback(undefined);
        if (!started && watch?.source.playing && source.kind === "youtube") applyState(true);
      },
      onEnded() {
        if (!active() || !watch?.source.playing) return;
        const duration = current.surface.getDuration();
        if (Number.isFinite(duration) && duration > 0 && expectedPosition() >= duration - 1) void change("ended", duration);
      },
      onBlocked() { if (active() && (source.kind === "screen" || watch?.source.playing)) setPlayback("gesture"); },
      onError() {
        if (!active()) return;
        current.ready = false;
        current.audience?.setVisible(false);
        showPreview();
        setPlayback("playbackError");
        renderTransport();
      },
      onPlaybackChange(resumed) {
        if (!active() || !current.ready || source.kind === "screen") return;
        nativeIntent = { id: source.id, playing: resumed };
        sendNativeIntent();
      },
      onVolumeChange(volume, muted) {
        if (active() && current.ready) controls.setVolume(volume, muted);
      },
      onVisibility(visible) {
        current.audience?.setVisible(visible);
        if (visible && active()) {
          current.revision = undefined;
          schedule(0);
        }
      },
      onTitle(value) {
        if (!active() || !host?.channelId || watch?.source.title) return;
        const title = [...value.trim()].slice(0, 120).join("");
        if (!title) return;
        const path = "/api/channels/" + host.channelId + "/watch/" + source.id + "/metadata";
        void request(path, "PATCH", { title }, true).catch(() => {});
      },
    }, ownerDocument);
    playing = current;
    if (current.surface.element.tagName === "VIDEO") current.surface.element.setAttribute("aria-label", title.textContent);
    stage.insertBefore(current.surface.element, preview?.element ?? null);
    controls.setFullscreenSurface(current.surface.element);
    waiting.hidden = true;
    controls.element.hidden = false;
    setPlayback("loading");
    const { volume, muted } = controls.volumeState();
    current.surface.setVolume(volume, muted);
    clock = setInterval(tick, 250);
  }

  function revoke(notifyChat = false) {
    authorized = false;
    watch = undefined;
    nativeIntent = undefined;
    hidePreview();
    discardMedia();
    if (notifyChat) chat?.dispatchEvent(new Event("quick-chat-revoke"));
    closeChat();
    dockEntry?.deactivate();
  }

  function closeChat() {
    chatScope?.abort();
    chatScope = undefined;
    chat?.remove();
    chat = undefined;
  }

  function openChat() {
    if (chat || !mounted || !authorized) return;
    chatScope = new AbortController();
    chat = renderQuickChat({ publicId, signal: AbortSignal.any([chatScope.signal, signal]), member });
    chatSlot.append(chat);
  }

  function showRoom(snapshot, sent) {
    authorized = true;
    const name = snapshot.roomTitle ?? snapshot.title;
    roomTitle = typeof name === "string" ? name.slice(0, 120) : "";
    onRoom?.(roomTitle, snapshot.source);
    room.toggleAttribute("data-watch-party", snapshot.source === "youtube" || snapshot.source === "local");
    room.hidden = false;
    gate.hidden = true;
    passwordInput.value = "";
    openChat();
    const source = guestSource(snapshot, base);
    const hasQueue = Boolean(source && source.kind !== "screen");
    setQueueAvailable(hasQueue);
    viewerQueue.update(snapshot.queue, { visible: hasQueue });
    if (!source) {
      watch = undefined;
      if (playing) discardMedia();
      dockEntry?.deactivate();
      showPreview();
      updateLabels();
      return;
    }
    const received = performance.now();
    watch = { source, serverTime: snapshot.serverTime, received, roundTrip: received - sent };
    updateLabels();
    if ((source.sessionId ?? source.id) === dismissedSource) return;
    if (source.id !== playing?.id || source.kind !== playing?.kind) {
      showPreview();
      startPlayback();
    }
    else applyState();
    if (playbackState === "reconnecting") setPlayback(undefined);
    renderTransport();
    dockEntry?.activate(source.title || roomTitle || title.textContent, host?.href ?? dockEntry.href ?? "#/watch/" + publicId);
  }

  function request(path, method = "GET", body, absolute = false) {
    return fetch(absolute ? path : base + path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      headers: { "Accept-Language": language(), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  function accessLost(response) {
    if (![401, 403, 404, 410].includes(response.status)) return false;
    revoke(true);
    showGate(!member && [401, 403].includes(response.status) ? "required" : "unavailable");
    host?.onUnavailable?.();
    return true;
  }

  function schedule(delay = watch?.source.kind === "local" || watch?.source.kind === "youtube" ? 1200 : 2600) {
    clearTimeout(timer);
    if (!signal.aborted) timer = setTimeout(refresh, delay);
  }

  async function refresh() {
    if (signal.aborted) return;
    if (pulling || writing) return schedule();
    pulling = true;
    const version = generation;
    const sent = performance.now();
    try {
      const response = await request("/state");
      if (signal.aborted || version !== generation || accessLost(response)) return;
      if (!response.ok) throw new Error();
      const snapshot = await response.json();
      if (!signal.aborted && version === generation) showRoom(snapshot, sent);
    } catch {
      if (signal.aborted || version !== generation) return;
      if (authorized) setPlayback("reconnecting");
      else showGate("reconnecting");
    } finally {
      pulling = false;
    }
    if (!signal.aborted && version === generation) schedule();
  }

  function sendNativeIntent() {
    if (!nativeIntent || writing || signal.aborted) return;
    const intent = nativeIntent;
    nativeIntent = undefined;
    if (watch?.source.id !== intent.id || !playing?.ready) return;
    if (intent.playing === watch.source.playing) applyState(true);
    else void change(intent.playing ? "play" : "pause");
  }

  async function change(action, position) {
    const source = watch?.source;
    if (!source || source.kind === "screen" || writing || signal.aborted) return;
    writing = true;
    generation++;
    renderTransport();
    setCommand(undefined);
    const sent = performance.now();
    try {
      const { id, revision } = source;
      if (action === "play" && playing?.audience && !await playing.audience.ensure()) {
        setCommand("visibleRequired");
        applyState(true);
        return;
      }
      if (signal.aborted || watch?.source.id !== id) return;
      const response = await request("/playback", "PATCH", { partyId: id, revision, action, position });
      if (signal.aborted || (response.status !== 404 && accessLost(response))) return;
      if (response.status === 409 || response.status === 404) {
        if (action !== "ended") setCommand("conflict");
        if (playing) playing.revision = undefined;
      } else {
        if (!response.ok) throw new Error();
        const snapshot = await response.json();
        if (!signal.aborted) showRoom(snapshot, sent);
      }
    } catch {
      if (!signal.aborted) {
        setCommand("commandError");
        applyState(true);
      }
    } finally {
      writing = false;
      if (!signal.aborted && authorized) {
        renderTransport();
        schedule(0);
        sendNativeIntent();
      }
    }
  }

  async function unlock(secret) {
    if (signal.aborted || enter.disabled) return;
    passwordInput.value = "";
    if (!guestPassword.test(secret)) {
      showGate("invalid");
      return;
    }
    showGate("checking");
    try {
      const response = await request("/session", "POST", { password: secret });
      if (signal.aborted) return;
      if (response.ok) await refresh();
      else if (response.status === 429) showGate("limited");
      else if ([401, 403].includes(response.status)) showGate("invalid");
      else showGate("unavailable");
    } catch {
      if (!signal.aborted) showGate("required");
    }
  }

  form.addEventListener("submit", event => {
    event.preventDefault();
    if (!member) void unlock(passwordInput.value.trim());
  }, { signal });
  play.addEventListener("click", () => {
    if (playbackState === "playbackError") startPlayback();
    else if (playing) applyState(true);
  }, { signal });
  viewer.addEventListener("guest-language", () => {
    updateLabels();
    controls.refreshLabels();
    viewerQueue.refreshLabels();
    chat?.dispatchEvent(new Event("guest-language"));
  }, { signal });
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    revoke();
  }, { once: true });

  discardMedia();
  updateLabels();
  if (!guestRoomId.test(publicId)) showGate("unavailable");
  else if (!member && typeof password === "string") void unlock(password);
  else void refresh();
  return {
    viewer, player, slot,
    connectView(nextHost, nextOnRoom) {
      mounted = true;
      removeHostActions();
      host = nextHost;
      onRoom = nextOnRoom;
      mountHost();
      updateLabels();
      dismissedSource = undefined;
      openChat();
      schedule(0);
    },
    disconnectView() {
      mounted = false;
      removeHostActions();
      host = undefined;
      onRoom = undefined;
      hidePreview();
      closeChat();
    },
    stopPlayback() {
      dismissedSource = watch?.source.sessionId ?? watch?.source.id;
      discardMedia();
      dockEntry?.deactivate();
    },
    reconnectAfterMove() {
      if (!playing) return;
      if (playing.kind === "youtube") startPlayback(true);
      else {
        controls.setFullscreenSurface(playing.surface.element);
        if (playing.kind === "screen" || watch?.source.playing) playing.surface.play();
      }
    },
  };
}
