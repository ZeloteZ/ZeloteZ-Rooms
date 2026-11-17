import { t } from "./i18n.js";
import { api, button, closeDialog, el, field, form, identifier, showDialog, status, tell, topicHref } from "./ui.js";
import { createYoutubePlayer } from "./youtube-player.js";
import { createWatchControls } from "./watch-controls.js";
import { createWatchViewerLease, reportWatchViewer } from "./watch-viewers.js";
import { watchQueue } from "./watch-queue.js";

const chunkSize = 4 * 1024 * 1024;
const maxFileSize = 64 * chunkSize;
const youtubeId = /^[a-zA-Z0-9_-]{11}$/u;
const youtubeHosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "www.youtube-nocookie.com"]);

export function youtubeVideoId(value) {
  const input = value.trim();
  if (youtubeId.test(input)) return input;
  let url;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
  let id;
  if (url.hostname === "youtu.be") id = /^\/([^/]+)\/?$/u.exec(url.pathname)?.[1];
  if (youtubeHosts.has(url.hostname)) {
    id = url.pathname === "/watch" ? url.searchParams.get("v")
      : /^\/(?:embed|shorts|live)\/([^/]+)\/?$/u.exec(url.pathname)?.[1];
  }
  return youtubeId.test(id ?? "") ? id : null;
}

function localVideoType(file) {
  if (/\.mp4$/iu.test(file.name)) return "video/mp4";
  if (/\.webm$/iu.test(file.name)) return "video/webm";
  return null;
}

function localPlayer(url, { onReady, onError, onEnded, onBlocked }) {
  const element = el("video", { playsinline: true, preload: "auto", "aria-label": t("Shared video", "Geteiltes Video") });
  element.addEventListener("loadedmetadata", onReady, { once: true });
  element.addEventListener("ended", onEnded);
  element.addEventListener("error", onError);
  element.src = url;
  return {
    element,
    play: () => element.play().catch(error => { if (error.name === "NotAllowedError") onBlocked(); }),
    pause: () => element.pause(),
    seek: seconds => { element.currentTime = seconds; },
    setVolume(volume, muted) { element.volume = volume; element.muted = muted; },
    getTime: () => element.currentTime,
    getDuration: () => element.duration,
    destroy: () => { element.pause(); element.removeAttribute("src"); element.load(); },
  };
}

export function createWatchParty(context, channel, options) {
  const { signal, videoDock, watchId } = context;
  if (!videoDock || options.setupOnly || !options.mount) {
    const party = createParty(context, channel, options);
    options.mount?.append(party.player);
    return party;
  }
  const entry = videoDock.get("watch:" + channel.id, entry =>
    createParty({ ...context, signal: entry.signal }, channel, {}, entry));
  entry.instance.connectView(options, watchId);
  entry.mount(options.mount, signal, () => entry.instance.disconnectView());
  return entry.instance;
}

function createParty({ signal, user, watchId, room, quickRoomHeader }, channel, options, dockEntry) {
  let view = options;
  const { setupOnly = false } = options;
  const endpoint = "channels/" + identifier(channel.id) + "/watch";
  const playbackLabel = t("Watch party", "Watchparty");
  const sourceLimit = room?.temporary ? room.quickSource : null;
  const share = button(t("Share video", "Video teilen"), () => chooseSource(false), { class: "primary", hidden: true });
  const queue = watchQueue({ add: () => chooseSource(true), remove: removeQueuedVideo,
    next: () => void change("next", undefined, queue.feedback) });
  const cardName = el("strong");
  const cardSource = el("small", { class: "muted" });
  const card = button([el("span", { class: "watch-party-card-title" }, cardName, cardSource),
    el("span", { class: "tag watch-party-tag" }, playbackLabel)], join,
  { class: "stream-pick watch-party-card", hidden: true, "aria-pressed": "false" });
  const title = el("h3");
  const statusNode = status();
  const media = el("div", { class: "watch-party-media", "data-watch-media": true });
  const enable = button(t("Enable playback on this device", "Wiedergabe auf diesem Gerät erlauben"), enablePlayback,
    { hidden: true });
  const controls = createWatchControls({
    signal,
    onToggle() {
      if (!sample || !ready) return;
      if (sample.party.playing) return void change("pause");
      const start = restartPosition();
      if (start === 0) surface.seek(0);
      if (sample.party.source !== "youtube") surface.play();
      void change("play", start);
    },
    onSeek: position => void change("seek", position),
    onVolume: (volume, muted) => surface?.setVolume(volume, muted),
    fullscreenTarget: () => player,
  });
  const stopTitle = t("End watch party", "Watchparty beenden");
  const stop = button(stopTitle, stopParty, { class: "danger watch-party-stop", hidden: true });
  const end = button(stopTitle, stopParty, { class: "danger watch-party-end", hidden: true });
  const leave = button("×", leaveParty, { class: "ghost icon-button", title: t("Close player", "Player schließen"),
    "aria-label": t("Close player", "Player schließen") });
  const player = el("section", { class: "panel watch-party-player", hidden: true, "aria-label": playbackLabel },
    el("header", { class: "section-heading watch-party-heading" }, title, el("div", { class: "inline" }, stop, leave)),
    media,
    el("div", { class: "watch-party-footer" }, controls.element, enable, statusNode));

  let sample;
  let hasSnapshot = false;
  let linkedId = watchId;
  let requestedSource;
  let selectedId;
  let surface;
  let audience;
  let ready = false;
  let appliedRevision;
  let nativeIntent;
  let canShare = false;
  let canStop = false;
  let busy = false;
  let polling = false;
  let generation = 0;
  let pollTimer;
  let clockTimer;

  function desiredPosition() {
    const now = performance.now();
    const { party, refreshedAt, age } = sample;
    const position = party.position + (party.playing ? Math.max(0, age + now - refreshedAt) / 1000 : 0);
    const duration = surface?.getDuration();
    return Number.isFinite(duration) && duration > 0 ? Math.min(position, duration) : position;
  }

  function restartPosition() {
    const duration = surface.getDuration();
    if (Number.isFinite(duration) && duration > 0 && desiredPosition() >= duration - 0.15) return 0;
  }

  function sync(force = false) {
    const party = sample?.party;
    if (!party || selectedId !== party.id || !surface || !ready || nativeIntent) return;
    const position = desiredPosition();
    const changed = appliedRevision !== party.revision;
    const drift = Math.abs(surface.getTime() - position);
    if (drift > (force ? 0.075 : party.playing && !changed ? 2.25 : 0.3)) surface.seek(position);
    if (force || changed) {
      appliedRevision = party.revision;
      if (party.playing) surface.play();
      else {
        surface.pause();
        enable.hidden = true;
      }
    }
    controls.setPosition(position, surface.getDuration());
  }

  function tick() {
    if (selectedId && ready) controls.setPosition(desiredPosition(), surface.getDuration());
  }

  function canEnd() {
    return !setupOnly && canStop && Boolean(sample?.party);
  }

  function render() {
    const party = sample?.party;
    const isReady = party?.state === "ready";
    share.hidden = !canShare || canEnd() || (setupOnly && Boolean(party));
    share.disabled = busy || Boolean(party);
    share.title = party ? t("A watch party is already shared in this channel.", "In diesem Kanal wird bereits ein Video geteilt.") : "";
    card.hidden = !isReady;
    card.setAttribute("aria-pressed", String(Boolean(selectedId)));
    if (isReady) {
      cardName.textContent = party.title || (party.source === "youtube" ? t("YouTube video", "YouTube-Video") : t("Local video", "Lokales Video"));
      cardSource.textContent = party.source === "youtube" ? "YouTube" : t("Room video", "Raumvideo");
      title.textContent = cardName.textContent;
    }
    stop.hidden = end.hidden = !canEnd();
    stop.disabled = end.disabled = busy;
    controls.setTransport({ isPlaying: party?.playing, enabled: !busy && ready });
    queue.update(sample?.queue, { visible: isReady, manage: canShare, pending: busy });
    if (selectedId) dockEntry?.activate(title.textContent, topicHref(room.id, channel.id, { watchId: party?.sessionId ?? selectedId }));
    view?.onChange?.();
  }

  function clearSurface(keepFullscreen = false) {
    const previous = surface;
    surface = null;
    ready = false;
    controls.resetPosition();
    appliedRevision = undefined;
    nativeIntent = undefined;
    audience?.stop();
    audience = undefined;
    clearInterval(clockTimer);
    previous?.destroy();
    if (!keepFullscreen) controls.setFullscreenSurface(null);
    media.replaceChildren();
  }

  function leaveParty() {
    const hadSelection = Boolean(selectedId);
    selectedId = null;
    clearSurface();
    player.hidden = true;
    dockEntry?.deactivate();
    enable.hidden = true;
    tell(statusNode, "");
    if (hadSelection && !signal.aborted) render();
  }

  function join() {
    const party = sample?.party;
    if (setupOnly || party?.state !== "ready" || selectedId === party.id || signal.aborted) return;
    selectedId = party.id;
    view?.onSelect?.();
    player.hidden = false;
    resetPlayer(party);
    render();
  }

  function open(id) {
    linkedId = id;
    openDestination();
  }

  function openDestination() {
    if (!linkedId || !hasSnapshot || signal.aborted) return;
    const id = linkedId;
    linkedId = undefined;
    const party = sample?.party;
    if (party?.state === "ready" && (party.id === id || party.sessionId === id)) join();
    else view?.onUnavailable?.();
  }

  function prepareSource(source) {
    requestedSource = source;
    openRequestedSource();
  }

  function openRequestedSource() {
    if (!requestedSource || signal.aborted) return;
    if (sourceLimit === "screen" || (sourceLimit && sourceLimit !== requestedSource)) {
      requestedSource = undefined;
      view?.onShareUnavailable?.();
      return;
    }
    if (!hasSnapshot) return;
    const source = requestedSource;
    requestedSource = undefined;
    if (!canShare || sample?.party || busy) view?.onShareUnavailable?.();
    else if (source === "youtube") youtubeForm();
    else if (source === "local") localForm();
  }

  function resetPlayer(party) {
    tell(statusNode, t("Loading video…", "Video wird geladen …"));
    const current = () => selectedId === party.id && !signal.aborted;
    if (party.source === "youtube") {
      const viewers = "/api/" + endpoint + "/" + identifier(party.id) + "/viewers";
      audience = createWatchViewerLease({ signal, report: options => reportWatchViewer(viewers, options, { accountId: user.id }) });
    }
    const handlers = {
      onReady() {
        if (!current()) return;
        ready = true;
        tell(statusNode, "");
        const { volume, muted } = controls.volumeState();
        surface.setVolume(volume, muted);
        sync(true);
        render();
      },
      onError() {
        if (!current()) return;
        ready = false;
        audience?.setVisible(false);
        const description = party.source === "youtube"
          ? t("YouTube couldn’t play this embedded video.", "YouTube konnte dieses eingebettete Video nicht abspielen.")
          : t("This device couldn’t play the video format.", "Dieses Gerät konnte das Videoformat nicht abspielen.");
        tell(statusNode, description, "error");
        render();
      },
      onEnded() {
        if (!current() || !sample?.party.playing) return;
        const duration = surface.getDuration();
        if (Number.isFinite(duration) && duration > 0 && desiredPosition() >= duration - 1) void change("ended", duration);
      },
      onBlocked() {
        if (current() && sample?.party.playing) enable.hidden = false;
      },
      onPlaying() {
        if (current()) enable.hidden = true;
      },
      onPlaybackChange(playing) {
        if (!current() || !ready) return;
        nativeIntent = { id: party.id, playing };
        sendNativeIntent();
      },
      onVolumeChange(volume, muted) {
        if (current() && ready) controls.setVolume(volume, muted);
      },
      onVisibility(visible) {
        audience?.setVisible(visible);
        if (visible && current()) {
          appliedRevision = undefined;
          schedule(0);
        }
      },
      onTitle(value) {
        if (!current() || party.hostId !== user?.id || sample?.party.title) return;
        const title = [...value.trim()].slice(0, 120).join("");
        void api(endpoint + "/" + identifier(party.id) + "/metadata", { method: "PATCH", body: { title }, signal })
          .then(() => schedule(0), () => {});
      },
    };
    surface = party.source === "youtube" ? createYoutubePlayer(party.videoId, handlers)
      : localPlayer("/api/" + endpoint + "/" + identifier(party.id) + "/media", handlers);
    media.replaceChildren(surface.element);
    controls.setFullscreenSurface(surface.element);
    clockTimer = setInterval(tick, 250);
  }

  function enablePlayback() {
    if (!surface || !sample?.party.playing) return;
    enable.hidden = true;
    sync(true);
  }

  function apply(data, requestedAt = performance.now()) {
    const refreshedAt = performance.now();
    const party = data.party ?? null;
    const changedVideo = Boolean(selectedId && selectedId !== party?.id);
    const advancing = changedVideo && party?.state === "ready" && party.sessionId && party.sessionId === sample?.party.sessionId;
    if (changedVideo && !advancing) leaveParty();
    sample = party ? { party, queue: data.queue, refreshedAt, age: data.serverTime - party.updatedAt + (refreshedAt - requestedAt) / 2 } : null;
    if (advancing) {
      selectedId = party.id;
      clearSurface(true);
      resetPlayer(party);
    }
    hasSnapshot = true;
    if (typeof data.canShare === "boolean") canShare = data.canShare;
    if (typeof data.canStop === "boolean") canStop = data.canStop;
    sync();
    render();
    openDestination();
    openRequestedSource();
  }

  function schedule(delay = sample?.party ? 1200 : 4000) {
    clearTimeout(pollTimer);
    if (!signal.aborted) pollTimer = setTimeout(refresh, delay);
  }

  async function refresh() {
    if (signal.aborted) return;
    if (busy || polling) return schedule();
    polling = true;
    const version = generation;
    const requestedAt = performance.now();
    try {
      const response = await api(endpoint, { signal });
      if (!signal.aborted && version === generation) apply(response, requestedAt);
    } catch (error) {
      if (!signal.aborted && version === generation && [401, 403, 404].includes(error.status)) {
        apply({ party: null, canShare: false, canStop: false });
      }
    } finally {
      polling = false;
      schedule();
    }
  }

  async function run(operation, report = statusNode) {
    if (busy || signal.aborted) return false;
    busy = true;
    generation++;
    if (report === statusNode) tell(statusNode, "");
    render();
    try {
      await operation();
      return true;
    } catch (error) {
      if (!signal.aborted && error.name !== "AbortError") tell(report, error.message, "error");
      return false;
    } finally {
      busy = false;
      if (!signal.aborted) {
        render();
        schedule(0);
        sendNativeIntent();
      }
    }
  }

  function sendNativeIntent() {
    if (!nativeIntent || busy || signal.aborted) return;
    const intent = nativeIntent;
    nativeIntent = undefined;
    const party = sample?.party;
    if (selectedId !== intent.id || party?.id !== intent.id || !ready) return;
    if (intent.playing === party.playing) {
      sync(true);
      return;
    }
    void change(intent.playing ? "play" : "pause", intent.playing ? restartPosition() : undefined);
  }

  function change(action, position, feedback = statusNode) {
    const party = sample?.party;
    if (!party || (action === "next" ? !canShare : selectedId !== party.id)) return;
    return run(async () => {
      if (action === "play" && audience && !await audience.ensure()) {
        sync(true);
        throw new Error(t("Open the video player to start playback.", "Öffne den Videoplayer, um die Wiedergabe zu starten."));
      }
      if (signal.aborted || sample?.party.id !== party.id || (action !== "next" && selectedId !== party.id)) return;
      const startedAt = performance.now();
      try {
        const result = await api(endpoint + "/" + identifier(party.id), {
          method: "PATCH", body: { action, position, revision: party.revision }, signal,
        });
        if (!signal.aborted) apply(result, startedAt);
      } catch (error) {
        if (error.status !== 409 && error.status !== 404) {
          sync(true);
          throw error;
        }
        appliedRevision = undefined;
        const refreshedAt = performance.now();
        const newest = await api(endpoint, { signal });
        if (!signal.aborted) apply(newest, refreshedAt);
        if (action !== "ended") tell(feedback, t("Playback changed in the room. The player will catch up.", "Die Wiedergabe wurde im Raum geändert. Der Player gleicht sie ab."));
      }
    }, feedback);
  }

  function removeQueuedVideo(id) {
    if (!canShare) return;
    tell(queue.feedback, "");
    void run(async () => {
      const data = await api(endpoint + "/" + identifier(id) + "/queue", { method: "DELETE", signal });
      if (!signal.aborted) apply(data);
    }, queue.feedback);
  }

  function stopParty() {
    const party = sample?.party;
    if (!canStop || !party) return;
    void run(async () => {
      await api(endpoint + "/" + identifier(party.id), { method: "DELETE", signal });
      if (room?.temporary) quickRoomHeader.ended(room.id);
      if (!signal.aborted) apply({ party: null, canStop: false, canShare });
    });
  }

  function chooseSource(enqueue) {
    if (!canShare || busy) return;
    const behind = enqueue && sample?.party?.state === "ready" ? sample.party.id : undefined;
    if (enqueue ? !behind : sample?.party) return;
    if (!enqueue && sourceLimit) {
      prepareSource(sourceLimit);
      return;
    }
    showDialog(enqueue ? t("Add video", "Video hinzufügen") : t("Share video", "Video teilen"), el("div", { class: "watch-party-sources" },
      button(enqueue ? t("YouTube video", "YouTube-Video") : t("Share YouTube video", "YouTube-Video teilen"), () => youtubeForm(behind)),
      button(enqueue ? t("Local video", "Lokales Video") : t("Share local video", "Lokales Video teilen"), () => localForm(behind))));
  }

  function videoEndpoint(behind) {
    return behind ? endpoint + "/" + identifier(behind) + "/queue" : endpoint;
  }

  function youtubeForm(behind) {
    const input = el("input", { type: "text", inputmode: "url", required: true, maxlength: 2048,
      placeholder: "https://youtu.be/…", spellcheck: "false", autocomplete: "off" });
    showDialog(t("Share YouTube video", "YouTube-Video teilen"), form([
      field(t("YouTube link", "YouTube-Link"), input),
      el("p", { class: "muted" }, t("Viewers connect to YouTube when they open the player.", "Beim Öffnen des Players verbinden sich Zuschauer mit YouTube.")),
    ], behind ? t("Add to queue", "Zur Warteschlange hinzufügen") : t("Share", "Teilen"), async feedback => {
      const videoId = youtubeVideoId(input.value);
      if (!videoId) throw new Error(t("Enter a YouTube video link.", "Gib einen Link zu einem YouTube-Video ein."));
      if (await run(async () => {
        const data = await api(videoEndpoint(behind), { method: "POST", body: { source: "youtube", videoId }, signal });
        if (!signal.aborted) apply(data);
      }, feedback) && !signal.aborted) {
        closeDialog();
        if (!behind) join();
      }
    }));
    input.focus();
  }

  function localForm(behind) {
    const input = el("input", { type: "file", accept: "video/mp4,video/webm,.mp4,.webm", required: true });
    const uploadProgress = el("progress", { max: 100, value: 0, hidden: true, "aria-label": t("Upload progress", "Upload-Fortschritt") });
    showDialog(t("Share local video", "Lokales Video teilen"), form([
      field(t("Video file", "Videodatei"), input),
      el("p", { class: "muted" }, t("MP4 or WebM up to 256 MiB. Rooms temporarily stores the original for playback in this channel.",
        "MP4 oder WebM bis 256 MiB. Rooms speichert das Original vorübergehend für die Wiedergabe in diesem Kanal.")), uploadProgress,
    ], behind ? t("Upload & add", "Hochladen und hinzufügen") : t("Upload & share", "Hochladen und teilen"), async (feedback, uploadForm) => {
      const file = input.files?.[0];
      const mime = file && localVideoType(file);
      if (!mime || !file.size || file.size > maxFileSize) {
        throw new Error(t("Choose an MP4 or WebM file up to 256 MiB.", "Wähle eine MP4- oder WebM-Datei bis 256 MiB."));
      }
      const upload = new AbortController();
      const uploadSignal = AbortSignal.any([signal, upload.signal]);
      uploadForm.closest("dialog").addEventListener("close", () => upload.abort(), { once: true, signal: uploadSignal });
      uploadProgress.value = 0;
      uploadProgress.hidden = false;
      input.disabled = true;
      const complete = await run(async () => {
        let uploadedParty;
        try {
          let data = await api(videoEndpoint(behind), { method: "POST", body: {
            source: "local", mime, size: file.size, title: [...file.name.replace(/\.[^.]+$/u, "")].slice(0, 120).join(""),
          }, signal: uploadSignal });
          uploadedParty = identifier(behind ? data.enqueued.id : data.party.id);
          if (behind && !signal.aborted) apply(data);
          for (let offset = 0; offset < file.size;) {
            if (!uploadForm.isConnected) throw new DOMException("Upload closed", "AbortError");
            data = await api(endpoint + "/" + uploadedParty + "/upload?offset=" + offset, {
              method: "PUT", binary: true, body: file.slice(offset, offset + chunkSize), signal: uploadSignal,
            });
            if (!Number.isSafeInteger(data.offset) || data.offset <= offset || data.offset > file.size) throw new Error(
              t("The server couldn’t confirm the upload.", "Der Server konnte den Upload nicht bestätigen."));
            offset = data.offset;
            uploadProgress.value = Math.floor(offset / file.size * 100);
          }
          if (!data.complete || !data.party) throw new Error(t("The upload didn’t finish.", "Der Upload wurde nicht abgeschlossen."));
          if (!signal.aborted) apply(data);
        } catch (error) {
          if (uploadedParty) void api(endpoint + "/" + uploadedParty + (behind ? "/queue" : ""), { method: "DELETE", keepalive: true }).catch(() => {});
          throw error;
        }
      }, feedback);
      upload.abort();
      input.disabled = false;
      uploadProgress.hidden = true;
      if (complete && !signal.aborted && uploadForm.isConnected) {
        closeDialog();
        if (!behind) join();
      }
    }));
    input.focus();
  }

  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(0); }, { signal });
  signal.addEventListener("abort", () => {
    clearTimeout(pollTimer);
    leaveParty();
  }, { once: true });
  if (sourceLimit !== "screen") schedule(0);
  return { share, end, canEnd, card, player, queue: queue.node, active: () => sample?.party.state === "ready", hasSnapshot: () => hasSnapshot,
    selected: () => Boolean(selectedId), currentTitle: () => selectedId ? title.textContent : "", join, leave: leaveParty, open, prepareSource,
    stopPlayback: leaveParty,
    connectView(options, id) {
      view = options;
      linkedId = id;
      schedule(0);
    },
    disconnectView() {
      view = undefined;
      linkedId = undefined;
      requestedSource = undefined;
    },
    reconnectAfterMove() {
      if (!selectedId || !surface) return;
      if (sample.party.source === "youtube") {
        ready = false;
        audience?.stop();
        audience = undefined;
        surface.destroy();
        clearInterval(clockTimer);
        resetPlayer(sample.party);
      } else if (sample.party.playing) surface.play();
    },
  };
}
