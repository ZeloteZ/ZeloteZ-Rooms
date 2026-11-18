# Run ZeloteZ Rooms in one container

The Rooms image contains the web gateway, the Rooms server, MediaMTX and FFmpeg. Use Docker Engine 28 or newer for loopback port publishing. The image is built for Linux amd64 and arm64. The host kernel must enable Landlock ABI 3 or later (Linux 6.2 or later, or a backport), and the container's seccomp profile must allow Landlock. Rooms checks this at startup. The gateway reads the web and download files, the API can write to the application and media volumes, and only MediaMTX can read the RTMPS key. FFmpeg runs with a separate, narrower policy.

## First start

```sh
docker run -d --name rooms --restart unless-stopped \
  --read-only --tmpfs /tmp:mode=1777 --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1:8080:8080 -p 127.0.0.1:8189:8189/udp -p 127.0.0.1:8189:8189/tcp \
  -v rooms-data:/data -v rooms-watch-media:/watch-data \
  ghcr.io/zelotez/zelotez-rooms:latest
docker exec rooms node bootstrap.mjs --setup-key
```

Open [http://127.0.0.1:8080](http://127.0.0.1:8080), enter the setup key, create the owner account, and scan the QR code with your authenticator. For a remote host, forward the loopback web port with `ssh -L 8080:127.0.0.1:8080 your-host` or use the configured HTTPS address. Treat the setup key like a password until the owner account exists. If you close the browser during setup, use the same key to continue. The wizard closes after owner registration.

To use a host without registry credentials, transfer the image with `docker image save` on a machine that has it and `docker image load` on the host. Use the loaded tag as `ROOMS_IMAGE` and skip the pull step.

## Public instance

The [image Compose file](compose.image.yaml) keeps persistent volumes and supports unattended container restarts. Run Compose from the repository root with `--project-directory . -f deploy/compose.image.yaml`, or use the same runtime options in your own Compose file.

- Set `PUBLIC_ORIGIN` to the canonical HTTPS address, such as `https://rooms.example.com`, before creating the account. Point an HTTPS reverse proxy at the loopback web port (`WEB_PORT`, default 8080). Set `TRUST_PROXY_IP=1` only when that proxy overwrites `X-Real-IP` with the verified client address. The gateway accepts this header only from trusted peers. The default peers are loopback and the Docker bridge gateway. For a proxy on a separate container or a custom network, set `ROOMS_TRUSTED_PROXY_IPS` to the comma-separated source IPs the gateway actually sees. Keep the web port private to the proxy.
- For remote voice or browser streaming, set `VOICE_ICE_HOST` to a hostname or IP address clients can reach and `VOICE_ICE_IP` to the host interface receiving media traffic. Publish `VOICE_ICE_PORT` over both UDP and TCP with the same port inside and outside the container (8189 by default).
- For native RTMPS ingest, set `STREAM_INGEST_BASE` to the RTMPS address and publish TCP 1936 on the intended interface (`INGEST_IP`, `INGEST_PORT`). Mount the directory holding `fullchain.pem` and `privkey.pem` at `/tls` using `RTMPS_CERT_DIR`. The container runs as UID/GID 1000 and needs read access to both files. Use a dedicated TLS key with restricted access. The browser streaming path works without this separate RTMPS certificate.
- Set `ROOMS_CPUS` below 4 for Docker hosts with fewer CPUs.

```sh
docker compose --project-directory . -f deploy/compose.image.yaml up -d --wait
docker compose --project-directory . -f deploy/compose.image.yaml exec -T rooms node bootstrap.mjs --setup-key
```

Enter the key at your configured web address. For owner account recovery or resetting owner MFA, run `node bootstrap.mjs --recover-owner` or `node bootstrap.mjs --setup-owner-mfa` in the Rooms container.

## Updates

Back up the current instance configuration, application volume and media files. Include the active Compose file and its environment file, reverse proxy configuration, and the configured media and certificate mounts. Protect archives containing credentials and keys. Verify a restore using a separate Compose project and volumes before relying on the backup. Then run the following from the same Compose project and environment.

```sh
docker compose --project-directory . -f deploy/compose.image.yaml pull
docker compose --project-directory . -f deploy/compose.image.yaml up -d --wait
```

The container keeps the existing accounts and rooms by remounting the same volumes. Pin `ROOMS_IMAGE` to `ghcr.io/zelotez/zelotez-rooms:sha-<commit>` or an image digest to choose a specific build. Keep a pre-update backup for rollback if database migrations have run.
