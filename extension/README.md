# ZeloteZ Rooms for YouTube

The optional extension adds **Create ZeloteZ Room** beside **Share** on YouTube watch pages.

## Install locally

Sign in to GitHub with access to this repository and download [ZeloteZ-Rooms-YouTube.zip](https://github.com/ZeloteZ/ZeloteZ-Rooms/releases/latest/download/ZeloteZ-Rooms-YouTube.zip) from Releases.

- **Firefox 140 or later.** Open `about:debugging`, select **This Firefox**, choose **Load Temporary Add-on**, and select the ZIP. If you extracted it, select `manifest.json`. Reload the add-on after each Firefox restart. A permanent Firefox installation requires a Mozilla-signed add-on. [Firefox’s loading instructions](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/)

Open the extension’s settings from its toolbar icon. Enter the HTTPS address of your Rooms instance without a path, choose where to open Rooms, and grant access to that host when prompted. Reload any YouTube watch page you already had open.

## Choose where Rooms opens

**This browser.** Keep a Rooms tab open for the same account in the same browser window. When that tab is ready and you have no temporary room open, one click starts a private room for the selected video. If Rooms opens a new tab, sign in or use **Unlock chats** to enter your Rooms password, then confirm the video. Rooms only creates the new room after you confirm in that tab.

**ZeloteZ Rooms Desktop.** Start the installed desktop app manually once and finish connecting to the exact same Rooms address as in the extension. On Linux, make the AppImage executable and start it from its permanent location. It registers a link handler on compatible desktops if no default is set. Start it again after moving or updating it so its own entry points to the current file. On the handoff screen, choose **Open desktop app** and confirm the browser prompt if it appears. If the app does not open, choose **Continue in browser**. [Desktop installation and link setup](../desktop/README.md)

The extension saves the address and target locally. It sends the selected video ID through the handoff when you click the YouTube button. The extension checks the server’s Rooms protocol and page marker, and the normal Rooms site handles sign-in. It uses the browser’s existing session for same-origin requests when you are already signed in. It reads no cookies or credentials and stores no viewing history. Choose an instance run by someone you trust.
