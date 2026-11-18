# Dokumentation zu ZeloteZ Rooms

[English](../README.md) · [Deutsch](README.md) · [简体中文](../zh-CN/README.md) · [Projektübersicht](../../README.de.md)

Wähle die Anleitung für dein Vorhaben. Diese Seiten beschreiben den Quellstand, den du gerade liest; installierte Versionen können davon abweichen. Die deutsche und chinesische Dokumentation deckt dieselben Themen wie die englische Fassung ab.

## Rooms nutzen

| Anleitung | Inhalt |
| --- | --- |
| [Erste Schritte](getting-started.md) | Einladung annehmen, Konto erstellen, Sprache wählen und deiner Gruppe beitreten. |
| [Benutzerhandbuch](user-guide.md) | Räume, Kanäle, Freunde, verschlüsselte Nachrichten, Dateien, Moderation, Benachrichtigungen und Gestaltung. |
| [Streams und Watchpartys](streaming.md) | Bildschirm oder Video teilen, Sprachchat nutzen, Gäste einladen, Wiedergabe wählen und Statistiken verstehen. |
| [Desktop-App](desktop.md) | Installation unter Windows und Linux, Bildschirm- und Audioaufnahme, Einstellungen und Updates. |
| [YouTube-Erweiterung](browser-extension.md) | Erweiterung installieren, Zugriff einstellen und Watchpartys im Browser oder in der Desktop-App öffnen. |

Zum Erstellen eines Mitgliedskontos brauchst du eine Einladung vom Betreiber einer Rooms-Instanz. Durch die Installation des Clients entsteht weder ein Konto noch ein eigener Server.

## Eine Instanz betreiben und verwalten

| Anleitung | Inhalt |
| --- | --- |
| [Selbst hosten](self-hosting.md) | Voraussetzungen, Image beziehen, erster Start, HTTPS, Medienports und öffentliche Erreichbarkeit. |
| [Konfigurationsreferenz](configuration.md) | Compose-Variablen, Netzwerkbindungen, Speicher, Laufzeitoptionen und Komponenteneinstellungen. |
| [Verwaltung](administration.md) | Betreiber einrichten, Einladungen, Konten, MFA, Passwörter und Wiederherstellung über die Konsole. |
| [Betrieb](operations.md) | Zustand, Logs, Backups, Datenwiederherstellung, Updates und Rückkehr zu einer früheren Version. |

Beginne mit dem Einzelcontainer-Deployment der Hosting-Anleitung. Docker Desktop unter Windows oder macOS belegt für sich genommen keine Kompatibilität mit den benötigten Linux-Isolationsfunktionen.

## Sicherheit und Hilfe

| Anleitung | Inhalt |
| --- | --- |
| [Sicherheit und Datenschutz](security.md) | Verschlüsselte Inhalte, lesbare Metadaten, Vertrauensgrenzen, lokale Schlüssel und Grenzen der Wiederherstellung. |
| [Fehlerbehebung](troubleshooting.md) | Symptome, Prüfungen und Verweise auf passende Lösungswege. |

## Lizenz und Beiträge

Rooms ist unter [PolyForm Noncommercial 1.0.0](../../LICENSE) als Quellcode verfügbar. Die [Lizenzhinweise](../../LICENSING.md) erläutern den Umfang. Für Drittanbieter-Komponenten gelten deren eigene Lizenzen. Lies vor Codebeiträgen oder anderem Projektmaterial [CONTRIBUTING.md](../../CONTRIBUTING.md) und [CLA.md](../../CLA.md).

## Konventionen

- Führe Befehle im Hauptverzeichnis des Repositorys aus, sofern eine Anleitung nicht ausdrücklich das Verzeichnis wechselt.
- Ersetze Beispieldomains, Adressen, Image-Tags und Pfade durch die Werte deiner Instanz.
- Der empfohlene Compose-Dienst heißt `rooms` und stammt aus `deploy/compose.image.yaml`.
- Verwende für Verwaltungs- und Wartungsbefehle dasselbe Compose-Projekt, dieselbe Umgebungsdatei und dieselben Datenvolumes wie bei der Installation.
- Technische Dateinamen, Befehle, Umgebungsvariablen und Protokollnamen bleiben in den Übersetzungen unverändert.
