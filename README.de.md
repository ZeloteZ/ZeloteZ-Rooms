# ZeloteZ Rooms

Privater Treffpunkt für deinen Freundeskreis. Räume bündeln Chat- und Live-Kanäle. Zur Registrierung braucht jede Person einen Einladungslink vom Betreiberkonto.

[English](README.md)

Englisch ist die Standardsprache. Deutsch lässt sich beim Anmelden oder im Profil auswählen. Chinesisch ist für eine spätere Übersetzung vorbereitet.

## Im Freundeskreis

- Alle Konten können **Räume** anlegen. Öffentliche Räume sind innerhalb des Freundeskreises sichtbar und können direkt betreten werden. Private Räume sind für den Ersteller und die von ihm freigegebenen Freunde sichtbar. Freundschaften erfordern eine Bestätigung.
- **Kanäle** können der Raumersteller und Raum-Admins anlegen, umsortieren und löschen. In der Raumansicht kannst du zwischen Textchats und Live-Kanälen wechseln und die letzte Aktivität sehen.
- **Aktivität** zeigt auf der Startseite Nachrichten und laufende Streams aus deinen Räumen, soweit du sie sehen darfst.
- **Chats** behalten ihren Verlauf. Du kannst Links und bis zu vier Dateien pro Nachricht teilen. Ein Anhang darf bis zu 12 MiB groß sein. Der Browser erstellt Linkkarten aus der URL lokal. Mit Enter sendest du und mit Umschalt + Enter schreibst du eine neue Zeile. Eigene Nachrichten kannst du löschen. Der Raumersteller und Raum-Admins können fremde Nachrichten mit einer Begründung löschen. Im Chat steht danach, wer die Nachricht gelöscht hat und welchen Grund diese Person angegeben hat.
- Bei **Erwähnungen** schlägt dir der Chat Personen, Räume und Channels vor, sobald du `@` tippst. Du kannst zugängliche Räume oder Channels verlinken. Persönliche Erwähnungen erscheinen in der Benachrichtigungsglocke der erwähnten Person.
- **Aussehen** umfasst Profilbild und Namensfarbe sowie Cover, Banner, Akzentfarbe, Flächenfarbe und Chat-Hintergrund eines Raums. Der Ersteller kann das Designrecht an einzelne beigetretene Mitglieder vergeben und wieder entziehen. Bilder in diesen Einstellungen sind JPEG, PNG oder WebP bis 8 MiB und werden auf dem VPS aufbereitet.
- **Live-Kanäle** zeigen Sprachchat und Streams auf einer Seite. Mit **Sprachchat beitreten** hörst du zu. Dein Mikrofon kannst du einschalten, wenn du sprechen willst. Dein Konto kann immer nur an einem Talk teilnehmen. Für einen anderen Talk öffnest du dessen Live-Kanal und wählst **Sprachchat wechseln**.
- **Bildschirmfreigabe** startest du über **Bildschirm teilen** im Live-Kanal. Im Browser wählst du einen Bildschirm, ein Fenster oder einen Tab. Ob Ton für einen Tab oder ein Fenster verfügbar ist, hängt vom Browser ab. [ZeloteZ Rooms Desktop](desktop/README.md) bietet Bildschirm-, Fenster- und Ausschnittfreigabe auf Windows und Linux. Beide Linux-Versionen können den Ton einer Anwendung oder den gesamten Ton eines Wiedergabegeräts übertragen. Die Zuschauerliste und den Streamchat findest du im Live-Kanal.
- **Talk und Wiedergabe** laufen beim Wechsel zwischen Seiten weiter. Neben deinem Profil findest du die Bedienelemente zum Verlassen des Talks, zum Beenden der Wiedergabe und den Link zurück zum jeweiligen Live-Kanal. Beim Abmelden oder Schließen des Tabs enden beide.

## Was verschlüsselt ist

Der Browser verschlüsselt Nachrichten, geteilte URLs, Dateinamen und Anhänge vor dem Upload. Eine Nachricht enthält für jedes zum Sendezeitpunkt beigetretene Mitglied einen separat verschlüsselten Nachrichtenschlüssel. Nach dem Beitritt erhält ein neues Mitglied den älteren Verlauf automatisch, sobald Browser älterer Mitglieder mit den benötigten Schlüsseln angemeldet und entsperrt sind. Diese Browser verschlüsseln zusätzliche Schlüsselkopien für das neue Konto. Verschlüsselte Nachrichten und Anhänge bleiben jeweils einmal gespeichert. Ein ausgeschiedenes Mitglied verliert den Serverzugriff. Bereits gespeicherte Kopien können bestehen bleiben.

Das Passwort entsperrt auch den privaten Schlüssel. Bei einem Passwortverlust geht der Zugriff auf verschlüsselte Nachrichten verloren. Der VPS speichert Raum- und Kanalnamen, Mitgliedschaften, Absender, Zeitpunkte und Dateigrößen als Betriebsdaten. Profil- und Designbilder sind auf dem VPS lesbar. Der Browser bezieht den Anwendungscode und öffentliche Schlüssel vom VPS. Die Verschlüsselung schützt daher gespeicherte Chatinhalte vor dem Lesen aus der Datenbank. Sie setzt einen vertrauenswürdigen Betrieb der ausgelieferten Website voraus. In der App erklärt **So funktioniert’s** den Unterschied in Alltagssprache.

Für persönliche Erwähnungen erhält der Server die IDs der erwähnten Konten sowie der Nachricht und ihres Chats. Der Nachrichtentext und die darin enthaltenen Links bleiben verschlüsselt.

Sprache und Bildschirmfreigaben aus dem Browser und der plattformübergreifenden Desktop-Version verwenden WebRTC mit Transportverschlüsselung. Die native Linux-Version streamt per RTMPS. Die Wiedergabe erfolgt per HTTPS. MediaMTX verteilt Audio und verarbeitet Video für die HLS-Wiedergabe. Der VPS zeichnet die Live-Übertragungen nicht auf. Die VPS-Uploadrate muss für alle gleichzeitigen Zuschauer und Streams ausreichen.

## Auf dem VPS betreiben

Kopiere [`.env.example`](.env.example) nach `.env` und trage die HTTPS-Adresse deiner Website als `PUBLIC_ORIGIN` sowie die RTMPS-Adresse für die Desktop-App als `STREAM_INGEST_BASE` ein. `VOICE_ICE_HOST` enthält die öffentlich erreichbare Adresse für WebRTC. Lege `fullchain.pem` und `privkey.pem` in `RTMPS_CERT_DIR` ab. Der HTTPS-Reverse-Proxy erreicht den Web-Port über Loopback und setzt `X-Real-IP` aus der eingehenden Verbindung. RTMPS nutzt standardmäßig TCP-Port 1936. Sprachchat und Bildschirmfreigaben im Browser verwenden UDP-Port 8189 und bei Bedarf TCP auf demselben Port.

Erzeuge den einmaligen Link für das Betreiberkonto.

Konten, Mitgliedschaften und verschlüsselte Inhalte liegen im Docker-Volume `community`. Beim Stoppen mit `docker compose down` bleibt dieses Volume erhalten.
