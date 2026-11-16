<img src="desktop/portable/ui/icon.png" alt="ZeloteZ Rooms logo" width="88" align="right">

# ZeloteZ Rooms

A private place for friends to chat, talk, and share their screens. Host an invite-only instance, set up rooms around whatever brings your group together, and join from a browser or the desktop app.

[Deutsch](README.de.md) · [Self-hosting](#self-hosting) · [Desktop app](desktop/README.md)

## What you can do

- **Make a room your own.** Join rooms open to your group or create private rooms for approved friends. Owners and room admins manage text and live channels. Owners can delete the room or grant design access. The home page keeps favorites, recent rooms, and live activity close at hand.
- **Keep the conversation going.** Text chats keep their history. Share links and up to four files per message, with a limit of 12 MiB per file. Click an image to enlarge it. Attachments load as you reach them by default. You can turn this off or set a size limit in your profile.
- **React, mention, and moderate.** Add emoji reactions in text and stream chats. Type `@` to mention a person or link a room or channel. Personal mentions appear in the notification bell. Anyone can delete their own messages. Room owners and admins can remove other messages with a reason or move them between text channels in the same room.
- **Message a friend.** Open an end-to-end encrypted direct chat from **Messages** or **Friends**. Share links and files with a confirmed friend. The notification bell shows friend requests, direct messages and mentions. Turn on live alerts in your profile for rooms you’ve joined.
- **Talk and watch together.** A live channel brings voice, streams, and stream chat into one view. Choose **Join voice chat** to listen, then enable your microphone when you want to speak. Voice and playback controls stay in the header as you browse. Viewers can choose direct WebRTC playback or buffered HLS.
- **Share a screen.** Choose **Share screen** in a live channel. Supported browsers can share a screen, window, or tab. The desktop app also supports region capture. On Linux you can share audio from one application or a whole playback device using PipeWire.
- **Start a watch party.** Use **Share video** in a live channel to share a YouTube embed or upload an original MP4 or WebM up to 256 MiB. Viewers share play, pause, and seek controls and adjust volume individually.
- **Stream now.** Choose a screen, YouTube video, or local file from the Rooms overview. Use an existing live channel or open a temporary room. Temporary rooms can appear in **Live now** for signed-in members or offer a password-protected viewer link for guests.
- **Change the look.** Choose a profile picture and name color. Give a room its own cover, banner, colors, and chat background. Built-in image presets are available for profile pictures and room images. You can also upload JPEG, PNG, or WebP images up to 8 MiB.
- **Find your way around.** First-visit guides introduce the main views and can be reset in your profile. The interface is available in English and German.

## Self-hosting

1. **Configure the instance.** Copy [`.env.example`](.env.example) to `.env`. Set `PUBLIC_ORIGIN` to your HTTPS origin and `STREAM_INGEST_BASE` to your RTMPS endpoint. Use addresses without paths. Set `VOICE_ICE_HOST` to a hostname or IP address your clients can reach.
2. **Set up HTTPS and RTMPS.** Point your HTTPS reverse proxy at the loopback port configured by `WEB_PORT`. Have the proxy overwrite `X-Real-IP` with the trusted client address. Put `fullchain.pem` and `privkey.pem` in `RTMPS_CERT_DIR`, using a separate TLS key for the ingest endpoint.
3. **Open the ports your group needs.** HTTPS terminates at your reverse proxy. The media defaults are TCP 1936 for native RTMPS ingest and UDP 8189 with a TCP fallback on the same port for WebRTC.
4. **Start the instance and create the owner account.** Run these commands from the repository root, then open the bootstrap link.

The site owner manages invitations and can suspend accounts or end their sessions under **Invites → Accounts**. Each account can broadcast one stream at a time, with up to eight simultaneous broadcasts per instance.

The default stack sets resource limits and rotates container logs. See the [Compose file](compose.yaml) for the values.

If your reverse proxy enforces request-body limits, allow 4 MiB chunks for the watch-party upload route `/api/channels/<id>/watch/<id>/upload`.

> [!IMPORTANT]
> Keep a separate, restorable backup of the `community` Docker volume and your instance configuration. The volume holds accounts, memberships, and encrypted data. An ordinary `docker compose down` preserves it.

## Desktop app

## What stays private

Room and direct chat messages, shared links, attachment names and files, reaction emojis, and moderation reasons are end-to-end encrypted in the browser. Your password unlocks the private key used to read your chats. A direct message's key is wrapped for the sender and recipient. When someone joins a room, an unlocked browser with access automatically shares encrypted copies of the older message keys. The server stores each message and attachment once. Stream chat is tied to the broadcast and is cleared when it ends.

The server handles room and channel names, membership, senders, timestamps, file sizes, profile and room images, and the account references needed for mentions and reactions. It also supplies the app code, membership lists, and first-seen public keys. A compromised server can change the app or misrepresent membership, so chat privacy depends on a trusted instance. **How it works** in the app explains these boundaries in plain language.

Voice and live video are encrypted in transit. MediaMTX relays live media and FFmpeg adapts audio for playback where needed. Server-side recording is disabled.

For watch parties, YouTube serves its own embedded player and video directly to each viewer. Rooms stores uploaded watch-party videos temporarily in their original form and restricts playback to viewers with access to the channel.

A temporary room’s guest link lets visitors watch, use the live chat, and play, pause, or seek in a watch party. The password in the link’s URL fragment is exchanged for a session limited to that room. The host can revoke or replace it from **Stream access**.

Temporary live chat uses separate, short-lived keys for each participating device. The server carries encrypted messages and can see who sent them and when. Participants do not receive messages sent before they joined, and the chat is cleared when the room closes.
