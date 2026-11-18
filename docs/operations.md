# Operations, backups, and upgrades

[English](operations.md) · [Deutsch](de/operations.md) · [简体中文](zh-CN/operations.md)

[Documentation](README.md) · [Self-hosting](self-hosting.md) · [Configuration](configuration.md) · [Administration](administration.md)

The commands on this page target the **single-image stack**. Run them from the repository root using the same `.env`, Compose project, and volume configuration as the initial deployment.

## Inspect the service

```sh
docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml ps
docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml logs --tail 100 rooms
docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml images
```

The image's health check tests the local web gateway and media signaling listener. A healthy result does not prove that external DNS, HTTPS, NAT, browser permissions, or client media paths work. Verify sign-in, one browser stream, voice, and optional native ingest from a real client after a change.

The container manages its child processes together: an unexpected API, gateway, or MediaMTX exit stops the service, and Docker applies its restart policy. Look for the first error rather than only the last restart message. Bound log retention is configured in Compose; preserve relevant logs before they rotate and redact account/link secrets before sharing them.

## What persists and what restarts end

- `/data` contains `community.sqlite` and related SQLite files, account/MFA state, encrypted history and attachments, profile/room assets, and setup state. Back up the entire volume, not only the `.sqlite` file.
- `/watch-data` contains temporary uploaded watch-party videos. Watch-party state is in memory; startup removes orphaned party-video files. This volume is not a permanent video library.
- Active streams, voice connections, watch-party playback/queues, and temporary live-chat messages may end on restart. Temporary room records refer to active media and are cleaned up when their source is no longer active; they are not durable saved rooms. Warn active members before maintenance.
- `.env`, Compose overrides, optional TLS files, reverse-proxy configuration, and the selected image tag/digest live outside these volumes and must be retained separately.

An ordinary Compose `down` retains named volumes, but a change in volume names or project can still attach a different empty database. Avoid volume-removal options in normal maintenance. Check actual mounts before assuming where the data is.

## Back up a stopped instance

This procedure takes downtime so SQLite and files form a consistent set. The helper image must be available before stopping the service. It creates archives only; it does not delete or replace the live volumes.

First define the same Compose invocation for this shell session, create a private absolute backup directory, and identify the mounted volumes:

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

Then archive each mounted volume, preserving its ownership and permissions:

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

If an archive step fails, keep the volumes intact, resolve the backup problem, and explicitly start the service when appropriate. Save TLS files and reverse-proxy/override configuration separately in the private backup set; include their actual configured locations. Copy backups to separate protected storage and test a restore. They contain sensitive account state, MFA secrets, private metadata, and encrypted material; encryption of chats does not make the backup public-safe.

## Restore into new volumes

Restore to **new, unused volume names** so the original data remains available. First define the `rooms` function from the backup section for this shell session, or substitute its full Compose invocation. Stop the target service. Set an absolute `backup_dir` pointing at the chosen backup, verify its provenance and archive contents, then choose names not already present:

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

The archive helpers retain Docker's default capabilities so they can read the application's private files and restore archived UID/GID and permissions. The backup source mounts are read-only. Do not restore an untrusted archive.

Set `ROOMS_DATA_VOLUME` and `ROOMS_WATCH_VOLUME` in the target `.env` to the two restored names. Restore the matching instance settings and TLS/proxy configuration, select the image version that matches the backup, review `rooms config`, and run `rooms up -d --wait`. Validate on an isolated host or private network using the **original canonical `PUBLIC_ORIGIN` and HTTPS hostname**, with controlled DNS/hosts routing and the matching proxy certificate, before directing real users to it. Account credential derivation and browser identity storage are origin-bound; changing a production origin to loopback is not a valid restored-account login test. Check database access, owner MFA/sign-in, room access, history decryption with the proper password, attachments, and media. A backup cannot recover an unknown chat-unlock password.

## Upgrade and rollback

1. Record the running image ID/digest and release version. Read the changes and make a stopped-instance backup.
2. Select the intended published tag or digest in `.env` and run `rooms pull`.
3. Keep the same project, configuration, and volumes. Run `rooms config --quiet`, then `rooms up -d --wait`.
4. Inspect health/logs and exercise sign-in, encryption/history, attachments, voice, and video from a client.

These short `rooms` commands assume the function defined in the backup section; otherwise use the full explicit Compose arguments. Keep old images until the upgrade and restore procedure are validated. A previous binary may not understand a database already migrated by a newer version. If rollback needs the old schema, restore the matching pre-upgrade backup into new volumes instead of pointing an old image at the changed live database.

Use client and server versions compatible with the chosen release. Updating the supplied single-container image updates the server and gateway together; desktop clients and browser extensions are updated separately.

## Certificate renewal and recovery

After replacing RTMPS certificate files in the configured TLS directory, restart/recreate `rooms` and verify native ingest. HTTPS certificates at the outer proxy are managed by that proxy's own renewal mechanism. For lost owner access, use the [owner recovery procedure](administration.md); do not delete the data volume to reopen setup.
