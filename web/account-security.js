import { locale, t } from "./i18n.js";
import { api, button, closeDialog, el, field, form, showDialog, status } from "./ui.js";

function existingFactor(value) {
  const code = value.trim();
  if (/^\d{6}$/u.test(code)) return code;
  const recoveryCode = code.replaceAll("-", "").toUpperCase();
  if (/^[A-Z2-7]{24}$/u.test(recoveryCode)) return recoveryCode;
  throw new Error(t("Enter a six-digit authenticator code or one of your recovery codes.",
    "Gib einen sechsstelligen Authenticator-Code oder einen deiner Wiederherstellungscodes ein."));
}

export function showAccountSecurity(account, { signal: parentSignal, onSessionChanged } = {}) {
  if (parentSignal?.aborted) return;
  const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
  const dialog = document.querySelector("#dialog");
  const title = t("Two-factor authentication", "Zwei-Faktor-Anmeldung");
  const panel = el("div", { class: "account-security stack" });
  const observer = new MutationObserver(() => {
    if (!panel.isConnected) controller.abort();
  });
  let enrollmentTimer;

  function active(screen = panel) {
    return !signal.aborted && dialog.open && screen.isConnected;
  }

  function paint(...children) {
    clearTimeout(enrollmentTimer);
    panel.replaceChildren(...children);
  }

  function sessionChanged({ enabled, required, recoveryCodesRemaining }) {
    if (!parentSignal?.aborted) {
      void Promise.resolve().then(() => onSessionChanged?.({ enabled, required, recoveryCodesRemaining })).catch(() => {});
    }
  }

  function overview(settings, message) {
    paint(message && status(message),
      el("p", { class: "tag" }, settings.enabled ? t("Enabled", "Aktiv") : t("Disabled", "Inaktiv")),
      el("p", {}, settings.required
        ? t("Two-factor sign-in is required for the owner account.", "Für das Betreiberkonto ist die Zwei-Faktor-Anmeldung erforderlich.")
        : t("Use a time-based code from your authenticator app when you sign in.",
          "Nutze bei der Anmeldung einen zeitbasierten Code aus deiner Authenticator-App.")),
      settings.enabled && el("p", { class: "subtle" }, t("Recovery codes remaining: {count}",
        "Verbleibende Wiederherstellungscodes: {count}", { count: settings.recoveryCodesRemaining })),
      el("div", { class: "inline" },
        button(settings.enabled ? t("Set up a new authenticator", "Neuen Authenticator einrichten")
          : t("Set up authenticator", "Authenticator einrichten"), () => credentials(settings, "setup"), { class: "primary" }),
        settings.enabled && button(t("Replace recovery codes", "Wiederherstellungscodes ersetzen"),
          () => credentials(settings, "recovery-codes"), { class: "ghost" }),
        settings.enabled && !settings.required && button(t("Disable two-factor authentication", "Zwei-Faktor-Anmeldung deaktivieren"),
          () => credentials(settings, "disable"), { class: "danger" })),
      el("div", { class: "inline" }, button(t("Done", "Fertig"), closeDialog, { class: "ghost" })));
  }

  function recoveryCodes({ recoveryCodes: codes, ...settings }) {
    if (!Array.isArray(codes) || !codes.length) return overview(settings);
    paint(el("h3", {}, t("Save your recovery codes", "Speichere deine Wiederherstellungscodes")),
      el("p", {}, t("You can use one of these codes to sign in if you lose access to your authenticator. Keep them somewhere safe. Each code works once and is shown only here.",
        "Wenn du keinen Zugriff mehr auf deinen Authenticator hast, kannst du dich mit einem dieser Codes anmelden. Bewahre sie sicher auf. Jeder Code gilt nur einmal und wird nur hier angezeigt.")),
      el("ul", { class: "account-recovery-codes" }, codes.map(code => el("li", {}, el("code", {}, code)))),
      el("div", { class: "inline" }, button(t("Done", "Fertig"), () => overview(settings), { class: "primary" })));
  }

  function formStep(settings, fields, label, submit) {
    const back = button(t("Back", "Zurück"), () => overview(settings), { class: "ghost" });
    return form([...fields, el("div", { class: "inline" }, back)], label, async (_, screen) => {
      if (!active(screen)) return;
      back.disabled = true;
      try {
        await submit(screen);
      } finally {
        back.disabled = false;
      }
    });
  }

  function credentials(settings, action) {
    const password = el("input", { type: "password", required: true, autocomplete: "current-password" });
    const code = settings.enabled && el("input", {
      type: "text", required: true, maxlength: 48, autocomplete: "one-time-code", autocapitalize: "none", spellcheck: "false",
    });
    const labels = {
      setup: t("Continue to authenticator setup", "Weiter zur Authenticator-Einrichtung"),
      "recovery-codes": t("Replace recovery codes", "Wiederherstellungscodes ersetzen"),
      disable: t("Disable two-factor authentication", "Zwei-Faktor-Anmeldung deaktivieren"),
    };
    const screen = formStep(settings, [
      action === "recovery-codes" && el("p", {}, t("Replacing the codes invalidates all previous recovery codes.",
        "Beim Ersetzen werden alle bisherigen Wiederherstellungscodes ungültig.")),
      action === "disable" && el("p", {}, t("After disabling two-factor authentication, you can sign in with just your password.",
        "Nach dem Deaktivieren kannst du dich allein mit deinem Passwort anmelden.")),
      field(t("Current password", "Aktuelles Passwort"), password),
      code && field(t("Authenticator or recovery code", "Authenticator- oder Wiederherstellungscode"), code),
    ], labels[action], async screen => {
      const enteredPassword = password.value;
      const factor = code ? existingFactor(code.value) : undefined;
      password.value = "";
      if (code) code.value = "";
      const current = await ClubCrypto.credential(account.username, enteredPassword);
      if (!active(screen)) return;
      const result = await api("auth/mfa/" + action, {
        method: "POST", signal, body: { current, ...(factor && { code: factor }) },
      });
      if (action !== "setup") sessionChanged(result);
      if (!active(screen)) return;
      if (action === "setup") enrollment(settings, result);
      else if (action === "recovery-codes") recoveryCodes(result);
      else overview(result, t("Two-factor authentication disabled.", "Zwei-Faktor-Anmeldung deaktiviert."));
    });
    paint(screen);
    password.focus();
  }

  function enrollment(settings, { enrollmentId, key, uri, expiresAt }) {
    const expires = Number(expiresAt) * 1000;
    if (typeof enrollmentId !== "string" || typeof key !== "string" || !Number.isFinite(expires)) {
      throw new Error(t("The authenticator setup response was invalid.", "Die Antwort für die Authenticator-Einrichtung war ungültig."));
    }
    const qr = el("div", { hidden: true });
    const code = el("input", { type: "text", required: true, inputmode: "numeric", pattern: "[0-9]{6}",
      maxlength: 6, autocomplete: "one-time-code" });
    const screen = formStep(settings, [
      el("p", {}, t("Scan the QR code in your authenticator app or enter the setup key manually. Then enter a code from the new entry.",
        "Scanne den QR-Code in deiner Authenticator-App oder gib den Einrichtungsschlüssel manuell ein. Gib anschließend einen Code aus dem neuen Eintrag ein.")),
      qr,
      el("p", {}, t("Manual setup key", "Manueller Einrichtungsschlüssel"), el("br"), el("code", { class: "mfa-setup-key" }, key)),
      el("p", { class: "subtle" }, t("This setup expires at {time}.", "Diese Einrichtung läuft um {time} ab.",
        { time: new Intl.DateTimeFormat(locale(), { hour: "numeric", minute: "2-digit" }).format(expires) })),
      field(t("Code from the new authenticator", "Code aus dem neuen Authenticator"), code),
    ], t("Confirm authenticator", "Authenticator bestätigen"), async screen => {
      const entered = code.value;
      code.value = "";
      const result = await api("auth/mfa/confirm", { method: "POST", signal, body: { enrollmentId, code: entered } });
      sessionChanged(result);
      if (active(screen)) recoveryCodes(result);
    });
    paint(screen);
    // The manual setup key is available immediately, even if the local QR asset cannot be loaded.
    void import("./qr-code.js").then(({ drawQrCode }) => {
      if (!active(screen)) return;
      const image = drawQrCode(uri);
      image.classList.add("mfa-qr");
      image.setAttribute("role", "img");
      image.setAttribute("aria-label", t("Authenticator setup QR code", "QR-Code für die Authenticator-Einrichtung"));
      qr.replaceChildren(image);
      qr.hidden = false;
    }).catch(() => {});
    enrollmentTimer = setTimeout(() => {
      if (active(screen)) overview(settings, t("Authenticator setup expired. Start again.",
        "Die Authenticator-Einrichtung ist abgelaufen. Starte sie erneut."));
    }, Math.max(0, expires - Date.now()));
  }

  async function load() {
    paint(status(t("Loading account security …", "Kontosicherheit wird geladen …")));
    try {
      const settings = await api("auth/mfa", { signal });
      if (active()) overview(settings);
    } catch (error) {
      if (active()) paint(status(error.message, "error"),
        el("div", { class: "inline" }, button(t("Try again", "Erneut laden"), load),
          button(t("Close", "Schließen"), closeDialog, { class: "ghost" })));
    }
  }

  signal.addEventListener("abort", () => {
    observer.disconnect();
    paint();
    if (dialog.open && panel.isConnected) closeDialog();
  }, { once: true });
  dialog.addEventListener("close", () => {
    if (!dialog.open || !panel.isConnected) controller.abort();
  }, { signal });
  window.addEventListener("pagehide", () => controller.abort(), { once: true, signal });
  showDialog(title, panel);
  observer.observe(document.querySelector("#dialog-content"), { childList: true });
  void load();
}
