# ZeloteZ Rooms Desktop

The desktop app opens the same Rooms interface as the website. Enter your server’s HTTPS address on first launch, choose **Check address**, then confirm the connection. The check verifies the Rooms protocol and HTTPS on the address you entered. Connect to instances run by someone you trust.

Open **Desktop settings** from the app menu or with Ctrl+, to change local preferences while staying signed in. Friend requests, direct messages, mentions, and opted-in live alerts can also appear as system notifications. By default, the close button asks whether to keep Rooms running in the background or quit. Select **Don’t show this again** to minimize automatically on future clicks. Restore Rooms from the tray or taskbar, depending on your desktop. Change what X does in Desktop settings.

Under **Desktop settings → Desktop updates**, turn on update notifications and choose the check frequency. Update checks start off. The app reads the version from your verified Rooms server. The alert opens that instance's download page in your browser, where you can download the update after signing in.

Upgrade the self-hosted gateway and server together before connecting a current desktop app. The app checks `/api/desktop/instance` and the `X-ZeloteZ-Rooms-Client` header on the main page. Any HTTPS reverse proxy in front of the gateway must pass through that response header.

## Windows and portable Linux

On Windows x64, run the `ZeloteZ-Rooms-…-x64.exe` installer. On Linux x64, mark the AppImage as executable and open it. Use the KDE or GNOME ScreenCast portal and PipeWire for sharing on Wayland.

Rooms requires the Chromium sandbox on Linux. If you see a startup error about the sandbox, refresh any older desktop integration that adds `--no-sandbox` and check your distribution’s documentation for allowing unprivileged user namespaces for this app.

To open YouTube videos from the browser extension, start the installed app once and connect to the same Rooms address in both the app and the extension. On Linux, start the executable AppImage from the location where you’ll keep it. On desktops that support XDG link handlers, it registers `zelotez-rooms:` if no default handler is set. If you move or update the AppImage, run it once to update the entry it manages. If your system uses another handler, choose Rooms in your system’s link settings if available. You can also choose **Continue in browser** from the extension. [Extension installation guide](../extension/README.md)

Open a live channel, choose the resolution and frame rate, then click **Share screen** to select a screen or application window. For a region, enable the crop option and select the area in the local preview before starting.

On Linux, set **Stream audio** to **Application audio** or **System audio** and choose the output when prompted. For application audio, start playback in the app so its output appears in the picker. System audio includes everything played through the selected device. The AppImage uses the PipeWire tools `pw-dump` and `pw-record` from your system for these modes.

On Windows 11, choose **Application audio** and play sound in the app so it appears in the audio picker. For **System audio** on Windows 10 or 11, choose the playback device you want to stream. If your chosen source disconnects, start sharing again to select a source.

With the native capture packages installed, **Share screen** opens the bundled PipeWire capture window for source, region, quality, and audio selection. Once the stream starts, the capture window closes from view and the live channel shows the local preview, duration, resolution, frame rate, upload rate, and stop control. The AppImage uses its built-in capture path on Linux systems without the native requirements.

Viewers get direct, low-latency playback when the WebRTC connection is available. The player can switch to buffered playback. On your own desktop, the local preview shows the selected output as it is captured.

Use Alt to show the application menu on Windows or Linux.

## Native screen capture on Linux

The Linux app uses the system ScreenCast portal for native monitor, region, or app window capture. App window capture requires support from the portal. Install these packages on CachyOS or Arch Linux with GNOME to use the native capture helper.

```bash
sudo pacman -S --needed python-gobject python-cairo gtk4 libadwaita libportal libportal-gtk4 \
  pipewire gst-plugin-pipewire xdg-desktop-portal xdg-desktop-portal-gnome \
  gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly \
  gst-plugin-gtk4 gst-libav glib-networking ca-certificates
```

On KDE Plasma Wayland, use `xdg-desktop-portal-kde` instead of `xdg-desktop-portal-gnome` in that command. Keep the portal backend that matches your active desktop session.

## Share your screen

1. Sign in, open a live channel where you can broadcast, and click **Share screen**.
2. Select **Monitor**, **Region**, or **App window**. Confirm the source in the system picker. In **Region** mode, drag a rectangle in the preview.
3. Choose 720p, 1080p, or 1440p and 30 or 60 FPS, then click **Start stream**.
4. The capture window shows a preview, controls, and live statistics. The live channel in the main window shows the audience and the encrypted stream chat. Click **End stream** to stop.

Use **Application audio** to select a playing app’s PipeWire output or **System audio** to select a playback device. Both work with monitor, region, and window capture. If the selected output closes, restart the stream and choose an available output.
