import { api, button, el, identifier, notify, personMark, personName, sameId, status, tell, topicHref } from "./ui.js";
import { language, t } from "./i18n.js";
import { renderStreamAudience } from "./stream-audience.js";
import { renderStreamChat } from "./stream-chat.js";
import { desktopShareControls } from "./desktop-share.js";

const viewerHeartbeat = 8000;
const startupTimeout = 24000;
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
  const close = button("×", () => stop(t("Playback stopped.", "Wiedergabe beendet.")), { "aria-label": t("Stop playback", "Wiedergabe beenden"), title: t("Stop playback", "Wiedergabe beenden"), class: "icon-button", hidden: true });
  const node = el("section", { class: "panel live-player stack", hidden: true, "aria-label": t("Stream player", "Stream-Player") },
    el("div", { class: "section-heading player-heading" }, heading, el("div", { class: "inline" }, sound, returnLink, close)),
    el("div", { class: "stage" }, video, overlay));
  const dockLabel = el("span", {}, "Stream");
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

  function show(label, description, action = "") {
    overlay.hidden = false;
    video.controls = false;
    video.setAttribute("aria-hidden", "true");
    title.textContent = label;
    detail.textContent = description;
    start.hidden = !action;
    start.textContent = action;
    updateSound();
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
      dockLabel.textContent = "Stream · " + person.displayName;
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id, playerId: viewerPlayerId, revision: ++viewerRevision }),
      keepalive: leaving,
      signal: leaving ? undefined : AbortSignal.timeout(6000),
    }).catch(() => { /* A lost heartbeat expires automatically. */ });
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
    hls = null;
    playback = null;
    old?.destroy();
    video.pause();
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
    const switchToNative = allowNative && playback.usingHlsJs && playback.nativeAvailable;
    disconnect();
    if (switchToNative) selected.nativeOnly = true;
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
  window.addEventListener("pagehide", releaseViewer, { signal });
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return;
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

export function renderLive(context, channel, edit, player) {
  const { signal, user, room, screenShare } = context;
  const endpoint = streamsPath(channel);
  const cards = el("div", { class: "stream-list" });
  const chat = el("div", { class: "stack", hidden: true });
  const empty = el("p", { class: "muted", role: "status" }, t("Loading streams…", "Streams werden geladen …"));
  const feedback = status();
  const previewTitle = t("Your stream preview", "Deine Stream-Vorschau");
  const previewVideo = el("video", { autoplay: true, playsinline: true, "aria-label": previewTitle });
  previewVideo.muted = true;
  const previewStage = el("div", { class: "stage" });
  const preview = el("section", { class: "stack screen-preview", hidden: true, "aria-label": previewTitle },
    el("h3", {}, previewTitle), previewStage);
  const reconnectNote = t("Reconnecting the stream list.", "Die Stream-Liste wird neu verbunden.");
  const unavailableNote = t("The mentioned stream is unavailable.", "Der erwähnte Stream ist nicht verfügbar.");
  const desktop = window.webkit?.messageHandlers?.roomsCapture;
  const portableShare = window.roomsDesktop === true && !desktop ? desktopShareControls() : null;
  const reserve = button(t("Share screen", "Bildschirm teilen"), requestStream, { class: "primary", hidden: true });
  const audio = el("input", { type: "checkbox" });
  const audioOption = el("label", { class: "inline subtle", hidden: true }, audio,
    t("Include tab or app audio when available", "Tab- oder Anwendungston teilen, wenn verfügbar"));
  const finish = button(t("End my stream", "Meinen Stream beenden"), endStream, { class: "danger", hidden: true });
  let streams = [];
  let streamsReady = false;
  let canStream = false;
  let pending = false;
  let timer;
  let polling = false;
  let lastSignature;
  let lastSelection;
  let chatScope;
  let chatStreamId;
  let chatNode;
  let destination = context.streamId ? { streamId: context.streamId, messageId: context.messageId } : null;

  function mine() {
    return streams.find(stream => sameId(stream.userId, user.id));
  }

  function chooseStream(stream) {
    if (sameId(screenShare?.active()?.id, stream.id)) {
      if (player.activeId()) player.stop();
    } else player.choose(channel, stream);
  }

  function selectDestination() {
    if (!destination || !streamsReady) return;
    const stream = streams.find(item => item.live && sameId(item.id, destination.streamId));
    if (!stream) {
      if (feedback.textContent !== unavailableNote) tell(feedback, unavailableNote, "error");
      return;
    }
    if (feedback.textContent === unavailableNote) tell(feedback, "");
    if (!sameId(player.activeId(), stream.id)) chooseStream(stream);
  }

  function renderControls() {
    const own = mine();
    const sharing = screenShare?.active();
    const sharingHere = sharing && sameId(sharing.channel.id, channel.id);
    reserve.hidden = !canStream || Boolean(own || sharing);
    audioOption.hidden = Boolean(desktop || portableShare) || reserve.hidden;
    if (portableShare) portableShare.element.hidden = reserve.hidden;
    finish.hidden = !own && !sharingHere;
    finish.textContent = sharingHere && sharing.phase !== "live"
      ? t("Cancel screen sharing", "Bildschirmfreigabe abbrechen") : t("End my stream", "Meinen Stream beenden");
    empty.hidden = streams.length > 0;
    if (!streams.length) empty.textContent = canStream ? t("Nobody is live here right now.", "Hier ist gerade niemand live.") : t("No streams in this channel right now.", "Gerade läuft kein Stream in diesem Channel.");
    const selection = player.activeId();
    const selectedHere = streams.find(stream => sameId(stream.id, selection));
    const previewMedia = sharingHere && sharing.phase === "live" && !selectedHere ? sharing.media : null;
    preview.hidden = !previewMedia;
    if (previewVideo.srcObject !== previewMedia) {
      previewVideo.srcObject = previewMedia;
      if (previewMedia) previewStage.append(previewVideo);
      else previewVideo.remove();
    }
    const nextChat = (selectedHere?.live ? selectedHere : null) ?? (own?.live ? own : null);
    const nextChatId = nextChat?.id;
    const target = nextChatId && sameId(nextChatId, destination?.streamId) ? destination : null;
    if (target) destination = null;
    if (nextChatId !== chatStreamId) {
      chatScope?.abort();
      chatStreamId = nextChatId;
      chat.hidden = !nextChatId;
      if (nextChatId) {
        chatScope = new AbortController();
        const chatSignal = AbortSignal.any([signal, chatScope.signal]);
        chatNode = renderStreamChat({ ...context, signal: chatSignal, messageId: target?.messageId }, nextChatId);
        if (sameId(nextChat.userId, user.id)) chat.replaceChildren(renderStreamAudience({ signal: chatSignal }, nextChatId), chatNode);
        else chat.replaceChildren(chatNode);
      } else {
        chatNode = null;
        chat.replaceChildren();
      }
    } else if (target?.messageId) {
      chatNode?.dispatchEvent(new CustomEvent("open-message", { detail: target }));
    }
    const signature = JSON.stringify(streams);
    const displayed = selectedHere?.id ?? (previewMedia ? sharing.id : null);
    if (signature === lastSignature && displayed === lastSelection) return;
    lastSignature = signature;
    lastSelection = displayed;
    const focused = document.activeElement?.dataset.streamId;
    cards.replaceChildren(...streams.map(stream => {
      const className = stream.live ? "tag live" : "tag";
      const person = streamer(stream);
      return button([
        el("span", { class: "stream-identity" }, personMark(person), personName(person)),
        el("span", { class: className }, stream.live ? "Live" : t("Waiting", "Wartet")),
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
    if (pending || !canStream || mine() || screenShare?.active()) return;
    tell(feedback, "");
    try {
      if (desktop) {
        desktop.postMessage({ action: "open", channelId: channel.id, language: language() });
        return;
      }
      await screenShare.start(room, channel, audio.checked, portableShare?.options());
      refreshSoon();
    } catch (error) {
      if (!signal.aborted) {
        tell(feedback, error.message, "error");
        refreshSoon();
      } else notify(error.message);
    }
  }

  async function endStream() {
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

  const node = el("section", { class: "panel stack" },
    el("div", { class: "section-heading" }, el("h2", {}, channel.title), edit),
    portableShare?.element,
    el("div", { class: "inline" }, reserve, audioOption, finish),
    cards, empty, feedback, preview, chat);
  node.addEventListener("open-message", event => {
    destination = event.detail?.streamId ? event.detail : null;
    selectDestination();
    renderControls();
  }, { signal });
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    previewVideo.srcObject = null;
  }, { once: true });
  player.whenChanged(renderControls, { signal });
  screenShare?.whenChanged(renderControls, { signal });
  refresh();
  return node;
}
