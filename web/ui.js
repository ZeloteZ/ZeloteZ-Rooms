import { language, locale, t } from "./i18n.js";

export function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false || value === null || value === undefined) continue;
    if (name === "class") node.className = value;
    else if (name.startsWith("on") && typeof value === "function") node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

let onUnauthorized = () => {};
let expectedAccount;
export function requireLoginOnExpiry(callback) {
  onUnauthorized = callback;
}

export function setExpectedAccount(id) {
  expectedAccount = id;
}

export function accountHeaders() {
  return expectedAccount ? { "X-Rooms-Account": expectedAccount } : {};
}

export function checkAccountResponse(response) {
  if (response.headers.get("X-Rooms-Error") === "account-changed") onUnauthorized("changed");
  return response;
}

export async function api(path, { method = "GET", body, signal, binary = false, buffer = false, keepalive = false } = {}) {
  const unauthenticated = ["auth/login", "auth/register", "auth/session"].includes(path);
  const response = checkAccountResponse(await fetch("/api/" + path, {
    method,
    body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
    headers: { "Accept-Language": language(),
      ...(unauthenticated ? {} : accountHeaders()),
      ...(body === undefined ? {} : { "Content-Type": binary ? "application/octet-stream" : "application/json" }) },
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    keepalive,
    referrer: location.origin + "/",
    referrerPolicy: "same-origin",
    signal,
  }));
  if (response.status === 204) return null;
  if (response.ok) return buffer ? response.arrayBuffer() : response.json();
  if (response.status === 401 && !path.startsWith("auth/")) onUnauthorized();
  const error = await response.json().catch(() => null);
  const failure = new Error(error?.error || error?.message || t("The request could not be completed.", "Die Anfrage konnte nicht abgeschlossen werden."));
  failure.status = response.status;
  failure.details = error;
  throw failure;
}

export function status(text = "", extra = "") {
  return element("p", { class: "status " + extra, role: "status", hidden: !text }, text);
}

export function tell(node, text, kind = "") {
  node.textContent = text;
  node.className = "status " + kind;
  node.hidden = !text;
}

export function button(text, action, { class: classes = "", ...attributes } = {}) {
  return element("button", { type: "button", class: "button " + classes, ...attributes, onclick: action }, text);
}

export function field(label, input) {
  return element("label", { class: "field" }, element("span", {}, label), input);
}

export function select(options, chosen) {
  const control = element("select", {}, options.map(([value, label]) => element("option", { value }, label)));
  control.value = chosen;
  return control;
}

export function form(items, submitLabel, submit) {
  const feedback = status();
  const submitButton = element("button", { class: "button primary", type: "submit" }, submitLabel);
  const node = element("form", { class: "stack" }, items, feedback, submitButton);
  node.addEventListener("submit", async event => {
    event.preventDefault();
    submitButton.disabled = true;
    node.setAttribute("aria-busy", "true");
    tell(feedback, "");
    try {
      await submit(feedback, node);
    } catch (error) {
      if (error.name !== "AbortError") tell(feedback, error.message, "error");
    } finally {
      submitButton.disabled = false;
      node.removeAttribute("aria-busy");
    }
  });
  return node;
}

const dialog = document.querySelector("#dialog");
const dialogHeading = document.querySelector("#dialog-heading");
const dialogContent = document.querySelector("#dialog-content");
const dialogClose = document.querySelector("#dialog-close");
dialogClose?.addEventListener("click", () => dialog?.close());
dialog?.addEventListener("close", () => {
  if (!dialog.open) dialogContent.replaceChildren();
});

export function showDialog(title, content) {
  dialogHeading.textContent = title;
  dialogContent.replaceChildren(content);
  if (!dialog.open) dialog.showModal();
}

export function closeDialog() {
  if (dialog.open) dialog.close();
  dialogContent.replaceChildren();
}

export function openChatImage(url, name, trigger) {
  const image = element("img", { alt: name });
  const failure = status();
  const viewer = element("div", { class: "chat-image-viewer" }, image, failure);
  image.addEventListener("error", () => {
    image.hidden = true;
    tell(failure, t("The image could not be displayed.", "Das Bild konnte nicht angezeigt werden."), "error");
  }, { once: true });
  image.src = url;
  trigger?.focus({ preventScroll: true });
  showDialog(name, viewer);
  dialogClose.focus({ preventScroll: true });
  return () => {
    if (dialog.open && viewer.parentNode === dialogContent) closeDialog();
  };
}

let toastTimer;
export function notify(message) {
  const node = document.querySelector("#toast");
  clearTimeout(toastTimer);
  node.textContent = message;
  node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, 4400);
}

export async function copyField(input) {
  try {
    await navigator.clipboard.writeText(input.value);
    notify(t("Copied", "Kopiert"));
  } catch {
    input.focus();
    input.select();
    notify(t("The text is selected and ready to copy.", "Der Text ist markiert und kann kopiert werden."));
  }
}

export function validAppearanceImageUrl(value) {
  return typeof value === "string" && /^\/api\/appearance\/images\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)
    ? value : null;
}

function previewImageUrl(value) {
  if (typeof value !== "string") return null;
  if (/^\/presets\/avatar\/[a-z0-9-]{1,32}\.webp$/u.test(value)) return value;
  if (!value.startsWith("blob:")) return null;
  try {
    return new URL(value).origin === location.origin ? value : null;
  } catch {
    return null;
  }
}

function displayName(person) {
  return (typeof person === "string" ? person : person?.displayName) || t("Member", "Mitglied");
}

function markPerson(node, attribute, person) {
  if (person?.id) node.setAttribute(attribute, person.id);
  else node.removeAttribute(attribute);
}

export function paintPersonMark(node, person, previewUrl) {
  markPerson(node, "data-person-avatar", person);
  const pieces = displayName(person).trim().split(/\s+/u, 2);
  const initials = pieces.map(word => [...word][0] || "").join("").toUpperCase() || "?";
  const source = previewImageUrl(previewUrl) ?? validAppearanceImageUrl(person?.avatarUrl);
  if (!source) {
    node.replaceChildren(initials);
    return node;
  }
  if (node.firstElementChild?.getAttribute("src") === source) return node;
  const image = element("img", { class: "avatar-image", alt: "", decoding: "async", loading: "lazy" });
  image.addEventListener("error", () => {
    if (image.parentNode === node) node.replaceChildren(initials);
  }, { once: true });
  image.setAttribute("src", source);
  node.replaceChildren(image);
  return node;
}

export function personMark(person) {
  return paintPersonMark(element("span", { class: "avatar", "aria-hidden": "true" }), person);
}

function luminance(rgb) {
  const linear = rgb.map(value => {
    const channel = value / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
}

// The lightest selected stream surface in the dark palette is #303969.
const minNameLuminance = (luminance([48, 57, 105]) + .05) * 4.5 - .05;

export function readableColor(value) {
  if (typeof value !== "string" || !/^#[a-f0-9]{6}$/iu.test(value)) return null;
  const rgb = [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16));
  if (luminance(rgb) >= minNameLuminance) return value.toLowerCase();

  for (let amount = .05; amount < 1; amount += .05) {
    const brighter = rgb.map(channel => Math.round(channel + (255 - channel) * amount));
    if (luminance(brighter) >= minNameLuminance) {
      return "#" + brighter.map(channel => channel.toString(16).padStart(2, "0")).join("");
    }
  }
  return "#ffffff";
}

export function paintPersonName(node, person) {
  markPerson(node, "data-person-name", person);
  node.classList.add("person-name");
  node.textContent = displayName(person);
  const color = readableColor(person?.nameColor);
  if (color) node.style.setProperty("--profile-name-color", color);
  else node.style.removeProperty("--profile-name-color");
  return node;
}

export function personName(person, attributes) {
  return paintPersonName(element("strong", attributes), person);
}

export function personRow(person, actions = [], note = "") {
  return element("li", { class: "person-row" },
    personMark(person),
    element("div", {},
      personName(person),
      person.username && element("p", { class: "subtle" }, "@" + person.username),
      note && element("p", { class: "subtle" }, note)),
    actions.length ? element("div", { class: "inline" }, actions) : null);
}

export function sameId(first, second) {
  return first !== null && first !== undefined && second !== null && second !== undefined && String(first) === String(second);
}

export function identifier(value) {
  return encodeURIComponent(String(value));
}

export function topicHref(id, channelId = null, { messageId, streamId, watchId, shareSource } = {}) {
  const query = new URLSearchParams();
  if (messageId) query.set("message", messageId);
  if (streamId) query.set("stream", streamId);
  if (watchId) query.set("watch", watchId);
  if (shareSource) query.set("share", shareSource);
  const base = "#/rooms/" + identifier(id) + (channelId === null ? "" : "/" + identifier(channelId));
  return query.size ? base + "?" + query : base;
}

export function directHref(id, messageId) {
  if (!id) return "#/direct";
  const path = "#/direct/" + identifier(id);
  return messageId ? path + "?message=" + identifier(messageId) : path;
}

export async function openDirect(userId, signal) {
  const { conversation } = await api("direct", { method: "POST", body: { userId }, signal });
  signal?.throwIfAborted();
  location.hash = directHref(conversation.id);
}

export const plainTime = new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" });

export function localizedTime(value) {
  const time = new Date(value);
  return Number.isFinite(Number(time)) ? plainTime.format(time) : "–";
}

export function validHttpLink(text) {
  try {
    const url = new URL(text);
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) return url.href;
  } catch {
    return null;
  }
  return null;
}

export { element as el };
