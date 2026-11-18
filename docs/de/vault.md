# ZeloteZ Vault

[English](../vault.md) · [Deutsch](vault.md) · [简体中文](../zh-CN/vault.md) · [Dokumentation](README.md)

Vault bietet jedem Mitglied einen privaten, Ende-zu-Ende-verschlüsselten Dateispeicher mit lesenden Dateifreigaben. Die Funktion ist optional und bei neuen Instanzen ausgeschaltet. Sie nutzt die vorhandene Verschlüsselungsidentität deines Kontos; ein weiteres Cloudkonto ist nicht nötig.

## Aktivieren und Speicher festlegen

Der Betreiber öffnet **Verwaltung → ZeloteZ Vault**, bestätigt den Betreiberzugriff mit einem Authenticator-Code, aktiviert Vault und speichert das Speicherlimit. Standard sind **2 GiB pro Konto**. Das eingestellte Limit gilt für jedes Konto einzeln.

Verschlüsselte Daten, verschlüsselte Metadaten und Reservierungen unvollständiger Uploads zählen zum Limit. Verschlüsselung benötigt etwas zusätzlichen Platz. Ein kleiner Anteil technischer Schutzdaten kann nach einer Dateilöschung belegt bleiben. Beim Senken bleiben Dateien erhalten; Konten über dem Limit können weiterhin herunterladen und löschen, aber keinen weiteren Speicher belegen.

Deaktivieren sperrt Uploads, Downloads und beide Freigabearten. Fertige Dateien bleiben bis zur erneuten Aktivierung gespeichert. Unvollständige Uploads werden verworfen. Betreiber müssen ausreichend Festplattenplatz für alle Konten bereitstellen und das Anwendungsdatenvolume in die [Sicherung](operations.md) aufnehmen.

## Dateien verwalten

1. Wähle auf der Rooms-Übersicht rechts unter **Gerade live** den Zugang **ZeloteZ Vault**. Er erscheint nur bei aktivierter Funktion.
2. Wechsle über die Reiter **Mein Vault** und **Mit mir geteilt** zwischen deinen Dateien und Mitgliederfreigaben. Der Pfad im Banner zeigt deinen aktuellen Ordner; mit einem übergeordneten Ordner gehst du zurück. Bei langen Pfaden öffnet **…** die weiteren übergeordneten Ordner.
3. Erstelle Ordner, wähle **Dateien hochladen** oder ziehe Dateien in den Dateimanager. Mehrere Dateien werden nacheinander übertragen.
4. Wähle einen Dateinamen, um die lokale Vorschau, den Player oder Bearbeitungswerkzeuge zu öffnen. Das Dateimenü bietet **Abspielen** für Audio/Video und **Öffnen und bearbeiten** für bearbeitbare Formate sowie **Herunterladen**, Umbenennen, Verschieben, Teilen und Löschen. Freigaben gelten für Dateien; Ordner strukturieren deinen eigenen Speicher.
5. Suche und sortiere im aktuellen Ordner. Passen nicht alle Einträge in die Ansicht, nutze die Buttons für die vorherige und nächste Seite. Die Anzahl pro Seite passt sich dem Fenster an; Banner, Reiter und Bedienelemente bleiben ohne Scrollen der gesamten Seite erreichbar.

Laufende Übertragungen erscheinen als kompakte Benachrichtigungen mit Fortschritt und Abbrechen-Button. Abgeschlossene und abgebrochene Übertragungen melden sich als Benachrichtigung und hinterlassen keine dauerhafte Verlaufstafel. Lasse die Vault-Ansicht bis zum Abschluss geöffnet; Verlassen oder Abmelden bricht laufende Arbeit ab. Unvollständige Uploads sind nicht herunterladbar. Ihre Reservierung wird beim Abbruch oder bei der Bereinigung veralteter Uploads freigegeben. Das Löschen eines Ordners löscht auch seinen Inhalt und die zugehörigen Freigaben. Eine Löschung lässt sich nicht rückgängig machen.

Über das Zahnrad **Vault-Einstellungen** erreichst du die Datenschutzhinweise und die optionale Dateimanager-Integration der Desktop-App.

## Lokal öffnen, abspielen und bearbeiten

Wähle einen Dateinamen, **Abspielen** für Audio/Video oder **Öffnen und bearbeiten** für eine bearbeitbare Datei im Dateimenü. Die Datei wird auf deinem Gerät geprüft und entschlüsselt. Vorschau und Bearbeitung senden keinen Klartext an den Server oder einen externen Bearbeitungsdienst. HTML, SVG und Quellcode bleiben reiner Text und werden im Editor niemals ausgeführt. Öffentliche Freigabelinks bieten weiterhin Downloads; die Bearbeitungswerkzeuge gehören zum Vault angemeldeter Nutzer.

| Dateityp | Werkzeuge | Lokale Grenzen |
| --- | --- | --- |
| Bilder, darunter PNG, JPEG, WebP, GIF, BMP und AVIF | Ränder zuschneiden, drehen, horizontal oder vertikal spiegeln; als PNG, JPEG oder WebP exportieren | 128 MiB Quelldatei und höchstens 33.554.432 Bildpunkte |
| Vom Browser unterstützte Videos und Audiodateien | Lokaler Player mit Wiedergabesteuerung | 128 MiB Quelldatei; verfügbare Codecs hängen vom Browser ab |
| PDF | Einzelne Seiten ansehen, umordnen, drehen, löschen und Textnotizen platzieren | 64 MiB Quelldatei, höchstens 500 Seiten; mindestens eine Seite muss erhalten bleiben |
| UTF-8-Text, Markdown, JSON, CSV, Konfigurationsdateien und gängiger Quellcode | Text bearbeiten, Zeilenumbruch umschalten und Zeilen-/Zeichenanzahl sehen; JSON wird vor dem Speichern auf Syntaxfehler geprüft | 2 MiB UTF-8-Text |

Bildexporte sind statisch und entfernen die Metadaten des Quellbildes; aus animierten Bildern entsteht ein statisches Bild. Exportierte Bearbeitungskopien sind auf 128 MiB begrenzt.

Audio und Video öffnen sich in einem lokalen Player und werden im Vault nicht bearbeitet oder exportiert. Für die Wiedergabe muss der Browser den Codec unterstützen. Bei nicht unterstützten Codecs oder Dateien über der Player-Grenze lädst du das Original für eine passende lokale Anwendung herunter.

PDF-Vorschauen sind passiv. Gespeicherte PDF-Kopien entfernen interaktive Links, Formulare, Anhänge und eingebettete Skripte. Ergänzte Notizen werden als Bild darübergelegt; ihr Text lässt sich daher nicht markieren. Der bestehende Seiteninhalt bleibt erhalten. Die Werkzeuge dienen der Seitenverwaltung und Kommentierung, nicht der vollständigen Gestaltung eines Dokuments. Passwortgeschützte oder nicht unterstützte PDFs lassen sich möglicherweise nicht öffnen.

Bei Bildern, PDFs und Text gibst du einen Kopienamen ein und wählst **Verschlüsselte Kopie speichern**. Jeder Speichervorgang lädt eine neue, frisch verschlüsselte Datei hoch; Original und bestehende Freigaben bleiben unverändert. Die Kopie einer eigenen Datei landet im selben Ordner. Die bearbeitete Kopie einer Mitgliederfreigabe landet im Hauptordner von **Mein Vault** und gehört dir; sie ändert die Datei des Absenders nicht. Für die zusätzliche Datei muss ausreichend freier Vault-Speicher vorhanden sein. Teile die neue Kopie bei Bedarf gesondert.

Ungespeicherte Änderungen existieren nur im geöffneten Editor. Beim Schließen fragt er nach, ob du sie verwerfen möchtest. Verlassen des Vault oder Abmelden bricht die Arbeit ab und verwirft lokale Änderungen. Eine automatische Entwurfswiederherstellung gibt es nicht.

Andere Formate, darunter Office-Dokumente und Archive, kannst du speichern, teilen und für eine passende lokale Anwendung herunterladen. Für sie gibt es keine eingebauten Bearbeitungswerkzeuge.

## Dateien herunterladen

Downloads werden auf deinem Gerät entschlüsselt und als gewöhnliche Dateien gespeichert. Browser mit unterstützter Dateiauswahl zum Speichern können große Dateien stückweise sichern. Andere Browser unterstützen **bis zu 128 MiB pro Datei**. Nutze für größere Downloads einen kompatiblen Chromium-Browser. Eigene Dateien und Mitgliederfreigaben kannst du auch über den Desktop-Client speichern; öffentliche Links öffnen sich im Browser. Downloads werden nicht automatisch geöffnet. Die Bearbeitungsgrenzen oben begrenzen normale Uploads und unterstützte stückweise Downloads innerhalb deines Speicherlimits nicht.

## Gemeinsam in einem Raum abspielen

Wähle bei einer Audio- oder Videodatei in deinem eigenen Vault **In einem Raum abspielen** im Dateimenü oder Player. Unterstützt werden Dateien bis **128 MiB**. Wähle einen Raum, dem du beigetreten bist, und einen seiner Live-Kanäle. Dein Konto benötigt dort die Berechtigung, eine Wiedergabe zu starten.

- Läuft keine Watchparty, bereitest du mit **Hier gemeinsam abspielen** eine synchronisierte Watchparty vor.
- Läuft bereits eine Watchparty, wählst du **Zur Warteschlange hinzufügen**, damit deine Datei nach dem aktuellen Eintrag abgespielt wird.

Die Bestätigung erstellt eine gesonderte, widerrufbare **verschlüsselte Freigabe für 24 Stunden**. Zugriffsberechtigung und Entschlüsselungsschlüssel werden für die beim Teilen berechtigten Kanalmitglieder verschlüsselt. Sie landen weder als Chatnachricht noch in der Navigationsadresse des Raums. Der Server speichert die verschlüsselten Inhalte und die verschlüsselten Wiedergabeinformationen; den Dateischlüssel erhält er nicht.

Nach der Bestätigung öffnest du mit **Zum Raum wechseln** den gewählten Kanal und die Watchparty. Der lokale Player bleibt erhalten, bis du selbst wechselst. Mitglieder nutzen die synchronisierte Wiedergabesteuerung des Raums und müssen die Wiedergabe gegebenenfalls auf ihrem Gerät erlauben. Unterstützte Codecs hängen vom jeweiligen Browser ab.

Das Original bleibt im Vault. Das Beenden der Watchparty oder Verlassen des Raums widerruft die Freigabe **nicht automatisch**. Widerrufe sie bei Bedarf bei der Originaldatei unter **Teilen → Aktive Freigaben**; andernfalls läuft sie nach 24 Stunden ab. Bereits erhaltene Kopien und Schlüssel lassen sich wie bei anderen Freigaben nicht zurückholen. Eine geänderte Raumzugehörigkeit zieht eine bereits erhaltene Zugriffsberechtigung nicht zurück.

Eine empfangene Mitgliederfreigabe lässt sich nicht direkt in einen Raum weitergeben. Lege dafür zuerst eine eigene Datei in **Mein Vault** ab, beispielsweise indem du eine eigene Kopie herunter- und wieder hochlädst. Die Raumwiedergabe benötigt eine ausdrückliche Bestätigung; das Öffnen des privaten Players allein teilt nichts.

## Eine Datei teilen

Öffne **Teilen** im Dateimenü und wähle die Gültigkeit:

- **Mitglied:** Suche ein aktives Rooms-Mitglied und wähle das richtige Konto. Der Empfänger findet die Datei unter **Mit mir geteilt** und benötigt den eigenen Kontoschlüssel zum Öffnen.
- **Link:** Erstelle einen Link für Personen ohne Rooms-Konto. Übermittle den vollständigen Link privat. Der Teil nach `#` enthält die Zugriffsberechtigung und den Entschlüsselungsschlüssel. Der Entschlüsselungsschlüssel wird nicht an den Server gesendet. Die Empfangsseite entfernt diese Geheimnisse nach dem Öffnen aus der Adresszeile.

Behandle einen vollständigen Freigabelink wie die Datei selbst: Wer ihn besitzt, kann die Datei bis zum Ablauf oder Widerruf herunterladen und weitergeben. Über die Freigabeliste kannst du einen bestehenden Link erneut anzeigen; die gespeicherte Kopie ist für dein Konto verschlüsselt.

Mit **Widerrufen** in der Freigabeliste beendest du den Zugriff. Auch das Löschen der Originaldatei beendet ihre Freigaben. Widerruf, Ablauf und Sperren des Absenders verhindern weitere Zugriffe über Rooms. Bereits erhaltene Kopien oder Schlüssel lassen sich damit nicht zurückholen. Vorhandene Freigaben behalten nach einer Umbenennung ihren verschlüsselten Namensstand.

## Optionales Kontextmenü im Dateimanager

Öffne in der Desktop-App unter Windows oder Linux das Zahnrad **Vault-Einstellungen → Dateimanager-Integration**. Installation und Entfernen erfolgen ausdrücklich über die zugehörigen Buttons und eine native Bestätigung. Ein Browser allein kann kein Kontextmenü im Betriebssystem installieren.

Der Eintrag heißt **Share securely via Vault**. Unterstützt werden Windows Explorer und unter Linux automatisch erkannte Installationen von **Dateien/Nautilus, Nemo, Caja, Dolphin und Thunar**. Bei GNOME Dateien und Caja liegt der Eintrag im Untermenü **Skripte**; Windows 11 zeigt ihn gegebenenfalls unter **Weitere Optionen anzeigen**. Öffne das Dateimanager-Fenster erneut, falls das Menü noch nicht aktualisiert wurde.

Wähle eine lokale Datei oder einen Ordner und rufe den Eintrag auf. Rooms öffnet Vault, zeigt Zielinstanz und Auswahl zur Bestätigung, erstellt lokal ein ZIP und verschlüsselt es vor dem Upload stückweise. Es wird keine unverschlüsselte ZIP-Zwischendatei auf die Festplatte geschrieben. Die Originale bleiben unverändert. Nach dem Upload wählst du im Freigabedialog Empfänger oder Link. Ist noch ein anderer Dialog geöffnet, verweist eine Benachrichtigung stattdessen auf das Dateimenü des hochgeladenen ZIPs.

Ordner enthalten ihre regulären Inhalte einschließlich versteckter Dateien. Symbolische Links und Spezialdateien werden abgewiesen. Geänderte Dateien, unsichere Archivpfade und eine Auswahl über den vorgesehenen Grenzen brechen den Vorgang ab. Verändere die Auswahl bis zum Abschluss nicht.

Mit **Kontextmenü entfernen** entfernst du die verwalteten Einträge wieder. Andere eigene Aktionen bleiben erhalten. Bewahre ein Linux-AppImage am dauerhaften Ort auf. Nach Verschieben oder Update auf einen anderen Pfad installierst du die Integration erneut, um den Starter zu aktualisieren.

## Datenschutz und Wiederherstellung

Inhalte, Datei- und Ordnernamen sowie Dateitypen werden vor dem Hochladen verschlüsselt. Kontozuordnung, Größen, Zeitpunkte, Ordnerbeziehungen und Freigabebeziehungen bleiben für den Server sichtbar. Freigaben sind nur lesbar und geben keinen Zugriff auf den übrigen Vault.

Eine normale Passwortänderung erhält den Zugriff auf deine Dateien. Eine Kontowiederherstellung ohne das bisherige Verschlüsselungspasswort entschlüsselt bestehende Vault-Dateien nicht. Der Betreiber kann ihre Inhalte ohne deinen Kontoschlüssel nicht wiederherstellen. Bewahre unabhängige Kopien wichtiger Daten auf.

Nutze eine vertrauenswürdige Instanz und ein vertrauenswürdiges Gerät. Wie bei verschlüsselten Rooms-Chats liefert die Instanz die Anwendungsoberfläche aus: Ein manipulierter Client oder ein kompromittiertes Gerät kann die Verschlüsselung am Endpunkt unterlaufen. Die [Sicherheits- und Datenschutzhinweise](security.md) erklären diese Vertrauensgrenzen.
