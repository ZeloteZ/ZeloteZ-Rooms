# Voice, streams, and watch parties

[Documentation](README.md) · [Deutsch](de/streaming.md) · [简体中文](zh-CN/streaming.md)

You need an account and room membership for regular live channels. Sharing also depends on the room and channel streaming policies. [Roles and permissions](user-guide.md#roles-and-controls)

## Choose a media mode

| Mode | Best fit | How it works |
| --- | --- | --- |
| Voice chat | Conversation while browsing Rooms | Join to listen; enable your microphone separately. |
| Screen stream | Show a screen, window, tab, or desktop region | Browser capture or the desktop client sends live media to the streaming server. |
| YouTube watch party | Watch an existing YouTube video together | YouTube serves an embedded player to each viewer; Rooms synchronizes controls. |
| Local-video watch party | Watch an MP4 or WebM together | Rooms uploads the original video temporarily and serves it to authorized viewers. |

Voice and live media are encrypted in transit and relayed by MediaMTX; they are not end-to-end encrypted between participants. Chat has a separate encryption model. [Security and privacy](security.md)

## Join a voice chat

1. Open a live channel and choose **Join voice chat**.
2. You begin by listening. Turn on your microphone to speak and allow microphone access when your browser or system asks.
3. Use the header's voice controls to mute, change your state, or return to the channel while browsing elsewhere.
4. Leave voice when you are done.

A denied microphone permission does not need to stop listening. If there is no sound or the connection keeps reconnecting, check browser permissions and the instance's reachable media ports in [troubleshooting](troubleshooting.md).

## Share from a browser

1. Open a live channel where sharing is permitted and choose **Share screen**.
2. Select a monitor, application window, or browser tab in the browser/system picker.
3. Enable a supported audio option if offered; available audio sources depend on the browser, OS, and chosen capture source.
4. Confirm sharing. Use the live-channel view for your preview, audience, chat, and sending statistics.
5. End the stream using the Rooms stop control or the browser's sharing control.

Keep the source tab/window and client open while streaming. A browser that does not provide the required display-capture or codec support cannot use this path. Use your instance through HTTPS for browser sharing.

Each account can reserve or publish one live stream at a time. The instance allows up to **eight simultaneous streams**. An abandoned reservation or connection interruption can temporarily occupy a slot until cleanup.

## Share from the desktop client

The desktop capture dialog brings source, crop, quality, and audio into one workflow. Use a monitor, window, or region; confirm OS permissions, select the region in the preview when needed, then start.

On the native Linux helper, the quality presets are:

| Output | 30 FPS video target | 60 FPS video target |
| --- | --- | --- |
| 720p | 3 Mbit/s | 4.5 Mbit/s |
| 1080p | 5 Mbit/s | 7.5 Mbit/s |
| 1440p | 8 Mbit/s | 11 Mbit/s |

These are encoder targets, not guaranteed measured rates. Leave additional upload capacity for audio and overhead. The Linux native publisher uses CPU x264 encoding. Higher resolution/frame rate increases processing and bandwidth requirements.

**Standard** is the default capture engine. **Rooms Capture** is an experimental alternative when its backend is available. Its availability depends on your operating system and capture support. It does not guarantee better performance than Standard. Validate it on your hardware and fall back to Standard if needed.

For installation, platform audio options, and native dependencies, see the [desktop guide](desktop.md).

## Watch a live stream

Select the broadcast in a live channel. **Direct** playback uses WebRTC for lower latency. **Buffered** playback uses HLS and adds delay; it can be useful when the direct path is unreliable. Availability still depends on a correctly configured streaming server.

Playback and volume controls remain reachable as you move through Rooms. Use the mini/floating player and room sidebar controls to arrange the view. Your volume is local to you; it does not alter someone else's volume.

## Start a watch party

Choose **Share video** and either supply a YouTube link or select an MP4/WebM file up to **256 MiB**. A file extension alone does not guarantee compatible media; the server validates the upload and playback still requires codecs supported by the viewers' browsers.

Members permitted to share can add or remove queued items. The queue supports up to **16 upcoming items**. Play, pause, and seek are synchronized; each viewer keeps their own volume. Uploaded videos use 4 MiB chunks, so operators must allow those requests through their proxy.

A watch video follows you into the mini player as you browse. YouTube pauses when the last viewer closes or hides their player. YouTube may impose its own availability or embedding restrictions.

Uploaded watch videos are temporary originals, not encrypted chat attachments. Party and queue state are held in memory and do not survive a server restart; uploaded watch files are cleaned at startup and on expiry/cleanup. Do not use a watch party as a video archive.

## Start a temporary room

From the room overview, choose a screen, YouTube video, or local file and select a temporary room instead of a persistent live channel. Review the audience before sharing:

- **Live now for members** controls whether signed-in members can discover the room.
- **Guest access** creates a password-protected guest link.
- The host can change the audience, revoke the guest link, or replace its password under **Stream access**.

Guest links include a secret in the URL fragment. Anyone holding the complete valid link can access that room, so share it with the intended viewers. A guest can watch, use the temporary live chat, and use watch-party play/pause/seek; a guest link is not an account invitation or access to the rest of the instance.

You can own one temporary room at a time. There are up to **24** temporary rooms per instance. An unused draft expires after **five minutes**; a used room has a maximum lifetime of **12 hours** and also depends on the host's session remaining active. The host can end it sooner.

Temporary chat is distinct from persistent channel history. The server keeps the last **64 encrypted messages** in memory until the room ends. A new browser starts receiving messages after joining; a returning browser with the same valid access and local keys can reopen recent messages it received, including while absent. [Retention and privacy](security.md)

## Understand the statistics

Turn on **Video reception statistics** in your profile to show local viewing time, received resolution, measured FPS, incoming video rate, packet loss, jitter, dropped frames, and codec where available. The setting is off by default and updates an open player. Sending statistics are shown for active screen streams.

- WebRTC measurements describe the active sending or receiving connection.
- HLS data rate measures downloaded media bytes and can vary as buffers fill.
- Sender network metrics describe the connection from the sender to the streaming server, not all viewers.
- Native RTMP and HLS do not expose all RTP loss/jitter values. Unsupported measurements show a dash.
- Embedded YouTube playback does not expose the Rooms receiver statistics.

The counters help diagnose a path; they do not certify the quality seen by every viewer. Compare them with [troubleshooting](troubleshooting.md) and your CPU/network load.
