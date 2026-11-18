# ZeloteZ Vault

[English](../vault.md) · [Deutsch](vault.md) · [简体中文](../zh-CN/vault.md) · [Dokumentation](README.md)

Vault bietet jedem Mitglied einen privaten, Ende-zu-Ende-verschlüsselten Dateispeicher mit lesenden Dateifreigaben. Die Funktion ist optional und bei neuen Instanzen ausgeschaltet. Sie nutzt die vorhandene Verschlüsselungsidentität deines Kontos; ein weiteres Cloudkonto ist nicht nötig.

## Aktivieren und Speicher festlegen

Der Betreiber öffnet **Verwaltung → ZeloteZ Vault**, bestätigt den Betreiberzugriff mit einem Authenticator-Code, aktiviert Vault und speichert das Speicherlimit. Standard sind **2 GiB pro Konto**. Das eingestellte Limit gilt für jedes Konto einzeln.

Verschlüsselte Daten, verschlüsselte Metadaten und Reservierungen unvollständiger Uploads zählen zum Limit. Verschlüsselung benötigt etwas zusätzlichen Platz. Ein kleiner Anteil technischer Schutzdaten kann nach einer Dateilöschung belegt bleiben. Beim Senken bleiben Dateien erhalten; Konten über dem Limit können weiterhin herunterladen und löschen, aber keinen weiteren Speicher belegen.

Unter **Einladungen → Konten** sieht der Betreiber je Konto den belegten Speicher, das Limit und Reservierungen unvollständiger Uploads, auch bei deaktiviertem Vault. Dateinamen und Inhalte werden dabei nicht offengelegt.

Deaktivieren sperrt Uploads, Downloads und beide Freigabearten. Fertige Dateien bleiben bis zur erneuten Aktivierung gespeichert. Unvollständige Uploads werden verworfen. Betreiber müssen ausreichend Festplattenplatz für alle Konten bereitstellen und das Anwendungsdatenvolume in die [Sicherung](operations.md) aufnehmen.

## Dateien verwalten

1. Wähle auf der Rooms-Übersicht rechts unter **Gerade live** den Zugang **ZeloteZ Vault**. Er erscheint nur bei aktivierter Funktion.
2. Die erste Spalte **Dateien** enthält deine eigenen Dateien und Ordner sowie den Ordner **Mit mir geteilt**. Öffne **Mit mir geteilt → Benutzername des Absenders**, um die lesenden Freigaben dieses Mitglieds zu sehen.
3. Öffne einen Ordner, um seinen Inhalt in der nächsten Spalte zu sehen. Die Hauptspalte und höchstens eine Unterordnerspalte bleiben gleichzeitig sichtbar; in schmalen Fenstern erscheint eine einzelne Ordnerspalte. Es gibt keine horizontale Scrollleiste. Tiefere Ordner verwenden die rechte Spalte erneut. Der Pfad links in der Werkzeugleiste enthält weiterhin alle Ebenen; wähle einen übergeordneten Ordner zum Zurückgehen oder öffne über **…** die ausgeblendeten Vorfahren.
4. Wähle eine Dateizeile, um Vorschau, Player oder Archivbrowser neben den Ordnern zu öffnen. Dateien öffnen sich zuerst zur Ansicht; die Bearbeitung beginnt erst über **Zum Editor**. Die Vorschau bleibt geöffnet, während du andere Ordner durchsuchst. Mit **×** in der Vorschau schließt du die Datei.
5. Ein Rechtsklick auf eine Zeile oder ihr **⋯**-Button öffnet Aktionen wie **Öffnen**, **Herunterladen**, Umbenennen, Verschieben, Teilen und Löschen. Per Tastatur erreichst du das Menü über die Kontextmenütaste oder **Umschalt+F10**. Die verfügbaren Aktionen hängen vom Eintrag ab; empfangene Freigaben können das Original des Absenders nicht verändern.
6. Wähle **Dateien hochladen** oder **Neuer Ordner** rechts in der Werkzeugleiste direkt links neben dem Suchfeld oder ziehe lokale Dateien in einen deiner eigenen Ordner. Mehrere Dateien werden nacheinander hochgeladen. Eigene Vault-Dateien und -Ordner verschiebst du auf einen anderen eigenen Ordner oder den Hauptordner im Pfad; alternativ wählst du **Verschieben** im Dateimenü. Ein Ordner lässt sich nicht in sich selbst oder einen seiner Unterordner verschieben. **Mit mir geteilt** und die darin enthaltenen Absenderordner sind schreibgeschützt. Freigaben gelten für Dateien; Ordner strukturieren deinen eigenen Speicher.
7. Suche und sortiere im aktuellen Ordner. Lange Listen scrollen innerhalb ihrer Spalte; auch die Vorschau hat einen eigenen Scrollbereich. Banner und gesamte Seite bleiben an ihrem Platz. Ein Wechsel zwischen vorherigen und nächsten Seiten ist nicht nötig.

Der Speicherverbrauch steht mittig im Banner.

Laufende Übertragungen erscheinen als kompakte Benachrichtigungen mit Fortschritt und Abbrechen-Button. Abgeschlossene und abgebrochene Übertragungen melden sich als Benachrichtigung und hinterlassen keine dauerhafte Verlaufstafel. Lasse die Vault-Ansicht bis zum Abschluss geöffnet; Verlassen oder Abmelden bricht laufende Arbeit ab. Unvollständige Uploads sind nicht herunterladbar. Ihre Reservierung wird beim Abbruch oder bei der Bereinigung veralteter Uploads freigegeben. Das Löschen eines Ordners löscht auch seinen Inhalt und die zugehörigen Freigaben. Eine Löschung lässt sich nicht rückgängig machen.

Über das Zahnrad **Vault-Einstellungen** erreichst du die Datenschutzhinweise und die optionale Dateimanager-Integration der Desktop-App.

## Lokal öffnen, abspielen und bearbeiten

Wähle eine Dateizeile oder **Öffnen** im Dateimenü. Die Datei öffnet sich zuerst in einer schreibgeschützten Ansicht im getrennten Vorschaubereich. Bei Bildern, PDFs, Text und unterstützten Office-Dateien startest du die Bearbeitung über **Zum Editor**; mit **Zur Vorschau** kehrst du zur schreibgeschützten Ansicht zurück. Audio und Video nutzen den Player, Archive den Archivbrowser.

Die Datei wird auf deinem Gerät geprüft und entschlüsselt. Vorschau und Bearbeitung senden keinen Klartext an den Server oder einen externen Bearbeitungsdienst. HTML, SVG und Quellcode bleiben reiner Text und werden weder in der Vorschau noch im Editor ausgeführt. Öffentliche Freigabelinks bieten weiterhin Downloads; die Anzeige- und Bearbeitungswerkzeuge gehören zum Vault angemeldeter Nutzer.

| Dateityp | Werkzeuge | Lokale Grenzen |
| --- | --- | --- |
| Bilder, darunter PNG, JPEG, WebP, GIF, BMP, AVIF und geprüfte ICO-Icons | Ansehen; im Editor Bleistift, Pinsel, Radierer, Füllen, Pipette, Linien, Formen, Text, Auswahl/Zuschnitt, Größenänderung, Drehen und Spiegeln nutzen; als PNG, JPEG oder WebP exportieren | 10 GiB Quelldatei und höchstens 33.554.432 Bildpunkte |
| Videos und Audiodateien, darunter unterstützte MKV-Dateien | Lokaler Player mit Wiedergabesteuerung | 10 GiB Quelldatei; verfügbare Codecs hängen vom Browser und Betriebssystem ab |
| PDF | Durch Seiten scrollen, zoomen oder zu einer Seite springen; im Editor Seiten umordnen, drehen, löschen und Textnotizen platzieren | 64 MiB Quelldatei, höchstens 500 Seiten; mindestens eine Seite muss erhalten bleiben |
| Text, Markdown, JSON, CSV, Konfigurationsdateien und gängiger Quellcode | UTF-8-Text oder UTF-16 mit BOM bearbeiten, Zeilenumbruch umschalten und Zeilen-/Zeichenanzahl sehen; JSON wird vor dem Speichern auf Syntaxfehler geprüft | 2 MiB einschließlich Kodierung und BOM |
| DOCX-Dokumente und XLSX-Tabellen | Absätze, Tabellen und Tabellenzellen bearbeiten; eine vereinfachte DOCX- oder XLSX-Kopie speichern | 32 MiB Quelldatei; insgesamt 2 MiB Text, 20.000 Zellen, 2.000 Zeilen, 64 Spalten je Zeile und 20 Tabellenblätter |
| ZIP-, TAR-, TAR.GZ- und TGZ-Archive | Ordner durchsuchen, unterstützte enthaltene Dateien lokal öffnen, einzeln herunterladen oder als neue verschlüsselte Vault-Datei speichern | 64 MiB Quelldatei, 128 MiB entpackter Inhalt, 2.000 Einträge; höchstens 32 MiB je entpackter Datei |

Medien unterstützen Quelldateien bis **10 GiB (10.737.418.240 Bytes)**, sofern dein Vault-Speicherlimit ausreicht. Dateien werden vor dem Öffnen stückweise verifiziert und entschlüsselt; große Dateien benötigen entsprechend Vorbereitungszeit. Der Browser verwaltet die lokalen Daten und kann dafür temporäre Dateien auf deinem Gerät verwenden. Dafür müssen genügend lokaler Speicher und Browser-Kontingent verfügbar sein; auch Gerät und Decoder setzen Grenzen. Beim Schließen der Vorschau werden ihre Referenzen freigegeben; ein sicheres Löschen des temporären Browserspeichers lässt sich nicht garantieren. Der Server erhält weder Klartext noch Entschlüsselungsschlüssel. Bildmaße werden vor dem Dekodieren geprüft; die separate Auflösungsgrenze bleibt bestehen.

Für das erste Bild werden höchstens **512 MiB kodierte Bilddaten** dekodiert. Benötigt schon dieses erste Bild mehr Daten, lässt es sich nicht lokal öffnen. Kann dein Browser das jeweilige Bildformat nicht aus einem Datenstrom dekodieren, unterstützt der alternative Ladeweg Bilder bis **128 MiB**. Dateigröße und entpackte Bildpunkte sind getrennte Grenzen; die Eingabegrenze von 10 GiB garantiert nicht, dass jedes Bild auf jedem Gerät dekodierbar ist.

Der Bildeditor bietet eine Farbpalette, freie Farbwahl, Strichbreite, Zoom sowie Rückgängig/Wiederholen. Markiere einen Bereich, bevor du **Auswahl zuschneiden** wählst. Der Verlauf hält höchstens **32 Schritte innerhalb von 32 MiB**; ältere Schritte können entfallen. Ein Vorgang über diesem Budget verwirft den bisherigen Verlauf. Füllen kann vorübergehend bis zu **128 MiB Bilddaten und 4 MiB Arbeitsspeicher** benötigen; komplexe Füllungen können an einer Sicherheitsgrenze abbrechen.

Bildexporte sind statisch und entfernen die Metadaten des Quellbildes; aus animierten Bildern entsteht ein statisches Bild. Exportierte Bearbeitungskopien sind auf 128 MiB begrenzt.

Klicke in der Bildvorschau auf das Bild oder auf **Kino**, um es innerhalb von Rooms größer anzuzeigen. Auch Videos bieten im Player einen **Kinomodus**. Mit **Escape** kehrst du zur normalen Ansicht zurück.

Audio und Video öffnen sich in einem lokalen Player und werden im Vault nicht bearbeitet oder exportiert. MKV-Wiedergabe unterstützt Kombinationen wie H.264/AAC und VP9/Opus, wenn Browser und Betriebssystem die nötigen Codecs bereitstellen. Die Dateiendung MKV allein garantiert keine Wiedergabe. Bei nicht unterstützten Codecs oder Dateien über der Player-Grenze lädst du das Original für eine passende lokale Anwendung herunter.

Bei unterstützten MKV- und MP4-Dateien erscheinen **Audio** und **Untertitel**, wenn mehrere Audiospuren oder eingebettete Untertitel vorhanden sind. **Originalton (Standard)** stellt die ursprüngliche Tonwahl der Datei wieder her; **Aus** schaltet Untertitel ab. Eingebettete SRT- und einfache ASS-Texte in MKV sowie `mov_text`-Untertitel in MP4 werden als passive Textuntertitel angezeigt. ASS-Layout und Formatierung werden nicht übernommen. Bildbasierte Untertitel wie PGS sind nicht verfügbar und als Auswahl deaktiviert; lade dafür das Original für einen passenden lokalen Player herunter. Die Spuren stammen aus der lokal entschlüsselten Datei, ohne einen externen Untertiteldienst zu kontaktieren. Deine Auswahl gilt nur auf deinem Gerät, auch bei Vault-Wiedergabe in einem Raum: Jeder Zuschauer wählt unabhängig. Der gemeinsame Wiedergabestatus des Raums und die Sprachwahl anderer Zuschauer bleiben unverändert.

Für die Spurauswertung gelten eigene Sicherheitsgrenzen: **64 Spuren**, **16 MiB Metadaten** und **32 MiB lokal gelesene Dateidaten je Auswertung**. Textuntertitel sind auf **20.000 Einblendungen und 2 MiB Text** begrenzt. MKV-Untertitel werden erst beim Auswählen ihrer Spur gelesen. Werden diese Grenzen überschritten, können einzelne Untertitel oder die zusätzliche Spurauswahl fehlen, obwohl die normale Wiedergabe funktioniert. Nutze dann den Originalton oder lade die Datei für einen passenden lokalen Player herunter.

Textkopien behalten die erkannte UTF-8- oder UTF-16-LE/BE-Kodierung, die BOM und den Zeilenumbruchstil. Für die automatische Erkennung benötigt UTF-16 eine BOM. Ungültiger Unicode-Text und Binärdaten werden abgelehnt. Andere Textkodierungen musst du zunächst in einer passenden lokalen Anwendung umwandeln.

Die Office-Bearbeitung erstellt eine vereinfachte Kopie der Absätze und Tabellen eines Dokuments oder der Zellen einer Arbeitsmappe. Komplexes Layout, Bilder, Diagramme und eingebettete Objekte entfallen. Formeln werden als Text angezeigt und gespeichert, nicht berechnet. Makros oder externe Datenverbindungen werden nicht ausgeführt. Nutze das Original in einer passenden Office-Anwendung, wenn du diese Funktionen oder eine genaue Layoutübernahme brauchst. Die Grenzen für Zellen, Zeilen und Text gelten für das gesamte Dokument beziehungsweise die gesamte Arbeitsmappe. Zusätzlich sind Office-Inhalte auf 16 MiB nach dem Entpacken und 4 MiB je XML-Datei begrenzt.

Wähle im Archiv eine Datei und anschließend **Ausgewählte Datei öffnen**, **Ausgewählte Datei herunterladen** oder **In Vault speichern**. Das Öffnen einer enthaltenen Datei bleibt lokal. Mit **Zurück zum Archiv** kehrst du aus ihrer Vorschau zum Archivinhalt zurück. **In Vault speichern** erstellt eine neue Datei mit dem enthaltenen Dateinamen und frischer Verschlüsselung im Vault-Ordner des Originalarchivs. Bei einem per Mitgliederfreigabe empfangenen Archiv landet die Kopie im Hauptordner **Dateien**. Archivordner dienen der Navigation; sie werden nicht als Vault-Ordnerbaum importiert. Originalarchiv und Freigaben bleiben unverändert. Größere enthaltene Dateien bleiben sichtbar; über 32 MiB sind lokales Öffnen, Entpacken und einzelne Downloads deaktiviert. Wähle dafür **Originalarchiv herunterladen**. Die Grenze für entpackte Inhalte begrenzt auch die während eines Öffnens entpackten Daten. ZIP64, passwortgeschützte ZIPs, symbolische oder harte Links und nicht unterstützte Kompressionsverfahren benötigen eine passende lokale Anwendung. Unsichere oder beschädigte Archive werden abgelehnt.

PDF-Vorschauen sind passiv und lassen sich innerhalb des Viewers durchgehend scrollen. Nutze **Zoom**, **Breite anpassen** oder das Feld **Seite** zur Navigation. Höchstens vier Seitenvorschauen mit zusammen **48 MiPixeln** bleiben im Speicher; weitere Seiten werden beim Scrollen geladen. Gespeicherte PDF-Kopien entfernen interaktive Links, Formulare, Anhänge und eingebettete Skripte. Ergänzte Notizen werden als Bild darübergelegt; ihr Text lässt sich daher nicht markieren. Der bestehende Seiteninhalt bleibt erhalten. Die Werkzeuge dienen der Seitenverwaltung und Kommentierung, nicht der vollständigen Gestaltung eines Dokuments. Passwortgeschützte oder nicht unterstützte PDFs lassen sich möglicherweise nicht öffnen.

Bei Bildern, PDFs, Text und unterstützten Office-Dateien gibst du einen Kopienamen ein und wählst **Verschlüsselte Kopie speichern**. Jeder Speichervorgang lädt eine neue, frisch verschlüsselte Datei hoch; Original und bestehende Freigaben bleiben unverändert. Die Kopie einer eigenen Datei landet im selben Ordner. Die bearbeitete Kopie einer Mitgliederfreigabe landet im Hauptordner **Dateien** und gehört dir; sie ändert die Datei des Absenders nicht. Für die zusätzliche Datei muss ausreichend freier Vault-Speicher vorhanden sein. Teile die neue Kopie bei Bedarf gesondert.

Ungespeicherte Änderungen existieren nur im geöffneten Editor. Beim Zurückkehren zur Vorschau, Dateiwechsel, Schließen des Editors oder Verlassen des Vault wirst du gefragt, ob du sie verwerfen möchtest. Abmelden oder das Ende deiner Sitzung bricht die Arbeit sofort ab und verwirft lokale Änderungen. Eine automatische Entwurfswiederherstellung gibt es nicht.

Andere Formate kannst du weiterhin speichern, teilen und für eine passende lokale Anwendung herunterladen. Office-Formate außerhalb von DOCX und XLSX, etwa PPTX, ODT, ODS oder ältere DOC- und XLS-Dateien, haben keine eingebauten Bearbeitungswerkzeuge.

## Dateien herunterladen

Downloads werden auf deinem Gerät entschlüsselt und als gewöhnliche Dateien gespeichert. Browser mit unterstützter Dateiauswahl zum Speichern können große Dateien stückweise sichern. Andere Browser unterstützen **bis zu 128 MiB pro Datei**. Nutze für größere Downloads einen kompatiblen Chromium-Browser. Eigene Dateien und Mitgliederfreigaben kannst du auch über den Desktop-Client speichern; öffentliche Links öffnen sich im Browser. Downloads werden nicht automatisch geöffnet. Die Bearbeitungsgrenzen oben begrenzen normale Uploads und unterstützte stückweise Downloads innerhalb deines Speicherlimits nicht.

## Gemeinsam in einem Raum abspielen

Wähle bei einer Audio- oder Videodatei in deinem eigenen Vault **In einem Raum abspielen** im Dateimenü oder Player. Unterstützt werden Dateien bis **10 GiB**. Wähle einen Raum, dem du beigetreten bist, und einen seiner Live-Kanäle. Dein Konto benötigt dort die Berechtigung, eine Wiedergabe zu starten.

- Läuft keine Watchparty, bereitest du mit **Hier gemeinsam abspielen** eine synchronisierte Watchparty vor.
- Läuft bereits eine Watchparty, wählst du **Zur Warteschlange hinzufügen**, damit deine Datei nach dem aktuellen Eintrag abgespielt wird.

Die Bestätigung erstellt eine gesonderte, widerrufbare **verschlüsselte Freigabe für 24 Stunden**. Zugriffsberechtigung und Entschlüsselungsschlüssel werden für die beim Teilen berechtigten Kanalmitglieder verschlüsselt. Sie landen weder als Chatnachricht noch in der Navigationsadresse des Raums. Der Server speichert die verschlüsselten Inhalte und die verschlüsselten Wiedergabeinformationen; den Dateischlüssel erhält er nicht.

Nach der Bestätigung öffnest du mit **Zum Raum wechseln** den gewählten Kanal und die Watchparty. Der lokale Player bleibt erhalten, bis du selbst wechselst. Mitglieder nutzen die synchronisierte Wiedergabesteuerung des Raums und müssen die Wiedergabe gegebenenfalls auf ihrem Gerät erlauben. Unterstützte Codecs hängen vom jeweiligen Browser ab.

Das Original bleibt im Vault. Das Beenden der Watchparty oder Verlassen des Raums widerruft die Freigabe **nicht automatisch**. Widerrufe sie bei Bedarf bei der Originaldatei unter **Teilen → Aktive Freigaben**; andernfalls läuft sie nach 24 Stunden ab. Bereits erhaltene Kopien und Schlüssel lassen sich wie bei anderen Freigaben nicht zurückholen. Eine geänderte Raumzugehörigkeit zieht eine bereits erhaltene Zugriffsberechtigung nicht zurück.

Eine empfangene Mitgliederfreigabe lässt sich nicht direkt in einen Raum weitergeben. Lege dafür zuerst eine eigene Datei in **Dateien** ab, beispielsweise indem du eine eigene Kopie herunter- und wieder hochlädst. Die Raumwiedergabe benötigt eine ausdrückliche Bestätigung; das Öffnen des privaten Players allein teilt nichts.

## Eine Datei teilen

Öffne **Teilen** im Dateimenü und wähle die Gültigkeit:

- **Mitglied:** Suche ein aktives Rooms-Mitglied und wähle das richtige Konto. Der Empfänger findet die Datei unter **Mit mir geteilt → Benutzername des Absenders** und benötigt den eigenen Kontoschlüssel zum Öffnen.
- **Link:** Erstelle einen Link für Personen ohne Rooms-Konto. Übermittle den vollständigen Link privat. Der Teil nach `#` enthält die Zugriffsberechtigung und den Entschlüsselungsschlüssel. Der Entschlüsselungsschlüssel wird nicht an den Server gesendet. Die Empfangsseite entfernt diese Geheimnisse nach dem Öffnen aus der Adresszeile.

Behandle einen vollständigen Freigabelink wie die Datei selbst: Wer ihn besitzt, kann die Datei bis zum Ablauf oder Widerruf herunterladen und weitergeben. Über die Freigabeliste kannst du einen bestehenden Link erneut anzeigen; die gespeicherte Kopie ist für dein Konto verschlüsselt.

Mit **Widerrufen** in der Freigabeliste beendest du den Zugriff. Auch das Löschen der Originaldatei beendet ihre Freigaben. Widerruf, Ablauf und Sperren des Absenders verhindern weitere Zugriffe über Rooms. Bereits erhaltene Kopien oder Schlüssel lassen sich damit nicht zurückholen. Vorhandene Freigaben behalten nach einer Umbenennung ihren verschlüsselten Namensstand.

## Optionales Kontextmenü im Dateimanager

Öffne in der Desktop-App unter Windows oder Linux das Zahnrad **Vault-Einstellungen → Dateimanager-Integration**. Installation und Entfernen erfolgen ausdrücklich über die zugehörigen Buttons und eine native Bestätigung. Ein Browser allein kann kein Kontextmenü im Betriebssystem installieren.

Der Eintrag heißt **Share securely via Vault**. Unterstützt werden Windows Explorer und unter Linux automatisch erkannte Installationen von **Dateien/Nautilus, Nemo, Caja, Dolphin und Thunar**. Bei Nautilus und Caja erscheint die Aktion direkt im Kontextmenü der Dateiauswahl. Windows 11 zeigt sie gegebenenfalls unter **Weitere Optionen anzeigen**.

Nautilus und Caja benötigen ihre Python-Erweiterungsunterstützung: `nautilus-python` beziehungsweise `python-caja`. Die Paketnamen können je nach Distribution abweichen. Fehlt die Unterstützung, zeigt Vault die benötigte Komponente an. Installiere das entsprechende Paket deiner Distribution und starte Rooms sowie den Dateimanager neu.

Hat eine frühere Rooms-Version einen verwalteten Eintrag unter **Skripte** angelegt, wähle **Kontextmenü aktualisieren**. Dabei wird der direkte Eintrag installiert und das alte verwaltete Skript entfernt. Andere Skripte, Erweiterungen und eigene Aktionen bleiben erhalten.

Starte den Linux-Dateimanager nach dem Installieren, Aktualisieren oder Entfernen der Integration **vollständig neu**. Ein weiteres Fenster allein lädt oder entfernt die Kontextmenü-Erweiterung möglicherweise nicht.

Wähle eine oder mehrere lokale Dateien oder Ordner und rufe den Eintrag auf. Rooms öffnet Vault und lässt dich Zielinstanz und gesamte Auswahl einmal bestätigen. Jede Datei wird direkt mit ihrem Originalnamen hochgeladen. Jeder Ordner wird zu einer eigenen **Ordnername.zip**; bei einer gemischten Auswahl entsteht somit für jede Datei und jeden Ordner ein eigener Vault-Eintrag. Alle Elemente werden auf deinem Gerät vor dem Upload stückweise verschlüsselt. Ordner-ZIPs werden gestreamt, ohne eine unverschlüsselte ZIP-Zwischendatei auf die Festplatte zu schreiben. Die Originale bleiben unverändert.

Nach einem einzelnen Upload wählst du im Freigabedialog Empfänger oder Link. Ist noch ein anderer Dialog geöffnet oder wurden mehrere Elemente hochgeladen, verweist eine Benachrichtigung stattdessen auf ihre jeweiligen Dateimenüs. Jedes Element lässt sich einzeln teilen. Ein Abbruch oder späterer Fehler stoppt die verbleibenden Uploads; bereits erfolgreich hochgeladene Elemente bleiben in Vault. Ältere Desktop-Versionen müssen für diesen Auswahl-Upload aktualisiert werden.

Ordner enthalten ihre regulären Inhalte einschließlich versteckter Dateien. Symbolische Links und Spezialdateien werden abgewiesen. Geänderte Dateien, unsichere Archivpfade und eine Auswahl über den vorgesehenen Grenzen brechen den Vorgang ab. Verändere die Auswahl bis zum Abschluss nicht.

Mit **Kontextmenü entfernen** entfernst du die verwalteten Einträge wieder. Bewahre ein Linux-AppImage am dauerhaften Ort auf. Nach Verschieben oder Update auf einen anderen Pfad öffnest du das neue AppImage und wählst **Kontextmenü aktualisieren**, um den Starter zu aktualisieren. Starte anschließend den Dateimanager neu.

## Datenschutz und Wiederherstellung

Inhalte, Datei- und Ordnernamen sowie Dateitypen werden vor dem Hochladen verschlüsselt. Kontozuordnung, Größen, Zeitpunkte, Ordnerbeziehungen und Freigabebeziehungen bleiben für den Server sichtbar. Freigaben sind nur lesbar und geben keinen Zugriff auf den übrigen Vault.

Eine normale Passwortänderung erhält den Zugriff auf deine Dateien. Eine Kontowiederherstellung ohne das bisherige Verschlüsselungspasswort entschlüsselt bestehende Vault-Dateien nicht. Der Betreiber kann ihre Inhalte ohne deinen Kontoschlüssel nicht wiederherstellen. Bewahre unabhängige Kopien wichtiger Daten auf.

Nutze eine vertrauenswürdige Instanz und ein vertrauenswürdiges Gerät. Wie bei verschlüsselten Rooms-Chats liefert die Instanz die Anwendungsoberfläche aus: Ein manipulierter Client oder ein kompromittiertes Gerät kann die Verschlüsselung am Endpunkt unterlaufen. Die [Sicherheits- und Datenschutzhinweise](security.md) erklären diese Vertrauensgrenzen.
