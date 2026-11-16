# ZeloteZ Rooms Desktop

## Windows and portable Linux

On Windows x64, run the `ZeloteZ-Rooms-…-x64.exe` installer. On Linux x64, mark the AppImage as executable and open it. Use the KDE or GNOME ScreenCast portal and PipeWire for sharing on Wayland.

Open a live channel, choose the resolution and frame rate, then click **Share screen** to select a screen or application window. For a region, enable the crop option and select the area in the local preview before starting.

On Linux, set **Stream audio** to **Application audio** or **System audio** and choose the output when prompted. For application audio, start playback in the app so its output appears in the picker. System audio includes everything played through the selected device. The AppImage uses the PipeWire tools `pw-dump` and `pw-record` from your system for these modes.

Open **Server settings** with Ctrl+, to change your server address. Use Alt to show the application menu on Windows or Linux.

## Share your screen

1. Sign in, open a live channel where you can broadcast, and click **Share screen**.
2. Select **Monitor**, **Region**, or **App window**. Confirm the source in the system picker. In **Region** mode, drag a rectangle in the preview.
3. Choose 720p, 1080p, or 1440p and 30 or 60 FPS, then click **Start stream**.
4. The capture window shows a preview, controls, and live statistics. The live channel in the main window shows the audience and the encrypted stream chat. Click **End stream** to stop.

Use **Application audio** to select a playing app’s PipeWire output or **System audio** to select a playback device. Both work with monitor, region, and window capture. If the selected output closes, restart the stream and choose an available output.
