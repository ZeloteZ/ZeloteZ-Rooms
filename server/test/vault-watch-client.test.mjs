import assert from 'node:assert/strict';
import { randomUUID, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

globalThis.document = { querySelector() { return null; }, documentElement: { lang: 'en' } };
globalThis.location = new URL('https://rooms.example.test/#/vault');
globalThis.localStorage = { getItem() { return null; } };
const watch = await import('../../web/vault-watch.js');
const vault = await import('../../web/vault-crypto.js');
const client = await import('../../web/vault-client.js');
const source = readFileSync(new URL('../../web/crypto.js', import.meta.url), 'utf8');
const encode = value => new TextEncoder().encode(value);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function storage() {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) };
}
async function account(username) {
  const window = {};
  runInNewContext(source, { window, crypto: webcrypto, TextEncoder, TextDecoder, EventTarget, atob, btoa, sessionStorage: storage(), localStorage: storage(), location: { origin: location.origin } });
  const crypto = window.ClubCrypto;
  const password = 'A private Vault room test passphrase';
  const ready = await crypto.prepareRegistration(username, password);
  const user = { id: randomUUID(), username, publicKey: ready.publicKey, identity: ready.identity };
  await crypto.unlock(user, password);
  return { user, crypto };
}

async function fixture(t, { type = 'video/mp4', name = 'private-vault-movie.mp4' } = {}) {
  vault.clearVaultKeys();
  const owner = await account('watch-owner'), viewer = await account('watch-viewer');
  globalThis.ClubCrypto = owner.crypto;
  const priorFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = priorFetch; vault.clearVaultKeys(); delete globalThis.ClubCrypto; });
  const bytes = encode('PRIVATE LOCAL MEDIA CONTENT');
  const file = new File([bytes], name, { type, lastModified: 1700000000000 });
  const created = await vault.createFile(owner.user, randomUUID(), file);
  const entry = { id: created.descriptor.id, kind: 'file', state: 'ready', name, type, ownerId: owner.user.id, descriptor: created.descriptor, envelope: created.envelope };
  const shareId = randomUUID();
  const prepared = await vault.createShare(entry, created.opened, shareId);
  const encrypted = await vault.encryptChunk(created.secret, entry.descriptor, 0, bytes);
  const share = { id: shareId, entryId: entry.id, ownerId: owner.user.id, descriptor: entry.descriptor, envelope: prepared.envelope, expiresAt: Date.now() + 86400000 };
  const publicShare = { id: shareId, url: client.publicVaultLink(shareId, prepared.token, prepared.keyFragment) };
  const calls = [], revocations = [];
  const service = { async createShare(value, options) { assert.equal(value, entry); calls.push(options); return publicShare; }, async revokeShare(value, options) { revocations.push({ value, options }); } };
  return { owner, viewer, bytes, entry, prepared, encrypted, share, publicShare, service, calls, revocations, channelId: randomUUID() };
}

async function createParty(f, { behind } = {}) {
  let sent;
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/messages?after=0')) return json({ recipients: [f.owner.user, f.viewer.user] });
    assert.equal(url, '/api/channels/' + f.channelId + '/watch' + (behind ? '/' + behind + '/queue' : ''));
    sent = JSON.parse(options.body);
    assert.deepEqual(Object.keys(sent).sort(), ['envelope', 'id', 'shareId', 'source']);
    assert.equal(sent.source, 'vault'); assert.equal(sent.shareId, f.share.id);
    for (const secret of [f.prepared.token, f.prepared.keyFragment, f.entry.name, f.entry.type, 'PRIVATE LOCAL MEDIA CONTENT']) assert.ok(!options.body.includes(secret));
    return json({ party: { id: sent.id, source: 'vault', shareId: sent.shareId, vaultEnvelope: sent.envelope, vaultOwner: { id: f.owner.user.id, publicKey: f.owner.user.publicKey } } }, 201);
  };
  const result = await watch.startVaultWatch({ entry: f.entry, client: f.service, user: f.owner.user, channelId: f.channelId, enqueueBehind: behind });
  assert.equal(f.calls[0].expiresIn, 86400);
  assert.equal(f.revocations.length, 0);
  return result.party;
}

test('Vault room start and queue transmit only an authenticated encrypted reference, never the key, name, MIME or content', async t => {
  const f = await fixture(t);
  await createParty(f);
  await createParty(f, { behind: randomUUID() });
});

test('Vault room media decrypts locally for another recipient and close releases the service Blob reference', async t => {
  const f = await fixture(t);
  const party = await createParty(f);
  globalThis.ClubCrypto = f.viewer.crypto;
  let opened = 0, chunks = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.redirect, 'error');
    assert.ok(!String(url).includes(f.prepared.keyFragment)); assert.ok(!String(options.body).includes(f.prepared.keyFragment));
    if (url === '/api/vault/public/open') { opened++; assert.deepEqual(JSON.parse(options.body), { id: f.share.id, token: f.prepared.token }); return json({ share: f.share }); }
    assert.equal(url, '/api/vault/public/' + f.share.id + '/chunks/0'); chunks++;
    assert.equal(options.headers.Authorization, 'Bearer ' + f.prepared.token);
    return new Response(f.encrypted);
  };
  const result = await watch.openVaultWatch({ party, channelId: f.channelId });
  assert.equal(result.name, f.entry.name); assert.equal(result.kind, 'video'); assert.equal(result.type, f.entry.type);
  assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()), f.bytes);
  assert.equal(opened, 1); assert.equal(chunks, 1);
  result.close(); assert.equal(result.blob, null); result.close();
});

test('a wrong channel, party or public-share binding fails before requesting a public capability', async t => {
  const f = await fixture(t); const party = await createParty(f);
  globalThis.ClubCrypto = f.viewer.crypto;
  let network = 0; globalThis.fetch = async () => { network++; throw new Error('unexpected plaintext reference request'); };
  for (const [candidate, channelId] of [[party, randomUUID()], [{ ...party, id: randomUUID() }, f.channelId], [{ ...party, shareId: randomUUID() }, f.channelId], [{ ...party, vaultOwner: f.viewer.user }, f.channelId]]) await assert.rejects(watch.openVaultWatch({ party: candidate, channelId }));
  assert.equal(network, 0);
});

test('unsupported decrypted file metadata is refused before any content chunk is requested', async t => {
  const f = await fixture(t, { type: 'application/pdf', name: 'private.pdf' });
  const partyId = randomUUID();
  const { envelope } = await f.owner.crypto.sealVaultMessage(`zelotez-vault/1/room/${f.owner.user.id}/${f.channelId}`, partyId,
    { type: 'vault-watch/1', channelId: f.channelId, partyId, link: { id: f.share.id, token: f.prepared.token, keyFragment: f.prepared.keyFragment } }, [f.owner.user, f.viewer.user]);
  globalThis.ClubCrypto = f.viewer.crypto;
  let chunks = 0;
  globalThis.fetch = async url => { if (url === '/api/vault/public/open') return json({ share: f.share }); chunks++; throw new Error('unexpected PDF chunk'); };
  await assert.rejects(watch.openVaultWatch({ party: { id: partyId, source: 'vault', shareId: f.share.id, vaultEnvelope: envelope, vaultOwner: f.owner.user }, channelId: f.channelId }), /authenticated/);
  assert.equal(chunks, 0);
});

test('failed or cancelled room start revokes only its dedicated newly-created share', async t => {
  const f = await fixture(t);
  globalThis.fetch = async url => url.endsWith('/messages?after=0') ? json({ recipients: [f.owner.user, f.viewer.user] }) : json({ error: 'fixture conflict' }, 409);
  await assert.rejects(watch.startVaultWatch({ entry: f.entry, client: f.service, user: f.owner.user, channelId: f.channelId }), /fixture conflict/);
  assert.equal(f.revocations.length, 1); assert.equal(f.revocations[0].value.id, f.share.id);
  const controller = new AbortController();
  f.service.createShare = async () => { controller.abort(); return f.publicShare; };
  await assert.rejects(watch.startVaultWatch({ entry: f.entry, client: f.service, user: f.owner.user, channelId: f.channelId, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.revocations.length, 2); assert.equal(f.revocations[1].options.signal.aborted, false);
});

test('room source selection rejects received, foreign, unsupported and oversized files before creating a link', async t => {
  const f = await fixture(t); let network = 0; globalThis.fetch = async () => { network++; throw new Error('unexpected request'); };
  for (const entry of [{ ...f.entry, receivedShareId: randomUUID() }, { ...f.entry, ownerId: randomUUID() },
    { ...f.entry, name: 'unsafe.svg', type: 'image/svg+xml' }, { ...f.entry, descriptor: { ...f.entry.descriptor, size: 128 * 1024 ** 2 + 1 } }]) await assert.rejects(watch.startVaultWatch({ entry, client: f.service, user: f.owner.user, channelId: f.channelId }));
  assert.equal(network, 0); assert.equal(f.calls.length, 0);
});
