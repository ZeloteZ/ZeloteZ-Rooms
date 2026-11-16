import { language, t } from "./i18n.js";
import { guestPassword, guestRoomId, guestSource, openGuestMedia } from "./guest-media.js";

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
  paused: ["Playback is paused.", "Die Wiedergabe ist pausiert."],
  localPause: ["Playback is paused on this device.", "Die Wiedergabe ist auf diesem Gerät pausiert."],
  gesture: ["Select Play to start playback on this device.", "Wähle Abspielen, um die Wiedergabe auf diesem Gerät zu starten."],
  playbackError: ["The video couldn’t be played.", "Das Video konnte nicht wiedergegeben werden."],
};

function copy(key) {
  const message = messages[key];
  return message ? t(...message) : "";
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

export function renderGuestViewer({ publicId, signal, member = false, password }) {
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
      <div class="guest-heading">
        <h1 class="guest-room-title"></h1>
        <span class="tag live" hidden></span>
      </div>
      <div class="guest-media">
        <p class="status guest-waiting" role="status"></p>
      </div>
      <p class="status guest-playback-status" role="status" hidden></p>
      <div class="guest-controls" hidden>
        <div class="guest-volume">
          <button class="button guest-mute" type="button"></button>
          <input type="range" min="0" max="100" value="100">
        </div>
        <button class="button guest-fullscreen" type="button" hidden></button>
        <button class="button primary guest-play" type="button" hidden></button>
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
  const title = find(".guest-room-title");
  const live = find(".guest-heading .tag");
  const stage = find(".guest-media");
  const waiting = find(".guest-waiting");
  const playbackStatus = find(".guest-playback-status");
  const controls = find(".guest-controls");
  const audio = find(".guest-volume");
  const volume = find("input[type=range]");
  const mute = find(".guest-mute");
  const fullscreen = find(".guest-fullscreen");
  const play = find(".guest-play");

  let gateState = "opening";
  let playbackState;
  let timer;
  let watch;
  let playing;
  let authorized = false;
  let muted = true;
  let roomTitle = "";
  const base = "/api/guest/" + publicId;

  function updateLabels() {
    gateTitle.textContent = t("Live room", "Live-Raum");
    setText(gateStatus, copy(gateState));
    passwordLabel.textContent = t("Password", "Passwort");
    enter.textContent = t("Open live room", "Live-Raum öffnen");
    setText(title, watch?.source.title || roomTitle || t("Live room", "Live-Raum"));
    live.textContent = t("Live", "Live");
    setText(waiting, copy("waiting"));
    setText(playbackStatus, copy(playbackState));
    mute.textContent = muted ? t("Unmute", "Ton an") : t("Mute", "Ton aus");
    volume.setAttribute("aria-label", t("Your volume", "Deine Lautstärke"));
    fullscreen.textContent = t("Full screen", "Vollbild");
    play.textContent = playbackState === "playbackError" ? t("Retry playback", "Wiedergabe erneut versuchen")
      : playbackState === "localPause" ? t("Resume watching", "Weiter zuschauen") : t("Play", "Abspielen");
  }

  function setPlayback(state) {
    if (state === playbackState) return;
    playbackState = state;
    playbackStatus.hidden = !state;
    play.hidden = !["playbackError", "localPause", "gesture"].includes(state);
    updateLabels();
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

  function audioVolume() {
    const level = Number(volume.value) / 100;
    playing?.surface.setVolume(muted ? 0 : level);
    updateLabels();
  }

  function discardMedia() {
    const old = playing;
    playing = undefined;
    old?.surface.destroy();
    waiting.hidden = false;
    controls.hidden = true;
    live.hidden = true;
    setPlayback(undefined);
  }

  function applyState(force = false) {
    const current = playing;
    if (!watch || !current?.ready || current.localPaused) return;
    const { source, serverTime, received, roundTrip } = watch;
    if (source.kind === "screen") {
      if (force) current.surface.play();
      return;
    }

    let expected = source.position;
    if (source.playing) expected += Math.max(0, serverTime - source.updatedAt + roundTrip / 2 + performance.now() - received) / 1000;
    const duration = current.surface.getDuration();
    if (Number.isFinite(duration) && duration > 0) expected = Math.min(expected, duration);
    const changed = current.revision !== source.revision;
    // Cueing a YouTube player that has not started can cancel its pending play command.
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
    if (!force && !changed && (source.playing || current.surface.isPaused())) return;
    current.revision = source.revision;
    if (source.playing) current.surface.play();
    else {
      current.started = false;
      current.surface.pause();
      setPlayback("paused");
    }
  }

  function startPlayback() {
    discardMedia();
    if (!watch) return;
    const { source } = watch;
    const current = { id: source.id, kind: source.kind, ready: false, localPaused: false, started: false };
    const active = () => playing === current && !signal.aborted;
    current.surface = openGuestMedia(source, {
      onReady() {
        if (!active()) return;
        current.ready = true;
        fullscreen.hidden = !document.fullscreenEnabled && !current.surface.element.webkitEnterFullscreen;
        applyState(true);
      },
      onPlaying() {
        if (!active()) return;
        if (!watch || (source.kind !== "screen" && !watch.source.playing)) {
          current.surface.pause();
          return;
        }
        const started = current.started;
        current.started = true;
        current.localPaused = false;
        setPlayback(undefined);
        if (!started && source.kind === "youtube") applyState(true);
      },
      onEnded() { if (active()) current.started = false; },
      onBlocked() { if (active() && (source.kind === "screen" || watch?.source.playing)) setPlayback("gesture"); },
      onError() {
        if (!active()) return;
        current.ready = false;
        setPlayback("playbackError");
      },
      onPlaybackChange(resumed) {
        if (!active() || !current.ready) return;
        current.localPaused = !resumed;
        if (resumed) applyState(true);
        else {
          current.started = false;
          setPlayback("localPause");
        }
      },
    });
    playing = current;
    if (current.surface.element.tagName === "VIDEO") current.surface.element.setAttribute("aria-label", title.textContent);
    stage.append(current.surface.element);
    waiting.hidden = true;
    controls.hidden = false;
    fullscreen.hidden = true;
    setPlayback("loading");
    audioVolume();
  }

  function showRoom(snapshot, sent) {
    authorized = true;
    roomTitle = typeof snapshot.title === "string" ? snapshot.title.slice(0, 120) : "";
    room.hidden = false;
    gate.hidden = true;
    passwordInput.value = "";
    const source = guestSource(snapshot, base);
    if (!source) {
      watch = undefined;
      discardMedia();
      updateLabels();
      return;
    }
    const received = performance.now();
    watch = { source, serverTime: snapshot.serverTime, received, roundTrip: received - sent };
    updateLabels();
    if (source.id !== playing?.id || source.kind !== playing?.kind) startPlayback();
    else applyState();
    if (playbackState === "reconnecting") setPlayback(source.kind === "screen" || source.playing ? undefined : "paused");
    audio.hidden = !source.hasAudio;
    live.hidden = source.kind !== "screen" && !source.playing;
  }

  function request(path, body) {
    return fetch(base + path, {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      headers: { "Accept-Language": language(), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async function refresh() {
    if (signal.aborted) return;
    const sent = performance.now();
    try {
      const response = await request("/state");
      if (signal.aborted) return;
      if ([401, 403, 404, 410].includes(response.status)) {
        watch = undefined;
        discardMedia();
        authorized = false;
        showGate(!member && [401, 403].includes(response.status) ? "required" : "unavailable");
        return;
      }
      if (!response.ok) throw new Error();
      const snapshot = await response.json();
      if (signal.aborted) return;
      showRoom(snapshot, sent);
    } catch {
      if (signal.aborted) return;
      if (authorized) setPlayback("reconnecting");
      else showGate("reconnecting");
    }
    if (!signal.aborted) timer = setTimeout(refresh, watch?.source.kind === "local" || watch?.source.kind === "youtube" ? 1200 : 2600);
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
      const response = await request("/session", { password: secret });
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
  });
  mute.addEventListener("click", () => {
    muted = !muted;
    if (!muted && Number(volume.value) === 0) volume.value = "100";
    audioVolume();
  });
  volume.addEventListener("input", () => {
    muted = Number(volume.value) === 0;
    audioVolume();
  });
  fullscreen.addEventListener("click", () => {
    if (document.fullscreenElement) void document.exitFullscreen()?.catch(() => {});
    else if (document.fullscreenEnabled) void stage.requestFullscreen()?.catch(() => {});
    else playing?.surface.element.webkitEnterFullscreen?.();
  });
  play.addEventListener("click", () => {
    if (playbackState === "playbackError") startPlayback();
    else if (playing) {
      playing.localPaused = false;
      applyState(true);
    }
  });
  viewer.addEventListener("guest-language", updateLabels);
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    discardMedia();
  }, { once: true });

  updateLabels();
  if (!guestRoomId.test(publicId)) showGate("unavailable");
  else if (!member && typeof password === "string") void unlock(password);
  else void refresh();
  return viewer;
}
