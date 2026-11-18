const nonnegative = value => Number.isFinite(value) && value >= 0 ? value : null;
const positive = value => Number.isFinite(value) && value > 0 ? value : null;

function displayedFrames(video) {
  try {
    const quality = video.getVideoPlaybackQuality?.();
    if (Number.isFinite(quality?.totalVideoFrames) && Number.isFinite(quality?.droppedVideoFrames)) {
      return nonnegative(quality.totalVideoFrames - quality.droppedVideoFrames);
    }
    return nonnegative(video.webkitDecodedFrameCount);
  } catch {
    return null;
  }
}

function droppedFrames(video) {
  try {
    const quality = video.getVideoPlaybackQuality?.();
    return nonnegative(quality?.droppedVideoFrames)
      ?? nonnegative(video.webkitDroppedFrameCount);
  } catch {
    return null;
  }
}

function codecName(value) {
  if (typeof value !== "string") return null;
  const codec = value.replace(/^video\//iu, "");
  return /^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(codec) ? codec : null;
}

function rate(current, previous, milliseconds, multiplier = 1) {
  if (current === null || previous === null || current < previous || milliseconds <= 0) return null;
  return nonnegative((current - previous) * multiplier * 1000 / milliseconds);
}

export function createPlaybackStats(video) {
  const lifetime = new AbortController();
  let peer;
  let hls;
  let fragmentEvent;
  let fragmentLoaded;
  let codecEvent;
  let codecParsed;
  let hlsCodec;
  let generation = 0;
  let destroyed = false;
  let receivedBytes = 0;
  let previousBytes = 0;
  let previousFrames = null;
  let previousSample = performance.now();
  let previousRtp = new Map();
  let elapsed = 0;
  let playingSince = !video.paused && video.readyState >= 3 ? performance.now() : null;

  function stopClock() {
    if (playingSince !== null) elapsed += Math.max(0, performance.now() - playingSince);
    playingSince = null;
  }

  video.addEventListener("playing", () => {
    if (playingSince === null) playingSince = performance.now();
  }, { signal: lifetime.signal });
  for (const event of ["pause", "waiting", "ended", "emptied"]) {
    video.addEventListener(event, stopClock, { signal: lifetime.signal });
  }

  function detachHls() {
    if (hls && fragmentLoaded) hls.off(fragmentEvent, fragmentLoaded);
    if (hls && codecParsed) hls.off(codecEvent, codecParsed);
    hls = fragmentEvent = fragmentLoaded = undefined;
    codecEvent = codecParsed = hlsCodec = undefined;
  }

  function resetMeters() {
    generation++;
    receivedBytes = previousBytes = 0;
    previousFrames = null;
    previousSample = performance.now();
    previousRtp = new Map();
  }

  function snapshot() {
    const currentTime = playingSince === null ? 0 : Math.max(0, performance.now() - playingSince);
    return {
      elapsed: Math.max(0, elapsed + currentTime) / 1000,
      width: positive(video.videoWidth),
      height: positive(video.videoHeight),
      fps: null,
      mbps: null,
      packetLoss: null,
      jitterMs: null,
      framesDropped: droppedFrames(video),
      codec: null,
    };
  }

  return {
    setPeer(next) {
      detachHls();
      peer = next;
      resetMeters();
    },
    setHls(instance, Hls) {
      detachHls();
      peer = null;
      resetMeters();
      hls = instance;
      fragmentEvent = Hls.Events.FRAG_LOADED;
      fragmentLoaded = (_event, data) => {
        if (destroyed || !["main", "video"].includes(data?.frag?.type)) return;
        const bytes = positive(data.payload?.byteLength) ?? positive((data.part ?? data.frag).stats?.loaded);
        if (bytes !== null && Number.isSafeInteger(bytes) && Number.isSafeInteger(receivedBytes + bytes)) {
          receivedBytes += bytes;
        }
      };
      hls.on(fragmentEvent, fragmentLoaded);
      codecEvent = Hls.Events.FRAG_PARSING_INIT_SEGMENT;
      if (codecEvent) {
        codecParsed = (_event, data) => {
          if (!destroyed && data?.tracks?.video) hlsCodec = codecName(data.tracks.video.codec);
        };
        hls.on(codecEvent, codecParsed);
      }
    },
    reset() {
      detachHls();
      peer = null;
      resetMeters();
      elapsed = 0;
      playingSince = null;
    },
    async sample() {
      const result = snapshot();
      if (destroyed) return result;
      const currentGeneration = generation;
      const now = performance.now();
      const milliseconds = now - previousSample;
      const frames = displayedFrames(video);
      const playing = !video.paused && !video.ended && playingSince !== null;
      result.fps = result.width && result.height
        ? playing ? rate(frames, previousFrames, milliseconds) : 0 : null;
      if (hls) {
        result.mbps = rate(receivedBytes, previousBytes, milliseconds, 8 / 1_000_000);
        result.codec = hlsCodec ?? codecName(hls.levels?.[hls.currentLevel]?.videoCodec);
      }
      previousSample = now;
      previousFrames = frames;
      previousBytes = receivedBytes;

      if (!peer) return result;
      try {
        const reports = await peer.getStats();
        if (destroyed || currentGeneration !== generation) return snapshot();
        const nextRtp = new Map();
        let bitsPerSecond = 0;
        let hasBitrate = false;
        let decodedRate = 0;
        let hasDecodedRate = false;
        let lostPackets = 0;
        let receivedPackets = 0;
        let hasPacketInterval = false;
        let dropped = 0;
        let hasDropped = false;
        for (const report of reports.values()) {
          if (report.type !== "inbound-rtp" || (report.kind ?? report.mediaType) !== "video" || report.isRemote) continue;
          const codec = reports.get(report.codecId)?.mimeType?.toLowerCase();
          if (["video/rtx", "video/red", "video/ulpfec", "video/flexfec-03"].includes(codec)) continue;
          result.codec ??= codecName(reports.get(report.codecId)?.mimeType);
          const jitterMs = nonnegative(report.jitter) === null ? null : nonnegative(report.jitter * 1000);
          if (jitterMs !== null) result.jitterMs = Math.max(result.jitterMs ?? 0, jitterMs);
          const framesDropped = nonnegative(report.framesDropped);
          if (framesDropped !== null) { dropped += framesDropped; hasDropped = true; }
          const counters = { timestamp: nonnegative(report.timestamp), bytes: nonnegative(report.bytesReceived),
            frames: nonnegative(report.framesDecoded), packets: nonnegative(report.packetsReceived),
            lost: nonnegative(report.packetsLost) };
          const previous = previousRtp.get(report.id);
          nextRtp.set(report.id, counters);
          const interval = previous && counters.timestamp !== null && previous.timestamp !== null
            ? counters.timestamp - previous.timestamp : 0;
          const incoming = rate(counters.bytes, previous?.bytes ?? null, interval, 8);
          if (incoming !== null) { bitsPerSecond += incoming; hasBitrate = true; }
          if (interval > 0 && counters.packets !== null && previous.packets !== null &&
              counters.lost !== null && previous.lost !== null &&
              counters.packets >= previous.packets && counters.lost >= previous.lost) {
            receivedPackets += counters.packets - previous.packets;
            lostPackets += counters.lost - previous.lost;
            hasPacketInterval = true;
          }
          const decoded = nonnegative(report.framesPerSecond)
            ?? rate(counters.frames, previous?.frames ?? null, interval);
          if (decoded !== null) { decodedRate += decoded; hasDecodedRate = true; }
        }
        previousRtp = nextRtp;
        result.mbps = hasBitrate ? bitsPerSecond / 1_000_000 : null;
        if (hasPacketInterval && receivedPackets + lostPackets > 0) {
          result.packetLoss = lostPackets * 100 / (receivedPackets + lostPackets);
        }
        if (hasDropped) result.framesDropped = dropped;
        if (hasDecodedRate && result.width && result.height) result.fps = playing ? decodedRate : 0;
      } catch {
        // Keep local decoded-frame measurements when a receiver has closed.
      }
      return result;
    },
    destroy() {
      stopClock();
      destroyed = true;
      generation++;
      lifetime.abort();
      detachHls();
      peer = null;
    },
  };
}
