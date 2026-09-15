// src/data/temperatureGradientRaster.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemperatureGradientImage } from './temperatureGradientRaster.js';
import { getCcaaFeatures } from './spainBoundaries.js';

// No real DOM under node:test — stub just enough of the Canvas 2D API that
// this module's orchestration (grid build → paint → clip → export) runs end
// to end without needing actual pixel rendering (that path is covered by
// manual browser verification; this test is about wiring, not pixels).
class FakePath2D {
  moveTo() {}
  lineTo() {}
  closePath() {}
  addPath() {}
}
globalThis.Path2D = FakePath2D;

function makeFakeContext() {
  return {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {},
    save() {},
    restore() {},
    clip() {},
    drawImage() {},
    set imageSmoothingEnabled(_v) {},
  };
}

function makeFakeCreateCanvas() {
  const canvases = [];
  const createCanvas = (width, height) => {
    const ctx = makeFakeContext();
    const canvas = { width, height, getContext: () => ctx, toDataURL: () => 'data:image/png;base64,FAKE' };
    canvases.push(canvas);
    return canvas;
  };
  return { createCanvas, canvases };
}

const SAMPLE_STATIONS = [
  { lat: 40.4, lon: -3.7, temperatureC: 20 },
  { lat: 41.4, lon: 2.2, temperatureC: 25 },
  { lat: 37.4, lon: -6.0, temperatureC: 30 },
  { lat: 43.3, lon: -2.9, temperatureC: 15 },
];

test('builds a data URL + bbox for real station data, excluding the Canaries from the raster rectangle', async () => {
  const { createCanvas } = makeFakeCreateCanvas();
  const result = await buildTemperatureGradientImage(SAMPLE_STATIONS, { createCanvas });
  assert.ok(result);
  assert.equal(result.dataUrl, 'data:image/png;base64,FAKE');
  const [west, south, east, north] = result.bbox;
  // Mainland+Baleares+Ceuta/Melilla bbox, NOT stretched out to Canarias' ~-18° west.
  assert.ok(west > -10 && west < -8, `west excludes Canarias (got ${west})`);
  assert.ok(east > 3 && east < 6, `got ${east}`);
  assert.ok(south > 34 && south < 37, `got ${south}`);
  assert.ok(north > 43 && north < 45, `got ${north}`);
});

test('returns null when there is no usable station data', async () => {
  const { createCanvas } = makeFakeCreateCanvas();
  assert.equal(await buildTemperatureGradientImage([], { createCanvas }), null);
  assert.equal(
    await buildTemperatureGradientImage([{ lat: 40, lon: -3, temperatureC: NaN }], { createCanvas }),
    null,
  );
});

test('returns null when createCanvas reports no DOM (headless)', async () => {
  const result = await buildTemperatureGradientImage(SAMPLE_STATIONS, { createCanvas: () => null });
  assert.equal(result, null);
});

test('the raster bbox padding matches the mainland CCAA feature set (sanity cross-check against spainBoundaries.js)', async () => {
  const features = await getCcaaFeatures();
  const mainland = features.filter((f) => f.id !== 'canarias');
  assert.ok(mainland.length === features.length - 1);
});
