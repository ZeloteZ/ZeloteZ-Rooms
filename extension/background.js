import { browserHandoff, configFrom, configKey, permissionFor, uuid, verifyInstance, videoIdPattern, youtubeVideoId } from "./links.mjs";
import { createSignedInRoom, readRoomsAccount } from "./create-room.mjs";

const api = globalThis.browser ?? globalThis.chrome;
const panel = api.runtime.getURL("panel.html");
const handoffTabs = new Map();
const launching = new Set();

api.action.onClicked.addListener(() => void api.runtime.openOptionsPage().catch(() => {}));
api.tabs.onRemoved.addListener(tabId => handoffTabs.delete(tabId));

function onInstance(address, origin) {
  try {
    const url = new URL(address);
    return url.origin === origin && url.pathname === "/" && !url.search && !url.username && !url.password;
  } catch {
    return false;
  }
}

function atAddress(tab, address) {
  return tab?.url === address && !tab.discarded && (!tab.pendingUrl || tab.pendingUrl === address);
}

async function waitForTab(tabId, address, previous) {
  for (const deadline = Date.now() + 8000; Date.now() < deadline;) {
    const tab = await api.tabs.get(tabId);
    if (tab.pendingUrl && tab.pendingUrl !== address) return null;
    if (atAddress(tab, address) && tab.status === "complete") return tab;
    if (tab.status === "complete" && tab.url && tab.url !== address && tab.url !== previous && tab.pendingUrl !== address) return null;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  return null;
}

function sameContext(first, second) {
  return first.windowId === second.windowId && first.incognito === second.incognito && first.cookieStoreId === second.cookieStoreId;
}

async function execute(tabId, func, args) {
  const [result] = await api.scripting.executeScript({ target: { tabId, frameIds: [0] }, func, args });
  return result?.result;
}

async function reuseOpenRoom(handoff, origin, videoId, audience) {
  const account = await execute(handoff.id, readRoomsAccount, [origin]);
  if (typeof account !== "string" || !uuid.test(account)) return false;
  const tabs = await api.tabs.query({ windowId: handoff.windowId });
  const candidates = tabs.filter(tab => Number.isInteger(tab.id) && tab.id !== handoff.id && sameContext(tab, handoff) &&
    atAddress(tab, tab.url) && tab.status === "complete" && onInstance(tab.url, origin))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)).slice(0, 6);
  for (const candidate of candidates) {
    if (!atAddress(await api.tabs.get(handoff.id), origin + "/")) return false;
    const result = await execute(candidate.id, createSignedInRoom, [origin, videoId, account, candidate.url, audience])
      .catch(() => ({ handled: false }));
    if (!result) continue;
    // Do not retry a room mutation from another tab if the first response was incomplete.
    if (!uuid.test(result.topicId ?? "") || !uuid.test(result.channelId ?? "")) return false;
    const destination = origin + "/#/rooms/" + result.topicId + "/" + result.channelId;
    const opened = await waitForTab(candidate.id, destination, candidate.url);
    if (!opened || !sameContext(opened, handoff)) return false;
    await api.tabs.update(opened.id, { active: true });
    if (handoffTabs.get(handoff.id) === videoId) {
      const temporaryTab = await api.tabs.get(handoff.id).catch(() => null);
      if (atAddress(temporaryTab, origin + "/") && temporaryTab.status === "complete") await api.tabs.remove(handoff.id).catch(() => {});
    }
    return true;
  }
  return false;
}

async function launchInBrowser(tabId, videoId, origin, audience) {
  const source = panel + "#" + videoId;
  let moved = false;
  const trackNavigation = (id, change) => {
    if (id === tabId && (change.status === "loading" || (change.url && change.url !== source))) moved = true;
  };
  api.tabs.onUpdated.addListener(trackNavigation);
  try {
    const stored = await api.storage.local.get(configKey);
    const config = configFrom(stored[configKey]);
    if (!config || config.origin !== origin || !await api.permissions.contains(permissionFor(config.origin))) throw new Error("permissionRequired");
    await verifyInstance(origin);
    const tab = await api.tabs.get(tabId);
    // Some browsers omit the URL of the sender's own extension page from tabs.get().
    if (moved || tab.discarded || (tab.pendingUrl && tab.pendingUrl !== source) || (tab.url !== undefined && tab.url !== source)) return;
  } finally {
    api.tabs.onUpdated.removeListener(trackNavigation);
  }
  await api.tabs.update(tabId, { url: origin + "/" });
  const tab = await waitForTab(tabId, origin + "/", source);
  if (tab && await reuseOpenRoom(tab, origin, videoId, audience).catch(() => false)) return;
  if (atAddress(await api.tabs.get(tabId), origin + "/")) await api.tabs.update(tabId, { url: browserHandoff(origin, videoId, audience) });
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== api.runtime.id || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0) return;
  if (message?.type === "rooms-youtube-video") {
    const id = youtubeVideoId(sender.url);
    if (!id) return;
    api.tabs.create({ url: panel + "#" + id, openerTabId: sender.tab.id, windowId: sender.tab.windowId })
      .then(tab => {
        if (Number.isInteger(tab.id)) handoffTabs.set(tab.id, id);
        sendResponse({ ok: true });
      }, () => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "rooms-browser-handoff" && sender.url?.startsWith(panel + "#")) {
    const id = sender.url.slice(panel.length + 1);
    const { origin, guestAccess, memberVisibility } = message;
    if (!videoIdPattern.test(id) || typeof origin !== "string" ||
        typeof guestAccess !== "boolean" || typeof memberVisibility !== "boolean") return;
    const tabId = sender.tab.id;
    if (launching.has(tabId)) return;
    launching.add(tabId);
    launchInBrowser(tabId, id, origin, { guestAccess, memberVisibility })
      .then(() => sendResponse({ ok: true }), error => sendResponse({ ok: false, code: error.message }))
      .finally(() => { launching.delete(tabId); handoffTabs.delete(tabId); });
    return true;
  }
});
