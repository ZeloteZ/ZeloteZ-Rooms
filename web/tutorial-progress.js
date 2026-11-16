import { api } from "./ui.js";

export function createTutorialProgress(accountId, chapters, signal, onChange) {
  const legacyKey = "zelotez-rooms-tutorials:" + accountId;
  const pendingKey = chapter => legacyKey + ":pending:" + chapter;
  const pending = new Set();
  let confirmed = new Set();
  let generation;
  let readNeeded = true;
  let resetting = false;
  let flight;
  let retry;
  let legacy = [];

  try {
    const value = JSON.parse(localStorage.getItem(legacyKey));
    if (Array.isArray(value)) legacy = chapters.filter(chapter => value.includes(chapter));
  } catch { /* Storage can be blocked in embedded browsers. */ }

  const updates = typeof BroadcastChannel === "function" ? new BroadcastChannel(legacyKey) : null;

  function request(method = "GET", body) {
    return api("tutorials", {
      method, body, keepalive: method !== "GET",
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    });
  }

  function apply(state) {
    if (signal.aborted) return;
    if (generation !== state.generation) pending.clear();
    generation = state.generation;
    confirmed = new Set(state.completed);
    for (const chapter of chapters) {
      try {
        const saved = localStorage.getItem(pendingKey(chapter));
        if (saved === String(generation) && !confirmed.has(chapter)) pending.add(chapter);
        else if (saved !== null && Number(saved) <= generation) localStorage.removeItem(pendingKey(chapter));
      } catch { /* Keep in-memory progress until it is synced. */ }
    }
    if (generation === 0) {
      for (const chapter of legacy) if (!confirmed.has(chapter)) pending.add(chapter);
    }
    if (generation > 0 || legacy.every(chapter => confirmed.has(chapter))) {
      legacy = [];
      try { localStorage.removeItem(legacyKey); } catch { /* The server has the current progress. */ }
    }
    for (const chapter of confirmed) pending.delete(chapter);
    onChange();
  }

  function sync(read = false) {
    readNeeded ||= read;
    if (flight || resetting || signal.aborted || navigator.onLine === false) return flight;
    clearTimeout(retry);
    flight = exchange().then(delay => {
      flight = undefined;
      if (!signal.aborted && !resetting && (readNeeded || pending.size)) {
        retry = setTimeout(sync, delay);
      }
    });
    return flight;
  }

  async function exchange() {
    try {
      if (readNeeded) {
        readNeeded = false;
        apply(await request());
      }
      if (!signal.aborted && pending.size) {
        apply(await request("PATCH", { generation, completed: [...pending] }));
        updates?.postMessage("updated");
      }
      return 0;
    } catch (error) {
      // Read the new generation before resending anything after a reset.
      readNeeded = true;
      return error.status === 409 ? 0 : 5000;
    }
  }

  function complete(chapter) {
    if (generation === undefined || resetting || signal.aborted) return;
    pending.add(chapter);
    try { localStorage.setItem(pendingKey(chapter), String(generation)); } catch { /* The request still saves it. */ }
    void sync();
  }

  async function reset() {
    clearTimeout(retry);
    resetting = true;
    try {
      await flight;
      signal.throwIfAborted();
      if (generation === undefined) apply(await request());
      const previous = generation;
      try {
        apply(await request("DELETE", { generation: previous }));
      } catch (error) {
        if (error.status !== 409) throw error;
        apply(await request());
        if (generation === previous) throw error;
      }
      updates?.postMessage("updated");
    } finally {
      resetting = false;
      if (readNeeded || pending.size) void sync();
    }
  }

  window.addEventListener("online", () => sync(true), { signal });
  window.addEventListener("focus", () => sync(true), { signal });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void sync(true);
  }, { signal });
  updates?.addEventListener("message", () => sync(true), { signal });
  signal.addEventListener("abort", () => {
    clearTimeout(retry);
    updates?.close();
  }, { once: true });

  return {
    get ready() { return generation !== undefined; },
    has: chapter => confirmed.has(chapter) || pending.has(chapter),
    sync, complete, reset,
  };
}
