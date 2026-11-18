# Administration and account recovery

[English](administration.md) · [Deutsch](de/administration.md) · [简体中文](zh-CN/administration.md)

[Documentation](README.md) · [Self-hosting](self-hosting.md) · [Operations](operations.md)

## Owner and room administrators

The **instance owner** controls invitations and account access. A **room's creator** manages that room's settings, membership, admin roles, and design grants. **Room creators and admins** can manage its channels and moderate messages; an admin role alone does not grant membership management or design access. Promoting a room member does not make them the instance owner. The owner account itself is protected from the account-suspension controls.

Create the first owner through the single-image setup wizard described in [self-hosting](self-hosting.md). Once registered, first-run setup is sealed and is not a password-reset mechanism. Adding the same setup key later does not reopen registration.

## Invite members

1. Sign in as the owner and open **Invites**.
2. Confirm sensitive actions with a current authenticator code when requested.
3. Create an invitation and share its complete link privately. It permits one registration and expires after its selected lifetime.
4. Revoke an unused invitation if it was sent to the wrong person or is no longer needed.

The interface offers 1 hour, 24 hours, 3 days, or 7 days; the API accepts 1–168 hours and defaults to 48 hours when no lifetime is supplied. The invitation token is in the URL fragment and the server stores its hash. The raw invitation URL is returned when created; the invitation list provides status rather than reconstructing that secret. Revoking an invitation does not remove an account that already used it.

Member registration is invitation-only. Room membership and guest viewer links are separate permissions: inviting someone to register does not automatically grant every restricted room. See [the user guide](user-guide.md) and [streaming](streaming.md).

## Account access and sessions

Open **Invites → Accounts** to suspend/re-enable a member account or end its sessions. Suspending an account revokes its sessions and broadcasts. Ending sessions forces a fresh sign-in; it does not delete the account or its stored messages. The owner account cannot be disabled through this interface.

Sensitive owner actions use a recent authenticator approval that lasts five minutes. An ordinary login with an MFA recovery code can restore sign-in access, but owner authorization for sensitive changes requires a current authenticator code. Do not treat access to the admin page as permanent authorization.

## Passwords and chat keys

Members change passwords under **Profile → Change password**. The official clients require at least 15 characters and reject a local list of common passwords; existing passwords remain accepted. The server receives a derived credential and enforces its format, while length/blocklist checks run in the official client.

A successful password change rewraps the same chat identity and ends other sessions. Remembering a login or recovering account access is not a substitute for the password needed to unlock an older encrypted chat identity. The owner tools below recover the owner account only; there is no documented general member-password reset command.

## Two-factor authentication

The owner must enroll an authenticator. Other members can enable it under **Profile → Two-factor sign-in**. Scan the QR code, confirm a six-digit code, and store the displayed one-use recovery codes separately from the authenticator device. The profile supports device replacement and regeneration of recovery codes; optional member MFA can be disabled there, but owner MFA is required.

Keep the Docker host's clock synchronized: authenticator codes are time-based. Do not share terminal enrollment output, QR codes, or recovery codes in issues or screenshots.

## Replace a lost owner authenticator

Use the same Compose file, project, `.env`, and volumes as the running instance. For the single-image deployment, from the repository root:

```sh
docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml exec -T rooms node bootstrap.mjs --setup-owner-mfa
```

The command replaces the owner authenticator and revokes existing owner sessions. Scan the terminal QR code or enter its printed time-based secret manually with six digits and a 30-second period. Sign in again and create new recovery codes in the profile. An SSH/Docker administrator with this access can take over the owner account; protect host access accordingly.

## Recover the owner account

If the owner cannot sign in, run:

```sh
docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml exec -T rooms node bootstrap.mjs --recover-owner
```

This pauses normal owner sign-in, revokes existing owner sessions and unused invitations issued by that owner, and prints a one-use link valid for **20 minutes**. Open the complete link at the configured `PUBLIC_ORIGIN` and complete the recovery flow. If it expires, run the command again; an expired recovery record still leaves ordinary owner sign-in paused until recovery is completed.

Use the previous chat password when available to preserve access to encrypted chats. If it is lost, the recovery flow can restore account access while leaving the old chat identity locked; it can be unlocked later if that password is found. Recovery does not decrypt old content for you. If the authenticator is also unavailable, use the authenticator replacement command as well.

Do not run the recovery CLI against an empty or unrelated volume: the commands must reach the database of the existing instance.

## Room moderation and deletion

Room creators and admins can manage text/live channels and moderate messages. Only the room's creator changes room settings and membership, promotes or demotes room admins, grants or revokes design permissions, and deletes the room. Design access is a separate grant, not an automatic consequence of being an admin. Members can delete their own messages. Removing a member or deleting a room changes application access; it cannot erase copies a recipient already downloaded or decrypted. Account suspension and invitation revocation are different from deleting a room or chat history.

Before maintenance that changes account or room state, keep a restorable [backup](operations.md). Never edit the SQLite database in place while the API is running.
