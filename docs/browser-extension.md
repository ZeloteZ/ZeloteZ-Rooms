# ZeloteZ Rooms Browser Extension

[Documentation](README.md) · [Deutsch](de/browser-extension.md) · [简体中文](zh-CN/browser-extension.md)

The optional extension adds a **grayscale Rooms logo button** beside **Share** on YouTube watch pages. It creates a temporary YouTube watch party on your chosen Rooms instance. It does not download a YouTube video or bypass YouTube's embedding restrictions.

## Browser support and installation

The manifest targets Chromium browsers from **version 121** and Firefox from **version 140**. Download [ZeloteZ-Rooms-Browser-Extension.zip](https://github.com/ZeloteZ/ZeloteZ-Rooms/releases/latest/download/ZeloteZ-Rooms-Browser-Extension.zip) from the public GitHub release.

| Browser | Install locally |
| --- | --- |
| Chrome, Brave, Edge | Extract the ZIP. Open the extensions manager, enable **Developer mode**, choose **Load unpacked**, and select the directory containing `manifest.json`. |
| Firefox 140+ | Open `about:debugging` → **This Firefox** → **Load Temporary Add-on**, then select the ZIP or extracted `manifest.json`. |

The local Firefox installation is temporary and must be reloaded after a browser restart. Permanent Firefox installation requires a Mozilla-signed package; the supplied ZIP uses the temporary installation method.

Official browser instructions: [Chromium unpacked extensions](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-an-unpacked-extension), [Firefox temporary installation](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).

## Configure your instance

1. Open the extension's settings using its toolbar icon.
2. Enter the Rooms HTTPS origin, for example `https://rooms.example.com`, without a room path or query.
3. Choose whether to open Rooms in this browser or the desktop app.
4. Grant host permission for that instance when prompted.
5. Reload an already-open YouTube watch page.

Connect to an instance you trust and sign in normally in Rooms.

## Share a video

1. Open a YouTube watch page.
2. Click the **grayscale Rooms logo** beside **Share**. The tooltip reads **Create ZeloteZ Room**.
3. Review **Allow guests with the link** and **Show in Live Now for members**.
4. Choose **Open in browser** or the desktop handoff.
5. Sign in or unlock chats in Rooms if requested, then confirm the video there.

Both audience options are enabled by default in the extension. Save different defaults in settings or change them for one video. The guest option creates a password-protected link for that temporary room; the member option controls discovery by signed-in members. [Temporary-room access](streaming.md#start-a-temporary-room)

## Browser handoff

The extension can use an existing Rooms tab for the same account in the same browser window when no temporary room is already active. Otherwise it opens a tab. A new tab may still require sign-in or **Unlock chats** even if another tab has an active session.

Normal Rooms permissions and temporary-room limits apply. You cannot own two temporary rooms simultaneously; return to or end the existing room before creating another.

## Desktop handoff

Install and start [ZeloteZ Rooms Desktop](desktop.md) once. Connect the app and extension to exactly the same Rooms origin.

On Linux, make the AppImage executable and start it from its permanent location to register the `zelotez-rooms:` handler. If moved or updated, start the new file again. Approve the browser's external-application prompt only when you intend to open Rooms.

The handoff tab closes after a compatible desktop client confirms receipt. Web/Desktop **0.1.22+** support the audience options; receipt-based closing requires **0.1.25+**. If an older handler is still selected, choose **Open an older desktop app**, update the handler, or choose **Continue in browser**.

## Permissions and stored data

The extension requests `storage` and `scripting`, runs its content script on YouTube watch pages, and requests optional host access to the Rooms instance you configure. It stores the instance address, target, and audience defaults locally.

On your sharing action it passes the selected YouTube video ID and audience settings to Rooms. Firefox's manifest declares **browsingActivity** because the current video identifies what is being shared. The extension does not request cookie access, read your account password, or maintain a viewing-history database. Same-origin Rooms requests use the browser's existing session; sign-in is handled by Rooms itself.

Desktop handoff receipts use a short-lived random ID and omit cookies, account details, and the video ID. YouTube still serves its own embedded player and media to viewers. [Privacy and external services](security.md)

## Update or remove the extension

For an unpacked Chromium install, replace the extracted files with the intended release and reload the extension in the manager. Reinstall/reload the Firefox temporary add-on as needed. Reload YouTube tabs after changes. Use the browser's extension manager to disable or remove it.

If the button does not appear or the handoff fails, confirm the configured origin, host permission, signed-in/unlocked Rooms state, and protocol compatibility. See [troubleshooting](troubleshooting.md).

## License

The extension is provided under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0). Keep the included `LICENSE` and `NOTICE` files when sharing a downloaded copy. Commercial use outside the license permissions requires separate authorization; third-party components retain their own terms. See [project licensing](../LICENSING.md).
