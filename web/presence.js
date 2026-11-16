import { t } from "./i18n.js";
import { api } from "./ui.js";

const avatar = ".avatar[data-person-avatar]";
const marked = ".avatar[data-online]";
const userId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const maxUsers = 200;
const heartbeatMs = 35_000;
const refreshDelay = 220;

function collectAvatars() {
  return [...document.querySelectorAll(avatar)].filter(mark => userId.test(mark.dataset.personAvatar) &&
    !mark.closest("[hidden], .appearance-profile-preview"));
}

function requestedUsers(self, marks) {
  const ids = new Set([self, ...marks.map(mark => mark.dataset.personAvatar)]);
  if (ids.size <= maxUsers) return [...ids].sort();

  // If an especially large list exceeds one request, prioritize the on-screen avatars.
  const visible = new Set([self]);
  for (const mark of marks) {
    const { bottom, top, right, left } = mark.getBoundingClientRect();
    if (bottom > 0 && top < window.innerHeight && right > 0 && left < window.innerWidth) visible.add(mark.dataset.personAvatar);
    if (visible.size >= maxUsers) break;
  }
  for (const id of ids) {
    if (visible.size >= maxUsers) break;
    visible.add(id);
  }
  return [...visible].sort();
}

function paint(mark, online) {
  if (mark.hasAttribute("data-online") === online) return;
  mark.toggleAttribute("data-online", online);
  const profile = mark.closest("#profile-edit");
  if (online) {
    const label = t("Online", "Online");
    mark.removeAttribute("aria-hidden");
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", label);
    mark.setAttribute("title", label);
    profile?.setAttribute("aria-description", label);
  } else {
    mark.setAttribute("aria-hidden", "true");
    for (const attribute of ["role", "aria-label", "title"]) mark.removeAttribute(attribute);
    profile?.removeAttribute("aria-description");
  }
}

function repaint(marks, online) {
  const activeMarks = new Set(marks);
  for (const mark of document.querySelectorAll(marked)) {
    if (!activeMarks.has(mark)) paint(mark, false);
  }
  for (const mark of marks) paint(mark, online.has(mark.dataset.personAvatar));
}

export function startPresence(self, signal) {
  if (signal.aborted || !userId.test(self)) return;
  let online = new Set();
  let lastRequest = "";
  let inFlight = false;
  let pending = false;
  let pendingHeartbeat = false;
  let timer = null;
  let limited = false;

  function schedule() {
    if (signal.aborted || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      const heartbeat = pendingHeartbeat;
      pendingHeartbeat = false;
      void update(heartbeat);
    }, refreshDelay);
  }

  async function update(heartbeat = false) {
    if (signal.aborted || navigator.onLine === false) return;
    if (inFlight) {
      pending = true;
      pendingHeartbeat ||= heartbeat;
      return;
    }
    const marks = collectAvatars();
    const ids = requestedUsers(self, marks);
    limited = ids.length === maxUsers;
    const key = ids.join(",");
    repaint(marks, online);
    if (!heartbeat && key === lastRequest) return;

    lastRequest = key;
    inFlight = true;
    try {
      const result = await api("presence", { method: "POST", body: { userIds: ids }, signal });
      if (signal.aborted || navigator.onLine === false) return;
      const requested = new Set(ids);
      online = new Set(Array.isArray(result?.online) ? result.online.filter(id => requested.has(id)) : []);
      repaint(collectAvatars(), online);
    } catch {
      if (!signal.aborted) clear();
    } finally {
      inFlight = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  }

  function clear() {
    online.clear();
    repaint([], online);
  }

  function affectsAvatars(node) {
    return node.nodeType === Node.ELEMENT_NODE && (node.matches(avatar) || node.querySelector(avatar));
  }

  const observer = new MutationObserver(records => {
    if (records.some(record => record.type === "attributes"
      ? record.attributeName === "data-person-avatar" || affectsAvatars(record.target)
      : [...record.addedNodes, ...record.removedNodes].some(affectsAvatars))) schedule();
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["data-person-avatar", "hidden", "open"] });
  document.addEventListener("scroll", () => { if (limited) schedule(); }, { capture: true, passive: true, signal });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void update(true); }, { signal });
  window.addEventListener("online", () => void update(true), { signal });
  window.addEventListener("offline", clear, { signal });
  const heartbeat = setInterval(() => void update(true), heartbeatMs);
  signal.addEventListener("abort", () => {
    observer.disconnect();
    clearInterval(heartbeat);
    clearTimeout(timer);
    clear();
  }, { once: true });
  void update(true);
}
