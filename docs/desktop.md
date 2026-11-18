# Desktop client

[Documentation](README.md) · [Deutsch](de/desktop.md) · [简体中文](zh-CN/desktop.md)

The desktop client provides Rooms with system integration, capture controls, optional notifications, and protected sign-in storage. You still need the address and account of a trusted Rooms instance.

## Available packages

Official downloads target **Windows x64** and **Linux x64**. A server image's arm64 support does not imply an arm64 desktop package. No official macOS installer is configured here.

Download the installer or AppImage from the [latest GitHub release](https://github.com/ZeloteZ/ZeloteZ-Rooms/releases/latest), or choose **Client** beside your profile in Rooms.

### Windows

Run `ZeloteZ-Rooms-<version>-x64.exe` and follow the installer. Allow capture/microphone access only when you intend to use it. **System audio** is supported on Windows 10/11; **Application audio** requires Windows 11. Play sound in the desired application so its output can be selected.

The experimental Rooms Capture backend requires Windows 10 version 1903 or later and compatible D3D11 graphics. Backend availability is checked; actual capture and performance still depend on hardware and system support.

### Linux AppImage

Place `ZeloteZ-Rooms-<version>-x86_64.AppImage` where it will remain, mark it executable, and run it:

```sh
chmod +x /path/to/ZeloteZ-Rooms-VERSION-x86_64.AppImage
/path/to/ZeloteZ-Rooms-VERSION-x86_64.AppImage
```

Replace `VERSION` with the downloaded version and the path with the actual location.

On Wayland, use PipeWire and the ScreenCast portal backend for your active desktop, such as GNOME or KDE. Distribution-level AppImage runtime requirements also apply. Rooms requires Chromium's sandbox: do not fix startup failures by adding `--no-sandbox`. Refresh older launcher entries that still contain that argument and consult your distribution's user-namespace policy if the sandbox cannot start.

## Connect to your instance

1. Enter the instance's HTTPS origin, for example `https://rooms.example.com`, without a room path.
2. Choose **Check address**, inspect the result, then confirm the connection.
3. Sign in with your account on that instance.
4. Open a room and use the same chat and media controls as in the browser.

The address check verifies that the selected HTTPS instance can be reached by the client. You must still choose an operator you trust.

## Settings, notifications, and closing

Open **Desktop settings** from the app menu or press **Ctrl+,**. Use **Alt** to reveal the menu on Windows/Linux. Local settings include the instance connection, optional system notifications, close behavior, and update checks.

By default, closing the window asks whether to keep Rooms in the background or quit. **Don't show this again** selects automatic minimizing for future closes; change the preference in settings if needed. Restore the client from its tray/menu/taskbar integration. Background operation and notification presentation depend on the desktop environment.

Notifications can cover friend requests, direct messages, mentions, and opted-in live alerts. The in-app bell remains available even when OS notifications are disabled.

## Sign-in storage

**Keep me signed in on this device** uses protected OS storage for the session and chat-unlock material until the session expires or you sign out. It is separate from merely leaving an ordinary browser session open.

On Linux, Rooms accepts only system-backed encrypted storage and rejects Chromium's fixed-key fallback. If the keyring is locked or secure storage is unavailable, sign in manually; remembering the login may be unavailable. Each instance's remembered data is scoped to its origin. Sign out on shared or untrusted devices.

## Capture and audio

Choose **Share screen** in a channel where you may broadcast. Select monitor, window, or region, approve the system picker, choose quality and audio, and start. Region capture uses a crop rectangle in the preview. When embedded preview support is available, the native Linux capture window is hidden after going live; the main live-channel view then shows the preview, duration, resolution, FPS, upload rate, and stop control. Otherwise, the native helper uses its own capture window.

On Linux, application and system audio use PipeWire outputs. Start playback before selecting an application. `pw-dump` and `pw-record` are required for the AppImage's PipeWire audio path. If the selected output disconnects, stop and restart with an available output.

**Standard** is the default engine. **Rooms Capture** is experimental and appears only when its backend is available. See [streaming](streaming.md) for quality targets, statistics, limitations, and direct/buffered playback.

### Optional native Linux helper

The helper needs Python GObject/Cairo, GTK 4, Libadwaita, libportal with GTK 4, PipeWire, GStreamer and the capture/encoding plugins. The AppImage uses its built-in capture path when native requirements are unavailable.

On CachyOS/Arch Linux with GNOME, the existing dependency set is:

```sh
sudo pacman -S --needed python-gobject python-cairo gtk4 libadwaita libportal libportal-gtk4 \
  pipewire gst-plugin-pipewire xdg-desktop-portal xdg-desktop-portal-gnome \
  gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly \
  gst-plugin-gtk4 gst-libav glib-networking ca-certificates
```

On KDE Plasma, use `xdg-desktop-portal-kde` in place of the GNOME backend. Other distributions use different package names; install their equivalents rather than copying a package command for another distribution. Package reference: [Arch's gst-plugin-gtk4](https://archlinux.org/packages/extra/x86_64/gst-plugin-gtk4/).

The helper checks for required GStreamer elements, including `pipewiresrc`, `gtk4paintablesink`, `x264enc`, `h264parse`, `flvmux`, and `rtmp2sink`, plus an AAC encoder for audio. Native Linux streaming uses CPU x264 and verifies the RTMPS server certificate using the system trust store.

## Browser-extension links

Start the installed app once and connect it to exactly the same Rooms origin as the [Browser Extension](browser-extension.md). On Linux, start the executable AppImage from its permanent location to create/update the menu entry and link handler. Start it again after moving it or updating to a new file.

On desktops supporting XDG link handlers, Rooms registers `zelotez-rooms:` if no default exists and consolidates recognized old AppImage launchers. If another handler is already selected, choose Rooms in your system's link settings or use the extension's **Continue in browser** option.

## Update the client

Update checks are **off by default**. Enable them under **Desktop settings → Desktop updates** and choose 1, 6, 24, or 168 hours between checks. The client checks the official public GitHub release API without credentials, compares the version, and opens the release page in your browser. It does not silently replace the installed client.

A failed check can also mean an offline connection, a rate limit, or invalid release metadata; use the release link manually. Update the server and gateway together when the client needs a newer instance protocol. Client and server updates are separate operations.

## Verify a download

Official desktop releases provide SHA-256 sidecars and an Ed25519-signed installer manifest. Obtain `desktop-release-manifest.json`, `desktop-release-manifest.sig`, your installer, and an independently trusted copy of [the release public key](../desktop/release-public.pem). From a repository checkout, run:

```sh
python3 deploy/desktop-release-signature.py verify VERSION \
  --source /path/to/downloads --trusted-key /path/to/trusted-public.pem --platform linux
```

Use `--platform windows` for the Windows installer. Replace `VERSION` with the intended numeric version, without the leading `v`.

On Windows, OpenSSL can check the signature with `openssl pkeyutl -verify -pubin -rawin -inkey public.pem -in desktop-release-manifest.json -sigfile desktop-release-manifest.sig`. Then compare the Windows installer's exact filename, size, and SHA-256 hash (`Get-FileHash -Algorithm SHA256`) to the verified manifest. A checksum from the same untrusted source alone does not establish authenticity. The signed installer manifest does not cover the browser-extension ZIP.
