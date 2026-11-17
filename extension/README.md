# ZeloteZ Rooms for YouTube

The optional extension adds **Create ZeloteZ Room** beside **Share** on YouTube watch pages. In browser mode, one click creates a private temporary room for the selected video when you already have a Rooms session and no temporary room is open. Otherwise, Rooms opens its sign-in or confirmation screen. Desktop mode opens the configured instance in ZeloteZ Rooms Desktop. The handoff screen also offers **Continue in browser**.

## Install locally

- **Firefox 140 or later**. Open `about:debugging`, select **This Firefox**, choose **Load Temporary Add-on**, and select `manifest.json` or the ZIP. The temporary add-on lasts until Firefox restarts. A permanent Firefox installation requires a Mozilla-signed add-on. [Firefox’s loading instructions](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/)

Click the extension’s toolbar icon to set the HTTPS address of your Rooms instance and choose the browser or desktop app. The browser requests access to that host for verification and the signed-in browser handoff. Reload an already-open YouTube tab after installation. For Desktop mode, install or register the app’s `zelotez-rooms:` link handler and configure the same instance in the desktop app.

The extension saves the address and target locally. It sends the selected video ID through the handoff when you click the YouTube button. The extension checks the server’s Rooms protocol and page marker, and the normal Rooms site handles sign-in. It uses the browser’s existing session for same-origin requests when you are already signed in. It reads no cookies or credentials and stores no viewing history. Choose an instance run by someone you trust.
