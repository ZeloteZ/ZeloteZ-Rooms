# Security and privacy

[English](security.md) · [Deutsch](de/security.md) · [简体中文](zh-CN/security.md) · [Documentation](README.md)

Rooms protects different kinds of data in different ways. This page describes the current implementation and its trust boundaries; it is not an independent cryptographic or deployment audit.

## Data protection at a glance

| Data | Protection and visibility |
| --- | --- |
| Regular room, live-channel, and direct-chat text, links, attachment names/content, reaction emojis, and moderation reasons | Encrypted in the client. The server stores ciphertext and encrypted message-key envelopes. |
| Room/channel names, membership, sender identities, timestamps, file sizes, mention recipients, and who reacted | Readable to the server for access control, delivery, and notifications. Encrypting message content does not hide this metadata. |
| Profile pictures and room artwork | Uploaded and processed by the server; not end-to-end encrypted. |
| Voice and live video | Encrypted on supported transport paths and relayed through MediaMTX. These are not end-to-end encrypted against the media server. |
| Uploaded watch-party videos | Temporarily stored in their original form and served to authorized viewers. They are not encrypted like chat attachments. |
| YouTube watch parties | The embedded player and video are delivered by YouTube directly to viewers. YouTube has its own data practices. |
| Temporary-room chat | Per-browser encrypted messages; the last 64 ciphertext messages are retained in server memory until room closure. This is separate from persistent channel history. |

See [the user guide](user-guide.md) and [streaming](streaming.md) for the controls that determine who can join and view each kind of content.

## Account keys and messages

The official client derives separate login and identity-unlock material from the password. Account derivation is bound to the username and the instance origin. Configure the final `PUBLIC_ORIGIN` before creating accounts; changing the address is not a routine, transparent account migration.

Each account has a public key and a password-protected private identity. A message key is encrypted separately for eligible recipients. Direct messages include the sender and recipient. When a member joins a room, an unlocked browser with the necessary historical keys can automatically share encrypted copies of those keys.

Consequences:

- If every browser holding older keys is offline or locked, history can remain unreadable until one returns and unlocks.
- Removing access does not erase messages or keys a former recipient already received or copied.
- Long-term account keys are involved in history access; do not assume forward secrecy or automatic protection of old messages after endpoint/key compromise.
- Signing in, unlocking chats, and restoring an account are related but distinct operations.

## The instance is a trust boundary

Browsers receive application code, public keys, membership lists, and history-sharing instructions from the instance. Key fingerprints are pinned after first observation in that browser's storage, but first contact still relies on the instance.

A malicious or compromised instance could change the delivered client code or misrepresent a recipient's membership/public key. A manipulated history-sharing flow could cause a client to share keys with an unauthorized recipient. End-to-end encryption here does not remove the need to trust the operator and the code your client executes.

Use HTTPS for remote instances. HTTP is accepted only for local loopback addresses. Check the instance address in the desktop app and browser extension before connecting.

## Authentication and recovery

New passwords are checked for at least 15 characters and a local common-password blocklist in the official clients. The server receives a derived credential and validates its format, so these password-strength checks are not a server-enforced password policy for arbitrary clients.

The owner must configure a time-based authenticator. Other members can enable MFA and one-time recovery codes. Server-side sessions use random tokens and expire; cookies are HTTP-only and SameSite Strict, with Secure and the host prefix on HTTPS.

MFA secrets, account metadata, authentication records, and active sessions are security-sensitive server data. Encrypting chats does not make database backups safe to publish.

The console can recover owner access and replace the owner's authenticator. It cannot decrypt an identity protected by a forgotten chat password. Password recovery can restore account control while leaving earlier chats locked. See [administration](administration.md) for the exact procedures and effects.

## Local storage and devices

The browser can cache chat-unlock material in session storage and remember observed public-key fingerprints in local storage. Temporary-room chat uses browser-local device keys, normally persisted with IndexedDB; losing that storage can make earlier guest messages unreadable. These temporary keys have a bounded lifetime.

The desktop option to remain signed in stores the session and chat-unlock material through the operating system credential backend. On Linux the implementation rejects Chromium's fixed-key storage fallback. An unavailable or locked keyring can prevent remembered sign-in without preventing a manual login.

Lock the operating-system session on shared devices. Signing out and disabling remembered login affect local access; recipients may still have their own copies of previously delivered content.

## Media and guest links

MediaMTX receives and redistributes voice/live streams. FFmpeg may adapt audio. Local loopback tests can use plain HTTP/RTMP; use the documented HTTPS/RTMPS configuration for remote access. Recording is disabled in the supplied configuration, but an operator or recipient can still record content by other means.

Temporary-room guest access uses a secret in the link's URL fragment, exchanged for a room-scoped session. Share the full link only with intended guests. Guests can use chat and shared watch-party playback controls. The host can revoke or replace guest access from the room's stream-access controls. Revocation cannot retract copies of content already received.

A regular members-only room and a temporary guest link are different access mechanisms; a room visible to members is not an anonymous public room.

## Deployment boundaries

The recommended image runs as an unprivileged user and restricts component filesystem access using Landlock. Its supplied Compose file uses a read-only filesystem, dropped capabilities, limited resources, and loopback port bindings by default. These measures limit exposure; an operator must still configure HTTPS, trusted proxies, media reachability, backups, and host security.

Internal media management and authentication endpoints must remain private. Trust forwarded client addresses only from a proxy that replaces the incoming header. See [self-hosting](self-hosting.md), [configuration](configuration.md), and [operations](operations.md).

## Reporting a security problem

Do not put credentials, invite/recovery links, chat content, or exploit details for an unpatched issue in a public issue. If GitHub offers a private vulnerability report for this repository, use it. Otherwise ask the [project owner](https://github.com/ZeloteZ) to establish a private reporting channel without publishing the sensitive details.

For an ordinary bug, use the sanitized information checklist in [troubleshooting](troubleshooting.md).
