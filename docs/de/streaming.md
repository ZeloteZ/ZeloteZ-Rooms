# Sprachchat, Streams und Watchpartys

[Dokumentation](README.md) · [English](../streaming.md) · [简体中文](../zh-CN/streaming.md)

Für reguläre Live-Channels brauchst du ein Konto und eine Raummitgliedschaft. Das Teilen hängt zusätzlich von den Streaming-Regeln des Raums und Channels ab. [Rollen und Rechte](user-guide.md#rollen-und-rechte)

## Medienart auswählen

| Funktion | Geeignet für | Ablauf |
| --- | --- | --- |
| Sprachchat | Gespräche während der Nutzung von Rooms | Zum Zuhören beitreten, Mikrofon getrennt aktivieren. |
| Bildschirmstream | Bildschirm, Fenster, Tab oder Desktopausschnitt zeigen | Browser oder Desktop-Client sendet Live-Medien an den Streaming-Server. |
| YouTube-Watchparty | Vorhandenes YouTube-Video gemeinsam ansehen | YouTube liefert eingebettete Player; Rooms synchronisiert die Steuerung. |
| Watchparty mit lokaler Datei | MP4 oder WebM gemeinsam ansehen | Rooms lädt das Original vorübergehend hoch und liefert es an berechtigte Zuschauer. |

Sprache und Live-Medien sind auf dem Transportweg verschlüsselt und werden von MediaMTX weitergeleitet. Sie sind nicht zwischen den Teilnehmern Ende-zu-Ende verschlüsselt. Für Chat gilt ein separates Modell. [Sicherheit und Datenschutz](security.md)

## Sprachchat betreten

1. Öffne einen Live-Channel und wähle **Sprachchat betreten**.
2. Zunächst hörst du zu. Schalte zum Sprechen das Mikrofon ein und erlaube den Zugriff im Browser/System.
3. Über die Sprachsteuerung im Kopfbereich kannst du auch beim Navigieren stummschalten, deinen Zustand ändern oder zum Channel zurückkehren.
4. Verlasse den Sprachchat nach dem Gespräch.

Eine verweigerte Mikrofonberechtigung muss das Zuhören nicht verhindern. Bei fehlendem Ton oder wiederholtem Neuverbinden prüfe Browserberechtigungen und die erreichbaren Medienports der Instanz. [Fehlersuche](troubleshooting.md)

## Im Browser teilen

1. Öffne einen Live-Channel, in dem du teilen darfst, und wähle **Bildschirm teilen**.
2. Wähle Bildschirm, Anwendungsfenster oder Browser-Tab im Browser-/Systemdialog.
3. Aktiviere eine angebotene Audiooption. Verfügbare Quellen hängen von Browser, Betriebssystem und Aufnahmequelle ab.
4. Bestätige die Freigabe. Im Live-Channel siehst du Vorschau, Zuschauer, Chat und Sendedaten.
5. Beende den Stream über Rooms oder die Freigabesteuerung des Browsers.

Lasse Quelle und Client während der Übertragung geöffnet. Ohne erforderliche Aufnahme- oder Codecunterstützung ist dieser Weg nicht verfügbar. Öffne deine Instanz für Browserfreigaben über HTTPS.

Pro Konto kann ein Stream reserviert oder aktiv sein. Die Instanz erlaubt bis zu **acht gleichzeitige Streams**. Eine verlassene Reservierung oder unterbrochene Verbindung kann einen Platz bis zur Bereinigung kurz belegen.

## Im Desktop-Client teilen

Der Desktop-Aufnahmedialog vereint Quelle, Ausschnitt, Qualität und Audio. Wähle Bildschirm, Fenster oder Region, bestätige Systemberechtigungen, lege gegebenenfalls das Rechteck in der Vorschau fest und starte.

Die native Linux-Aufnahme bietet diese Vorgaben:

| Ausgabe | Videoziel bei 30 FPS | Videoziel bei 60 FPS |
| --- | --- | --- |
| 720p | 3 Mbit/s | 4,5 Mbit/s |
| 1080p | 5 Mbit/s | 7,5 Mbit/s |
| 1440p | 8 Mbit/s | 11 Mbit/s |

Das sind Encoderziele, keine garantierten Messwerte. Plane zusätzliche Uploadkapazität für Audio und Protokollaufwand ein. Die native Linux-Pipeline kodiert mit x264 auf der CPU. Höhere Auflösung/Bildrate braucht mehr Rechenleistung und Bandbreite.

**Standard** ist die Vorgabe. **Rooms Capture** ist eine experimentelle Alternative bei verfügbarem Backend. Die Verfügbarkeit hängt vom Betriebssystem und dessen Aufnahmeunterstützung ab. Bessere Leistung als Standard ist nicht garantiert. Prüfe es mit deiner Hardware und nutze bei Problemen Standard.

Installation, plattformabhängiges Audio und native Pakete stehen im [Desktop-Handbuch](desktop.md).

## Live-Streams ansehen

Wähle die Übertragung im Live-Channel. **Direkt** verwendet WebRTC mit geringerem Zeitversatz. **Gepuffert** verwendet HLS und fügt Verzögerung hinzu; das kann bei unzuverlässiger Direktverbindung helfen. Beide Wege benötigen einen korrekt eingerichteten Streaming-Server.

Wiedergabe und Lautstärke bleiben beim Navigieren erreichbar. Mit Mini-/schwebendem Player und Seitenleistensteuerung ordnest du die Ansicht an. Deine Lautstärke beeinflusst andere Zuschauer nicht.

## Watchparty starten

Wähle **Video teilen** und gib einen YouTube-Link oder eine MP4-/WebM-Datei bis **256 MiB** an. Die Endung allein garantiert keine kompatiblen Medien: Der Server prüft den Upload, und die Browser der Zuschauer müssen die enthaltenen Codecs abspielen können.

Zum Teilen berechtigte Mitglieder können Einträge der Warteschlange hinzufügen oder entfernen. Bis zu **16 kommende Einträge** sind möglich. Abspielen, Pausieren und Spulen werden synchronisiert, die Lautstärke bleibt individuell. Uploads verwenden 4-MiB-Teilstücke; Betreiber müssen diese Anfragen durch ihren Proxy lassen.

Das Video folgt dir beim Navigieren in den Mini-Player. YouTube pausiert, sobald der letzte Zuschauer seinen Player schließt oder ausblendet. Eigene Verfügbarkeits- und Einbettungsregeln von YouTube gelten weiterhin.

Hochgeladene Watchvideos sind temporäre Originaldateien, keine verschlüsselten Chat-Anhänge. Party- und Warteschlangenzustand liegen im Arbeitsspeicher und überstehen keinen Serverneustart. Dateien werden beim Start und durch Ablauf/Bereinigung entfernt. Eine Watchparty ist kein Videoarchiv.

## Temporären Raum starten

Wähle in der Raumübersicht Bildschirm, YouTube oder lokale Datei und einen temporären Raum anstelle eines dauerhaften Live-Channels. Prüfe vor dem Teilen die Zielgruppe:

- **Gerade live für Mitglieder** bestimmt, ob angemeldete Mitglieder den Raum entdecken.
- **Gastzugriff** erstellt einen passwortgeschützten Gastlink.
- Unter **Stream-Zugriff** kann der Gastgeber die Zielgruppe ändern, den Gastlink widerrufen oder das Passwort ersetzen.

Das Geheimnis liegt im URL-Fragment des Gastlinks. Wer den vollständigen gültigen Link besitzt, kann diesen Raum nutzen. Teile ihn nur mit den vorgesehenen Zuschauern. Gäste dürfen zuschauen, temporären Livechat nutzen und Watchparty-Videos abspielen, pausieren oder spulen. Der Link erstellt kein Konto und öffnet keine anderen Bereiche der Instanz.

Du kannst einen temporären Raum besitzen. Pro Instanz gibt es bis zu **24**. Ein ungenutzter Entwurf läuft nach **fünf Minuten** ab. Ein genutzter Raum besteht höchstens **12 Stunden** und hängt zusätzlich von der aktiven Sitzung des Gastgebers ab. Der Gastgeber kann ihn früher beenden.

Temporärer Chat ist kein dauerhafter Channelverlauf. Der Server hält die letzten **64 verschlüsselten Nachrichten** bis zum Raumende im Arbeitsspeicher. Ein neuer Browser empfängt ab dem Beitritt. Ein zurückkehrender Browser mit demselben gültigen Zugang und lokalen Schlüsseln kann zuletzt empfangene Nachrichten auch aus seiner Abwesenheit wieder öffnen. [Aufbewahrung und Datenschutz](security.md)

## Statistiken verstehen

Aktiviere **Video-Empfangsdaten** im Profil für Wiedergabedauer, empfangene Auflösung, gemessene FPS, Datenrate, Paketverlust, Jitter, verworfene Frames und Codec, soweit verfügbar. Die Einstellung startet deaktiviert und wirkt sofort auf einen offenen Player. Bei Bildschirmstreams werden Sendedaten angezeigt.

- WebRTC-Messungen beschreiben die aktive Sende- oder Empfangsverbindung.
- HLS misst heruntergeladene Medienbytes; die Rate kann beim Füllen des Puffers schwanken.
- Netzwerkwerte des Senders beschreiben die Verbindung zum Streaming-Server, nicht die aller Zuschauer.
- Native RTMP- und HLS-Wege liefern nicht alle RTP-Verlust-/Jitterwerte. Fehlende Werte erscheinen als Strich.
- Eingebettete YouTube-Player liefern keine Rooms-Empfangsstatistiken.

Die Zähler helfen bei der Diagnose eines Übertragungswegs und bescheinigen nicht jedem Zuschauer dieselbe Qualität. Vergleiche sie mit [Fehlersuche](troubleshooting.md) und CPU-/Netzauslastung.
