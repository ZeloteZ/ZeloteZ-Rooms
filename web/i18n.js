const preference = "zelotez-rooms-language";

export const languages = Object.freeze([
  Object.freeze({ id: "en", label: "English", tag: "en-US" }),
  Object.freeze({ id: "de", label: "Deutsch", tag: "de-DE" }),
]);

// A completed locale can be registered above and supply a catalog keyed by the English source text.
const catalogs = Object.freeze({ zh: Object.freeze({}) });

function supported(id) {
  return languages.some(language => language.id === id);
}

export function language() {
  const override = new URL(location.href).searchParams.get("lang");
  if (supported(override)) return override;
  try {
    const saved = localStorage.getItem(preference);
    if (supported(saved)) return saved;
  } catch {
    // Storage can be disabled.
  }
  return "en";
}

export function locale() {
  return languages.find(item => item.id === language()).tag;
}

export function setLanguage(id) {
  if (!supported(id)) return;
  const url = new URL(location.href);
  let stored = false;
  try {
    localStorage.setItem(preference, id);
    stored = true;
  } catch {
    // Fall back to the URL when the browser does not allow persistent preferences.
  }
  if (!stored || url.searchParams.has("lang")) {
    url.searchParams.set("lang", id);
    history.replaceState(history.state, "", url);
  }
}

export function t(english, german = english, parts = {}) {
  const id = language();
  const template = id === "de" ? german : catalogs[id]?.[english] ?? english;
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/gu, (match, key) =>
    Object.hasOwn(parts, key) ? String(parts[key]) : match);
}
