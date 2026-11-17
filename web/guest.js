import { language, languages as supportedLanguages, setLanguage, t } from "./i18n.js";
import { renderGuestViewer } from "./guest-viewer.js";

const publicId = /^\/guest\/([a-f0-9-]+)\/?$/u.exec(location.pathname)?.[1];
const mount = document.querySelector("#guest-view");
const languages = document.querySelector("#guest-language");
const languageLabel = document.querySelector("#guest-language-label");
languages.replaceChildren(...supportedLanguages.map(({ id, label }) => {
  const option = document.createElement("option");
  option.value = id;
  option.textContent = label;
  return option;
}));
let lifetime;
let viewer;

function takePassword() {
  if (!location.hash) return;
  const params = new URLSearchParams(location.hash.slice(1));
  history.replaceState(history.state, "", location.pathname + location.search);
  if (params.has("password")) return params.size === 1 ? params.get("password") : "";
}

function updateLanguage() {
  document.documentElement.lang = language();
  languages.value = language();
  languageLabel.textContent = t("Language", "Sprache");
  viewer?.dispatchEvent(new Event("guest-language"));
}

function open(password) {
  lifetime?.abort();
  lifetime = new AbortController();
  viewer = renderGuestViewer({ publicId, password, signal: lifetime.signal });
  mount.replaceChildren(viewer);
  updateLanguage();
}

languages.addEventListener("change", () => {
  setLanguage(languages.value);
  updateLanguage();
});
window.addEventListener("hashchange", () => {
  const password = takePassword();
  if (password !== undefined) open(password);
});
window.addEventListener("pagehide", () => lifetime?.abort());
window.addEventListener("pageshow", event => { if (event.persisted) open(takePassword()); });
open(takePassword());
