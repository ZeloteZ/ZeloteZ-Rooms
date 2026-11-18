import assert from "node:assert/strict";
import test from "node:test";
globalThis.location = new URL("https://rooms.example.test/#/vault");
globalThis.localStorage = { getItem: () => "en" };
const { inspectMediaTracks, attachMediaTracks } = await import("../../web/vault-media-tracks.js");
class WorkerFixture {
  static instances = [];
  constructor() { WorkerFixture.instances.push(this); }
  postMessage(value) { this.input = value; }
  terminate() { this.terminated = true; }
  result(value) { this.onmessage({ data: { result: value } }); }
}
async function pendingWorker() {
  while (!WorkerFixture.instances.length) await new Promise(resolve => setImmediate(resolve));
  return WorkerFixture.instances.at(-1);
}
function fixture(t) {
  const previous = globalThis.Worker; globalThis.Worker = WorkerFixture; WorkerFixture.instances = [];
  t.after(() => { globalThis.Worker = previous; });
}
function result() {
  return { audio: [{ id: "1", language: "deu", label: "Private track", default: true }],
    audioPatches: { "1": [{ offset: 0, bytes: new Uint8Array([9]) }] },
    subtitles: [{ id: "2", language: "eng", label: "Private captions", format: "srt", supported: true,
      cues: [{ start: 0, end: 1, text: "Private cue text" }] }] };
}
test("queued worker results after abort and invalid results erase private cues and patch bytes", async t => {
  fixture(t);
  const controller = new AbortController(), promise = inspectMediaTracks(new Blob([new Uint8Array([1])]), { signal: controller.signal });
  const worker = await pendingWorker(); controller.abort(); await assert.rejects(promise, { name: "AbortError" });
  const late = result(), cue = late.subtitles[0].cues[0], patch = late.audioPatches["1"][0].bytes;
  worker.result(late);
  assert.equal(cue.text, ""); assert.equal(late.subtitles.length, 0); assert.deepEqual(patch, new Uint8Array([0]));
  WorkerFixture.instances = [];
  const invalidPromise = inspectMediaTracks(new Blob([new Uint8Array([1])]));
  const invalidWorker = await pendingWorker(), invalid = result(), invalidCue = invalid.subtitles[0].cues[0];
  invalid.audioPatches["1"][0].offset = 999; invalidWorker.result(invalid);
  await assert.rejects(invalidPromise); assert.equal(invalidCue.text, ""); assert.equal(invalid.audio.length, 0);
});

test("disposing a controller clears its pending owned media source while preserving parent-owned sources", async t => {
  fixture(t);
  class MediaFixture extends EventTarget {
    constructor() { super(); this.src = "blob:parent-owned"; this.textTracks = []; this.paused = false; this.currentTime = .5; this.volume = .3; this.muted = true; this.playbackRate = 1.25; this.loads = 0; }
    get currentSrc() { return this.src; }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === "src") this.src = ""; }
    load() { this.loads++; }
  }
  const media = new MediaFixture(), scope = new AbortController();
  const attaching = attachMediaTracks(media, new Blob([new Uint8Array([1])]), { signal: scope.signal });
  const worker = await pendingWorker(), metadata = result(); metadata.subtitles = [];
  worker.result(metadata); const controller = await attaching;
  const changing = controller.selectAudio("1");
  while (!media.loads) await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(media.src, "blob:parent-owned"); scope.abort(); await assert.rejects(changing, { name: "AbortError" });
  assert.equal(media.src, ""); assert.equal(media.paused, true); assert.equal(media.loads, 2);
  controller.dispose(); assert.equal(media.loads, 2);
});

test("a selected stream with no decodable audio restores the previous source and playback state", async t => {
  fixture(t);
  class MediaFixture extends EventTarget {
    constructor() { super(); this.src = "blob:parent-owned"; this.textTracks = []; this.paused = true; this._time = .25; this.volume = .4; this.muted = true; this.playbackRate = .75; this.duration = 2; this.captureStops = 0; }
    get currentSrc() { return this.src; }
    get currentTime() { return this._time; }
    set currentTime(value) { this._time = value; queueMicrotask(() => this.dispatchEvent(new Event("seeked"))); }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === "src") this.src = ""; }
    load() { this._time = 0; queueMicrotask(() => { this.dispatchEvent(new Event("loadedmetadata")); this.dispatchEvent(new Event("loadeddata")); }); }
    captureStream() { return { getAudioTracks: () => this.src === "blob:parent-owned" ? [{}] : [], getTracks: () => [{ stop: () => { this.captureStops++; } }] }; }
  }
  const media = new MediaFixture(), attaching = attachMediaTracks(media, new Blob([new Uint8Array([1])]));
  const worker = await pendingWorker(), metadata = result(); metadata.subtitles = []; worker.result(metadata);
  const controller = await attaching;
  await assert.rejects(controller.selectAudio("1"), /cannot be decoded/u);
  assert.equal(media.src, "blob:parent-owned"); assert.equal(media.currentTime, .25); assert.equal(media.paused, true);
  assert.equal(media.playbackRate, .75); assert.equal(media.volume, .4); assert.equal(media.muted, true);
  assert.equal(controller.audioId, "original"); assert.equal(controller.switching, false); assert.equal(media.captureStops, 1);
  controller.dispose(); assert.equal(media.src, "blob:parent-owned");
});
