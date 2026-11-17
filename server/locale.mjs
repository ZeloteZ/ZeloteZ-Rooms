const localeKey = Symbol('response locale')
const sourceLocale = 'de'
const defaultLocale = 'en'

const catalogs = {
  de: {
    messages: {
      'Dieses Bild oder Thema ist nicht verfügbar.': 'Dieses Bild oder dieser Raum ist nicht verfügbar.',
      'Dieses Thema hat bereits 50 Kanäle.': 'Dieser Raum hat bereits 50 Kanäle.',
      'Dieses Thema hat bereits die maximale Mitgliederzahl erreicht.': 'Dieser Raum hat bereits die maximale Mitgliederzahl erreicht.',
      'Du kannst nur bestätigte Freunde für das Thema freigeben.': 'Zugriff auf diesen Raum ist bestätigten Freunden vorbehalten.',
      'In diesem Thema gibt es schon einen Kanal mit diesem Namen.': 'In diesem Raum gibt es schon einen Kanal mit diesem Namen.',
      'Nur die Themenleitung kann Channels verwalten.': 'Zum Verwalten von Channels brauchst du die Rolle Raumersteller oder Raum-Admin.',
      'Thema oder Channel nicht gefunden.': 'Raum oder Channel nicht gefunden.',
    },
    patterns: [],
  },
  en: {
    messages: {
      'Benutzername oder Passwort stimmt nicht.': 'The username or password is incorrect.',
      'Dafür fehlt dir die Berechtigung.': 'You do not have permission to do this.',
      'Das angemeldete Konto hat sich geändert.': 'The signed-in account has changed.',
      'Das Betreiberkonto ist geschützt.': 'The site owner account is protected.',
      'Das aktuelle Passwort stimmt nicht.': 'The current password is incorrect.',
      'Das Konto wurde inzwischen geändert. Melde dich erneut an.': 'The account has changed. Sign in again.',
      'Das Passwort oder der Chatschlüssel konnte nicht verarbeitet werden.': 'The password or chat key could not be processed.',
      'Der Wiederherstellungslink ist ungültig oder abgelaufen.': 'The recovery link is invalid or has expired.',
      'Gib einen aktuellen Code aus deiner Authenticator-App ein.': 'Enter a current code from your authenticator app.',
      'Richte zuerst die Zwei-Faktor-Anmeldung für das Betreiberkonto ein.': 'Set up two-factor sign-in for the owner account on the server first.',
      'Bestätige den Betreiberzugriff mit einem aktuellen Authenticator-Code.': 'Confirm owner access with a current authenticator code.',
      'Das Bild konnte nicht verarbeitet werden. Wähle ein statisches Bild mit höchstens 16 Megapixeln.':
        'Choose a still image of up to 16 megapixels.',
      'Das Passwort konnte nicht verarbeitet werden.': 'The password could not be processed.',
      'Das Passwort für diesen Stream-Raum fehlt oder stimmt nicht.': 'The password for this stream room is missing or incorrect.',
      'Deine Teilnahme am Talk ist abgelaufen.': 'Your voice chat session has expired.',
      'Der Benutzername braucht 3 bis 32 Zeichen. Erlaubt sind Buchstaben von A bis Z, Zahlen, Punkt, Bindestrich und Unterstrich.':
        'Use 3 to 32 letters (A–Z), digits, periods, hyphens, or underscores for your username.',
      'Der Schlüssel für den verschlüsselten Chat ist ungültig.': 'The encrypted chat key is invalid.',
      'Der Sprachchat ist voll. Versuch es später erneut.': 'The voice chat is full. Try again later.',
      'Der Rundgangsfortschritt wurde inzwischen zurückgesetzt.': 'Tutorial progress was reset. Refresh it and try again.',
      'Der Sprachserver hat eine ungültige Antwort geliefert.': 'The voice server sent an invalid response.',
      'Der Sprachserver ist gerade nicht erreichbar.': 'The voice server is unavailable right now.',
      'Der Sprachserver konnte die Verbindung nicht öffnen.': 'The voice server could not open the connection.',
      'Der Speicher für Anhänge ist voll.': 'The attachment storage is full.',
      'Der Speicher für Chatnachrichten ist voll.': 'The chat message storage is full.',
      'Der Speicher für Verlaufsfreigaben ist voll.': 'History sharing storage is full.',
      'Der Speicher für Designbilder ist voll.': 'The design image storage is full.',
      'Der Speicher für Videos ist voll.': 'Video storage is full.',
      'Direktnachrichten sind bestätigten Freunden vorbehalten.': 'Direct messages are limited to confirmed friends.',
      'Der Streamingserver ist gerade nicht erreichbar.': 'The streaming server is unavailable right now.',
      'Die Wiedergabe benötigt H.264-Video und optional Opus-Audio.': 'This playback requires H.264 video. Opus audio is optional.',
      'Der Talk unterstützt eine einzelne Opus-Tonspur.': 'Voice chat supports a single Opus audio track.',
      'Die Anfrage ist zu groß.': 'The request is too large.',
      'Die Anfrage konnte nicht verarbeitet werden.': 'The request could not be processed.',
      'Die Anfrage muss JSON enthalten.': 'The request must contain JSON.',
      'Das Video darf höchstens 256 MiB groß sein.': 'The video can be up to 256 MiB.',
      'Die Watchparty wurde inzwischen geändert.': 'The watch party has changed.',
      'Der Livechat hat sich inzwischen geändert.': 'The live chat has changed.',
      'Die Anmeldung ist gerade ausgelastet. Versuche es gleich erneut.': 'Sign-in is busy right now. Try again in a moment.',
      'Die Channel-Liste hat sich geändert. Lade sie erneut.': 'The channel list has changed. Refresh it and try again.',
      'Die Einladung ist ungültig, abgelaufen oder schon eingelöst.': 'The invite is invalid, expired, or already used.',
      'Die Mitgliederliste hat sich geändert. Bitte sende erneut.': 'The member list has changed. Send the message again.',
      'Die maximale Anzahl von Räumen ist erreicht.': 'The room limit has been reached.',
      'Die maximale Anzahl von Direktchats ist erreicht.': 'The direct conversation limit has been reached.',
      'Die Tonspur wird noch verbunden.': 'The audio track is still connecting.',
      'Die verschlüsselte Datei ist ungültig.': 'The encrypted file is invalid.',
      'Die Wiedergabe gehört zu einer anderen Sitzung.': 'Playback belongs to a different session.',
      'Die Wiedergabe ist ungültig.': 'The playback session is invalid.',
      'Diese Anfrage ist hier nicht erlaubt.': 'This request is not permitted here.',
      'Diese Anfrage wird hier nicht unterstützt.': 'This request is not supported here.',
      'Diese Einladung ist nicht mehr offen.': 'This invite is no longer active.',
      'Diese Herkunft ist für die Anfrage gesperrt.': 'Requests from this origin are blocked.',
      'Diese Nachricht wurde bereits verwendet.': 'This message has already been used.',
      'Diese Person sendet gerade keinen Ton.': 'This person is not sending audio right now.',
      'Dieser Anhang wurde bereits verwendet.': 'This attachment has already been used.',
      'Dieser Benutzername ist schon vergeben.': 'This username is already taken.',
      'Dieser Bereich ist nicht verfügbar.': 'This area is unavailable.',
      'Dieser Stream-Raum ist nicht verfügbar.': 'This stream room is unavailable.',
      'Dieser temporäre Raum gehört bereits zu einer Freigabe.': 'This temporary room already belongs to a stream or watch party.',
      'Dieser Chat oder dieses Mitglied ist nicht verfügbar.': 'This chat or member is unavailable.',
      'Dieses Bild oder Thema ist nicht verfügbar.': 'This image or room is unavailable.',
      'Dieses Thema hat bereits 50 Kanäle.': 'This room already has 50 channels.',
      'Dieses Thema hat bereits die maximale Mitgliederzahl erreicht.': 'This room has reached its member limit.',
      'Du bist bereits in einem Sprachchat verbunden.': 'You are already connected to a voice chat.',
      'Du darfst diese Nachricht nicht löschen.': 'You do not have permission to delete this message.',
      'Du darfst dieses Design nicht ändern.': 'You do not have permission to change this design.',
      'Du darfst in diesem Channel nicht streamen.': 'You do not have permission to stream in this channel.',
      'Du hast hier bereits einen Stream vorbereitet oder gestartet.': 'You already have a stream set up or running in this channel.',
      'Du hast bereits einen Stream vorbereitet oder gestartet.': 'You already have a stream set up or running.',
      'Du hast bereits einen temporären Stream-Raum.': 'You already have a temporary stream room.',
      'Alle Streamplätze sind gerade belegt.': 'All stream slots are currently in use.',
      'Alle temporären Stream-Räume sind belegt.': 'All temporary stream rooms are currently in use.',
      'Du hast die maximale Anzahl an Reaktionen für diese Nachricht erreicht.': 'You have reached the reaction limit for this message.',
      'Du kannst nur bestätigte Freunde für das Thema freigeben.': 'Access to this room is limited to confirmed friends.',
      'Ein Anhang fehlt oder wurde schon versendet. Lade ihn erneut hoch.': 'An attachment is missing or has already been sent. Upload it again.',
      'Der Browser-Stream benötigt H.264-Video und optional Opus-Audio.': 'Browser streaming requires H.264 video. Opus audio is optional.',
      'Eine SDP-Verbindungsanfrage wird erwartet.': 'An SDP connection request is required.',
      'Für diese Person gibt es schon eine Anfrage oder Verbindung.': 'A request or friendship already exists for this person.',
      'Gib einen Anzeigenamen mit bis zu 48 Zeichen ein.': 'Enter a display name of up to 48 characters.',
      'Gib einen Grund für das Löschen an.': 'Enter a reason for deleting the message.',
      'Gib einen verschlüsselten Grund für die Löschung an.': 'Enter a reason to share in the encrypted chat.',
      'Gelöschte Nachrichten können nicht verschoben werden.': 'Deleted messages cannot be moved.',
      'In diesem Thema gibt es schon einen Kanal mit diesem Namen.': 'This room already has a channel with that name.',
      'In diesem Channel läuft bereits eine Watchparty.': 'A watch party is already active in this channel.',
      'Es ist gerade kein Platz für eine weitere Watchparty frei.': 'There is no space for another watch party right now.',
      'Keine Watchparty gefunden.': 'Watch party not found.',
      'Live-Channel nicht gefunden.': 'Live channel not found.',
      'Mindestens eine Nachricht kann für dieses Mitglied nicht freigegeben werden.':
        'At least one message cannot be shared with this member.',
      'Nachricht bereits verwendet.': 'This message has already been used.',
      'Nachricht nicht gefunden.': 'Message not found.',
      'Nicht gefunden.': 'Not found.',
      'Nur der Betreiber kann Einladungen verwalten.': 'Only the site owner can manage invites.',
      'Nur der Betreiber kann Konten verwalten.': 'Only the site owner can manage accounts.',
      'Nur die Themenleitung kann Channels verwalten.': 'Managing channels requires the room owner or admin role.',
      'Nur verschlüsselte Dateien sind erlaubt.': 'Only encrypted files are allowed.',
      'Bitte melde dich an.': 'Please sign in.',
      'Bitte warte, bis der laufende Upload abgeschlossen ist.': 'Wait for the current upload to finish.',
      'Stream nicht gefunden.': 'Stream not found.',
      'Talk-Raum nicht gefunden.': 'Voice chat not found.',
      'Thema oder Channel nicht gefunden.': 'Room or channel not found.',
      'Ungültige Anhänge.': 'Invalid attachments.',
      'Ungültige Anwesenheitsabfrage.': 'Invalid presence query.',
      'Ungültige Auswahl.': 'Invalid selection.',
      'Ungültige Videodatei.': 'Invalid video file.',
      'Ungültige Videosteuerung.': 'Invalid playback action.',
      'Ungültige YouTube-Video-ID.': 'Invalid YouTube video ID.',
      'Ungültiger Videoabschnitt.': 'Invalid video segment.',
      'Ungültiger Videotitel.': 'Invalid video title.',
      'Ungültige Channel-Reihenfolge.': 'Invalid channel order.',
      'Ungültige Designeinstellung.': 'Invalid design setting.',
      'Ungültige JSON-Anfrage.': 'Invalid JSON request.',
      'Ungültige Markierungen.': 'Invalid mentions.',
      'Ungültige Nachricht.': 'Invalid message.',
      'Ungültige Position bei den Verlaufsfreigaben.': 'Invalid position in shared history.',
      'Ungültige Position bei gelöschten Nachrichten.': 'Invalid position in deleted messages.',
      'Ungültige Position bei verschobenen Nachrichten.': 'Invalid position in moved messages.',
      'Ungültige Position im Chatverlauf.': 'Invalid position in chat history.',
      'Ungültige Position im Streamchat.': 'Invalid position in stream chat.',
      'Ungültige Profileinstellung.': 'Invalid profile setting.',
      'Ungültiger Rundgangsfortschritt.': 'Invalid tutorial progress.',
      'Wähle einen anderen Text-Channel im selben Raum.': 'Choose a different text channel in the same room.',
      'Ungültige Reaktion.': 'Invalid reaction.',
      'Ungültige Talk-Verbindung.': 'Invalid voice chat connection.',
      'Ungültige Verlaufsfreigabe.': 'Invalid chat history share.',
      'Ungültige verschlüsselte Nachricht.': 'Invalid encrypted message.',
      'Ungültiger Favorit.': 'Invalid favorite.',
      'Warte einen Moment, bevor du den Sprachchat erneut betrittst.': 'Wait a moment before rejoining the voice chat.',
      'Warte einen Moment, bevor du erneut schreibst.': 'Wait a moment before sending another message.',
      'Warte einen Moment, bevor du es erneut versuchst.': 'Wait a moment and try again.',
      'Warte kurz vor einem weiteren Bild-Upload.': 'Wait a moment before uploading another image.',
      'Warte kurz vor einer weiteren Stream-Anfrage.': 'Wait a moment before setting up another stream.',
      'Warte kurz, bevor du erneut schreibst.': 'Wait a moment before sending another message.',
      'Warte, bis andere Uploads abgeschlossen sind.': 'Wait for the other uploads to finish.',
      'Warte, bis andere Downloads abgeschlossen sind.': 'Wait for the other downloads to finish.',
      'Wähle ein JPEG-, PNG- oder WebP-Bild.': 'Choose a JPEG, PNG, or WebP image.',
      'Wähle eine Bilddatei.': 'Choose an image file.',
      'Wähle ein Video im MP4- oder WebM-Format.': 'Choose an MP4 or WebM video.',
      'Wähle eine gültige Farbe.': 'Choose a valid color.',
      'Wähle eine gültige Hintergrund-Einstellung.': 'Choose a valid background setting.',
      'Zu viele gleichzeitige Wiedergaben.': 'Too many streams are playing at once.',
      'Zu viele Sprachverbindungen gleichzeitig. Versuch es gleich erneut.': 'Too many simultaneous voice connections. Try again in a moment.',
      'Zu viele Versuche. Warte bitte einen Moment.': 'Too many attempts. Wait a moment before trying again.',
    },
    patterns: [
      [/^Eine Einladung kann zwischen 1 und (\d+) Stunden gültig sein\.$/u,
        hours => `An invite can be valid for 1 to ${hours} hours.`],
      [/^Gib einen Namen mit höchstens (\d+) Zeichen ein\.$/u,
        limit => `Enter a name of up to ${limit} characters.`],
    ],
  },
}

function preferredLanguage(header) {
  let selected = defaultLocale
  let highest = 0
  if (typeof header !== 'string') return selected
  for (const choice of header.split(',')) {
    const [tag, parameter] = choice.trim().toLowerCase().split(';')
    const language = tag.trim().split('-')[0]
    const weight = parameter === undefined ? 1 : Number(parameter.trim().match(/^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u)?.[1])
    if (weight > highest && (language === sourceLocale || Object.hasOwn(catalogs, language))) {
      selected = language
      highest = weight
    }
  }
  return selected
}

export function setResponseLocale(request, response) {
  response[localeKey] = preferredLanguage(request.headers['accept-language'])
}

export function responseLocale(response) {
  return response[localeKey] ?? defaultLocale
}

function catalogMessage(message, language) {
  if (!Object.hasOwn(catalogs, language)) return undefined
  const catalog = catalogs[language]
  if (Object.hasOwn(catalog.messages, message)) return catalog.messages[message]
  for (const [pattern, format] of catalog.patterns) {
    const match = pattern.exec(message)
    if (match) return format(...match.slice(1))
  }
  return undefined
}

export function translateError(message, language) {
  if (language === sourceLocale) return catalogMessage(message, language) ?? message
  return catalogMessage(message, language) ?? catalogMessage(message, defaultLocale) ?? message
}
