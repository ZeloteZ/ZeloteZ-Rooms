import { configFrom, configKey, desktopHandoff, instanceOrigin, permissionFor, verifyInstance, videoIdPattern } from "./links.mjs";

const api = globalThis.browser ?? globalThis.chrome;
const text = key => api.i18n.getMessage(key);
const find = selector => document.querySelector(selector);
const form = find("#settings");
const address = find("#instance");
const target = find("#target");
const save = find("#save");
const status = find("#status");
const desktop = find("#desktop");
const openDesktop = find("#open-desktop");
const edit = find("#edit");
const videoId = location.hash.slice(1);
const selectedVideo = videoIdPattern.test(videoId);
const knownErrors = ["invalidAddress", "invalidInstance", "incompatibleInstance", "permissionRequired"];
let current;

document.documentElement.lang = api.i18n.getUILanguage();
document.title = text(selectedVideo ? "createRoom" : "settingsTitle");
find("h1").dataset.text = selectedVideo ? "createRoom" : "settingsTitle";
for (const node of document.querySelectorAll("[data-text]")) node.textContent = text(node.dataset.text);

function setStatus(key, error = false) {
  status.hidden = !key;
  status.classList.toggle("error", error);
  status.textContent = key ? text(key) : "";
}

function showSettings() {
  desktop.hidden = true;
  openDesktop.removeAttribute("href");
  edit.hidden = true;
  form.hidden = false;
}

function showError(error) {
  setStatus(knownErrors.includes(error.message) ? error.message : "checkFailed", true);
  showSettings();
}

async function openBrowser() {
  setStatus("opening");
  desktop.hidden = true;
  openDesktop.removeAttribute("href");
  const result = await api.runtime.sendMessage({ type: "rooms-browser-handoff" });
  if (!result?.ok) throw new Error(result?.code || "checkFailed");
}

async function launch() {
  form.hidden = true;
  edit.hidden = true;
  setStatus("checking");
  if (current.target === "browser") {
    await openBrowser();
    return;
  }
  if (!await api.permissions.contains(permissionFor(current.origin))) throw new Error("permissionRequired");
  await verifyInstance(current.origin);
  setStatus("");
  openDesktop.href = desktopHandoff(current.origin, videoId);
  desktop.hidden = false;
  edit.hidden = false;
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (save.disabled) return;
  const origin = instanceOrigin(address.value);
  if (!origin) return setStatus("invalidAddress", true);
  const next = { origin, target: target.value };
  const permission = permissionFor(next.origin);
  const previous = current && permissionFor(current.origin);
  const changedHost = previous?.origins[0] !== permission.origins[0];
  save.disabled = true;
  setStatus("checking");
  let permitted = false;
  try {
    permitted = await api.permissions.request(permission);
    if (!permitted) throw new Error("permissionRequired");
    await verifyInstance(next.origin);
    await api.storage.local.set({ [configKey]: next });
    if (previous && changedHost) await api.permissions.remove(previous).catch(() => {});
    current = next;
    address.value = next.origin;
    if (selectedVideo) await launch();
    else setStatus("saved");
  } catch (error) {
    if (permitted && changedHost && current !== next) await api.permissions.remove(permission).catch(() => {});
    showError(error);
  } finally {
    save.disabled = false;
  }
});

edit.addEventListener("click", showSettings);
find("#browser-fallback").addEventListener("click", () => void openBrowser().catch(showError));

try {
  const stored = await api.storage.local.get(configKey);
  current = configFrom(stored[configKey]);
  address.value = current?.origin ?? "";
  target.value = current?.target ?? "browser";
  if (selectedVideo && current) await launch();
  else showSettings();
} catch (error) {
  showError(error);
}
