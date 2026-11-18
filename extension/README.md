# ZeloteZ Rooms for YouTube

The optional extension adds **Create ZeloteZ Room** beside **Share** on YouTube watch pages.

## Install locally

Download [ZeloteZ-Rooms-YouTube.zip](https://github.com/ZeloteZ/ZeloteZ-Rooms/releases/latest/download/ZeloteZ-Rooms-YouTube.zip) from Releases.

- **Firefox 140 or later.** Open `about:debugging`, select **This Firefox**, choose **Load Temporary Add-on**, and select the ZIP. If you extracted it, select `manifest.json`. Reload the add-on after each Firefox restart. A permanent Firefox installation requires a Mozilla-signed add-on. [Firefox’s loading instructions](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/)

Open the extension’s settings from its toolbar icon. Enter the HTTPS address of your Rooms instance without a path, choose where to open Rooms, and grant access to that host when prompted. Reload any YouTube watch page you already had open.

## Choose who can join

**Allow guests with the link** enables a password-protected guest link you can share. **Show in Live Now for members** lets signed-in members find and open the room from Rooms. Both options start enabled. Save your defaults in the extension settings, or change either option for just one video after choosing **Create ZeloteZ Room** on YouTube.

Rooms Web 0.1.22 or later applies these choices when the handoff opens a confirmation page. Use Rooms Desktop 0.1.22 or later for the desktop handoff.

## Choose where Rooms opens

**This browser.** Review the room access options and click **Open in browser**. When a Rooms tab is ready for the same account in that browser window and you have no temporary room open, the extension starts the room in that tab. If Rooms opens a new tab, sign in or use **Unlock chats** to enter your Rooms password, then confirm the video.

**ZeloteZ Rooms Desktop.** Start the installed desktop app manually once and finish connecting to the exact same Rooms address as in the extension. On Linux, make the AppImage executable and start it from its permanent location. It registers a link handler on compatible desktops if no default is set. Start it again after moving or updating it so its own entry points to the current file. On the handoff screen, choose **Open desktop app** and confirm the browser prompt if it appears. If the app does not open, choose **Continue in browser**. [Desktop installation and link setup](../desktop/README.md)

The YouTube handoff tab closes after Rooms Desktop confirms the handoff. This needs Desktop and the Rooms instance on release 0.1.25 or later. If your system still opens an older Desktop version, use **Open an older desktop app** when it appears. The receipt uses a short-lived random ID and omits cookies, account information, and the video ID.

The extension saves your address, target, and default access options locally. It passes the selected video ID and access choices to Rooms when you open the video. The extension checks the server’s Rooms protocol and page marker, and the normal Rooms site handles sign-in. It uses the browser’s existing session for same-origin requests when you are already signed in. It reads no cookies or credentials and stores no viewing history. Choose an instance run by someone you trust.

## License

The extension is source available under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0). Include `LICENSE` and `NOTICE` when distributing the ZIP or an extracted copy. Commercial use outside the license's permissions requires separate authorization from ZeloteZ. Third-party components retain their own licenses. The extension's `LICENSE` is an unchanged copy of the repository's root license.
