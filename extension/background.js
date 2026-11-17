import { browserHandoff, configFrom, configKey, permissionFor, uuid, verifyInstance, videoIdPattern, youtubeVideoId } from "./links.mjs";
import { createSignedInRoom } from "./create-room.mjs";

const api = globalThis.browser ?? globalThis.chrome;
const panel = api.runtime.getURL("panel.html");

api.action.onClicked.addListener(() => void api.runtime.openOptionsPage().catch(() => {}));

function onInstance(address, origin) {
  try {
    const url = new URL(address);
    return url.origin === origin && url.pathname === "/" && !url.search;
  } catch {
    return false;
  }
}

async function waitForTab(tabId, origin) {
  for (const deadline = Date.now() + 8000; Date.now() < deadline;) {
    const tab = await api.tabs.get(tabId);
    if (tab.status === "complete" && onInstance(tab.url, origin)) return true;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  return false;
}

async function launchInBrowser(tabId, videoId) {
  const stored = await api.storage.local.get(configKey);
  const config = configFrom(stored[configKey]);
  if (!config || !await api.permissions.contains(permissionFor(config.origin))) throw new Error("permissionRequired");
  const { origin } = config;
  await verifyInstance(origin);
  await api.tabs.update(tabId, { url: origin + "/" });
  let room;
  if (await waitForTab(tabId, origin)) {
    try {
      const [result] = await api.scripting.executeScript({ target: { tabId }, func: createSignedInRoom, args: [origin, videoId] });
      room = result?.result;
    } catch {
      // If scripts are unavailable, the app's normal login/confirmation route is still available.
    }
  }
  const tab = await api.tabs.get(tabId);
  if (!onInstance(tab.url, origin)) return;
  const target = uuid.test(room?.topicId ?? "") && uuid.test(room.channelId ?? "")
    ? origin + "/#/rooms/" + room.topicId + "/" + room.channelId
    : browserHandoff(origin, videoId);
  await api.tabs.update(tabId, { url: target });
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== api.runtime.id || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0) return;
  if (message?.type === "rooms-youtube-video") {
    const id = youtubeVideoId(sender.url);
    if (!id) return;
    api.tabs.create({ url: panel + "#" + id, openerTabId: sender.tab.id })
      .then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "rooms-browser-handoff" && sender.url?.startsWith(panel + "#")) {
    const id = sender.url.slice(panel.length + 1);
    if (!videoIdPattern.test(id)) return;
    launchInBrowser(sender.tab.id, id).then(() => sendResponse({ ok: true }), error => sendResponse({ ok: false, code: error.message }));
    return true;
  }
});
