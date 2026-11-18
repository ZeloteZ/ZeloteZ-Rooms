# Get started as a member

[Documentation](README.md) · [Deutsch](de/getting-started.md) · [简体中文](zh-CN/getting-started.md)

This guide is for joining an existing instance. To run your own, start with [self-hosting](self-hosting.md).

## What you need

Use a current browser with JavaScript and Web Crypto, the HTTPS address of a trusted Rooms instance, and an invitation from its owner. Screen sharing and voice additionally require the relevant browser and operating-system permissions. You can also use the [Windows or Linux desktop client](desktop.md).

A GitHub account is not required to use Rooms or download its public clients. A Rooms account belongs to one instance: an account on one server does not automatically work on another.

## Create your account

1. Open the invitation link supplied by the instance owner.
2. Select **English**, **Deutsch**, or **简体中文** on the sign-in page.
3. Enter a display name and a username. New usernames use 3–32 lowercase letters, digits, underscores, periods, or hyphens, beginning with a letter or digit.
4. Choose an uncommon password or passphrase of at least 15 characters. The official client rejects common passwords.
5. Submit **Create account**. Keep your username and password somewhere you can recover them.

An ordinary instance URL opens sign-in; it does not provide open registration. If the invitation expired or was already used, request a replacement from the owner. A temporary room's guest link is a different kind of access and does not create an account.

Your password also protects the private key used to open your encrypted chats. Signing in and unlocking that key are related but separate operations; see [security and privacy](security.md).

## Sign in and unlock chats

Use your username and password at the same instance address. If two-factor sign-in is enabled, enter a six-digit authenticator code or an unused recovery code when requested.

An existing session can show **Unlock chats** after opening another tab or restarting a client. Enter your password to unlock the chat key in that context. An authenticated session alone does not guarantee that older encrypted messages can be opened.

The desktop client can offer **Keep me signed in on this device** when protected system credential storage is available. That stores the session and chat-unlock material until expiry or sign-out. Use it only on a device you trust; see [desktop storage](desktop.md#sign-in-storage).

## Your first room and conversation

1. Open **Rooms**. Choose a room visible to the group, or accept a private-room invitation.
2. Click **Join** or **Accept invitation** to become a member.
3. Choose a **Chat** channel and send a message.
4. Open **Friends**, find a member, and send a friend request. After acceptance you can start a direct chat from **Messages** or the friend's entry.
5. In a **Live** channel, choose **Join voice chat** to listen. Enable the microphone separately if you want to speak.

The home view includes favorites, recently visited rooms, activity, and live rooms. Room visibility **Everyone in the group** means signed-in members of this instance, not the public internet. [Room and channel guide](user-guide.md)

## Set up your profile and account security

Open your profile beside your name or avatar. You can change the interface language, profile image and name color, chat-attachment loading, optional live alerts, optional video reception statistics, and reset the first-visit tutorials.

Under **Two-factor sign-in**, add an authenticator, scan the QR code or enter its manual key, and confirm a code. Save the recovery codes when shown: each works once. Keep them separately from the authenticator device. You can replace the authenticator or recovery codes in the same view. Two-factor sign-in is optional for members and mandatory for the instance owner.

Use **Change password** while you still know the existing password. A normal change keeps your chat key and ends your other sessions. Password-length and common-password checks run in the official clients; the server receives a derived login credential rather than the original password.

## If you lose access

- **Lost authenticator:** use an unused recovery code. If none remains, contact the owner; this is not an email-based reset service.
- **Forgotten password:** there is no ordinary self-service email reset flow. Contact your instance owner. Do not assume an owner can recover your private chat key or decrypt your history.
- **Owner account:** console recovery and owner MFA replacement are described in [administration](administration.md). Owner account access can be restored while old chats remain locked if the previous chat password is unavailable.
- **Missing history after joining:** leave an authorized member's browser signed in with its chats unlocked so it can share the required encrypted history keys. The server alone cannot supply those private keys.

For connection, media, or client errors, use [troubleshooting](troubleshooting.md).
