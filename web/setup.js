import { t } from "./i18n.js";
import { api, button, el, field, form } from "./ui.js";

export async function setupIsAvailable() {
  try {
    const setup = await api("setup", { signal: AbortSignal.timeout(5000) });
    return setup.available === true;
  } catch {
    // Existing installations can keep serving the usual sign-in without this optional endpoint.
    return false;
  }
}

export function setupProgress(current) {
  return el("ol", { class: "setup-progress", "aria-label": t("Setup progress", "Einrichtungsfortschritt") },
    [t("Access", "Zugang"), t("Account", "Konto"), t("Security", "Sicherheit")].map((label, index) =>
      el("li", { "aria-current": current === index + 1 ? "step" : undefined },
        el("span", { class: "setup-step-number", "aria-hidden": "true" }, index + 1), label)));
}

export function setupKeyForm({ onClaim, onSignIn }) {
  const key = el("input", { type: "password", name: "setupKey", required: true, maxlength: 128,
    autocomplete: "off", autocapitalize: "none", spellcheck: "false", "aria-describedby": "setup-key-note" });
  const screen = form([
    el("p", { id: "setup-key-note", class: "muted" }, t(
      "Enter the setup key from your server terminal. You'll choose a separate password for your account in the next step.",
      "Gib den Einrichtungsschlüssel aus deinem Serverterminal ein. Im nächsten Schritt wählst du ein eigenes Passwort für dein Konto.")),
    field(t("Setup key", "Einrichtungsschlüssel"), key),
    el("details", { class: "setup-key-help" },
      el("summary", {}, t("Where do I find the setup key?", "Wo finde ich den Einrichtungsschlüssel?")),
      el("div", { class: "stack" },
        el("p", {}, t("On your Docker host, run:", "Führe auf deinem Docker-Host aus:")),
        el("code", {}, "docker exec rooms node bootstrap.mjs --setup-key"),
        el("p", {}, t("With Docker Compose, use the same Compose options you used to start Rooms:",
          "Mit Docker Compose verwende dieselben Compose-Optionen wie beim Start von Rooms:")),
        el("code", {}, "docker compose exec rooms node bootstrap.mjs --setup-key"),
        el("p", {}, t("For other installations, run this in the Rooms server folder:",
          "Bei anderen Installationen führe dies im Rooms-Serverordner aus:")),
        el("code", {}, "node bootstrap.mjs --setup-key"))),
  ], t("Continue", "Weiter"), async () => {
    const entered = key.value.trim();
    key.value = "";
    const result = await api("setup", { method: "POST", body: { key: entered }, signal: AbortSignal.timeout(10000) });
    if (!screen.isConnected) return;
    if (!/^[A-Za-z0-9_-]{43}$/u.test(result?.invite)) {
      throw new Error(t("The setup response was invalid. Please try again.", "Die Einrichtungsantwort war ungültig. Versuche es erneut."));
    }
    onClaim(result.invite);
  });
  return el("div", { class: "stack setup-key-form" }, setupProgress(1), screen,
    button(t("Back to sign in", "Zum Login"), onSignIn, { class: "ghost" }));
}
