"use strict";

// This document never loads remote content. Its only visible surface is the
// confirmed output canvas. Raw frames and preview canvases never enter its DOM.
const output = document.getElementById("output");
const context = output.getContext("2d", { alpha: false });
let source, reader, latest, geometry, cropBuffer, repaint, starting, stopped = false;

function stop(reason = "ended") {
  if (stopped) return;
  stopped = true;
  clearInterval(repaint);
  context.fillStyle = "#000";
  context.fillRect(0, 0, output.width, output.height);
  reader?.cancel().catch(() => {});
  for (const track of source?.getTracks() ?? []) track.stop();
  latest?.close();
  latest = null;
  window.roomsCaptureOwner.ended(reason);
}

function paint() {
  if (stopped || !geometry || !latest) return;
  if (geometry.cropped && (latest.displayWidth !== geometry.sourceWidth || latest.displayHeight !== geometry.sourceHeight)) {
    stop("resized");
    return;
  }
  context.fillStyle = "#000";
  context.fillRect(0, 0, output.width, output.height);
  if (geometry.cropped) {
    // Materialize only the allowed pixels before scaling. Interpolation must not
    // sample a neighboring source pixel outside the selected rectangle.
    cropBuffer.getContext("2d", { alpha: false }).drawImage(latest, geometry.x, geometry.y,
      geometry.cropWidth, geometry.cropHeight, 0, 0, geometry.cropWidth, geometry.cropHeight);
    context.drawImage(cropBuffer, 0, 0, output.width, output.height);
  } else {
    // A full-window share remains a full-window share when that window resizes.
    const scale = Math.min(output.width / latest.displayWidth, output.height / latest.displayHeight);
    const width = latest.displayWidth * scale, height = latest.displayHeight * scale;
    context.drawImage(latest, 0, 0, latest.displayWidth, latest.displayHeight,
      (output.width - width) / 2, (output.height - height) / 2, width, height);
  }
}

window.roomsStartLocalCapture = () => starting ??= (async () => {
  source = await navigator.mediaDevices.getDisplayMedia({ audio: false,
    video: { resizeMode: "none", frameRate: { ideal: 60, max: 60 } } });
  if (stopped) { for (const track of source.getTracks()) track.stop(); throw new Error("Capture cancelled"); }
  const track = source.getVideoTracks()[0];
  if (!track) throw new Error("No capture track");
  track.addEventListener("ended", () => stop(), { once: true });
  reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 }).readable.getReader();
  let firstFrame;
  const ready = new Promise((resolve, reject) => { firstFrame = { resolve, reject }; });
  void (async () => {
    try {
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        if (stopped) { value.close(); break; }
        latest?.close();
        latest = value;
        firstFrame.resolve({ width: value.displayWidth, height: value.displayHeight });
        if (geometry?.cropped && (value.displayWidth !== geometry.sourceWidth || value.displayHeight !== geometry.sourceHeight)) stop("resized");
      }
    } catch { /* Closing the trusted owner cancels its reader. */ }
    firstFrame.reject(new Error("The capture source ended"));
    stop();
  })();
  return ready;
})();

window.roomsCaptureOwner.onCommand(async (id, operation, value) => {
  try {
    await starting;
    if (stopped || !latest) throw new Error("The capture source ended");
    let result;
    if (operation === "dimensions") {
      result = { width: latest.displayWidth, height: latest.displayHeight };
    } else if (operation === "snapshot") {
      const width = latest.displayWidth, height = latest.displayHeight;
      const scale = Math.min(1, 640 / width, 640 / height);
      const preview = document.createElement("canvas");
      preview.width = Math.max(1, Math.round(width * scale));
      preview.height = Math.max(1, Math.round(height * scale));
      preview.getContext("2d", { alpha: false }).drawImage(latest, 0, 0, preview.width, preview.height);
      let thumbnail = preview.toDataURL("image/jpeg", .7);
      if (thumbnail.length > 250000) thumbnail = preview.toDataURL("image/jpeg", .4);
      if (thumbnail.length > 250000) throw new Error("Preview is too large");
      result = { thumbnail, width, height, aspect: width / height };
    } else if (operation === "configure") {
      if (value.cropped && (latest.displayWidth !== value.sourceWidth || latest.displayHeight !== value.sourceHeight)) throw new Error("Capture source changed size");
      geometry = value;
      cropBuffer = value.cropped ? new OffscreenCanvas(value.cropWidth, value.cropHeight) : null;
      output.width = value.width;
      output.height = value.height;
      await source.getVideoTracks()[0].applyConstraints({ frameRate: { ideal: value.fps, max: value.fps } }).catch(() => {});
      if (stopped) throw new Error("Capture cancelled");
      paint();
      clearInterval(repaint);
      repaint = setInterval(paint, 1000 / value.fps);
      result = { width: output.width, height: output.height };
    } else throw new Error("Invalid capture command");
    window.roomsCaptureOwner.reply(id, result, null);
  } catch (error) {
    window.roomsCaptureOwner.reply(id, null, String(error.message).slice(0, 160));
    stop("unavailable");
  }
});

window.addEventListener("pagehide", () => stop(), { once: true });
