# ZeloteZ Vault

[English](../vault.md) · [Deutsch](vault.md) · [简体中文](../zh-CN/vault.md) · [Dokumentation](README.md)

Vault bietet jedem Mitglied einen privaten, Ende-zu-Ende-verschlüsselten Dateispeicher mit lesenden Dateifreigaben. Die Funktion ist optional und bei neuen Instanzen ausgeschaltet. Sie nutzt die vorhandene Verschlüsselungsidentität deines Kontos; ein weiteres Cloudkonto ist nicht nötig.

## Aktivieren und Speicher festlegen

Der Betreiber öffnet **Verwaltung → ZeloteZ Vault**, bestätigt den Betreiberzugriff mit einem Authenticator-Code, aktiviert Vault und speichert das Speicherlimit. Standard sind **2 GiB pro Konto**. Das eingestellte Limit gilt für jedes Konto einzeln.

Verschlüsselte Daten, verschlüsselte Metadaten und Reservierungen unvollständiger Uploads zählen zum Limit. Verschlüsselung benötigt etwas zusätzlichen Platz. Ein kleiner Anteil technischer Schutzdaten kann nach einer Dateilöschung belegt bleiben. Beim Senken bleiben Dateien erhalten; Konten über dem Limit können weiterhin herunterladen und löschen, aber keinen weiteren Speicher belegen.

Deaktivieren sperrt Uploads, Downloads und beide Freigabearten. Fertige Dateien bleiben bis zur erneuten Aktivierung gespeichert. Unvollständige Uploads werden verworfen. Betreiber müssen ausreichend Festplattenplatz für alle Konten bereitstellen und das Anwendungsdatenvolume in die [Sicherung](operations.md) aufnehmen.

## Dateien verwalten

1. Wähle auf der Rooms-Übersicht rechts unter **Gerade live** den Zugang **ZeloteZ Vault**. Er erscheint nur bei aktivierter Funktion.
2. Erstelle Ordner, wähle **Dateien hochladen** oder ziehe Dateien in den Dateimanager. Mehrere Dateien werden nacheinander übertragen.
3. Über das Menü eines Eintrags kannst du herunterladen, umbenennen, verschieben, freigeben oder löschen. Freigaben gelten für Dateien; Ordner strukturieren deinen eigenen Speicher.
4. Nutze Pfadnavigation, Suche, Sortierung und **Mit mir geteilt**, um Dateien zu finden.

Übertragungen zeigen ihren Fortschritt und lassen sich abbrechen. Lasse die Vault-Ansicht bis zum Abschluss geöffnet; Verlassen oder Abmelden bricht laufende Arbeit ab. Unvollständige Uploads sind nicht herunterladbar. Ihre Reservierung wird beim Abbruch oder bei der Bereinigung veralteter Uploads freigegeben. Das Löschen eines Ordners löscht auch seinen Inhalt und die zugehörigen Freigaben. Eine Löschung lässt sich nicht rückgängig machen.

Downloads werden auf deinem Gerät entschlüsselt und als gewöhnliche Dateien gespeichert. Browser mit unterstützter Dateiauswahl zum Speichern können große Dateien stückweise sichern. Andere Browser unterstützen **bis zu 128 MiB pro Datei**. Nutze für größere Downloads einen kompatiblen Chromium-Browser. Eigene Dateien und Mitgliederfreigaben kannst du auch über den Desktop-Client speichern; öffentliche Links öffnen sich im Browser. Dateien werden heruntergeladen und nicht als aktive Webinhalte ausgeführt oder angezeigt.

## Eine Datei teilen

Öffne **Teilen** im Dateimenü und wähle die Gültigkeit:

- **Mitglied:** Suche ein aktives Rooms-Mitglied und wähle das richtige Konto. Der Empfänger findet die Datei unter **Mit mir geteilt** und benötigt den eigenen Kontoschlüssel zum Öffnen.
- **Link:** Erstelle einen Link für Personen ohne Rooms-Konto. Übermittle den vollständigen Link privat. Der Teil nach `#` enthält die Zugriffsberechtigung und den Entschlüsselungsschlüssel. Der Entschlüsselungsschlüssel wird nicht an den Server gesendet. Die Empfangsseite entfernt diese Geheimnisse nach dem Öffnen aus der Adresszeile.

Behandle einen vollständigen Freigabelink wie die Datei selbst: Wer ihn besitzt, kann die Datei bis zum Ablauf oder Widerruf herunterladen und weitergeben. Über die Freigabeliste kannst du einen bestehenden Link erneut anzeigen; die gespeicherte Kopie ist für dein Konto verschlüsselt.

Mit **Widerrufen** in der Freigabeliste beendest du den Zugriff. Auch das Löschen der Originaldatei beendet ihre Freigaben. Widerruf, Ablauf und Sperren des Absenders verhindern weitere Zugriffe über Rooms. Bereits erhaltene Kopien oder Schlüssel lassen sich damit nicht zurückholen. Vorhandene Freigaben behalten nach einer Umbenennung ihren verschlüsselten Namensstand.

## Optionales Kontextmenü im Dateimanager

Öffne in der Desktop-App unter Windows oder Linux den Bereich **Dateimanager-Integration**. Installation und Entfernen erfolgen ausdrücklich über die zugehörigen Buttons und eine native Bestätigung. Ein Browser allein kann kein Kontextmenü im Betriebssystem installieren.

Der Eintrag heißt **Share securely via Vault**. Unterstützt werden Windows Explorer und unter Linux automatisch erkannte Installationen von **Dateien/Nautilus, Nemo, Caja, Dolphin und Thunar**. Bei GNOME Dateien und Caja liegt der Eintrag im Untermenü **Skripte**; Windows 11 zeigt ihn gegebenenfalls unter **Weitere Optionen anzeigen**. Öffne das Dateimanager-Fenster erneut, falls das Menü noch nicht aktualisiert wurde.

Wähle eine lokale Datei oder einen Ordner und rufe den Eintrag auf. Rooms öffnet Vault, zeigt Zielinstanz und Auswahl zur Bestätigung, erstellt lokal ein ZIP und verschlüsselt es vor dem Upload stückweise. Es wird keine unverschlüsselte ZIP-Zwischendatei auf die Festplatte geschrieben. Die Originale bleiben unverändert. Nach dem Upload öffnet sich der Freigabedialog, in dem du Empfänger oder Link wählen kannst.

Ordner enthalten ihre regulären Inhalte einschließlich versteckter Dateien. Symbolische Links und Spezialdateien werden abgewiesen. Geänderte Dateien, unsichere Archivpfade und eine Auswahl über den vorgesehenen Grenzen brechen den Vorgang ab. Verändere die Auswahl bis zum Abschluss nicht.

Mit **Integration entfernen** entfernst du die verwalteten Einträge wieder. Andere eigene Aktionen bleiben erhalten. Bewahre ein Linux-AppImage am dauerhaften Ort auf. Nach Verschieben oder Update auf einen anderen Pfad installierst du die Integration erneut, um den Starter zu aktualisieren.

## Datenschutz und Wiederherstellung

Inhalte, Datei- und Ordnernamen sowie Dateitypen werden vor dem Hochladen verschlüsselt. Kontozuordnung, Größen, Zeitpunkte, Ordnerbeziehungen und Freigabebeziehungen bleiben für den Server sichtbar. Freigaben sind nur lesbar und geben keinen Zugriff auf den übrigen Vault.

Eine normale Passwortänderung erhält den Zugriff auf deine Dateien. Eine Kontowiederherstellung ohne das bisherige Verschlüsselungspasswort entschlüsselt bestehende Vault-Dateien nicht. Der Betreiber kann ihre Inhalte ohne deinen Kontoschlüssel nicht wiederherstellen. Bewahre unabhängige Kopien wichtiger Daten auf.

Nutze eine vertrauenswürdige Instanz und ein vertrauenswürdiges Gerät. Wie bei verschlüsselten Rooms-Chats liefert die Instanz die Anwendungsoberfläche aus: Ein manipulierter Client oder ein kompromittiertes Gerät kann die Verschlüsselung am Endpunkt unterlaufen. Die [Sicherheits- und Datenschutzhinweise](security.md) erklären diese Vertrauensgrenzen.
