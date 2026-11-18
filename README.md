<img src="desktop/portable/ui/icon.png" alt="ZeloteZ Rooms logo" width="88" align="right">

# ZeloteZ Rooms

A private place for friends to chat, talk, and share their screens. Host an invite-only instance, set up rooms around whatever brings your group together, and join from a browser or the desktop app.

[Deutsch](README.de.md) · [简体中文](README.zh-CN.md) · [Self-hosting](#self-hosting) · [Desktop app](desktop/README.md) · [YouTube extension](#youtube-browser-extension)

## What you can do

- **Make a room your own.** Join rooms open to your group or create private rooms for approved friends. Owners and room admins manage text and live channels. Owners can delete the room or grant design access. The home page keeps favorites, recent rooms, and live activity close at hand.
- **Keep the conversation going.** Text chats keep their history. Share links and up to four files per message, with a limit of 12 MiB per file. Click an image to enlarge it. Attachments load as you reach them by default. You can turn this off or set a size limit in your profile.
- **React, mention, and moderate.** Add emoji reactions in text and stream chats. Type `@` to mention a person or link a room or channel. Personal mentions appear in the notification bell. Anyone can delete their own messages. Room owners and admins can remove other messages with a reason or move them between text channels in the same room.
- **Message a friend.** Open an end-to-end encrypted direct chat from **Messages** or **Friends**. Share links and files with a confirmed friend. The notification bell shows friend requests, direct messages and mentions. Turn on live alerts in your profile for rooms you’ve joined.
- **Talk and watch together.** A live channel brings voice, streams, and an encrypted channel chat into one view. The chat is available between broadcasts and alongside any video source. Choose **Join voice chat** to listen, then enable your microphone when you want to speak. Voice and playback controls stay in the header as you browse. Viewers can choose direct WebRTC playback or buffered HLS.
- **Share a screen.** Choose **Share screen** in a live channel. Supported browsers can share a screen, window, or tab. The desktop app also supports region capture. On Linux you can share audio from one application or a whole playback device using PipeWire.
- **Start a watch party.** Use **Share video** to share a YouTube embed or upload an MP4 or WebM up to 256 MiB. People with permission to share can add or remove upcoming videos in the queue. Viewers share play, pause and seek controls while keeping their own volume. The video moves to the mini player as you browse. YouTube pauses when the last viewer closes or hides their player.
- **Stream now.** Choose a screen, YouTube video, or local file from the Rooms overview. Use an existing live channel or open a temporary room. Temporary rooms can appear in **Live now** for signed-in members or offer a password-protected viewer link for guests.
- **Change the look.** Choose a profile picture and name color. Give a room its own cover, banner, colors, and chat background. Built-in image presets are available for profile pictures and room images. You can also upload JPEG, PNG, or WebP images up to 8 MiB.
- **Find your way around.** First-visit guides introduce the main views and can be reset in your profile. The interface is available in English, German, and Simplified Chinese.

## Self-hosting

Use the same Rooms image for a public instance. Configure its canonical HTTPS address and media ports before creating the owner account, following the [public-instance guide](deploy/README.md#public-instance). It covers the reverse proxy, reachable media addresses, optional RTMPS certificates, and resource limits. Keep using the same Compose project and volumes for [updates](deploy/README.md#updates).

Members can enable two-factor sign-in under **Profile → Two-factor sign-in**. Scan the QR code and enter a six-digit code from the app. Save the displayed recovery codes separately from the device. Each can replace an authenticator code once when signing in. Use the profile to change devices, generate new recovery codes or turn off optional two-factor sign-in.

Two-factor sign-in is required for the owner. The owner can set up and replace an authenticator in the profile. Sensitive actions under **Invites** and changes to the owner password require recent authenticator confirmation. If you lose access to the authenticator, run this from the same Compose project and environment:

```sh
docker compose --project-directory . -f deploy/compose.image.yaml exec -T rooms node bootstrap.mjs --setup-owner-mfa
```

Scan the terminal QR code with your authenticator app. You can also enter the printed key as a time-based code with six digits and a 30-second period. This command replaces the old authenticator and ends existing owner sessions. Sign in again and generate recovery codes in the profile.

The site owner manages invitations and can suspend accounts or end their sessions under **Invites → Accounts**. Each account can broadcast one stream at a time, with up to eight simultaneous broadcasts per instance.

Rooms checks new passwords in the browser. Use at least 15 characters and choose a password that is uncommon. Existing passwords still work. The server receives a derived credential and can enforce its format. The password length and blocklist checks run in the official web and desktop apps.

To change your password, open your profile and choose **Change password**. Rooms keeps your chat key and ends your other sessions. To recover the owner account from the server console, use:

```sh
docker compose --project-directory . -f deploy/compose.image.yaml exec -T rooms node bootstrap.mjs --recover-owner
```

This revokes owner sessions and unused invitations and pauses the old sign-in. Open the one-time link in the terminal within 20 minutes. Use the previous chat password to keep the chat key accessible. If you lost that password, you can regain the account with its chats locked and unlock them later if you find it. Run the recovery command again if the link expires.

If your reverse proxy enforces request-body limits, allow 4 MiB chunks for the watch-party upload route `/api/channels/<id>/watch/<id>/upload`.

> [!IMPORTANT]
> Keep a separate, restorable backup of the application and media volumes (`rooms-data` and `rooms-watch-media` by default) and your instance configuration. The application volume holds accounts, memberships, and encrypted data. An ordinary `docker compose down` preserves the volumes.

## Desktop app

In your browser, sign in to Rooms and select **Client** next to your profile picture. The page suggests a Linux AppImage or Windows installer for your x64 system and links to the official GitHub downloads. If the repository is private, sign in to GitHub with an account that has access. [Latest release](https://github.com/ZeloteZ/ZeloteZ-Rooms/releases/latest)

Desktop update notifications are optional. Enable them and choose a check interval in Desktop Settings. The app checks which version your verified Rooms instance has published and opens its download page in your browser.

## YouTube browser extension

On YouTube, click **Create ZeloteZ Room** beside **Share** and review the room access options. Guest links and the **Live Now** listing for members are enabled by default. You can set your own defaults in the extension settings or change them for one video. Choose **Open in browser** to use an open Rooms tab for the same account in that browser window. If Rooms opens a new tab, sign in or enter your password under **Unlock chats**, then confirm the video in Rooms.

For **ZeloteZ Rooms Desktop**, open the installed app once and connect to the same Rooms address you entered in the extension. On Linux, make the AppImage executable and start it from the location where you’ll keep it so it can register its link handler. If the desktop app is unavailable, choose **Continue in browser**. [Desktop installation guide](desktop/README.md)

## What stays private

Room and direct chat messages, shared links, attachment names and files, reaction emojis, and moderation reasons are end-to-end encrypted in the browser. Your password unlocks the private key used to read your chats. A direct message's key is wrapped for the sender and recipient. When someone joins a room, an unlocked browser with access automatically shares encrypted copies of the older message keys. The server stores each message and attachment once. Each regular live channel keeps its own chat history between broadcasts.

The server handles room and channel names, membership, senders, timestamps, file sizes, profile and room images, and the account references needed for mentions and reactions. It also supplies the app code, membership lists, and first-seen public keys. A compromised server can change the app or misrepresent membership, so chat privacy depends on a trusted instance. **How it works** in the app explains these boundaries in plain language.

Voice and live video are encrypted in transit. MediaMTX relays live media and FFmpeg adapts audio for playback where needed. Server-side recording is disabled.

For watch parties, YouTube serves its own embedded player and video directly to each viewer. Rooms stores uploaded watch-party videos temporarily in their original form and restricts playback to viewers with access to the channel.

A temporary room’s guest link lets visitors watch, use the live chat, and play, pause, or seek in a watch party. The password in the link’s URL fragment is exchanged for a session limited to that room. The host can revoke or replace it from **Stream access**.

Temporary live chat uses separate keys for each participating browser, including invited guests. The browser keeps its private key locally. While its room access is valid, the same browser can reopen the recent chat it received, including messages sent during its absence. A new browser starts with messages sent after it joins. The server holds the latest 64 encrypted messages in memory until the room closes and can see senders and timestamps.
