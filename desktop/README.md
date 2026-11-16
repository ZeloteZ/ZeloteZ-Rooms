# ZeloteZ Rooms for Linux

The desktop app opens the same Rooms interface as the website. Its native capture window shares a monitor, a region, or an app window through the system’s ScreenCast portal. It requires Libadwaita 1.4 or later, WebKitGTK 6.0, PipeWire, and a graphical session with a ScreenCast portal such as GNOME on Wayland. App window capture requires support from the portal.

## Install on CachyOS or Arch Linux with GNOME

```bash
sudo pacman -S --needed python-gobject python-cairo gtk4 libadwaita libportal libportal-gtk4 \
  pipewire gst-plugin-pipewire xdg-desktop-portal xdg-desktop-portal-gnome \
  gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly \
  gst-plugin-gtk4 gst-libav glib-networking ca-certificates webkitgtk-6.0
```


Enter your server’s HTTPS address on first launch. The app remembers the address on this device. Change it from the server settings in the title bar. Choose English or German at sign-in or in your profile.

## Share your screen

1. Sign in, open a live channel where you can broadcast, and click **Share screen**.
2. Select **Monitor**, **Region**, or **App window**. Confirm the source in the system picker. In **Region** mode, drag a rectangle in the preview.
3. Choose 720p, 1080p, or 1440p and 30 or 60 FPS, then click **Start stream**.
4. The capture window shows a preview, controls, and live statistics. The live channel in the main window shows the audience and the encrypted stream chat. Click **End stream** to stop.

In **App window** mode, play audio in the app, turn on **Include this app’s audio**, and select its PipeWire output. The window and audio choices are separate. If the selected output closes, restart the stream with another audio source or turn off app audio.
