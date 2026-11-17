import chinese from "./i18n-zh.js";

const preference = "zelotez-rooms-language";

export const languages = Object.freeze([
  Object.freeze({ id: "en", label: "English", tag: "en-US" }),
  Object.freeze({ id: "de", label: "Deutsch", tag: "de-DE" }),
  Object.freeze({ id: "zh-CN", label: "简体中文", tag: "zh-CN" }),
]);

const catalogs = Object.freeze({ "zh-CN": chinese });

function supported(id) {
  if (typeof id !== "string") return null;
  const value = id.toLowerCase().replaceAll("_", "-");
  if (["zh", "zh-cn", "zh-hans", "zh-sg", "zh-hans-cn", "zh-hans-sg"].includes(value)) return "zh-CN";
  return languages.find(language => language.id === value)?.id ?? null;
}

export function language() {
  const override = supported(new URL(location.href).searchParams.get("lang"));
  if (override) return override;
  try {
    const saved = supported(localStorage.getItem(preference));
    if (saved) return saved;
  } catch {
    // Storage can be disabled.
  }
  return "en";
}

export function locale() {
  return languages.find(item => item.id === language()).tag;
}

export function setLanguage(id) {
  const selected = supported(id);
  if (!selected) return;
  const url = new URL(location.href);
  let stored = false;
  try {
    localStorage.setItem(preference, selected);
    stored = true;
  } catch {
    // Fall back to the URL when the browser does not allow persistent preferences.
  }
  if (!stored || url.searchParams.has("lang")) {
    url.searchParams.set("lang", selected);
    history.replaceState(history.state, "", url);
  }
}

export function t(english, german = english, parts = {}) {
  const id = language();
  const template = id === "de" ? german : catalogs[id]?.[english] ?? english;
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/gu, (match, key) =>
    Object.hasOwn(parts, key) ? String(parts[key]) : match);
}
