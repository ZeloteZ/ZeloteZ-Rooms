import { button, el, field, select } from "./ui.js";
import { t } from "./i18n.js";

export function desktopShareControls() {
  const resolution = select([["720", "720p"], ["1080", "1080p"], ["1440", "1440p"]], "1080");
  const rate = select([["30", "30 FPS"], ["60", "60 FPS"]], "30");
  const region = el("input", { type: "checkbox" });
  const element = el("div", { class: "desktop-share-controls", hidden: true },
    field(t("Resolution", "Auflösung"), resolution),
    field(t("Frame rate", "Bildrate"), rate),
    el("label", { class: "inline" }, region, t("Share a region", "Ausschnitt teilen")));
  return { element, options: () => ({ height: Number(resolution.value), fps: Number(rate.value), region: region.checked }) };
}

function pictureBounds(video) {
  const { width, height, left, top } = video.getBoundingClientRect();
  const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
  return { x: (width - video.videoWidth * scale) / 2, y: (height - video.videoHeight * scale) / 2, scale, left, top };
}

function bound(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function desktopShareSettings(value) {
  const region = value?.region;
  if (![720, 1080, 1440].includes(value?.height) || ![30, 60].includes(value?.fps) ||
      !["none", "application", "system"].includes(value?.audio) || (region !== null &&
      (!region || !["x", "y", "width", "height", "aspect"].every(key => Number.isFinite(region[key])) ||
      !Number.isSafeInteger(region.sourceWidth) || region.sourceWidth <= 0 ||
      !Number.isSafeInteger(region.sourceHeight) || region.sourceHeight <= 0 ||
      region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 || region.aspect <= 0 ||
      region.x + region.width > 1 + 1e-6 || region.y + region.height > 1 + 1e-6))) {
    throw new Error(t("The screen sharing settings are invalid. Choose your source again.",
      "Die Freigabeeinstellungen sind ungültig. Wähle deine Quelle erneut."));
  }
  return { height: value.height, fps: value.fps, audio: value.audio, region: region && {
    x: region.x, y: region.y, width: region.width, height: region.height, aspect: region.aspect,
    sourceWidth: region.sourceWidth, sourceHeight: region.sourceHeight,
  } };
}

export function normalizedDesktopRegion(region, sourceWidth, sourceHeight) {
  if (!Number.isSafeInteger(sourceWidth) || sourceWidth <= 0 || !Number.isSafeInteger(sourceHeight) || sourceHeight <= 0 ||
      !region || !Number.isFinite(region.aspect) || region.aspect <= 0 ||
      region.sourceWidth !== sourceWidth || region.sourceHeight !== sourceHeight ||
      Math.abs(sourceWidth / sourceHeight / region.aspect - 1) > .02) {
    throw new Error(t("The capture source changed size. Select a region again.",
      "Die Größe der Aufnahme hat sich geändert. Wähle den Ausschnitt erneut."));
  }
  desktopShareSettings({ height: 1080, fps: 30, audio: "none", region });
  const x = Math.ceil(region.x * sourceWidth);
  const y = Math.ceil(region.y * sourceHeight);
  const right = Math.floor(Math.min(1, region.x + region.width) * sourceWidth);
  const bottom = Math.floor(Math.min(1, region.y + region.height) * sourceHeight);
  if (right - x < Math.min(32, sourceWidth) || bottom - y < Math.min(32, sourceHeight)) {
    throw new Error(t("The selected region is too small. Choose a larger area.",
      "Der ausgewählte Ausschnitt ist zu klein. Wähle einen größeren Bereich."));
  }
  return { x, y, width: right - x, height: bottom - y };
}

async function sourceVideo(source, signal) {
  signal.throwIfAborted();
  const video = el("video", { muted: true, playsinline: true });
  video.muted = true;
  video.srcObject = new MediaStream(source.getVideoTracks());
  try {
    await new Promise((resolve, reject) => {
      function finish(error) {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        video.removeEventListener("loadeddata", ready);
        video.removeEventListener("error", failed);
        if (error) reject(error);
        else resolve();
      }
      const ready = () => {
        if (video.videoWidth && video.videoHeight && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) finish();
      };
      const failed = () => finish(new Error(t("The screen preview is unavailable. Choose your source again.",
        "Die Bildschirmvorschau ist nicht verfügbar. Wähle deine Quelle erneut.")));
      const abort = () => finish(signal.reason);
      const timer = setTimeout(failed, 8000);
      signal.addEventListener("abort", abort, { once: true });
      video.addEventListener("loadeddata", ready);
      video.addEventListener("error", failed, { once: true });
      video.play().then(ready, failed);
    });
    signal.throwIfAborted();
    return video;
  } catch (error) {
    video.srcObject = null;
    throw error;
  }
}

export async function desktopSharePreview(source, signal) {
  const video = await sourceVideo(source, signal);
  try {
    const aspect = video.videoWidth / video.videoHeight;
    const scale = Math.min(1, 640 / video.videoWidth, 640 / video.videoHeight);
    const canvas = el("canvas", { width: Math.max(1, Math.round(video.videoWidth * scale)),
      height: Math.max(1, Math.round(video.videoHeight * scale)) });
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error(t("The screen preview is unavailable. Choose your source again.",
      "Die Bildschirmvorschau ist nicht verfügbar. Wähle deine Quelle erneut."));
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    let image = canvas.toDataURL("image/jpeg", .7);
    if (image.length > 250000) image = canvas.toDataURL("image/jpeg", .4);
    if (!image.startsWith("data:image/jpeg;base64,") || image.length > 250000) {
      throw new Error(t("The screen preview is unavailable. Choose your source again.",
        "Die Bildschirmvorschau ist nicht verfügbar. Wähle deine Quelle erneut."));
    }
    return { image, aspect, width: video.videoWidth, height: video.videoHeight };
  } finally {
    video.srcObject = null;
  }
}

function chooseRegion(video, track, signal) {
  return new Promise(resolve => {
    const caption = t("Drag over the preview to choose an area. Use the arrow keys to move it or Shift and the arrow keys to resize it.",
      "Ziehe über die Vorschau, um einen Ausschnitt zu wählen. Mit den Pfeiltasten verschiebst du ihn, mit Umschalt und den Pfeiltasten änderst du seine Größe.");
    const selection = el("div", { class: "desktop-crop-selection", hidden: true });
    const stage = el("div", { class: "desktop-crop-stage", tabindex: "0", "aria-label": caption }, video, selection);
    const start = button(t("Start stream", "Stream starten"), () => finish(region), { class: "primary", disabled: true });
    const cancel = button(t("Cancel", "Abbrechen"), () => finish(null));
    const dialog = el("dialog", { class: "dialog desktop-crop-dialog", "aria-labelledby": "desktop-crop-title" },
      el("div", { class: "dialog-body" },
        el("h2", { id: "desktop-crop-title" }, t("Choose a region", "Ausschnitt wählen")),
        stage, el("p", { class: "muted" }, caption),
        el("div", { class: "inline" }, start, cancel)));
    let region;
    let sourceWidth;
    let sourceHeight;
    let drag;
    let finished = false;
    const observer = new ResizeObserver(paint);
    const abort = () => finish(null);
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

    function finish(result) {
      if (finished) return;
      finished = true;
      if (!result) {
        track.stop();
        video.srcObject = null;
      }
      signal.removeEventListener("abort", abort);
      video.removeEventListener("error", abort);
      video.removeEventListener("loadeddata", paint);
      video.removeEventListener("resize", reset);
      observer.disconnect();
      dialog.close();
      dialog.remove();
      resolve(result && { region: result, sourceWidth, sourceHeight });
    }

    function paint() {
      selection.hidden = !region;
      start.disabled = !region || Boolean(drag) || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA;
      if (!region) return;
      const { x, y, scale } = pictureBounds(video);
      selection.style.left = `${x + region.x * scale}px`;
      selection.style.top = `${y + region.y * scale}px`;
      selection.style.width = `${region.width * scale}px`;
      selection.style.height = `${region.height * scale}px`;
    }

    function reset() {
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) return;
      sourceWidth = width;
      sourceHeight = height;
      const x = Math.floor(width / 10);
      const y = Math.floor(height / 10);
      drag = null;
      region = { x, y, width: width - 2 * x, height: height - 2 * y };
      paint();
    }

    function point(event) {
      const box = pictureBounds(video);
      return {
        x: bound(Math.round((event.clientX - box.left - box.x) / box.scale), 0, video.videoWidth),
        y: bound(Math.round((event.clientY - box.top - box.y) / box.scale), 0, video.videoHeight),
      };
    }

    function dragTo(event) {
      const next = point(event);
      region = { x: Math.min(drag.start.x, next.x), y: Math.min(drag.start.y, next.y),
        width: Math.abs(drag.start.x - next.x), height: Math.abs(drag.start.y - next.y) };
    }

    stage.addEventListener("pointerdown", event => {
      if (event.button !== 0 || drag || !region) return;
      stage.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, start: point(event), previous: region };
      dragTo(event);
      paint();
    });
    stage.addEventListener("pointermove", event => {
      if (event.pointerId !== drag?.id) return;
      dragTo(event);
      paint();
    });
    stage.addEventListener("pointerup", event => {
      if (event.pointerId !== drag?.id) return;
      dragTo(event);
      if (region.width < 32 || region.height < 32) region = drag.previous;
      drag = null;
      paint();
    });
    stage.addEventListener("lostpointercapture", event => {
      if (event.pointerId !== drag?.id) return;
      region = drag.previous;
      drag = null;
      paint();
    });
    stage.addEventListener("keydown", event => {
      const direction = directions[event.key];
      if (!region || drag || !direction) return;
      event.preventDefault();
      const step = Math.max(1, Math.round(Math.min(video.videoWidth, video.videoHeight) / 80));
      const [dx, dy] = direction.map(unit => unit * step);
      if (event.shiftKey) {
        region.width = bound(region.width + dx, Math.min(32, video.videoWidth), video.videoWidth - region.x);
        region.height = bound(region.height + dy, Math.min(32, video.videoHeight), video.videoHeight - region.y);
      } else {
        region.x = bound(region.x + dx, 0, video.videoWidth - region.width);
        region.y = bound(region.y + dy, 0, video.videoHeight - region.height);
      }
      paint();
    });
    dialog.addEventListener("cancel", event => { event.preventDefault(); finish(null); });
    video.addEventListener("error", abort, { once: true });
    video.addEventListener("loadeddata", paint);
    video.addEventListener("resize", reset);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      finish(null);
      return;
    }
    observer.observe(video);
    document.body.append(dialog);
    dialog.showModal();
    reset();
    video.play().catch(abort);
  });
}

export async function cropDesktopShare(source, { height: maxHeight, fps, region: chosenRegion = true }, signal, onEnded) {
  const input = source.getVideoTracks()[0];
  const video = chosenRegion === true ? el("video", { muted: true, playsinline: true }) : await sourceVideo(source, signal);
  if (chosenRegion === true) {
    video.muted = true;
    video.srcObject = new MediaStream([input]);
  }
  let selection;
  try {
    selection = chosenRegion === true ? await chooseRegion(video, input, signal) : {
      region: normalizedDesktopRegion(chosenRegion, video.videoWidth, video.videoHeight),
      sourceWidth: video.videoWidth, sourceHeight: video.videoHeight,
    };
    signal.throwIfAborted();
  } catch (error) {
    video.srcObject = null;
    throw error;
  }
  if (!selection) return null;

  const { region, sourceWidth, sourceHeight } = selection;
  if (video.videoWidth !== sourceWidth || video.videoHeight !== sourceHeight) {
    video.srcObject = null;
    onEnded(true);
    return null;
  }
  const maxWidth = Math.round(maxHeight * 16 / 9);
  const scale = Math.min(maxWidth / region.width, maxHeight / region.height);
  // Match the selected shape within the quality preset, aligned for H.264.
  const width = Math.max(2, Math.round(region.width * scale / 2) * 2);
  const height = Math.max(2, Math.round(region.height * scale / 2) * 2);
  const canvas = el("canvas", { width, height });
  const context = canvas.getContext("2d", { alpha: false });
  if (!context || !canvas.captureStream || typeof MediaStreamTrackProcessor !== "function") {
    video.srcObject = null;
    throw new Error(t("This desktop app couldn’t prepare the region stream.", "Die Desktop-App konnte den Ausschnitt-Stream nicht vorbereiten."));
  }
  const draw = frame => context.drawImage(frame, region.x, region.y, region.width, region.height, 0, 0, width, height);
  let output;
  let reader;
  try {
    reader = new MediaStreamTrackProcessor({ track: input, maxBufferSize: 1 }).readable.getReader();
    output = canvas.captureStream(fps);
    // Use the visible preview immediately, even if the shared window is still.
    draw(video);
  } catch (error) {
    reader?.releaseLock();
    for (const track of output?.getTracks() ?? []) track.stop();
    throw error;
  } finally {
    video.srcObject = null;
  }

  async function drawFrames() {
    try {
      while (!signal.aborted) {
        const { done, value: frame } = await reader.read();
        if (done) break;
        try {
          if (signal.aborted) return;
          if (frame.displayWidth !== sourceWidth || frame.displayHeight !== sourceHeight) {
            onEnded(true);
            return;
          }
          draw(frame);
        } finally {
          frame.close();
        }
      }
    } catch {
      // Treat a failed input or draw as an ended capture.
    } finally {
      reader.releaseLock();
    }
    if (!signal.aborted) onEnded(false);
  }

  signal.addEventListener("abort", () => {
    reader.cancel().catch(() => {});
    for (const track of output.getTracks()) track.stop();
  }, { once: true });
  drawFrames();
  return output;
}
