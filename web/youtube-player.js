const youtube = "https://www.youtube-nocookie.com";
const videoIdPattern = /^[A-Za-z0-9_-]{11}$/u;
const connectionInterval = 250;
const connectionTimeout = 18_000;
const numeric = value => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function createYoutubePlayer(videoId, { onReady, onError, onEnded, onBlocked } = {}) {
  if (typeof videoId !== "string" || !videoIdPattern.test(videoId)) throw new Error("Invalid YouTube video ID");

  const element = document.createElement("iframe");
  element.id = "rooms-youtube-" + crypto.randomUUID();
  element.className = "watch-youtube-frame";
  element.title = "YouTube";
  element.width = "560";
  element.height = "315";
  element.referrerPolicy = "strict-origin-when-cross-origin";
  element.setAttribute("allow", "autoplay; encrypted-media; fullscreen");
  element.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox");
  const url = new URL("/embed/" + videoId, youtube);
  url.search = new URLSearchParams({ enablejsapi: 1, origin: location.origin, playsinline: 1, controls: 0 });

  let ready = false;
  let destroyed = false;
  let visible = false;
  let intersecting = false;
  let nativeVisible = true;
  let wantsPlayback = false;
  let state = -1;
  let position = 0;
  let duration = 0;
  let pendingSeek;
  let volume;

  // Keep the provider's JavaScript in its own origin, outside the Rooms renderer.
  function send(message) {
    element.contentWindow?.postMessage(JSON.stringify({ id: element.id, channel: "widget", ...message }), youtube);
  }

  function command(func, ...args) {
    send({ event: "command", func, args });
  }

  function applyVolume() {
    if (!ready || volume === undefined) return;
    command("setVolume", Math.round(volume * 100));
    command(volume === 0 ? "mute" : "unMute");
  }

  function applySeek() {
    if (!ready || pendingSeek === undefined || (wantsPlayback && !visible)) return;
    const target = pendingSeek;
    pendingSeek = undefined;
    // Seeking from the unstarted or ended state can begin playback. Queue the same video at the target instead.
    if (state === -1 || state === 0 || state === 5) command("cueVideoById", videoId, target);
    else command("seekTo", target, true);
  }

  function applyPlayback() {
    if (!ready || !visible || !nativeVisible || document.hidden || !wantsPlayback) return;
    applySeek();
    if (state !== 1 && state !== 3) command("playVideo");
  }

  const observer = new IntersectionObserver(([entry]) => {
    intersecting = entry.isIntersecting && entry.intersectionRatio > 0;
    visible = entry.intersectionRatio > 0.5 && entry.boundingClientRect.width >= 200 && entry.boundingClientRect.height >= 200;
    updateVisibility();
  }, { threshold: [0, 0.5, 0.51, 1] });
  observer.observe(element);

  function updateVisibility() {
    if (ready && (!intersecting || !nativeVisible || document.hidden) && (state === 1 || state === 3)) command("pauseVideo");
    else applyPlayback();
  }
  document.addEventListener("visibilitychange", updateVisibility);
  const unobserveWindow = window.roomsWindowVisibility?.observe(value => { nativeVisible = value; updateVisibility(); });

  function updateState(value) {
    if (![0, 1, 2, 3, 5, -1].includes(value) || value === state) return;
    state = value;
    if (state === 0) onEnded?.();
  }

  function receive(event) {
    if (event.origin !== youtube || event.source !== element.contentWindow || typeof event.data !== "string" || event.data.length > 65_536) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!message || message.id !== element.id) return;

    switch (message.event) {
      case "onReady":
        if (ready) return;
        ready = true;
        clearInterval(connecting);
        clearTimeout(failed);
        for (const event of ["onError", "onStateChange", "onAutoplayBlocked"]) command("addEventListener", event);
        applyVolume();
        applySeek();
        onReady?.();
        applyPlayback();
        break;
      case "initialDelivery":
      case "infoDelivery":
        if (numeric(message.info?.currentTime)) position = message.info.currentTime;
        if (numeric(message.info?.duration)) duration = message.info.duration;
        updateState(message.info?.playerState);
        break;
      case "onStateChange":
        updateState(message.info);
        break;
      case "onError":
        onError?.(Number.isInteger(message.info) ? message.info : null);
        break;
      case "onAutoplayBlocked":
        onBlocked?.();
        break;
    }
  }

  window.addEventListener("message", receive);
  element.src = url.href;
  const connecting = setInterval(() => send({ event: "listening" }), connectionInterval);
  const failed = setTimeout(() => {
    clearInterval(connecting);
    onError?.(null);
  }, connectionTimeout);

  return {
    element,
    play() {
      if (destroyed) return;
      wantsPlayback = true;
      applyPlayback();
    },
    pause() {
      if (destroyed) return;
      const wasPlaying = wantsPlayback || state === 1 || state === 3;
      wantsPlayback = false;
      applySeek();
      if (ready && wasPlaying) command("pauseVideo");
    },
    seek(seconds) {
      if (destroyed || !numeric(seconds)) return;
      pendingSeek = duration > 0 ? Math.min(seconds, duration) : seconds;
      position = pendingSeek;
      applySeek();
    },
    setVolume(value) {
      if (destroyed || !numeric(value)) return;
      volume = Math.min(value, 1);
      applyVolume();
    },
    getTime: () => position,
    getDuration: () => duration,
    isPaused: () => state !== 1 && state !== 3,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(connecting);
      clearTimeout(failed);
      observer.disconnect();
      document.removeEventListener("visibilitychange", updateVisibility);
      unobserveWindow?.();
      window.removeEventListener("message", receive);
      element.remove();
    },
  };
}
