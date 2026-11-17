import { configFrom, configKey, desktopHandoff, handoffId, instanceOrigin, permissionFor, verifyInstance, videoIdPattern,
  waitForDesktopReceipt } from "./links.mjs";

const api = globalThis.browser ?? globalThis.chrome;
const text = key => api.i18n.getMessage(key);
const find = selector => document.querySelector(selector);
const form = find("#settings");
const address = find("#instance");
const target = find("#target");
const save = find("#save");
const status = find("#status");
const handoff = find("#handoff");
const handoffInstance = find("#handoff-instance");
const desktopNote = find("#desktop-note");
const openDesktop = find("#open-desktop");
const openOlderDesktop = find("#open-older-desktop");
const openInBrowser = find("#browser-fallback");
const edit = find("#edit");
const defaults = mountAccessOptions("#default-access");
const forVideo = mountAccessOptions("#video-access");
const videoId = location.hash.slice(1);
const selectedVideo = videoIdPattern.test(videoId);
const knownErrors = ["invalidAddress", "invalidInstance", "incompatibleInstance", "permissionRequired"];
let current;
let supportsReceipt = false;
let desktopAttempt;

document.documentElement.lang = api.i18n.getUILanguage();
document.title = text(selectedVideo ? "createRoom" : "settingsTitle");
find("h1").dataset.text = selectedVideo ? "createRoom" : "settingsTitle";
for (const node of document.querySelectorAll("[data-text]")) node.textContent = text(node.dataset.text);

function mountAccessOptions(selector) {
  const fields = find("#room-access-options").content.cloneNode(true);
  const guest = fields.querySelector('[name="guestAccess"]');
  const members = fields.querySelector('[name="memberVisibility"]');
  find(selector).append(fields);
  return {
    read: () => ({ guestAccess: guest.checked, memberVisibility: members.checked }),
    set({ guestAccess = true, memberVisibility = true } = {}) {
      guest.checked = guestAccess;
      members.checked = memberVisibility;
    },
  };
}

function setStatus(key, error = false) {
  status.hidden = !key;
  status.classList.toggle("error", error);
  status.textContent = key ? text(key) : "";
}

function showSettings() {
  cancelDesktopAttempt();
  openOlderDesktop.hidden = true;
  handoff.hidden = true;
  openDesktop.removeAttribute("href");
  edit.hidden = true;
  form.hidden = false;
}

function showError(error) {
  setStatus(knownErrors.includes(error.message) ? error.message : "checkFailed", true);
  showSettings();
}

async function openBrowser() {
  cancelDesktopAttempt();
  setStatus("opening");
  handoff.hidden = true;
  edit.hidden = true;
  openDesktop.removeAttribute("href");
  const result = await api.runtime.sendMessage({ type: "rooms-browser-handoff", origin: current.origin, ...forVideo.read() });
  if (!result?.ok) throw new Error(result?.code || "checkFailed");
}

function updateDesktopLink() {
  openDesktop.href = openOlderDesktop.href = desktopHandoff(current.origin, videoId, forVideo.read());
}

function cancelDesktopAttempt() {
  desktopAttempt?.abort();
  desktopAttempt = undefined;
  openDesktop.removeAttribute("aria-disabled");
}

function openDesktopApp(event) {
  if (!supportsReceipt) return;
  if (desktopAttempt) {
    event.preventDefault();
    return;
  }
  const receipt = handoffId();
  const origin = current.origin;
  const source = location.href;
  const attempt = new AbortController();
  desktopAttempt = attempt;
  // Set the receipt before the browser follows the user-activated protocol link.
  openDesktop.href = desktopHandoff(origin, videoId, forVideo.read(), receipt);
  openDesktop.setAttribute("aria-disabled", "true");
  setStatus("waitingDesktop");
  const hint = setTimeout(() => {
    if (desktopAttempt === attempt) openOlderDesktop.hidden = false;
  }, 12000);
  void (async () => {
    try {
      if (await waitForDesktopReceipt(origin, receipt, attempt.signal) && desktopAttempt === attempt) {
        const tab = await api.tabs.getCurrent();
        if (desktopAttempt !== attempt || location.href !== source ||
            (tab?.url && tab.url !== source) || (tab?.pendingUrl && tab.pendingUrl !== source)) return;
        if (Number.isInteger(tab?.id)) {
          await api.tabs.remove(tab.id);
          return;
        }
      }
    } catch {
      // Keep the fallback available if confirmation or tab closure fails.
    } finally {
      clearTimeout(hint);
      if (desktopAttempt === attempt) {
        cancelDesktopAttempt();
        updateDesktopLink();
        openOlderDesktop.hidden = false;
        setStatus("");
      }
    }
  })();
}

async function showHandoff(instance) {
  form.hidden = true;
  edit.hidden = true;
  const inDesktop = current.target === "desktop";
  if (inDesktop && !instance) {
    setStatus("checking");
    if (!await api.permissions.contains(permissionFor(current.origin))) throw new Error("permissionRequired");
    instance = await verifyInstance(current.origin);
  }
  supportsReceipt = inDesktop && instance.handoffReceipt;
  forVideo.set(current);
  handoffInstance.textContent = current.origin;
  desktopNote.hidden = openDesktop.hidden = !inDesktop;
  openOlderDesktop.hidden = true;
  if (inDesktop) updateDesktopLink();
  openInBrowser.classList.toggle("primary", !inDesktop);
  openInBrowser.textContent = text(inDesktop ? "openBrowser" : "openInBrowser");
  setStatus("");
  handoff.hidden = false;
  edit.hidden = false;
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (save.disabled) return;
  const origin = instanceOrigin(address.value);
  if (!origin) return setStatus("invalidAddress", true);
  const next = { origin, target: target.value, ...defaults.read() };
  const permission = permissionFor(next.origin);
  const previous = current && permissionFor(current.origin);
  const changedHost = previous?.origins[0] !== permission.origins[0];
  save.disabled = true;
  setStatus("checking");
  let permitted = false;
  try {
    permitted = await api.permissions.request(permission);
    if (!permitted) throw new Error("permissionRequired");
    const instance = await verifyInstance(next.origin);
    await api.storage.local.set({ [configKey]: next });
    if (previous && changedHost) await api.permissions.remove(previous).catch(() => {});
    current = next;
    address.value = next.origin;
    if (selectedVideo) await showHandoff(instance);
    else setStatus("saved");
  } catch (error) {
    if (permitted && changedHost && current !== next) await api.permissions.remove(permission).catch(() => {});
    showError(error);
  } finally {
    save.disabled = false;
  }
});

edit.addEventListener("click", showSettings);
find("#video-access").addEventListener("change", () => {
  if (openDesktop.hidden) return;
  cancelDesktopAttempt();
  updateDesktopLink();
  setStatus("");
});
openDesktop.addEventListener("click", openDesktopApp);
openOlderDesktop.addEventListener("click", () => {
  cancelDesktopAttempt();
  updateDesktopLink();
  setStatus("");
});
window.addEventListener("pagehide", cancelDesktopAttempt);
openInBrowser.addEventListener("click", () => void openBrowser().catch(showError));

try {
  const stored = await api.storage.local.get(configKey);
  current = configFrom(stored[configKey]);
  address.value = current?.origin ?? "";
  target.value = current?.target ?? "browser";
  defaults.set(current ?? undefined);
  if (selectedVideo && current) await showHandoff();
  else showSettings();
} catch (error) {
  showError(error);
}
