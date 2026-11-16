import { renderTopic, renderTopics } from "./rooms.js";
import { renderAdmin, renderFriends } from "./people.js";
import { editProfile } from "./appearance.js";
import { renderHowItWorks } from "./how-it-works.js";
import { startHistorySharing } from "./history.js";
import { mountNotifications } from "./notifications.js";
import { createLivePlayer } from "./live.js";
import { createScreenShareController } from "./screen-share.js";
import { createVoicePanel, releaseVoiceForLogout } from "./voice.js";
import { language, languages, setLanguage, t } from "./i18n.js";
import { api, button, closeDialog, el, field, form, paintPersonMark, paintPersonName, requireLoginOnExpiry, select } from "./ui.js";

const navigation = document.querySelector("#navigation");
const profile = document.querySelector("#profile");
const adminLink = document.querySelector("#admin-link");
const avatar = document.querySelector("#avatar");
const profileName = document.querySelector("#profile-name");
const profileEditor = document.querySelector("#profile-edit");
const bootstrap = document.querySelector("#boot");
const auth = document.querySelector("#auth");
const workspace = document.querySelector("#workspace");
const logout = document.querySelector("#logout");
const playerDock = document.querySelector("#player-dock");
const voiceDock = document.querySelector("#voice-dock");
const broadcastDock = document.querySelector("#broadcast-dock");
const notificationDock = document.querySelector("#notification-dock");

let user = null;
let view;
let activeTopic;
let workspaceSession;
let player;
let voice;
let screenShare;
const invite = takeInvite();
let pendingInvite = invite;

const routes = { topics: "rooms", themen: "rooms", freunde: "friends", einladungen: "invites", "so-funktionierts": "help" };
const navLabels = {
  rooms: t("Rooms", "Räume"), friends: t("Friends", "Freunde"), invites: t("Invites", "Einladungen"),
  help: t("How it works", "So funktioniert’s"),
};

document.documentElement.lang = language();
navigation.setAttribute("aria-label", t("Main navigation", "Hauptnavigation"));
for (const link of navigation.querySelectorAll("[data-nav]")) link.textContent = navLabels[link.dataset.nav];
document.querySelector(".skip-link").textContent = t("Skip to content", "Zum Inhalt springen");
document.querySelector(".wordmark").setAttribute("aria-label", t("ZeloteZ Rooms – Home", "ZeloteZ Rooms – Startseite"));
logout.textContent = t("Sign out", "Abmelden");
profileEditor.title = t("Edit profile", "Profil bearbeiten");
profileEditor.setAttribute("aria-label", profileEditor.title);
document.querySelector("#dialog-close").setAttribute("aria-label", t("Close", "Schließen"));
bootstrap.querySelector("p").textContent = t("Checking the connection …", "Verbindung wird geprüft …");

function languageChooser() {
  const picker = select(languages.map(item => [item.id, item.label]), language());
  picker.addEventListener("change", () => {
    setLanguage(picker.value);
    window.webkit?.messageHandlers?.roomsCapture?.postMessage({ action: "language", language: picker.value });
    if (pendingInvite !== null) {
      const url = new URL(location.href);
      url.hash = new URLSearchParams({ invite: pendingInvite }).toString();
      history.replaceState(null, "", url);
    }
    location.reload();
  });
  return field(t("Language", "Sprache"), picker);
}

function takeInvite() {
  const url = new URL(location.href);
  const hash = new URLSearchParams(url.hash.slice(1));
  const invitation = hash.get("invite");
  if (invitation !== null) {
    url.hash = "";
    history.replaceState(null, "", url);
  }
  return invitation;
}

function getRoute() {
  try {
    const [path, query] = location.hash.replace(/^#\/?/u, "").split("?", 2);
    const [page = "rooms", topicId, channelId] = path.split("/").filter(Boolean).map(decodeURIComponent);
    const params = new URLSearchParams(query);
    const message = params.get("message");
    const stream = params.get("stream");
    const target = {
      messageId: /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(message ?? "") ? message : undefined,
      streamId: /^[a-f0-9]{32}$/u.test(stream ?? "") ? stream : undefined,
    };
    return { page: Object.hasOwn(routes, page) ? routes[page] : page, topicId, channelId, target };
  } catch {
    return { page: "rooms" };
  }
}

function setNav(active) {
  for (const link of navigation.querySelectorAll("[data-nav]")) {
    if (link.dataset.nav === active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function paintOwnProfile() {
  paintPersonMark(avatar, user);
  paintPersonName(profileName, user);
  for (const mark of workspace.querySelectorAll("[data-person-avatar]")) {
    if (mark.dataset.personAvatar === user.id) paintPersonMark(mark, user);
  }
  for (const name of workspace.querySelectorAll("[data-person-name]")) {
    if (name.dataset.personName === user.id) paintPersonName(name, user);
  }
}

profileEditor.addEventListener("click", () => {
  if (!user) return;
  const account = user;
  editProfile(account, profile => {
    if (user !== account) return;
    Object.assign(user, profile);
    paintOwnProfile();
  }, languageChooser());
});

async function showWorkspace(nextUser) {
  user = nextUser;
  workspaceSession?.abort();
  workspaceSession = new AbortController();
  const { signal } = workspaceSession;
  player = createLivePlayer({ signal, user }, playerDock);
  voice = createVoicePanel({ user, signal }, voiceDock);
  screenShare = createScreenShareController({ signal }, broadcastDock);
  mountNotifications(notificationDock, signal, render);
  startHistorySharing(signal, user.id);
  pendingInvite = null;
  auth.replaceChildren();
  auth.hidden = true;
  bootstrap.hidden = true;
  navigation.hidden = false;
  profile.hidden = false;
  adminLink.hidden = !user.admin;
  paintOwnProfile();
  workspace.hidden = false;
  await render();
}

function showAuth(note = "", preset = "", showInvite = false) {
  if (user) window.webkit?.messageHandlers?.roomsCapture?.postMessage({ action: "session-ended" });
  if (view) view.abort();
  workspaceSession?.abort();
  workspaceSession = null;
  player = null;
  voice = null;
  screenShare = null;
  view = null;
  activeTopic = null;
  user = null;
  globalThis.ClubCrypto?.lock();
  closeDialog();
  bootstrap.hidden = true;
  workspace.hidden = true;
  workspace.replaceChildren();
  profile.hidden = true;
  navigation.hidden = true;
  auth.hidden = false;

  const startRegister = showInvite && pendingInvite !== null;
  const authAction = startRegister ? t("Create account", "Konto erstellen") : t("Sign in", "Anmelden");
  const header = el("h2", {}, authAction);
  const username = el("input", {
    type: "text", name: "username", autocomplete: "username", maxlength: "32",
    required: true, value: preset, autocapitalize: "none", spellcheck: "false",
    ...(startRegister ? { minlength: "3", pattern: "[a-z0-9][a-z0-9_.\\-]{2,31}" } : {}),
  });
  const name = el("input", { type: "text", name: "displayName", autocomplete: "nickname", maxlength: "48", required: true });
  const password = el("input", {
    type: "password", name: "password", autocomplete: startRegister ? "new-password" : "current-password",
    required: true, minlength: startRegister ? "12" : undefined,
  });
  const authForm = form([
    startRegister && field(t("Display name", "Anzeigename"), name),
    field(t("Username", "Benutzername"), username),
    field(t("Password", "Passwort"), password),
    note && el("p", { class: "status" }, note),
  ], authAction, async () => {
    if (!globalThis.ClubCrypto) throw new Error(t("Encryption could not be loaded. Reload the page.", "Die Verschlüsselung konnte nicht geladen werden. Lade die Seite erneut."));
    const loginName = username.value.trim().toLowerCase();
    const plainPassword = password.value;
    const result = startRegister
      ? await api("auth/register", { method: "POST", body: {
        ...(await ClubCrypto.prepareRegistration(loginName, plainPassword)),
        invite: pendingInvite, username: loginName, displayName: name.value.trim(),
      } })
      : await api("auth/login", { method: "POST", body: {
        username: loginName, password: await ClubCrypto.credential(loginName, plainPassword),
      } });
    password.value = "";
    if (!await ClubCrypto.unlock(result.user, plainPassword)) {
      throw new Error(t("Your keys could not be unlocked.", "Deine Schlüssel konnten nicht entsperrt werden."));
    }
    await showWorkspace(result.user);
  });
  auth.replaceChildren(
    el("div", { class: "auth-banner" }, el("h1", {}, "ZeloteZ Rooms"),
      el("p", {}, t("A private place for our friends.", "Ein privater Treffpunkt für unseren Freundeskreis."))),
    el("div", { class: "auth-form-area" }, header, authForm,
      pendingInvite !== null && button(startRegister ? t("Back to sign in", "Zum Login") : t("Accept invitation", "Einladung annehmen"),
        () => showAuth("", "", !startRegister), { class: "ghost" }), languageChooser()));
}

async function render(force = false) {
  if (!user) return;
  const route = getRoute();
  setNav(route.page);
  if (force !== true && route.page === "rooms" && route.topicId && activeTopic?.id === route.topicId) {
    activeTopic.view.select(route.channelId, route.target);
    return;
  }
  player.setLocation();
  voice.setLocation(null);
  if (view) view.abort();
  activeTopic = null;
  view = new AbortController();
  const { signal } = view;
  workspace.replaceChildren(el("p", { class: "panel status", role: "status" }, t("Loading …", "Wird geladen …")));
  workspace.scrollTop = 0;
  const context = { user, signal, player, voice, screenShare, refresh: () => render(true) };
  try {
    let page;
    if (route.page === "friends") page = await renderFriends(context);
    else if (route.page === "invites" && user.admin) page = await renderAdmin(context);
    else if (route.page === "help") page = renderHowItWorks();
    else if (route.page === "rooms" && route.topicId) {
      const topic = await renderTopic(context, route.topicId, route.channelId, route.target);
      if (signal.aborted) return;
      activeTopic = { id: route.topicId, view: topic };
      page = topic.node;
    }
    else page = await renderTopics(context);
    if (!signal.aborted) {
      workspace.replaceChildren(page);
      player.refreshPlacement();
    }
  } catch (error) {
    if (!signal.aborted) {
      workspace.replaceChildren(el("div", { class: "panel stack" },
        el("h1", {}, t("Page unavailable", "Seite nicht verfügbar")), el("p", { class: "error", role: "alert" }, error.message),
        el("div", { class: "inline" }, button(t("Try again", "Erneut laden"), render),
          el("a", { class: "button", href: "#/rooms" }, t("Back to rooms", "Zu den Räumen")))));
    }
  }
}

requireLoginOnExpiry(() => {
  if (user) showAuth(t("Your session expired. Please sign in again.", "Deine Sitzung ist abgelaufen. Melde dich erneut an."));
});
document.querySelector(".skip-link").addEventListener("click", event => {
  event.preventDefault();
  document.querySelector("#content").focus({ preventScroll: true });
});
window.addEventListener("hashchange", () => {
  const invitation = takeInvite();
  if (invitation !== null) {
    pendingInvite = invitation;
    showAuth("", "", true);
    return;
  }
  closeDialog();
  render();
});
logout.addEventListener("click", async () => {
  logout.disabled = true;
  try {
    screenShare?.stop();
    window.webkit?.messageHandlers?.roomsCapture?.postMessage({ action: "session-ended" });
    await releaseVoiceForLogout();
    await api("auth/logout", { method: "POST", body: {} });
    showAuth();
  } catch (error) {
    if (error.status === 401) showAuth();
    else {
      const message = document.querySelector("#toast");
      message.textContent = error.message;
      message.hidden = false;
    }
  } finally {
    logout.disabled = false;
  }
});

async function start() {
  try {
    const session = await api("auth/session");
    if (pendingInvite !== null) return showAuth("", "", true);
    if (!session.user) return showAuth();
    if (await globalThis.ClubCrypto?.unlock(session.user)) return showWorkspace(session.user);
    showAuth(t("Sign in to unlock your chats in this tab.", "Melde dich an, um deine Chats in diesem Tab zu entsperren."), session.user.username);
  } catch {
    bootstrap.replaceChildren(
      el("p", { class: "error" }, t("ZeloteZ Rooms is currently unavailable.", "Die Verbindung zum Treffpunkt ist gerade nicht verfügbar.")),
      button(t("Try again", "Erneut laden"), start));
  }
}
start();
