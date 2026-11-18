# Self-hosting

[English](self-hosting.md) · [Deutsch](de/self-hosting.md) · [简体中文](zh-CN/self-hosting.md)

[Documentation](README.md) · [Configuration](configuration.md) · [Administration](administration.md) · [Operations](operations.md)

## Choose a deployment

Use [deploy/compose.image.yaml](../deploy/compose.image.yaml) to run Rooms in one container with two persistent volumes for application data and temporary watch-party media. The official `ghcr.io/zelotez/zelotez-rooms` image is public and supports `linux/amd64` and `linux/arm64`; downloading it requires no GitHub account or registry login.

## Requirements

- A Linux Docker host with Docker Engine 28 or later and Docker Compose 2.24.4 or later.
- For the single image, Linux Landlock ABI 3 or later and a container seccomp policy that allows its syscalls. Linux 6.2 or a suitable backport provides that ABI; kernel configuration and container policy also matter. Startup checks fail if it is unavailable. Do not remove the role isolation to bypass the check.
- Use an image matching the Docker host architecture (`linux/amd64` or `linux/arm64`).
- Storage for persistent application data, encrypted chat attachments, image uploads, and temporary watch-party videos. The shipped single-container limits are 4 CPUs, 3 GiB memory, and 512 processes; these are limits rather than measured minimum requirements.
- For a public instance: DNS, an HTTPS reverse proxy, and reachable media ports. Access to Docker or its socket is privileged administrative access.

## First start on the Docker host

Download the [repository files](https://github.com/ZeloteZ/ZeloteZ-Rooms/archive/refs/heads/main.zip), extract them, and open the extracted repository root on your Docker host. The following commands use the supplied deployment files from that directory:

```sh
mkdir -p deploy/tls
```

For a **new installation**, create a private `.env` with the following values. If `.env` already exists, inspect it and edit the intended values instead of replacing it. The repository's `.env.example` contains public-server examples; do not copy those values unchanged for a loopback test.

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

Open **http://127.0.0.1:8080 on the Docker host**. Enter the setup key, create the owner account, and enroll an authenticator by scanning the QR code and confirming its six-digit code. The setup key remains usable if the browser is closed before registration. Registration seals first-run setup permanently. Keep the printed key private until then.

This loopback configuration is for a browser on the same host. SSH forwarding can expose the web page privately, but forwarding port 8080 alone does not forward WebRTC media. Use the public configuration below for remote members and production use. Change `PUBLIC_ORIGIN` before creating production accounts; browser identity storage and native clients are associated with the chosen origin.

## Publish an HTTPS instance

Choose a canonical origin such as `https://rooms.example.com`, without a path, query, or fragment. Arrange HTTPS at the reverse proxy and point it at the Docker host's loopback web port. A reverse proxy in another container has its own loopback interface; use a reachable Docker network address and configure the exact trusted peer addresses instead of assuming `127.0.0.1` reaches the host.

Adapt `.env` before the first public start:

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

Replace the documentation address `203.0.113.10` with the host/IP clients can actually reach. With NAT, forward the configured UDP and TCP media port to the Docker host. An HTTP/CDN proxy for the website does not automatically forward those media connections.

The reverse proxy must:

- Preserve the public host and serve Rooms at the origin root, rather than under a URL subdirectory.
- Overwrite `X-Real-IP` with the verified client address when `TRUST_PROXY_IP=1`; never pass a client-supplied value unchanged.
- Preserve application response headers, including `X-ZeloteZ-Rooms-Client`, and support streaming responses. Avoid caching authenticated APIs, event streams, and private media.
- Allow 4 MiB request bodies on watch-party upload routes and the attachment/image requests allowed by the application. The bundled gateway already applies per-route limits; an outer proxy must not impose a smaller blanket limit.
- Keep the loopback web listener private. Open only HTTPS and the media/ingest ports actually used.

By default, trusted proxy peers in the single image are loopback and the detected Docker bridge gateway. For a different topology set `ROOMS_TRUSTED_PROXY_IPS` to exact comma-separated IP addresses; CIDR notation and hostnames are not accepted. See [configuration](configuration.md).

Re-run the explicit Compose `config`, `up`, and `--setup-key` commands above, and open the HTTPS origin. HTTPS is required for non-loopback origins, secure browser capture, and the supported desktop connection flow.

## Optional native RTMPS ingest

Public browser WebRTC sharing does not require a publicly exposed RTMPS listener. Native RTMP publishing, including the Linux native desktop helper, needs a reachable RTMPS endpoint and a valid matching certificate.

Put the full certificate chain in `deploy/tls/fullchain.pem` and its private key in `deploy/tls/privkey.pem`. The image runs as UID/GID 1000 and must be able to read them; arrange owner/group permissions or ACLs without making the key world-readable. Keep the directory out of Git. Then add:

```dotenv
INGEST_IP=0.0.0.0
INGEST_PORT=1936
STREAM_INGEST_BASE=rtmps://rooms.example.com:1936
RTMPS_CERT_DIR=./deploy/tls
```

Open/forward TCP 1936, or the chosen host ingest port, directly to the Docker host. The configured ingest hostname must match the certificate. A single-image HTTPS start with an explicit ingest base but without both readable TLS files fails; without files and without an explicit ingest base, RTMP is disabled while browser sharing remains available. Restart/recreate the service after certificate renewal so MediaMTX reads the new files.

## Choose an image revision or transfer it offline

Set `ROOMS_IMAGE` to the intended published tag or immutable digest. The official image is publicly downloadable without login. `latest` follows the current release; use a published SHA tag or digest for a fixed revision. Pull with the same Compose arguments before recreating the service.

For offline transfer, export on a machine that already has the chosen image:

```sh
docker image save ghcr.io/zelotez/zelotez-rooms:latest -o rooms-image.tar
```

Transfer the archive, run `docker image load -i rooms-image.tar` on the target, and set `ROOMS_IMAGE` to the loaded tag. Retain the matching image digest, configuration, and license notices.

## Next steps

Create member invitations using [administration](administration.md), read the [configuration reference](configuration.md), and set up a tested [backup and update procedure](operations.md). See [security](security.md) for the trust model and [troubleshooting](troubleshooting.md) for startup or media failures.
