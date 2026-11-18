# Fehlerbehebung

[English](../troubleshooting.md) · [Deutsch](troubleshooting.md) · [简体中文](../zh-CN/troubleshooting.md) · [Dokumentation](README.md)

Beginne beim beobachteten Symptom und folge dem verlinkten Ablauf. Die folgenden Befehle gelten für das empfohlene Einzelcontainer-Deployment. Führe sie im Hauptverzeichnis mit derselben Umgebungsdatei und demselben Compose-Projekt wie bei der Installation aus.

## Einen kleinen Diagnosestand sammeln

```sh
docker compose --env-file .env --project-directory . -f deploy/compose.image.yaml ps
docker compose --env-file .env --project-directory . -f deploy/compose.image.yaml logs --tail=100 rooms
```

Hast du ohne `.env` installiert, lasse `--env-file .env` weg. Prüfe Logs vor dem Weitergeben auf sensible Angaben.

## Installation und Start

| Symptom | Prüfungen und nächster Schritt |
| --- | --- |
| Image-Pull verweigert | Das offizielle Image ist öffentlich. Prüfe Namen und Tag in `ROOMS_IMAGE`, die Netzwerkverbindung und die Erreichbarkeit der Registry. Falls Docker veraltete GHCR-Anmeldedaten gespeichert hat, melde dich ab und versuche den Abruf erneut. Siehe [Hosting](self-hosting.md). |
| Container beendet sich mit Landlock-Fehler | Das Image benötigt Linux Landlock ABI 3 oder neuer und ein Seccomp-Profil, das die Aufrufe erlaubt. Prüfe den tatsächlichen Host- beziehungsweise VM-Kernel und die Laufzeit. Nutze eine kompatible Umgebung; schalte nicht pauschal die Isolation ab. |
| Zugriff auf `/data`, `/watch-data` oder ein Zertifikat verweigert | Das Image läuft als uid/gid 1000. Prüfe Volume-Besitzer und Leserechte dieses Benutzers. Begrenze Geheimniszugriffe, statt Daten weltweit schreibbar zu machen. Siehe [Betrieb](operations.md). |
| RTMPS-Zertifikatfehler | Bei konfiguriertem Ingest auf einer öffentlichen HTTPS-Instanz müssen `/tls/fullchain.pem` und `/tls/privkey.pem` vorhanden und lesbar sein. Prüfe Bind-Verzeichnis und Zertifikatskette. Browser-Bildschirmfreigabe allein braucht keinen öffentlichen RTMPS-Endpunkt. |
| Weboberfläche aus der Ferne nicht erreichbar | Der Webport bindet standardmäßig nur an Loopback. Verwende den eingerichteten HTTPS-Reverse-Proxy oder für Verwaltung und lokale Tests einen SSH-Tunnel. Der interne Health-Endpunkt ist keine öffentliche Statusseite. |
| Einrichtungsschlüssel abgewiesen oder Einrichtung geschlossen | Der Schlüssel muss zum Datenvolume dieser Instanz gehören. Nach Erstellung des Betreiberkontos wird die Einrichtung absichtlich geschlossen. Nutze die Betreiberwiederherstellung, statt die Datenbank zu löschen.  |

Siehe [Hosting](self-hosting.md) und [Verwaltung](administration.md).

## Konten und verschlüsselter Verlauf

| Symptom | Prüfungen und nächster Schritt |
| --- | --- |
| Anmeldung nach Domain- oder Portwechsel unmöglich | Der kanonische Origin geht in die Ableitung der Anmeldewerte ein. Prüfe die beabsichtigte Adresse und `PUBLIC_ORIGIN`. Wiederholte Adresswechsel oder Kontoresets sind kein geeigneter erster Reparaturschritt. Siehe [Sicherheit](security.md). |
| Aktion scheitert mit Herkunftsfehler | Prüfe HTTPS-Schema, Hostname und Port, den Host-Header des Reverse-Proxys und `PUBLIC_ORIGIN`. Offizieller Client und Server müssen denselben Origin nutzen. |
| Authenticator-Code abgewiesen | Prüfe die Zeitsynchronisierung von Gerät und Server und verwende einen aktuellen sechsstelligen Code. Bereits verbrauchte Codes können abgewiesen werden. Nutze gegebenenfalls einen unbenutzten Wiederherstellungscode; die Betreiberwiederherstellung ist separat beschrieben. |
| Angemeldet, Chats aber gesperrt | Verwende unter **Chats entsperren** das Passwort, das die Kontoidentität schützt. Ein wiederhergestellter Login entschlüsselt keinen vergessenen Chatschlüssel. |
| Älterer Verlauf fehlt nach Raumbeitritt | Ein berechtigtes Mitglied sollte seinen Browser öffnen und entsperren, damit er ältere Schlüssel freigibt. Der Verlauf kann warten, bis ein geeigneter Schlüsselinhaber wieder online ist. |
| Ältere Nachrichten eines temporären Raums nicht mehr lesbar | Nutze dasselbe Browserprofil mit seinem ursprünglichen lokalen Schlüssel und noch gültigem Raumzugang. Gelöschter Browserspeicher, Profilwechsel, Schlüsselablauf oder Raumende können den Zugriff verhindern. |
| Gemerkte Desktop-Anmeldung nicht verfügbar | Prüfe, ob der Betriebssystem-Schlüsselbund läuft und entsperrt ist. Manuelle Anmeldung bleibt möglich. Unter Linux wird ein Speicherersatz mit festem Schlüssel absichtlich abgewiesen. |

Lösche Browserdaten oder Volumes nicht als allgemeinen Reparaturversuch. Sie können für die Wiederherstellung nötige Daten und Schlüssel enthalten.

## Sprache, Freigabe und Wiedergabe

| Symptom | Prüfungen und nächster Schritt |
| --- | --- |
| Keine Bildschirm-/Fensterauswahl oder keine Quellen | Prüfe Browser- und Betriebssystemberechtigungen sowie das ScreenCast-Portal deiner GNOME-/KDE-Sitzung. Unter Wayland sind PipeWire und ein passendes Portal-Backend nötig. Siehe [Desktop](desktop.md). |
| Linux-Client verweigert Start wegen Sandbox | Entferne eine alte Starteroption, die die Sandbox ausschaltet, und nutze die von deiner Distribution unterstützte Richtlinie für unprivilegierte User Namespaces. Rooms benötigt die Chromium-Sandbox. |
| Schwarzes Bild oder Aufnahmeengine fehlt | Probiere **Standard**, wähle die Quelle erneut und prüfe Treiber und Portal. **Rooms Capture** ist experimentell und garantiert keine bessere Leistung auf jeder Hardware. |
| Liste für Anwendungsaudio leer | Starte die Wiedergabe in der gewünschten App und öffne die Audioauswahl erneut. Prüfe unter Linux die PipeWire-Werkzeuge; Anwendungsaudio unter Windows benötigt eine unterstützte Windows-Version. |
| Ton verschwindet nach Schließen von App oder Ausgang | Starte den Stream erneut und wähle eine verfügbare Anwendung beziehungsweise Ausgabe. Systemaudio umfasst auch andere Töne auf dieser Ausgabe. |
| Sprachchat oder direkte Wiedergabe verbindet nicht | Prüfe angekündigten `VOICE_ICE_HOST`, passende TCP-/UDP-Ports, NAT-/Firewall-Erreichbarkeit und TLS. Ein Web-Reverse-Proxy allein macht den Medienport nicht erreichbar. |
| Verzögertes Bild oder springende Datenrate | HLS puffert und kann Daten schubweise laden. Probiere direkte Wiedergabe, sofern verfügbar. Die [Streaming-Anleitung](streaming.md) erklärt die Statistiken. |
| Messwert zeigt einen Strich | Die gewählte Übertragung oder Aufnahmeengine stellt ihn möglicherweise nicht bereit. Natives RTMP und HLS liefern nicht alle WebRTC-Messwerte. Ein Strich bedeutet nicht verfügbar, nicht null Verlust. |
| YouTube pausiert oder spielt nicht | YouTube pausiert, wenn der letzte Zuschauer seinen Player schließt oder ausblendet. Prüfe außerdem Einbettbarkeit, Autoplay-Regeln und YouTube-Erreichbarkeit. |
| Videoupload abgewiesen | Prüfe MP4-/WebM-Format, 256-MiB-Grenze und Reverse-Proxy-Unterstützung für die 4-MiB-Uploadteile. Für Chat-Anhänge und Raumbilder gelten andere Grenzen. |

## Erweiterung und Desktop-Links

Erweiterung und Client müssen exakt denselben Rooms-Origin nutzen. Öffne die Desktop-App einmal und bestätige die Instanz. Unter Linux starte das ausführbare AppImage an seinem dauerhaften Ablageort, damit es den Linkhandler registrieren kann.

Wenn eine alte App `zelotez-rooms:` öffnet, wähle die aktuelle Rooms-App in den System-Linkeinstellungen. In der Erweiterung bleibt **Im Browser fortfahren** verfügbar. Temporäre Firefox-Add-ons müssen nach einem Neustart neu geladen werden. Siehe [Erweiterung](browser-extension.md).

Desktop-Updateprüfungen sind optional und fragen die offiziellen GitHub-Releases ab. Bei einer fehlgeschlagenen Prüfung kontrolliere Netzwerkzugang sowie GitHub-Verfügbarkeit und Abfragelimits. Öffne bei Bedarf die [Release-Seite](https://github.com/ZeloteZ/ZeloteZ-Rooms/releases/latest) manuell. Prüfe Desktop-Version und Serverstand getrennt.

## Einen reproduzierbaren Fehler melden

Gib Folgendes an:

- Ausgeführte Schritte, erwartetes Verhalten und genaue sichtbare Fehlermeldung.
- Image-Tag beziehungsweise Revision des Rooms-Servers, gegebenenfalls Desktop-Version und Nutzung per Browser oder App.
- Betriebssystem und Desktopsitzung, Browserversion, Aufnahmeengine und Wiedergabemodus, soweit für den Fehler relevant.
- Minimale Reproduktionsschritte und bereinigte Logzeilen rund um den Fehler.
- Ob der Fehler auch mit **Standard** oder einem anderen unterstützten Browser auftritt, soweit sinnvoll.

Entferne Cookies, Tokens, vollständige Gast-, Einladungs- und Wiederherstellungslinks, Authenticator-QR-Codes und -Geheimnisse, private Schlüssel, persönliche Chatinhalte und unbeteiligte Adressen. Sicherheitslücken gehören in den [vertraulichen Meldeweg](security.md#eine-sicherheitslücke-melden).
