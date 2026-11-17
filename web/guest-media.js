import { createYoutubePlayer } from "./youtube-player.js";

export const guestRoomId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export const guestPassword = /^[A-Za-z0-9_-]{43}$/u;
const streamId = /^[a-f0-9]{32}$/u;
const youtubeId = /^[A-Za-z0-9_-]{11}$/u;
let hlsLoading;

function matchesPath(input, path) {
  return typeof input === "string" && (input === path || input === location.origin + path);
}

function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  hlsLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL("./hls.min.js", import.meta.url).href;
    script.addEventListener("load", () => {
      script.remove();
      if (window.Hls) resolve(window.Hls);
      else reject(new Error("HLS player did not load"));
    }, { once: true });
    script.addEventListener("error", () => {
      script.remove();
      reject(new Error("HLS player did not load"));
    }, { once: true });
    document.head.append(script);
  }).catch(error => {
    hlsLoading = undefined;
    throw error;
  });
  return hlsLoading;
}

export function guestSource(snapshot, base) {
  if (snapshot.source === "screen") {
    const stream = snapshot.stream;
    if (!stream?.live || !streamId.test(stream.id)) return null;
    const path = base + "/hls/live/" + stream.id + "/index.m3u8";
    return matchesPath(stream.playlistUrl, path) ? { id: stream.id, kind: "screen", path, hasAudio: stream.hasAudio !== false } : null;
  }

  const party = snapshot.party;
  if (!party || !guestRoomId.test(party.id) || snapshot.source !== party.source ||
      !Number.isFinite(snapshot.serverTime) || !Number.isFinite(party.updatedAt) ||
      !Number.isFinite(party.position) || party.position < 0 || !Number.isSafeInteger(party.revision) ||
      typeof party.playing !== "boolean") return null;

  if (party.source === "youtube" && youtubeId.test(party.videoId)) {
    return { ...party, kind: "youtube", hasAudio: true };
  }
  const path = base + "/media/" + party.id;
  return party.source === "local" && matchesPath(party.mediaUrl, path) ? { ...party, kind: "local", path, hasAudio: true } : null;
}

export function openGuestMedia(source, callbacks, ownerDocument = document) {
  if (source.kind === "youtube") return createYoutubePlayer(source.videoId, callbacks, ownerDocument);

  const video = ownerDocument.createElement("video");
  const url = new URL(source.path, location.origin).href;
  video.playsInline = true;
  video.preload = "auto";
  video.muted = true;
  const listener = new AbortController();
  const { signal } = listener;
  video.addEventListener("loadedmetadata", callbacks.onReady, { signal });
  video.addEventListener("playing", callbacks.onPlaying, { signal });
  video.addEventListener("ended", callbacks.onEnded, { signal });
  video.addEventListener("error", callbacks.onError, { signal });
  let hls;

  if (source.kind !== "screen") {
    video.src = url;
  } else {
    const native = Boolean(video.canPlayType("application/vnd.apple.mpegurl"));
    void loadHls().then(Hls => {
      if (signal.aborted) return;
      if (!Hls.isSupported()) throw new Error("HLS playback is unavailable");
      hls = new Hls({ preferManagedMediaSource: true, maxBufferLength: 18, backBufferLength: 24 });
      hls.on(Hls.Events.ERROR, (_, data) => { if (!signal.aborted && data.fatal) callbacks.onError(); });
      hls.attachMedia(video);
      hls.loadSource(url);
    }).catch(() => {
      if (signal.aborted) return;
      hls?.destroy();
      hls = undefined;
      if (native) video.src = url;
      else callbacks.onError();
    });
  }

  return {
    element: video,
    play() {
      video.play().catch(error => {
        if (signal.aborted || error.name === "AbortError") return;
        if (error.name === "NotAllowedError") callbacks.onBlocked();
        else callbacks.onError();
      });
    },
    pause() { video.pause(); },
    seek(position) { video.currentTime = position; },
    setVolume(volume, muted) {
      video.muted = muted;
      video.volume = volume;
    },
    getTime: () => video.currentTime,
    getDuration: () => video.duration,
    isPaused: () => video.paused,
    destroy() {
      listener.abort();
      hls?.destroy();
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.remove();
    },
  };
}
