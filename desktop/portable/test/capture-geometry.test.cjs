"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { captureGeometry } = require("../capture-geometry.cjs");

test("crop geometry rounds inward and bounds the confirmed output", () => {
  const result = captureGeometry({ width: 1920, height: 1080 }, { height: 1080, fps: 30,
    region: { x: .1001, y: .1001, width: .5, height: .5, sourceWidth: 1920, sourceHeight: 1080 } });
  assert.equal(result.x, 193);
  assert.equal(result.y, 109);
  assert.equal(result.x + result.cropWidth, 1152);
  assert.equal(result.y + result.cropHeight, 648);
  assert(result.width <= 1920 && result.height <= 1080);
  assert.equal(result.width % 2, 0);
  assert.equal(result.height % 2, 0);
});

test("full sources retain their aspect and small sources are not upscaled", () => {
  const result = captureGeometry({ width: 1280, height: 720 }, { height: 1440, fps: 60, region: null });
  assert.equal(result.width, 1280);
  assert.equal(result.height, 720);
  assert.equal(result.cropWidth, 1280);
});

test("source dimension changes and outside rectangles are rejected before output", () => {
  const region = { x: .1, y: .1, width: .5, height: .5, sourceWidth: 1280, sourceHeight: 720 };
  assert.throws(() => captureGeometry({ width: 1920, height: 1080 }, { region }), /changed size/);
  assert.throws(() => captureGeometry({ width: 1280, height: 720 }, { region: { ...region, width: 1 } }));
  assert.throws(() => captureGeometry({ width: 1280, height: 720 }, { region: { ...region, x: NaN } }));
});
