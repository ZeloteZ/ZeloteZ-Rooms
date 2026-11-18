# Configuration reference

[English](configuration.md) · [Deutsch](de/configuration.md) · [简体中文](zh-CN/configuration.md)

[Documentation](README.md) · [Self-hosting](self-hosting.md) · [Operations](operations.md)

## Which configuration applies?

This reference applies to the recommended single-container deployment in `deploy/compose.image.yaml`. Environment variables in a shell or `.env` affect the container only where this Compose file forwards them or uses them for interpolation; adding an arbitrary variable to `.env` does not automatically inject it.

Run all examples from the repository root and pass the environment file explicitly:

```sh
docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml config
```

The resolved configuration can contain private settings. Do not paste it unredacted into public issues. Shell-exported variables may override values in `.env`; inspect the resolved result before changing an existing instance.

## Single-image variables

Defaults below come from the shipped image Compose file and entrypoint, not from `.env.example`.

| Variable | Default | Effect |
| --- | --- | --- |
| `ROOMS_IMAGE` | `ghcr.io/zelotez/zelotez-rooms:latest` | Container image. Use the intended public package tag or immutable digest. |
| `PUBLIC_ORIGIN` | `http://127.0.0.1:${WEB_PORT:-8080}` | Canonical browser origin. HTTPS is mandatory outside loopback; no subpath, query, fragment, or embedded credentials. |
| `WEB_PORT` | `8080` | Host TCP web port, always bound to `127.0.0.1` by this Compose file; container port remains 8080. |
| `TRUST_PROXY_IP` | `0` | Only `1` enables trusted-proxy processing of `X-Real-IP`. Use only with an outer proxy that overwrites the header. |
| `ROOMS_TRUSTED_PROXY_IPS` | Empty | With proxy trust enabled, exact comma-separated IPv4/IPv6 peer IPs. Empty uses loopback and detected Docker bridge gateways. Hostnames/CIDRs are invalid. |
| `VOICE_ICE_HOST` | Empty | Media host/IP advertised to clients. Empty uses the hostname in `PUBLIC_ORIGIN`; use an address reachable directly by media clients. |
| `VOICE_ICE_IP` | `127.0.0.1` | Host bind address for both UDP and TCP WebRTC media. Usually `0.0.0.0` for a public IPv4 instance. |
| `VOICE_ICE_PORT` | `8189` | Host and container UDP/TCP WebRTC media port, from 1 to 65535. Changing it changes both bindings and MediaMTX listeners. |
| `INGEST_IP` | `127.0.0.1` | Host bind address for RTMPS TCP publishing. |
| `INGEST_PORT` | `1936` | Host RTMPS TCP port forwarded to container port 1936. Include the chosen host port in `STREAM_INGEST_BASE`. |
| `STREAM_INGEST_BASE` | Empty | Advertised ingest base URL without a path. For HTTPS instances use `rtmps://host:port`; loopback HTTP tests may use loopback RTMP. API derives a default when empty; actual ingest availability also depends on TLS/entrypoint mode. |
| `RTMPS_CERT_DIR` | `./deploy/tls` | Read-only host directory mounted at `/tls`, relative to the project directory. RTMPS expects `fullchain.pem` and `privkey.pem`. |
| `ROOMS_DATA_VOLUME` | `rooms-data` | Exact Docker volume name mounted at `/data`. Existing data is not moved when this value changes. |
| `ROOMS_WATCH_VOLUME` | `rooms-watch-media` | Exact Docker volume name mounted at `/watch-data`. |
| `ROOMS_CPUS` | `4.0` | Container CPU limit. Other resource limits require a Compose override. |

The published image configures its private control endpoints automatically. Do not add direct host port bindings for internal control services.

HTTPS mode enables strict RTMPS only when both certificate files are readable. An explicit `STREAM_INGEST_BASE` in HTTPS mode requires them; otherwise RTMP can remain disabled. Loopback HTTP mode uses plain internal RTMP on 1935. The image Compose file does not publish 1935.

## Ports and storage

| Endpoint/path | Purpose | Public exposure |
| --- | --- | --- |
| Container TCP 8080 | NGINX web/API gateway | Host loopback; place HTTPS proxy in front. |
| Configured UDP/TCP 8189 | WebRTC media | Directly reachable by participating clients. |
| Container TCP 1936 | Optional RTMPS ingest | Expose only when using native publishing with TLS. |
| `/data` | SQLite database, account state, encrypted history/attachments, profile/room assets, setup state | Persistent application volume. |
| `/watch-data/watch-videos` | Temporary original watch-party videos | Separate media volume; party state is in memory and startup removes orphaned party files. |
| `/tls` | Optional RTMPS chain and private key | Read-only bind mount; not application data. |

The filesystem is read-only except its configured volumes and `/tmp` tmpfs. Logging uses Docker's `local` driver with up to three 20 MiB files. The single-image limits are 3072 MiB RAM and 512 processes; the default CPU limit is above. Change resource policy through a reviewed Compose override rather than editing live containers.

## Application limits

These limits are currently constants in the application, not environment-variable settings or performance guarantees. Storage accounting is distinct from the size of the SQLite file, backups, and third-party process memory. Limits can reject new writes even when the host still has free disk space.

| Area | Current limit and scope |
| --- | --- |
| Regular rooms | 200 instance-wide, 32 owned by one account. The room-creation count excludes direct conversations and temporary rooms. |
| Room membership | 80 membership records per room, including the owner and pending entries, not 80 simultaneous online viewers. |
| Persistent chat attachments | 4 per message; 12 MiB plaintext per attachment (the server allows 28 additional encrypted bytes). Stored encrypted attachment bytes are limited to 2 GiB instance-wide and 250 MiB per uploader. |
| Persistent chat history | For persistent regular-channel and direct-chat history: 300,000 messages instance-wide and 50,000 per sender; serialized encrypted message envelopes have separate byte limits of 256 MiB instance-wide and 32 MiB per sender. These are not plaintext-character or complete database-size limits. |
| Profile/room images | JPEG, PNG, or WebP uploads up to 8 MiB, with an image-decoder pixel limit of 16 million. |
| Prepared/active screen broadcasts | 8 instance-wide, with one prepared or active broadcast per account. |
| Confirmed voice participants | 16 per live channel, 64 instance-wide; pending joins have separate negotiation limits. |
| Watch-party uploads | MP4/WebM up to 256 MiB per file; 512 MiB of reserved local-video storage instance-wide, including queued uploads. Uploads use 4 MiB chunks, expire after 3 minutes without upload progress, and have a maximum upload lifetime of 20 minutes. |
| Watch parties and queues | 8 active channel parties instance-wide and up to 16 upcoming items per party, in addition to its current item. |
| Temporary rooms | 24 instance-wide and one per owner; drafts expire after 5 minutes, rooms after at most 12 hours, and an inactive media source can end a room earlier. |
| Temporary live chat | The last 64 ciphertext messages per temporary-room chat, kept in memory rather than permanent history. |
