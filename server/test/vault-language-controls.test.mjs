import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

globalThis.location = new URL('https://rooms.example.test/#/vault');
globalThis.localStorage = { getItem() { return 'en'; } };
const url = new URL('../../web/vault-language-controls.js', import.meta.url);
const source = (await readFile(url, 'utf8'))
  .replace('import { attachMediaTracks } from "./vault-media-tracks.js";', 'const attachMediaTracks = (...args) => globalThis.__vaultLanguageAttach(...args);')
  .replace(/from "\.\/([^"]+)"/gu, (_, path) => 'from ' + JSON.stringify(new URL(path, url).href));
const { mountVaultMediaLanguages, vaultMediaLanguageLabel } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

class Element extends EventTarget {
  constructor(tag, owner) { super(); this.tag = tag; this.ownerDocument = owner; this.children = []; this.value = ''; this.textContent = ''; this.attributes = new Map(); }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this.children = values; }
  setAttribute(name, value) { this.attributes.set(name, value); }
}
function fixture(t, metadata = {}) {
  const prior = globalThis.__vaultLanguageAttach;
  const owner = { createElement: tag => new Element(tag, owner) }, media = { ownerDocument: owner };
  const state = { disposed: 0, calls: [], changes: [], errors: [] };
  let callbacks;
  const controller = { audio: metadata.audio ?? [], subtitles: metadata.subtitles ?? [], audioId: 'original', subtitleId: 'off', switching: false,
    async selectAudio(id) { state.calls.push(['audio', id]); controller.audioId = id; callbacks.onChange(); return true; },
    async selectSubtitle(id) { state.calls.push(['subtitle', id]); controller.subtitleId = id; callbacks.onChange(); return true; },
    dispose() { state.disposed++; } };
  globalThis.__vaultLanguageAttach = async (_media, _blob, options) => { callbacks = options; return controller; };
  const mounted = mountVaultMediaLanguages(media, new Blob(['private local media']), { ownerDocument: owner,
    onChange: value => state.changes.push(value), onError: error => state.errors.push(error), ...metadata.options });
  t.after(() => { mounted.dispose(); globalThis.__vaultLanguageAttach = prior; });
  return { owner, media, controller, mounted, state, callbacks: () => callbacks,
    audio: mounted.element.children[0].children[1], subtitles: mounted.element.children[1].children[1], note: mounted.element.children[2] };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('labels use localized languages and passive bounded titles without executable DOM', () => {
  assert.match(vaultMediaLanguageLabel({ language: 'eng', label: '<img src=x onerror=run()>', default: true }, 0), /English.*<img.*default/u);
  const value = vaultMediaLanguageLabel({ language: '???', label: 'hidden\u202e\n title' }, 0, true);
  assert.ok(!/[\p{Cc}\u202e]/u.test(value)); assert.match(value, /hidden title/u);
  assert.equal(vaultMediaLanguageLabel({ language: 'und', label: '' }, 1), 'Audio track 2');
});

test('single ordinary audio tracks without subtitles keep the optional language UI hidden', async t => {
  const f = fixture(t, { audio: [{ id: '1', language: 'eng', label: '', default: true }] });
  assert.equal(await f.mounted.ready, false); assert.equal(f.mounted.element.hidden, true); assert.equal(f.state.errors.length, 0);
});

test('multi-audio and subtitle selectors expose default/off and passive metadata labels', async t => {
  const f = fixture(t, { audio: [{ id: 'a1', language: 'deu', label: 'Deutsch', default: true }, { id: 'a2', language: 'eng', label: '<b>English</b>' }],
    subtitles: [{ id: 's1', language: 'eng', label: 'SDH' }, { id: 's2', language: 'deu', label: 'PGS', supported: false }] });
  assert.equal(await f.mounted.ready, true); assert.equal(f.mounted.element.hidden, false);
  assert.deepEqual(f.audio.children.map(option => option.value), ['original', 'a1', 'a2']);
  assert.deepEqual(f.subtitles.children.map(option => option.value), ['off', 's1', 's2']);
  assert.equal(f.subtitles.children[2].disabled, true); assert.match(f.subtitles.children[2].textContent, /unavailable/u);
  assert.equal(f.note.hidden, false); assert.equal(f.audio.children[2].children.length, 0);
  f.audio.value = 'a2'; f.audio.dispatchEvent(new Event('change')); await flush();
  assert.deepEqual(f.state.calls[0], ['audio', 'a2']); assert.equal(f.audio.value, 'a2');
  f.subtitles.value = 's1'; f.subtitles.dispatchEvent(new Event('change')); await flush();
  assert.deepEqual(f.state.calls[1], ['subtitle', 's1']); assert.equal(f.subtitles.value, 's1');
});

test('audio switching disables both selectors and emits one final local resynchronization state', async t => {
  const f = fixture(t, { audio: [{ id: '1', language: 'deu', label: '' }, { id: '2', language: 'eng', label: '' }] });
  await f.mounted.ready; let complete;
  f.controller.selectAudio = id => new Promise(resolve => { complete = () => { f.controller.audioId = id; resolve(true); }; });
  f.audio.value = '2'; f.audio.dispatchEvent(new Event('change'));
  assert.equal(f.mounted.switching, true); assert.equal(f.audio.disabled, true); assert.equal(f.subtitles.disabled, true);
  complete(); await flush(); assert.equal(f.mounted.switching, false); assert.equal(f.audio.disabled, false);
  assert.equal(f.state.changes.at(-1).switching, false); assert.equal(f.audio.value, '2');
});

test('active selection failures report once and preserve the controller selection', async t => {
  const f = fixture(t, { audio: [{ id: '1', language: 'deu', label: '' }, { id: '2', language: 'eng', label: '' }] });
  await f.mounted.ready; const failure = new Error('local track failed');
  f.controller.selectAudio = async () => { f.callbacks().onError(failure); throw failure; };
  f.audio.value = '2'; f.audio.dispatchEvent(new Event('change')); await flush();
  assert.equal(f.state.errors.length, 1); assert.equal(f.audio.value, 'original'); assert.equal(f.mounted.switching, false);
  assert.equal(f.note.textContent, 'local track failed');
});

test('abort disposes the track controller once and late selection events cannot act', async t => {
  const scope = new AbortController();
  const f = fixture(t, { options: { signal: scope.signal }, audio: [{ id: '1', language: 'deu', label: '' }, { id: '2', language: 'eng', label: '' }] });
  await f.mounted.ready; scope.abort(); f.mounted.dispose();
  assert.equal(f.state.disposed, 1); assert.equal(f.mounted.element.children.length, 0); assert.equal(f.mounted.switching, false);
  f.audio.value = '2'; f.audio.dispatchEvent(new Event('change')); await flush(); assert.equal(f.state.calls.length, 0);
});

test('late inspection results after closing are disposed without retaining controls', async () => {
  const prior = globalThis.__vaultLanguageAttach; let release, disposed = 0;
  globalThis.__vaultLanguageAttach = () => new Promise(resolve => { release = resolve; });
  const owner = { createElement: tag => new Element(tag, owner) };
  const mounted = mountVaultMediaLanguages({ ownerDocument: owner }, new Blob(['private']));
  try { mounted.dispose(); release({ dispose() { disposed++; } }); assert.equal(await mounted.ready, false); assert.equal(disposed, 1); }
  finally { mounted.dispose(); globalThis.__vaultLanguageAttach = prior; }
});

test('optional unsupported containers keep normal playback silent', async () => {
  const prior = globalThis.__vaultLanguageAttach;
  globalThis.__vaultLanguageAttach = async () => { throw new Error('unsupported container'); };
  const owner = { createElement: tag => new Element(tag, owner) }; let errors = 0;
  const mounted = mountVaultMediaLanguages({ ownerDocument: owner }, new Blob(['private']), { onError() { errors++; } });
  try { assert.equal(await mounted.ready, false); assert.equal(mounted.element.hidden, true); assert.equal(errors, 0); }
  finally { mounted.dispose(); globalThis.__vaultLanguageAttach = prior; }
});
