import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { terrainHeightsProxy } from 'gods-eye-view/server/providers/terrain';
import { tomtomProxy } from 'gods-eye-view/server/providers/traffic';
import { firmsProxy } from 'gods-eye-view/server/providers/firms';
import { gbfsProxy } from 'gods-eye-view/server/providers/gbfs';
import {
  aemetBeachesProxy,
  aemetEnvironmentalProxy,
  aemetFireRiskProxy,
  aemetForecastProxy,
  aemetLightningProxy,
  aemetSeaSurfaceTempProxy,
  aemetStationsProxy,
  aemetUvIndexProxy,
  aemetWarningsProxy,
} from '../../server/providers/weather.js';
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
    aemetWarningsProxy,
    aemetForecastProxy,
    aemetLightningProxy,
    aemetFireRiskProxy,
    aemetUvIndexProxy,
    aemetSeaSurfaceTempProxy,
    aemetBeachesProxy,
    aemetEnvironmentalProxy,
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

/** Build a minimal (uncompressed) POSIX tar buffer from {name, content} entries. */
function buildTestTar(files) {
  const BLOCK = 512;
  const chunks = [];
  for (const { name, content } of files) {
    const header = Buffer.alloc(BLOCK);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'utf8');
    header.write('0000000\0', 108, 8, 'utf8');
    header.write('0000000\0', 116, 8, 'utf8');
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
    header.write('00000000000\0', 136, 12, 'utf8');
    header.write('        ', 148, 8, 'utf8');
    header[156] = '0'.charCodeAt(0);
    header.write('ustar\0', 257, 6, 'utf8');
    header.write('00', 263, 2, 'utf8');
    chunks.push(header);
    const body = Buffer.from(content, 'utf8');
    chunks.push(body);
    const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}

function capAlertFixture({ geocode, name, level, event, phenomenon, onset, expires }) {
  return `<alert><info>
    <language>es-ES</language>
    <event>${event}</event>
    <eventCode><valueName>AEMET-Meteoalerta fenomeno</valueName><value>${phenomenon}</value></eventCode>
    <onset>${onset}</onset>
    <expires>${expires}</expires>
    <description>Descripción de prueba con eñe y acentos: Almería.</description>
    <parameter><valueName>AEMET-Meteoalerta nivel</valueName><value>${level}</value></parameter>
    <area>
      <areaDesc>${name}</areaDesc>
      <polygon>1,1 2,2 3,3 1,1</polygon>
      <geocode><valueName>AEMET-Meteoalerta zona</valueName><value>${geocode}</value></geocode>
    </area>
  </info></alert>`;
}

test('AEMET warnings decodes UTF-8 CAP XML from a tar archive, suppresses verde, and caches across the TTL', async (t) => {
  isolate(t, { AEMET_API_KEY: '' });
  let now = Date.UTC(2026, 8, 12, 12);
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  // Real AEMET CAP text is UTF-8 (the reverse of the stations feed) —
  // encoding this fixture as UTF-8 and asserting the accented text round-
  // trips catches a latin1 regression the same way the stations test above
  // catches the opposite one.
  const tar = buildTestTar([
    {
      name: 'verde.xml',
      content: capAlertFixture({
        geocode: '000000', name: 'Everywhere', level: 'verde', event: 'Aviso verde',
        phenomenon: 'AT;Temperaturas máximas', onset: '2026-09-12T00:00:00+00:00', expires: '2099-01-01T00:00:00+00:00',
      }),
    },
    {
      name: 'amarillo.xml',
      content: capAlertFixture({
        geocode: '659101', name: 'Almería', level: 'amarillo', event: 'Aviso de vientos de nivel amarillo',
        phenomenon: 'VI;Vientos', onset: '2026-09-12T00:00:00+00:00', expires: '2099-01-01T00:00:00+00:00',
      }),
    },
    {
      name: 'expired.xml',
      content: capAlertFixture({
        geocode: '999999', name: 'Ya pasado', level: 'rojo', event: 'Aviso ya expirado',
        phenomenon: 'PR;Lluvias', onset: '2020-01-01T00:00:00+00:00', expires: '2020-01-02T00:00:00+00:00',
      }),
    },
  ]);
  t.mock.method(globalThis, 'fetch', async (raw) => {
    calls++;
    const url = new URL(raw);
    assert.equal(url.hostname, 'opendata.aemet.es');
    if (url.pathname.endsWith('/warnings-datos-fixture')) {
      return new Response(tar, { headers: { 'content-type': 'application/x-gtar;charset=ISO-8859-15' } });
    }
    assert.equal(url.searchParams.get('api_key'), 'fixture-key');
    return Response.json({
      descripcion: 'exito',
      estado: 200,
      datos: 'https://opendata.aemet.es/warnings-datos-fixture',
    });
  });
  const request = install(aemetWarningsProxy());
  assert.equal((await request()).status, 503);
  assert.equal(json(await request('/status')).hasKey, false);
  assert.equal(calls, 0);
  process.env.AEMET_API_KEY = 'fixture-key';

  const first = json(await request());
  assert.equal(first.count, 1, 'verde and the expired rojo are both suppressed — only the live amarillo zone remains');
  assert.equal(first.zones[0].geocode, '659101');
  assert.equal(first.zones[0].name, 'Almería', 'UTF-8 decodes correctly, not as mangled latin1');
  assert.equal(first.zones[0].level, 'amarillo');
  assert.match(first.zones[0].phenomena[0].description, /Almería/, 'accented description text round-trips');
  assert.equal(calls, 2, 'one envelope fetch + one datos (tar) fetch');

  assert.equal(json(await request()).count, 1);
  assert.equal(calls, 2, 'within TTL: served from cache, no new upstream calls');

  now += 13 * 60_000; // past the 12-minute TTL
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('upstream down');
  });
  const stale = json(await request());
  assert.equal(stale.stale, true);
  assert.equal(stale.count, 1, 'stale cache beats an empty layer');
});

test('AEMET forecast resolves lat/lon to the nearest municipio, filters to upcoming Madrid-time hours, and caches both layers independently', async (t) => {
  isolate(t, { AEMET_API_KEY: '' });
  // 2026-09-12T12:00:00Z is CEST (+2) → 14:00 in Madrid. Fixture hours are
  // chosen straddling that boundary so the Madrid-civil-time filter (not the
  // test process's own timezone) is what's actually being exercised.
  let now = Date.UTC(2026, 8, 12, 12);
  t.mock.method(Date, 'now', () => now);
  let calls = 0;

  const madridMunicipioRaw = {
    id: 'id28079', id_old: '28001', nombre: 'Madrid', capital: 'Madrid',
    latitud_dec: '40.4168', longitud_dec: '-3.7038', altitud: '667', num_hab: '3223334',
  };
  const municipiosBuffer = Buffer.from(JSON.stringify([madridMunicipioRaw]), 'latin1');
  const hourlyForecastRaw = [{
    id: '28079', nombre: 'Madrid', provincia: 'Madrid', elaborado: '2026-09-12T13:00:00',
    prediccion: {
      dia: [{
        fecha: '2026-09-12T00:00:00',
        // "13" is already past 14:00 Madrid time — must be filtered out.
        temperatura: [{ value: '24', periodo: '13' }, { value: '25', periodo: '14' }, { value: '26', periodo: '15' }],
        estadoCielo: [{ value: '11', periodo: '14', descripcion: 'Despejado' }, { value: '11', periodo: '15', descripcion: 'Despejado' }],
        precipitacion: [{ value: '0', periodo: '14' }, { value: '0', periodo: '15' }],
        vientoAndRachaMax: [
          { direccion: ['NE'], velocidad: ['10'], periodo: '14' },
          { direccion: ['NE'], velocidad: ['12'], periodo: '15' },
        ],
      }],
    },
  }];
  const forecastBuffer = Buffer.from(JSON.stringify(hourlyForecastRaw), 'latin1');

  t.mock.method(globalThis, 'fetch', async (raw) => {
    calls++;
    const url = new URL(raw);
    assert.equal(url.hostname, 'opendata.aemet.es');
    if (url.pathname.endsWith('/municipios-datos-fixture')) {
      return new Response(municipiosBuffer, { headers: { 'content-type': 'text/plain;charset=ISO-8859-15' } });
    }
    if (url.pathname.endsWith('/forecast-datos-fixture')) {
      return new Response(forecastBuffer, { headers: { 'content-type': 'text/plain;charset=ISO-8859-15' } });
    }
    assert.equal(url.searchParams.get('api_key'), 'fixture-key');
    if (url.pathname.includes('/maestro/municipios')) {
      return Response.json({ descripcion: 'exito', estado: 200, datos: 'https://opendata.aemet.es/municipios-datos-fixture' });
    }
    assert.ok(url.pathname.endsWith('/municipio/horaria/28079'), `unexpected forecast municipio in ${url.pathname}`);
    return Response.json({ descripcion: 'exito', estado: 200, datos: 'https://opendata.aemet.es/forecast-datos-fixture' });
  });

  const request = install(aemetForecastProxy());
  assert.equal((await request('/?lat=40.42&lon=-3.70')).status, 503, 'keyless');
  assert.equal(json(await request('/status')).hasKey, false);
  assert.equal(calls, 0);
  process.env.AEMET_API_KEY = 'fixture-key';

  assert.equal((await request('/?lat=999&lon=-3.70')).status, 400, 'out-of-range lat');
  assert.equal((await request('/?lat=abc&lon=-3.70')).status, 400, 'non-numeric lat');
  assert.equal(calls, 0, 'bad requests never reach upstream');

  const first = json(await request('/?lat=40.42&lon=-3.70'));
  assert.equal(first.municipio.id, '28079');
  assert.equal(first.municipio.name, 'Madrid');
  assert.equal(calls, 4, 'municipios envelope + datos, forecast envelope + datos');
  assert.deepEqual(first.hours.map((h) => h.hour), [14, 15], 'hour 13 is already past 14:00 Madrid time');
  assert.equal(first.hours[0].temperatureC, 25);
  assert.equal(first.hours[0].windDirection, 'NE');
  assert.equal(first.stale, false);

  const second = json(await request('/?lat=40.42&lon=-3.70'));
  assert.equal(second.municipio.id, '28079');
  assert.equal(calls, 4, 'within both TTLs: municipio table and forecast both served from cache');

  const status = json(await request('/status'));
  assert.equal(status.hasKey, true);
  assert.equal(status.municipiosLoaded, 1);
  assert.equal(status.cachedForecastCount, 1);

  now += 46 * 60_000; // past the forecast's 45-minute TTL, well within the municipio table's 24h TTL
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('upstream down');
  });
  const stale = json(await request('/?lat=40.42&lon=-3.70'));
  assert.equal(stale.stale, true);
  assert.equal(stale.municipio.id, '28079', 'the municipio lookup itself needed no re-fetch — stale forecast beats no forecast');
  assert.deepEqual(stale.hours.map((h) => h.hour), [14, 15]);
});

test('AEMET lightning passes the binary GIF through unmodified, TTLs at 6h, and caches memory-only', async (t) => {
  isolate(t, { AEMET_API_KEY: '' });
  let now = Date.UTC(2026, 8, 12, 12);
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  // A real GIF87a header (magic bytes) — enough to prove the proxy never
  // touches or reinterprets the bytes, just forwards them.
  const gifFixture = Buffer.from('47494638376180028001', 'hex');
  t.mock.method(globalThis, 'fetch', async (raw) => {
    calls++;
    const url = new URL(raw);
    assert.equal(url.hostname, 'opendata.aemet.es');
    if (url.pathname.endsWith('/lightning-datos-fixture')) {
      return new Response(gifFixture, { headers: { 'content-type': 'image/gif;charset=ISO-8859-15' } });
    }
    assert.equal(url.searchParams.get('api_key'), 'fixture-key');
    return Response.json({
      descripcion: 'exito',
      estado: 200,
      datos: 'https://opendata.aemet.es/lightning-datos-fixture',
    });
  });
  const request = install(aemetLightningProxy());
  assert.equal((await request()).status, 503, 'keyless');
  assert.equal(json(await request('/status')).hasKey, false);
  assert.equal(calls, 0);
  process.env.AEMET_API_KEY = 'fixture-key';

  const first = await request();
  assert.equal(first.status, 200);
  assert.equal(first.headers['Content-Type'], 'image/gif', 'charset param stripped, bytes untouched');
  assert.ok(Buffer.from(first.body).equals(gifFixture), 'the GIF bytes pass through byte-for-byte');
  assert.equal(calls, 2, 'one envelope fetch + one datos fetch');

  const second = await request();
  assert.equal(calls, 2, 'within the 6h TTL: served from memory cache, no new upstream calls');
  assert.ok(Buffer.from(second.body).equals(gifFixture));

  const status = json(await request('/status'));
  assert.equal(status.hasKey, true);
  assert.equal(status.contentType, 'image/gif');
  assert.equal(status.stale, false);

  now += 6 * 3600_000 + 60_000; // past the 6-hour TTL
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('upstream down');
  });
  const stale = await request();
  assert.equal(stale.status, 200, 'stale cache beats an error');
  assert.ok(Buffer.from(stale.body).equals(gifFixture));
  assert.equal(json(await request('/status')).stale, true);
});

test('AEMET sea-surface-temperature passes the binary GIF through unmodified, TTLs at 6h, and caches memory-only', async (t) => {
  isolate(t, { AEMET_API_KEY: '' });
  let now = Date.UTC(2026, 8, 12, 12);
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  // A real GIF87a header (magic bytes) — enough to prove the proxy never
  // touches or reinterprets the bytes, just forwards them.
  const gifFixture = Buffer.from('47494638376180028001', 'hex');
  t.mock.method(globalThis, 'fetch', async (raw) => {
    calls++;
    const url = new URL(raw);
    assert.equal(url.hostname, 'opendata.aemet.es');
    if (url.pathname.endsWith('/sea-surface-temp-datos-fixture')) {
      return new Response(gifFixture, { headers: { 'content-type': 'image/gif;charset=ISO-8859-15' } });
    }
    assert.equal(url.searchParams.get('api_key'), 'fixture-key');
    return Response.json({
      descripcion: 'exito',
      estado: 200,
      datos: 'https://opendata.aemet.es/sea-surface-temp-datos-fixture',
    });
  });
  const request = install(aemetSeaSurfaceTempProxy());
  assert.equal((await request()).status, 503, 'keyless');
  assert.equal(json(await request('/status')).hasKey, false);
  assert.equal(calls, 0);
  process.env.AEMET_API_KEY = 'fixture-key';

  const first = await request();
  assert.equal(first.status, 200);
  assert.equal(first.headers['Content-Type'], 'image/gif', 'charset param stripped, bytes untouched');
  assert.ok(Buffer.from(first.body).equals(gifFixture), 'the GIF bytes pass through byte-for-byte');
  assert.equal(calls, 2, 'one envelope fetch + one datos fetch');

  const second = await request();
  assert.equal(calls, 2, 'within the 6h TTL: served from memory cache, no new upstream calls');
  assert.ok(Buffer.from(second.body).equals(gifFixture));

  const status = json(await request('/status'));
  assert.equal(status.hasKey, true);
  assert.equal(status.contentType, 'image/gif');
  assert.equal(status.stale, false);

  now += 6 * 3600_000 + 60_000; // past the 6-hour TTL
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('upstream down');
  });
  const stale = await request();
  assert.equal(stale.status, 200, 'stale cache beats an error');
  assert.ok(Buffer.from(stale.body).equals(gifFixture));
  assert.equal(json(await request('/status')).stale, true);
});

test('AEMET fire-risk falls back from estimado to previsto day 1 when "today" has no published map, and caches memory-only at 3h', async (t) => {
  isolate(t, { AEMET_API_KEY: '' });
  let now = Date.UTC(2026, 8, 12, 12);
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  // A real PNG header — enough to prove the proxy never touches or
  // reinterprets the bytes, just forwards them.
  const pngFixture = Buffer.from('89504e470d0a1a0a', 'hex');
  let estimadoAvailable = false;
  t.mock.method(globalThis, 'fetch', async (raw) => {
    calls++;
    const url = new URL(raw);
    assert.equal(url.hostname, 'opendata.aemet.es');
    if (url.pathname.endsWith('/fire-risk-datos-fixture')) {
      return new Response(pngFixture, { headers: { 'content-type': 'image/png' } });
    }
    assert.equal(url.searchParams.get('api_key'), 'fixture-key');
    if (url.pathname.includes('/mapasriesgo/estimado/area/p')) {
      // Confirmed live: "today" can genuinely have no published product yet.
      if (!estimadoAvailable) return Response.json({ estado: 404, descripcion: 'No hay datos que satisfagan esos criterios' });
      return Response.json({ descripcion: 'exito', estado: 200, datos: 'https://opendata.aemet.es/fire-risk-datos-fixture' });
    }
    assert.ok(url.pathname.includes('/mapasriesgo/previsto/dia/1/area/p'), `unexpected path ${url.pathname}`);
    return Response.json({ descripcion: 'exito', estado: 200, datos: 'https://opendata.aemet.es/fire-risk-datos-fixture' });
  });
  const request = install(aemetFireRiskProxy());
  assert.equal((await request()).status, 503, 'keyless');
  assert.equal(json(await request('/status')).hasKey, false);
  assert.equal(calls, 0);
  process.env.AEMET_API_KEY = 'fixture-key';

  const first = await request();
  assert.equal(first.status, 200);
  assert.equal(first.headers['Content-Type'], 'image/png');
  assert.ok(Buffer.from(first.body).equals(pngFixture));
  assert.equal(calls, 3, 'estimado envelope (404) + previsto envelope + previsto datos');
  assert.equal(json(await request('/status')).source, 'previsto-1');

  const callsAfterFirst = calls;
  await request();
  assert.equal(calls, callsAfterFirst, 'within the 3h TTL: served from memory cache, no new upstream calls');

  now += 3 * 3600_000 + 60_000; // past the 3-hour TTL
  estimadoAvailable = true; // AEMET has since published today's map
  const refreshed = await request();
  assert.equal(refreshed.status, 200);
  assert.equal(json(await request('/status')).source, 'estimado', 'picks up estimado again once it exists, not stuck on the fallback');

  now += 3 * 3600_000 + 60_000;
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('upstream down');
  });
  const stale = await request();
  assert.equal(stale.status, 200, 'stale cache beats an error');
  assert.equal(json(await request('/status')).stale, true);
});

test('AEMET UV-index joins each city to its municipio coordinates, drops unmatched cities, and caches memory-only at 3h', async (t) => {
  isolate(t, { AEMET_API_KEY: '' });
  let now = Date.UTC(2026, 8, 12, 12);
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const municipiosRaw = [
    { id: 'id28079', nombre: 'Madrid', capital: 'Madrid', latitud_dec: '40.4168', longitud_dec: '-3.7038', altitud: '667', num_hab: '3223334' },
  ];
  const uviRaw = {
    FECHA_ELABORACION: '2026-09-12T03:52:02',
    FECHA_VALIDEZ: '2026-09-12T12:00:00',
    CIUDAD: [
      { id: '28079', valor: 'Madrid', uv: '8', canarias: '0' },
      // No matching municipio for this one — must be dropped, not fabricated a position.
      { id: '99999', valor: 'Nowhere', uv: '3', canarias: '0' },
    ],
  };
  t.mock.method(globalThis, 'fetch', async (raw) => {
    calls++;
    const url = new URL(raw);
    assert.equal(url.hostname, 'opendata.aemet.es');
    if (url.pathname.endsWith('/municipios-datos-fixture')) {
      return new Response(Buffer.from(JSON.stringify(municipiosRaw), 'latin1'), { headers: { 'content-type': 'text/plain;charset=ISO-8859-15' } });
    }
    if (url.pathname.endsWith('/uvi-datos-fixture')) {
      return new Response(Buffer.from(JSON.stringify(uviRaw), 'latin1'), { headers: { 'content-type': 'text/plain;charset=ISO-8859-15' } });
    }
    assert.equal(url.searchParams.get('api_key'), 'fixture-key');
    if (url.pathname.includes('/maestro/municipios')) {
      return Response.json({ descripcion: 'exito', estado: 200, datos: 'https://opendata.aemet.es/municipios-datos-fixture' });
    }
    assert.ok(url.pathname.endsWith('/uvi/0'), `unexpected path ${url.pathname}`);
    return Response.json({ descripcion: 'exito', estado: 200, datos: 'https://opendata.aemet.es/uvi-datos-fixture' });
  });
  const request = install(aemetUvIndexProxy());
  assert.equal((await request()).status, 503, 'keyless');
  assert.equal(json(await request('/status')).hasKey, false);
  assert.equal(calls, 0);
  process.env.AEMET_API_KEY = 'fixture-key';

  const first = json(await request());
  assert.equal(first.count, 1, 'the unmatched city is dropped, not fabricated a position');
  assert.equal(first.cities[0].municipioId, '28079');
  assert.equal(first.cities[0].uvIndex, 8);
  assert.equal(first.cities[0].lat, 40.4168);
  assert.equal(first.cities[0].lon, -3.7038);
  assert.equal(first.elaborated, '2026-09-12T03:52:02');
  assert.equal(calls, 4, 'municipios envelope + datos, uvi envelope + datos');

  assert.equal(json(await request()).count, 1);
  assert.equal(calls, 4, 'within the 3h TTL: served from memory cache, no new upstream calls');

  now += 3 * 3600_000 + 60_000; // past the 3-hour TTL
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('upstream down');
  });
  const stale = json(await request());
  assert.equal(stale.stale, true);
  assert.equal(stale.count, 1, 'stale cache beats an empty layer');
});

const BEACH_NOMENCLATOR_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-6.9944, 36.9589] }, properties: { NOMBRE: 'La Barrosa', ID: '1101503' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-4.4078, 36.7192] }, properties: { NOMBRE: 'La Malagueta', ID: '2906707' } },
  ],
};

function beachForecastFixture(nombre, localidad, waterTempC = 22) {
  return Buffer.from(JSON.stringify([{
    nombre, localidad,
    prediccion: { dia: [{ estadoCielo: { descripcion1: 'despejado' }, tAgua: { valor1: waterTempC }, fecha: 20260913 }] },
  }]), 'latin1');
}

test('AEMET beaches proxy never blocks a request on its own sweep, and fills in as the paced background sweep completes, cached at 6h', async (t) => {
  isolate(t, { AEMET_API_KEY: '' });
  let now = Date.UTC(2026, 8, 13, 12);
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (raw) => {
    calls++;
    const url = new URL(raw);
    if (url.hostname === 'www.aemet.es') {
      assert.equal(url.pathname, '/es/api-eltiempo/municipios/9/playas');
      return Response.json(BEACH_NOMENCLATOR_FIXTURE);
    }
    assert.equal(url.hostname, 'opendata.aemet.es');
    if (url.pathname.endsWith('/playa-1101503-datos-fixture')) {
      return new Response(beachForecastFixture('La Barrosa', 11015), { headers: { 'content-type': 'text/plain;charset=ISO-8859-15' } });
    }
    if (url.pathname.endsWith('/playa-2906707-datos-fixture')) {
      return new Response(beachForecastFixture('La Malagueta', 29067), { headers: { 'content-type': 'text/plain;charset=ISO-8859-15' } });
    }
    assert.equal(url.searchParams.get('api_key'), 'fixture-key');
    if (url.pathname.endsWith('/prediccion/especifica/playa/1101503')) {
      return Response.json({ descripcion: 'exito', estado: 200, datos: 'https://opendata.aemet.es/playa-1101503-datos-fixture' });
    }
    assert.ok(url.pathname.endsWith('/prediccion/especifica/playa/2906707'), `unexpected path ${url.pathname}`);
    return Response.json({ descripcion: 'exito', estado: 200, datos: 'https://opendata.aemet.es/playa-2906707-datos-fixture' });
  });
  // paceMs/throttleCooldownMs: 0 — this test drives the real sweep to
  // completion via `_sweepPromiseForTest()` rather than fighting fake timers
  // against a fire-and-forget background loop; production always uses the
  // real conservative pacing (see the factory's own defaults).
  const plugin = aemetBeachesProxy({ paceMs: 0, throttleCooldownMs: 0 });
  const request = install(plugin);
  assert.equal((await request()).status, 503, 'keyless');
  assert.equal(json(await request('/status')).hasKey, false);
  assert.equal(calls, 0, 'keyless never even fetches the (keyless) nomenclator');
  process.env.AEMET_API_KEY = 'fixture-key';

  const cold = json(await request());
  assert.equal(cold.count, 0, 'a cold start responds immediately — never blocks on the sweep it just kicked off');
  assert.equal(cold.stale, true);

  await plugin._sweepPromiseForTest();
  const warm = json(await request());
  assert.equal(warm.count, 2);
  const byId = Object.fromEntries(warm.beaches.map((b) => [b.id, b]));
  assert.equal(byId['1101503'].name, 'La Barrosa');
  assert.equal(byId['1101503'].forecast.waterTempC, 22);
  assert.equal(byId['1101503'].forecast.municipioId, '11015');
  assert.equal(byId['2906707'].name, 'La Malagueta');
  assert.equal(calls, 5, 'one nomenclator fetch + 2 beaches × (envelope + datos)');
  assert.equal(warm.stale, false);

  const callsAfterFirstSweep = calls;
  json(await request());
  assert.equal(calls, callsAfterFirstSweep, 'within the 6h TTL: served from memory cache, no new sweep started');

  const status = json(await request('/status'));
  assert.equal(status.hasKey, true);
  assert.equal(status.count, 2);
  assert.equal(status.stale, false);

  now += 6 * 3600_000 + 60_000; // past the 6-hour TTL
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('upstream down');
  });
  const staleResponse = json(await request());
  assert.equal(staleResponse.count, 2, 'a new sweep starting still serves the last-known readings immediately');
  await plugin._sweepPromiseForTest();
  const afterFailedSweep = json(await request('/status'));
  assert.equal(afterFailedSweep.stale, true, 'a wholesale-failed sweep must not report freshness it never earned');
  assert.equal(afterFailedSweep.count, 2, 'the failed sweep did not drop any previously-cached beach');
});

test('AEMET beaches proxy keeps a beach\'s last-known forecast when only that beach\'s refresh fails, instead of dropping it from the layer', async (t) => {
  isolate(t, { AEMET_API_KEY: 'fixture-key' });
  let now = Date.UTC(2026, 8, 13, 12);
  t.mock.method(Date, 'now', () => now);
  let brosaFails = false;
  t.mock.method(globalThis, 'fetch', async (raw) => {
    const url = new URL(raw);
    if (url.hostname === 'www.aemet.es') return Response.json(BEACH_NOMENCLATOR_FIXTURE);
    if (url.pathname.endsWith('/playa-1101503-datos-fixture')) {
      if (brosaFails) throw new Error('flaky upstream');
      return new Response(beachForecastFixture('La Barrosa', 11015, 21), { headers: { 'content-type': 'text/plain;charset=ISO-8859-15' } });
    }
    if (url.pathname.endsWith('/playa-2906707-datos-fixture')) {
      return new Response(beachForecastFixture('La Malagueta', 29067, 24), { headers: { 'content-type': 'text/plain;charset=ISO-8859-15' } });
    }
    if (url.pathname.endsWith('/prediccion/especifica/playa/1101503')) {
      return Response.json({ descripcion: 'exito', estado: 200, datos: 'https://opendata.aemet.es/playa-1101503-datos-fixture' });
    }
    return Response.json({ descripcion: 'exito', estado: 200, datos: 'https://opendata.aemet.es/playa-2906707-datos-fixture' });
  });
  const plugin = aemetBeachesProxy({ paceMs: 0, throttleCooldownMs: 0 });
  const request = install(plugin);

  json(await request());
  await plugin._sweepPromiseForTest();
  const first = json(await request());
  assert.equal(first.count, 2);
  assert.equal(Object.fromEntries(first.beaches.map((b) => [b.id, b]))['1101503'].forecast.waterTempC, 21);

  now += 6 * 3600_000 + 60_000; // past the 6-hour TTL
  brosaFails = true;
  json(await request()); // kicks off the next sweep
  await plugin._sweepPromiseForTest();
  const second = json(await request());
  assert.equal(second.count, 2, 'the flaky beach is kept from its last successful sweep, not dropped');
  const byId = Object.fromEntries(second.beaches.map((b) => [b.id, b]));
  assert.equal(byId['1101503'].forecast.waterTempC, 21, 'still the OLD reading — this sweep never overwrote it');
  assert.equal(byId['2906707'].forecast.waterTempC, 24, 'the healthy beach refreshed normally');
});

test('AEMET beaches proxy cools down on an explicit 429 without corrupting cached data, and revisits that beach on the next sweep', async (t) => {
  isolate(t, { AEMET_API_KEY: 'fixture-key' });
  let now = Date.UTC(2026, 8, 13, 12);
  t.mock.method(Date, 'now', () => now);
  let brosaCallCount = 0;
  t.mock.method(globalThis, 'fetch', async (raw) => {
    const url = new URL(raw);
    if (url.hostname === 'www.aemet.es') return Response.json(BEACH_NOMENCLATOR_FIXTURE);
    if (url.pathname.endsWith('/playa-1101503-datos-fixture')) {
      return new Response(beachForecastFixture('La Barrosa', 11015, 21), { headers: { 'content-type': 'text/plain;charset=ISO-8859-15' } });
    }
    if (url.pathname.endsWith('/playa-2906707-datos-fixture')) {
      return new Response(beachForecastFixture('La Malagueta', 29067, 24), { headers: { 'content-type': 'text/plain;charset=ISO-8859-15' } });
    }
    if (url.pathname.endsWith('/prediccion/especifica/playa/1101503')) {
      brosaCallCount++;
      if (brosaCallCount === 1) {
        return Response.json({}, { status: 429, headers: { 'remaining-request-endpoint': '0' } });
      }
      return Response.json({ descripcion: 'exito', estado: 200, datos: 'https://opendata.aemet.es/playa-1101503-datos-fixture' });
    }
    return Response.json({ descripcion: 'exito', estado: 200, datos: 'https://opendata.aemet.es/playa-2906707-datos-fixture' });
  });
  const plugin = aemetBeachesProxy({ paceMs: 0, throttleCooldownMs: 1 });
  const request = install(plugin);

  json(await request());
  await plugin._sweepPromiseForTest();
  const first = json(await request());
  assert.equal(first.count, 1, 'the rate-limited beach is skipped this sweep, not fabricated');
  assert.equal(first.beaches[0].id, '2906707');

  now += 6 * 3600_000 + 60_000; // past the 6-hour TTL — a fresh sweep retries the previously-limited beach
  json(await request());
  await plugin._sweepPromiseForTest();
  const second = json(await request());
  assert.equal(second.count, 2, 'the previously rate-limited beach succeeds on the next sweep');
});

test('AEMET environmental proxy joins ozone/radiation rows to station coordinates by indicativo, decodes UTF-8 (not latin1), and caches memory-only at 3h', async (t) => {
  isolate(t, { AEMET_API_KEY: '' });
  let now = Date.UTC(2026, 8, 13, 12);
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const stationsRaw = [
    { idema: '1387', ubi: 'A CORUÑA', lat: '43.365969', lon: '-8.421517', fint: '2026-09-13T12:00:00' },
    { idema: '8178D', ubi: 'ALBACETE', lat: '38.9479', lon: '-1.8560', fint: '2026-09-13T12:00:00' },
    // No station for this ozone indicativo — must be dropped, not fabricated a position.
  ];
  const ozoneCsv = '"CAPA DE OZONO"\r\n"12-09-26"\r\n"Estación";"Indicativo";"OZONO"\r\n"A Coruña";"1387";"285"\r\n"Nowhere";"99999X";"999"\r\n';
  const radiationCsv = '"RADIACION SOLAR"\r\n"12-09-26"\r\n"Estación";"Indicativo";"Tipo";"5";"SUMA"\r\n"Albacete";"8178D";"GL";"1";"2333"\r\n';
  t.mock.method(globalThis, 'fetch', async (raw) => {
    calls++;
    const url = new URL(raw);
    assert.equal(url.hostname, 'opendata.aemet.es');
    if (url.pathname.endsWith('/stations-datos-fixture')) {
      return new Response(Buffer.from(JSON.stringify(stationsRaw), 'latin1'), { headers: { 'content-type': 'text/plain;charset=ISO-8859-15' } });
    }
    if (url.pathname.endsWith('/ozono-datos-fixture')) {
      return new Response(Buffer.from(ozoneCsv, 'utf8'), { headers: { 'content-type': 'text/plain;charset=UTF-8' } });
    }
    if (url.pathname.endsWith('/radiacion-datos-fixture')) {
      return new Response(Buffer.from(radiationCsv, 'utf8'), { headers: { 'content-type': 'text/plain;charset=UTF-8' } });
    }
    assert.equal(url.searchParams.get('api_key'), 'fixture-key');
    if (url.pathname.includes('/observacion/convencional/todas')) {
      return Response.json({ descripcion: 'exito', estado: 200, datos: 'https://opendata.aemet.es/stations-datos-fixture' });
    }
    if (url.pathname.includes('/red/especial/ozono')) {
      return Response.json({ descripcion: 'exito', estado: 200, datos: 'https://opendata.aemet.es/ozono-datos-fixture' });
    }
    assert.ok(url.pathname.includes('/red/especial/radiacion'), `unexpected path ${url.pathname}`);
    return Response.json({ descripcion: 'exito', estado: 200, datos: 'https://opendata.aemet.es/radiacion-datos-fixture' });
  });
  const request = install(aemetEnvironmentalProxy());
  assert.equal((await request()).status, 503, 'keyless');
  assert.equal(json(await request('/status')).hasKey, false);
  assert.equal(calls, 0);
  process.env.AEMET_API_KEY = 'fixture-key';

  const first = json(await request());
  assert.equal(first.count, 2, 'the unmatched ozone row (99999X) is dropped, not fabricated a position');
  const byIndicativo = Object.fromEntries(first.stations.map((s) => [s.indicativo, s]));
  assert.equal(byIndicativo['1387'].name, 'A Coruña', 'the genuinely-UTF-8 name decodes correctly, not as latin1 mojibake');
  assert.equal(byIndicativo['1387'].lat, 43.365969);
  assert.equal(byIndicativo['1387'].ozoneDobson, 285);
  assert.equal(byIndicativo['1387'].globalRadiationSum, null, 'a station with only ozone data leaves radiation fields null');
  assert.equal(byIndicativo['8178D'].globalRadiationSum, 2333);
  assert.equal(byIndicativo['8178D'].ozoneDobson, null, 'a station with only radiation data leaves ozone null');
  assert.equal(calls, 6, 'stations envelope+datos, ozone envelope+datos, radiation envelope+datos');

  assert.equal(json(await request()).count, 2);
  assert.equal(calls, 6, 'within the 3h TTL: served from memory cache, no new upstream calls');

  now += 3 * 3600_000 + 60_000; // past the 3-hour TTL
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('upstream down');
  });
  const stale = json(await request());
  assert.equal(stale.stale, true);
  assert.equal(stale.count, 2, 'stale cache beats an empty layer');
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
