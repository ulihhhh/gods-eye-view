import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { terrainHeightsProxy } from 'gods-eye-view/server/providers/terrain';
import { tomtomProxy } from 'gods-eye-view/server/providers/traffic';
import { firmsProxy } from 'gods-eye-view/server/providers/firms';
import { gbfsProxy } from 'gods-eye-view/server/providers/gbfs';
import { aemetStationsProxy } from '../../server/providers/weather.js';
import { localProviderPlugins } from '../../server/providers/local.js';

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  assert.equal(routes.size, 1);
  return async (url = '/', method = 'GET') => {
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      end(body) {
        this.body = body;
      },
    };
    await [...routes.values()][0]({ url, method }, res);
    return res;
  };
}
function isolate(t, env = {}) {
  for (const [name, value] of Object.entries(env)) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    process.env[name] = value;
  }
  t.mock.method(fsp, 'readFile', async () => {
    throw Error('no disk cache');
  });
  t.mock.method(fsp, 'stat', async () => {
    throw Error('no disk cache');
  });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'writeFile', async () => {});
  t.mock.method(globalThis, 'setInterval', () => ({ unref() {} }));
  t.mock.method(console, 'warn', () => {});
}
const json = (res) => JSON.parse(res.body);

test('standalone composition mounts every extracted provider exactly once without acquisition', (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('construction must not fetch');
  });
  const plugins = localProviderPlugins();
  for (const factory of [
    terrainHeightsProxy,
    tomtomProxy,
    firmsProxy,
    gbfsProxy,
    aemetStationsProxy,
  ])
    assert.equal(plugins.filter((p) => p.name === factory().name).length, 1);
});

test('terrain middleware chunks missing points and reconstructs repeated/reordered requests from cache', async (t) => {
  isolate(t);
  let calls = 0;
  const sizes = [];
  t.mock.method(globalThis, 'fetch', async (raw) => {
    calls++;
    const url = new URL(raw);
    assert.equal(url.origin, 'https://terrain.reearth.land');
    const points = url.searchParams
      .get('points')
      .split(';')
      .map((p) => p.split(',').map(Number));
    sizes.push(points.length);
    return Response.json({
      results: points.map(([lon]) => ({ ellipsoid: lon + 100 })),
    });
  });
  const request = install(terrainHeightsProxy());
  const points = Array.from({ length: 257 }, (_, i) => `${i / 100},1`);
  const res = await request('/?points=' + points.join(';'));
  assert.equal(res.status, 200);
  assert.deepEqual(sizes, [256, 1]);
  const reordered = await request('/?points=2.56,1;0,1;2.56,1');
  assert.deepEqual(json(reordered), {
    results: [{ ellipsoid: 102.56 }, { ellipsoid: 100 }, { ellipsoid: 102.56 }],
  });
  assert.equal(calls, 2);
  assert.equal((await request('/?points=invalid')).status, 400);
  assert.equal(
    (await request('/?points=' + Array(2001).fill('0,1').join(';'))).status,
    500,
  );
  assert.equal(calls, 2);
});

test('terrain middleware migrates valid legacy disk points without fabricating omitted heights', async (t) => {
  isolate(t);
  t.mock.method(fsp, 'readFile', async () =>
    JSON.stringify({
      '1,2;3,4': { at: Date.now(), results: [{ ellipsoid: 77 }] },
    }),
  );
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (raw) => {
    calls++;
    assert.equal(new URL(raw).searchParams.get('points'), '3.00000,4.00000');
    return Response.json({ results: [{ ellipsoid: 88 }] });
  });
  const res = await install(terrainHeightsProxy())('/?points=3,4;1,2');
  assert.deepEqual(json(res), {
    results: [{ ellipsoid: 88 }, { ellipsoid: 77 }],
  });
  assert.equal(calls, 1);
});

test('traffic middleware preserves keyless mode, caching, stale budget fallback and UTC rollover', async (t) => {
  isolate(t, { TOMTOM_API_KEY: '', TOMTOM_DAILY_TILE_BUDGET: '1' });
  let now = Date.UTC(2026, 8, 12, 12);
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (raw) => {
    calls++;
    assert.equal(new URL(raw).searchParams.get('key'), 'fixture-key');
    return new Response(new Uint8Array([1, 2, 3]));
  });
  const request = install(tomtomProxy());
  assert.equal(json(await request('/status')).hasKey, false);
  assert.equal((await request('/flow/8/1/1.pbf')).status, 503);
  assert.equal((await request('/flow/7/1/1.pbf')).status, 400);
  assert.equal(calls, 0);
  process.env.TOMTOM_API_KEY = 'fixture-key';
  assert.equal(
    (await request('/flow/8/1/1.pbf')).headers['x-tomtom-cache'],
    'MISS',
  );
  assert.equal(
    (await request('/flow/8/1/1.pbf')).headers['x-tomtom-cache'],
    'HIT',
  );
  assert.equal(json(await request('/status')).dailyCount, 1);
  assert.equal(calls, 1);
  now += 120001;
  assert.equal(
    (await request('/flow/8/1/1.pbf')).headers['x-tomtom-cache'],
    'STALE-BUDGET',
  );
  assert.equal((await request('/flow/8/2/1.pbf')).status, 429);
  assert.equal(calls, 1);
  now += 86400000;
  assert.equal(json(await request('/status')).dailyCount, 0);
  assert.equal(
    (await request('/flow/8/1/1.pbf')).headers['x-tomtom-cache'],
    'MISS',
  );
  assert.equal(calls, 2);
});

test('FIRMS retains a large successful source during partial failure and filters stale data at serve time', async (t) => {
  isolate(t, { FIRMS_MAP_KEY: '' });
  let now = Date.UTC(2026, 8, 12, 12);
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const header = 'latitude,longitude,acq_date,acq_time,confidence,frp\n';
  const csv = header + '30,-97,2026-09-12,1200,h,10\n'.repeat(130001);
  t.mock.method(globalThis, 'fetch', async (raw) => {
    calls++;
    const url = new URL(raw);
    assert.equal(url.hostname, 'firms.modaps.eosdis.nasa.gov');
    if (url.pathname.includes('mapkey_status'))
      return Response.json({
        current_transactions: 3,
        transaction_limit: 5000,
      });
    return url.pathname.includes('VIIRS_NOAA20')
      ? new Response(csv)
      : new Response('offline', { status: 503 });
  });
  const request = install(firmsProxy());
  assert.equal((await request()).status, 503);
  assert.equal(json(await request('/status')).hasKey, false);
  assert.equal(calls, 0);
  process.env.FIRMS_MAP_KEY = 'fixture-key';
  const first = json(await request());
  assert.equal(first.count, 130001);
  assert.equal(first.sources.filter((s) => s.ok).length, 1);
  assert.equal(calls, 3);
  assert.equal(json(await request()).count, 130001);
  assert.equal(calls, 3);
  assert.deepEqual(json(await request('/status')).transactions, {
    used: 3,
    limit: 5000,
  });
  now += 25 * 3600000;
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('offline', { status: 503 }),
  );
  const stale = json(await request());
  assert.equal(stale.stale, true);
  assert.equal(stale.count, 0);
});

test('AEMET decodes ISO-8859-15 station names, dedups trailing hourly rows, and caches across the TTL', async (t) => {
  isolate(t, { AEMET_API_KEY: '' });
  let now = Date.UTC(2026, 8, 12, 12);
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  // The real API serves this second response as ISO-8859-15/latin1 — encode
  // the fixture the same way so decoding it wrong (e.g. as UTF-8) would
  // actually mangle "VANDELLÓS" and fail the assertion below, not pass by
  // accident on ASCII-only fixture data.
  const rows = [
    { idema: '0002I', lat: 40.95806, lon: 0.871385, alt: 32, ubi: 'VANDELLÓS', fint: '2026-09-12T11:00:00+0000', ta: 20 },
    { idema: '0002I', lat: 40.95806, lon: 0.871385, alt: 32, ubi: 'VANDELLÓS', fint: '2026-09-12T12:00:00+0000', ta: 24 },
  ];
  const datosBuffer = Buffer.from(JSON.stringify(rows), 'latin1');
  t.mock.method(globalThis, 'fetch', async (raw) => {
    calls++;
    const url = new URL(raw);
    assert.equal(url.hostname, 'opendata.aemet.es');
    if (url.pathname.endsWith('/datos-fixture')) {
      return new Response(datosBuffer, { headers: { 'content-type': 'text/plain;charset=ISO-8859-15' } });
    }
    assert.equal(url.searchParams.get('api_key'), 'fixture-key');
    return Response.json({
      descripcion: 'exito',
      estado: 200,
      datos: 'https://opendata.aemet.es/datos-fixture',
    });
  });
  const request = install(aemetStationsProxy());
  assert.equal((await request()).status, 503);
  assert.equal(json(await request('/status')).hasKey, false);
  assert.equal(calls, 0);
  process.env.AEMET_API_KEY = 'fixture-key';

  const first = json(await request());
  assert.equal(first.count, 1, 'two trailing hourly rows for the same station dedup to one');
  assert.equal(first.stations[0].name, 'VANDELLÓS', 'ISO-8859-15 decodes correctly, not as mangled UTF-8');
  assert.equal(first.stations[0].temperatureC, 24, 'the later fint wins the dedup');
  assert.equal(calls, 2, 'one envelope fetch + one datos fetch');

  assert.equal(json(await request()).count, 1);
  assert.equal(calls, 2, 'within TTL: served from cache, no new upstream calls');

  now += 21 * 60_000; // past the 20-minute TTL
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('upstream down');
  });
  const stale = json(await request());
  assert.equal(stale.stale, true);
  assert.equal(stale.count, 1, 'stale cache beats an empty layer');
});

test('GBFS keeps host/path/method guards, response caps and distinct information/status cache headers', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (raw) => {
    calls++;
    assert.equal(new URL(raw).hostname, 'gbfs.lyft.com');
    return Response.json({ data: { stations: [] } });
  });
  const request = install(gbfsProxy());
  const target = (p) => '/' + encodeURIComponent('https://gbfs.lyft.com/' + p);
  assert.equal(
    (await request(target('station_status.json'), 'POST')).status,
    405,
  );
  assert.equal(
    (
      await request(
        '/' + encodeURIComponent('https://example.com/station_status.json'),
      )
    ).status,
    403,
  );
  assert.equal((await request(target('gbfs.json'))).status, 400);
  assert.equal((await request('/%zz')).status, 400);
  assert.equal(calls, 0);
  assert.equal(
    (await request(target('station_information.json'))).headers[
      'Cache-Control'
    ],
    'public, max-age=300',
  );
  assert.equal(
    (await request(target('station_status.json'))).headers['Cache-Control'],
    'no-store',
  );
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response('x', {
        headers: { 'content-length': String(6 * 1024 * 1024) },
      }),
  );
  assert.equal((await request(target('station_status.json'))).status, 502);
});
