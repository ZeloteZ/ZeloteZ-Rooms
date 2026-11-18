# Räume, Chats und Freunde

[Dokumentation](README.md) · [English](../user-guide.md) · [简体中文](../zh-CN/user-guide.md)

Wenn du noch kein Konto hast, beginne mit dem [Einstieg für Mitglieder](getting-started.md). Diese Seite beschreibt dauerhafte Räume; für [temporäre Räume und Medien](streaming.md) gelten andere Zugriffs- und Aufbewahrungsregeln.

## Orientierung

**Räume** zeigt sichtbare Räume, Einladungen, Favoriten, Aktivitäten und Live-Räume. Nach dem Beitritt öffnest du die Channels eines Raums. Markiere Räume als Favoriten, um sie schnell wiederzufinden. Unter **Freunde** findest du bestätigte Freunde, eingehende und ausgehende Anfragen sowie die Mitgliedersuche. **Nachrichten** enthält Direktunterhaltungen. Die Glocke sammelt Freundschaftsanfragen, Direktnachrichten und persönliche Erwähnungen. Live-Benachrichtigungen für beigetretene Räume aktivierst du freiwillig im Profil.

Rundgänge erklären die Hauptansichten und lassen sich im Profil zurücksetzen. Englisch, Deutsch und vereinfachtes Chinesisch stehen auf der Anmeldeseite und im Profil zur Auswahl.

## Sichtbarkeit und Mitgliedschaft

Beim Erstellen eines Raums wählst du den Zugang:

| Sichtbarkeit | Wer beitreten kann |
| --- | --- |
| **Für alle im Freundeskreis** | Angemeldete Konten dieser Instanz |
| **Privat · nur auf Einladung** | In diesen Raum eingeladene Konten |

Der Ersteller kann bestätigte Freunde einzeln in einen privaten Raum einladen. Erst die Annahme macht sie zu Mitgliedern. Die Sichtbarkeit des GitHub-Repositories ändert diese Anwendungsrechte nicht.

Mitglieder ohne Erstellerrolle können einen Raum **Verlassen**. Der Ersteller verwaltet seinen Raum anstelle dieser Funktion. Ein Mitglied zu entfernen oder einen Raum zu löschen entfernt keine bereits heruntergeladenen Kopien.

## Rollen und Rechte

| Rolle oder Recht | Wichtigste Funktionen |
| --- | --- |
| Instanzbetreiber | Erstellt Kontoeinladungen und verwaltet Kontosperren und Sitzungen. Das ist eine andere Rolle als der Ersteller eines bestimmten Raums. |
| Raumersteller | Ändert Namen, Sichtbarkeit und Streaming-Regel des Raums; verwaltet Mitglieder, Admins und Designrechte; verwaltet Channels, moderiert Nachrichten und löscht den ganzen Raum. |
| Raum-Admin | Verwaltet Channels und moderiert Nachrichten dieses Raums. |
| Ausdrückliches Designrecht | Ändert Titelbild, Banner, Hintergrund und Farben. Der Ersteller besitzt dieses Recht; die Adminrolle allein gewährt es nicht. |
| Raummitglied | Liest und schreibt zugängliche Chats, nutzt Sprachchat und teilt Medien gemäß Raum- und Channel-Regeln. |

Unter **Mitglieder** kann der Ersteller Admin- und Designrechte vergeben oder entziehen. Die Streaming-Regel erlaubt alle Mitglieder, nur Ersteller und Admins oder deaktiviert Streaming im ganzen Raum. Ein Live-Channel besitzt zusätzlich die Auswahl alle Mitglieder/nur Admins; er hebt eine Einschränkung des Raums nicht auf.

## Channels

**Chat**-Channels speichern Text- und Anhangsverlauf. **Live**-Channels verbinden Sprachchat, Bildschirmstreams, Watchpartys und einen verschlüsselten Channelchat. Dieser Chat bleibt auch zwischen Übertragungen verfügbar.

Ersteller und Admins können Channels anlegen, umbenennen, sortieren und löschen. Der Typ wird beim Anlegen gewählt. Beim Löschen eines Chat-Channels verschwinden Nachrichten und Anhänge; bei einem Live-Channel enden zusätzlich laufende Medien, und sein Streamchat wird gelöscht. Das Löschen des ganzen Raums entfernt sämtliche Channels und Inhalte und beendet aktive Medien. Die Oberfläche verlangt eine Bestätigung.

## Nachrichten und Dateien

Eine Nachricht im dauerhaften Chat erlaubt bis zu **4.000 Zeichen** sowie **vier Anhänge mit jeweils bis zu 12 MiB**. Wähle die Dateien im Eingabebereich, entferne versehentlich ausgewählte und sende. Der Browser verschlüsselt Text und Dateiinhalte vor dem Hochladen.

Dateinamen, Inhalte, geteilte Links, Reaktionen und Moderationsgründe sind verschlüsselt. Mitgliedschaften, Absender, Zeitpunkte, Dateigrößen und weitere Betriebsmetadaten bleiben für den Server sichtbar. [Datenschutzmodell](security.md)

Anhänge laden normalerweise, sobald sie in den sichtbaren Bereich kommen. Im Profil wählst du manuelles Laden oder automatisches Laden nur unter einer Größenbegrenzung. Diese Einstellung steuert Download und Anzeige; sie ändert die Uploadgrenze nicht. Unterstützte Bilder, Audio- und Videodateien bieten eine Vorschau, andere bleiben herunterladbar. Bilder lassen sich vergrößert öffnen.

Speicher- und Anfragekontingente können auch kleinere Dateien oder Nachrichten ablehnen, wenn ein Konto oder die Instanz voll ist. [Grenzen und Konfiguration](configuration.md)

## Reaktionen, Erwähnungen und Antworten

- Über die Reaktionsfunktion fügst du ein Emoji hinzu oder entfernst deine Reaktion.
- Mit **@** erscheinen Vorschläge für Personen, Räume und Channels. Sie berücksichtigen zugängliche Ziele. Ein Link gewährt keinen Zutritt zu einem privaten Raum.
- Die Antwort-/Zitatfunktion verweist auf eine Nachricht. Das Zitat kann zum Original springen, solange es für dein Konto verfügbar ist.
- Lange Nachrichten lassen sich bei Bedarf ausklappen.

Persönliche Erwähnungen können eine Benachrichtigung erzeugen. Für deren Zustellung kennt Rooms die betroffenen Kontoreferenzen, obwohl der Nachrichtentext verschlüsselt bleibt.

## Löschen und Moderieren

Du kannst eigene Nachrichten löschen. Ersteller und Admins dürfen Nachrichten anderer mit einer Begründung löschen oder zwischen Textchannels desselben Raums verschieben. Die Begründung wird für berechtigte Empfänger verschlüsselt. Berechtigte Moderatoren können auch den Löschhinweis aus dem Chat entfernen.

Das Löschen entfernt die in der Anwendung gespeicherte Nachricht samt Anhängen für andere Nutzer. Bereits erstellte Screenshots, Exporte und Downloads werden dadurch nicht zurückgerufen. Beim Verschieben erhält niemand Zugriff auf einen für ihn unzugänglichen Zielchannel.

## Freunde und Direktnachrichten

Suche unter **Freunde → Suchen** ein Konto, sende eine Anfrage und nimm sie beim Empfänger an. Bestätigte Freunde können eine Direktunterhaltung mit Text, Links und Dateien öffnen. Eingehende und ausgehende Anfragen stehen getrennt.

Direktnachrichten verwenden dieselbe Verschlüsselung für Texte und Anhänge. Zum Senden braucht es eine aktive, bestätigte Freundschaft. Das Entfernen einer Freundschaft macht den Chat nicht öffentlich. Bei gesperrtem Gegenüber oder inaktiver Freundschaft ist Senden nicht verfügbar.

## Aussehen und persönliche Einstellungen

Profil- und Raumbilder akzeptieren JPEG, PNG und WebP bis **8 MiB**. Zusätzlich gibt es eingebaute Bildvorlagen. Im Profil änderst du Bild und Namensfarbe. Berechtigte Raumgestalter wählen Titelbild, Banner, Chathintergrund und Raumfarben.

Diese Bilder werden auf dem Server verarbeitet und sind nicht wie Chat-Anhänge verschlüsselt. Automatisches Laden von Anhängen, Live-Hinweise und Video-Empfangsdaten sind persönliche Kontoeinstellungen. Empfangsdaten sind zunächst deaktiviert. [Medienstatistiken verstehen](streaming.md#statistiken-verstehen)

## Verlauf und geänderter Zugriff

Nach dem Beitritt kann dein Browser verschlüsselte Kopien älterer Nachrichtenschlüssel von einem berechtigten, angemeldeten Browser mit entsperrten Chats erhalten. Sind solche Browser offline, bleibt älterer Verlauf gegebenenfalls bis zur Rückkehr unlesbar. Bewahre Passwort und Schlüssel auf: Weder eine Einladung noch eine Kontowiederherstellung rekonstruiert einen verlorenen privaten Schlüssel.

Die genauen Vertrauensgrenzen und Unterschiede zwischen dauerhaftem Chat, temporärem Chat und Medien erklärt [Sicherheit und Datenschutz](security.md).
