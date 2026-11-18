"use strict";

const { execFile, spawn } = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");
const { app, screen, sharedTexture } = require("electron");

const execute = promisify(execFile);

async function probeWindowsCapture() {
  if (process.platform !== "win32" || process.arch !== "x64" ||
      !sharedTexture?.importSharedTexture || !sharedTexture?.sendSharedTexture) return null;
  const root = app.isPackaged ? process.resourcesPath : __dirname;
  const executable = path.join(root, "windows-video", "rooms-windows-capture.exe");
  const result = await execute(executable, ["--probe"], { timeout: 3000, maxBuffer: 4096, windowsHide: true })
    .catch(() => null);
  return result?.stdout.trim() === "ok" ? executable : null;
}

function captureArguments(source) {
  if (typeof source?.id !== "string") return null;
  const window = /^window:([1-9][0-9]{0,19}):[0-9]+$/u.exec(source.id);
  if (window && BigInt(window[1]) <= 0xffffffffffffffffn) return ["window", window[1]];
  if (!source.id.startsWith("screen:") || typeof source.display_id !== "string" || !source.display_id) return null;
  const display = screen.getAllDisplays().find(candidate => String(candidate.id) === source.display_id);
  if (!display) return null;
  const { x, y, width, height } = display.bounds;
  const point = screen.dipToScreenPoint({ x: x + Math.floor(width / 2), y: y + Math.floor(height / 2) });
  return [point.x, point.y].every(Number.isSafeInteger) ? ["monitor", String(point.x), String(point.y)] : null;
}

function readFrame(line) {
  const frame = JSON.parse(line);
  if (frame?.type !== "frame" || typeof frame.handle !== "string" || !/^[0-9a-f]{1,16}$/u.test(frame.handle) ||
      ![frame.sequence, frame.width, frame.height, frame.timestamp].every(Number.isSafeInteger) ||
      frame.sequence < 1 || frame.timestamp < 0 || frame.width < 1 || frame.height < 1 ||
      frame.width > 16384 || frame.height > 16384 || BigInt("0x" + frame.handle) === 0n) return null;
  return frame;
}

function startWindowsCapture(executable, source, frameTarget, onEnded) {
  const target = captureArguments(source);
  if (!target) throw new Error("Selected source has no Windows capture target");
  const child = spawn(executable, ["capture", String(process.pid), ...target], {
    windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
  });
  let closed = false, buffer = "", sequence = 0, outstanding = 0, timeout;
  const send = message => { if (!closed && child.stdin.writable) child.stdin.write(message + "\n"); };

  function close() {
    if (closed) return;
    closed = true;
    if (child.stdin.writable) child.stdin.end("stop\n");
    if (child.exitCode === null && child.signalCode === null) {
      timeout = setTimeout(() => child.kill(), 1500);
      timeout.unref();
    }
  }

  function fail() {
    if (closed) return;
    close();
    onEnded();
  }

  async function transfer(frame) {
    let texture;
    try {
      const frameDestination = frameTarget();
      if (!frameDestination) { fail(); return; }
      const ntHandle = Buffer.alloc(8);
      ntHandle.writeBigUInt64LE(BigInt("0x" + frame.handle));
      texture = sharedTexture.importSharedTexture({
        textureInfo: { pixelFormat: "bgra", codedSize: { width: frame.width, height: frame.height },
          handle: { ntHandle }, timestamp: frame.timestamp },
        allReferencesReleased: () => { outstanding--; send("ack " + frame.sequence); },
      });
      await sharedTexture.sendSharedTexture({ frame: frameDestination, importedSharedTexture: texture }, frame.sequence);
    } catch {
      fail();
    } finally {
      texture?.release();
    }
  }

  child.stdin.on("error", fail);
  child.stdout.setEncoding("utf8");
  child.stdout.on("error", fail);
  child.stdout.on("data", chunk => {
    if (closed) return;
    buffer += chunk;
    if (buffer.length > 8192) { fail(); return; }
    for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
      let frame;
      try { frame = readFrame(buffer.slice(0, end)); } catch { /* Broken helper frame. */ }
      buffer = buffer.slice(end + 1);
      if (!frame || frame.sequence !== sequence + 1 || outstanding >= 3) { fail(); return; }
      sequence = frame.sequence;
      outstanding++;
      void transfer(frame);
      if (closed) return;
    }
  });
  child.once("error", fail);
  child.once("close", () => { clearTimeout(timeout); fail(); });
  return { close, setFrameRate: fps => { if (fps === 30 || fps === 60) send("fps " + fps); } };
}

module.exports = { probeWindowsCapture, startWindowsCapture };
