# ZeloteZ Vault

[English](vault.md) · [Deutsch](de/vault.md) · [简体中文](zh-CN/vault.md) · [Documentation](README.md)

Vault gives each member private, end-to-end encrypted file storage and read-only file sharing. It is optional and disabled on new instances. It uses your existing account encryption identity; no additional cloud account is required.

## Enable and allocate storage

The operator opens **Administration → ZeloteZ Vault**, confirms owner access with an authenticator code, enables Vault, and saves the storage limit. The default is **2 GiB per account**. The limit applies individually to every account.

The limit includes encrypted data, encrypted metadata, and reserved space for unfinished uploads. Encryption adds a small amount of storage overhead. A small amount of technical protection data can remain allocated after deleting files. Lowering the limit keeps existing files; accounts above the limit can still download and delete, but cannot allocate more storage.

Disabling Vault blocks uploads, downloads, and both kinds of shares. Completed files remain stored for later reactivation. Unfinished uploads are discarded. Operators must also provide enough disk space for all accounts and include the application data volume in [backups](operations.md).

## Manage files

1. On the Rooms overview, select **ZeloteZ Vault** below **Live now** on the right. The entry appears only when Vault is enabled.
2. The first column, **Files**, contains your own files and folders and the **Shared With Me** folder. Open **Shared With Me → sender's username** to browse that member's read-only shares.
3. Open a folder to show its contents in the next column. The root column and up to two subfolder columns are visible together. Narrow windows automatically show fewer folder columns, without a horizontal scrollbar. Deeper folders reuse the rightmost column. The banner's breadcrumbs retain the complete path; select an ancestor to return, or use **…** to reach ancestors hidden from the breadcrumb bar.
4. Select a file row to open its viewer, player, or archive browser beside the folders. Files open for viewing first; editing starts only after you choose **Open editor**. The preview stays open while you browse other folders. Use **×** in the preview to close the file.
5. Right-click a row or use its **⋯** button for actions such as **Open**, **Download**, renaming, moving, sharing, and deletion. The menu also opens with the keyboard's context-menu key or **Shift+F10**. Available actions depend on the item; received shares cannot change the sender's original file.
6. Create folders, choose **Upload files**, or drop local files into one of your own folders. Multiple files upload in sequence. To move your own Vault files or folders, drag them onto another own folder or the root breadcrumb, or choose **Move** in the item menu. A folder cannot be moved into itself or one of its descendants. **Shared With Me** and its sender folders are read-only destinations. Only files can be shared; folders organize your own storage.
7. Search and sort the current folder. Long lists scroll inside their columns, and the preview scrolls within its own area; the banner and overall page stay in place. There are no previous/next pages.

Active transfers appear as compact progress notifications and can be cancelled there. Completed and cancelled transfers produce a notification and leave no permanent history panel. Keep the Vault view open until a transfer finishes; leaving it or signing out cancels active work. An incomplete upload is not a downloadable file and its reservation is released on cancellation or stale-upload cleanup. Deleting a folder also deletes its contents and their shares. Deletion cannot be undone.

Open the gear button **Vault settings** for the privacy information and optional desktop file-manager integration.

## Open, play, and edit locally

Select a file row or choose **Open** in its menu. The file opens first in a read-only viewer in the separate preview area. For images, PDFs, text, and supported Office files, choose **Open editor** to start editing; **Back to viewer** returns to the read-only view. Audio and video use the player, and archives use the archive browser.

The file is authenticated and decrypted on your device; previewing and editing do not send plaintext to the server or an external editing service. HTML, SVG, and source code are handled as plain text and never executed in the viewer or editor. Public sharing links continue to provide downloads; these viewing and editing tools are part of the signed-in Vault.

| File type | Available tools | Local limits |
| --- | --- | --- |
| Images, including PNG, JPEG, WebP, GIF, BMP, AVIF, and validated ICO icons | Crop edges, rotate, flip horizontally or vertically, and export as PNG, JPEG, or WebP | 10 GiB input and 33,554,432 decoded pixels |
| Videos and audio, including supported MKV files | Local player with playback controls | 10 GiB input; available codecs depend on your browser and operating system |
| PDF | Preview individual pages, reorder, rotate, delete pages, and position text notes | 64 MiB input, up to 500 pages; at least one page must remain |
| Text, Markdown, JSON, CSV, configuration files, and common source-code formats | Edit UTF-8 or BOM-marked UTF-16 text, toggle line wrapping, and see line/character counts; JSON syntax is checked before saving | 2 MiB including encoding and BOM |
| DOCX documents and XLSX spreadsheets | Edit paragraphs, tables, and spreadsheet cells; save a simplified DOCX or XLSX copy | 32 MiB input; 2 MiB of text, 20,000 cells, 2,000 rows, 64 columns per row, and 20 worksheets |
| ZIP, TAR, TAR.GZ, and TGZ archives | Browse folders, open supported member files locally, download a member, or save it as a new encrypted Vault file | 64 MiB input, 128 MiB expanded content, 2,000 entries; up to 32 MiB per extracted file |

Media input supports up to **10 GiB (10,737,418,240 bytes)** per file, subject to your Vault storage allowance. Files are authenticated and decrypted in chunks before opening; large files take time to prepare. The browser manages the resulting local data and may use temporary files on your device. Sufficient local storage and browser quota are required; availability also depends on your device and decoder. Closing the preview releases its references, but secure erasure of browser temporary storage is not guaranteed. The server receives neither plaintext nor decryption keys. Image dimensions are checked before decoding; the separate pixel limit remains in place.

Image decoding reads at most **512 MiB of encoded data** to produce the first frame. An image whose first frame needs more data cannot be opened locally. If your browser cannot decode that image format from a stream, the fallback supports images up to **128 MiB** instead. Image size on disk and decoded pixel count are separate limits; the 10 GiB input allowance does not guarantee that every image can be decoded on every device.

Image exports are static and remove the source image's metadata; animated images become a static image. Exported editing copies are limited to 128 MiB.

Audio and video open in a local player and are not edited or exported in Vault. MKV playback supports combinations such as H.264/AAC and VP9/Opus when the browser and operating system provide the required codecs. An MKV filename alone does not guarantee playback. For unsupported codecs or files above the player limit, download the original and open it in a suitable local application.

For supported MKV and MP4 files, **Audio** and **Subtitles** controls appear when multiple audio tracks or embedded subtitles are available. **Original audio (default)** restores the file's initial audio choice; **Off** disables subtitles. Embedded SRT and simple ASS text in MKV, and `mov_text` subtitles in MP4, can be displayed as passive text captions. ASS layout and styling are not preserved. Bitmap subtitle formats such as PGS are unavailable and shown as disabled choices; download the original for a suitable local player. Tracks come from the locally decrypted file, without contacting an external subtitle service. Your choices apply only on your device, including during Vault playback in a room: every viewer chooses independently, and the room's shared playback state and other viewers' language choices are unchanged.

Track inspection has separate safety limits: **64 tracks**, **16 MiB of metadata**, and **32 MiB of local file reads per inspection**. Text subtitles are limited to **20,000 captions and 2 MiB of text**. MKV subtitle text is read when you select its track. Exceeding these limits can make a subtitle track or custom track selection unavailable even when normal playback still works. Use the original audio choice or download the file for a suitable local player.

Text copies preserve the detected UTF-8 or UTF-16 LE/BE encoding, BOM, and line-ending style. UTF-16 input needs a BOM for automatic detection. Invalid Unicode and binary data are refused; other text encodings must be converted in a suitable local application first.

Office editing creates a simplified copy of the document's paragraphs and tables or the workbook's cells. Complex layout, images, charts, and embedded objects are omitted. Formulas are displayed and saved as text; they are not calculated, and macros or external data connections are not run. Use the original in a suitable Office application when you need those features or exact layout preservation. The cell, row, and text limits apply across the entire document or workbook. Office contents are additionally limited to 16 MiB after decompression and 4 MiB per XML part.

Inside an archive, select a file and choose **Open selected file**, **Download selected file**, or **Save to Vault**. Opening a member remains local. Use **Back to archive** to return from its preview to the archive contents. **Save to Vault** creates one new file under the member's name, with fresh encryption, in the original archive's Vault folder. For a member-shared archive, the copy goes to the root of **Files**. Archive folders provide navigation; they are not imported as a Vault folder tree. The original archive and its shares stay unchanged. Larger members remain listed, but local opening, extraction, and individual downloads are disabled above 32 MiB; use **Download original archive** instead. The expanded-content limit also bounds extracted data during one opening. ZIP64, password-protected ZIPs, symbolic or hard links, and unsupported compression methods require a suitable local application. Unsafe or damaged archives are refused.

PDF previews are passive. Saved PDF copies remove interactive links, forms, attachments, and embedded scripts. Added notes are embedded as image overlays, so their text is not selectable. Existing page content remains page content; this is page management and annotation, not a full document-layout editor. Password-protected or unsupported PDFs may not open.

For images, PDFs, text, and supported Office files, choose a copy name and **Save encrypted copy**. Each save uploads a new file with fresh encryption; the original file and its existing shares remain unchanged. An edited copy of your own file is saved in the same folder. An edited copy of a member share is saved in the root of **Files** and belongs to you; it does not change the sender's file. Saving a copy needs enough free Vault storage for the additional file. Share the new copy separately if needed.

Unsaved changes remain only in the open editor. Returning to the viewer, switching files, closing the editor, or leaving Vault asks you to confirm whether to discard them. Signing out or the end of your session cancels work immediately and discards local edits. There is no automatic draft recovery.

Other formats can still be stored, shared, and downloaded for a suitable local application. Office formats beyond DOCX and XLSX, such as PPTX, ODT, ODS, and older DOC or XLS files, do not have built-in editing tools.

## Download files

Downloads are decrypted on your device and saved as ordinary files. Browsers with a supported save-file picker can save large files in chunks. Other browsers support downloads up to **128 MiB per file**. For larger files, use a compatible Chromium browser. Your own files and member shares can also be saved through the desktop client; public links open in your browser. Downloads are not opened automatically. The editing limits above do not restrict ordinary uploads or supported streaming downloads within your account's storage limit.

## Play together in a room

For an audio or video file in your own Vault, choose **Play in a room** in its file menu or player. Files up to **10 GiB** are supported. Choose a room you have joined and one of its live channels; your account must be allowed to start playback there.

- If no watch party is active, choose **Play together here** to prepare a synchronized watch party.
- If a watch party is already active, choose **Add to queue** to play your file after the current item.

The confirmation creates a dedicated, revocable **24-hour encrypted share**. Its access capability and decryption key are encrypted for the members allowed to access the channel at the time of sharing. They are not placed in a chat message or the room navigation URL. The server stores encrypted content and the encrypted playback envelope; it does not receive the file's decryption key.

After confirmation, **Go to room** opens the selected channel and watch party. The local player stays in place until you choose to navigate. Members use the room's synchronized playback controls and may need to enable playback on their device. Supported codecs depend on each member's browser.

The original remains in Vault. Ending the watch party or leaving the room does **not** automatically revoke this share. Revoke it in the original file's **Share → Active shares** list when needed; otherwise it expires after 24 hours. As with other shares, downloaded copies and keys already obtained cannot be recalled. Room membership changes do not retract a capability already received.

A received member share cannot be forwarded directly into a room. You must first place a file of your own in **Files**, for example by downloading and uploading your own copy. Creating room playback requires an explicit confirmation; opening the private player alone does not share anything.

## Share a file

Open a file's **Share** menu and choose an expiry:

- **Member:** search for an active Rooms member and select the intended account. The recipient finds the file under **Shared With Me → sender's username** and needs their own account encryption key to open it.
- **Link:** create a link for someone without a Rooms account. Send the complete link privately. The part after `#` contains the access capability and decryption key. The decryption key is not sent to the server. The receiving page removes these secrets from the address bar after opening the link.

Treat a full sharing link like the file itself: anyone holding it can download and forward the file until the share expires or is revoked. You can show an existing link again from its share list; its saved copy is encrypted for your account.

Use the share list to **revoke** access. Deleting the original file also ends its shares. Revocation, expiry, or suspending the sender prevents subsequent access through Rooms; it cannot delete copies or keys a recipient has already obtained. Existing shares keep their encrypted filename snapshot after a rename.

## Optional file-manager menu

In the Windows or Linux desktop app, open the gear button **Vault settings → File manager integration**. Installation and removal are explicit actions with a native confirmation. A browser alone cannot install an operating-system context menu.

The entry is named **Share securely via Vault**. Windows Explorer is supported. On Linux, available **Files/Nautilus, Nemo, Caja, Dolphin, and Thunar** installations are detected automatically. Nautilus and Caja show the action directly in the file-selection context menu. Windows 11 may place the entry under **Show more options**.

Nautilus and Caja require their Python extension support: `nautilus-python` or `python-caja`. Package names vary by distribution. If support is missing, Vault shows the required component; install the corresponding distribution package and restart Rooms and the file manager.

If an earlier Rooms version installed a managed entry under **Scripts**, choose **Update context menu**. This installs the direct entry and removes the old managed script. Other scripts, extensions, and custom actions are preserved.

After installing, updating, or removing the integration, **completely restart the Linux file manager**. Opening another window alone may not load or remove its context-menu extension.

Select one or more local files or folders and invoke the entry. Rooms opens Vault and asks you to confirm the destination instance and the complete selection once. Each file is uploaded directly under its original name. Each folder becomes its own **foldername.zip**; a mixed selection therefore creates separate Vault entries for every file and folder. All items are encrypted in chunks on your device before upload. Folder ZIPs are streamed without writing an unencrypted temporary ZIP to disk. The originals remain unchanged.

After a single upload, the sharing dialog lets you choose a recipient or create a link. If another dialog is still open, or several items were uploaded, a notification directs you to their individual file menus instead. Each item can be shared separately. Cancelling or a later error stops the remaining uploads; items already uploaded successfully stay in Vault. Older desktop versions must be updated to use this selection upload.

Folders include their regular contents, including hidden files. Symbolic links and special files are rejected; changed files, unsafe archive paths, and selections exceeding the configured limits abort the operation. Keep selected files unchanged until completion.

Select **Remove context menu** to remove the managed entries. Keep a Linux AppImage in its permanent location. After moving it or updating to a different path, open the new AppImage and choose **Update context menu** to update the launcher, then restart the file manager.

## Privacy and recovery

Contents, filenames, folder names, and file types are encrypted before upload. The server does see account ownership, sizes, timestamps, folder relationships, and sharing relationships. Shared files are read-only, and a recipient does not receive access to the rest of your Vault.

A normal password change preserves your encrypted files. Account recovery without the previous encryption password does not decrypt existing Vault files. The operator cannot recover their contents without your account key. Keep independent copies of important data.

Use a trusted instance and device. As with encrypted Rooms chats, the instance delivers the application interface: altered client code or a compromised device can undermine protection at the endpoint. See [security and privacy](security.md) for these trust boundaries.
