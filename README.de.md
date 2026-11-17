<img src="desktop/portable/ui/icon.png" alt="ZeloteZ Rooms Logo" width="88" align="right">

# ZeloteZ Rooms

ZeloteZ Rooms ist ein selbst gehosteter Treffpunkt für deinen Freundeskreis. In euren Räumen könnt ihr schreiben, miteinander sprechen und euren Bildschirm teilen. Ihr nutzt Rooms im Browser oder in der Desktop-App für Windows und Linux. Neue Konten entstehen über Einladungslinks des Betreibers.

[English](README.md) · [Selbst hosten](#selbst-hosten) · [Desktop-App](desktop/README.md)

## Auf einen Blick

- **Räume für eure Themen.** Räume sind für alle Konten der Instanz sichtbar oder auf ausgewählte Freunde beschränkt. Ersteller und Raum-Admins verwalten Text- und Live-Kanäle. Der Ersteller kann den ganzen Raum löschen. Auf der Startseite findest du Favoriten, zuletzt besuchte Räume und aktuelle Aktivitäten.
- **Chats mit Verlauf.** Teile Links und bis zu vier Anhänge pro Nachricht mit jeweils bis zu 12 MiB. Ein Klick vergrößert ein Bild. Anhänge laden standardmäßig, sobald du sie im Chat erreichst. Im Profil kannst du das abschalten oder eine Größengrenze setzen. In Text- und Streamchats kannst du mit Emojis reagieren. Mit `@` erwähnst du Personen oder verlinkst Räume und Kanäle, auf die du Zugriff hast. Persönliche Erwähnungen erscheinen in der Benachrichtigungsglocke.
- **Direkt mit Freunden schreiben.** Starte einen Ende-zu-Ende-verschlüsselten Chat über **Nachrichten** oder **Freunde**. Die Glocke zeigt Direktnachrichten, Freundschaftsanfragen und Erwähnungen. Hinweise auf Live-Starts in deinen Räumen kannst du im Profil einschalten.
- **Moderation und Konten.** Du kannst eigene Nachrichten löschen. Raumersteller und Raum-Admins können Nachrichten anderer Mitglieder mit einer Begründung löschen oder zwischen den Textkanälen desselben Raums verschieben. Der Betreiber kann unter **Einladungen → Konten** Konten sperren und ihre Sitzungen samt Streams beenden.
- **Sprache und Streams.** Über **Sprachchat betreten** hörst du zunächst zu. Zum Sprechen schaltest du das Mikrofon ein und erlaubst den Zugriff. Der verschlüsselte Livechat des Kanals steht bei jeder Videoquelle und zwischen Übertragungen zur Verfügung. Beim Wechsel zwischen Seiten bleiben die Bedienelemente neben deinem Profil erreichbar. Der Player bietet direkte Wiedergabe per WebRTC und gepufferte Wiedergabe per HLS.
- **Gemeinsam Videos schauen.** Über **Video teilen** kannst du YouTube einbetten oder eine MP4- oder WebM-Datei bis 256 MiB hochladen. Wer teilen darf, kann Videos zur Warteschlange hinzufügen und entfernen. Abspielen, Pausieren und Spulen wirken für alle. Die Lautstärke stellt jede Person selbst ein. Beim Seitenwechsel wandert das Video in den Mini-Player. YouTube pausiert, sobald die letzte Person ihren Player schließt oder ausblendet.
- **Jetzt streamen.** Wähle in der Rooms-Übersicht Bildschirm, YouTube oder eine lokale Datei und nutze einen bestehenden Live-Kanal oder einen temporären Raum. Temporäre Räume können für angemeldete Mitglieder unter **Gerade live** erscheinen und einen passwortgeschützten Zuschauerlink für Gäste anbieten.
- **Ein eigener Look.** Lege Profilbild und Namensfarbe fest. Berechtigte Mitglieder können Räume mit Titelbild, Banner, Chat-Hintergrund und eigenen Farben gestalten. Für Bilder stehen Vorlagen und eigene JPEG-, PNG- und WebP-Dateien bis 8 MiB zur Auswahl.
- **Orientierung beim ersten Besuch.** Die Rundgänge erklären die wichtigsten Bedienelemente. Du kannst sie im Profil zurücksetzen. Rooms startet auf Englisch. Beim Anmelden und im Profil kannst du **Deutsch** wählen.

## So funktioniert die Verschlüsselung

**Chattexte, Links, Dateinamen, Anhänge, Reaktions-Emojis und Moderationsgründe** werden im Browser Ende-zu-Ende verschlüsselt. Jedes berechtigte Mitglied erhält eine verschlüsselte Kopie des Nachrichtenschlüssels. Wenn du einem Raum beitrittst, kann dein Browser den älteren Verlauf lesen, sobald ein angemeldeter und entsperrter Browser eines berechtigten Mitglieds die benötigten Schlüssel für dich freigibt. Der Server speichert jede Nachricht und jeden Anhang einmal. Jeder reguläre Live-Kanal speichert seinen Chatverlauf über das Ende einer Übertragung hinaus.

Der Betrieb des Dienstes erfordert lesbare Angaben wie Raum- und Kanalnamen, Mitgliedschaften, Absender, Zeitpunkte und Dateigrößen. Für Benachrichtigungen kennt der Server die Zuordnung persönlicher Erwähnungen. Er weiß, wer auf welche Nachricht reagiert hat. Profil- und Raumbilder werden auf dem Server verarbeitet.

Dein Passwort entsperrt deinen privaten Kontoschlüssel. Sobald der Schlüssel gesperrt ist, brauchst du das Passwort, um deine verschlüsselten Nachrichten wieder zu öffnen. Du vertraust dem Server dabei, dass er den richtigen App-Code, die Raummitgliedschaften und beim ersten Kontakt die öffentlichen Schlüssel liefert. Eine aktiv manipulierte Instanz könnte falsche Empfänger für die Verlaufsfreigabe melden. In der App erklärt **So funktioniert’s** diese Grenzen näher.

**Sprache und Live-Video** sind auf dem Transportweg verschlüsselt. MediaMTX empfängt und verteilt die Übertragungen. Bei Bedarf wandelt FFmpeg das Audioformat für die Wiedergabe um. Die mitgelieferte Konfiguration deaktiviert Aufzeichnungen.

In einer Watchparty liefert YouTube den eingebetteten Player und das Video direkt an die Zuschauer. Hochgeladene Videos speichert Rooms vorübergehend im Original und liefert sie nur an Zuschauer mit Kanalzugriff aus.

Über den Gastlink eines temporären Raums können Besucher zuschauen, mitchatten und bei einer Watchparty abspielen, pausieren oder spulen. Das Passwort im URL-Fragment wird gegen eine Sitzung für genau diesen Raum eingetauscht. Unter **Stream-Zugriff** lässt sich der Link widerrufen oder ersetzen.

Der temporäre Livechat verschlüsselt Nachrichten auch für eingeladene Gäste. Jeder teilnehmende Browser hält seinen privaten Schlüssel lokal. Mit demselben gültigen Zugang kann er seine letzten Nachrichten beim Zurückkehren wieder lesen, auch wenn sie während der Abwesenheit gesendet wurden. Ein neuer Browser erhält Nachrichten ab seinem Beitritt. Der Server hält die letzten 64 verschlüsselten Nachrichten bis zum Raumende im Arbeitsspeicher und sieht Absender und Zeitpunkte.

## Selbst hosten

Kopiere für die Erstinstallation [`.env.example`](.env.example) nach `.env` und passe die Werte an deine Umgebung an.

| Einstellung | Wofür sie gebraucht wird |
| --- | --- |
| `PUBLIC_ORIGIN` | Öffentliche HTTPS-Adresse der Website ohne Pfad |
| `STREAM_INGEST_BASE` | RTMPS-Adresse für native Desktop-Übertragungen ohne Pfad |
| `VOICE_ICE_HOST` | Hostname oder IP-Adresse, über die Clients den WebRTC-Dienst erreichen |
| `RTMPS_CERT_DIR` | Verzeichnis mit dem RTMPS-Zertifikat `fullchain.pem` und seinem Schlüssel `privkey.pem` |

Der Web-Port ist an Loopback gebunden. Setze davor einen HTTPS-Reverse-Proxy, der `X-Real-IP` mit der vertrauenswürdigen Client-IP überschreibt. Verwende für den RTMPS-Eingang einen eigenen TLS-Schlüssel. Gib für RTMPS standardmäßig TCP 1936 frei. WebRTC nutzt standardmäßig UDP 8189 und TCP 8189 als Ausweichweg. Die Compose-Konfiguration enthält Ressourcenlimits und Logrotation.

Wenn dein Reverse-Proxy Anfragen nach Größe begrenzt, erlaube 4 MiB je Teilstück für die Watchparty-Upload-Route `/api/channels/<id>/watch/<id>/upload`.

Starte die Dienste und erstelle den Einmal-Link für das Betreiberkonto.

Mitglieder können unter **Profil → Zwei-Faktor-Anmeldung** freiwillig einen Authenticator hinzufügen. Scanne den QR-Code und bestätige ihn mit einem sechsstelligen Code. Bewahre die einmalig angezeigten Wiederherstellungscodes getrennt vom Gerät auf. Sie können bei der Anmeldung jeweils einmal den Authenticator-Code ersetzen. Im Profil kannst du das Gerät wechseln, neue Wiederherstellungscodes erzeugen oder die freiwillige Zwei-Faktor-Anmeldung deaktivieren.

Für den Betreiber ist die Zwei-Faktor-Anmeldung Pflicht. Die erste Einrichtung und der Gerätewechsel sind per QR-Code im Profil möglich. Änderungen unter **Einladungen** und am Betreiberpasswort brauchen eine aktuelle Bestätigung per Authenticator. Wenn du den Zugriff auf den Authenticator verloren hast oder nach einem Upgrade noch keinen eingerichtet hast, öffne ein privates Serverterminal.

Scanne den QR-Code aus dem Terminal mit deiner Authenticator-App. Bei Bedarf kannst du den Schlüssel manuell als zeitbasierten Code mit sechs Stellen und 30 Sekunden Intervall hinzufügen. Der Befehl beendet bestehende Betreibersitzungen und ersetzt den bisherigen Authenticator. Melde dich erneut an und erstelle im Profil neue Wiederherstellungscodes.

Im Profil kannst du unter **Passwort ändern** dein Passwort wechseln. Rooms erhält deinen Chatschlüssel und beendet die anderen Sitzungen. Um das Betreiberkonto über die Konsole wiederherzustellen, führe `docker compose exec -T server node bootstrap.mjs --recover-owner` aus. Der Befehl beendet die Betreibersitzungen, widerruft ungenutzte Einladungen und sperrt die Anmeldung mit dem alten Passwort. Öffne den Einmal-Link aus dem Terminal innerhalb von 20 Minuten. Mit dem bisherigen Chatpasswort bleiben deine Chats zugänglich. Wenn du es verloren hast, kannst du das Konto mit gesperrten Chats wiederherstellen und sie später mit dem bisherigen Chatpasswort entsperren. Führe den Befehl erneut aus, falls der Link abläuft.

Pro Konto kann ein Stream laufen, pro Instanz bis zu acht gleichzeitig.

> [!IMPORTANT]
> Halte ein separates, wiederherstellbares Backup des Docker-Volumes `community` und deiner Instanz-Konfiguration vor. Das Volume enthält Konten, Mitgliedschaften und verschlüsselte Inhalte. Ein normales `docker compose down` erhält es.

## Desktop-App

Beim ersten Start prüfst du die HTTPS-Adresse deiner Instanz und bestätigst die Verbindung. Die Desktop-App kann Systembenachrichtigungen anzeigen und beim Schließen des Fensters im Hintergrund weiterlaufen. Im Browser wählst du beim Teilen einen Bildschirm, ein Fenster oder einen Tab. Die Desktop-App bietet zusätzlich die Auswahl eines Bildausschnitts. Audiooptionen hängen vom Betriebssystem und der Aufnahmeart ab. Die [Desktop-Anleitung](desktop/README.md) beschreibt Windows-Installer und Linux-AppImage.

Updatehinweise sind optional. In den Desktop-Einstellungen kannst du sie einschalten und das Prüfintervall festlegen. Die App liest die Versionsnummer deiner geprüften Rooms-Instanz. Den Release öffnet sie in deinem Browser auf GitHub.

Die optionale Browsererweiterung ergänzt **Create ZeloteZ Room** auf YouTube in Chromium-Browsern und Firefox. Wähle eine geprüfte Instanz und öffne das Video im Browser oder in deiner konfigurierten Desktop-App. [Anleitung zur Erweiterung](extension/README.md)

Wenn du **Auf diesem Gerät angemeldet bleiben** auswählst, schützt der sichere Systemspeicher deine Sitzung und den Chat-Entsperrschlüssel bis zur Abmeldung oder bis die Sitzung abläuft.
