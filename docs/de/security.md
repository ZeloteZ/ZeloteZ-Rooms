# Sicherheit und Datenschutz

[English](../security.md) · [Deutsch](security.md) · [简体中文](../zh-CN/security.md) · [Dokumentation](README.md)

Rooms schützt unterschiedliche Daten auf unterschiedliche Weise. Diese Seite beschreibt die aktuelle Umsetzung und ihre Vertrauensgrenzen. Sie ist kein unabhängiges kryptografisches Audit und keine Prüfung eines konkreten Deployments.

## Datenschutz im Überblick

| Daten | Schutz und Sichtbarkeit |
| --- | --- |
| Texte, Links, Anhangsnamen und -inhalte, Reaktions-Emojis und Moderationsgründe in regulären Raum-, Livekanal- und Direktchats | Im Client verschlüsselt. Der Server speichert verschlüsselte Inhalte und verschlüsselte Kopien der Nachrichtenschlüssel. |
| Raum- und Kanalnamen, Mitgliedschaften, Absender, Zeitpunkte, Dateigrößen, Empfänger von Erwähnungen und Zuordnung von Reaktionen | Für den Server lesbar, um Zugriff, Zustellung und Benachrichtigungen zu verwalten. Die Inhaltsverschlüsselung verbirgt diese Metadaten nicht. |
| Profil- und Raumbilder | Werden hochgeladen und auf dem Server verarbeitet; keine Ende-zu-Ende-Verschlüsselung. |
| Sprache und Livevideo | Auf den unterstützten Transportwegen verschlüsselt und über MediaMTX weitergeleitet. Keine Ende-zu-Ende-Verschlüsselung gegenüber dem Medienserver. |
| Hochgeladene Watchparty-Videos | Vorübergehend im Original gespeichert und an berechtigte Zuschauer ausgeliefert. Sie sind nicht wie Chat-Anhänge verschlüsselt. |
| YouTube-Watchpartys | YouTube liefert eingebetteten Player und Video direkt an die Zuschauer und hat eigene Datenschutzbedingungen. |
| Chat temporärer Räume | Pro Browser verschlüsselte Nachrichten; die letzten 64 verschlüsselten Nachrichten bleiben bis zum Raumende im Arbeitsspeicher des Servers. Das ist vom dauerhaften Kanalverlauf getrennt. |

Das [Benutzerhandbuch](user-guide.md) und die [Streaming-Anleitung](streaming.md) erklären, wie du den Zugriff auf die verschiedenen Inhalte einstellst.

## Kontoschlüssel und Nachrichten

Der offizielle Client leitet getrennte Werte für Anmeldung und Entsperren des Kontoschlüssels aus dem Passwort ab. Die Ableitung ist an Benutzername und Instanz-Origin gebunden. Lege deshalb `PUBLIC_ORIGIN` vor der Kontoerstellung endgültig fest. Eine Adressänderung ist keine gewöhnliche, für Konten transparente Migration.

Jedes Konto besitzt einen öffentlichen Schlüssel und eine mit dem Passwort geschützte private Identität. Nachrichtenschlüssel werden für berechtigte Empfänger jeweils separat verschlüsselt. Bei Direktnachrichten gehören Absender und Empfänger dazu. Wenn ein Mitglied einem Raum beitritt, kann ein entsperrter Browser mit den älteren Schlüsseln automatisch verschlüsselte Kopien dieser Schlüssel freigeben.

Daraus folgt:

- Sind alle Browser mit älteren Schlüsseln offline oder gesperrt, bleibt der Verlauf möglicherweise unlesbar, bis einer zurückkehrt und entsperrt wird.
- Ein Zugriffsentzug löscht keine Nachrichten oder Schlüssel, die ein früherer Empfänger bereits erhalten oder kopiert hat.
- Langfristige Kontoschlüssel sind am Zugriff auf den Verlauf beteiligt. Setze keine Forward Secrecy und keinen automatischen Schutz alter Nachrichten nach einer Geräte- oder Schlüsselkompromittierung voraus.
- Anmelden, Chats entsperren und ein Konto wiederherstellen sind zusammenhängende, aber unterschiedliche Vorgänge.

## Die Instanz bildet eine Vertrauensgrenze

Browser erhalten Anwendungscode, öffentliche Schlüssel, Mitgliedslisten und Anweisungen zur Verlaufsfreigabe von der Instanz. Nach dem ersten Kontakt merkt sich dieser Browser Schlüssel-Fingerabdrücke in seinem Speicher; der Erstkontakt vertraut weiterhin der Instanz.

Eine bösartige oder kompromittierte Instanz könnte den ausgelieferten Clientcode verändern oder die Mitgliedschaft beziehungsweise den öffentlichen Schlüssel eines Empfängers falsch darstellen. Eine manipulierte Verlaufsfreigabe könnte einen Client zur Schlüsselfreigabe an Unberechtigte bringen. Die Ende-zu-Ende-Verschlüsselung ersetzt hier nicht das Vertrauen in Betreiber und ausgeführten Clientcode.

Verwende für entfernte Instanzen HTTPS. HTTP ist nur für lokale Loopback-Adressen zugelassen. Prüfe vor der Verbindung die Instanzadresse in Desktop-App und Erweiterung.

## Anmeldung und Wiederherstellung

Die offiziellen Clients prüfen neue Passwörter auf mindestens 15 Zeichen und eine lokale Sperrliste häufiger Passwörter. Der Server erhält einen abgeleiteten Anmeldewert und prüft dessen Format. Die Stärkeprüfung ist deshalb keine serverseitig durchgesetzte Passwortregel für beliebige Clients.

Der Betreiber muss einen zeitbasierten Authenticator einrichten. Andere Mitglieder können MFA mit einmaligen Wiederherstellungscodes aktivieren. Serverseitige Sitzungen nutzen zufällige Tokens und laufen ab. Cookies sind HTTP-only und verwenden SameSite Strict; unter HTTPS kommen Secure und das Host-Präfix hinzu.

MFA-Geheimnisse, Kontometadaten, Anmeldedaten und aktive Sitzungen sind sensible Serverdaten. Verschlüsselte Chats machen Datenbankbackups nicht zur Veröffentlichung geeignet.

Über die Konsole lässt sich der Betreiberzugang wiederherstellen und der Authenticator ersetzen. Eine private Identität mit vergessenem Chatpasswort kann die Konsole nicht entschlüsseln. Nach einer Zugangswiederherstellung können ältere Chats daher gesperrt bleiben. Die [Verwaltungsanleitung](administration.md) beschreibt die genauen Abläufe und Folgen.

## Lokaler Speicher und Geräte

Der Browser kann Material zum Entsperren von Chats im Sitzungsspeicher zwischenspeichern und beobachtete Schlüssel-Fingerabdrücke im lokalen Speicher merken. Temporäre Chats verwenden lokale Geräteschlüssel des Browsers, die normalerweise in IndexedDB liegen. Ein Verlust dieses Speichers kann ältere Gastnachrichten unlesbar machen. Die temporären Schlüssel haben eine begrenzte Lebensdauer.

Die Desktop-Option zum angemeldeten Bleiben schützt Sitzung und Chat-Entsperrmaterial über die Zugangsdatenverwaltung des Betriebssystems. Unter Linux lehnt die Implementierung Chromiums Speicherersatz mit festem Schlüssel ab. Ein gesperrter oder fehlender Schlüsselbund kann das Merken der Anmeldung verhindern; eine manuelle Anmeldung bleibt möglich.

Sperre auf gemeinsam genutzten Geräten die Betriebssystemsitzung. Abmelden und deaktiviertes Merken betreffen den lokalen Zugriff. Andere Empfänger können weiterhin eigene Kopien bereits zugestellter Inhalte haben.

## Medien und Gastlinks

MediaMTX empfängt und verteilt Sprache und Livestreams. FFmpeg passt bei Bedarf Audio an. Lokale Loopback-Tests können unverschlüsseltes HTTP/RTMP verwenden; für entfernten Zugriff gilt die dokumentierte HTTPS-/RTMPS-Konfiguration. In der mitgelieferten Konfiguration sind Aufzeichnungen deaktiviert; Betreiber oder Empfänger können Inhalte dennoch auf anderen Wegen aufzeichnen.

Gastzugänge temporärer Räume nutzen ein Geheimnis im URL-Fragment des Links, das gegen eine raumgebundene Sitzung getauscht wird. Teile den vollständigen Link nur mit vorgesehenen Gästen. Gäste können chatten und die gemeinsame Watchparty-Wiedergabe steuern. Der Gastgeber kann den Gastzugriff über die Stream-Zugriffseinstellungen widerrufen oder ersetzen. Bereits empfangene Kopien lassen sich dadurch nicht zurückholen.

Ein regulärer Raum für Mitglieder und ein temporärer Gastlink sind verschiedene Zugangswege. Ein unter Mitgliedern sichtbarer Raum ist kein anonym zugänglicher öffentlicher Raum.

## Grenzen der Deployment-Isolation

Das empfohlene Image läuft ohne Root-Rechte und beschränkt mit Landlock den Dateisystemzugriff einzelner Komponenten. Die Compose-Datei verwendet standardmäßig ein schreibgeschütztes Dateisystem, entfernte Capabilities, Ressourcenlimits und Loopback-Portbindungen. Betreiber müssen HTTPS, vertrauenswürdige Proxys, Medienerreichbarkeit, Backups und Hostsicherheit weiterhin passend konfigurieren.

Interne Medienverwaltung und Authentifizierungsendpunkte müssen privat bleiben. Vertraue weitergereichten Clientadressen nur von einem Proxy, der den eingehenden Header ersetzt. Siehe [Hosting](self-hosting.md), [Konfiguration](configuration.md) und [Betrieb](operations.md).

## Eine Sicherheitslücke melden

Veröffentliche keine Zugangsdaten, Einladungs- oder Wiederherstellungslinks, Chatinhalte oder Exploitdetails einer ungepatchten Lücke in einem öffentlichen Issue. Falls GitHub für dieses Repository vertrauliche Sicherheitsmeldungen anbietet, nutze diese Funktion. Andernfalls bitte den [Projektbetreiber](https://github.com/ZeloteZ) zunächst um einen privaten Meldeweg, ohne sensible Einzelheiten zu veröffentlichen.

Für gewöhnliche Fehler findest du in der [Fehlerbehebung](troubleshooting.md) eine Liste geeigneter, bereinigter Diagnoseangaben.
