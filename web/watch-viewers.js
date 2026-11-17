const heartbeatDelay = 4000;
const requestTimeout = 5000;
const confirmationAge = 8000;
const transferGrace = 4500;

export async function reportWatchViewer(path, { method, body, keepalive, signal }, { accountId, partyId } = {}) {
  const response = await fetch(path, {
    method, keepalive, signal,
    credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "same-origin",
    headers: { "Content-Type": "application/json", ...(accountId && { "X-Rooms-Account": accountId }) },
    body: JSON.stringify(partyId ? { ...body, partyId } : body),
  });
  if (response.status !== 204) throw new Error("Watch party viewing access is unavailable.");
}

export function createWatchViewerLease({ signal, report, ownerDocument = document }) {
  const playerId = crypto.randomUUID();
  const lifetime = new AbortController();
  let revision = 0;
  let visible = false;
  let pageHidden = false;
  let reported = false;
  let confirmedAt = -Infinity;
  let pending;
  let timer;
  let transferTimer;
  let currentDocument;
  let documentBinding;

  function active() {
    return visible && !pageHidden && !currentDocument.hidden && !lifetime.signal.aborted;
  }

  function send(method) {
    const keepalive = method === "DELETE";
    const timeout = AbortSignal.timeout(requestTimeout);
    const options = {
      method, body: { playerId, revision: ++revision }, keepalive,
      signal: keepalive ? timeout : AbortSignal.any([timeout, lifetime.signal]),
    };
    return Promise.resolve().then(() => report(options));
  }

  function clearHeartbeat() {
    clearTimeout(timer);
    timer = undefined;
  }

  function pulse() {
    if (!active()) return Promise.resolve(false);
    if (pending) return pending;
    clearHeartbeat();
    reported = true;
    const sent = performance.now();
    const attempt = send("POST").then(() => {
      if (pending !== attempt || !active()) return false;
      confirmedAt = sent;
      return true;
    }, () => false).finally(() => {
      if (pending !== attempt) return;
      pending = undefined;
      if (active()) timer = setTimeout(() => void pulse(), heartbeatDelay);
    });
    pending = attempt;
    return attempt;
  }

  function sync() {
    if (active()) {
      if (!pending && timer === undefined) void pulse();
    } else {
      clearHeartbeat();
      confirmedAt = -Infinity;
      pending = undefined;
      if (!reported) return;
      reported = false;
      void send("DELETE").catch(() => {});
    }
  }

  function clearTransfer() {
    clearTimeout(transferTimer);
    transferTimer = undefined;
  }

  function stop() {
    clearTransfer();
    lifetime.abort();
    sync();
  }

  function bindDocument(nextDocument) {
    if (currentDocument === nextDocument) return;
    currentDocument = nextDocument;
    pageHidden = false;
    documentBinding?.abort();
    documentBinding = new AbortController();
    const listener = { signal: AbortSignal.any([documentBinding.signal, lifetime.signal]) };
    currentDocument.addEventListener("visibilitychange", sync, listener);
    currentDocument.defaultView?.addEventListener("pagehide", () => {
      pageHidden = true;
      sync();
    }, listener);
    currentDocument.defaultView?.addEventListener("pageshow", () => {
      pageHidden = false;
      sync();
    }, listener);
  }

  bindDocument(ownerDocument);
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true, signal: lifetime.signal });

  return {
    setVisible(next) {
      clearTransfer();
      visible = Boolean(next);
      if (visible) sync();
      else queueMicrotask(sync);
    },
    moveTo(nextDocument) {
      bindDocument(nextDocument);
      // Keep an already visible viewer while its replacement iframe connects and measures its viewport.
      if (!active()) {
        clearTransfer();
        visible = false;
      } else if (transferTimer === undefined) {
        transferTimer = setTimeout(() => {
          transferTimer = undefined;
          visible = false;
          sync();
        }, transferGrace);
      }
      sync();
    },
    ensure() {
      if (!active()) return Promise.resolve(false);
      if (performance.now() - confirmedAt < confirmationAge) return Promise.resolve(true);
      return pulse();
    },
    stop,
  };
}
