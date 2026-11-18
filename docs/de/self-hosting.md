# Selbst hosten

[English](../self-hosting.md) · [Deutsch](self-hosting.md) · [简体中文](../zh-CN/self-hosting.md)

[Dokumentation](README.md) · [Konfiguration](configuration.md) · [Administration](administration.md) · [Betrieb](operations.md)

## Bereitstellungsart wählen

Nutze [deploy/compose.image.yaml](../../deploy/compose.image.yaml), um Rooms in einem Container mit zwei dauerhaften Volumes für Anwendungsdaten und temporäre Watchparty-Medien zu betreiben. Das offizielle Image `ghcr.io/zelotez/zelotez-rooms` ist öffentlich und unterstützt `linux/amd64` sowie `linux/arm64`; zum Herunterladen sind weder GitHub-Konto noch Registry-Anmeldung nötig.

## Voraussetzungen

- Ein Linux-Docker-Host mit Docker Engine ab 28 und Docker Compose ab 2.24.4.
- Für das einzelne Image: Linux Landlock ABI ab 3 und eine Container-Seccomp-Regelung, die die zugehörigen Systemaufrufe erlaubt. Linux 6.2 oder ein passender Backport stellt diese ABI bereit; Kernelkonfiguration und Containerregeln sind ebenfalls entscheidend. Der Start bricht ab, wenn sie fehlt. Entferne die Rollenisolation nicht, um die Prüfung zu umgehen.
- Verwende ein Image passend zur Architektur des Docker-Hosts (`linux/amd64` oder `linux/arm64`).
- Speicher für dauerhafte Anwendungsdaten, verschlüsselte Chat-Anhänge, hochgeladene Bilder und temporäre Watchparty-Videos. Der einzelne Container begrenzt standardmäßig auf 4 CPUs, 3 GiB RAM und 512 Prozesse; das sind Obergrenzen und keine gemessenen Mindestanforderungen.
- Für eine öffentliche Instanz: DNS, ein HTTPS-Reverse-Proxy und erreichbare Medienports. Docker- beziehungsweise Docker-Socket-Zugriff ist privilegierter Administrationszugriff.

## Erster Start auf dem Docker-Host

Lade die [Repository-Dateien](https://github.com/ZeloteZ/ZeloteZ-Rooms/archive/refs/heads/main.zip) herunter, entpacke sie und öffne auf dem Docker-Host den entpackten Projektstamm. Die folgenden Befehle verwenden die mitgelieferten Bereitstellungsdateien aus diesem Verzeichnis:

```sh
mkdir -p deploy/tls
```

Lege bei einer **neuen Installation** eine private `.env` mit den folgenden Werten an. Wenn bereits eine `.env` vorhanden ist, prüfe und bearbeite die gewünschten Werte, statt sie zu ersetzen. Die `.env.example` im Repository enthält Beispiele für einen öffentlichen Server; übernimm diese nicht unverändert für einen Loopback-Test.

```dotenv
ROOMS_IMAGE=ghcr.io/zelotez/zelotez-rooms:latest
PUBLIC_ORIGIN=http://127.0.0.1:8080
WEB_PORT=8080
INGEST_IP=127.0.0.1
VOICE_ICE_IP=127.0.0.1
VOICE_ICE_HOST=127.0.0.1
TRUST_PROXY_IP=0
```

```sh
chmod 600 .env
docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml config --quiet
docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml pull
docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml up -d --wait
docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml exec -T rooms node bootstrap.mjs --setup-key
```

Öffne **http://127.0.0.1:8080 auf dem Docker-Host**. Gib den Einrichtungsschlüssel ein, erstelle das Betreiberkonto und richte einen Authenticator ein, indem du den QR-Code scannst und den sechsstelligen Code bestätigst. Wenn du den Browser vor der Registrierung schließt, bleibt der Einrichtungsschlüssel verwendbar. Die Registrierung schließt die Ersteinrichtung dauerhaft. Halte den ausgegebenen Schlüssel bis dahin geheim.

Diese Loopback-Konfiguration ist für einen Browser auf demselben Host gedacht. Per SSH-Weiterleitung kannst du die Webseite privat erreichen; allein die Weiterleitung von Port 8080 transportiert jedoch keine WebRTC-Medien. Nutze für entfernte Mitglieder und den Produktivbetrieb die folgende öffentliche Konfiguration. Lege `PUBLIC_ORIGIN` vor dem Erstellen produktiver Konten fest; der Identitätsspeicher im Browser und native Clients sind mit der gewählten Origin verbunden.

## Eine HTTPS-Instanz veröffentlichen

Wähle eine kanonische Origin wie `https://rooms.example.com`, ohne Pfad, Query oder Fragment. Richte HTTPS am Reverse-Proxy ein und leite zum Loopback-Webport des Docker-Hosts weiter. Ein Reverse-Proxy in einem anderen Container besitzt eine eigene Loopback-Schnittstelle; verwende eine erreichbare Docker-Netzwerkadresse und konfiguriere die genauen vertrauenswürdigen Gegenstellen, statt den Host unter `127.0.0.1` vorauszusetzen.

Passe `.env` vor dem ersten öffentlichen Start an:

```dotenv
ROOMS_IMAGE=ghcr.io/zelotez/zelotez-rooms:latest
PUBLIC_ORIGIN=https://rooms.example.com
WEB_PORT=8080
TRUST_PROXY_IP=1
VOICE_ICE_HOST=203.0.113.10
VOICE_ICE_IP=0.0.0.0
VOICE_ICE_PORT=8189
INGEST_IP=127.0.0.1
```

Ersetze die Dokumentationsadresse `203.0.113.10` durch einen Host oder eine IP, den die Clients tatsächlich erreichen können. Bei NAT müssen der konfigurierte UDP- und TCP-Medienport zum Docker-Host weitergeleitet werden. Ein HTTP-/CDN-Proxy für die Webseite leitet diese Medienverbindungen nicht automatisch weiter.

Der Reverse-Proxy muss:

- Den öffentlichen Host erhalten und Rooms am Stamm der Origin bereitstellen, nicht unter einem URL-Unterverzeichnis.
- Bei `TRUST_PROXY_IP=1` den Header `X-Real-IP` mit der geprüften Clientadresse überschreiben; einen vom Client gelieferten Wert niemals unverändert übernehmen.
- Anwendungs-Antwortheader einschließlich `X-ZeloteZ-Rooms-Client` erhalten und fortlaufende Antworten unterstützen. Angemeldete APIs, Ereignisströme und private Medien dürfen nicht zwischengespeichert werden.
- Auf Watchparty-Upload-Routen 4 MiB große Anfragen sowie die von der Anwendung erlaubten Anhang-/Bildanfragen zulassen. Das mitgelieferte Gateway hat eigene Routenlimits; ein äußerer Proxy darf kein kleineres pauschales Limit erzwingen.
- Den Loopback-Weblistener privat halten. Öffne nur HTTPS und tatsächlich benötigte Medien-/Ingest-Ports.

Standardmäßig vertraut das einzelne Image bei aktiviertem Proxy-Modus Loopback und dem erkannten Docker-Bridge-Gateway. Trage bei einer anderen Topologie in `ROOMS_TRUSTED_PROXY_IPS` genaue, durch Kommas getrennte IP-Adressen ein; CIDR-Angaben und Hostnamen sind nicht zulässig. Siehe [Konfiguration](configuration.md).

Führe die ausdrücklichen Compose-Befehle `config`, `up` und `--setup-key` von oben erneut aus und öffne die HTTPS-Origin. HTTPS ist für nicht lokale Origins, sichere Browseraufnahme und die unterstützte Desktop-Verbindung erforderlich.

## Optionaler nativer RTMPS-Ingest

Öffentliches Teilen per Browser-WebRTC benötigt keinen öffentlich erreichbaren RTMPS-Listener. Natives RTMP-Publishing einschließlich des nativen Linux-Desktop-Helfers benötigt einen erreichbaren RTMPS-Endpunkt mit passendem gültigem Zertifikat.

Lege die vollständige Zertifikatskette unter `deploy/tls/fullchain.pem` und den privaten Schlüssel unter `deploy/tls/privkey.pem` ab. Das Image läuft als UID/GID 1000 und muss beide Dateien lesen können; verwende Eigentümer-/Gruppenrechte oder ACLs, ohne den Schlüssel weltweit lesbar zu machen. Halte das Verzeichnis aus Git heraus. Ergänze dann:

```dotenv
INGEST_IP=0.0.0.0
INGEST_PORT=1936
STREAM_INGEST_BASE=rtmps://rooms.example.com:1936
RTMPS_CERT_DIR=./deploy/tls
```

Öffne beziehungsweise leite TCP 1936 oder den gewählten Host-Ingest-Port direkt zum Docker-Host weiter. Der konfigurierte Ingest-Hostname muss zum Zertifikat passen. Ein HTTPS-Start des einzelnen Images mit ausdrücklicher Ingest-Basis scheitert, wenn nicht beide TLS-Dateien lesbar sind. Ohne Dateien und ohne ausdrückliche Ingest-Basis bleibt RTMP deaktiviert, Browserfreigabe funktioniert weiterhin. Starte beziehungsweise erstelle den Dienst nach einer Zertifikatserneuerung neu, damit MediaMTX die neuen Dateien einliest.

## Image-Version wählen oder offline übertragen

Setze `ROOMS_IMAGE` auf das gewünschte veröffentlichte Tag oder einen unveränderlichen Digest. Das offizielle Image ist ohne Anmeldung öffentlich herunterladbar. `latest` folgt der aktuellen Version; verwende für einen festen Stand einen veröffentlichten SHA-Tag oder Digest. Lade das Image mit denselben Compose-Argumenten, bevor du den Dienst neu erstellst.

Exportiere für einen Offline-Transport auf einem Rechner, auf dem das gewählte Image bereits vorhanden ist:

```sh
docker image save ghcr.io/zelotez/zelotez-rooms:latest -o rooms-image.tar
```

Übertrage das Archiv, führe auf dem Ziel `docker image load -i rooms-image.tar` aus und setze `ROOMS_IMAGE` auf das geladene Tag. Bewahre den passenden Image-Digest, die Konfiguration und Lizenzhinweise auf.

## Nächste Schritte

Erstelle über die [Administration](administration.md) Mitgliedseinladungen, lies die [Konfigurationsreferenz](configuration.md) und richte ein geprüftes [Backup- und Update-Verfahren](operations.md) ein. [Sicherheit](security.md) erklärt das Vertrauensmodell; die [Fehlerbehebung](troubleshooting.md) hilft bei Start- und Medienproblemen.
