import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

class Element extends EventTarget {
  constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attributes = new Map(); this.value = ''; this.textContent = ''; this.className = ''; this.hidden = false; this.disabled = false;
    this.classList = { add: (...names) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' '); },
      contains: name => this.className.split(' ').includes(name) };
  }
  get textContent() { return this.children.map(child => child instanceof Element ? child.textContent : String(child)).join(''); }
  set textContent(value) { for (const child of this.children) if (child instanceof Element) child.parentNode = null; this.children = value ? [String(value)] : []; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'class') this.className = String(value); if (name === 'value') this.value = String(value); if (name === 'hidden') this.hidden = true; if (name === 'disabled') this.disabled = true; }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...values) { for (const value of values) { if (value instanceof Element) { value.remove(); value.parentNode = this; } this.children.push(value); } }
  replaceChildren(...values) { for (const child of this.children) if (child instanceof Element) child.parentNode = null; this.children = []; this.append(...values); }
  remove() { if (!this.parentNode) return; const siblings = this.parentNode.children; siblings.splice(siblings.indexOf(this), 1); this.parentNode = null; }
  contains(node) { return node === this || this.children.some(child => child instanceof Element && child.contains(node)); }
  querySelectorAll(selector) { const matches = node => selector.split(',').some(part => part.startsWith('.') ? node.className.split(' ').includes(part.slice(1)) : node.tagName.toLowerCase() === part); const found = [];
    for (const child of this.children) if (child instanceof Element) { if (matches(child)) found.push(child); found.push(...child.querySelectorAll(selector)); } return found; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
const toast = new Element('p');
globalThis.document = { createElement: tag => new Element(tag), querySelector: selector => selector === '#toast' ? toast : null, documentElement: { lang: 'en' } };
globalThis.location = new URL('https://rooms.example.test/#/vault');
globalThis.localStorage = { getItem() { return 'en'; } };
const url = new URL('../../web/vault-editor.js', import.meta.url);
const source = (await readFile(url, 'utf8'))
  .replace('import { archiveViewer, archiveError } from "./vault-archive-viewer.js";', 'const archiveViewer = (...args) => globalThis.__vaultSessionArchive(...args); const archiveError = error => error.message;')
  .replace(/from "\.\/([^"]+)"/gu, (_, path) => 'from ' + JSON.stringify(new URL(path, url).href));
const { mountVaultEditor } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) { const state = { closed: 0, saved: [], reads: [] }; const entry = { id: 'local-preview', kind: 'file', name: 'notes.txt', type: 'text/plain', ...options.entry };
  const client = { async readBlob(_entry, value) { state.reads.push(value); return new Blob(['private text']); }, async saveEditedCopy(_entry, blob, value) { state.saved.push({ blob, ...value }); return { id: 'saved-copy' }; }, ...options.client };
  const mounted = mountVaultEditor({ ...options, entry, client, onClose() { state.closed++; } }); return { state, mounted }; }
async function edit(mounted, value = 'updated private text') {
  if (!mounted.node.querySelector('textarea')) {
    const control = mounted.node.querySelector('.vault-editor-mode'); assert.ok(control && !control.disabled); control.dispatchEvent(new Event('click')); await flush();
  }
  const input = mounted.node.querySelector('textarea'); assert.ok(input); input.value = value; input.dispatchEvent(new Event('input')); return input;
}
function save(mounted) { mounted.node.querySelector('.vault-editor-footer').querySelector('button').dispatchEvent(new Event('click')); }

test('inline editing survives detachment; declined close preserves changes and accepted close wipes them once', async () => {
  const f = fixture(); await f.mounted.ready; const host = new Element('div'); host.append(f.mounted.node); const input = await edit(f.mounted); f.mounted.node.remove();
  assert.equal(f.mounted.closed, false); assert.equal(f.mounted.dirty, true);
  globalThis.confirm = () => false; assert.equal(f.mounted.requestClose(), false); assert.equal(input.value, 'updated private text'); assert.equal(f.state.closed, 0);
  globalThis.confirm = () => true; assert.equal(f.mounted.close(), true); assert.equal(input.value, ''); assert.equal(f.mounted.closed, true); assert.equal(f.mounted.dirty, false);
  f.mounted.dispose(); assert.equal(f.state.closed, 1); assert.equal(f.mounted.node.children.length, 0);
});

test('already-aborted previews never read or retain decrypted data', async () => {
  const scope = new AbortController(); scope.abort(); const f = fixture({ signal: scope.signal }); await f.mounted.ready;
  assert.equal(f.state.reads.length, 0); assert.equal(f.state.closed, 1); assert.equal(f.mounted.node.children.length, 0);
});

test('disposing during a delayed read aborts it and ignores its late result', async () => {
  let finish, signal; const f = fixture({ client: { readBlob(_entry, options) { signal = options.signal; return new Promise(resolve => { finish = resolve; }); } } });
  await flush(); f.mounted.dispose(); assert.equal(signal.aborted, true); finish(new Blob(['late plaintext'])); await f.mounted.ready;
  assert.equal(f.mounted.node.children.length, 0); assert.equal(f.state.closed, 1);
});

test('saving an inline edit keeps the same session open and reports the encrypted-copy result', async () => {
  let saved; const f = fixture({ onSaved(value) { saved = value; } }); await f.mounted.ready; const input = await edit(f.mounted); save(f.mounted); await flush();
  assert.equal(f.state.saved.length, 1); assert.equal(await f.state.saved[0].blob.text(), 'updated private text'); assert.deepEqual(saved, { id: 'saved-copy' });
  assert.equal(f.mounted.closed, false); assert.equal(f.mounted.dirty, false); assert.equal(f.mounted.saving, false); assert.equal(input.disabled, false); assert.equal(f.state.closed, 0); f.mounted.dispose();
});

test('dirty close during an upload asks before aborting and late upload completion cannot save into a closed pane', async () => {
  let finish, uploadSignal, saved = 0; const f = fixture({ onSaved() { saved++; }, client: { saveEditedCopy(_entry, _blob, options) { uploadSignal = options.signal; return new Promise(resolve => { finish = resolve; }); } } });
  await f.mounted.ready; const input = await edit(f.mounted); save(f.mounted); await flush(); assert.equal(f.mounted.saving, true);
  globalThis.confirm = () => false; assert.equal(f.mounted.requestClose(), false); assert.equal(uploadSignal.aborted, false);
  globalThis.confirm = () => true; assert.equal(f.mounted.requestClose(), true); assert.equal(uploadSignal.aborted, true); assert.equal(input.value, '');
  finish({ id: 'late-copy' }); await flush(); assert.equal(saved, 0); assert.equal(f.state.closed, 1);
});

test('large media keeps its separate 10 GiB Blob path and abort signal', async () => {
  let options, finish; const f = fixture({ entry: { name: 'film.mkv', type: 'video/x-matroska' }, client: { readMediaBlob(_entry, value) { options = value; return new Promise(resolve => { finish = resolve; }); }, readBlob() { assert.fail('large media must use the media Blob reader'); } } });
  await flush(); assert.equal(options.maxBytes, 10 * 1024 ** 3); f.mounted.dispose(); assert.equal(options.signal.aborted, true); finish(new Blob()); await f.mounted.ready; assert.equal(f.mounted.node.children.length, 0);
});

test('archive members preview in the same pane and Back preserves the parent archive with dirty protection', async () => {
  let environment; globalThis.__vaultSessionArchive = async (_blob, _entry, options) => { environment = options; options.stage.append(new Element('article')); return null; };
  const f = fixture({ entry: { name: 'files.zip', type: 'application/zip' } }); await f.mounted.ready; const original = [...f.mounted.node.children];
  await environment.onPreview({ entry: { name: 'member.txt' }, blob: new Blob(['archive private text'], { type: 'text/plain' }) });
  assert.equal(f.mounted.node.children.length, 1); const nested = f.mounted.node.children[0]; const input = await edit({ node: nested }); assert.equal(f.mounted.dirty, true);
  globalThis.confirm = () => false; assert.equal(f.mounted.requestClose(), false); nested.querySelector('.vault-editor-dismiss').dispatchEvent(new Event('click')); assert.equal(input.value, 'updated private text');
  globalThis.confirm = () => true; nested.querySelector('.vault-editor-dismiss').dispatchEvent(new Event('click')); assert.deepEqual(f.mounted.node.children, original); assert.equal(input.value, ''); assert.equal(f.mounted.dirty, false); assert.equal(f.state.closed, 0); f.mounted.dispose();
});

test('aborting a parent archive force-disposes its dirty nested member without a prompt', async () => {
  let environment; globalThis.__vaultSessionArchive = async (_blob, _entry, options) => { environment = options; return null; }; const scope = new AbortController();
  const f = fixture({ signal: scope.signal, entry: { name: 'files.zip', type: 'application/zip' } }); await f.mounted.ready;
  await environment.onPreview({ entry: { name: 'member.txt' }, blob: new Blob(['private text'], { type: 'text/plain' }) }); const input = await edit(f.mounted);
  globalThis.confirm = () => assert.fail('lifetime abort must not prompt'); scope.abort(); assert.equal(input.value, ''); assert.equal(f.mounted.node.children.length, 0); assert.equal(f.state.closed, 1);
});


test('external headers hide only the top heading and nested archive members retain their Back control', async () => {
  let environment; globalThis.__vaultSessionArchive = async (_blob, _entry, options) => { environment = options; return null; };
  const f = fixture({ externalHeader: true, entry: { name: 'files.zip', type: 'application/zip' } }); await f.mounted.ready;
  assert.equal(f.mounted.node.querySelector('.vault-editor-heading').hidden, true);
  await environment.onPreview({ entry: { name: 'member.txt' }, blob: new Blob(['private text'], { type: 'text/plain' }) });
  assert.equal(f.mounted.node.querySelector('.vault-editor-heading').hidden, false);
  assert.equal(f.mounted.node.querySelector('.vault-editor-dismiss').attributes.get('aria-label'), 'Back to archive'); f.mounted.dispose();
});


test('async discard cancellation preserves edits and confirmation closes once without duplicate prompts', async () => {
  let answer, prompts = 0;
  const f = fixture({ confirmDiscard() { prompts++; return new Promise(resolve => { answer = resolve; }); } });
  await f.mounted.ready; const input = await edit(f.mounted);
  globalThis.confirm = () => assert.fail('custom confirmation must replace the native dialog');
  const checking = f.mounted.canClose(), closing = f.mounted.requestClose();
  assert.equal(typeof checking.then, 'function'); assert.equal(prompts, 1); assert.equal(input.value, 'updated private text');
  answer(false); assert.equal(await checking, false); assert.equal(await closing, false); assert.equal(f.mounted.closed, false);
  const accepted = f.mounted.requestClose(); assert.equal(prompts, 2); answer(true); assert.equal(await accepted, true);
  assert.equal(f.state.closed, 1); assert.equal(input.value, '');
});

test('abort during an unresolved discard prompt settles false promptly and late acceptance cannot act', async () => {
  let answer; const scope = new AbortController();
  const f = fixture({ signal: scope.signal, confirmDiscard: () => new Promise(resolve => { answer = resolve; }) });
  await f.mounted.ready; const input = await edit(f.mounted); const closing = f.mounted.requestClose();
  scope.abort(); assert.equal(await closing, false); assert.equal(f.state.closed, 1); assert.equal(input.value, '');
  answer(true); await flush(); assert.equal(f.state.closed, 1); assert.equal(f.mounted.node.children.length, 0);
});

test('nested archive Back awaits the inherited async prompt and parent close checks the dirty child first', async () => {
  let environment, answer, prompts = 0;
  globalThis.__vaultSessionArchive = async (_blob, _entry, options) => { environment = options; return null; };
  const f = fixture({ entry: { name: 'files.zip', type: 'application/zip' }, confirmDiscard() { prompts++; return new Promise(resolve => { answer = resolve; }); } });
  await f.mounted.ready; const original = [...f.mounted.node.children];
  await environment.onPreview({ entry: { name: 'member.txt' }, blob: new Blob(['private text'], { type: 'text/plain' }) });
  const nested = f.mounted.node.children[0], input = await edit({ node: nested });
  nested.querySelector('.vault-editor-dismiss').dispatchEvent(new Event('click'));
  assert.equal(prompts, 1); assert.equal(f.mounted.node.children[0], nested); answer(false); await flush(); assert.equal(input.value, 'updated private text');
  const closing = f.mounted.requestClose(); assert.equal(prompts, 2); answer(false); assert.equal(await closing, false); assert.equal(f.state.closed, 0);
  nested.querySelector('.vault-editor-dismiss').dispatchEvent(new Event('click')); assert.equal(prompts, 3); answer(true); await flush();
  assert.deepEqual(f.mounted.node.children, original); assert.equal(input.value, ''); assert.equal(f.mounted.closed, false); f.mounted.dispose();
});

test('discard callback failures preserve the session and its edits', async () => {
  for (const confirmDiscard of [() => { throw new Error('dialog failed'); }, () => Promise.reject(new Error('dialog failed'))]) {
    const f = fixture({ confirmDiscard }); await f.mounted.ready; const input = await edit(f.mounted);
    assert.equal(await f.mounted.requestClose(), false); assert.equal(f.mounted.closed, false); assert.equal(input.value, 'updated private text'); f.mounted.dispose();
  }
});


test('copy name stays disabled while decrypting and becomes editable only when its local editor is ready', async () => {
  let finish; const f = fixture({ client: { readBlob() { return new Promise(resolve => { finish = resolve; }); } } });
  const filename = f.mounted.node.querySelector('input'); assert.equal(filename.disabled, true); await flush(); assert.equal(filename.disabled, true);
  finish(new Blob(['private text'])); await f.mounted.ready; assert.equal(filename.disabled, true); assert.equal(f.mounted.mode, 'viewer');
  f.mounted.node.querySelector('.vault-editor-mode').dispatchEvent(new Event('click')); await flush();
  assert.equal(filename.disabled, false); assert.equal(f.mounted.mode, 'editor'); assert.equal(f.mounted.dirty, false); f.mounted.dispose();
});

test('files open as inert viewers without editing controls, save actions or unsaved-change prompts', async () => {
  const text = '<svg onload="fetch(\"https://outside.invalid\")"><script>danger()</script></svg>';
  const f = fixture({ entry: { name: 'untrusted.svg', type: 'image/svg+xml' }, client: { async readBlob() { return new Blob([text]); } } });
  await f.mounted.ready;
  assert.equal(f.mounted.mode, 'viewer'); assert.equal(f.mounted.dirty, false);
  assert.equal(f.mounted.node.querySelector('.vault-text-viewer').textContent, text);
  assert.equal(f.mounted.node.querySelector('textarea'), null);
  assert.equal(f.mounted.node.querySelector('.vault-editor-tools').hidden, true);
  assert.equal(f.mounted.node.querySelector('.vault-editor-footer').hidden, true);
  assert.equal(f.mounted.node.querySelector('.vault-editor-mode').textContent, 'Open editor');
  save(f.mounted); await flush(); assert.equal(f.state.saved.length, 0);
  globalThis.confirm = () => assert.fail('viewing must never create dirty changes');
  const content = f.mounted.node.querySelector('.vault-text-viewer'); assert.equal(f.mounted.requestClose(), true); assert.equal(content.textContent, '');
});

test('returning to the viewer awaits discard confirmation, restores the original and never rereads its chunks', async () => {
  let answer, prompts = 0;
  const f = fixture({ confirmDiscard() { prompts++; return new Promise(resolve => { answer = resolve; }); } });
  await f.mounted.ready; const original = f.mounted.node.querySelector('.vault-text-viewer');
  const input = await edit(f.mounted); assert.equal(original.textContent, ''); assert.equal(f.mounted.mode, 'editor');
  const mode = f.mounted.node.querySelector('.vault-editor-mode'); assert.equal(mode.textContent, 'Back to viewer');
  mode.dispatchEvent(new Event('click')); mode.dispatchEvent(new Event('click')); assert.equal(prompts, 1);
  answer(false); await flush(); assert.equal(f.mounted.mode, 'editor'); assert.equal(input.value, 'updated private text');
  mode.dispatchEvent(new Event('click')); assert.equal(prompts, 2); answer(true); await flush();
  assert.equal(f.mounted.mode, 'viewer'); assert.equal(f.mounted.dirty, false); assert.equal(input.value, '');
  assert.equal(f.mounted.node.querySelector('.vault-text-viewer').textContent, 'private text');
  assert.equal(f.state.reads.length, 1); assert.equal(f.state.saved.length, 0); assert.equal(f.mounted.closed, false);
  await edit(f.mounted); assert.equal(f.state.reads.length, 1); f.mounted.dispose();
});

test('saving a copy preserves the original viewer and mode changes remain blocked until upload finishes', async () => {
  let finish; const f = fixture({ client: { saveEditedCopy(_entry, blob) { return new Promise(resolve => { finish = () => resolve({ id: 'saved-copy', blob }); }); } } });
  await f.mounted.ready; await edit(f.mounted); save(f.mounted); await flush(); assert.equal(f.mounted.saving, true);
  f.mounted.node.querySelector('.vault-editor-mode').dispatchEvent(new Event('click')); await flush(); assert.equal(f.mounted.mode, 'editor');
  finish(); await flush(); assert.equal(f.mounted.dirty, false); assert.equal(f.mounted.saving, false);
  f.mounted.node.querySelector('.vault-editor-mode').dispatchEvent(new Event('click')); await flush();
  assert.equal(f.mounted.mode, 'viewer'); assert.equal(f.mounted.node.querySelector('.vault-text-viewer').textContent, 'private text');
  assert.equal(f.state.reads.length, 1); f.mounted.dispose();
});

test('abort during a viewer-return prompt wipes edits and a late confirmation cannot remount plaintext', async () => {
  let answer; const scope = new AbortController();
  const f = fixture({ signal: scope.signal, confirmDiscard: () => new Promise(resolve => { answer = resolve; }) });
  await f.mounted.ready; const input = await edit(f.mounted);
  f.mounted.node.querySelector('.vault-editor-mode').dispatchEvent(new Event('click')); scope.abort(); await flush();
  assert.equal(input.value, ''); assert.equal(f.mounted.closed, true); assert.equal(f.mounted.node.children.length, 0);
  answer(true); await flush(); assert.equal(f.mounted.node.children.length, 0); assert.equal(f.state.reads.length, 1);
});
