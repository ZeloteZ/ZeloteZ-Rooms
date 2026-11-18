# ZeloteZ Vault

[English](vault.md) · [Deutsch](de/vault.md) · [简体中文](zh-CN/vault.md) · [Documentation](README.md)

Vault gives each member private, end-to-end encrypted file storage and read-only file sharing. It is optional and disabled on new instances. It uses your existing account encryption identity; no additional cloud account is required.

## Enable and allocate storage

The operator opens **Administration → ZeloteZ Vault**, confirms owner access with an authenticator code, enables Vault, and saves the storage limit. The default is **2 GiB per account**. The limit applies individually to every account.

The limit includes encrypted data, encrypted metadata, and reserved space for unfinished uploads. Encryption adds a small amount of storage overhead. A small amount of technical protection data can remain allocated after deleting files. Lowering the limit keeps existing files; accounts above the limit can still download and delete, but cannot allocate more storage.

Disabling Vault blocks uploads, downloads, and both kinds of shares. Completed files remain stored for later reactivation. Unfinished uploads are discarded. Operators must also provide enough disk space for all accounts and include the application data volume in [backups](operations.md).

## Manage files

1. On the Rooms overview, select **ZeloteZ Vault** below **Live now** on the right. The entry appears only when Vault is enabled.
2. Switch between the **My vault** and **Shared with me** tabs. The banner's breadcrumb trail shows the current location; select a parent folder to return to it. For deeper paths, **…** opens the other ancestors.
3. Create folders, choose **Upload files**, or drop files into the file manager. Multiple files are processed in sequence.
4. Select a file's name to open its local preview, player, or editing tools. The item menu provides **Play** for audio/video and **Open and edit** for editable formats, as well as **Download**, renaming, moving, sharing, and deletion. Only files can be shared; folders organize your own storage.
5. Search and sort the current folder. When its contents exceed the available space, use the previous/next page buttons. The page size adapts to your window, keeping the banner, tabs, and controls in view without scrolling the whole page.

Active transfers appear as compact progress notifications and can be cancelled there. Completed and cancelled transfers produce a notification and leave no permanent history panel. Keep the Vault view open until a transfer finishes; leaving it or signing out cancels active work. An incomplete upload is not a downloadable file and its reservation is released on cancellation or stale-upload cleanup. Deleting a folder also deletes its contents and their shares. Deletion cannot be undone.

Open the gear button **Vault settings** for the privacy information and optional desktop file-manager integration.

## Open, play, and edit locally

Select a file name, **Play** for audio/video, or **Open and edit** for an editable file in its menu. The file is authenticated and decrypted on your device; previewing and editing do not send plaintext to the server or an external editing service. HTML, SVG, and source code are handled as plain text and never executed in the editor. Public sharing links continue to provide downloads; these editing tools are part of the signed-in Vault.

| File type | Available tools | Local limits |
| --- | --- | --- |
| Images, including PNG, JPEG, WebP, GIF, BMP, and AVIF | Crop edges, rotate, flip horizontally or vertically, and export as PNG, JPEG, or WebP | 128 MiB input and 33,554,432 decoded pixels |
| Videos and audio that your browser can decode | Local player with playback controls | 128 MiB input; available codecs depend on your browser |
| PDF | Preview individual pages, reorder, rotate, delete pages, and position text notes | 64 MiB input, up to 500 pages; at least one page must remain |
| UTF-8 text, Markdown, JSON, CSV, configuration files, and common source-code formats | Edit text, toggle line wrapping, and see line/character counts; JSON syntax is checked before saving | 2 MiB of UTF-8 text |

Image exports are static and remove the source image's metadata; animated images become a static image. Exported editing copies are limited to 128 MiB.

Audio and video open in a local player and are not edited or exported in Vault. Playback requires a codec supported by your browser. For unsupported codecs or files above the player limit, download the original and open it in a suitable local application.

PDF previews are passive. Saved PDF copies remove interactive links, forms, attachments, and embedded scripts. Added notes are embedded as image overlays, so their text is not selectable. Existing page content remains page content; this is page management and annotation, not a full document-layout editor. Password-protected or unsupported PDFs may not open.

For images, PDFs, and text, choose a copy name and **Save encrypted copy**. Each save uploads a new file with fresh encryption; the original file and its existing shares remain unchanged. An edited copy of your own file is saved in the same folder. An edited copy of a member share is saved in the root of **My vault** and belongs to you; it does not change the sender's file. Saving a copy needs enough free Vault storage for the additional file. Share the new copy separately if needed.

Unsaved changes remain only in the open editor. Closing an editor with unsaved edits asks for confirmation. Leaving Vault or signing out cancels work and discards local edits. There is no automatic draft recovery.

Other formats, including office documents and archives, can be stored, shared, and downloaded for a suitable local application. They do not have built-in editing tools.

## Download files

Downloads are decrypted on your device and saved as ordinary files. Browsers with a supported save-file picker can save large files in chunks. Other browsers support downloads up to **128 MiB per file**. For larger files, use a compatible Chromium browser. Your own files and member shares can also be saved through the desktop client; public links open in your browser. Downloads are not opened automatically. The editing limits above do not restrict ordinary uploads or supported streaming downloads within your account's storage limit.

## Play together in a room

For an audio or video file in your own Vault, choose **Play in a room** in its file menu or player. Files up to **128 MiB** are supported. Choose a room you have joined and one of its live channels; your account must be allowed to start playback there.

- If no watch party is active, choose **Play together here** to prepare a synchronized watch party.
- If a watch party is already active, choose **Add to queue** to play your file after the current item.

The confirmation creates a dedicated, revocable **24-hour encrypted share**. Its access capability and decryption key are encrypted for the members allowed to access the channel at the time of sharing. They are not placed in a chat message or the room navigation URL. The server stores encrypted content and the encrypted playback envelope; it does not receive the file's decryption key.

After confirmation, **Go to room** opens the selected channel and watch party. The local player stays in place until you choose to navigate. Members use the room's synchronized playback controls and may need to enable playback on their device. Supported codecs depend on each member's browser.

The original remains in Vault. Ending the watch party or leaving the room does **not** automatically revoke this share. Revoke it in the original file's **Share → Active shares** list when needed; otherwise it expires after 24 hours. As with other shares, downloaded copies and keys already obtained cannot be recalled. Room membership changes do not retract a capability already received.

A received member share cannot be forwarded directly into a room. You must first place a file of your own in **My vault**, for example by downloading and uploading your own copy. Creating room playback requires an explicit confirmation; opening the private player alone does not share anything.

## Share a file

Open a file's **Share** menu and choose an expiry:

- **Member:** search for an active Rooms member and select the intended account. The recipient finds the file under **Shared with me** and needs their own account encryption key to open it.
- **Link:** create a link for someone without a Rooms account. Send the complete link privately. The part after `#` contains the access capability and decryption key. The decryption key is not sent to the server. The receiving page removes these secrets from the address bar after opening the link.

Treat a full sharing link like the file itself: anyone holding it can download and forward the file until the share expires or is revoked. You can show an existing link again from its share list; its saved copy is encrypted for your account.

Use the share list to **revoke** access. Deleting the original file also ends its shares. Revocation, expiry, or suspending the sender prevents subsequent access through Rooms; it cannot delete copies or keys a recipient has already obtained. Existing shares keep their encrypted filename snapshot after a rename.

## Optional file-manager menu

In the Windows or Linux desktop app, open the gear button **Vault settings → File manager integration**. Installation and removal are explicit actions with a native confirmation. A browser alone cannot install an operating-system context menu.

The entry is named **Share securely via Vault**. Windows Explorer is supported. On Linux, available **Files/Nautilus, Nemo, Caja, Dolphin, and Thunar** installations are detected automatically. GNOME Files and Caja expose scripts in their **Scripts** submenu; Windows 11 may place the entry under **Show more options**. Reopen the file-manager window if its menu has not refreshed.

Select a local file or folder and invoke the entry. Rooms opens Vault, shows the destination instance and selection for confirmation, creates a ZIP locally, and encrypts it in chunks before uploading. No unencrypted temporary ZIP is written to disk. The originals remain unchanged. After uploading, choose a recipient or create a link in the sharing dialog. If another dialog is still open, a notification directs you to the uploaded ZIP’s file menu instead.

Folders include their regular contents, including hidden files. Symbolic links and special files are rejected; changed files, unsafe archive paths, and selections exceeding the configured limits abort the operation. Keep selected files unchanged until completion.

Select **Remove context menu** to remove the managed entries. Other custom actions are preserved. Keep a Linux AppImage in its permanent location; after moving it or updating to a different path, install the integration again to update the launcher.

## Privacy and recovery

Contents, filenames, folder names, and file types are encrypted before upload. The server does see account ownership, sizes, timestamps, folder relationships, and sharing relationships. Shared files are read-only, and a recipient does not receive access to the rest of your Vault.

A normal password change preserves your encrypted files. Account recovery without the previous encryption password does not decrypt existing Vault files. The operator cannot recover their contents without your account key. Keep independent copies of important data.

Use a trusted instance and device. As with encrypted Rooms chats, the instance delivers the application interface: altered client code or a compromised device can undermine protection at the endpoint. See [security and privacy](security.md) for these trust boundaries.
