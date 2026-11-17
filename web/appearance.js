import { t } from "./i18n.js";
import { api, button, closeDialog, el, field, form, identifier, notify, paintPersonMark, paintPersonName, personMark, personName, select, showDialog, status, tell, validAppearanceImageUrl } from "./ui.js";

const imageTypes = ["image/png", "image/jpeg", "image/webp"];
const fileLimit = 8 * 1024 * 1024;
const bytesPerMiB = 1024 * 1024;
const imageSlots = [
  ["cover", "coverUrl", "Cover image", "Titelbild"],
  ["banner", "bannerUrl", "Banner", "Banner"],
  ["background", "chatBackgroundUrl", "Chat background", "Chat-Hintergrund"],
];
const imagePresets = [
  { id: "aurora", en: "Aurora", de: "Polarlicht" },
  { id: "ember", en: "Ember", de: "Glut" },
  { id: "tide", en: "Deep Blue", de: "Tiefblau" },
  { id: "bloom", en: "Night Bloom", de: "Nachtblüte" },
];
let appearanceDialog;

function hexColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value) ? value.toLowerCase() : null;
}

function setStyle(node, name, value) {
  if (value === null) node.style.removeProperty(name);
  else node.style.setProperty(name, value);
}

function urlValue(path) {
  return path ? "url(" + JSON.stringify(path) + ")" : null;
}

export function applyTopicCover(node, appearance) {
  const cover = validAppearanceImageUrl(appearance?.coverUrl);
  node.toggleAttribute("data-custom-cover", Boolean(cover));
  setStyle(node, "--topic-cover", urlValue(cover));
}

export function applyTopicDesign(node, appearance, previews = {}) {
  const banner = previews.banner ?? validAppearanceImageUrl(appearance?.bannerUrl);
  const background = previews.background ?? validAppearanceImageUrl(appearance?.chatBackgroundUrl);
  const accent = hexColor(appearance?.accentColor);
  const surface = hexColor(appearance?.surfaceColor);
  const value = appearance?.chatBackgroundOpacity;
  const opacity = Number.isInteger(value) && value >= 0 && value <= 70 ? value : 28;
  node.dataset.chatBackgroundMode = appearance?.chatBackgroundMode === "tile" ? "tile" : "cover";
  node.toggleAttribute("data-custom-accent", Boolean(accent));
  node.toggleAttribute("data-custom-surface", Boolean(surface));
  node.toggleAttribute("data-chat-backdrop", Boolean(background && opacity));
  setStyle(node, "--topic-banner", urlValue(banner));
  setStyle(node, "--chat-background", urlValue(background));
  setStyle(node, "--chat-background-opacity", String(opacity / 100));
  setStyle(node, "--theme-accent", accent);
  setStyle(node, "--theme-surface", surface);
}

function dialogLifetime(parentSignal) {
  appearanceDialog?.abort();
  const controller = new AbortController();
  appearanceDialog = controller;
  const dialog = document.querySelector("#dialog");
  const abort = () => controller.abort();
  dialog.addEventListener("close", () => {
    if (!dialog.open) abort();
  }, { signal: controller.signal });
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener("abort", abort, { once: true, signal: controller.signal });
  return controller.signal;
}

function optColor(label, defaultColor, current, update) {
  const control = el("input", { type: "color", value: hexColor(current) ?? defaultColor, "aria-label": label });
  const code = el("span", { class: "appearance-color-code" });
  let selected = hexColor(current);
  let reset;
  function sync() {
    control.value = selected ?? defaultColor;
    code.textContent = selected ?? t("Default", "Standard");
    reset.disabled = selected === null;
  }
  reset = button(t("Default", "Standard"), () => {
    selected = null;
    sync();
    update();
  }, { class: "ghost", "aria-label": t("Reset {label}", "{label} zurücksetzen", { label }) });
  control.addEventListener("input", () => {
    selected = hexColor(control.value);
    sync();
    update();
  });
  sync();
  return {
    node: el("div", { class: "field appearance-color-field" },
      el("span", {}, label), el("div", { class: "appearance-color-row" }, control, code, reset)),
    value: () => selected,
  };
}

function imageEditor(slot, label, stored, signal, update) {
  let current = validAppearanceImageUrl(stored);
  let preview;
  let change;
  const thumbnail = el("div", { class: "appearance-image-preview", "aria-hidden": "true" });
  const note = status();
  const input = el("input", { type: "file", accept: imageTypes.join(","), hidden: true });
  const selectFile = button(t("Upload", "Hochladen"), () => input.click(), {
    "aria-label": t("Choose {label}", "{label} auswählen", { label }),
  });
  const remove = button(t("Remove", "Entfernen"), () => {
    clearPreview();
    change = current ? null : undefined;
    sync();
  }, { class: "ghost", "aria-label": t("Remove {label}", "{label} entfernen", { label }) });
  const presets = imagePresets.map(({ id, en, de }) => ({ path: `/presets/${slot}/${id}.webp`, title: t(en, de) }));
  const presetButtons = presets.map(preset => button([
    el("img", { src: preset.path, alt: "", loading: "lazy", decoding: "async" }), el("span", {}, preset.title),
  ], () => {
    clearPreview();
    change = preset;
    sync();
  }, { class: "appearance-preset", "aria-pressed": "false" }));
  const gallery = el("details", { class: "appearance-presets" },
    el("summary", { class: "button ghost", "aria-label": t("Presets for {label}", "Vorlagen für {label}", { label }) },
      t("Presets", "Vorlagen")),
    el("div", { class: "appearance-preset-grid", "data-slot": slot }, presetButtons));

  function clearPreview() {
    if (preview) URL.revokeObjectURL(preview);
    preview = undefined;
  }

  function previewPath() {
    return preview ?? change?.path;
  }

  function path() {
    return change === null ? null : previewPath() ?? current;
  }

  function sync(shouldNotify = true) {
    const image = path();
    thumbnail.toggleAttribute("data-has-image", Boolean(image));
    setStyle(thumbnail, "--appearance-preview-image", urlValue(image));
    remove.disabled = !image;
    for (const [index, option] of presetButtons.entries()) {
      option.setAttribute("aria-pressed", String(change === presets[index]));
    }
    tell(note, change instanceof File ? change.name : change === null ? t("Will be removed", "Wird entfernt") : change?.title ?? "");
    if (shouldNotify) update();
  }

  input.addEventListener("change", () => {
    const [file] = input.files;
    input.value = "";
    if (!file) return;
    if (!imageTypes.includes(file.type) || file.size > fileLimit || file.size === 0) {
      tell(note, t("Choose a JPEG, PNG, or WebP image up to 8 MB.", "Wähle ein JPEG, PNG oder WebP bis 8 MB."), "error");
      return;
    }
    clearPreview();
    change = file;
    preview = URL.createObjectURL(file);
    sync();
  });
  signal.addEventListener("abort", clearPreview, { once: true });
  sync(false);
  return {
    node: el("div", { class: "appearance-image-field stack" },
      el("strong", {}, label), thumbnail, input,
      el("div", { class: "appearance-image-actions inline" }, selectFile, remove), gallery, note),
    savedPath: () => path(),
    previewPath,
    async save(endpoint, consume) {
      if (change === undefined) return;
      let options = { method: "DELETE", signal };
      if (change !== null) {
        const body = change instanceof File ? change : await loadPreset(change.path, signal);
        options = { method: "PUT", body, binary: true, signal };
      }
      const result = await api(endpoint, options);
      current = validAppearanceImageUrl(consume(result));
      change = undefined;
      clearPreview();
      sync();
    },
  };
}

async function loadPreset(path, signal) {
  const response = await fetch(path, { signal, credentials: "same-origin", redirect: "error" });
  if (response.ok && response.headers.get("Content-Type")?.split(";")[0].trim() === "image/webp") {
    const image = await response.blob();
    if (image.size && image.size <= fileLimit) return image;
  }
  throw new Error(t("The image preset couldn’t be loaded.", "Die Bildvorlage konnte nicht geladen werden."));
}

function attachmentPreference(profile) {
  const maxBytes = profile.autoLoadAttachmentMaxBytes;
  const initialMode = !profile.autoLoadAttachments ? "manual" : maxBytes === null ? "auto" : "limited";
  const mode = select([
    ["manual", t("Load manually", "Manuell laden")],
    ["auto", t("Load automatically", "Automatisch laden")],
    ["limited", t("Load automatically up to a size limit", "Automatisch bis zu einer Größenbegrenzung laden")],
  ], initialMode);
  const limit = el("input", {
    type: "number", inputmode: "decimal", min: 1 / bytesPerMiB, step: "any", required: true,
    value: maxBytes === null ? 1 : maxBytes / bytesPerMiB,
  });
  const sizeField = field(t("Size limit per attachment (MiB)", "Maximale Größe pro Anhang (MiB)"), limit);
  function sync() {
    sizeField.hidden = limit.disabled = mode.value !== "limited";
  }
  mode.addEventListener("change", sync);
  sync();
  return {
    node: el("div", { class: "appearance-attachment-preference field" },
      field(t("Chat attachments", "Chat-Anhänge"), mode), sizeField),
    value: () => ({
      autoLoadAttachments: mode.value !== "manual",
      autoLoadAttachmentMaxBytes: mode.value === "limited" ? Math.round(limit.valueAsNumber * bytesPerMiB)
        : mode.value === "manual" ? maxBytes : null,
    }),
  };
}

export function editProfile(user, onChange, languageControl, onResetTutorials, onPassword, onSecurity) {
  const signal = dialogLifetime();
  const person = { nameColor: null, autoLoadAttachments: true, autoLoadAttachmentMaxBytes: null, notifyLive: false, ...user };
  const mark = personMark(person);
  const name = personName(person, { class: "appearance-profile-name" });
  const color = optColor(t("Name color", "Namensfarbe"), "#abb8ff", person.nameColor, preview);
  const icon = imageEditor("avatar", t("Profile picture", "Profilbild"), person.avatarUrl, signal, preview);
  const attachments = attachmentPreference(person);
  const liveNotifications = el("input", { type: "checkbox", checked: person.notifyLive });
  function preview() {
    const next = { ...person, id: undefined, nameColor: color.value(), avatarUrl: icon.savedPath() };
    paintPersonMark(mark, next, icon.previewPath());
    paintPersonName(name, next);
  }
  const fields = el("fieldset", { class: "appearance-fields appearance-profile-fields stack" },
    icon.node, color.node, attachments.node,
    el("label", { class: "inline" }, liveNotifications,
      t("Notify me when someone goes live in a room I’ve joined", "Benachrichtige mich über Live-Starts in Räumen, denen ich beigetreten bin")),
    languageControl);
  const tutorialFeedback = status();
  showDialog(t("Your profile", "Dein Profil"), form([
    el("div", { class: "appearance-profile-preview" }, mark,
      el("div", {}, name, el("p", { class: "subtle" }, "@" + user.username))), fields,
    el("div", { class: "inline" },
      button(t("Change password", "Passwort ändern"), onPassword, { class: "ghost" }),
      onSecurity && button(t("Two-factor authentication", "Zwei-Faktor-Anmeldung"), onSecurity, { class: "ghost" })),
    onResetTutorials && el("div", { class: "inline" },
      button(t("Reset tutorials", "Rundgänge zurücksetzen"), async event => {
        const control = event.currentTarget;
        control.disabled = true;
        tell(tutorialFeedback, "");
        try {
          await onResetTutorials();
          if (!signal.aborted) tell(tutorialFeedback, t("Tutorials will restart when you close your profile.", "Die Rundgänge starten erneut, sobald du dein Profil schließt."));
        } catch (error) {
          if (!signal.aborted) tell(tutorialFeedback,
            t("The tutorials could not be reset. Please try again.", "Die Rundgänge konnten nicht zurückgesetzt werden. Versuche es erneut."), "error");
        } finally {
          control.disabled = false;
        }
      }, { class: "ghost", "data-tutorial": "reset" }), tutorialFeedback),
  ], t("Save profile", "Profil speichern"), async () => {
    const values = { nameColor: color.value(), ...attachments.value(), notifyLive: liveNotifications.checked };
    const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== person[key]));
    fields.disabled = true;
    try {
      const saved = ({ profile }) => {
        Object.assign(person, profile);
        onChange(profile);
        return profile.avatarUrl;
      };
      await icon.save("profile/avatar", saved);
      if (Object.keys(changed).length) {
        saved(await api("profile", { method: "PATCH", body: changed, signal }));
      }
      if (!signal.aborted) {
        closeDialog();
        notify(t("Profile saved.", "Profil gespeichert."));
      }
    } finally {
      fields.disabled = false;
    }
  }));
  preview();
}

export function editTopicDesign(context, topic, onChange) {
  const signal = dialogLifetime(context.signal);
  let appearance = topic.appearance ?? {};
  const endpoint = "topics/" + identifier(topic.id) + "/appearance";
  const coverArt = el("div", { class: "topic-card appearance-preview-cover", "aria-hidden": "true" });
  const visual = el("div", { class: "appearance-topic-preview topic-view", "aria-hidden": "true" },
    el("div", { class: "room-hero appearance-preview-banner" }, el("strong", {}, topic.title),
      el("span", { class: "appearance-preview-accent" }, t("# General", "# Allgemein"))),
    el("div", { class: "appearance-preview-room" }, coverArt,
      el("div", { class: "message-list appearance-preview-chat" },
        el("div", { class: "message-row appearance-preview-message" }, el("span", {}, t("Welcome to the chat!", "Willkommen im Chat!"))))));
  const accent = optColor(t("Accent color", "Akzentfarbe"), "#365df1", appearance.accentColor, preview);
  const surface = optColor(t("Surface color", "Flächenfarbe"), "#141419", appearance.surfaceColor, preview);
  const layout = select([["cover", t("Fill", "Flächig")], ["tile", t("Tile", "Gekachelt")]], appearance.chatBackgroundMode ?? "cover");
  const opacity = el("input", { type: "range", min: "0", max: "70", step: "1", value: appearance.chatBackgroundOpacity ?? 28 });
  const opacityReadout = el("span", { class: "appearance-color-code", "aria-hidden": "true" });
  layout.addEventListener("change", preview);
  opacity.addEventListener("input", preview);
  const editors = imageSlots.map(([slot, key, english, german]) => {
    const label = t(english, german);
    return { slot, key, label, editor: imageEditor(slot, label, appearance[key], signal, preview) };
  });
  const fieldValues = () => ({ accentColor: accent.value(), surfaceColor: surface.value(),
    chatBackgroundMode: layout.value, chatBackgroundOpacity: Number(opacity.value) });

  function preview() {
    const [cover, banner, background] = editors.map(item => item.editor);
    const coverPath = cover.savedPath();
    coverArt.toggleAttribute("data-custom-cover", Boolean(coverPath));
    setStyle(coverArt, "--topic-cover", urlValue(coverPath));
    const previewAppearance = { ...fieldValues() };
    const paths = { banner: banner.savedPath(), background: background.savedPath() };
    applyTopicDesign(visual, previewAppearance, paths);
    opacityReadout.textContent = t("{value}%", "{value} %", { value: opacity.value });
  }

  const controls = el("fieldset", { class: "appearance-fields stack" },
    el("div", { class: "appearance-image-grid" }, editors.map(({ editor }) => editor.node)),
    el("div", { class: "appearance-color-grid" }, accent.node, surface.node),
    el("div", { class: "appearance-color-grid" }, field(t("Chat background layout", "Chat-Hintergrund darstellen"), layout),
      el("label", { class: "field" }, el("span", {}, t("Background opacity · ", "Sichtbarkeit · "), opacityReadout), opacity)));
  showDialog(t("Room design", "Raumdesign"), form([
    el("div", { class: "appearance-design-sample" }, el("p", { class: "subtle" }, t("Preview", "Vorschau")), visual), controls,
  ], t("Save design", "Design speichern"), async () => {
    controls.disabled = true;
    try {
      const saved = next => {
        appearance = next;
        onChange(next);
      };
      for (const { slot, key, label, editor } of editors) {
        try {
          await editor.save(endpoint + "/" + slot, result => {
            saved(result.appearance);
            return appearance[key];
          });
        } catch (error) {
          if (error.name === "AbortError") throw error;
          throw new Error(t("{label} could not be saved. {detail}", "{label} konnte nicht gespeichert werden. {detail}", { label, detail: error.message }));
        }
      }
      const fields = fieldValues();
      const changed = Object.fromEntries(Object.entries(fields).filter(([key, value]) => value !== appearance[key]));
      if (Object.keys(changed).length) {
        saved((await api(endpoint, { method: "PATCH", body: changed, signal })).appearance);
      }
      if (!signal.aborted) {
        closeDialog();
        notify(t("Design saved.", "Design gespeichert."));
      }
    } finally {
      controls.disabled = false;
    }
  }));
  preview();
}
