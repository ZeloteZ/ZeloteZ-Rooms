import { t } from "./i18n.js";
import { api } from "./ui.js";
import { openPublicVault, takePublicVaultLink } from "./vault-client.js";
import { VAULT_EDITOR_LIMITS, abortEditor, vaultFileKind } from "./vault-media-edit.js";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const SECRET = /^[A-Za-z0-9_-]{43}$/u;
const SUITE = "zelotez-vault/1/room/";

function invalid() { return new Error(t("The encrypted room media could not be authenticated.", "Die verschlüsselten Raummedien konnten nicht verifiziert werden.")); }
function uuid(value) { if (typeof value !== "string" || !UUID.test(value)) throw invalid(); return value; }
function media(entry) {
  const kind = vaultFileKind(entry);
  return kind === "video" || kind === "audio";
}
function scope(ownerId, channelId) { return SUITE + uuid(ownerId) + "/" + uuid(channelId); }

export function vaultWatchPayload(content, { channelId, partyId, shareId } = {}) {
  uuid(channelId); uuid(partyId); uuid(shareId);
  if (!content || Object.keys(content).length !== 4 || content.type !== "vault-watch/1" || content.channelId !== channelId || content.partyId !== partyId ||
      !content.link || Object.keys(content.link).length !== 3 || content.link.id !== shareId || !SECRET.test(content.link.token ?? "") || !SECRET.test(content.link.keyFragment ?? "")) throw invalid();
  return { id: shareId, token: content.link.token, keyFragment: content.link.keyFragment };
}

export async function startVaultWatch({ entry, client, user, channelId, signal, enqueueBehind } = {}) {
  abortEditor(signal);
  uuid(user?.id); uuid(channelId);
  if (enqueueBehind !== undefined) uuid(enqueueBehind);
  if (!entry || entry.kind !== "file" || entry.state !== "ready" || entry.receivedShareId || entry.ownerId !== user.id || !media(entry)) throw new Error(t(
    "Choose one of your own audio or video files.", "Wähle eine eigene Audio- oder Videodatei."));
  const size = entry.descriptor?.size ?? entry.plainBytes ?? entry.size;
  if (!Number.isSafeInteger(size) || size < 0 || size > VAULT_EDITOR_LIMITS.mediaBytes) throw new Error(t(
    "Room playback supports Vault files up to 10 GiB.", "Die Raumwiedergabe unterstützt Vault-Dateien bis 10 GiB."));
  const endpoint = "channels/" + channelId;
  const members = await api(endpoint + "/messages?after=0", { signal });
  abortEditor(signal);
  const recipients = members?.recipients;
  if (!Array.isArray(recipients) || !recipients.length || recipients.length > 1000 || !recipients.some(recipient => recipient.id === user.id) ||
      recipients.some(recipient => !UUID.test(recipient.id ?? "") || !recipient.publicKey) || new Set(recipients.map(recipient => recipient.id)).size !== recipients.length) throw new Error(t(
    "The members’ encryption keys are unavailable right now.", "Die Schlüssel der Mitglieder sind gerade nicht verfügbar."));
  const partyId = crypto.randomUUID();
  let share;
  try {
    share = await client.createShare(entry, { expiresIn: 86400, signal });
    abortEditor(signal);
    uuid(share?.id);
    const address = new URL(share.url);
    if (address.origin !== location.origin || address.pathname !== "/vault" || address.search) throw invalid();
    const link = takePublicVaultLink(address.href, () => {});
    if (!link || link.id !== share.id) throw invalid();
    const { envelope } = await ClubCrypto.sealVaultMessage(scope(user.id, channelId), partyId,
      { type: "vault-watch/1", channelId, partyId, link }, recipients);
    abortEditor(signal);
    const result = await api(endpoint + "/watch" + (enqueueBehind ? "/" + enqueueBehind + "/queue" : ""), {
      method: "POST", body: { id: partyId, source: "vault", shareId: share.id, envelope }, signal,
    });
    abortEditor(signal);
    return result;
  } catch (error) {
    if (share?.id && UUID.test(share.id)) {
      // This dedicated share was created only for this attempt. Even an
      // ambiguous failed POST should not leave a usable, hidden room share.
      await client.revokeShare(share, { signal: AbortSignal.timeout(5000) }).catch(() => {});
    }
    throw error;
  }
}

export async function openVaultWatch({ party, channelId, signal, onProgress } = {}) {
  abortEditor(signal);
  uuid(channelId); uuid(party?.id); uuid(party?.shareId); uuid(party?.vaultOwner?.id);
  if (party.source !== "vault" || (party.channelId !== undefined && party.channelId !== channelId) || !party.vaultEnvelope || !party.vaultOwner.publicKey) throw invalid();
  const identity = { id: party.vaultOwner.id, publicKey: party.vaultOwner.publicKey };
  const decoded = await ClubCrypto.openVaultMessage(scope(identity.id, channelId), party.id, party.vaultEnvelope, identity);
  abortEditor(signal);
  const link = vaultWatchPayload(decoded?.content, { channelId, partyId: party.id, shareId: party.shareId });
  const local = new AbortController();
  const lifetime = signal ? AbortSignal.any([signal, local.signal]) : local.signal;
  let remote, result, closed = false;
  function close() {
    if (!closed) { closed = true; local.abort(); }
    remote?.close({ revokeDownloads: false }); remote = null;
    signal?.removeEventListener("abort", close);
    if (result) result.blob = null;
  }
  signal?.addEventListener("abort", close, { once: true });
  try {
    abortEditor(lifetime);
    remote = await openPublicVault(link, { signal: lifetime });
    abortEditor(lifetime);
    if (remote.share?.id !== party.shareId || remote.share.ownerId !== identity.id || remote.opened.ownerId !== identity.id || !media(remote.opened)) throw invalid();
    const blob = await remote.readMediaBlob({ signal: lifetime, onProgress, maxBytes: VAULT_EDITOR_LIMITS.mediaBytes });
    abortEditor(lifetime);
    if (!(blob instanceof Blob) || blob.size > VAULT_EDITOR_LIMITS.mediaBytes) throw invalid();
    result = { blob, name: remote.opened.name, type: remote.opened.type, kind: vaultFileKind(remote.opened), close };
    return result;
  } catch (error) { close(); throw error; }
}
