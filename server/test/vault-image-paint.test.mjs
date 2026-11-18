import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { VAULT_PAINT_LIMITS, createPaintHistory, floodPaintPixels, paintSelectionRect } from '../../web/vault-image-paint.js';
globalThis.location = new URL('https://rooms.example.test/?lang=en');

class Pixels {
  constructor(width, height) {
    this._width = width; this._height = height; this.data = new Uint8ClampedArray(width * height * 4); this.captures = [];
    this.canvas = { get width() { return this.owner._width; }, set width(value) { this.owner._width = value; this.owner.reset(); },
      get height() { return this.owner._height; }, set height(value) { this.owner._height = value; this.owner.reset(); }, owner: this };
  }
  reset() { this.data.fill(0); this.data = new Uint8ClampedArray(this._width * this._height * 4); }
  getImageData(x, y, width, height) {
    const image = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
      if (x + column < this._width && y + row < this._height) image.data.set(this.data.subarray(((y + row) * this._width + x + column) * 4, ((y + row) * this._width + x + column) * 4 + 4), (row * width + column) * 4);
    }
    this.captures.push(image.data); return image;
  }
  putImageData(image, x, y) {
    for (let row = 0; row < image.height; row++) for (let column = 0; column < image.width; column++) {
      if (x + column < this._width && y + row < this._height) this.data.set(image.data.subarray((row * image.width + column) * 4, (row * image.width + column) * 4 + 4), ((y + row) * this._width + x + column) * 4);
    }
  }
}
const rect = { x: 0, y: 0, width: 1, height: 1 };
function edit(history, pixels, value) {
  const record = history.begin(pixels, rect); pixels.data.fill(value); history.commit(record);
}

test('Paint limits are immutable and selection rectangles stay within image pixels in either direction', () => {
  assert.ok(Object.isFrozen(VAULT_PAINT_LIMITS)); assert.equal(VAULT_PAINT_LIMITS.historyBytes, 32 * 1024 ** 2);
  assert.deepEqual(paintSelectionRect({ x: 8, y: 6 }, { x: 2, y: 1 }, 10, 8), { x: 2, y: 1, width: 7, height: 6 });
  assert.deepEqual(paintSelectionRect({ x: -10, y: -10 }, { x: 50, y: 50 }, 10, 8), { x: 0, y: 0, width: 10, height: 8 });
  assert.equal(paintSelectionRect({ x: NaN, y: 0 }, { x: 1, y: 1 }, 10, 8), null);
});

test('Undo and redo restore exact pixels, swap one snapshot and wipe every released buffer', () => {
  const p = new Pixels(2, 2), h = createPaintHistory({ maxBytes: 32 }); p.data.fill(4);
  edit(h, p, 19); assert.equal(h.state.bytes, 16);
  assert.equal(h.undo(p), true); assert.deepEqual([...p.data], Array(16).fill(4));
  assert.equal(h.state.bytes, 16); assert.equal(h.state.redo, 1);
  assert.equal(h.redo(p), true); assert.deepEqual([...p.data], Array(16).fill(19));
  h.clear(); assert.equal(h.state.bytes, 0); assert.ok(p.captures.every(bytes => bytes.every(value => value === 0)));
  assert.ok(Object.isFrozen(h.state)); assert.equal(h.state.patches, undefined);
});

test('history enforces both byte and entry budgets and a new edit wipes redo pixels', () => {
  const p = new Pixels(2, 2), h = createPaintHistory({ maxBytes: 32 });
  edit(h, p, 1); edit(h, p, 2); edit(h, p, 3);
  assert.equal(h.state.undo, 2); assert.equal(h.state.bytes, 32); assert.ok(p.captures[0].every(value => value === 0));
  h.undo(p); assert.equal(p.data[0], 2); edit(h, p, 7);
  assert.equal(h.state.redo, 0); assert.equal(h.redo(p), false); assert.ok(h.state.bytes <= 32);
  const entries = createPaintHistory({ maxBytes: 1024 });
  for (let i = 0; i < 40; i++) edit(entries, p, i);
  assert.equal(entries.state.undo, VAULT_PAINT_LIMITS.historyEntries); entries.clear(); h.clear();
});

test('overlapping stroke tiles are captured once and oversized operations create a safe history barrier', () => {
  const p = new Pixels(2, 2), h = createPaintHistory({ maxBytes: 16 });
  const record = h.begin(p, rect); h.capture(record, p, { x: 1, y: 1, width: 1, height: 1 });
  assert.equal(p.captures.length, 1); h.commit(record);
  const huge = h.begin(p, null, { width: 3, height: 3 });
  assert.equal(p.captures.length, 1, 'no oversized snapshot is allocated');
  assert.equal(h.commit(huge), false); assert.equal(h.state.undo, 0); assert.equal(h.state.bytes, 0);
  assert.ok(p.captures[0].every(value => value === 0));
});

test('structural undo and redo restore dimensions as well as exact pixels', () => {
  const p = new Pixels(2, 2), h = createPaintHistory({ maxBytes: 128 }); p.data.fill(11);
  const record = h.begin(p, null, { width: 3, height: 2 });
  p.canvas.width = 3; p.data.fill(22); h.commit(record);
  h.undo(p); assert.equal(p.canvas.width, 2); assert.equal(p.canvas.height, 2); assert.deepEqual([...p.data], Array(16).fill(11));
  h.redo(p); assert.equal(p.canvas.width, 3); assert.deepEqual([...p.data], Array(24).fill(22));
  assert.ok(h.state.bytes <= 128); h.clear(); assert.ok(p.captures.every(bytes => bytes.every(value => value === 0)));
});

test('flood fill changes exactly the connected original color, including transparent pixels', async () => {
  const data = new Uint8ClampedArray([
    1, 1, 1, 0, 9, 9, 9, 255, 1, 1, 1, 0,
    1, 1, 1, 0, 9, 9, 9, 255, 1, 1, 1, 0,
    1, 1, 1, 0, 9, 9, 9, 255, 1, 1, 1, 0,
  ]);
  const image = { width: 3, height: 3, data }, color = [50, 60, 70, 255];
  assert.equal(await floodPaintPixels(image, 0, 0, color), true);
  for (let row = 0; row < 3; row++) {
    assert.deepEqual([...data.slice(row * 12, row * 12 + 4)], color);
    assert.deepEqual([...data.slice(row * 12 + 8, row * 12 + 12)], [1, 1, 1, 0]);
  }
  assert.equal(await floodPaintPixels(image, 0, 0, color), false);
});

test('fill validates buffers, colors, coordinates, resolution and pre-aborted operations', async () => {
  const valid = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
  for (const [image, x, color] of [[{ ...valid, data: new Uint8ClampedArray(4) }, 0, [0, 0, 0, 255]],
    [valid, NaN, [0, 0, 0, 255]], [valid, 0, [1]], [valid, 0, [256, 0, 0, 255]], [valid, 0, [0, .5, 0, 255]]]) {
    await assert.rejects(floodPaintPixels(image, x, 0, color), TypeError);
  }
  await assert.rejects(floodPaintPixels({ width: 100000, height: 100000, data: new Uint8ClampedArray(0) }, 0, 0, [1, 2, 3, 255]), /resolution/u);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(floodPaintPixels(valid, 0, 0, [1, 2, 3, 255], { signal: controller.signal }), { name: 'AbortError' });
});

test('large fill yields so cancellation can interrupt its bounded local buffer', async () => {
  const controller = new AbortController(), image = { width: 1024, height: 1024, data: new Uint8ClampedArray(1024 ** 2 * 4) };
  const pending = floodPaintPixels(image, 0, 0, [1, 2, 3, 255], { signal: controller.signal });
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(pending, { name: 'AbortError' }); image.data.fill(0);
});

class PaintElement extends EventTarget {
  constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.style = {}; this.dataset = {}; this.value = ''; this.hidden = false; this.disabled = false; }
  setAttribute(name, value) { this.attrs[name] = value; if (name === 'value') this.value = value; if (name === 'hidden') this.hidden = true; }
  append(...values) { this.children.push(...values.flat(Infinity).filter(value => value != null && value !== false)); }
  replaceChildren(...values) { this.children = []; this.append(...values); }
  set textContent(value) { this.replaceChildren(String(value)); }
  get textContent() { return this.children.map(value => value instanceof PaintElement ? value.textContent : String(value)).join(''); }
  focus() {}
  querySelectorAll(selector) {
    const found = [], tags = selector.split(',');
    for (const item of this.children) if (item instanceof PaintElement) {
      if (tags.includes(item.tagName.toLowerCase()) || selector.startsWith('.') && item.className?.split(' ').includes(selector.slice(1))) found.push(item);
      found.push(...item.querySelectorAll(selector));
    }
    return found;
  }
}
const ui = {
  el(tag, attrs = {}, ...children) { const element = new PaintElement(tag); Object.assign(element.attrs, attrs); element.value = attrs.value ?? ''; element.hidden = attrs.hidden ?? false; element.className = attrs.class ?? ''; element.append(...children); return element; },
  button(text, action, attrs) { const element = ui.el('button', attrs, text); element.addEventListener('click', action); return element; },
  field: (label, input) => ui.el('label', {}, label, input),
  select(options, value) { const element = ui.el('select', {}, options.map(([id, name]) => ui.el('option', { value: id }, name))); element.value = value; return element; },
  status: () => ui.el('p'), tell(element, value) { element.textContent = value; },
};
const sourceUrl = new URL('../../web/vault-image-paint.js', import.meta.url);
const actualSource = (await readFile(sourceUrl, 'utf8'))
  .replace('import { decodeVaultImage } from "./vault-image-inspect.js";', 'const decodeVaultImage = (...args) => globalThis.__paintDecode(...args);')
  .replace('await import("./ui.js")', 'globalThis.__paintUI')
  .replace(/from "\.\/([^"]+)"/gu, (_, path) => 'from ' + JSON.stringify(new URL(path, sourceUrl).href));
const { paintVaultImage } = await import('data:text/javascript;base64,' + Buffer.from(actualSource).toString('base64'));

test('Paint API closes its decoder, exposes tools and a nondirty palette, exports safely and wipes on dispose', async t => {
  const prior = { ui: globalThis.__paintUI, decode: globalThis.__paintDecode, document: globalThis.document };
  t.after(() => { for (const [key, value] of [['__paintUI', prior.ui], ['__paintDecode', prior.decode], ['document', prior.document]]) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  } });
  let closed = 0, dirty = 0; const canvas = new PaintElement('canvas'), pixels = new Pixels(2, 2);
  Object.defineProperties(canvas, { width: { get: () => pixels.canvas.width, set: value => { pixels.canvas.width = value; } },
    height: { get: () => pixels.canvas.height, set: value => { pixels.canvas.height = value; } } });
  pixels.drawImage = () => { pixels.data.fill(14); };
  canvas.getContext = () => pixels; canvas.toBlob = (done, type) => done(new Blob(['clean image'], { type }));
  globalThis.__paintUI = { ...ui, el(tag, attrs, ...children) { if (tag === 'canvas') return canvas; return ui.el(tag, attrs, ...children); } };
  globalThis.__paintDecode = async () => ({ width: 2, height: 2, close() { closed++; } });
  globalThis.document = { createElement: tag => new PaintElement(tag) };
  const stage = ui.el('div'), filename = ui.el('input', { value: 'copy.png' }), disposers = [];
  const build = await paintVaultImage(new Blob(['original']), { stage, filename, disposers, dirtyChanged() { dirty++; } });
  assert.equal(closed, 1); assert.equal(typeof build, 'function');
  assert.equal(stage.querySelectorAll('select')[0].querySelectorAll('option').length, 10);
  const palette = stage.querySelectorAll('.vault-paint-swatch'); assert.equal(palette.length, 16);
  palette[4].dispatchEvent(new Event('click')); assert.equal(dirty, 0);
  assert.equal(palette[4].attrs['aria-pressed'], 'true');
  assert.equal((await build()).type, 'image/png');
  const format = stage.querySelectorAll('select').find(element => element.attrs['aria-label'] === 'Output format');
  format.value = 'image/webp'; format.dispatchEvent(new Event('change'));
  assert.equal(filename.value, 'copy.webp'); assert.equal((await build()).type, 'image/webp');
  disposers[0](); assert.equal(canvas.width, 1); assert.equal(canvas.height, 1); assert.equal(stage.textContent, '');
  await assert.rejects(build(), { name: 'AbortError' });
});
