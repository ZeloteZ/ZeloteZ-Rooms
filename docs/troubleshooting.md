# Troubleshooting

[English](troubleshooting.md) · [Deutsch](de/troubleshooting.md) · [简体中文](zh-CN/troubleshooting.md) · [Documentation](README.md)

Start with the symptom and use the linked procedure. Commands below target the recommended single-container deployment, run from the repository root with the same environment file and Compose project used at installation.

## Collect a small diagnostic snapshot

```sh
docker compose --env-file .env --project-directory . -f deploy/compose.image.yaml ps
docker compose --env-file .env --project-directory . -f deploy/compose.image.yaml logs --tail=100 rooms
```

If you installed without `.env`, omit `--env-file .env`. Logs may contain sensitive information; inspect them before sharing.

## Installation and startup

| Symptom | Checks and next action |
| --- | --- |
| Image pull is denied | The official image is public. Check the `ROOMS_IMAGE` name and tag, network access, and registry availability. If Docker has stale GHCR credentials, sign out and retry. See [self-hosting](self-hosting.md). |
| Container exits with a Landlock error | The image requires Linux Landlock ABI 3 or later and a seccomp profile permitting its calls. Check the actual host/VM kernel and runtime. Use a compatible host/profile; do not turn the entire isolation policy off to hide the failure. |
| Permission denied for `/data`, `/watch-data`, or a certificate | The image runs as uid/gid 1000. Inspect volume ownership and read permissions for that user. Keep secrets narrowly readable rather than making data world-writable. See [operations](operations.md). |
| RTMPS certificate error | If ingest is configured on a public HTTPS instance, `/tls/fullchain.pem` and `/tls/privkey.pem` must both exist and be readable. Check the bind directory and complete certificate chain. Browser screen sharing does not by itself require a public RTMPS endpoint. |
| Web interface cannot be reached remotely | The default web binding is loopback. Use the configured HTTPS reverse proxy, or an SSH tunnel for administration/local testing. Do not mistake the internal health endpoint for a public status page. |
| Setup key is rejected or setup is closed | Check that the key came from this instance's data volume. After owner creation, setup closes intentionally. Use the owner recovery procedure rather than deleting the database.  |

See [self-hosting](self-hosting.md) and [administration](administration.md).

## Accounts and encrypted history

| Symptom | Checks and next action |
| --- | --- |
| Login fails after changing domain or port | The canonical origin participates in client credential derivation. Verify the intended address and `PUBLIC_ORIGIN`. Do not repeatedly change origins or reset accounts as a first step. See [security](security.md). |
| An action fails with an origin error | Check the exact HTTPS scheme, hostname, and port, the reverse proxy's Host header, and `PUBLIC_ORIGIN`. The official client and server must use the same origin. |
| Authenticator code is rejected | Check device/server time synchronization and use a current six-digit code. A code already consumed can be rejected. Use an unused saved recovery code where available; owner console recovery is documented separately. |
| Signed in but chats are locked | Use **Unlock chats** with the password protecting the account identity. Recovering login access does not decrypt a forgotten chat key. |
| Old history is missing for a newly joined member | Have an authorized member's browser open and unlocked so it can share older keys. History may wait until an eligible key holder returns. |
| Earlier temporary-room messages no longer open | Reuse the same browser profile with its original local key and a still-valid room access. Clearing browser storage, switching profiles, key expiry, or room closure may make those messages unavailable. |
| Remembered desktop login is unavailable | Check that the OS credential store is running/unlocked. Manual login remains available. Linux fixed-key fallback storage is intentionally refused. |

Do not clear browser storage or delete volumes as a generic repair step. They contain data and keys that may be needed for recovery.

## Voice, sharing, and playback

| Symptom | Checks and next action |
| --- | --- |
| No screen/window picker or no sources | Check browser/OS permissions and the ScreenCast portal matching the active GNOME/KDE session. On Wayland, PipeWire and a working portal backend are required. See [desktop](desktop.md). |
| Linux client refuses to start with a sandbox warning | Remove an old launcher flag that disables the sandbox and use the distribution's supported unprivileged-user-namespace policy. Rooms requires the Chromium sandbox. |
| Black image or an unavailable capture engine | Retry with **Standard**, reselect a source, and check driver/portal support. **Rooms Capture** is experimental and is not a promise of better performance on all hardware. |
| Application audio list is empty | Start playback in the target app, then reopen the audio picker. On Linux check PipeWire tools; on Windows application audio requires the supported Windows version. |
| Audio disappears when an app/output closes | Start the stream again and select an available application/output. System audio includes other sounds played on that output. |
| Voice or direct playback will not connect | Check advertised `VOICE_ICE_HOST`, matching TCP/UDP ports, NAT/firewall reachability, and TLS. Reverse-proxying the website alone does not make the media port reachable. |
| Video is delayed or the rate jumps | Buffered HLS trades latency for buffering and can download in bursts. Try direct playback where available. See [streaming](streaming.md) for interpreting statistics. |
| A metric displays a dash | The selected transport/capture backend may not expose it. Native RTMP/HLS do not expose every WebRTC statistic. A dash means unavailable, not zero loss. |
| YouTube pauses or cannot play | YouTube pauses when its final viewer closes/hides the player. Also check embed availability, browser autoplay rules, and access to YouTube. |
| Video upload is rejected | Check MP4/WebM format, the 256 MiB limit, and proxy support for the upload route's 4 MiB chunks. Chat attachment and room-image limits are different. |

## Extension and desktop links

The extension and client must use exactly the same Rooms origin. Open the desktop app once, confirm the instance, and on Linux run the executable AppImage from its permanent location so it can register the link handler.

If an old app handles `zelotez-rooms:`, choose the current Rooms app in system link settings. The extension's **Continue in browser** path remains available. Firefox temporary add-ons must be reloaded after a restart. See [the extension guide](browser-extension.md).

Desktop update checks are optional and query the official GitHub releases. If a check is unavailable, verify network access and GitHub service/rate-limit conditions, then open the [release page](https://github.com/ZeloteZ/ZeloteZ-Rooms/releases/latest) manually. Check your desktop version and server revision separately.

## Report a reproducible bug

Include:

- What you tried, what you expected, and the exact visible error.
- Rooms server image tag/revision, desktop version if relevant, and whether you use the browser or app.
- Operating system/desktop session, browser version, capture engine, and playback mode relevant to the failure.
- Minimal reproduction steps and sanitized log lines around the failure.
- Whether it also occurs with **Standard** capture or another supported browser, where relevant.

Remove cookies, tokens, full guest/invite/recovery links, authenticator QR codes/secrets, private keys, personal chat content, and unrelated addresses before posting. For vulnerabilities use [private security reporting](security.md#reporting-a-security-problem).
