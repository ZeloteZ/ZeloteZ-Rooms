"use strict";

// This document never loads remote content. Its only visible surface is the
// confirmed output canvas. Raw frames and preview canvases never enter its DOM.
const output = document.getElementById("output");
const context = output.getContext("2d", { alpha: false });
let source, reader, nativeFrames, latest, firstFrame, geometry, cropContext, repaint, refresh, starting;
let nextPaint = 0, stopped = false;

function stop(reason = "ended") {
  if (stopped) return;
  stopped = true;
  clearTimeout(repaint);
  clearInterval(refresh);
  context.fillStyle = "#000";
  context.fillRect(0, 0, output.width, output.height);
  reader?.cancel().catch(() => {});
  nativeFrames?.close();
  for (const track of source?.getTracks() ?? []) track.stop();
  latest?.close();
  latest = null;
  firstFrame?.reject(new Error("The capture source ended"));
  firstFrame = null;
  window.roomsCaptureOwner.ended(reason);
}

function matchesRegion(frame, dimensions) {
  return frame.displayWidth === dimensions.sourceWidth && frame.displayHeight === dimensions.sourceHeight;
}

function paint(frame) {
  context.fillStyle = "#000";
  context.fillRect(0, 0, output.width, output.height);
  if (geometry.cropped) {
    // Materialize only the allowed pixels before scaling. Interpolation must not
    // sample a neighboring source pixel outside the selected rectangle.
    cropContext.drawImage(frame, geometry.x, geometry.y,
      geometry.cropWidth, geometry.cropHeight, 0, 0, geometry.cropWidth, geometry.cropHeight);
    context.drawImage(cropContext.canvas, 0, 0, output.width, output.height);
  } else {
    // A full-window share remains a full-window share when that window resizes.
    const scale = Math.min(output.width / frame.displayWidth, output.height / frame.displayHeight);
    const width = frame.displayWidth * scale, height = frame.displayHeight * scale;
    context.drawImage(frame, 0, 0, frame.displayWidth, frame.displayHeight,
      (output.width - width) / 2, (output.height - height) / 2, width, height);
  }
}

function paintLatest() {
  if (!stopped && geometry && latest) {
    try { paint(latest); } catch { stop("unavailable"); }
  }
}

function schedulePaint() {
  if (stopped || !geometry || !latest || repaint !== undefined) return;
  const now = performance.now();
  if (now < nextPaint) {
    repaint = setTimeout(() => {
      repaint = undefined;
      schedulePaint();
    }, nextPaint - now);
    return;
  }
  const interval = 1000 / geometry.fps;
  nextPaint = now - nextPaint < interval ? nextPaint + interval : now + interval;
  paintLatest();
}

function acceptFrame(frame) {
  if (stopped) { frame.close(); return; }
  latest?.close();
  latest = frame;
  if (geometry?.cropped && !matchesRegion(frame, geometry)) {
    stop("resized");
    return;
  }
  firstFrame?.resolve({ width: frame.displayWidth, height: frame.displayHeight });
  firstFrame = null;
  if (nativeFrames) schedulePaint();
}

function waitForFrame() {
  return new Promise((resolve, reject) => { firstFrame = { resolve, reject }; });
}

function startNative() {
  const channel = new MessageChannel();
  nativeFrames = channel.port1;
  nativeFrames.onmessage = ({ data: frame }) => {
    if (!(frame instanceof VideoFrame)) { stop("unavailable"); return; }
    acceptFrame(frame);
    if (!stopped) nativeFrames.postMessage("received");
  };
  nativeFrames.onmessageerror = () => stop("unavailable");
  const ready = waitForFrame();
  window.postMessage("rooms:capture-owner-native-port", "*", [channel.port2]);
  return ready;
}

async function startChromium() {
  source = await navigator.mediaDevices.getDisplayMedia({ audio: false,
    video: { resizeMode: "none", frameRate: { ideal: 60, max: 60 } } });
  if (stopped) { for (const track of source.getTracks()) track.stop(); throw new Error("Capture cancelled"); }
  const track = source.getVideoTracks()[0];
  if (!track) throw new Error("No capture track");
  track.addEventListener("ended", () => stop(), { once: true });
  reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 }).readable.getReader();
  const ready = waitForFrame();
  void (async () => {
    try {
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        acceptFrame(value);
      }
    } catch { /* Closing the trusted owner cancels its reader. */ }
    stop();
  })();
  return ready;
}

window.roomsStartLocalCapture = ({ native = false } = {}) => starting ??=
  (native ? startNative() : startChromium());

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
      if (source) await source.getVideoTracks()[0].applyConstraints({ frameRate: { ideal: value.fps, max: value.fps } }).catch(() => {});
      if (stopped) throw new Error("Capture cancelled");
      if (value.cropped && !matchesRegion(latest, value)) throw new Error("Capture source changed size");
      geometry = value;
      cropContext = value.cropped ? new OffscreenCanvas(value.cropWidth, value.cropHeight).getContext("2d", { alpha: false }) : null;
      if (cropContext) cropContext.globalCompositeOperation = "copy";
      output.width = value.width;
      output.height = value.height;
      clearTimeout(repaint);
      clearInterval(refresh);
      repaint = undefined;
      nextPaint = 0;
      if (nativeFrames) schedulePaint(); else paintLatest();
      if (stopped) throw new Error("Capture cancelled");
      if (nativeFrames) {
        // WGC can stop delivering frames on a still screen. Refresh slowly
        // after inactivity so a video-only stream still has frame updates.
        refresh = setInterval(() => {
          if (performance.now() - nextPaint >= 1000 - 1000 / geometry.fps) schedulePaint();
        }, 1000);
      } else {
        refresh = setInterval(paintLatest, 1000 / geometry.fps);
      }
      result = { width: output.width, height: output.height };
    } else throw new Error("Invalid capture command");
    window.roomsCaptureOwner.reply(id, result, null);
  } catch (error) {
    window.roomsCaptureOwner.reply(id, null, String(error.message).slice(0, 160));
    stop("unavailable");
  }
});

window.addEventListener("pagehide", () => stop(), { once: true });
