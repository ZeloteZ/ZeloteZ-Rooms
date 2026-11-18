# Rooms, chats, and friends

[Documentation](README.md) · [Deutsch](de/user-guide.md) · [简体中文](zh-CN/user-guide.md)

Start with [member onboarding](getting-started.md) if you do not yet have an account. This page covers persistent rooms; [temporary rooms and media](streaming.md) have different access and retention rules.

## Navigate the instance

**Rooms** lists rooms you can see, invitations, favorites, recent activity, and live rooms. Join a room to open its channels. Mark joined rooms as favorites for quick access. **Friends** contains confirmed friends, incoming and outgoing requests, and member search. **Messages** lists direct conversations. The bell collects friend requests, direct messages, and personal mentions; live alerts for joined rooms are optional in your profile.

First-visit tutorials explain the main views. Reset them in your profile to run them again. English, German, and Simplified Chinese are available from the sign-in screen and profile.

## Room visibility and membership

Create a room from the room actions and select its visibility:

| Visibility | Who can join |
| --- | --- |
| **Everyone in the group** | Signed-in accounts on this instance |
| **Private · invite only** | Accounts invited to this room |

A room's creator can invite confirmed friends individually to a private room. Invitees accept before becoming members. Public repository visibility has no effect on these application permissions.

A non-owner can **Leave** a room. The creator manages the room rather than using that leave action. Removing a member or deleting a room is not a way to erase copies that someone has already downloaded.

## Roles and controls

| Role or permission | Main controls |
| --- | --- |
| Instance owner | Creates account invitations; manages account suspension and sessions. This is separate from being a particular room's creator. |
| Room creator | Changes room name, visibility and room streaming policy; manages members, admins and design grants; manages channels; moderates messages; deletes the entire room. |
| Room admin | Manages channels and moderates messages in that room. |
| Explicit design permission | Changes the room cover, banner, background and colors. The creator has this permission; an admin role alone does not grant it. |
| Room member | Reads and writes accessible chats, joins voice, and shares media where the room and channel policies permit. |

The creator can grant or remove admin and design permissions from **Members**. Room settings can allow all members to stream, restrict streaming to the creator and admins, or disable streaming. A live channel also has an all-members or admins policy; a channel does not override a room-wide restriction.

## Channels

**Chat** channels keep a text and attachment history. **Live** channels combine voice, screen streams, watch parties, and an encrypted channel chat. The live-channel chat remains available between broadcasts.

The creator and admins can add, rename, reorder, and delete channels. Channel type is selected when creating a channel. Deleting a chat channel removes its messages and attachments; deleting a live channel also ends active media and removes its stream chat. Deleting a whole room removes all of its channels and content and ends its active media. The interface asks for confirmation for these actions.

## Write messages and share files

A persistent chat message can contain up to **4,000 characters** and **four attachments of up to 12 MiB each**. Choose files in the composer, remove any you did not intend to share, and send. The browser encrypts the message and file contents before upload.

Attachment names, contents, shared links, reactions, and moderation reasons are encrypted. Membership, senders, timestamps, file sizes, and other operating metadata remain visible to the server. [Privacy model](security.md)

Attachments normally load as they enter view. In your profile, choose manual loading or automatic loading only below a chosen size. These controls manage downloading and display; they do not change the size permitted for an upload. Supported images, audio, and video can be previewed; other files remain downloadable. An image can be opened in a larger view.

Storage and request quotas can still reject a message or file below the per-file limit when an account or instance is full. [Limits and configuration](configuration.md)

## Reactions, mentions, and replies

- Use the reaction control to add or remove an emoji reaction.
- Type **@** for suggestions for people, rooms, and channels. Suggestions are filtered to relevant accessible destinations. A link does not grant access to a private room.
- Use the reply/quote action to reference a message. The quote can jump to its original message when it is still available to your account.
- Long messages can be expanded on demand.

A personal mention can create a notification. Rooms must expose the account references needed to route such notifications, even though message text stays encrypted.

## Delete and moderate messages

You can delete your own messages. Room creators and admins can delete another person's message with a reason, or move a message between text channels in the same room. The reason is encrypted for the eligible recipients. Authorized moderators can also remove a deletion notice from the chat.

Deletion removes the application's stored message and associated attachments for other users; it cannot retract screenshots, exports, downloads, or other copies already made. Moving a message does not create access for a person who cannot access the destination channel.

## Friends and direct messages

Use **Friends → Search** to find an account, send a request, then accept it on the receiving account. Confirmed friends can open a direct conversation and share text, links, and files. Incoming and outgoing requests appear separately.

Direct messages use the same encrypted message and attachment model. Sending requires an active confirmed friendship; removing a friendship does not turn the conversation into a public room. If a peer is suspended or the friendship is no longer active, sending is unavailable.

## Appearance and personal preferences

Profile and room images accept JPEG, PNG, or WebP files up to **8 MiB**. Built-in image presets are also available. Profile controls include name color and image. Authorized room designers can set a cover, banner, chat background, and room colors.

Images used for profiles and room design are processed by the server and are not encrypted like chat attachments. Attachment auto-loading, live-alert preferences, and video reception statistics are personal account settings. Video reception statistics start off; see [understanding media statistics](streaming.md#understand-the-statistics).

## History and access changes

When you join a room, your browser can receive encrypted copies of older message keys from an authorized, signed-in browser with its chats unlocked. If those browsers are offline, history may remain unreadable until one returns. Keep your own password and keys available; inviting another person or recovering an account is not a way to reconstruct a lost private key.

For exact trust boundaries and retention differences between persistent chats, temporary chat, and media, read [security and privacy](security.md).
