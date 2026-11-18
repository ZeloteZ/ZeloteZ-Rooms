import { quickViewerHeading, renderTopic, renderTopics } from "./rooms.js";
import { renderAdmin, renderFriends } from "./people.js";
import { renderDirect } from "./direct.js";
import { editProfile } from "./appearance.js";
import { showAccountSecurity } from "./account-security.js";
import { setupIsAvailable, setupKeyForm, setupProgress } from "./setup.js";
import { renderHowItWorks } from "./how-it-works.js";
import { isDesktopApp, renderDownloads } from "./downloads.js";
import { renderGuestViewer } from "./guest-viewer.js";
import { forgetMemberQuickChatDevices } from "./quick-chat-crypto.js";
import { clearQuickLinks, confirmYoutubeRoom, mountQuickRoomDock, quickSource } from "./quick-start.js";
import { startHistorySharing } from "./history.js";
import { mountNotifications } from "./notifications.js";
import { startPresence } from "./presence.js";
import { createLivePlayer } from "./live.js";
import { createVideoDock } from "./video-dock.js";
import { createScreenShareController } from "./screen-share.js";
import { createNativeBroadcast } from "./native-broadcast.js";
import { createVoicePanel, releaseVoiceForLogout } from "./voice.js";
import { createTutorials } from "./tutorial.js";
import { language, languages, setLanguage, t } from "./i18n.js";
import { api, button, closeDialog, el, field, form, notify, paintPersonMark, paintPersonName, requireLoginOnExpiry,
  select, setExpectedAccount, showDialog, topicHref } from "./ui.js";

const siteHeader = document.querySelector(".site-header");
const wordmark = siteHeader.querySelector(".wordmark");
const roomHeader = siteHeader.querySelector("#room-header");
const navigation = document.querySelector("#navigation");
const profile = document.querySelector("#profile");
const adminLink = document.querySelector("#admin-link");
const avatar = document.querySelector("#avatar");
const profileName = document.querySelector("#profile-name");
const profileEditor = document.querySelector("#profile-edit");
const downloadsLink = document.querySelector("#downloads-link");
const bootstrap = document.querySelector("#boot");
const auth = document.querySelector("#auth");
const workspace = document.querySelector("#workspace");
const logout = document.querySelector("#logout");
const playerDock = document.querySelector("#player-dock");
const videoDockNode = document.querySelector("#video-dock");
const voiceDock = document.querySelector("#voice-dock");
const broadcastDock = document.querySelector("#broadcast-dock");
const nativeBroadcastDock = document.querySelector("#native-broadcast-dock");
const quickRoomDock = document.querySelector("#quick-room-dock");
const notificationDock = document.querySelector("#notification-dock");
const profileUpdates = new EventTarget();
const sessionChanges = typeof BroadcastChannel === "function" ? new BroadcastChannel("zelotez-rooms-session") : null;
const desktopLogin = window.roomsDesktopLogin;
const desktop = isDesktopApp();
const roomIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;

let user = null;
let view;
let activeTopic;
let workspaceSession;
let player;
let videoDock;
let voice;
let screenShare;
let nativeBroadcast;
let quickRoomHeader;
let tutorials;
let vaultLocked = false;
let pendingRecovery = takeLinkToken("recover");
let pendingInvite = pendingRecovery === null ? takeLinkToken("invite") : null;
let setupAvailable = false;
let setupInvite = false;

const routes = { topics: "rooms", themen: "rooms", freunde: "friends", einladungen: "invites", "so-funktionierts": "help" };
const navLabels = {
  rooms: t("Rooms", "Räume"), friends: t("Friends", "Freunde"), invites: t("Invites", "Einladungen"),
  direct: t("Messages", "Nachrichten"),
  help: t("How it works", "So funktioniert’s"),
};

document.documentElement.lang = language();
navigation.setAttribute("aria-label", t("Main navigation", "Hauptnavigation"));
for (const link of navigation.querySelectorAll("[data-nav]")) link.textContent = navLabels[link.dataset.nav];
document.querySelector(".skip-link").textContent = t("Skip to content", "Zum Inhalt springen");
wordmark.setAttribute("aria-label", t("ZeloteZ Rooms – Home", "ZeloteZ Rooms – Startseite"));
logout.textContent = t("Sign out", "Abmelden");
profileEditor.title = t("Edit profile", "Profil bearbeiten");
profileEditor.setAttribute("aria-label", profileEditor.title);
downloadsLink.querySelector(".download-label").textContent = t("Client", "Client");
downloadsLink.hidden = desktop;
document.querySelector("#dialog-close").setAttribute("aria-label", t("Close", "Schließen"));
bootstrap.querySelector("p").textContent = t("Checking the connection …", "Verbindung wird geprüft …");

function languageChooser() {
  const picker = select(languages.map(item => [item.id, item.label]), language());
  picker.addEventListener("change", () => {
    setLanguage(picker.value);
    window.webkit?.messageHandlers?.roomsCapture?.postMessage({ action: "language", language: picker.value });
    if ((!setupInvite && pendingInvite !== null) || pendingRecovery !== null) {
      const url = new URL(location.href);
      url.hash = new URLSearchParams(pendingRecovery !== null ? { recover: pendingRecovery } : { invite: pendingInvite }).toString();
      history.replaceState(null, "", url);
    }
    location.reload();
  });
  return field(t("Language", "Sprache"), picker);
}

function takeLinkToken(name) {
  const url = new URL(location.href);
  const hash = new URLSearchParams(url.hash.slice(1));
  const token = hash.get(name);
  if (token !== null) {
    url.hash = "";
    history.replaceState(null, "", url);
  }
  return token;
}

function getRoute() {
  try {
    const fragment = location.hash.replace(/^#\/?/u, "");
    const shared = /^share\/youtube\/([A-Za-z0-9_-]{11})(?:\?((?:guests=[01](?:&live=[01])?|live=[01](?:&guests=[01])?)))?$/u.exec(fragment);
    if (shared) {
      const audience = new URLSearchParams(shared[2]);
      return { page: "rooms", sharedVideo: shared[1], audience: {
        guestAccess: audience.get("guests") !== "0", memberVisibility: audience.get("live") !== "0",
      } };
    }
    const [path, query] = fragment.split("?", 2);
    const [page = "rooms", topicId, channelId] = path.split("/").filter(Boolean).map(decodeURIComponent);
    const params = new URLSearchParams(query);
    const message = params.get("message");
    const stream = params.get("stream");
    const watch = params.get("watch");
    const shareSource = quickSource(params.get("share"));
    if (params.has("share")) {
      params.delete("share");
      history.replaceState(null, "", "#/" + path + (params.size ? "?" + params : ""));
    }
    const target = {
      messageId: roomIdPattern.test(message ?? "") ? message : undefined,
      streamId: /^[a-f0-9]{32}$/u.test(stream ?? "") ? stream : undefined,
      watchId: roomIdPattern.test(watch ?? "") ? watch : undefined,
      shareSource,
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
  if (active === "downloads") downloadsLink.setAttribute("aria-current", "page");
  else downloadsLink.removeAttribute("aria-current");
}

function setRoomHeader(banner = null, recoverFocus = false) {
  const focused = document.activeElement;
  const inRoom = Boolean(banner);
  const moveFocus = roomHeader.contains(focused) ||
    (inRoom && (navigation.contains(focused) || focused === wordmark)) ||
    (recoverFocus && focused === document.body);
  if (banner === roomHeader.firstElementChild) return;
  roomHeader.replaceChildren(...(banner ? [banner] : []));
  roomHeader.hidden = !inRoom;
  siteHeader.toggleAttribute("data-room-route", inRoom);
  navigation.inert = wordmark.inert = inRoom;
  if (moveFocus) {
    const target = inRoom ? banner.querySelector("h1") :
      (navigation.hidden ? wordmark : navigation.querySelector('[aria-current="page"]:not([hidden])') ?? wordmark);
    target?.focus({ preventScroll: true });
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
    profileUpdates.dispatchEvent(new Event("change"));
  }, languageChooser(), () => tutorials?.reset(), changePassword, openAccountSecurity);
  tutorials?.openProfile(document.querySelector("#dialog-content"));
});

function passwordInput(newPassword = false) {
  return el("input", { type: "password", required: true,
    autocomplete: newPassword ? "new-password" : "current-password", minlength: newPassword ? "15" : undefined });
}

let passwordHintId = 0;
function newPasswordField(label, input) {
  const id = "password-guidance-" + ++passwordHintId;
  input.setAttribute("aria-describedby", id);
  return el("div", { class: "field" }, field(label, input), el("p", { id, class: "subtle" }, t(
    "Use at least 15 characters. Choose an uncommon password or passphrase.",
    "Verwende mindestens 15 Zeichen. Wähle ein ungewöhnliches Passwort oder eine Passphrase.")));
}

function authenticatorInput() {
  return el("input", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", pattern: "[0-9]{6}", maxlength: "6" });
}

function signInFactor() {
  const input = authenticatorInput();
  const label = el("span");
  const switchMode = button("", () => {
    setMode(!recovery);
    input.focus();
  }, { class: "ghost" });
  const node = el("div", { class: "stack", hidden: true }, el("label", { class: "field" }, label, input), switchMode);
  let recovery = false;

  function setMode(next) {
    recovery = next;
    input.value = "";
    input.inputMode = next ? "text" : "numeric";
    input.autocomplete = next ? "off" : "one-time-code";
    input.maxLength = next ? 36 : 6;
    if (next) input.removeAttribute("pattern");
    else input.pattern = "[0-9]{6}";
    label.textContent = next ? t("Recovery code", "Wiederherstellungscode") : t("Authenticator code", "Authenticator-Code");
    switchMode.textContent = next ? t("Use authenticator code", "Authenticator-Code verwenden") : t("Use recovery code", "Wiederherstellungscode verwenden");
  }
  setMode(false);

  return {
    node,
    value: () => input.value.trim(),
    show({ focus = true } = {}) {
      node.hidden = false;
      input.required = true;
      if (focus) input.focus();
    },
    clear() {
      node.hidden = true;
      input.required = false;
      setMode(false);
    },
  };
}

async function openAccountSecurity() {
  const account = user;
  const signal = workspaceSession?.signal;
  if (!account || !signal || signal.aborted) return;
  const remembered = desktopLogin?.load(account.id).then(Boolean).catch(() => false);
  try {
    await showAccountSecurity(account, { signal, async onSessionChanged() {
      if (signal.aborted || user !== account) return;
      sessionChanges?.postMessage("changed");
      if (desktopLogin) {
        const keepSignIn = await remembered;
        if (signal.aborted || user !== account) return;
        const vault = ClubCrypto.deviceUnlockKey(account.id);
        if (vault && keepSignIn) await desktopLogin.save(account.id, vault).catch(() => {});
        else await desktopLogin.forget().catch(() => {});
      }
      if (!signal.aborted && user === account && getRoute().page === "invites") void render(true);
    } });
  } catch (error) {
    if (!signal.aborted && user === account) notify(error.message);
  }
}

async function changePassword() {
  const account = user;
  if (!account) return;
  const title = t("Change password", "Passwort ändern");
  const current = passwordInput();
  const previous = account.identity?.detached ? passwordInput() : null;
  const next = passwordInput(true);
  const code = authenticatorInput();
  const codeField = field(t("Authenticator code", "Authenticator-Code"), code);
  const memberFactor = account.admin ? null : signInFactor();
  const askForCode = () => { codeField.hidden = false; code.required = true; };
  codeField.hidden = true;
  const body = form([
    field(t("Current password", "Aktuelles Passwort"), current),
    previous && field(t("Previous chat password", "Bisheriges Chatpasswort"), previous),
    newPasswordField(t("New password", "Neues Passwort"), next),
    account.admin ? codeField : memberFactor.node,
  ], title, async () => {
    if (user !== account) return;
    const nextPassword = next.value;
    const [prepared, currentCredential] = await Promise.all([
      ClubCrypto.rewrapIdentity(account, previous?.value ?? current.value, nextPassword),
      ClubCrypto.credential(account.username, current.value),
    ]);
    const remember = Boolean(await desktopLogin?.load(account.id).catch(() => null));
    if (!body.isConnected || user !== account) return;
    if (!codeField.hidden) {
      await api("admin/authorize", { method: "POST", body: { code: code.value } });
      codeField.hidden = true;
      code.required = false;
      code.value = "";
    }
    if (!body.isConnected || user !== account) return;
    let updated;
    try {
      ({ user: updated } = await api("auth/password", { method: "POST", body: {
        current: currentCredential, ...prepared,
        ...(memberFactor && !memberFactor.node.hidden && { code: memberFactor.value() }),
      } }));
    } catch (error) {
      if (error.details?.code === "ROOMS_OWNER_APPROVAL") {
        askForCode();
        code.focus();
      }
      if (error.details?.code === "ROOMS_MFA_CODE") memberFactor?.show();
      throw error;
    }
    closeDialog();
    sessionChanges?.postMessage("changed");
    if (!await ClubCrypto.unlock(updated, nextPassword)) {
      await desktopLogin?.forget().catch(() => {});
      showAuth(t("Sign in again with your new password.", "Melde dich mit deinem neuen Passwort an."), updated.username);
      return;
    }
    await (remember ? desktopLogin.save(updated.id, ClubCrypto.deviceUnlockKey(updated.id)) : desktopLogin?.forget())?.catch(() => {});
    await showWorkspace(updated);
    notify(t("Password changed. Other sessions have ended.", "Das Passwort wurde geändert. Andere Sitzungen wurden beendet."));
  });
  let security;
  try {
    security = await api(account.admin ? "admin/security" : "auth/mfa");
  } catch (error) {
    if (user === account) notify(error.message);
    return;
  }
  if (user !== account) return;
  if (account.admin && !security.configured) {
    showDialog(title, el("div", { class: "stack" },
      el("p", {}, t("Set up two-factor sign-in first.", "Richte zuerst die Zwei-Faktor-Anmeldung ein.")),
      button(t("Set up with QR code", "Per QR-Code einrichten"), openAccountSecurity)));
    return;
  }
  if (account.admin && security.approvedUntil <= Date.now() / 1000) askForCode();
  if (memberFactor && security.enabled) memberFactor.show({ focus: false });
  showDialog(title, body);
}

async function showWorkspace(nextUser, unlocked = true) {
  user = nextUser;
  vaultLocked = !unlocked;
  setExpectedAccount(user.id);
  workspaceSession?.abort();
  workspaceSession = new AbortController();
  const { signal } = workspaceSession;
  player = createLivePlayer({ signal, user }, playerDock);
  videoDock = createVideoDock({ signal, onSelect() { if (player.activeId()) player.stop(); } }, videoDockNode);
  player.whenChanged(() => { if (player.activeId()) videoDock.stop(); }, { signal });
  voice = createVoicePanel({ user, signal }, voiceDock);
  screenShare = createScreenShareController({ signal }, broadcastDock);
  nativeBroadcast = createNativeBroadcast(signal, nativeBroadcastDock);
  quickRoomHeader = mountQuickRoomDock(quickRoomDock, { user, signal, screenShare, nativeBroadcast });
  tutorials = createTutorials(user.id, signal);
  mountNotifications(notificationDock, signal, render);
  if (unlocked) startHistorySharing(signal, user.id);
  pendingInvite = null;
  setupAvailable = false;
  setupInvite = false;
  auth.replaceChildren();
  auth.hidden = true;
  bootstrap.hidden = true;
  navigation.hidden = false;
  profile.hidden = false;
  adminLink.hidden = !user.admin;
  paintOwnProfile();
  workspace.hidden = false;
  await render(true);
  if (!signal.aborted) startPresence(nextUser.id, signal);
}

function enterAuth() {
  clearQuickLinks();
  if (user) void forgetMemberQuickChatDevices(user.id);
  if (user) window.webkit?.messageHandlers?.roomsCapture?.postMessage({ action: "session-ended" });
  if (user) window.roomsNativeCapture?.close().catch(() => {});
  if (view) view.abort();
  workspaceSession?.abort();
  workspaceSession = null;
  player = null;
  videoDock = null;
  voice = null;
  screenShare = null;
  nativeBroadcast = null;
  quickRoomHeader = null;
  tutorials = null;
  view = null;
  activeTopic = null;
  user = null;
  vaultLocked = false;
  setExpectedAccount(null);
  globalThis.ClubCrypto?.lock();
  closeDialog();
  bootstrap.hidden = true;
  workspace.hidden = true;
  workspace.replaceChildren();
  profile.hidden = true;
  navigation.hidden = true;
  setRoomHeader();
  auth.hidden = false;
}

function showAuthPage(title, ...content) {
  auth.replaceChildren(
    el("div", { class: "auth-banner" }, el("h1", {}, "ZeloteZ Rooms"),
      el("p", {}, t("A private place for our friends.", "Ein privater Treffpunkt für unseren Freundeskreis."))),
    el("div", { class: "auth-form-area" }, el("h2", {}, title), content, languageChooser()));
}

function focusAuthHeading() {
  const heading = auth.querySelector(".auth-form-area h2");
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
}

function showSetup() {
  if (setupInvite) pendingInvite = null;
  setupInvite = false;
  enterAuth();
  showAuthPage(t("Set up Rooms", "Rooms einrichten"), setupKeyForm({
    onClaim(invite) {
      pendingInvite = invite;
      setupInvite = true;
      showAuth("", "", true);
      focusAuthHeading();
    },
    onSignIn() { showAuth(); focusAuthHeading(); },
  }));
  focusAuthHeading();
}

function showAuth(note = "", preset = "", showInvite = false) {
  enterAuth();
  const startRegister = showInvite && pendingInvite !== null;
  const authAction = startRegister ? t("Create account", "Konto erstellen") : t("Sign in", "Anmelden");
  const username = el("input", {
    type: "text", name: "username", autocomplete: "username", maxlength: "32",
    required: true, value: preset, autocapitalize: "none", spellcheck: "false",
    ...(startRegister ? { minlength: "3", pattern: "[a-z0-9][a-z0-9_.\\-]{2,31}" } : {}),
  });
  const name = el("input", { type: "text", name: "displayName", autocomplete: "nickname", maxlength: "48", required: true });
  const password = el("input", {
    type: "password", name: "password", autocomplete: startRegister ? "new-password" : "current-password",
    required: true, minlength: startRegister ? "15" : undefined,
  });
  const factor = signInFactor();
  username.addEventListener("input", factor.clear);
  const remember = desktopLogin && !startRegister && el("input", { type: "checkbox", name: "remember" });
  const authForm = form([
    startRegister && setupInvite && setupProgress(2),
    startRegister && setupInvite && el("p", { class: "muted" }, t(
      "Create the owner account. You'll secure it with an authenticator next.",
      "Erstelle das Betreiberkonto. Anschließend sicherst du es mit einem Authenticator ab.")),
    startRegister && field(t("Display name", "Anzeigename"), name),
    field(t("Username", "Benutzername"), username),
    startRegister ? newPasswordField(t("Password", "Passwort"), password) : field(t("Password", "Passwort"), password),
    factor.node,
    remember && el("label", { class: "inline" }, remember,
      t("Keep me signed in on this device", "Auf diesem Gerät angemeldet bleiben")),
    note && el("p", { class: "status" }, note),
  ], authAction, async () => {
    if (!globalThis.ClubCrypto) throw new Error(t("Encryption could not be loaded. Reload the page.", "Die Verschlüsselung konnte nicht geladen werden. Lade die Seite erneut."));
    const loginName = username.value.trim().toLowerCase();
    const plainPassword = password.value;
    const keepSignedIn = remember?.checked === true;
    let result;
    try {
      result = startRegister
        ? await api("auth/register", { method: "POST", body: {
          ...(await ClubCrypto.prepareRegistration(loginName, plainPassword)),
          invite: pendingInvite, username: loginName, displayName: name.value.trim(),
        } })
        : await api("auth/login", { method: "POST", body: {
          username: loginName, password: await ClubCrypto.credential(loginName, plainPassword),
          ...(!factor.node.hidden && { code: factor.value() }),
        } });
    } catch (error) {
      if (["ROOMS_OWNER_CODE", "ROOMS_MFA_CODE"].includes(error.details?.code)) factor.show();
      throw error;
    }
    password.value = "";
    factor.clear();
    sessionChanges?.postMessage("changed");
    const unlocked = await ClubCrypto.unlock(result.user, plainPassword);
    if (!unlocked && !result.user.identity?.detached) {
      await desktopLogin?.forget().catch(() => {});
      throw new Error(t("Your keys could not be unlocked.", "Deine Schlüssel konnten nicht entsperrt werden."));
    }
    let remembered;
    if (desktopLogin) {
      remembered = await (keepSignedIn && unlocked
        ? desktopLogin.save(result.user.id, ClubCrypto.deviceUnlockKey(result.user.id))
        : desktopLogin.forget()).catch(() => false);
    }
    await showWorkspace(result.user, unlocked);
    if (startRegister && result.user.admin) void openAccountSecurity();
    if (keepSignedIn && (!remembered || !unlocked)) notify(t(
      "Rooms couldn’t save this sign-in in your system’s secure storage. Sign in again the next time you open the app.",
      "Rooms konnte die Anmeldung nicht sicher auf diesem Gerät speichern. Melde dich beim nächsten Start erneut an."));
  });
  showAuthPage(authAction, authForm,
    setupInvite ? button(t("Back", "Zurück"), showSetup, { class: "ghost" })
      : pendingInvite !== null && button(startRegister ? t("Back to sign in", "Zum Login") : t("Accept invitation", "Einladung annehmen"),
        () => showAuth("", "", !startRegister), { class: "ghost" }),
    setupAvailable && !startRegister && !setupInvite && button(t("Set up Rooms", "Rooms einrichten"), showSetup, { class: "ghost" }));
}

function sameChatIdentity(account, current) {
  return current?.id === account.id && current.identity?.nonce === account.identity?.nonce &&
    current.identity?.detached === account.identity?.detached;
}

function showUnlock(account) {
  enterAuth();
  const password = passwordInput();
  const title = t("Unlock chats", "Chats entsperren");
  const unlockForm = form(field(t("Password", "Passwort"), password), title, async (_, screen) => {
    const encryption = globalThis.ClubCrypto;
    if (!encryption) throw new Error(t("Encryption could not be loaded. Reload the page.", "Die Verschlüsselung konnte nicht geladen werden. Lade die Seite neu."));
    const currentForm = () => screen.isConnected && !user;
    const passphrase = password.value;
    password.value = "";
    if (!await encryption.unlock(account, passphrase, undefined, currentForm)) {
      if (currentForm()) throw new Error(t("This password could not unlock your chats.", "Dieses Passwort konnte deine Chats nicht entsperren."));
      return;
    }
    try {
      const { user: current } = await api("auth/session");
      if (!currentForm()) return;
      if (!sameChatIdentity(account, current)) {
        showAuth(t("Your session has changed. Please sign in again.", "Deine Sitzung hat sich geändert. Melde dich erneut an."));
        return;
      }
      await showWorkspace(current);
    } catch (error) {
      if (currentForm()) encryption.lock();
      throw error;
    }
  });
  showAuthPage(title, el("p", { class: "status" },
    t("You are signed in as @{name}. Enter your password to unlock chats in this tab.",
      "Du bist als @{name} angemeldet. Gib dein Passwort ein, um Chats in diesem Tab zu entsperren.", { name: account.username })),
  unlockForm, button(t("Sign in with another account", "Mit anderem Konto anmelden"), () => showAuth(), { class: "ghost" }));
}

async function showRecovery(token) {
  pendingInvite = null;
  enterAuth();
  const title = t("Recover owner account", "Betreiberkonto wiederherstellen");
  const panel = el("div", { class: "auth-form-area stack" }, el("h2", {}, title));
  auth.replaceChildren(panel);
  try {
    const { user: account } = await api("auth/recovery", { method: "POST", body: { token } });
    if (pendingRecovery !== token || !panel.isConnected) return;
    const previous = passwordInput();
    const password = passwordInput(true);
    const keepLocked = el("input", { type: "checkbox" });
    keepLocked.addEventListener("change", () => {
      previous.disabled = keepLocked.checked;
      if (keepLocked.checked) previous.value = "";
    });
    panel.append(el("p", {}, "@" + account.username), form([
      el("p", {}, t("Use the previous chat password to keep your existing chats accessible.",
        "Gib das bisherige Chatpasswort ein, damit die vorhandenen Chats zugänglich bleiben.")),
      field(t("Previous chat password", "Bisheriges Chatpasswort"), previous),
      el("label", { class: "inline" }, keepLocked, t("I lost the chat password. Keep the chats locked.",
        "Ich habe das Chatpasswort verloren. Die Chats sollen gesperrt bleiben.")),
      newPasswordField(t("New password", "Neues Passwort"), password),
    ], title, async () => {
      ClubCrypto.assertNewPassword(password.value);
      const prepared = keepLocked.checked
        ? { password: await ClubCrypto.credential(account.username, password.value), keepLocked: true }
        : await ClubCrypto.rewrapIdentity(account, previous.value, password.value);
      if (pendingRecovery !== token || !panel.isConnected) return;
      await api("auth/recovery/complete", { method: "POST", body: { token, ...prepared } });
      pendingRecovery = null;
      await desktopLogin?.discard().catch(() => {});
      sessionChanges?.postMessage("changed");
      showAuth(t("Owner password reset. Sign in with your new password.", "Das Betreiberpasswort wurde zurückgesetzt. Melde dich mit dem neuen Passwort an."),
        account.username);
    }), languageChooser());
  } catch (error) {
    if (pendingRecovery !== token || !panel.isConnected) return;
    pendingRecovery = null;
    showAuth(error.message);
  }
}

function showTutorial(route, page, banner) {
  if (route.page === "watch" || page.hasAttribute("data-temporary")) return;
  if (page.matches(".home-dashboard")) tutorials?.visit("home", page);
  else if (page.matches(".topic-view")) {
    if (!page.hasAttribute("data-joined")) {
      tutorials?.visit("join", page, banner);
      return;
    }
    const channel = route.channelId && (page.querySelector(".room-layout[data-live-channel]") ? "live"
      : page.querySelector(".conversation") ? "chat" : null);
    tutorials?.visit(channel || "room", page, banner);
  } else tutorials?.visit(route.page, page);
}

async function render(force = false) {
  if (!user) return;
  const route = getRoute();
  if (desktop && route.page === "downloads") {
    history.replaceState(history.state, "", "#/rooms");
    route.page = "rooms";
  }
  quickRoomHeader.setLocation(route.page === "rooms" || route.page === "watch" ? route.topicId : undefined);
  if (route.sharedVideo) history.replaceState(history.state, "", "#/rooms");
  setNav(route.page === "watch" ? "rooms" : route.page);
  if (force !== true && route.page === "rooms" && route.topicId && activeTopic?.id === route.topicId) {
    activeTopic.view.select(route.channelId, route.target);
    showTutorial(route, activeTopic.view.node, activeTopic.view.header);
    return;
  }
  const focused = document.activeElement;
  const recoverFocus = workspace.contains(focused) || roomHeader.contains(focused);
  if (route.topicId && (route.page === "rooms" || route.page === "watch")) {
    const actions = roomHeader.querySelector(".room-actions");
    if (actions) actions.inert = true;
  } else setRoomHeader();
  player.setLocation();
  voice.setLocation(null);
  if (view) view.abort();
  activeTopic = null;
  view = new AbortController();
  const { signal } = view;
  let requestedHash = location.hash;
  const current = () => !signal.aborted && location.hash === requestedHash;
  workspace.replaceChildren(el("p", { class: "panel status", role: "status" }, t("Loading …", "Wird geladen …")));
  workspace.scrollTop = 0;
  const context = { user, signal, player, videoDock, voice, screenShare, nativeBroadcast, quickRoomHeader, profileUpdates,
    onAccountChanged: lockOnAccountChange, refresh: () => render(true) };
  try {
    if (route.page === "watch" && roomIdPattern.test(route.topicId ?? "")) {
      const { room } = await api("quick-rooms", { signal });
      if (!current()) return;
      if (room?.publicId === route.topicId && room.topicId === route.topicId && roomIdPattern.test(room.channelId ?? "")) {
        history.replaceState(history.state, "", topicHref(room.topicId, room.channelId));
        requestedHash = location.hash;
        route.page = "rooms";
        route.channelId = room.channelId;
        route.target = undefined;
      }
    }
    let page, banner;
    if (route.page === "friends") page = await renderFriends(context);
    else if (route.page === "direct") page = await renderDirect(context, route.topicId, route.target?.messageId);
    else if (route.page === "invites" && user.admin) page = await renderAdmin({ ...context, onSecurity: openAccountSecurity });
    else if (route.page === "help") page = renderHowItWorks();
    else if (route.page === "downloads") page = renderDownloads(context);
    else if (route.page === "watch" && roomIdPattern.test(route.topicId ?? "")) {
      const quick = quickViewerHeading();
      banner = quick.header;
      page = renderGuestViewer({ publicId: route.topicId, signal, member: true, accountId: user.id,
        onAccountChanged: lockOnAccountChange, videoDock, onRoom: quick.update });
    }
    else if (route.page === "rooms" && route.topicId) {
      const topic = await renderTopic(context, route.topicId, route.channelId, route.target);
      if (!current()) return;
      activeTopic = { id: route.topicId, view: topic };
      page = topic.node;
      banner = topic.header;
    }
    else page = await renderTopics(context);
    if (current()) {
      workspace.replaceChildren(...(vaultLocked ? [el("div", { class: "panel stack", role: "status" },
        el("p", {}, t("Your chats are locked. If you find your previous chat password, update it to unlock them.",
          "Deine Chats sind gesperrt. Wenn du das bisherige Chatpasswort wiederfindest, kannst du sie damit entsperren.")),
        button(t("Unlock chats", "Chats entsperren"), changePassword))] : []), page);
      setRoomHeader(banner, recoverFocus);
      player.refreshPlacement();
      videoDock.refreshPlacement();
      if (route.sharedVideo) confirmYoutubeRoom(context, route.sharedVideo, route.audience);
      else showTutorial(route, page, banner);
    }
  } catch (error) {
    if (current()) {
      setRoomHeader(null, recoverFocus);
      workspace.replaceChildren(el("div", { class: "panel stack" },
        el("h1", {}, t("Page unavailable", "Seite nicht verfügbar")), el("p", { class: "error", role: "alert" }, error.message),
        el("div", { class: "inline" }, button(t("Try again", "Erneut laden"), render),
          el("a", { class: "button", href: "#/rooms" }, t("Back to rooms", "Zu den Räumen")))));
    }
  }
}

function lockOnAccountChange() {
  if (!user) return;
  void desktopLogin?.discard().catch(() => {});
  showAuth(t("The signed-in account has changed. Sign in again.", "Das angemeldete Konto hat sich geändert. Melde dich erneut an."));
}

let checkingAccount = false;
async function checkTabAccount() {
  if (!user || checkingAccount) return;
  const current = user;
  checkingAccount = true;
  try {
    const session = await api("auth/session");
    if (user === current && !sameChatIdentity(current, session.user)) lockOnAccountChange();
  } catch {
    // Requests from this tab retain their expected-account guard during an interruption.
  } finally {
    checkingAccount = false;
  }
}
sessionChanges?.addEventListener("message", checkTabAccount);
document.addEventListener("visibilitychange", () => { if (!document.hidden) void checkTabAccount(); });
requireLoginOnExpiry(reason => {
  if (reason === "changed") lockOnAccountChange();
  else if (user) {
    void desktopLogin?.discard().catch(() => {});
    showAuth(t("Your session expired. Please sign in again.", "Deine Sitzung ist abgelaufen. Melde dich erneut an."));
  }
});
document.querySelector(".skip-link").addEventListener("click", event => {
  event.preventDefault();
  document.querySelector("#content").focus({ preventScroll: true });
});
window.addEventListener("hashchange", () => {
  tutorials?.leave();
  const recovery = takeLinkToken("recover");
  if (recovery !== null) {
    pendingRecovery = recovery;
    void showRecovery(recovery);
    return;
  }
  const invitation = takeLinkToken("invite");
  if (invitation !== null) {
    pendingRecovery = null;
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
    await desktopLogin?.forget().catch(() => {});
    screenShare?.stop();
    window.webkit?.messageHandlers?.roomsCapture?.postMessage({ action: "session-ended" });
    await window.roomsNativeCapture?.close().catch(() => {});
    await releaseVoiceForLogout();
    await api("auth/logout", { method: "POST", body: {} });
    sessionChanges?.postMessage("changed");
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
    if (pendingRecovery !== null) return showRecovery(pendingRecovery);
    const session = await api("auth/session");
    if (!session.user) await desktopLogin?.discard().catch(() => {});
    if (pendingInvite !== null) return showAuth("", "", true);
    if (!session.user) {
      setupAvailable = await setupIsAvailable();
      return setupAvailable ? showSetup() : showAuth();
    }
    if (await globalThis.ClubCrypto?.unlock(session.user)) return showWorkspace(session.user);
    const savedVault = await desktopLogin?.load(session.user.id).catch(() => null);
    if (savedVault && await globalThis.ClubCrypto?.unlock(session.user, undefined, savedVault)) return showWorkspace(session.user);
    await desktopLogin?.forget().catch(() => {});
    if (session.user.identity?.detached) return showWorkspace(session.user, false);
    showUnlock(session.user);
  } catch {
    bootstrap.replaceChildren(
      el("p", { class: "error" }, t("ZeloteZ Rooms is currently unavailable.", "Die Verbindung zum Treffpunkt ist gerade nicht verfügbar.")),
      button(t("Try again", "Erneut laden"), start));
  }
}
start();
