# Betrieb, Backups und Updates

[English](../operations.md) · [Deutsch](operations.md) · [简体中文](../zh-CN/operations.md)

[Dokumentation](README.md) · [Selbst hosten](self-hosting.md) · [Konfiguration](configuration.md) · [Administration](administration.md)

Die Befehle auf dieser Seite betreffen das **einzelne Image**. Führe sie im Projektstamm mit derselben `.env`, demselben Compose-Projekt und derselben Volume-Konfiguration wie bei der Ersteinrichtung aus.

## Dienst prüfen

```sh
docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml ps
docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml logs --tail 100 rooms
docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml images
```

Der Image-Healthcheck prüft das lokale Webgateway und den Medien-Signalisierungslistener. Ein gesunder Status beweist nicht, dass externes DNS, HTTPS, NAT, Browserrechte oder Client-Medienpfade funktionieren. Prüfe nach Änderungen Anmeldung, einen Browserstream, Sprache und gegebenenfalls nativen Ingest mit einem echten Client.

Der Container verwaltet seine Kindprozesse gemeinsam: Ein unerwartetes Ende von API, Gateway oder MediaMTX beendet den Dienst; Docker wendet die Neustartregel an. Suche nach dem ersten Fehler statt nur nach der letzten Neustartmeldung. Compose begrenzt die Logaufbewahrung. Sichere relevante Logs vor der Rotation und schwärze Konto-/Linkgeheimnisse, bevor du sie teilst.

## Was bleibt und was ein Neustart beendet

- `/data` enthält `community.sqlite` mit zugehörigen SQLite-Dateien, Konto-/MFA-Zustand, verschlüsselten Verlauf und Anhänge, Profil-/Raumbilder und Einrichtungszustand. Sichere das ganze Volume, nicht nur die `.sqlite`-Datei.
- `/watch-data` enthält temporär hochgeladene Watchparty-Videos. Der Partystatus liegt im RAM; der Start entfernt verwaiste Party-Videodateien. Dieses Volume ist keine dauerhafte Videobibliothek.
- Aktive Streams, Sprachverbindungen, Watchparty-Wiedergabe/-Warteschlangen und temporäre Livechat-Nachrichten können beim Neustart enden. Temporäre Raumdatensätze verweisen auf aktive Medien und werden entfernt, wenn deren Quelle nicht mehr aktiv ist; sie sind keine dauerhaft gespeicherten Räume. Informiere aktive Mitglieder vor Wartung.
- `.env`, Compose-Überschreibungen, optionale TLS-Dateien, Reverse-Proxy-Konfiguration und gewähltes Image-Tag/Digest liegen außerhalb dieser Volumes und müssen separat aufbewahrt werden.

Ein normales Compose `down` erhält benannte Volumes; geänderte Volume-Namen oder ein anderes Projekt können trotzdem eine andere, leere Datenbank einbinden. Verwende im normalen Betrieb keine Optionen zum Entfernen von Volumes. Prüfe die tatsächlichen Mounts, bevor du Annahmen über den Datenort triffst.

## Gestoppte Instanz sichern

Dieses Verfahren braucht Ausfallzeit, damit SQLite und Dateien konsistent sind. Das Hilfsimage muss vor dem Stoppen verfügbar sein. Es erstellt ausschließlich Archive und löscht oder ersetzt keine laufenden Volumes.

Definiere für diese Shell dieselbe Compose-Ausführung, erstelle ein privates absolutes Backup-Verzeichnis und ermittle die gemounteten Volumes:

```sh
rooms() { docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml "$@"; }
backup_dir="$HOME/rooms-backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
chmod 700 "$HOME/rooms-backups" "$backup_dir"
container_id=$(rooms ps -aq rooms)
test -n "$container_id"
data_volume=$(docker inspect "$container_id" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')
watch_volume=$(docker inspect "$container_id" --format '{{range .Mounts}}{{if eq .Destination "/watch-data"}}{{.Name}}{{end}}{{end}}')
test -n "$data_volume" && test -n "$watch_volume"
docker pull alpine:3.24
rooms config > "$backup_dir/compose.resolved.yaml"
cp .env "$backup_dir/rooms.env"
docker inspect "$container_id" > "$backup_dir/container.json"
rooms stop rooms
```

Archiviere dann jedes gemountete Volume unter Erhalt der Eigentümer und Berechtigungen:

```sh
docker run --rm --network none --read-only --security-opt no-new-privileges \
  --mount "type=volume,src=$data_volume,dst=/source,readonly" \
  --mount "type=bind,src=$backup_dir,dst=/backup" \
  alpine:3.24 tar -C /source -czf /backup/application.tar.gz .
docker run --rm --network none --read-only --security-opt no-new-privileges \
  --mount "type=volume,src=$watch_volume,dst=/source,readonly" \
  --mount "type=bind,src=$backup_dir,dst=/backup" \
  alpine:3.24 tar -C /source -czf /backup/watch-media.tar.gz .
rooms start rooms
rooms ps
tar -tzf "$backup_dir/application.tar.gz" > /dev/null
tar -tzf "$backup_dir/watch-media.tar.gz" > /dev/null
```

Falls ein Archivschritt fehlschlägt, lasse die Volumes unangetastet, behebe das Backup-Problem und starte den Dienst ausdrücklich wieder, sobald dies sinnvoll ist. Sichere TLS-Dateien und Reverse-Proxy-/Override-Konfiguration separat im privaten Backup-Satz, mit ihren tatsächlich konfigurierten Pfaden. Kopiere Backups auf getrennten geschützten Speicher und teste eine Wiederherstellung. Sie enthalten sensible Kontodaten, MFA-Geheimnisse, private Metadaten und verschlüsseltes Material; Chatverschlüsselung macht ein Backup nicht zur öffentlichen Datei.

## In neue Volumes wiederherstellen

Stelle in **neue, unbenutzte Volume-Namen** wieder her, damit die ursprünglichen Daten verfügbar bleiben. Definiere für diese Shell zuerst die Funktion `rooms` aus dem Backup-Abschnitt oder ersetze sie durch den vollständigen Compose-Aufruf. Stoppe den Zieldienst. Setze `backup_dir` auf den absoluten Pfad des gewählten Backups, prüfe Herkunft und Archivinhalt und wähle noch nicht vorhandene Namen:

```sh
rooms stop rooms
backup_dir=/absolute/path/to/the/backup
restore_data=rooms-data-restore-20261118
restore_watch=rooms-watch-media-restore-20261118
if docker volume inspect "$restore_data" >/dev/null 2>&1; then exit 1; fi
if docker volume inspect "$restore_watch" >/dev/null 2>&1; then exit 1; fi
docker volume create "$restore_data"
docker volume create "$restore_watch"
docker run --rm --network none --read-only \
  --mount "type=volume,src=$restore_data,dst=/restore" \
  --mount "type=bind,src=$backup_dir,dst=/backup,readonly" \
  alpine:3.24 tar -C /restore -xzf /backup/application.tar.gz
docker run --rm --network none --read-only \
  --mount "type=volume,src=$restore_watch,dst=/restore" \
  --mount "type=bind,src=$backup_dir,dst=/backup,readonly" \
  alpine:3.24 tar -C /restore -xzf /backup/watch-media.tar.gz
```

Die Archivhelfer behalten Dockers Standard-Capabilities, um private Anwendungsdateien zu lesen und archivierte UID/GID und Rechte wiederherzustellen. Die Backup-Quellen sind nur lesbar gemountet. Stelle kein nicht vertrauenswürdiges Archiv wieder her.

Setze `ROOMS_DATA_VOLUME` und `ROOMS_WATCH_VOLUME` in der Ziel-`.env` auf die beiden wiederhergestellten Namen. Stelle passende Instanzeinstellungen und TLS-/Proxy-Konfiguration wieder her, wähle die zum Backup passende Image-Version, prüfe `rooms config` und führe `rooms up -d --wait` aus. Prüfe vor der Umschaltung realer Nutzer auf einem isolierten Host oder privaten Netz mit **ursprünglicher kanonischer `PUBLIC_ORIGIN` und HTTPS-Hostname**, kontrollierter DNS-/Hosts-Zuordnung und passendem Proxy-Zertifikat. Kontozugangsdatenableitung und Browser-Identitätsspeicher sind an die Origin gebunden; eine produktive Origin für den Test auf Loopback zu ändern ist kein gültiger Anmeldetest wiederhergestellter Konten. Prüfe Datenbankzugriff, Betreiber-MFA/-Anmeldung, Raumrechte, Verlaufsentschlüsselung mit dem richtigen Passwort, Anhänge und Medien. Ein Backup stellt ein unbekanntes Chat-Entsperrpasswort nicht wieder her.

## Aktualisieren und zurückrollen

1. Notiere laufende Image-ID/Digest und Versionsnummer. Lies die Änderungen und erstelle ein Backup bei gestoppter Instanz.
2. Wähle das gewünschte veröffentlichte Tag oder den Digest in `.env` und führe `rooms pull` aus.
3. Behalte Projekt, Konfiguration und Volumes bei. Führe `rooms config --quiet` und anschließend `rooms up -d --wait` aus.
4. Prüfe Healthstatus und Logs sowie Anmeldung, Verschlüsselung/Verlauf, Anhänge, Sprache und Video von einem Client aus.

Die kurzen `rooms`-Befehle setzen die Funktion aus dem Backup-Abschnitt voraus; andernfalls verwende die vollständigen ausdrücklichen Compose-Argumente. Behalte alte Images, bis Update und Wiederherstellungsverfahren geprüft sind. Eine ältere Binärversion versteht möglicherweise keine bereits migrierte Datenbank. Erfordert ein Rollback das alte Schema, stelle das passende Backup von vor dem Update in neue Volumes wieder her, statt das alte Image gegen die geänderte Live-Datenbank zu starten.

Verwende zur gewählten Veröffentlichung passende Client- und Serverversionen. Ein Update des mitgelieferten einzelnen Container-Images aktualisiert Server und Gateway gemeinsam; Desktop-Clients und Browsererweiterungen werden getrennt aktualisiert.

## Zertifikate erneuern und Zugriff wiederherstellen

Starte beziehungsweise erstelle `rooms` nach dem Austausch der RTMPS-Zertifikate im konfigurierten TLS-Verzeichnis neu und prüfe nativen Ingest. HTTPS-Zertifikate des äußeren Proxys werden durch dessen eigene Erneuerung verwaltet. Bei verlorenem Betreiberzugriff nutze die [Betreiberwiederherstellung](administration.md); lösche nicht das Datenvolume, um die Ersteinrichtung wieder zu öffnen.
