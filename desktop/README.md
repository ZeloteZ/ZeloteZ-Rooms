# ZeloteZ Rooms Desktop

The desktop app opens the same Rooms interface as the website. Enter your server’s HTTPS address on first launch, choose **Check address**, then confirm the connection. The check verifies the Rooms protocol and HTTPS on the address you entered. Connect to instances run by someone you trust.

Open **Desktop settings** from the app menu or with Ctrl+, to change local preferences while staying signed in. Friend requests, direct messages, mentions, and opted-in live alerts can also appear as system notifications. By default, the close button keeps the app running. Restore it from the tray or taskbar, depending on your desktop. Turn this off in settings or choose **Quit** to exit.

Upgrade the self-hosted gateway and server together before connecting a current desktop app. The app checks `/api/desktop/instance` and the `X-ZeloteZ-Rooms-Client` header on the main page. Any HTTPS reverse proxy in front of the gateway must pass through that response header.

## Windows and portable Linux

On Windows x64, run the `ZeloteZ-Rooms-…-x64.exe` installer. On Linux x64, mark the AppImage as executable and open it. Use the KDE or GNOME ScreenCast portal and PipeWire for sharing on Wayland.

Open a live channel, choose the resolution and frame rate, then click **Share screen** to select a screen or application window. For a region, enable the crop option and select the area in the local preview before starting.

On Linux, set **Stream audio** to **Application audio** or **System audio** and choose the output when prompted. For application audio, start playback in the app so its output appears in the picker. System audio includes everything played through the selected device. The AppImage uses the PipeWire tools `pw-dump` and `pw-record` from your system for these modes.

With the native capture packages installed, **Share screen** opens the bundled PipeWire capture window for source, region, quality, and audio selection. Once the stream starts, the capture window closes from view and the live channel shows the local preview, duration, resolution, frame rate, upload rate, and stop control. The AppImage uses its built-in capture path on Linux systems without the native requirements.

Viewers get direct, low-latency playback when the WebRTC connection is available. The player can switch to buffered playback. On your own desktop, the local preview shows the selected output as it is captured.

Use Alt to show the application menu on Windows or Linux.

## Share your screen

1. Sign in, open a live channel where you can broadcast, and click **Share screen**.
2. Select **Monitor**, **Region**, or **App window**. Confirm the source in the system picker. In **Region** mode, drag a rectangle in the preview.
3. Choose 720p, 1080p, or 1440p and 30 or 60 FPS, then click **Start stream**.
4. The capture window shows a preview, controls, and live statistics. The live channel in the main window shows the audience and the encrypted stream chat. Click **End stream** to stop.

Use **Application audio** to select a playing app’s PipeWire output or **System audio** to select a playback device. Both work with monitor, region, and window capture. If the selected output closes, restart the stream and choose an available output.
