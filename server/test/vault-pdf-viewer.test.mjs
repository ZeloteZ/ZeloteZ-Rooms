import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

globalThis.location = new URL('https://rooms.example.test/#/vault');
globalThis.localStorage = { getItem() { return 'en'; } };
globalThis.document = { querySelector() { return null; } };
const { mountVaultPdfViewer, VAULT_PDF_VIEWER_LIMITS: limits } = await import('../../web/vault-pdf-viewer.js');
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture(t, { count = 500, width = 612, height = 792, delayedPage, delayedRender, ignoreCancel = false, cancelThrows = false } = {}) {
  const prior = new Map(['document', 'ResizeObserver', 'devicePixelRatio'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const canvases = [], requests = [], tasks = [], pages = new Map(), disposers = [];
  let peakPixels = 0, peakCanvases = 0, resize;
  function measure() {
    const active = canvases.filter(canvas => canvas.width * canvas.height > 0);
    peakCanvases = Math.max(peakCanvases, active.length);
    peakPixels = Math.max(peakPixels, active.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0));
  }
  class Element extends EventTarget {
    constructor(tag) {
      super(); this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attributes = new Map();
      this.style = {}; this.className = ''; this.value = ''; this.hidden = false; this.disabled = false;
      this.clientWidth = 800; this.clientHeight = 600; this.scrollTop = 0; this._width = 0; this._height = 0;
      if (tag === 'canvas') { this._width = 300; this._height = 150; canvases.push(this); measure(); }
    }
    set width(value) { this._width = value; measure(); } get width() { return this._width; }
    set height(value) { this._height = value; measure(); } get height() { return this._height; }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === 'value') this.value = String(value);
      if (name === 'hidden') this.hidden = true;
      if (name === 'disabled') this.disabled = true;
    }
    get textContent() { return this.children.map(value => value instanceof Element ? value.textContent : String(value)).join(''); }
    set textContent(value) { this.replaceChildren(String(value)); }
    append(...children) { for (const child of children) { if (child instanceof Element) { child.remove(); child.parentNode = this; } this.children.push(child); } }
    replaceChildren(...children) { for (const child of this.children) if (child instanceof Element) child.parentNode = null; this.children = []; this.append(...children); }
    remove() { if (!this.parentNode) return; const siblings = this.parentNode.children; siblings.splice(siblings.indexOf(this), 1); this.parentNode = null; }
    getContext() { return { canvas: this }; }
    querySelectorAll(selector) {
      const result = [], matches = value => selector.startsWith('.') ? value.className.split(' ').includes(selector.slice(1)) : value.tagName === selector.toUpperCase();
      for (const child of this.children) if (child instanceof Element) { if (matches(child)) result.push(child); result.push(...child.querySelectorAll(selector)); }
      return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  }
  Object.defineProperties(globalThis, {
    document: { value: { createElement: tag => new Element(tag), activeElement: null }, configurable: true },
    ResizeObserver: { value: class { constructor(callback) { resize = callback; } observe() {} disconnect() { this.disconnected = true; } }, configurable: true },
    devicePixelRatio: { value: 2, configurable: true },
  });
  function page(number) {
    if (pages.has(number)) return pages.get(number);
    const item = { cleaned: 0, getViewport({ scale }) { return { width: width * scale, height: height * scale }; },
      cleanup() { item.cleaned++; }, render(options) {
        assert.equal(options.annotationMode, 0, 'PDF previews must not create active annotations');
        const gate = deferred(), task = { options, cancelled: 0, promise: gate.promise,
          cancel() {
            task.cancelled++;
            if (cancelThrows) throw new Error('cancel failure');
            if (!ignoreCancel) gate.reject(Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' }));
          }, finish() { gate.resolve(); }, fail(error) { gate.reject(error); } };
        tasks.push(task);
        if (number !== delayedRender) gate.resolve();
        return task;
      } };
    pages.set(number, item); return item;
  }
  const pageGate = deferred(), scope = new AbortController(), stage = new Element('div');
  const pdf = { numPages: count, getPage(number) { requests.push(number); return number === delayedPage ? pageGate.promise : Promise.resolve(page(number)); }, destroy() { assert.fail('the caller owns PDF document destruction'); } };
  t.after(() => {
    scope.abort(); for (const dispose of disposers) dispose();
    for (const [name, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  });
  return { stage, pdf, scope, disposers, canvases, requests, tasks, pages, page, pageGate,
    mount: () => mountVaultPdfViewer(pdf, { signal: scope.signal, stage, disposers }),
    get peakPixels() { return peakPixels; }, get peakCanvases() { return peakCanvases; },
    resize: () => resize(), find: selector => stage.querySelector(selector), all: selector => stage.querySelectorAll(selector) };
}

test('500-page PDFs create a continuous placeholder document but only a bounded local rendering window', async t => {
  const f = fixture(t); assert.equal(await f.mount(), null);
  assert.equal(f.all('.vault-pdf-page').length, 500);
  assert.equal(f.requests.length, limits.canvases);
  assert.ok(parseFloat(f.find('.vault-pdf-pages').style.height) > 500 * 600);
  assert.ok(f.peakCanvases <= limits.canvases);
  const scroller = f.find('.vault-pdf-scroller');
  scroller.scrollTop = parseFloat(f.all('.vault-pdf-page')[350].style.top);
  scroller.dispatchEvent(new Event('scroll')); await flush();
  assert.ok(f.requests.some(number => number >= 350));
  assert.ok(f.all('.vault-pdf-page-canvas').length <= limits.canvases);
  assert.ok(f.canvases.slice(0, 4).every(canvas => canvas.width === 0 && canvas.height === 0));
  assert.ok(f.pages.get(1).cleaned > 0);
  assert.ok(f.peakPixels <= limits.residentPixels);
});

test('page jumping, zoom and resize keep real canvas allocations below the aggregate and individual pixel limits', async t => {
  const f = fixture(t, { width: 4000, height: 6000 }); await f.mount();
  const zoom = f.find('.vault-pdf-zoom'), jump = f.find('.vault-pdf-page-input'), scroller = f.find('.vault-pdf-scroller');
  scroller.clientWidth = 10000; scroller.clientHeight = 10000; f.resize(); await flush();
  for (const value of ['3', '0.25', 'fit', '2']) { zoom.value = value; zoom.dispatchEvent(new Event('change')); await flush(); }
  jump.value = '450'; jump.dispatchEvent(new Event('change')); await flush();
  assert.ok(scroller.scrollTop > 100000);
  assert.ok(f.requests.some(number => number === 450));
  const before = scroller.scrollTop;
  jump.value = '999999999999'; jump.dispatchEvent(new Event('change')); assert.equal(scroller.scrollTop, before);
  assert.ok(f.peakCanvases <= limits.canvases); assert.ok(f.peakPixels <= limits.residentPixels);
  for (const canvas of f.canvases) assert.ok(canvas.width * canvas.height <= limits.pagePixels);
  assert.equal(f.all('.vault-pdf-page').length, 500);
});

test('aborting while getPage is pending cleans a late page and never recreates detached plaintext surfaces', async t => {
  const f = fixture(t, { delayedPage: 1 }), ready = f.mount();
  assert.deepEqual(f.requests, [1]); f.scope.abort(); await ready;
  assert.equal(f.stage.children.length, 0); assert.equal(f.canvases.length, 0);
  const late = f.page(1); f.pageGate.resolve(late); await flush();
  assert.ok(late.cleaned > 0); assert.equal(f.stage.children.length, 0); assert.equal(f.canvases.length, 0);
});

test('aborting an in-flight render cancels and wipes immediately, then wipes again after a hostile late completion', async t => {
  const f = fixture(t, { delayedRender: 1, ignoreCancel: true }), ready = f.mount(); await flush();
  const task = f.tasks[0], canvas = task.options.canvasContext.canvas;
  assert.ok(canvas.width * canvas.height > 0); f.scope.abort(); await ready;
  assert.ok(task.cancelled > 0); assert.equal(canvas.width * canvas.height, 0); assert.equal(f.stage.children.length, 0);
  canvas.width = 17; canvas.height = 19; task.finish(); await flush();
  assert.equal(canvas.width, 0); assert.equal(canvas.height, 0); assert.equal(f.stage.children.length, 0);
});

test('scrolling away cancels an unfinished page before it settles and renders the new window without retaining old canvases', async t => {
  const f = fixture(t, { delayedRender: 1 }), ready = f.mount(); await flush();
  const task = f.tasks[0], scroller = f.find('.vault-pdf-scroller');
  scroller.scrollTop = parseFloat(f.all('.vault-pdf-page')[300].style.top); scroller.dispatchEvent(new Event('scroll'));
  assert.ok(task.cancelled > 0); assert.equal(task.options.canvasContext.canvas.width, 0);
  await ready; await flush(); assert.ok(f.requests.some(number => number >= 300));
  assert.ok(f.peakCanvases <= limits.canvases); assert.ok(f.peakPixels <= limits.residentPixels);
});

test('zoom invalidates an unfinished render and stale completion cannot replace the current zoom surfaces', async t => {
  const f = fixture(t, { delayedRender: 1, ignoreCancel: true }), ready = f.mount(); await flush();
  const task = f.tasks[0], old = task.options.canvasContext.canvas, zoom = f.find('.vault-pdf-zoom');
  zoom.value = '0.5'; zoom.dispatchEvent(new Event('change')); assert.ok(task.cancelled > 0); assert.equal(old.width, 0);
  // Let only the original render wait; subsequent render tasks finish normally.
  const originalRender = f.page(1).render;
  f.page(1).render = options => { const task = originalRender(options); task.finish(); return task; };
  task.finish(); await ready; await flush();
  assert.equal(old.width, 0); assert.equal(old.height, 0);
  assert.ok(f.all('.vault-pdf-page-canvas').every(canvas => canvas !== old));
  assert.ok(f.peakPixels <= limits.residentPixels);
});

test('resize notifications coalesce outside the observer callback and a late animation frame cannot remount after abort', async t => {
  const previous = new Map(['requestAnimationFrame', 'cancelAnimationFrame'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const frames = [], cancelled = [];
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  globalThis.cancelAnimationFrame = handle => cancelled.push(handle);
  t.after(() => { for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  const f = fixture(t); await f.mount(); const count = f.requests.length;
  f.find('.vault-pdf-scroller').clientWidth = 500; f.resize(); f.resize();
  assert.equal(frames.length, 1); assert.equal(f.requests.length, count);
  f.scope.abort(); assert.deepEqual(cancelled, [1]); frames[0](); await flush();
  assert.equal(f.stage.children.length, 0); assert.equal(f.requests.length, count);
  assert.ok(f.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});

test('broken cancellation still aborts without leaving an unresolved viewer or canvas surface', async t => {
  const f = fixture(t, { delayedRender: 1, ignoreCancel: true, cancelThrows: true }), ready = f.mount(); await flush();
  f.scope.abort(); await ready;
  assert.equal(f.stage.children.length, 0); assert.ok(f.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  f.tasks[0].finish(); await flush();
});

test('a page timeout pauses further work instead of accumulating unresolved PDF loads on repeated zooms', async t => {
  const original = globalThis.setTimeout; let timeout;
  globalThis.setTimeout = (callback, milliseconds, ...args) => {
    if (milliseconds === limits.milliseconds) { timeout = callback; return 0; }
    return original(callback, milliseconds, ...args);
  };
  t.after(() => { globalThis.setTimeout = original; });
  const f = fixture(t, { delayedPage: 1 }), ready = f.mount();
  timeout(); await ready;
  assert.match(f.find('.vault-pdf-status').textContent, /timed out/u);
  const zoom = f.find('.vault-pdf-zoom');
  for (const value of ['2', '0.5', 'fit']) { zoom.value = value; zoom.dispatchEvent(new Event('change')); }
  await flush(); assert.deepEqual(f.requests, [1]); assert.equal(f.canvases.length, 0);
  const late = f.page(1); f.pageGate.resolve(late); await flush(); assert.ok(late.cleaned > 0);
});

test('an already-aborted viewer never loads a page or creates DOM', async t => {
  const f = fixture(t); f.scope.abort(); assert.equal(await f.mount(), null);
  assert.equal(f.requests.length, 0); assert.equal(f.stage.children.length, 0); assert.equal(f.canvases.length, 0);
});

test('invalid page counts and unsafe page geometry fail without allocating large surfaces', async t => {
  const f = fixture(t, { count: 2, width: Infinity, height: 1 });
  for (const count of [0, 501, Infinity, 2.5]) {
    await assert.rejects(mountVaultPdfViewer({ ...f.pdf, numPages: count }, { stage: f.stage, signal: f.scope.signal, disposers: f.disposers }), /preview limit/u);
    assert.equal(f.canvases.length, 0);
  }
  await f.mount();
  assert.equal(f.canvases.length, 0); assert.match(f.find('.vault-pdf-status').textContent ?? '', /displayed/u);
});

test('the standalone CSS confines scrolling to the inner reader and gives it a shrinkable grid row', async () => {
  const css = await readFile(new URL('../../web/vault-pdf-viewer.css', import.meta.url), 'utf8');
  assert.match(css, /\.vault-pdf-reader\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)/u);
  assert.match(css, /\.vault-pdf-reader\s*\{[^}]*overflow:\s*hidden/u);
  assert.match(css, /\.vault-pdf-scroller\s*\{[^}]*min-block-size:\s*0[^}]*overflow:\s*auto/u);
});
