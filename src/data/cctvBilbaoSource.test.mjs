import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';
import { BILBAO_CAMERAS_URL } from '../../server/providers/cctv/constants.js';
import { loadBilbaoSourcesFromOpenData } from '../../server/providers/cctv/sources.js';

/** Set (or, for `undefined`, delete) environment variables for one test. */
function withEnv(t, env) {
  for (const [name, value] of Object.entries(env)) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/** Silence the loaders' progress and failure logging. */
function quiet(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
}

/** A Bilbao GeoJSON feature carrying the fields the loader reads. */
function bilbaoFeature(id, lat, lon, overrides = {}) {
  const props = {
    ID: String(id),
    Camid: String(id),
    Nombre: `Camera ${id}`,
    Tipo: 'Ayto',
    Rotacion_SPA: '0.0',
    URL: `https://www.bilbao.eus/camarastrafico/codec${id}/snap_c1.jpg`,
    ...overrides,
  };
  return {
    type: 'Feature',
    properties: props,
    geometry: { type: 'Point', coordinates: [lon, lat] },
  };
}

function bilbaoResponse(features) {
  return { type: 'FeatureCollection', features };
}

test('Bilbao loader keeps valid cameras, decodes entities and reads the compass heading', async (t) => {
  quiet(t);
  withEnv(t, { CCTV_BILBAO_MAX_SOURCES: undefined });
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json(
      bilbaoResponse([
        bilbaoFeature(4075, 43.2575, -2.9413, {
          Nombre: 'Autonom&#237;a/Gord&#243;niz',
          Rotacion_SPA: '20.695450695242787',
        }),
        bilbaoFeature(4061, 43.2577, -2.9184, { Rotacion_SPA: '-46.08' }),
        // The payload's own host is ignored if it points off the pinned origin.
        bilbaoFeature('bad-url', 43.26, -2.93, {
          URL: 'https://example.com/snap.jpg',
        }),
        // Out of the Bilbao bounding box.
        bilbaoFeature('far', 40.0, -3.7),
        bilbaoFeature('no-id', 43.26, -2.93, { ID: '' }),
      ]),
    );
  });

  const cameras = await loadBilbaoSourcesFromOpenData();

  assert.deepEqual(requested, [BILBAO_CAMERAS_URL]);
  assert.deepEqual(
    cameras.map((camera) => camera.id).sort(),
    ['bilbao-4061', 'bilbao-4075'],
  );
  const cam = cameras.find((camera) => camera.id === 'bilbao-4075');
  assert.equal(cam.name, 'Autonomía/Gordóniz', 'numeric entities are decoded');
  assert.equal(cam.city, 'Bilbao');
  assert.equal(cam.provider, 'Ayuntamiento de Bilbao');
  assert.equal(cam.feedType, 'image');
  assert.equal(
    cam.url,
    'https://www.bilbao.eus/camarastrafico/codec4075/snap_c1.jpg',
  );
  assert.equal(cam.snapshotUrl, cam.url);
  assert.equal(
    Math.round(cam.headingDeg * 1000) / 1000,
    20.695,
    'the feed heading is used as-is, no direction-word parsing needed',
  );
  assert.equal(cam.headingConfidence, 'high');
  assert.match(cam.license, /CC BY 4.0/);

  const negative = cameras.find((camera) => camera.id === 'bilbao-4061');
  assert.equal(
    negative.headingDeg,
    313.92,
    'a negative feed heading normalizes into [0, 360)',
  );
});

test('Bilbao loader falls back to a name when Nombre and Texto_SPA are both empty', async (t) => {
  quiet(t);
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      bilbaoResponse([
        bilbaoFeature(99, 43.26, -2.93, { Nombre: '', Texto_SPA: '' }),
      ]),
    ),
  );

  const cameras = await loadBilbaoSourcesFromOpenData();
  assert.equal(cameras[0].name, 'Bilbao Camera 99');
});

test('Bilbao loader fails soft on HTTP errors, unexpected payloads and network errors', async (t) => {
  quiet(t);
  let respond;
  t.mock.method(globalThis, 'fetch', (...args) => respond(...args));
  for (respond of [
    async () => new Response('unavailable', { status: 503 }),
    async () => Response.json({ features: 'nope' }),
    async () => {
      throw new TypeError('fetch failed');
    },
  ]) {
    assert.deepEqual(await loadBilbaoSourcesFromOpenData(), []);
  }
});

test('CCTV catalog merges Bilbao cameras and CCTV_BILBAO_ENABLED=0 skips the request', async (t) => {
  quiet(t);
  const sourceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gev-cctv-catalog-bilbao-'),
  );
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  withEnv(t, {
    CCTV_SOURCES_FILE: undefined,
    CCTV_SOURCES_JSON: undefined,
    CCTV_FORCE_AUSTIN: undefined,
    CCTV_PREFER_AUSTIN: undefined,
    CCTV_MAX_SOURCES: undefined,
    CCTV_CALTRANS_DISTRICTS: undefined,
    CCTV_TFL_ENABLED: undefined,
    CCTV_BILBAO_ENABLED: undefined,
    CCTV_BILBAO_MAX_SOURCES: undefined,
  });
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    // Every other live pack is down; only Bilbao answers.
    return String(url) === BILBAO_CAMERAS_URL
      ? Response.json(bilbaoResponse([bilbaoFeature(4075, 43.2575, -2.9413)]))
      : new Response('unavailable', { status: 503 });
  });

  const sources = await createCctvCatalog({ sourceRoot })();
  assert.deepEqual(
    sources.map((source) => source.id),
    ['bilbao-4075'],
  );

  process.env.CCTV_BILBAO_ENABLED = '0';
  requested.length = 0;
  assert.deepEqual(await createCctvCatalog({ sourceRoot })(), []);
  assert.ok(requested.length > 0, 'the other live packs still load');
  assert.equal(
    requested.includes(BILBAO_CAMERAS_URL),
    false,
    'a disabled pack makes no request',
  );
});
