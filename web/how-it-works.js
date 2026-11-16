import { t } from "./i18n.js";
import { el, field, select } from "./ui.js";

function card(title, text) {
  return el("div", { class: "help-card" }, el("h3", {}, title), el("p", {}, text));
}

function step(title, text) {
  return el("li", {}, el("h3", {}, title), el("p", {}, text));
}

function section(id, title, ...content) {
  return el("section", { class: "panel help-section", "aria-labelledby": id }, el("h2", { id }, title), content);
}

export function renderHowItWorks() {
  const sections = [
    ["help-overview", t("At a glance", "Auf einen Blick"),
      el("div", { class: "help-cards" },
        card(t("Chat · End-to-end encrypted", "Chat · Ende-zu-Ende verschlüsselt"),
          t("Messages, shared links, file names, attachments, and reaction emojis are encrypted in your browser. Members with access open them in theirs.", "Chattexte, geteilte Links, Dateinamen, Anhänge und Reaktions-Emojis werden im Browser verschlüsselt. Berechtigte Mitglieder öffnen sie in ihrem Browser.")),
        card(t("Voice and streams · Encrypted in transit", "Talk und Streams · Auf dem Transport verschlüsselt"),
          t("Voice, screen video, and any application audio are protected on the way to the server and from there to viewers. The server processes them for playback. Recording is disabled.", "Sprache, Bildschirmvideo und optionaler Anwendungston sind auf dem Weg zum Server und von dort zu den Zuschauern geschützt. Der Server verarbeitet sie für die Live-Wiedergabe. Aufzeichnungen sind ausgeschaltet.")),
        card(t("What the server can see", "Für den Betrieb sichtbar"),
          t("The server knows rooms, channels, memberships, roles, senders, timestamps, file sizes, and connection details. It also knows which account reacted to which message. It handles profile and room images so it can display them.", "Der Server kennt Räume, Kanäle, Mitgliedschaften, Rollen, Absender, Zeitpunkte, Dateigrößen und Verbindungsdaten. Er sieht auch, welches Konto auf welche Nachricht reagiert hat. Profile und Raumbilder verarbeitet er für die Anzeige.")))],
    ["help-message", t("How a message reaches your friends", "So kommt eine Nachricht an"),
      el("ol", { class: "help-steps" },
        step(t("Your browser encrypts", "Dein Browser verschlüsselt"),
          t("Each message gets its own key. Your browser encrypts a copy for every current member of a room. In a direct chat, it makes copies for you and your friend.", "Für jede Nachricht entsteht ein eigener Schlüssel. Dein Browser verschlüsselt eine Kopie für jedes aktuelle Raummitglied. Im Direktchat gibt es Kopien für dich und deinen Freund.")),
        step(t("The server stores and delivers", "Der Server speichert und liefert"),
          t("The server receives the encrypted message and encrypted copies of its key. It stores chat attachments in encrypted form too.", "Beim Server kommen die verschlüsselte Nachricht und die verschlüsselten Schlüsselkopien an. Dateien aus dem Chat bleiben ebenfalls verschlüsselt gespeichert.")),
        step(t("Members read the message", "Der Empfänger liest"),
          t("Each member’s browser uses their private account key to open their copy of the message key. It can then display the text and open attachments.", "Der Browser des Empfängers öffnet seine Schlüsselkopie mit dem privaten Schlüssel seines Kontos. Damit kann er den Text anzeigen und Anhänge öffnen.")))],
    ["help-mentions", t("Mentions and notifications", "Erwähnungen und Benachrichtigungen"),
      el("p", {}, t("Type @ in a chat to see suggestions for people, rooms, and channels. Your browser filters the suggestions as you type. Room and channel links work for members with access to the destination.", "Tippe im Chat @, um Vorschläge für Personen, Räume und Channels zu sehen. Dein Browser filtert die Vorschläge schon beim Tippen. Raum- und Channel-Links funktionieren für Mitglieder mit Zugriff auf das Ziel.")),
      el("p", {}, t("A personal mention appears in the recipient’s notification bell. The server uses the mentioned account ID and the IDs of the message and its chat to deliver the notification. The message and its embedded links stay end-to-end encrypted.", "Eine persönliche Erwähnung erscheint in der Benachrichtigungsglocke der erwähnten Person. Für die Zustellung nutzt der Server die ID des erwähnten Kontos sowie die IDs der Nachricht und ihres Chats. Die Nachricht und die darin enthaltenen Links bleiben Ende-zu-Ende verschlüsselt."))],
    ["help-direct", t("Direct messages and alerts", "Direktnachrichten und Hinweise"),
      el("p", {}, t("You and a confirmed friend can share messages, links and attachments in a direct chat. Both accounts can still open their existing history if the friendship ends.", "Mit bestätigten Freunden kannst du Nachrichten, Links und Anhänge im Direktchat teilen. Wenn die Freundschaft endet, bleibt der bisherige Verlauf für beide Konten lesbar.")),
      el("p", {}, t("The bell shows friend requests, direct messages and mentions. Enable live alerts in your profile for rooms you’ve joined. The desktop app can show the same alerts while it’s running.", "Die Glocke zeigt Freundschaftsanfragen, Direktnachrichten und Erwähnungen. Hinweise zu Live-Starts in deinen Räumen schaltest du im Profil ein. Die Desktop-App kann dieselben Hinweise anzeigen, solange sie läuft.")),
      el("p", {}, t("The server uses the sender, recipient, time and conversation to deliver alerts. Alerts include an event and an address inside Rooms. Message text and file names stay in the encrypted chat.", "Für Hinweise nutzt der Server Absender, Empfänger, Zeitpunkt und Unterhaltung. Ein Hinweis enthält das Ereignis und einen Link innerhalb von Rooms. Nachrichtentexte und Dateinamen bleiben im verschlüsselten Chat."))],
    ["help-history", t("How new members get chat history", "So erhalten neue Mitglieder den Verlauf"),
      el("p", {}, t("When you join a room, its history and attachments become available automatically. A signed-in browser that can read the older messages encrypts their keys for your account too.", "Mit deinem Beitritt bekommst du automatisch Zugriff auf den bisherigen Raumverlauf einschließlich der Anhänge. Ein angemeldeter Browser, der ältere Nachrichten lesen kann, verschlüsselt ihre Schlüssel zusätzlich für dein Konto.")),
      el("p", {}, t("If all those browsers are offline, history will arrive when a member with access signs in. The server stores each message and attachment once. Each new member gets a small encrypted copy of the key for each earlier message.", "Ist gerade kein solcher Browser online, wird der Verlauf nachgereicht, sobald sich ein berechtigtes Mitglied anmeldet. Jede Nachricht und jeder Anhang bleibt einmal gespeichert. Pro neuem Mitglied kommt eine kleine verschlüsselte Schlüsselkopie je älterer Nachricht hinzu.")),
      el("p", {}, t("A browser checks that a key can open the message before sharing it. If your browser detects a damaged history key, it requests a fresh copy from a member who can read the message.", "Bevor ein Browser einen Schlüssel freigibt, prüft er, ob sich die Nachricht damit öffnen lässt. Erkennt dein Browser eine fehlerhafte Schlüsselkopie, fordert er eine neue von einem Mitglied an, das die Nachricht lesen kann.")),
      el("p", {}, t("When automatic loading is enabled, the chat loads attachments as you reach them. You can set a file size limit in your profile. Some images open only when you choose to view them.", "Wenn automatisches Laden aktiv ist, lädt der Chat Anhänge, sobald du sie im Verlauf erreichst. Im Profil kannst du dafür eine Größengrenze festlegen. Manche Bilder öffnen sich erst, wenn du sie zur Ansicht auswählst.")),
      el("p", { class: "help-note" }, t("Access to a room also controls who can retrieve its history. Copies members already saved may still exist.", "Den Verlauf können Mitglieder mit Zugriff auf den Raum abrufen. Bereits gespeicherte Kopien können bestehen bleiben."))],
    ["help-account", t("What happens to your private key", "Was mit deinem persönlichen Schlüssel passiert"),
      el("p", {}, t("The server stores an encrypted copy of your private key. Your browser derives the key to open that copy from your password. During sign-in, the server receives a separately derived value.", "Der Server bewahrt eine verschlüsselte Kopie deines privaten Schlüssels auf. Zum Öffnen leitet dein Browser den passenden Schlüssel aus deinem Passwort ab. Bei der Anmeldung erhält der Server einen getrennt abgeleiteten Wert.")),
      el("p", {}, t("Someone with a copy of the server database sees encrypted chat content. They could still test weak passwords against that copy. If you lose your password after your browser locks the key, you can no longer unlock it with that account.", "Wer nur die Serverdatenbank kopiert, sieht verschlüsselte Chatinhalte. Schwache Passwörter könnten mit der Kopie durchprobiert werden. Wenn du dein Passwort verlierst und dein Browser den Schlüssel gesperrt hat, kannst du ihn mit diesem Konto nicht mehr öffnen.")),
      el("p", {}, t("The site operator can end all sessions for an account or suspend its sign-in. Suspension also stops new chat keys from being shared with that account. Copies already saved on a device can still exist.", "Der Betreiber kann alle Sitzungen eines Kontos beenden oder seine Anmeldung sperren. Gesperrte Konten erhalten keine weiteren Chatschlüssel. Bereits auf einem Gerät gespeicherte Kopien können bestehen bleiben."))],
    ["help-trust", t("Why the website still requires trust", "Warum die Website eine Vertrauensrolle hat"),
      el("p", {}, t("Your browser downloads the app code from the server. A server that actively changes the code could capture your password or decrypted messages when you open the site.", "Dein Browser lädt den Programmcode vom Server. Ein Server, der diesen Code aktiv verändert, könnte beim Öffnen der Website dein Passwort oder entschlüsselte Nachrichten abgreifen.")),
      el("p", {}, t("The server also tells your browser who belongs to a room and supplies each person’s public key on first contact. Your browser remembers keys it has seen and rejects changes. An actively manipulated server could list an unknown account as a room member. Your browser could then share history keys with that account even if the app code was unchanged.", "Der Server meldet deinem Browser die Raummitglieder und liefert beim ersten Kontakt ihren öffentlichen Schlüssel. Dein Browser merkt sich bereits bekannte Schlüssel und lehnt Änderungen ab. Ein aktiv manipulierter Server könnte ein unbekanntes Konto als Raummitglied ausgeben. Dein Browser könnte dann Verlaufsschlüssel für dieses Konto freigeben, auch wenn der App-Code unverändert ist."))],
    ["help-talk", t("Voice and streams as you browse", "Talk und Stream unterwegs"),
      el("p", {}, t("Open a live channel to see its streams and voice controls. Choose “Join voice chat” to listen. Your microphone starts off and turns on when you enable it and grant permission.", "In einem Live-Kanal findest du Streams und die Sprachchat-Steuerung. Wähle „Sprachchat betreten“, um zuzuhören. Dein Mikrofon bleibt aus, bis du es einschaltest und den Zugriff erlaubst.")),
      el("p", {}, t("You can watch and share streams independently of the voice chat.", "Du kannst Streams unabhängig vom Sprachchat ansehen und teilen.")),
      el("p", {}, t("Voice and stream playback continue as you browse. The controls and a link back to the live channel sit beside your profile. You can join one voice chat at a time. To switch, open the other live channel and choose “Switch voice chat”.", "Talk und Stream laufen beim Wechsel zwischen Seiten weiter. Neben deinem Profil findest du die Bedienelemente und den Link zurück zum jeweiligen Live-Kanal. Dein Konto kann immer nur an einem Talk teilnehmen. Für einen anderen Talk öffnest du dessen Live-Kanal und wählst „Sprachchat wechseln“.")),
      el("p", {}, t("Use “Leave voice chat” or “Stop playback” to close either connection. Both end when you sign out or close the tab.", "Über „Sprachchat verlassen“ und „Wiedergabe beenden“ stoppst du die jeweilige Verbindung. Beim Abmelden oder Schließen des Tabs enden beide."))],
    ["help-share", t("How to share your screen", "So teilst du deinen Bildschirm"),
      el("p", {}, t("Open a live channel and choose “Share screen”. Your browser asks which screen, window, or tab you want to share. The desktop app opens its capture window, where you can also choose a region.", "Öffne einen Live-Kanal und wähle „Bildschirm teilen“. Im Browser wählst du einen Bildschirm, ein Fenster oder einen Tab aus. In der Desktop-App öffnet sich die Aufnahme, in der du auch einen Ausschnitt wählen kannst.")),
      el("p", {}, t("The live channel shows the audience and encrypted stream chat. Stop sharing using the controls in the header or the desktop capture window.", "Im Live-Kanal siehst du die Zuschauer und den verschlüsselten Streamchat. Beende die Freigabe über die Steuerung im Header oder über das Aufnahmefenster der Desktop-App."))],
  ];
  const picker = select(sections.map(([id, title]) => [id, title]), sections[0][0]);
  const detail = el("div", { id: "help-detail", class: "help-content", tabindex: "0", role: "region", "aria-label": t("Explanation", "Erklärung") });
  picker.setAttribute("aria-controls", detail.id);
  function showSection() {
    const selected = sections.find(([id]) => id === picker.value);
    if (selected) detail.replaceChildren(section(...selected));
  }
  picker.addEventListener("change", () => {
    showSection();
    detail.scrollTop = 0;
  });
  showSection();

  return el("article", { class: "help-page secondary-page" },
    el("header", { class: "help-header" }, el("h1", {}, t("How it works", "So funktioniert’s")), field(t("Explanation", "Erklärung"), picker)),
    detail);
}
