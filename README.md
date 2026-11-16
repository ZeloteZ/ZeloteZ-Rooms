# ZeloteZ Rooms

[Deutsch](README.de.md)

ZeloteZ Rooms is a private place for friends. Rooms bring together encrypted chats, voice channels, and live streams. New accounts require an invitation from the site owner.

## Use Rooms

- **Rooms** can be public within the group or invite only. Room owners and admins can create, reorder, and delete channels. Members can mark rooms as favorites and see recent activity on the home screen.
- **Chat** supports links and up to four attachments per message, with a limit of 12 MiB per file. Anyone can delete their own messages. Room owners and admins can delete other messages with a reason. The chat then shows who deleted the message and their reason.
- **Mentions** suggest people, rooms, and channels when you type `@`. Room and channel mentions link to destinations you can access. Personal mentions appear in the recipient’s notification bell.
- **Live channels** show voice and streams together. Click **Join voice chat** to listen. Enable your microphone when you want to speak. Voice and stream playback continue as you browse. Their controls sit beside your profile. To switch voice rooms, open the other live channel and select **Switch voice chat**.
- **Screen sharing** starts with **Share screen** in a live channel. The browser asks you to choose a screen, window, or tab. Tab and window audio depend on browser support. [ZeloteZ Rooms Desktop](desktop/README.md) supports screen, window, and region capture on Windows and Linux. Both Linux builds can include a selected application’s audio or all audio from one playback device. The live channel shows viewers and stream chat.
- **Appearance** includes profile pictures and name colors, plus room covers, banners, accents, surfaces, and chat backgrounds. Room owners can grant design access to members. Images may be JPEG, PNG, or WebP up to 8 MiB and are processed on the server.

## Languages

English is the default. Choose **Deutsch** at sign-in or in your profile. The interface supports adding a Chinese catalog when the translation is ready.

## Encryption and storage

Browsers encrypt chat text, links, attachment names and files before upload. Each joined member receives an encrypted copy of the message key. Members with access automatically re-encrypt older keys for new members while their browser is signed in and unlocked. The encrypted content stays in one copy. Moderation reasons use the same protections. Stream chat belongs to the active broadcast and is removed when it ends.

Your password unlocks the encrypted account key. The server can see membership, roles, channel names, accounts, timestamps, file sizes, and connection data. It also serves the app code and public keys, so chat privacy assumes the delivered app is trustworthy. **How it works** explains these limits.

For personal mention notifications, the server receives the mentioned account IDs and the message and chat IDs. The chat text and its embedded links stay encrypted.

Voice and browser capture use WebRTC transport encryption. The native Linux capture available in the desktop app uses RTMPS. Stream playback uses HTTPS. MediaMTX relays live media and FFmpeg converts optional WebRTC stream audio to AAC for HLS playback on Apple devices. Server recording is disabled. The list of active viewers is visible to the streamer.

## Deploy

Copy [`.env.example`](.env.example) to `.env` and configure your server. Set `PUBLIC_ORIGIN` to the external HTTPS website address, and set `STREAM_INGEST_BASE` to the RTMPS address for desktop capture. Set `VOICE_ICE_HOST` to the address clients can reach for WebRTC. Put `fullchain.pem` and `privkey.pem` in `RTMPS_CERT_DIR`. Configure your HTTPS reverse proxy to reach the web port via loopback and to set `X-Real-IP` from the incoming connection. RTMPS uses TCP port 1936 by default. Voice and browser screen sharing use UDP 8189 with TCP on the same port as a fallback.


The `community` Docker volume holds accounts, memberships, and encrypted data. `docker compose down` preserves this volume.
