# ZeloteZ Vault

[English](vault.md) · [Deutsch](de/vault.md) · [简体中文](zh-CN/vault.md) · [Documentation](README.md)

Vault gives each member private, end-to-end encrypted file storage and read-only file sharing. It is optional and disabled on new instances. It uses your existing account encryption identity; no additional cloud account is required.

## Enable and allocate storage

The operator opens **Administration → ZeloteZ Vault**, confirms owner access with an authenticator code, enables Vault, and saves the storage limit. The default is **2 GiB per account**. The limit applies individually to every account.

The limit includes encrypted data, encrypted metadata, and reserved space for unfinished uploads. Encryption adds a small amount of storage overhead. A small amount of technical protection data can remain allocated after deleting files. Lowering the limit keeps existing files; accounts above the limit can still download and delete, but cannot allocate more storage.

Disabling Vault blocks uploads, downloads, and both kinds of shares. Completed files remain stored for later reactivation. Unfinished uploads are discarded. Operators must also provide enough disk space for all accounts and include the application data volume in [backups](operations.md).

## Manage files

1. On the Rooms overview, select **ZeloteZ Vault** below **Live now** on the right. The entry appears only when Vault is enabled.
2. Create folders, choose **Upload files**, or drop files into the file manager. Multiple files are processed in sequence.
3. Use the item menu to download, rename, move, share, or delete an item. Only files can be shared; folders organize your own storage.
4. Use the breadcrumb trail, search, sorting, and **Shared with me** to find files.

Transfers show progress and can be cancelled. Keep the Vault view open until the transfer finishes; leaving it or signing out cancels active work. An incomplete upload is not a downloadable file and its reservation is released on cancellation or stale-upload cleanup. Deleting a folder also deletes its contents and their shares. Deletion cannot be undone.

Downloads are decrypted on your device and saved as ordinary files. Browsers with a supported save-file picker can save large files in chunks. Other browsers support downloads up to **128 MiB per file**. For larger files, use a compatible Chromium-based browser. Your own files and member shares can also be saved through the desktop client; public links open in your browser. Files are downloaded rather than executed or displayed as active web content.

## Share a file

Open a file's **Share** menu and choose an expiry:

- **Member:** search for an active Rooms member and select the intended account. The recipient finds the file under **Shared with me** and needs their own account encryption key to open it.
- **Link:** create a link for someone without a Rooms account. Send the complete link privately. The part after `#` contains the access capability and decryption key. The decryption key is not sent to the server. The receiving page removes these secrets from the address bar after opening the link.

Treat a full sharing link like the file itself: anyone holding it can download and forward the file until the share expires or is revoked. You can show an existing link again from its share list; its saved copy is encrypted for your account.

Use the share list to **revoke** access. Deleting the original file also ends its shares. Revocation, expiry, or suspending the sender prevents subsequent access through Rooms; it cannot delete copies or keys a recipient has already obtained. Existing shares keep their encrypted filename snapshot after a rename.

## Optional file-manager menu

In the Windows or Linux desktop app, open Vault's **file-manager integration** section. Installation and removal are explicit actions with a native confirmation. A browser alone cannot install an operating-system context menu.

The entry is named **Share securely via Vault**. Windows Explorer is supported. On Linux, available **Files/Nautilus, Nemo, Caja, Dolphin, and Thunar** installations are detected automatically. GNOME Files and Caja expose scripts in their **Scripts** submenu; Windows 11 may place the entry under **Show more options**. Reopen the file-manager window if its menu has not refreshed.

Select a local file or folder and invoke the entry. Rooms opens Vault, shows the destination instance and selection for confirmation, creates a ZIP locally, and encrypts it in chunks before uploading. No unencrypted temporary ZIP is written to disk. The originals remain unchanged. The sharing dialog opens after upload so you can choose the recipient or create a link.

Folders include their regular contents, including hidden files. Symbolic links and special files are rejected; changed files, unsafe archive paths, and selections exceeding the configured limits abort the operation. Keep selected files unchanged until completion.

Select **Remove integration** to remove the managed entries. Other custom actions are preserved. Keep a Linux AppImage in its permanent location; after moving it or updating to a different path, install the integration again to update the launcher.

## Privacy and recovery

Contents, filenames, folder names, and file types are encrypted before upload. The server does see account ownership, sizes, timestamps, folder relationships, and sharing relationships. Shared files are read-only, and a recipient does not receive access to the rest of your Vault.

A normal password change preserves your encrypted files. Account recovery without the previous encryption password does not decrypt existing Vault files. The operator cannot recover their contents without your account key. Keep independent copies of important data.

Use a trusted instance and device. As with encrypted Rooms chats, the instance delivers the application interface: altered client code or a compromised device can undermine protection at the endpoint. See [security and privacy](security.md) for these trust boundaries.
