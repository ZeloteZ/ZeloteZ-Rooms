import { t } from "./i18n.js";
import { api, button, closeDialog, el, field, form, identifier, showDialog, status, tell } from "./ui.js";
import { createYoutubePlayer } from "./youtube-player.js";
import { createWatchControls } from "./watch-controls.js";

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
    setVolume: value => { element.volume = value; element.muted = value === 0; },
    getTime: () => element.currentTime,
    getDuration: () => element.duration,
    destroy: () => { element.pause(); element.removeAttribute("src"); element.load(); },
  };
}

export function createWatchParty({ signal, user, watchId, room, quickRoomHeader }, channel,
  { onSelect, onChange, onUnavailable, onShareUnavailable, setupOnly = false }) {
  const endpoint = "channels/" + identifier(channel.id) + "/watch";
  const playbackLabel = t("Watch party", "Watchparty");
  const sourceLimit = room?.temporary ? room.quickSource : null;
  const share = button(t("Share video", "Video teilen"), chooseSource, { hidden: true });
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
      surface.play();
      void change("play", start);
    },
    onSeek: position => void change("seek", position),
    onVolume: level => surface?.setVolume(level),
    fullscreenTarget: () => player,
  });
  const stop = button(t("End watch party", "Watchparty beenden"), stopParty, { class: "danger", hidden: true });
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

  function render() {
    const party = sample?.party;
    const isReady = party?.state === "ready";
    share.hidden = !canShare || (setupOnly && Boolean(party));
    share.disabled = busy || Boolean(party);
    share.title = party ? t("A watch party is already shared in this channel.", "In diesem Kanal wird bereits ein Video geteilt.") : "";
    card.hidden = !isReady;
    card.setAttribute("aria-pressed", String(Boolean(selectedId)));
    if (isReady) {
      cardName.textContent = party.title || (party.source === "youtube" ? t("YouTube video", "YouTube-Video") : t("Local video", "Lokales Video"));
      cardSource.textContent = party.source === "youtube" ? "YouTube" : t("Room video", "Raumvideo");
      title.textContent = cardName.textContent;
    }
    stop.hidden = !canStop;
    stop.disabled = busy;
    controls.setTransport({ isPlaying: party?.playing, enabled: !busy && ready });
    onChange?.();
  }

  function leaveParty() {
    const previous = surface;
    surface = null;
    const hadSelection = Boolean(selectedId);
    selectedId = null;
    ready = false;
    controls.resetPosition();
    appliedRevision = undefined;
    nativeIntent = undefined;
    clearInterval(clockTimer);
    previous?.destroy();
    controls.setFullscreenSurface(null);
    media.replaceChildren();
    player.hidden = true;
    enable.hidden = true;
    tell(statusNode, "");
    if (hadSelection && !signal.aborted) render();
  }

  function join() {
    const party = sample?.party;
    if (setupOnly || party?.state !== "ready" || selectedId === party.id || signal.aborted) return;
    selectedId = party.id;
    onSelect();
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
    if (sample?.party.id === id && sample.party.state === "ready") join();
    else onUnavailable();
  }

  function prepareSource(source) {
    requestedSource = source;
    openRequestedSource();
  }

  function openRequestedSource() {
    if (!requestedSource || signal.aborted) return;
    if (sourceLimit === "screen" || (sourceLimit && sourceLimit !== requestedSource)) {
      requestedSource = undefined;
      onShareUnavailable();
      return;
    }
    if (!hasSnapshot) return;
    const source = requestedSource;
    requestedSource = undefined;
    if (!canShare || sample?.party || busy) onShareUnavailable();
    else if (source === "youtube") youtubeForm();
    else if (source === "local") localForm();
  }

  function resetPlayer(party) {
    tell(statusNode, t("Loading video…", "Video wird geladen …"));
    const current = () => selectedId === party.id && !signal.aborted;
    const handlers = {
      onReady() {
        if (!current()) return;
        ready = true;
        tell(statusNode, "");
        surface.setVolume(controls.volume());
        sync(true);
        render();
      },
      onError() {
        if (!current()) return;
        ready = false;
        const description = party.source === "youtube"
          ? t("YouTube couldn’t play this embedded video.", "YouTube konnte dieses eingebettete Video nicht abspielen.")
          : t("This device couldn’t play the video format.", "Dieses Gerät konnte das Videoformat nicht abspielen.");
        tell(statusNode, description, "error");
        render();
      },
      onEnded() {
        if (!current() || !sample?.party.playing) return;
        const duration = surface.getDuration();
        if (Number.isFinite(duration) && duration > 0 && desiredPosition() >= duration - 1) void change("pause");
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
    if (selectedId && selectedId !== party?.id) leaveParty();
    sample = party ? { party, refreshedAt, age: data.serverTime - party.updatedAt + (refreshedAt - requestedAt) / 2 } : null;
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

  function change(action, position) {
    const party = sample?.party;
    if (!party || selectedId !== party.id) return;
    return run(async () => {
      const startedAt = performance.now();
      try {
        const result = await api(endpoint + "/" + identifier(party.id), {
          method: "PATCH", body: { action, position, revision: party.revision }, signal,
        });
        if (!signal.aborted) apply(result, startedAt);
      } catch (error) {
        if (error.status !== 409) {
          sync(true);
          throw error;
        }
        appliedRevision = undefined;
        const refreshedAt = performance.now();
        const newest = await api(endpoint, { signal });
        if (!signal.aborted) apply(newest, refreshedAt);
        tell(statusNode, t("Playback changed in the room. The player will catch up.", "Die Wiedergabe wurde im Raum geändert. Der Player gleicht sie ab."));
      }
    });
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

  function chooseSource() {
    if (!canShare || sample?.party || busy) return;
    if (sourceLimit) {
      prepareSource(sourceLimit);
      return;
    }
    showDialog(t("Share video", "Video teilen"), el("div", { class: "watch-party-sources" },
      button(t("Share YouTube video", "YouTube-Video teilen"), youtubeForm),
      button(t("Share local video", "Lokales Video teilen"), localForm)));
  }

  function youtubeForm() {
    const input = el("input", { type: "text", inputmode: "url", required: true, maxlength: 2048,
      placeholder: "https://youtu.be/…", spellcheck: "false", autocomplete: "off" });
    showDialog(t("Share YouTube video", "YouTube-Video teilen"), form([
      field(t("YouTube link", "YouTube-Link"), input),
      el("p", { class: "muted" }, t("Viewers connect to YouTube when they open the player.", "Beim Öffnen des Players verbinden sich Zuschauer mit YouTube.")),
    ], t("Share", "Teilen"), async feedback => {
      const videoId = youtubeVideoId(input.value);
      if (!videoId) throw new Error(t("Enter a YouTube video link.", "Gib einen Link zu einem YouTube-Video ein."));
      if (await run(async () => {
        const data = await api(endpoint, { method: "POST", body: { source: "youtube", videoId }, signal });
        if (!signal.aborted) apply(data);
      }, feedback) && !signal.aborted) {
        closeDialog();
        join();
      }
    }));
    input.focus();
  }

  function localForm() {
    const input = el("input", { type: "file", accept: "video/mp4,video/webm,.mp4,.webm", required: true });
    const uploadProgress = el("progress", { max: 100, value: 0, hidden: true, "aria-label": t("Upload progress", "Upload-Fortschritt") });
    showDialog(t("Share local video", "Lokales Video teilen"), form([
      field(t("Video file", "Videodatei"), input),
      el("p", { class: "muted" }, t("MP4 or WebM up to 256 MiB. Rooms temporarily stores the original for playback in this channel.",
        "MP4 oder WebM bis 256 MiB. Rooms speichert das Original vorübergehend für die Wiedergabe in diesem Kanal.")), uploadProgress,
    ], t("Upload & share", "Hochladen und teilen"), async (feedback, uploadForm) => {
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
          let data = await api(endpoint, { method: "POST", body: {
            source: "local", mime, size: file.size, title: [...file.name.replace(/\.[^.]+$/u, "")].slice(0, 120).join(""),
          }, signal: uploadSignal });
          uploadedParty = identifier(data.party.id);
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
          if (uploadedParty) void api(endpoint + "/" + uploadedParty, { method: "DELETE", keepalive: true }).catch(() => {});
          throw error;
        }
      }, feedback);
      upload.abort();
      input.disabled = false;
      uploadProgress.hidden = true;
      if (complete && !signal.aborted && uploadForm.isConnected) {
        closeDialog();
        join();
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
  return { share, card, player, active: () => sample?.party.state === "ready", hasSnapshot: () => hasSnapshot,
    selected: () => Boolean(selectedId), join, leave: leaveParty, open, prepareSource };
}
