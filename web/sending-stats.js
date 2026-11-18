const nonnegative = value => Number.isFinite(value) && value >= 0 ? value : null;
const positive = value => Number.isFinite(value) && value > 0 ? value : null;
const repairCodecs = new Set(["video/rtx", "video/red", "video/ulpfec", "video/flexfec-03"]);
const maximumReportAge = 10_000;

function rate(current, previous, milliseconds, multiplier = 1) {
  if (current === null || previous === null || current < previous || milliseconds <= 0) return null;
  return nonnegative((current - previous) * multiplier * 1000 / milliseconds);
}

function codecName(reports, report) {
  const mime = reports.get(report.codecId)?.mimeType;
  return typeof mime === "string" && /^video\/[a-z0-9.+-]{1,40}$/i.test(mime)
    ? mime.slice(6) : null;
}

function remoteReport(reports, outbound) {
  const linked = reports.get(outbound.remoteId);
  if (linked?.type === "remote-inbound-rtp" && (!linked.localId || linked.localId === outbound.id)) return linked;
  return [...reports.values()].find(report => report.type === "remote-inbound-rtp" && report.localId === outbound.id);
}

export function createSendingStats(peer, { startedAt = performance.now() } = {}) {
  let destroyed = false;
  let stoppedAt = null;
  let previousRtp = new Map();
  let previousRemote = new Map();

  function snapshot() {
    return {
      elapsed: Math.max(0, (stoppedAt ?? performance.now()) - startedAt) / 1000,
      width: null,
      height: null,
      fps: null,
      mbps: null,
      packetLoss: null,
      jitterMs: null,
      framesDropped: null,
      codec: null,
    };
  }

  return {
    async sample() {
      const result = snapshot();
      if (destroyed) return result;
      try {
        const reports = await peer.getStats();
        if (destroyed) return snapshot();
        const nextRtp = new Map();
        const nextRemote = new Map();
        let primary = null;
        let bitsPerSecond = 0;
        let hasBitrate = false;
        for (const report of reports.values()) {
          if (report.type !== "outbound-rtp" || (report.kind ?? report.mediaType) !== "video"
            || report.isRemote || report.active === false) continue;
          const mime = reports.get(report.codecId)?.mimeType?.toLowerCase();
          if (repairCodecs.has(mime)) continue;
          const counters = { timestamp: nonnegative(report.timestamp), bytes: nonnegative(report.bytesSent),
            frames: nonnegative(report.framesEncoded) };
          const previous = previousRtp.get(report.id);
          nextRtp.set(report.id, counters);
          const interval = previous && counters.timestamp !== null && previous.timestamp !== null
            ? counters.timestamp - previous.timestamp : 0;
          const outgoing = rate(counters.bytes, previous?.bytes ?? null, interval, 8);
          if (outgoing !== null) { bitsPerSecond += outgoing; hasBitrate = true; }
          const measured = {
            report,
            width: positive(report.frameWidth),
            height: positive(report.frameHeight),
            fps: nonnegative(report.framesPerSecond) ?? rate(counters.frames, previous?.frames ?? null, interval),
          };
          // A broadcast has one video track. Prefer its largest active encoding if simulcast is available.
          if (!primary || (measured.width ?? 0) * (measured.height ?? 0) > (primary.width ?? 0) * (primary.height ?? 0)) {
            primary = measured;
          }
        }
        previousRtp = nextRtp;
        result.mbps = hasBitrate ? bitsPerSecond / 1_000_000 : null;
        if (primary) {
          const { report } = primary;
          result.width = primary.width;
          result.height = primary.height;
          result.fps = primary.fps;
          result.codec = codecName(reports, report);
          // Source/encoded-frame differences include adaptation and asynchronous samples, not measured drops.
          result.framesDropped = nonnegative(report.framesDropped);
          const remote = remoteReport(reports, report);
          if (remote) {
            const previous = previousRemote.get(remote.id);
            const timestamp = nonnegative(remote.timestamp);
            const localTimestamp = nonnegative(report.timestamp);
            const counters = { timestamp, received: nonnegative(remote.packetsReceived),
              lost: nonnegative(remote.packetsLost), packetLoss: null };
            const fresh = timestamp !== null && localTimestamp !== null && timestamp <= localTimestamp
              && localTimestamp - timestamp <= maximumReportAge
              && (!previous || previous.timestamp === null || timestamp >= previous.timestamp);
            if (fresh) {
              const fraction = nonnegative(remote.fractionLost);
              if (fraction !== null && fraction <= 1) counters.packetLoss = fraction * 100;
              else if (previous && timestamp === previous.timestamp) counters.packetLoss = previous.packetLoss;
              else if (previous && previous.timestamp !== null && timestamp > previous.timestamp) {
                const received = counters.received !== null && previous.received !== null
                  ? counters.received - previous.received : null;
                const lost = counters.lost !== null && previous.lost !== null ? counters.lost - previous.lost : null;
                if (received !== null && lost !== null && received >= 0 && lost >= 0 && received + lost > 0) {
                  counters.packetLoss = lost * 100 / (received + lost);
                }
              }
              result.packetLoss = counters.packetLoss;
              const jitter = nonnegative(remote.jitter);
              result.jitterMs = jitter === null ? null : jitter * 1000;
            }
            // Repeated RR timestamps are normal between RTCP updates; retain their last measured interval.
            if (!previous || timestamp !== null && (previous.timestamp === null || timestamp >= previous.timestamp)) {
              nextRemote.set(remote.id, counters);
            } else nextRemote.set(remote.id, previous);
          }
        }
        previousRemote = nextRemote;
      } catch {
        // A closed sender has no current network measurements.
      }
      return result;
    },
    destroy() {
      if (destroyed) return;
      stoppedAt = performance.now();
      destroyed = true;
      previousRtp.clear();
      previousRemote.clear();
    },
  };
}
