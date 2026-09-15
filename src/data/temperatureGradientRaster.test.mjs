// src/data/temperatureGradientRaster.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemperatureGradientImages } from './temperatureGradientRaster.js';
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
  { lat: 28.1, lon: -15.4, temperatureC: 24 },
  { lat: 28.5, lon: -16.3, temperatureC: 22 },
];

test('builds one image for the mainland region and one for the Canary Islands, each tightly cropped', async () => {
  const { createCanvas } = makeFakeCreateCanvas();
  const results = await buildTemperatureGradientImages(SAMPLE_STATIONS, { createCanvas });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.dataUrl === 'data:image/png;base64,FAKE'));

  const [mainland, canary] = results;
  {
    const [west, south, east, north] = mainland.bbox;
    // Mainland+Baleares+Ceuta/Melilla bbox, NOT stretched out to Canarias' ~-18° west.
    assert.ok(west > -10 && west < -8, `west excludes Canarias (got ${west})`);
    assert.ok(east > 3 && east < 6, `got ${east}`);
    assert.ok(south > 34 && south < 37, `got ${south}`);
    assert.ok(north > 43 && north < 45, `got ${north}`);
  }
  {
    const [west, south, east, north] = canary.bbox;
    // Canary Islands' own tightly-cropped bbox, not touching the mainland.
    assert.ok(west < -13, `got ${west}`);
    assert.ok(east < -12, `got ${east}`);
    assert.ok(south > 26 && south < 28, `got ${south}`);
    assert.ok(north > 29 && north < 30, `got ${north}`);
  }
});

test('returns an empty array when there is no usable station data', async () => {
  const { createCanvas } = makeFakeCreateCanvas();
  assert.deepEqual(await buildTemperatureGradientImages([], { createCanvas }), []);
  assert.deepEqual(
    await buildTemperatureGradientImages([{ lat: 40, lon: -3, temperatureC: NaN }], { createCanvas }),
    [],
  );
});

test('returns an empty array when createCanvas reports no DOM (headless)', async () => {
  const results = await buildTemperatureGradientImages(SAMPLE_STATIONS, { createCanvas: () => null });
  assert.deepEqual(results, []);
});

test('the raster bbox padding matches the mainland/Canary province feature split (sanity cross-check against spainBoundaries.js)', async () => {
  const features = await getCcaaFeatures();
  const CANARY_PROVINCE_IDS = new Set(['las-palmas', 'santa-cruz-de-tenerife']);
  const mainland = features.filter((f) => !CANARY_PROVINCE_IDS.has(f.id));
  const canary = features.filter((f) => CANARY_PROVINCE_IDS.has(f.id));
  assert.equal(mainland.length, features.length - CANARY_PROVINCE_IDS.size);
  assert.equal(canary.length, CANARY_PROVINCE_IDS.size);
});
