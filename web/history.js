import { api, identifier } from "./ui.js";
import { t } from "./i18n.js";

const batchSize = 24;
const betweenPages = 1200;
const idleDelay = 15000;
const firstRetry = 3000;
const maxRetry = 60000;

export function startHistorySharing(signal, accountId) {
  if (signal.aborted || !accountId) return;

  let cursor = null;
  let timer;
  let running = false;
  let sessionChanged = false;
  let retryDelay = firstRetry;

  function schedule(delay) {
    clearTimeout(timer);
    if (!signal.aborted && !sessionChanged && navigator.onLine !== false) timer = setTimeout(run, delay);
  }

  async function sharePage() {
    const query = new URLSearchParams({ limit: String(batchSize) });
    if (cursor !== null) query.set("cursor", cursor);
    const { job, nextCursor, grantorId } = await api("history/pending?" + query, { signal });
    if (signal.aborted) return idleDelay;
    if (grantorId !== accountId) {
      sessionChanged = true;
      return idleDelay;
    }
    if (job === null) {
      cursor = null;
      return idleDelay;
    }

    const { channelId, recipient, messages } = job;
    if (typeof nextCursor !== "string" || !nextCursor || nextCursor === cursor ||
        typeof channelId !== "string" || typeof recipient?.id !== "string" ||
        !Array.isArray(messages) || !messages.length || messages.length > batchSize) {
      throw new Error(t("The server returned an invalid history sync response.", "Ungültige Antwort bei der Verlaufssynchronisierung."));
    }

    // A stale key or a damaged old key box must not block other messages or chats.
    const entries = await Promise.allSettled(messages.map(async entry => {
      const { deletionRevision } = entry;
      const scope = deletionRevision === undefined ? channelId : ClubCrypto.deletionScope(channelId);
      return {
        messageId: entry.id, wrapper: await ClubCrypto.wrapHistoryKey(scope, entry, recipient),
        ...(deletionRevision === undefined ? {} : { deletionRevision }),
      };
    }));
    if (signal.aborted) return idleDelay;
    const grants = entries.filter(entry => entry.status === "fulfilled").map(entry => entry.value);
    if (grants.length) {
      try {
        await api("channels/" + identifier(channelId) + "/history-grants", {
          method: "POST", signal, body: { grantorId: accountId, recipientId: recipient.id, grants },
        });
      } catch (error) {
        // Membership or session state can change between the two requests; revisit this page in a fresh sweep.
        if (![403, 404, 409].includes(error.status)) throw error;
      }
    }
    cursor = nextCursor;
    return betweenPages;
  }

  async function run() {
    if (running || signal.aborted || sessionChanged || navigator.onLine === false) return;
    running = true;
    try {
      const delay = navigator.locks
        ? await navigator.locks.request("zelotez-history-sharing", { ifAvailable: true }, lock =>
          lock && !signal.aborted ? sharePage() : firstRetry)
        : await sharePage();
      retryDelay = firstRetry;
      schedule(delay);
    } catch (error) {
      if (!signal.aborted && error.status !== 401) {
        schedule(retryDelay);
        retryDelay = Math.min(retryDelay * 2, maxRetry);
      }
    } finally {
      running = false;
    }
  }

  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  window.addEventListener("online", () => schedule(0), { signal });
  run();
}
