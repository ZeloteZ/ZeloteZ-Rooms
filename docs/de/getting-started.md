# Als Mitglied starten

[Dokumentation](README.md) · [English](../getting-started.md) · [简体中文](../zh-CN/getting-started.md)

Diese Anleitung hilft beim Beitritt zu einer vorhandenen Instanz. Eine eigene Instanz richtest du mit der [Selfhosting-Anleitung](self-hosting.md) ein.

## Voraussetzungen

Du brauchst einen aktuellen Browser mit JavaScript und Web Crypto, die HTTPS-Adresse einer vertrauenswürdigen Rooms-Instanz und eine Einladung des Betreibers. Für Bildschirmfreigabe und Sprachchat sind außerdem die jeweiligen Browser- und Systemberechtigungen erforderlich. Alternativ kannst du den [Desktop-Client für Windows oder Linux](desktop.md) verwenden.

Für Rooms oder die öffentlich verfügbaren Client-Downloads ist kein GitHub-Konto nötig. Ein Rooms-Konto gehört zu genau einer Instanz und funktioniert nicht automatisch auf anderen Servern.

## Konto erstellen

1. Öffne den Einladungslink des Betreibers.
2. Wähle **English**, **Deutsch** oder **简体中文** auf der Anmeldeseite.
3. Gib einen Anzeigenamen und Benutzernamen ein. Neue Benutzernamen bestehen aus 3–32 Kleinbuchstaben, Ziffern, Unterstrichen, Punkten oder Bindestrichen; am Anfang steht ein Buchstabe oder eine Ziffer.
4. Wähle ein ungewöhnliches Passwort oder eine Passphrase mit mindestens 15 Zeichen. Der offizielle Client lehnt häufige Passwörter ab.
5. Bestätige **Konto erstellen** und bewahre Benutzername und Passwort wiederauffindbar auf.

Die normale Instanzadresse öffnet die Anmeldung, keine offene Registrierung. Ist eine Einladung abgelaufen oder schon benutzt, brauchst du einen neuen Link vom Betreiber. Ein Gastlink zu einem temporären Raum ist eine andere Zugangsart und erstellt kein Konto.

Dein Passwort schützt auch den privaten Schlüssel für verschlüsselte Chats. Anmeldung und Entsperren dieses Schlüssels sind zusammenhängende, aber getrennte Vorgänge. [Sicherheit und Datenschutz](security.md)

## Anmelden und Chats entsperren

Melde dich mit Benutzername und Passwort an derselben Instanz an. Bei aktivierter Zwei-Faktor-Anmeldung gibst du zusätzlich einen sechsstelligen Authenticator-Code oder einen unbenutzten Wiederherstellungscode ein.

Nach dem Öffnen eines weiteren Tabs oder einem Client-Neustart kann eine vorhandene Sitzung **Chats entsperren** anzeigen. Gib dein Passwort ein, um den Chatschlüssel dort zu entsperren. Eine angemeldete Sitzung allein bedeutet nicht, dass ältere verschlüsselte Nachrichten lesbar sind.

Wenn geschützter System-Anmeldespeicher verfügbar ist, kann die Desktop-App **Auf diesem Gerät angemeldet bleiben** anbieten. Dabei werden Sitzung und Entsperrmaterial bis zum Ablauf oder zur Abmeldung gespeichert. Nutze das nur auf vertrauenswürdigen Geräten. [Desktop-Anmeldespeicher](desktop.md#anmeldespeicher)

## Erster Raum und erste Unterhaltung

1. Öffne **Räume** und wähle einen für die Gruppe sichtbaren Raum oder eine private Einladung.
2. Klicke **Beitreten** oder **Einladung annehmen**, um Mitglied zu werden.
3. Öffne einen **Chat**-Channel und schreibe eine Nachricht.
4. Suche unter **Freunde** ein Mitglied und sende eine Freundschaftsanfrage. Nach der Annahme kannst du über **Nachrichten** oder den Freundeseintrag eine Direktnachricht beginnen.
5. Mit **Sprachchat betreten** hörst du in einem **Live**-Channel zunächst zu. Aktiviere das Mikrofon getrennt, wenn du sprechen möchtest.

Auf der Startseite findest du Favoriten, zuletzt besuchte Räume, Aktivitäten und laufende Übertragungen. **Für alle im Freundeskreis** bedeutet angemeldete Konten dieser Instanz, keine öffentliche Freigabe im Internet. [Räume und Channels](user-guide.md)

## Profil und Kontosicherheit

Öffne dein Profil neben Name oder Avatar. Dort änderst du Sprache, Profilbild, Namensfarbe, das Laden von Chat-Anhängen, optionale Live-Benachrichtigungen und Video-Empfangsdaten. Außerdem kannst du die Rundgänge für den ersten Besuch zurücksetzen.

Richte unter **Zwei-Faktor-Anmeldung** einen Authenticator ein: QR-Code scannen oder den manuellen Schlüssel eingeben und einen Code bestätigen. Speichere die nur dort angezeigten Wiederherstellungscodes getrennt vom Gerät; jeder gilt einmal. Authenticator und Wiederherstellungscodes lassen sich in derselben Ansicht ersetzen. Für Mitglieder ist die Funktion freiwillig, für den Betreiber Pflicht.

Nutze **Passwort ändern**, solange du das bisherige Passwort kennst. Ein normaler Wechsel erhält deinen Chatschlüssel und beendet deine anderen Sitzungen. Mindestlänge und Sperrliste häufiger Passwörter werden in den offiziellen Clients geprüft. Der Server erhält einen abgeleiteten Anmeldewert statt des ursprünglichen Passworts.

## Wenn der Zugriff verloren geht

- **Authenticator verloren:** Nutze einen unbenutzten Wiederherstellungscode. Ohne einen solchen Code wende dich an den Betreiber; es gibt keinen E-Mail-Resetdienst.
- **Passwort vergessen:** Es gibt keinen normalen E-Mail-Selbstbedienungsreset. Frage den Betreiber. Gehe nicht davon aus, dass er deinen privaten Chatschlüssel wiederherstellen oder den Verlauf entschlüsseln kann.
- **Betreiberkonto:** Konsolenwiederherstellung und Authenticator-Wechsel stehen in der [Administration](administration.md). Das Konto kann wieder zugänglich werden, während alte Chats ohne bisheriges Chatpasswort gesperrt bleiben.
- **Verlauf nach dem Beitritt fehlt:** Ein berechtigtes Mitglied sollte seinen Browser angemeldet und die Chats entsperrt lassen, damit die benötigten Verlaufsschlüssel verschlüsselt freigegeben werden können. Der Server kann diese privaten Schlüssel nicht allein liefern.

Bei Verbindungs-, Medien- oder Clientproblemen hilft die [Fehlersuche](troubleshooting.md).
