# Konfigurationsreferenz

[English](../configuration.md) · [Deutsch](configuration.md) · [简体中文](../zh-CN/configuration.md)

[Dokumentation](README.md) · [Selbst hosten](self-hosting.md) · [Betrieb](operations.md)

## Welche Konfiguration gilt?

Diese Referenz gilt für die empfohlene Ein-Container-Bereitstellung in `deploy/compose.image.yaml`. Variablen aus Shell oder `.env` beeinflussen den Container nur dort, wo diese Compose-Datei sie weitergibt oder interpoliert; eine beliebige Variable in `.env` wird nicht automatisch in den Container injiziert.

Führe alle Beispiele im Projektstamm aus und gib die Umgebungsdatei ausdrücklich an:

```sh
docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml config
```

Die aufgelöste Konfiguration kann private Einstellungen enthalten. Veröffentliche sie nicht ungeschwärzt in Issues. In der Shell exportierte Variablen können Werte aus `.env` überschreiben; prüfe vor Änderungen an einer bestehenden Instanz das aufgelöste Ergebnis.

## Variablen des einzelnen Images

Die Vorgaben stammen aus der mitgelieferten Image-Compose-Datei und dem Entrypoint, nicht aus `.env.example`.

| Variable | Vorgabe | Wirkung |
| --- | --- | --- |
| `ROOMS_IMAGE` | `ghcr.io/zelotez/zelotez-rooms:latest` | Container-Image. Verwende das gewünschte öffentliche Paket-Tag oder einen unveränderlichen Digest. |
| `PUBLIC_ORIGIN` | `http://127.0.0.1:${WEB_PORT:-8080}` | Kanonische Browser-Origin. Außerhalb Loopback ist HTTPS Pflicht; kein Unterpfad, Query, Fragment oder eingebettete Zugangsdaten. |
| `WEB_PORT` | `8080` | Host-TCP-Webport, in dieser Compose-Datei stets an `127.0.0.1` gebunden; im Container bleibt es Port 8080. |
| `TRUST_PROXY_IP` | `0` | Nur `1` aktiviert die Verarbeitung von `X-Real-IP` über vertrauenswürdige Proxys. Nur mit einem äußeren Proxy verwenden, der den Header überschreibt. |
| `ROOMS_TRUSTED_PROXY_IPS` | Leer | Bei aktiviertem Proxy-Vertrauen genaue, durch Kommas getrennte IPv4-/IPv6-Gegenstellen. Leer bedeutet Loopback und erkannte Docker-Bridge-Gateways. Hostnamen/CIDRs sind ungültig. |
| `VOICE_ICE_HOST` | Leer | Medienhost/IP für Clients. Leer verwendet den Hostnamen aus `PUBLIC_ORIGIN`; die Adresse muss für Medienclients direkt erreichbar sein. |
| `VOICE_ICE_IP` | `127.0.0.1` | Host-Bind-Adresse für UDP- und TCP-WebRTC-Medien. Für eine öffentliche IPv4-Instanz gewöhnlich `0.0.0.0`. |
| `VOICE_ICE_PORT` | `8189` | UDP-/TCP-WebRTC-Medienport auf Host und Container, 1 bis 65535. Änderungen passen beide Bindings und MediaMTX-Listener an. |
| `INGEST_IP` | `127.0.0.1` | Host-Bind-Adresse für RTMPS-TCP-Publishing. |
| `INGEST_PORT` | `1936` | Host-RTMPS-TCP-Port, weitergeleitet an Container-Port 1936. Trage den gewählten Host-Port auch in `STREAM_INGEST_BASE` ein. |
| `STREAM_INGEST_BASE` | Leer | Angezeigte Ingest-Basis-URL ohne Pfad. Für HTTPS-Instanzen `rtmps://host:port`; lokale HTTP-Tests dürfen Loopback-RTMP nutzen. Die API leitet bei leerem Wert eine Vorgabe ab; die tatsächliche Verfügbarkeit hängt zusätzlich von TLS und Entrypoint-Modus ab. |
| `RTMPS_CERT_DIR` | `./deploy/tls` | Nur lesbar nach `/tls` gemountetes Host-Verzeichnis, relativ zum Projektverzeichnis. RTMPS erwartet `fullchain.pem` und `privkey.pem`. |
| `ROOMS_DATA_VOLUME` | `rooms-data` | Genauer Docker-Volume-Name für `/data`. Eine Änderung verschiebt vorhandene Daten nicht. |
| `ROOMS_WATCH_VOLUME` | `rooms-watch-media` | Genauer Docker-Volume-Name für `/watch-data`. |
| `ROOMS_CPUS` | `4.0` | Container-CPU-Limit. Andere Ressourcenlimits erfordern eine Compose-Überschreibung. |

Das veröffentlichte Image konfiguriert seine privaten Kontrollendpunkte automatisch. Ergänze keine direkten Host-Portfreigaben für interne Kontrolldienste.

Der HTTPS-Modus aktiviert striktes RTMPS nur mit zwei lesbaren Zertifikatsdateien. Ein ausdrückliches `STREAM_INGEST_BASE` im HTTPS-Modus erfordert sie; andernfalls kann RTMP deaktiviert bleiben. Der lokale HTTP-Modus nutzt internes Klartext-RTMP auf 1935. Die Image-Compose-Datei veröffentlicht 1935 nicht.

## Ports und Speicher

| Endpunkt/Pfad | Zweck | Öffentliche Erreichbarkeit |
| --- | --- | --- |
| Container TCP 8080 | NGINX-Web-/API-Gateway | Host-Loopback; HTTPS-Proxy davor setzen. |
| Konfiguriertes UDP/TCP 8189 | WebRTC-Medien | Für teilnehmende Clients direkt erreichbar. |
| Container TCP 1936 | Optionaler RTMPS-Ingest | Nur für natives Publishing mit TLS öffnen. |
| `/data` | SQLite-Datenbank, Kontozustand, verschlüsselter Verlauf/Anhänge, Profil-/Raumbilder, Einrichtungszustand | Dauerhaftes Anwendungsvolume. |
| `/watch-data/watch-videos` | Temporäre Originalvideos für Watchpartys | Separates Medienvolume; Partystatus liegt im RAM und der Start entfernt verwaiste Partydateien. |
| `/tls` | Optionale RTMPS-Kette und privater Schlüssel | Nur lesbarer Bind-Mount, keine Anwendungsdaten. |

Das Dateisystem ist abgesehen von konfigurierten Volumes und `/tmp`-tmpfs nur lesbar. Logging nutzt den Docker-Treiber `local` mit bis zu drei Dateien à 20 MiB. Das einzelne Image begrenzt auf 3072 MiB RAM und 512 Prozesse; das CPU-Limit steht oben. Passe die Ressourcen über eine geprüfte Compose-Überschreibung an statt durch Änderungen an laufenden Containern.

## Anwendungslimits

Diese Grenzen sind derzeit Konstanten der Anwendung, keine Umgebungsvariablen oder Leistungszusagen. Die Speicherzählung unterscheidet sich von der Größe der SQLite-Datei, Backups und dem RAM externer Prozesse. Ein erreichtes Limit kann neue Schreibvorgänge ablehnen, obwohl der Host noch freien Speicher hat.

| Bereich | Aktuelles Limit und Geltungsbereich |
| --- | --- |
| Reguläre Räume | 200 je Instanz, davon höchstens 32 im Besitz eines Kontos. Die Zählung bei Raumerstellung schließt Direktunterhaltungen und temporäre Räume aus. |
| Raummitgliedschaften | 80 Mitgliedschaftseinträge je Raum einschließlich Raumersteller und ausstehender Einträge; nicht 80 gleichzeitig aktive Zuschauer. |
| Dauerhafte Chat-Anhänge | 4 je Nachricht; 12 MiB Klartext je Anhang (der Server erlaubt 28 zusätzliche verschlüsselte Bytes). Gespeicherte verschlüsselte Anhänge sind auf 2 GiB je Instanz und 250 MiB je hochladendem Konto begrenzt. |
| Dauerhafter Chatverlauf | Für dauerhaften regulären Kanal-/Direktchatverlauf: 300.000 Nachrichten je Instanz und 50.000 je Absender; serialisierte verschlüsselte Nachrichtenhüllen haben eigene Grenzen von 256 MiB je Instanz und 32 MiB je Absender. Das sind keine Klartextzeichen- oder vollständigen Datenbankgrößenlimits. |
| Profil-/Raumbilder | JPEG-, PNG- oder WebP-Uploads bis 8 MiB, mit einem Decoderlimit von 16 Millionen Bildpunkten. |
| Vorbereitete/aktive Bildschirmübertragungen | 8 je Instanz, höchstens eine vorbereitete oder aktive Übertragung je Konto. |
| Bestätigte Sprachteilnehmer | 16 je Livekanal, 64 je Instanz; ausstehende Beitritte haben getrennte Aushandlungslimits. |
| Watchparty-Uploads | MP4/WebM bis 256 MiB je Datei; instanzweit 512 MiB reservierter lokaler Videospeicher einschließlich wartender Uploads. Uploads verwenden 4-MiB-Stücke, laufen nach 3 Minuten ohne Uploadfortschritt ab und dürfen insgesamt höchstens 20 Minuten dauern. |
| Watchpartys und Warteschlangen | 8 aktive Kanalpartys je Instanz und bis zu 16 kommende Einträge je Party zusätzlich zum aktuellen Eintrag. |
| Temporäre Räume | 24 je Instanz und einer je Ersteller; Entwürfe verfallen nach 5 Minuten, Räume spätestens nach 12 Stunden. Eine inaktive Medienquelle kann den Raum früher beenden. |
| Temporärer Livechat | Die letzten 64 verschlüsselten Nachrichten je temporärem Raumchat, im RAM statt als dauerhafter Verlauf. |
