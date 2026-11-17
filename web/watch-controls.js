import { t } from "./i18n.js";
import { createWatchCinema } from "./watch-cinema.js";

const fullscreenIdleDelay = 3000;

function item(tag, className, children = []) {
  const node = document.createElement(tag);
  node.className = className;
  node.append(...children);
  return node;
}

function button(className, action, signal) {
  const node = item("button", "button " + className);
  node.type = "button";
  node.addEventListener("click", action, { signal });
  return node;
}

function range(className, max, step, value) {
  const node = item("input", className);
  node.type = "range";
  node.min = "0";
  node.max = String(max);
  node.step = String(step);
  node.value = String(value);
  return node;
}

function timeLabel(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  return minutes + ":" + String(whole % 60).padStart(2, "0");
}

export function createWatchControls({ signal, onToggle, onSeek, onVolume, fullscreenTarget, muted = false }) {
  let scrubbing = false;
  let position = 0;
  let duration;
  let playing = false;
  let previousVolume = 100;
  let shell;
  let media;
  let inFullscreen = false;
  let inCinema = false;
  let idleTimer;
  const dragging = new Set();
  const icon = item("span", "watch-play-icon");
  icon.setAttribute("aria-hidden", "true");
  const toggle = button("watch-play-button", onToggle, signal);
  toggle.append(icon);
  const progress = range("watch-position", 0, 0.1, 0);
  const time = item("span", "watch-party-time", ["0:00"]);
  const total = item("span", "watch-party-time watch-duration");
  const timeline = item("div", "watch-timeline", [time, progress, total]);
  const level = range("watch-volume", 100, 1, muted ? 0 : 100);
  const mute = button("ghost watch-mute-button", () => {
    level.value = Number(level.value) === 0 ? String(previousVolume) : "0";
    volumeChanged();
  }, signal);
  const audio = item("div", "watch-audio", [mute, level]);
  const cinemaButton = button("ghost watch-cinema-button", () => cinema.toggle(), signal);
  cinemaButton.hidden = true;
  const fullscreen = button("ghost icon-button watch-fullscreen", toggleFullscreen, signal);
  fullscreen.hidden = true;
  const expand = item("span", "watch-fullscreen-icon", ["⛶"]);
  expand.setAttribute("aria-hidden", "true");
  fullscreen.append(expand);
  const transport = item("div", "watch-party-transport", [toggle,
    item("div", "watch-actions", [cinemaButton, audio, fullscreen]),
  ]);
  const reveal = button("watch-fullscreen-reveal", event => {
    wake();
    if (event.detail === 0) (toggle.disabled || toggle.hidden ? inCinema ? cinemaButton : fullscreen : toggle).focus({ preventScroll: true });
  }, signal);
  const element = item("div", "watch-party-controls", [timeline, transport, reveal]);
  const cinema = createWatchCinema({ signal, target: fullscreenTarget, trigger: () => cinemaButton, onChange(open) {
    inCinema = open;
    dragging.clear();
    clearIdle();
    refreshLabels();
    wake();
  } });

  function refreshLabels() {
    const action = playing ? t("Pause together", "Gemeinsam pausieren") : t("Play together", "Gemeinsam abspielen");
    toggle.title = action;
    toggle.setAttribute("aria-label", action);
    toggle.toggleAttribute("data-playing", playing);
    progress.setAttribute("aria-label", t("Playback position for everyone", "Wiedergabeposition für alle"));
    level.setAttribute("aria-label", t("Your volume", "Deine Lautstärke"));
    refreshVolumeLabel();
    cinemaButton.textContent = t("Cinema", "Kino");
    cinemaButton.title = inCinema ? t("Exit cinema mode", "Kinomodus verlassen") : t("Cinema mode", "Kinomodus");
    cinemaButton.setAttribute("aria-label", cinemaButton.title);
    cinemaButton.setAttribute("aria-pressed", String(inCinema));
    fullscreen.title = inFullscreen ? t("Exit full screen", "Vollbild verlassen") : t("Full screen", "Vollbild");
    fullscreen.setAttribute("aria-label", fullscreen.title);
    reveal.setAttribute("aria-label", t("Show playback controls", "Wiedergabesteuerung einblenden"));
  }

  function clearIdle() {
    clearTimeout(idleTimer);
    shell?.removeAttribute("data-watch-idle");
  }

  function wake() {
    if (!(inFullscreen || inCinema) || !media) return;
    clearIdle();
    idleTimer = setTimeout(() => {
      if (dragging.size || element.querySelector(":focus-visible")) return;
      const keepFocus = media.localName === "iframe" && element.contains(document.activeElement);
      shell.setAttribute("data-watch-idle", "");
      if (keepFocus) reveal.focus({ preventScroll: true });
    }, fullscreenIdleDelay);
  }

  function fullscreenChanged() {
    const next = document.fullscreenElement === shell;
    if (next === inFullscreen) return;
    inFullscreen = next;
    dragging.clear();
    clearIdle();
    if (!next && document.activeElement === document.body && element.isConnected && !fullscreen.hidden) {
      fullscreen.focus({ preventScroll: true });
    }
    refreshLabels();
    wake();
  }

  function toggleFullscreen() {
    if (!media) return;
    cinema.close(false);
    if (inFullscreen) void document.exitFullscreen().catch(() => {});
    else if (document.fullscreenEnabled && shell?.requestFullscreen) void shell.requestFullscreen().catch(() => {});
    else media.webkitEnterFullscreen?.();
  }

  function setFullscreenSurface(surface) {
    if (signal.aborted) return;
    if (!shell) {
      shell = fullscreenTarget?.();
      if (shell) {
        const passive = { signal, passive: true };
        shell.addEventListener("pointermove", event => {
          if (event.target !== reveal || event.pointerType === "mouse") wake();
        }, passive);
        shell.addEventListener("pointerdown", event => {
          if (event.target === reveal) return;
          if ((inFullscreen || inCinema) && element.contains(event.target)) dragging.add(event.pointerId);
          wake();
        }, passive);
        const wakeFromControl = event => {
          if (event.target !== reveal) wake();
        };
        shell.addEventListener("keydown", wakeFromControl, { signal });
        shell.addEventListener("focusin", wakeFromControl, { signal });
        shell.addEventListener("focusout", () => {
          if (!shell.hasAttribute("data-watch-idle")) wake();
        }, { signal });
        const stopDragging = event => {
          if (dragging.delete(event.pointerId)) wake();
        };
        document.addEventListener("pointerup", stopDragging, passive);
        document.addEventListener("pointercancel", stopDragging, passive);
        document.addEventListener("fullscreenchange", fullscreenChanged, { signal });
        signal.addEventListener("abort", clearIdle, { once: true });
      }
    }
    media = surface;
    if (media && shell) shell.dataset.watchFullscreen = media.localName === "iframe" ? "embed" : "overlay";
    if (!media) {
      cinema.close(false);
      clearIdle();
      shell?.removeAttribute("data-watch-fullscreen");
      if (inFullscreen) void document.exitFullscreen().catch(() => {});
    }
    fullscreen.hidden = !media || !(document.fullscreenEnabled && shell?.requestFullscreen || media.webkitEnterFullscreen);
    cinemaButton.hidden = !media || !shell;
  }

  function paintTimeline() {
    if (!scrubbing) progress.value = String(position);
    const preview = timeLabel(scrubbing ? Number(progress.value) : position);
    time.textContent = preview;
    total.textContent = duration ? timeLabel(duration) : "";
    progress.setAttribute("aria-valuetext", preview);
  }

  function volumeState() {
    return { volume: previousVolume / 100, muted: level.value === "0" };
  }

  function refreshVolumeLabel() {
    mute.textContent = level.value === "0" ? t("Unmute", "Ton an") : t("Mute", "Ton aus");
  }

  function volumeChanged() {
    const value = Number(level.value);
    if (value > 0) previousVolume = value;
    const { volume, muted } = volumeState();
    onVolume(volume, muted);
    refreshVolumeLabel();
  }

  progress.addEventListener("input", () => { scrubbing = true; paintTimeline(); }, { signal });
  progress.addEventListener("change", () => {
    const value = Number(progress.value);
    scrubbing = false;
    onSeek(value);
  }, { signal });
  progress.addEventListener("blur", () => { scrubbing = false; paintTimeline(); }, { signal });
  level.addEventListener("input", volumeChanged, { signal });
  refreshLabels();

  return {
    element, audio, setFullscreenSurface,
    refreshLabels,
    volumeState,
    setVolume(volume, muted) {
      const value = Math.round(volume * 100);
      if (value > 0) previousVolume = value;
      level.value = String(muted ? 0 : value);
      refreshVolumeLabel();
    },
    setTransport({ isPlaying = false, enabled = false, shared = true } = {}) {
      playing = isPlaying;
      toggle.disabled = !enabled;
      toggle.hidden = !shared;
      timeline.hidden = !shared;
      progress.disabled = !enabled || !duration;
      refreshLabels();
    },
    setPosition(seconds, length) {
      position = seconds;
      duration = Number.isFinite(length) && length > 0 ? length : undefined;
      progress.max = duration ? String(duration) : "0";
      progress.disabled = toggle.disabled || !duration;
      paintTimeline();
    },
    resetPosition() {
      scrubbing = false;
      this.setPosition(0);
    },
  };
}
