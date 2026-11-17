import { api, button, checkAccountResponse, el, identifier, notify, personMark, personName, sameId, status, tell, topicHref } from "./ui.js";
import { t } from "./i18n.js";
import { renderChat } from "./chat.js";
import { renderStreamAudience } from "./stream-audience.js";
import { renderStreamChat } from "./stream-chat.js";
import { createChannelCapture } from "./channel-capture.js";
import { createWatchParty } from "./watch-party.js";
import { canPlayDirectly, startWhep } from "./whep.js";

const viewerHeartbeat = 8000;
const startupTimeout = 24000;
const directStartupTimeout = 13000;
const progressInterval = 4000;
const stallTimeout = 12000;

function streamsPath(channel) {
  return "channels/" + identifier(channel.id) + "/streams";
}

function localPlaylist(path) {
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin || !url.pathname.startsWith("/hls/")) {
    throw new Error(t("The stream URL is invalid.", "Die Stream-Adresse ist ungültig."));
  }
  return url.href;
}

function streamer(stream) {
  return { id: stream.userId, displayName: stream.displayName, avatarUrl: stream.avatarUrl, nameColor: stream.nameColor };
}

export function createLivePlayer(context, dock) {
  const { signal, user } = context;
  const video = el("video", { playsinline: true, autoplay: true, preload: "auto", "aria-hidden": "true" });
  video.muted = true;
  const title = el("h3", {});
  const detail = el("p");
  const start = button(t("Start playback", "Wiedergabe starten"), () => {
    if (!playback) {
      connect();
      return;
    }
    if (!playback.started) {
      clearTimeout(watchdog);
      watchdog = setTimeout(retry, startupTimeout);
    }
    playVideo();
  }, { class: "primary", hidden: true });
  const overlay = el("div", { class: "stage-overlay" },
    el("div", { class: "stack", role: "status" }, title, detail), start);
  const heading = el("h2", { class: "stream-heading" }, t("Live stream", "Livestream"));
  const returnLink = el("a", { class: "button", hidden: true }, t("Go to live channel", "Zum Live-Channel"));
  const sound = button(t("Unmute", "Ton an"), () => {
    if (sound.hidden) return;
    video.muted = !video.muted;
    updateSound();
  }, { hidden: true });
  const playbackMode = button("", () => {
    if (!selected?.stream.live || !canPlayDirectly(selected.stream)) return;
    selected.buffered = playback?.direct === true;
    selected.nativeOnly = false;
    connect();
  }, { class: "ghost", hidden: true });
  const close = button("×", () => stop(t("Playback stopped.", "Wiedergabe beendet.")), { "aria-label": t("Stop playback", "Wiedergabe beenden"), title: t("Stop playback", "Wiedergabe beenden"), class: "icon-button", hidden: true });
  const node = el("section", { class: "panel live-player stack", hidden: true, "aria-label": t("Stream player", "Stream-Player") },
    el("div", { class: "section-heading player-heading" }, heading, el("div", { class: "inline" }, playbackMode, sound, returnLink, close)),
    el("div", { class: "stage" }, video, overlay));
  const dockLabel = el("span", {}, t("Stream", "Stream"));
  const summary = el("summary", { class: "button" }, dockLabel);
  const popover = el("div", { class: "stream-popover" }, node);
  const details = el("details", { class: "stream-dock", name: "header-media" }, summary, popover);
  dock.replaceChildren(details);
  details.addEventListener("toggle", updatePlacement, { signal });
  details.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !details.open) return;
    event.stopPropagation();
    details.open = false;
    summary.focus({ preventScroll: true });
  }, { signal });
  returnLink.addEventListener("click", () => { details.open = false; }, { signal });

  let current;
  let selected;
  let hls;
  let heartbeat;
  let retryTimer;
  let watchdog;
  let playback;
  let viewerTimer;
  let viewerStream;
  let viewerPosition;
  let viewerRevision = 0;
  const viewerPlayerId = crypto.randomUUID().replaceAll("-", "");
  let version = 0;
  const changes = new EventTarget();

  function updateSound() {
    sound.hidden = !video.controls || selected?.stream.hasAudio !== true;
    const action = video.muted ? t("Unmute stream", "Streamton einschalten") : t("Mute stream", "Streamton stummschalten");
    sound.textContent = video.muted ? t("Unmute", "Ton an") : t("Mute", "Ton aus");
    sound.setAttribute("aria-label", action);
    sound.title = action;
  }

  function updateMode() {
    const direct = playback?.direct === true;
    playbackMode.hidden = !playback || !selected?.stream.live || !canPlayDirectly(selected.stream);
    playbackMode.textContent = direct ? t("Direct", "Direkt") : t("Buffered", "Gepuffert");
    const action = direct ? t("Use buffered playback", "Gepufferte Wiedergabe verwenden")
      : t("Use low-latency playback", "Wiedergabe mit geringer Verzögerung verwenden");
    playbackMode.title = action;
    playbackMode.setAttribute("aria-label", action);
  }

  function show(label, description, action = "") {
    overlay.hidden = false;
    video.controls = false;
    video.setAttribute("aria-hidden", "true");
    title.textContent = label;
    detail.textContent = description;
    start.hidden = !action;
    start.textContent = action;
    updateSound();
    updateMode();
  }

  function notifySelection() {
    changes.dispatchEvent(new Event("change"));
  }

  function viewingOrigin() {
    return current && selected && current.channel?.type === "live" && sameId(selected.channel.id, current.channel.id);
  }

  function movePlayer(target) {
    if (node.parentNode === target) return;
    const playing = playback && !video.paused;
    if (target.moveBefore && target.isConnected && node.isConnected) target.moveBefore(node, null);
    else {
      target.append(node);
      if (playing) playVideo();
    }
  }

  function updatePlacement() {
    const full = viewingOrigin() && current.layout?.isConnected && !details.open;
    const placement = full ? "full" : selected ? "mini" : "none";
    movePlayer(full ? current.layout : popover);
    if (current?.layout) current.layout.dataset.player = full ? "full" : "none";
    node.dataset.mode = placement;
    dock.hidden = !selected;
    node.hidden = placement === "none";
    close.hidden = !selected;
    returnLink.hidden = placement !== "mini";
    if (selected) {
      const person = streamer(selected.stream);
      heading.replaceChildren(personMark(person), el("span", {}, personName(person), t(" is streaming", " streamt")));
      returnLink.href = topicHref(selected.topic.id, selected.channel.id);
      dockLabel.textContent = t("Stream", "Stream") + " · " + person.displayName;
      summary.title = person.displayName + " · " + selected.topic.title + " · " + selected.channel.title;
      summary.setAttribute("aria-label", t("Stream by {name} · {channel}", "Stream von {name} · {channel}",
        { name: person.displayName, channel: selected.channel.title }));
      video.setAttribute("aria-label", t("Stream by {name}", "Stream von {name}", { name: person.displayName }));
    }
  }

  function reportViewer(streamId, method) {
    const leaving = method === "DELETE";
    fetch("/api/streams/" + identifier(streamId) + "/viewers", {
      method, credentials: "same-origin", cache: "no-store", redirect: "error",
      referrer: location.origin + "/", referrerPolicy: "same-origin",
      headers: { "Content-Type": "application/json", "X-Rooms-Account": user.id },
      body: JSON.stringify({ userId: user.id, playerId: viewerPlayerId, revision: ++viewerRevision }),
      keepalive: leaving,
      signal: leaving ? undefined : AbortSignal.timeout(6000),
    }).then(checkAccountResponse).catch(() => { /* A lost heartbeat expires automatically. */ });
  }

  function releaseViewer() {
    clearTimeout(viewerTimer);
    if (viewerStream) reportViewer(viewerStream, "DELETE");
    viewerStream = undefined;
    viewerPosition = undefined;
  }

  function reportPlaying() {
    clearTimeout(viewerTimer);
    const stream = selected?.stream;
    if (!user || !playback || signal.aborted || video.paused || !stream?.live || sameId(stream.userId, user.id)) {
      releaseViewer();
      return;
    }
    if (video.currentTime !== viewerPosition) {
      viewerPosition = video.currentTime;
      viewerStream = stream.id;
      reportViewer(stream.id, "POST");
    }
    viewerTimer = setTimeout(reportPlaying, viewerHeartbeat);
  }

  function disconnect() {
    releaseViewer();
    clearTimeout(retryTimer);
    clearTimeout(watchdog);
    const old = hls;
    const stopDirect = playback?.stopDirect;
    hls = null;
    playback = null;
    stopDirect?.();
    old?.destroy();
    video.pause();
    if (video.srcObject) video.srcObject = null;
    video.removeAttribute("src");
    video.removeAttribute("disableremoteplayback");
    video.load();
  }

  function stop(note = "") {
    const hadSelection = Boolean(selected);
    version += 1;
    selected = null;
    details.open = false;
    clearTimeout(heartbeat);
    disconnect();
    show(t("Live stream", "Livestream"), note || t("Select a stream below.", "Wähle unten einen Stream."));
    updatePlacement();
    notifySelection();
    if (note && hadSelection && !signal.aborted) notify(note);
  }

  function retry(allowNative = true) {
    if (!selected || !playback || signal.aborted) return;
    const switchToBuffered = playback.direct === true;
    const switchToNative = allowNative && playback.usingHlsJs && playback.nativeAvailable;
    disconnect();
    if (switchToNative) selected.nativeOnly = true;
    if (switchToBuffered) {
      selected.buffered = true;
      connect();
      return;
    }
    show(t("Connection lost", "Verbindung unterbrochen"), t("Reconnecting playback.", "Die Wiedergabe wird neu verbunden."), t("Reconnect", "Erneut verbinden"));
    retryTimer = setTimeout(connect, switchToNative ? 0 : 4000);
  }

  function playVideo() {
    const attempt = playback;
    if (!attempt) return;
    video.play().catch(error => {
      if (attempt !== playback || error.name === "AbortError") return;
      if (error.name === "NotAllowedError") {
        clearTimeout(watchdog);
        show(t("Stream is ready", "Stream bereit"), t("Click to start playback.", "Starte die Wiedergabe mit einem Klick."), t("Start playback", "Wiedergabe starten"));
      } else {
        retry();
      }
    });
  }

  function monitorProgress() {
    clearTimeout(watchdog);
    const attempt = playback;
    if (!attempt?.started || video.paused || document.hidden) return;
    let position = video.currentTime;
    let lastAdvance = performance.now();
    function check() {
      if (attempt !== playback || video.paused || document.hidden) return;
      const now = performance.now();
      if (video.seeking || video.currentTime !== position) {
        position = video.currentTime;
        lastAdvance = now;
      } else if (now - lastAdvance >= stallTimeout) {
        retry();
        return;
      }
      watchdog = setTimeout(check, progressInterval);
    }
    watchdog = setTimeout(check, progressInterval);
  }

  function connect() {
    if (!selected || !selected.stream.live || signal.aborted) return;
    disconnect();
    if (!selected.buffered && canPlayDirectly(selected.stream)) {
      const attempt = playback = { direct: true, started: false };
      show(t("Connecting directly", "Direktverbindung wird aufgebaut"),
        t("Starting low-latency playback.", "Wiedergabe mit geringer Verzögerung startet."));
      watchdog = setTimeout(retry, directStartupTimeout);
      try {
        attempt.stopDirect = startWhep(selected.stream, media => {
          if (playback !== attempt) return;
          video.srcObject = media;
          playVideo();
        }, () => {
          if (playback === attempt) retry();
        });
      } catch {
        retry();
      }
      return;
    }
    let url;
    try {
      url = localPlaylist(selected.stream.playlistUrl);
    } catch (error) {
      show(t("Playback unavailable", "Wiedergabe nicht verfügbar"), error.message);
      return;
    }
    const Hls = window.Hls;
    const usingHlsJs = !selected.nativeOnly && Boolean(Hls?.isSupported());
    const nativeAvailable = Boolean(video.canPlayType("application/vnd.apple.mpegurl"));
    if (!usingHlsJs && !nativeAvailable) {
      show(t("Playback unavailable", "Wiedergabe nicht verfügbar"), t("This browser does not support the live stream.", "Dieser Browser unterstützt den Livestream nicht."));
      return;
    }
    playback = { usingHlsJs, nativeAvailable, started: false };
    show(t("Loading live stream", "Livestream wird geladen"), t("Connecting to the stream.", "Der Stream verbindet sich."));
    watchdog = setTimeout(retry, startupTimeout);
    if (!usingHlsJs) {
      video.src = url;
      return;
    }
    try {
      hls = new Hls({ preferManagedMediaSource: true, maxBufferLength: 18, backBufferLength: 24, maxLiveSyncPlaybackRate: 1.1 });
      const active = hls;
      active.on(Hls.Events.ERROR, (_, data) => {
        if (active === hls && data.fatal) retry(data.type !== Hls.ErrorTypes?.NETWORK_ERROR);
      });
      active.attachMedia(video);
      if (active === hls) active.loadSource(url);
    } catch {
      retry();
    }
  }

  async function monitor(expected) {
    if (signal.aborted || !selected || version !== expected) return;
    try {
      const response = await api(streamsPath(selected.channel), { signal });
      if (signal.aborted || version !== expected) return;
      const next = response.streams.find(stream => sameId(stream.id, selected.stream.id));
      if (!next) {
        stop(t("This stream has ended.", "Dieser Stream ist beendet."));
        return;
      }
      const changed = next.live !== selected.stream.live;
      const changedProfile = next.displayName !== selected.stream.displayName || next.avatarUrl !== selected.stream.avatarUrl
        || next.nameColor !== selected.stream.nameColor;
      const changedAudio = next.hasAudio !== selected.stream.hasAudio;
      selected.stream = next;
      if (changedProfile) updatePlacement();
      if (changedAudio) {
        if (!next.hasAudio) video.muted = true;
        updateSound();
      }
      updateMode();
      if (changedAudio && !changed && playback?.direct) connect();
      if (changed) {
        if (next.live) connect();
        else {
          disconnect();
          show(t("Waiting for the signal", "Wartet auf Signal"), t("The stream will appear when the broadcast goes live.", "Der Stream erscheint, sobald die Übertragung läuft."));
        }
      }
    } catch (error) {
      if (signal.aborted || version !== expected) return;
      if (error.status === 403 || error.status === 404) {
        stop(t("This stream is no longer available to you.", "Der Stream ist für dich nicht mehr verfügbar."));
        return;
      }
    }
    heartbeat = setTimeout(() => monitor(expected), 4100);
  }

  function choose(channel, stream) {
    if (signal.aborted || !current?.topic || !sameId(current.channel?.id, channel.id)) return;
    details.open = false;
    if (sameId(selected?.stream.id, stream.id)) return updatePlacement();
    disconnect();
    clearTimeout(heartbeat);
    version += 1;
    video.muted = true;
    selected = { topic: current.topic, channel, stream };
    if (stream.live) connect();
    else show(t("Waiting for the signal", "Wartet auf Signal"), t("The stream will appear when the broadcast goes live.", "Der Stream erscheint, sobald die Übertragung läuft."));
    updatePlacement();
    notifySelection();
    heartbeat = setTimeout(() => monitor(version), 4100);
  }

  video.addEventListener("canplay", () => {
    if (playback && !playback.started) playVideo();
  });
  video.addEventListener("play", () => {
    if (playback?.started) monitorProgress();
  });
  video.addEventListener("playing", () => {
    if (!playback) return;
    if (!playback.started) {
      playback.started = true;
      monitorProgress();
    }
    reportPlaying();
    overlay.hidden = true;
    video.controls = true;
    video.setAttribute("aria-hidden", "false");
    updateSound();
  });
  video.addEventListener("error", () => {
    if (video.error) retry();
  });
  video.addEventListener("ended", () => {
    if (video.ended) retry();
  });
  video.addEventListener("pause", () => {
    if (!video.paused) return;
    releaseViewer();
    if (playback?.started) clearTimeout(watchdog);
  });
  video.addEventListener("volumechange", updateSound);
  document.addEventListener("visibilitychange", () => {
    if (playback?.started) monitorProgress();
  }, { signal });
  window.addEventListener("pagehide", () => {
    if (playback?.direct) disconnect();
    else releaseViewer();
  }, { signal });
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return;
    if (selected?.stream.live && !playback) connect();
    reportPlaying();
    if (playback?.started) monitorProgress();
  }, { signal });
  signal.addEventListener("abort", () => stop(), { once: true });

  return {
    choose, stop,
    setLocation(topic, channel, layout) {
      const wasFull = node.dataset.mode === "full";
      const wasOrigin = viewingOrigin();
      if (current?.layout && current.layout !== layout) current.layout.dataset.player = "none";
      current = topic ? { topic, channel, layout } : null;
      if (viewingOrigin() && !wasOrigin) details.open = false;
      else if (wasFull && !viewingOrigin() && matchMedia("(min-width: 741px) and (min-height: 520px)").matches) details.open = true;
      updatePlacement();
    },
    refreshPlacement: updatePlacement,
    activeId() { return selected?.stream.id; },
    whenChanged(callback, options) { changes.addEventListener("change", callback, options); },
    end(streamId) {
      if (sameId(selected?.stream.id, streamId)) stop(t("This stream has ended.", "Dieser Stream ist beendet."));
    },
  };
}

export function renderLive(context, channel, player, voiceMount, playerMount = el("div", { class: "live-channel-player" })) {
  const { signal, user, room, screenShare, nativeBroadcast } = context;
  const endpoint = streamsPath(channel);
  const cards = el("div", { class: "screen-stream-cards" });
  const liveTitle = el("h2", { id: "live-channel-heading", title: channel.title, tabindex: -1 }, channel.title);
  const empty = el("p", { class: "muted", role: "status" }, t("Loading streams…", "Streams werden geladen …"));
  const watchHint = el("div", { class: "live-channel-placeholder", "aria-label": t("Stream player", "Stream-Player") }, empty);
  const channelChat = renderChat({ ...context, liveChat: true, messageId: undefined }, channel);
  const chat = el("div", { class: "live-channel-chat-content" }, channelChat);
  const audience = el("div", { class: "live-channel-audience", hidden: true });
  const feedback = status();
  const previewTitle = t("Your stream preview", "Deine Stream-Vorschau");
  const previewVideo = el("video", { autoplay: true, playsinline: true, "aria-label": previewTitle });
  previewVideo.muted = true;
  const previewStage = el("div", { class: "stage" });
  const preview = el("section", { class: "stack screen-preview", hidden: true, "aria-label": previewTitle },
    el("h3", {}, previewTitle), previewStage);
  const nativePreview = nativeBroadcast?.mount(room, channel, signal);
  const reconnectNote = t("Reconnecting the stream list.", "Die Stream-Liste wird neu verbunden.");
  const unavailableNote = t("The mentioned stream is unavailable.", "Der erwähnte Stream ist nicht verfügbar.");
  const unavailableWatch = t("The watch party has ended.", "Die Watchparty ist beendet.");
  const capture = createChannelCapture(context, channel);
  const reserve = button(t("Share screen", "Bildschirm teilen"), requestStream, { class: "primary", hidden: true, "data-tutorial": "live-share" });
  const finish = button(t("End my stream", "Meinen Stream beenden"), endStream, { class: "danger", hidden: true });
  const shareSummary = el("summary", { class: "button" }, t("Share options", "Freigabeoptionen"));
  const shareSettings = el("details", { class: "live-channel-share-settings", hidden: true }, shareSummary,
    el("div", { class: "panel stack live-channel-share-options" }, capture.options));
  shareSettings.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !shareSettings.open) return;
    event.stopPropagation();
    shareSettings.open = false;
    shareSummary.focus({ preventScroll: true });
  });
  const peopleButton = button(t("Voice & streams", "Sprache & Streams"), () => setPanel("people"), {
    id: "live-people-tab", role: "tab", "aria-controls": "live-channel-people",
  });
  const chatButton = button(t("Live chat", "Livechat"), () => setPanel("chat"), {
    id: "live-chat-tab", role: "tab", "aria-controls": "live-channel-chat",
  });
  const queueButton = button(t("Queue", "Warteschlange"), () => setPanel("queue"), {
    id: "live-queue-tab", role: "tab", "aria-controls": "live-channel-queue", hidden: true,
  });
  const watchSlot = el("div", { class: "watch-party-slot" });
  const watchParty = createWatchParty(context, channel, {
    mount: watchSlot,
    onSelect() {
      autoSelectPending = false;
      if (player.activeId()) player.stop();
      if (feedback.textContent === unavailableWatch) tell(feedback, "");
    },
    onChange() {
      selectInitialPlayback();
      renderControls();
    },
    onUnavailable: () => tell(feedback, unavailableWatch),
    onShareUnavailable: () => tell(feedback, t("Video sharing is unavailable in this channel.", "In diesem Kanal kannst du gerade kein Video teilen.")),
  });
  const closeWatchTitle = t("Close player", "Player schließen");
  const closeWatch = button(closeWatchTitle, () => {
    const restoreFocus = document.activeElement === closeWatch;
    watchParty.leave();
    if (restoreFocus) liveTitle.focus({ preventScroll: true });
  }, { hidden: true });
  const watchActions = el("div", {
    class: "live-channel-watch-actions", role: "group", "aria-label": t("Watch party actions", "Watchparty-Aktionen"), hidden: true,
  }, closeWatch, watchParty.end);
  const streamsSection = el("section", {
    class: "live-channel-streams", "aria-labelledby": "live-channel-streams-heading", hidden: true,
  }, el("h3", { id: "live-channel-streams-heading" }, t("Streams", "Streams")),
  el("div", { class: "stream-list" }, cards, watchParty.card));
  let streams = [];
  let streamsReady = false;
  let canStream = false;
  let pending = false;
  let timer;
  let polling = false;
  let lastSignature;
  let lastSelection;
  let lastLocalStream;
  let audienceScope;
  let audienceId;
  let legacy;
  let selectedPanel;
  let peopleInSidebar = false;
  let requestedShare = context.shareSource;
  let destination = !context.watchId && context.streamId ? { streamId: context.streamId } : null;
  let autoSelectPending = !context.watchId && !context.streamId && !context.shareSource;

  function mine() {
    return streams.find(stream => sameId(stream.userId, user.id));
  }

  function setPanel(panel) {
    selectedPanel = panel;
    updatePanels();
  }

  function updatePanels() {
    const focused = document.activeElement;
    const hasQueue = !watchParty.queue.hidden;
    queueButton.hidden = !hasQueue;
    peopleButton.hidden = peopleInSidebar;
    tablist.hidden = peopleInSidebar && !hasQueue;
    if ((selectedPanel === "queue" && !hasQueue) || (selectedPanel === "people" && peopleInSidebar)) selectedPanel = "chat";
    const focusInChat = chatPanel.contains(focused) || focused === chatButton;
    const focusInPeople = people.contains(focused) || focused === peopleButton;
    const defaultPanel = peopleInSidebar || focusInChat || (hasQueue && !focusInPeople) ? "chat" : "people";
    const activePanel = selectedPanel ?? defaultPanel;
    node.dataset.panel = activePanel;
    node.toggleAttribute("data-has-queue", hasQueue);

    for (const [name, tab, panel] of panels) {
      const active = name === activePanel;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      panel.hidden = !active && !(name === "people" && peopleInSidebar);
    }
    if (tablist.hidden) {
      chatPanel.removeAttribute("role");
      chatPanel.removeAttribute("aria-labelledby");
      chatPanel.tabIndex = -1;
    } else {
      chatPanel.setAttribute("role", "tabpanel");
      chatPanel.setAttribute("aria-labelledby", chatButton.id);
      chatPanel.tabIndex = 0;
    }
    if (panels.some(([, tab, panel]) => (focused === tab && (tab.hidden || tablist.hidden)) ||
      (panel.hidden && panel.contains(focused)))) {
      const [, activeTab] = panels.find(([name]) => name === activePanel);
      (tablist.hidden ? chatPanel : activeTab).focus({ preventScroll: true });
    }
  }

  function setSupportSidebar(inSidebar) {
    peopleInSidebar = inSidebar;
    people.setAttribute("role", inSidebar ? "region" : "tabpanel");
    people.tabIndex = inSidebar ? -1 : 0;
    if (inSidebar) {
      people.removeAttribute("aria-labelledby");
      people.setAttribute("aria-label", peopleButton.textContent);
    } else {
      people.removeAttribute("aria-label");
      people.setAttribute("aria-labelledby", peopleButton.id);
    }
    updatePanels();
  }

  function showChannelChat() {
    legacy?.scope.abort();
    legacy?.node.remove();
    legacy = undefined;
    channelChat.hidden = false;
  }

  function showChatTarget(target) {
    if (!target?.messageId) return;
    setPanel("chat");
    showChannelChat();
    if (!target.streamId) {
      channelChat.dispatchEvent(new CustomEvent("open-message", { detail: target }));
      return;
    }
    const scope = new AbortController();
    const chatSignal = AbortSignal.any([signal, scope.signal]);
    const older = renderStreamChat({ ...context, messageId: target.messageId, signal: chatSignal, readOnly: true }, target.streamId);
    const node = el("div", { class: "live-channel-legacy-chat" },
      button(t("Back to live chat", "Zurück zum Livechat"), showChannelChat, { class: "ghost" }), older);
    legacy = { scope, node };
    channelChat.hidden = true;
    chat.append(node);
  }

  function localNative() {
    const active = nativeBroadcast?.active();
    return sameId(active?.channelId, channel.id) ? active : null;
  }

  function showsLocally(stream) {
    return sameId(screenShare?.active()?.id, stream.id) || sameId(localNative()?.streamId, stream.id);
  }

  function chooseStream(stream) {
    autoSelectPending = false;
    watchParty.leave();
    if (showsLocally(stream)) {
      if (streams.some(item => sameId(item.id, player.activeId()))) player.stop();
    } else {
      player.choose(channel, stream);
    }
  }

  function selectInitialPlayback() {
    if (!autoSelectPending || !streamsReady) return;
    if (streams.some(stream => sameId(stream.id, player.activeId())) || watchParty.selected() || lastLocalStream) {
      autoSelectPending = false;
      return;
    }
    const firstStream = streams.find(stream => stream.live);
    if (firstStream) chooseStream(firstStream);
    else if (watchParty.hasSnapshot()) {
      autoSelectPending = false;
      watchParty.join();
    }
  }

  function selectDestination() {
    if (!destination || !streamsReady) return;
    const stream = streams.find(item => item.live && sameId(item.id, destination.streamId));
    if (!stream) {
      if (feedback.textContent !== unavailableNote) tell(feedback, unavailableNote, "error");
      return;
    }
    destination = null;
    if (feedback.textContent === unavailableNote) tell(feedback, "");
    if (!sameId(player.activeId(), stream.id)) chooseStream(stream);
  }

  function renderControls() {
    if (queueButton.hidden !== watchParty.queue.hidden) updatePanels();
    const own = mine();
    const sharing = screenShare?.active();
    const sharingHere = sharing && sameId(sharing.channel.id, channel.id);
    const nativeHere = localNative();
    const selection = player.activeId();
    const selectedHere = streams.find(stream => sameId(stream.id, selection));
    const watchingParty = watchParty.selected();
    const nextTitle = watchParty.currentTitle() || channel.title;
    node.toggleAttribute("data-watching", watchingParty);
    if (liveTitle.textContent !== nextTitle) {
      liveTitle.textContent = nextTitle;
      liveTitle.title = nextTitle;
    }
    closeWatch.hidden = !watchingParty;
    watchActions.hidden = closeWatch.hidden && watchParty.end.hidden;
    const previewMedia = sharingHere && sharing.phase === "live" && !selectedHere && !watchingParty ? sharing.media : null;
    reserve.hidden = !canStream || watchParty.canEnd() || Boolean(own || sharing || nativeBroadcast?.active());
    if (requestedShare && (requestedShare !== "screen" || streamsReady)) {
      const source = requestedShare;
      requestedShare = null;
      if (source !== "screen") watchParty.prepareSource(source);
      else if (!reserve.hidden) reserve.focus({ preventScroll: true });
      else tell(feedback, t("Screen sharing is unavailable in this channel.", "In diesem Kanal kannst du gerade keinen Bildschirm teilen."));
    }
    shareSettings.hidden = reserve.hidden || !capture.options;
    if (shareSettings.hidden) shareSettings.open = false;
    finish.hidden = (!own && !sharingHere) || Boolean(nativeHere && !selectedHere);
    finish.textContent = sharingHere && sharing.phase !== "live"
      ? t("Cancel screen sharing", "Bildschirmfreigabe abbrechen") : t("End my stream", "Meinen Stream beenden");
    const hasLive = streams.some(stream => stream.live) || watchParty.active();
    const watchNote = watchParty.active() && !streams.length
      ? t("Select the watch party to watch together.", "Öffne die Watchparty, um gemeinsam zuzuschauen.")
      : hasLive ? t("Choose a stream to watch.", "Wähle einen Stream zum Zuschauen.")
      : streams.length ? t("Waiting for the first stream to go live.", "Der erste Stream wird vorbereitet.")
        : t("Nobody is live here right now.", "Hier ist gerade niemand live.");
    if ((streamsReady || watchParty.active()) && empty.textContent !== watchNote) empty.textContent = watchNote;
    streamsSection.hidden = !streams.length && !watchParty.active();
    preview.hidden = !previewMedia;
    if (previewVideo.srcObject !== previewMedia) {
      previewVideo.srcObject = previewMedia;
      if (previewMedia) previewStage.append(previewVideo);
      else previewVideo.remove();
    }
    const nextAudience = own?.live && (!selectedHere || sameId(own.id, selectedHere.id)) ? own.id : undefined;
    if (nextAudience !== audienceId) {
      audienceScope?.abort();
      audienceId = nextAudience;
      audience.hidden = !audienceId;
      if (audienceId) {
        audienceScope = new AbortController();
        const audienceSignal = AbortSignal.any([signal, audienceScope.signal]);
        audience.replaceChildren(renderStreamAudience({ signal: audienceSignal }, audienceId));
      } else audience.replaceChildren();
    }
    const signature = JSON.stringify(streams);
    const displayed = selectedHere?.id ?? (previewMedia ? sharing.id : nativeHere?.streamId);
    if (signature === lastSignature && displayed === lastSelection) return;
    lastSignature = signature;
    lastSelection = displayed;
    const focused = document.activeElement?.dataset.streamId;
    const ordered = [...streams].sort((a, b) => Number(b.live) - Number(a.live));
    cards.replaceChildren(...ordered.map(stream => {
      const className = stream.live ? "tag live" : "tag";
      const person = streamer(stream);
      return button([
        el("span", { class: "stream-identity" }, personMark(person), personName(person)),
        el("span", { class: className }, stream.live ? t("Live", "Live") : t("Waiting", "Wartet")),
      ], () => {
        destination = null;
        if (feedback.textContent === unavailableNote) tell(feedback, "");
        chooseStream(stream);
      }, {
        class: "stream-pick", "aria-pressed": String(sameId(displayed, stream.id)), "data-stream-id": stream.id,
      });
    }));
    if (focused !== undefined) {
      [...cards.children].find(child => child.dataset.streamId === focused)?.focus({ preventScroll: true });
    }
  }

  async function requestStream() {
    if (pending || !canStream || mine() || screenShare?.active() || nativeBroadcast?.active()) return;
    autoSelectPending = false;
    shareSettings.open = false;
    tell(feedback, "");
    try {
      await capture.start();
      refreshSoon();
    } catch (error) {
      if (!signal.aborted) {
        tell(feedback, error.message, "error");
        refreshSoon();
      } else notify(error.message);
    }
  }

  async function endStream() {
    if (localNative()) {
      finish.disabled = true;
      try {
        await nativeBroadcast.stop();
        refreshSoon();
      } catch (error) {
        if (!signal.aborted) tell(feedback, error.message, "error");
      } finally {
        finish.disabled = false;
      }
      return;
    }
    const sharing = screenShare?.active();
    if (sharing && sameId(sharing.channel.id, channel.id)) {
      screenShare.stop(t("Stream ended.", "Stream beendet."));
      streams = streams.filter(item => !sameId(item.id, sharing.id));
      player.end(sharing.id);
      renderControls();
      refreshSoon();
      return;
    }
    const stream = mine();
    if (!stream || pending) return;
    pending = true;
    finish.disabled = true;
    try {
      await api("streams/" + identifier(stream.id), { method: "DELETE", signal });
      if (signal.aborted) return;
      streams = streams.filter(item => !sameId(item.id, stream.id));
      player.end(stream.id);
      renderControls();
      notify(t("Stream ended.", "Stream beendet."));
    } catch (error) {
      if (!signal.aborted) tell(feedback, error.message, "error");
    } finally {
      pending = false;
      finish.disabled = false;
    }
  }

  function refreshSoon() {
    if (signal.aborted || polling) return;
    clearTimeout(timer);
    refresh();
  }

  function sharingChanged() {
    const sharing = screenShare?.active();
    const localStream = localNative()?.streamId ?? (sameId(sharing?.channel.id, channel.id) && sharing.phase === "live" ? sharing.id : null);
    if (localStream && !sameId(localStream, lastLocalStream)) {
      lastLocalStream = localStream;
      watchParty.leave();
      if (streams.some(stream => sameId(stream.id, player.activeId()))) player.stop();
    } else if (!localStream) {
      lastLocalStream = null;
    }
    renderControls();
    refreshSoon();
  }

  async function refresh() {
    if (signal.aborted || polling) return;
    polling = true;
    try {
      const data = await api(endpoint, { signal });
      if (signal.aborted) return;
      if (!pending) {
        streams = data.streams ?? [];
        streamsReady = true;
        canStream = Boolean(data.canStream);
        selectDestination();
        selectInitialPlayback();
        renderControls();
      }
      if (!feedback.textContent || feedback.textContent === reconnectNote) tell(feedback, "");
    } catch (error) {
      if (signal.aborted) return;
      if (error.status === 403 || error.status === 404) {
        context.refresh();
        return;
      }
      tell(feedback, reconnectNote, "error");
    } finally {
      polling = false;
    }
    if (!signal.aborted) timer = setTimeout(refresh, 4000);
  }

  const people = el("div", {
    class: "panel live-channel-people", id: "live-channel-people", "data-tutorial": "live-people",
    role: "tabpanel", "aria-labelledby": peopleButton.id, tabindex: 0,
  }, voiceMount, streamsSection);
  const chatPanel = el("div", {
    class: "live-channel-chat", id: "live-channel-chat", "data-tutorial": "live-chat",
  }, chat, audience);
  const queuePanel = el("div", {
    class: "live-channel-queue", id: "live-channel-queue", role: "tabpanel", "aria-labelledby": queueButton.id,
    tabindex: 0, hidden: true,
  }, watchParty.queue);
  const panels = [["chat", chatButton, chatPanel], ["queue", queueButton, queuePanel], ["people", peopleButton, people]];
  const tablist = el("div", { class: "live-channel-switch", role: "tablist",
    "aria-label": t("Live channel view", "Live-Channel-Ansicht"),
  }, chatButton, queueButton, peopleButton);
  tablist.addEventListener("keydown", event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const available = panels.filter(([, tab]) => !tab.hidden);
    const current = available.findIndex(([, tab]) => tab === event.target);
    if (current === -1) return;
    let index;
    if (event.key === "Home") index = 0;
    else if (event.key === "End") index = available.length - 1;
    else if (event.key === "ArrowLeft") index = (current + available.length - 1) % available.length;
    else if (event.key === "ArrowRight") index = (current + 1) % available.length;
    else return;
    event.preventDefault();
    const [panel, tab] = available[index];
    setPanel(panel);
    tab.focus();
  }, { signal });
  const node = el("section", {
    class: "panel live-channel", "aria-label": channel.title,
  }, el("header", { class: "live-channel-toolbar" },
    el("div", { class: "live-channel-title" }, liveTitle),
    el("div", { class: "inline live-channel-tools" }, shareSettings, reserve, watchParty.share, finish), feedback),
  el("div", { class: "live-channel-body" },
    el("div", { class: "live-channel-watch" }, playerMount, preview,
      nativePreview && el("div", { class: "live-channel-native" }, nativePreview), watchSlot, watchHint),
    el("div", { class: "live-channel-support" },
      el("div", { class: "live-channel-support-toolbar" }, watchActions, tablist), people, chatPanel, queuePanel)));
  updatePanels();
  node.addEventListener("open-message", event => {
    if (event.detail?.messageId) showChatTarget(event.detail);
    if (event.detail?.shareSource) {
      autoSelectPending = false;
      requestedShare = event.detail.shareSource;
      renderControls();
      return;
    }
    if (event.detail?.watchId) {
      autoSelectPending = false;
      destination = null;
      watchParty.open(event.detail.watchId);
      return;
    }
    if (event.detail?.streamId) autoSelectPending = false;
    destination = event.detail?.streamId ? event.detail : null;
    selectDestination();
    renderControls();
  }, { signal });
  showChatTarget(context);
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    previewVideo.srcObject = null;
  }, { once: true });
  player.whenChanged(renderControls, { signal });
  screenShare?.whenChanged(sharingChanged, { signal });
  nativeBroadcast?.whenChanged(sharingChanged, { signal });
  sharingChanged();
  return { node, people, setSupportSidebar };
}
