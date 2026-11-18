# ZeloteZ Rooms documentation

[English](README.md) · [Deutsch](de/README.md) · [简体中文](zh-CN/README.md) · [Project overview](../README.md)

Choose the guide for what you want to do. These pages describe the source revision you are reading; installed releases can differ. The German and Simplified Chinese documentation covers the same topics as the English edition.

## Use Rooms

| Guide | What it covers |
| --- | --- |
| [Get started](getting-started.md) | Accept an invitation, create an account, choose your language, and join your group. |
| [User guide](user-guide.md) | Rooms, channels, friends, encrypted messages, files, moderation, notifications, and appearance. |
| [Streams and watch parties](streaming.md) | Share a screen or video, use voice, invite guests, choose playback, and interpret statistics. |
| [Desktop app](desktop.md) | Windows and Linux installation, screen/audio capture, settings, updates. |
| [YouTube extension](browser-extension.md) | Install the extension, configure access, and open a watch party in the browser or desktop app. |

You need an invitation from the operator of a Rooms instance to create a member account. Installing the client does not create an account or host a server.

## Host and administer an instance

| Guide | What it covers |
| --- | --- |
| [Self-hosting](self-hosting.md) | Requirements, obtaining the image, first start, HTTPS, media ports, and public access. |
| [Configuration reference](configuration.md) | Compose variables, network bindings, storage, runtime options, and component settings. |
| [Administration](administration.md) | Owner setup, invitations, accounts, MFA, passwords, and console recovery. |
| [Operations](operations.md) | Health, logs, backups, restoring data, updates, and rollback. |

Start with the single-container deployment in the self-hosting guide. Docker Desktop on Windows or macOS does not by itself establish compatibility with the Linux isolation requirements.

## Security and help

| Guide | What it covers |
| --- | --- |
| [Security and privacy](security.md) | What is encrypted, readable metadata, trust boundaries, local keys, and the limits of recovery. |
| [Troubleshooting](troubleshooting.md) | Symptoms, checks, and links to the relevant corrective procedure. |

## License and contributions

Rooms is source available under [PolyForm Noncommercial 1.0.0](../LICENSE), with [licensing details](../LICENSING.md). Third-party components retain their own licenses. Read [CONTRIBUTING.md](../CONTRIBUTING.md) and [CLA.md](../CLA.md) before submitting code or other project material.

## Conventions

- Run commands from the repository root unless a guide explicitly changes directories.
- Replace example domains, addresses, image tags, and paths with values for your instance.
- The recommended Compose service is `rooms`, from `deploy/compose.image.yaml`.
- Keep the same Compose project, environment file, and data volumes when using administration and maintenance commands.
- Translations keep technical filenames, commands, environment variables, and protocol names unchanged.
