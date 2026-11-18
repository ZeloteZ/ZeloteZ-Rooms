# ZeloteZ Rooms Browser Extension

[Dokumentation](README.md) · [English](../browser-extension.md) · [简体中文](../zh-CN/browser-extension.md)

Die optionale Erweiterung ergänzt einen **Button mit dem Rooms-Logo in Graustufen** neben **Teilen** auf YouTube-Videoseiten. Sie startet eine temporäre YouTube-Watchparty auf deiner Rooms-Instanz. Sie lädt kein YouTube-Video herunter und umgeht keine Einbettungsbeschränkungen.

## Browser und Installation

Das Manifest setzt Chromium-Browser **ab Version 121** und Firefox **ab Version 140** voraus. Lade [ZeloteZ-Rooms-Browser-Extension.zip](https://github.com/ZeloteZ/ZeloteZ-Rooms/releases/latest/download/ZeloteZ-Rooms-Browser-Extension.zip) aus dem öffentlichen GitHub-Release.

| Browser | Lokale Installation |
| --- | --- |
| Chrome, Brave, Edge | ZIP entpacken, Erweiterungsverwaltung öffnen, **Entwicklermodus** einschalten, **Entpackte Erweiterung laden** wählen und Ordner mit `manifest.json` auswählen. |
| Firefox ab 140 | `about:debugging` → **Dieser Firefox** → **Temporäres Add-on laden**, dann ZIP oder entpackte `manifest.json` wählen. |

Die lokale Firefox-Installation ist temporär und muss nach einem Browserneustart erneut geladen werden. Für eine dauerhafte Installation ist ein von Mozilla signiertes Paket erforderlich; die angebotene ZIP nutzt die temporäre Installation.

Offizielle Anleitungen: [Chromium-Erweiterung laden](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-an-unpacked-extension), [temporäre Firefox-Installation](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).

## Instanz einrichten

1. Öffne die Einstellungen über das Erweiterungssymbol.
2. Gib die HTTPS-Basisadresse ein, etwa `https://rooms.example.com`, ohne Raumpfad oder Suchparameter.
3. Wähle Öffnen im Browser oder in der Desktop-App.
4. Erlaube bei Nachfrage den Zugriff auf diese Instanz.
5. Lade bereits geöffnete YouTube-Videoseiten neu.

Verbinde dich mit einer vertrauenswürdigen Instanz und melde dich regulär in Rooms an.

## Video teilen

1. Öffne eine YouTube-Videoseite.
2. Klicke auf das **Rooms-Logo in Graustufen** neben **Teilen**. Der Tooltip lautet **ZeloteZ-Raum erstellen**.
3. Prüfe **Gäste mit dem Link erlauben** und **Unter Gerade live für Mitglieder anzeigen**.
4. Wähle **Im Browser öffnen** oder **ZeloteZ Rooms Desktop**.

Beide Zugriffsoptionen sind zunächst aktiviert. Speichere andere Vorgaben in den Erweiterungseinstellungen oder ändere sie für ein einzelnes Video. [Gastzugriff und temporäre Räume](streaming.md#temporären-raum-starten)

## Im Browser öffnen

Die Erweiterung kann einen geöffneten Rooms-Tab desselben Kontos im selben Browserfenster verwenden. Ist ein neuer Tab nötig, melde dich dort gegebenenfalls an oder wähle **Chats entsperren**. Bestätige das Video anschließend in Rooms.

Die normalen Rechte und Grenzen temporärer Räume gelten weiter. Du kannst nicht zwei temporäre Räume gleichzeitig besitzen; kehre zum vorhandenen Raum zurück oder beende ihn zunächst.

## In der Desktop-App öffnen

Installiere und starte [ZeloteZ Rooms Desktop](desktop.md) einmal. App und Erweiterung müssen mit exakt derselben Rooms-Basisadresse verbunden sein.

Mache unter Linux das AppImage ausführbar und starte es am dauerhaften Speicherort, um `zelotez-rooms:` zu registrieren. Nach Verschieben oder Update starte die neue Datei erneut. Bestätige die Browsernachfrage zum Öffnen einer externen Anwendung nur bei beabsichtigter Nutzung.

Der Übergabetab schließt sich, sobald ein kompatibler Desktop-Client den Empfang bestätigt. Web/Desktop **ab 0.1.22** unterstützen die Zugriffsoptionen; automatisches Schließen per Empfangsbestätigung benötigt **ab 0.1.25**. Zeigt der Handler noch auf eine alte App, nutze **Ältere Desktop-App öffnen**, aktualisiere die Zuordnung oder wähle **Im Browser fortfahren**.

## Berechtigungen und gespeicherte Daten

Die Erweiterung benötigt `storage` und `scripting`, führt ihr Inhaltsskript auf YouTube-Seiten aus und fragt optionalen Hostzugriff für die konfigurierte Rooms-Instanz an. Adresse, Öffnungsziel und Zugriffsoptionen werden lokal gespeichert.

Beim Teilen übergibt sie die gewählte YouTube-Video-ID und Zugriffseinstellungen an Rooms. Das Firefox-Manifest deklariert **browsingActivity**, weil die aktuelle Video-ID das geteilte Video identifiziert. Die Erweiterung fordert keinen Cookiezugriff an, liest kein Kontopasswort und führt keine Datenbank deines Wiedergabeverlaufs. Anfragen innerhalb derselben Rooms-Origin verwenden die vorhandene Browsersitzung. Die Anmeldung übernimmt Rooms.

Desktop-Empfangsbestätigungen verwenden eine kurzlebige zufällige ID ohne Cookies, Kontodetails oder Video-ID. YouTube liefert seinen eingebetteten Player und Medien weiterhin direkt an Zuschauer. [Datenschutz und externe Dienste](security.md)

## Aktualisieren oder entfernen

Ersetze bei einer entpackten Chromium-Installation die Dateien durch die gewünschte Version und lade die Erweiterung in der Verwaltung neu. Lade das temporäre Firefox-Add-on bei Bedarf erneut. Aktualisiere danach YouTube-Tabs. Über die Erweiterungsverwaltung kannst du das Add-on deaktivieren oder entfernen.

Fehlt der Button oder scheitert die Übergabe, prüfe Adresse, Hostberechtigung, angemeldete/entsperrte Rooms-Sitzung und Protokollkompatibilität. [Fehlersuche](troubleshooting.md)

## Lizenz

Die Erweiterung verwendet die [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0). Bewahre beim Weitergeben einer heruntergeladenen Kopie die mitgelieferten Dateien `LICENSE` und `NOTICE` auf. Kommerzielle Nutzung außerhalb der Lizenzerlaubnisse benötigt eine separate Genehmigung; Drittanbieter-Komponenten behalten ihre eigenen Bedingungen. Siehe [Projektlizenz](../../LICENSING.md).
