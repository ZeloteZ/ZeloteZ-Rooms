import { accountHeaders, checkAccountResponse } from "./ui.js";

const idPattern = /^[a-f0-9]{32}$/u;
const leasePattern = /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/u;

function request(path, method, body, timeout = 6000) {
  return fetch(path, {
    method, body, credentials: "same-origin", cache: "no-store", redirect: "error",
    referrer: location.origin + "/", referrerPolicy: "same-origin",
    headers: { ...accountHeaders(), ...(body === undefined ? {} : { "Content-Type": "application/sdp", Accept: "application/sdp" }) },
    signal: AbortSignal.timeout(timeout),
    keepalive: method === "DELETE",
  }).then(checkAccountResponse);
}

function iceComplete(peer, signal) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const deadline = AbortSignal.timeout(6000);
    function cleanup() {
      peer.removeEventListener("icegatheringstatechange", changed);
      signal.removeEventListener("abort", aborted);
      deadline.removeEventListener("abort", aborted);
    }
    function changed() {
      if (peer.iceGatheringState !== "complete") return;
      cleanup();
      resolve();
    }
    function aborted() {
      cleanup();
      reject(signal.reason ?? deadline.reason);
    }
    peer.addEventListener("icegatheringstatechange", changed);
    signal.addEventListener("abort", aborted, { once: true });
    deadline.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    else changed();
  });
}

export function canPlayDirectly(stream) {
  return Boolean(idPattern.test(stream.id) && stream.whepUrl === "/api/streams/" + stream.id + "/whep"
    && typeof RTCPeerConnection === "function" && typeof MediaStream === "function");
}

export function startWhep(stream, onMedia, onFailure, { onPeer } = {}) {
  const peer = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const source = new MediaStream();
  const controller = new AbortController();
  const { signal } = controller;
  let lease;
  let released = false;
  let heartbeat;
  let disconnectTimer;

  function release() {
    if (!lease || released) return;
    released = true;
    request(lease, "DELETE").catch(() => {});
  }

  function close() {
    if (signal.aborted) return;
    controller.abort();
    clearTimeout(heartbeat);
    clearTimeout(disconnectTimer);
    onPeer?.(null);
    peer.close();
    release();
  }

  function fail() {
    if (signal.aborted) return;
    close();
    onFailure();
  }

  async function maintain() {
    try {
      const response = await request(lease, "PATCH");
      if ([401, 403, 404, 410].includes(response.status)) return fail();
    } catch {
      // A short HTTP interruption need not interrupt the connected peer.
    }
    if (!signal.aborted) heartbeat = setTimeout(maintain, 12000);
  }

  peer.addEventListener("track", ({ track }) => {
    if (signal.aborted) return;
    source.addTrack(track);
    if (track.kind === "video") {
      track.addEventListener("ended", fail, { once: true, signal });
      onMedia(source);
    }
  }, { signal });
  peer.addEventListener("connectionstatechange", () => {
    clearTimeout(disconnectTimer);
    if (["failed", "closed"].includes(peer.connectionState)) fail();
    else if (peer.connectionState === "disconnected") disconnectTimer = setTimeout(fail, 4500);
  }, { signal });

  async function open() {
    peer.addTransceiver("video", { direction: "recvonly" });
    if (stream.hasAudio) peer.addTransceiver("audio", { direction: "recvonly" });
    await peer.setLocalDescription(await peer.createOffer());
    await iceComplete(peer, signal);
    signal.throwIfAborted();
    // Let a started POST return its lease even if the viewer switches streams.
    const response = await request(stream.whepUrl, "POST", peer.localDescription.sdp, 10000);
    const prefix = stream.whepUrl + "/";
    const location = response.headers.get("Location");
    if (response.status !== 201 || !location?.startsWith(prefix) || !leasePattern.test(location.slice(prefix.length))) {
      throw new Error("Invalid playback session.");
    }
    lease = location;
    if (signal.aborted) {
      release();
      return;
    }
    if (!response.headers.get("Content-Type")?.startsWith("application/sdp")) throw new Error("Missing playback answer.");
    await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
    if (!signal.aborted) heartbeat = setTimeout(maintain, 12000);
  }

  open().catch(fail);
  onPeer?.(peer);
  return close;
}
