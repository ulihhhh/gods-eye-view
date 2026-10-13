import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TMB_ARRIVALS_PER_MINUTE,
  TMB_ARRIVALS_TTL_MS,
  TMB_CATALOG_TTL_MS,
  TMB_STATUS_TTL_MS,
  classifyTmbStatus,
  createTmbArrivalsService,
  createTmbBusLinesService,
  createTmbCatalogService,
  createTmbStatusService,
  tmbBusLinesUrl,
  tmbCatalogUrls,
  tmbCredentials,
  tmbProxy,
  tmbStatusUrl,
} from '../../server/providers/tmb.js';
import { KEY_SETUP_KEYS, keySetupStatus } from '../keySetupCore.mjs';

const PAIR = { TMB_APP_ID: 'fixture-id', TMB_APP_KEY: 'fixture-secret' };

function fakeFetch(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const { status = 200, body = { type: 'FeatureCollection', features: [] } } =
      typeof answer === 'function' ? answer(calls.length) : answer;
    if (status === 'throw') throw new Error('network down');
    return new Response(JSON.stringify(body), { status });
  };
  return { fetchImpl, calls };
}

test('both halves of the TMB pair are required', () => {
  assert.equal(tmbCredentials({}), null);
  assert.equal(tmbCredentials({ TMB_APP_ID: 'a' }), null);
  assert.equal(tmbCredentials({ TMB_APP_KEY: 'b' }), null);
  assert.equal(tmbCredentials({ TMB_APP_ID: ' ', TMB_APP_KEY: 'b' }), null);
  assert.deepEqual(tmbCredentials({ TMB_APP_ID: ' a ', TMB_APP_KEY: 'b' }), {
    appId: 'a',
    appKey: 'b',
  });
});

test('the credential check asks one fixed, small TMB endpoint', () => {
  const url = new URL(tmbStatusUrl({ appId: 'id&x', appKey: 'k=y' }));
  assert.equal(url.origin, 'https://api.tmb.cat');
  assert.equal(url.pathname, '/v1/transit/linies/metro');
  assert.equal(url.searchParams.get('app_id'), 'id&x');
  assert.equal(url.searchParams.get('app_key'), 'k=y');
  assert.equal(url.searchParams.get('propertyName'), 'CODI_LINIA');
});

test("TMB's answer is classified without echoing it", () => {
  assert.equal(classifyTmbStatus(200, { type: 'FeatureCollection' }), 'ok');
  assert.equal(classifyTmbStatus(401, null), 'rejected');
  assert.equal(classifyTmbStatus(403, { error: 'x' }), 'rejected');
  assert.equal(classifyTmbStatus(200, { unexpected: true }), 'unavailable');
  assert.equal(classifyTmbStatus(500, null), 'unavailable');
});

test('no key means no request to TMB', async () => {
  const { fetchImpl, calls } = fakeFetch({});
  const service = createTmbStatusService({ env: {}, fetchImpl });
  assert.deepEqual(await service.status(), {
    hasKey: false,
    state: null,
    checkedAt: null,
  });
  assert.equal(calls.length, 0);
});

test('a working pair is checked once per ten minutes and never leaks', async () => {
  let clock = 1_000;
  const { fetchImpl, calls } = fakeFetch({});
  const service = createTmbStatusService({
    env: PAIR,
    fetchImpl,
    now: () => clock,
  });
  const [a, b] = await Promise.all([service.status(), service.status()]);
  assert.deepEqual(a, { hasKey: true, state: 'ok', checkedAt: 1_000 });
  assert.deepEqual(b, a);
  assert.equal(calls.length, 1, 'concurrent checks share one request');
  assert.equal(
    calls[0].init.redirect,
    'error',
    'the keyed URL is never redirected',
  );
  clock += TMB_STATUS_TTL_MS - 1;
  await service.status();
  assert.equal(calls.length, 1, 'cached within the window');
  clock += 2;
  await service.status();
  assert.equal(calls.length, 2, 'rechecked after the window');
  const text = JSON.stringify(await service.status());
  assert.doesNotMatch(text, /fixture-id|fixture-secret/);
});

test('a refused pair, a TMB outage and a key change are told apart', async () => {
  const env = { ...PAIR };
  const answers = [{ status: 401, body: {} }, { status: 'throw' }, {}];
  const { fetchImpl } = fakeFetch((n) => answers[n - 1]);
  const service = createTmbStatusService({ env, fetchImpl });
  assert.equal((await service.status()).state, 'rejected');
  env.TMB_APP_KEY = 'another-secret';
  assert.equal((await service.status()).state, 'unavailable');
  env.TMB_APP_KEY = 'third-secret';
  assert.equal((await service.status()).state, 'ok');
});

test('the status route answers only GET on its exact path', async () => {
  let handler = null;
  const plugin = tmbProxy({ env: {}, fetchImpl: fakeFetch({}).fetchImpl });
  plugin.configureServer({
    middlewares: {
      use(path, fn) {
        if (path === '/api/tmb/status') handler = fn;
      },
    },
  });
  const call = async (method, url) => {
    const res = {
      code: 0,
      body: '',
      writeHead(code) {
        this.code = code;
      },
      setHeader() {},
      end(text) {
        this.body = text;
      },
    };
    await handler(
      {
        method,
        url,
        headers: { host: 'localhost:4173' },
        socket: {},
      },
      res,
    );
    return res;
  };
  const ok = await call('GET', '/');
  assert.equal(ok.code, 200);
  assert.deepEqual(JSON.parse(ok.body), {
    hasKey: false,
    state: null,
    checkedAt: null,
  });
  assert.equal((await call('POST', '/')).code, 405);
  assert.equal((await call('GET', '/elsewhere')).code, 404);
});

test('POWER UP offers the TMB pair as one free, server-side credential', () => {
  const tmb = KEY_SETUP_KEYS.find((key) => key.id === 'tmb');
  assert.ok(tmb);
  assert.deepEqual([...tmb.envVars], ['TMB_APP_ID', 'TMB_APP_KEY']);
  assert.equal(tmb.tier, 'free');
  assert.notEqual(tmb.clientExposed, true);
  assert.match(tmb.getUrl, /^https:\/\/developer\.tmb\.cat\//);
  const half = keySetupStatus({ TMB_APP_ID: 'fixture-id' });
  assert.equal(half.keys.find((key) => key.id === 'tmb').set, false);
  const whole = keySetupStatus(PAIR);
  assert.equal(whole.keys.find((key) => key.id === 'tmb').set, true);
  assert.doesNotMatch(JSON.stringify(whole), /fixture-secret/);
});

// --- Station catalogue and next arrivals ------------------------------------
// Hand-made answers in TMB's shape; not TMB data (app-bound licence).

const point = (lon, lat) => ({ type: 'Point', coordinates: [lon, lat] });
const METRO_BODY = {
  type: 'FeatureCollection',
  features: [
    {
      geometry: point(2.17, 41.38),
      properties: {
        CODI_GRUP_ESTACIO: 6660100,
        CODI_ESTACIO: 100,
        NOM_ESTACIO: 'Plaça Exemple',
        NOM_LINIA: 'L1',
        COLOR_LINIA: 'CE1126',
      },
    },
    {
      geometry: point(2.17, 41.38),
      properties: {
        CODI_GRUP_ESTACIO: 6660100,
        CODI_ESTACIO: 300,
        NOM_ESTACIO: 'Plaça Exemple',
        NOM_LINIA: 'L3',
        COLOR_LINIA: '1EB53A',
      },
    },
  ],
};
const BUS_BODY = {
  type: 'FeatureCollection',
  features: [
    {
      geometry: point(2.15, 41.37),
      properties: { CODI_PARADA: 108, NOM_PARADA: 'Plaça B' },
    },
  ],
};
const LINES_BODY = {
  type: 'FeatureCollection',
  features: [
    {
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [
            [2.17, 41.38],
            [2.18, 41.39],
          ],
        ],
      },
      properties: { NOM_LINIA: 'L1', COLOR_LINIA: 'ce1126', ORDRE_LINIA: 1 },
    },
  ],
};
const BUS_LINES_BODY = {
  type: 'FeatureCollection',
  features: [
    {
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [
            [2.16, 41.38],
            [2.17, 41.39],
          ],
          [
            [2.17, 41.39],
            [2.16, 41.38],
          ],
        ],
      },
      properties: {
        NOM_LINIA: '24',
        DESC_LINIA: 'Pl. Catalunya / El Carmel',
        COLOR_LINIA: 'DA291C',
        ORDRE_LINIA: 24,
      },
    },
    {
      geometry: { type: 'LineString', coordinates: [[2.1, 41.4]] },
      properties: { NOM_LINIA: 'X', COLOR_LINIA: 'zz' },
    },
  ],
};
const IMETRO_BODY = {
  timestamp: 1_000,
  linies: [
    {
      nom_linia: 'L1',
      estacions: [
        {
          codi_via: 1,
          linies_trajectes: [
            {
              nom_linia: 'L1',
              desti_trajecte: 'Nord',
              propers_trens: [{ temps_arribada: 61_000 }],
            },
          ],
        },
      ],
    },
  ],
};
const IBUS_BODY = {
  timestamp: 2_000,
  parades: [
    {
      nom_parada: 'Plaça B',
      linies_trajectes: [
        {
          nom_linia: 'H16',
          desti_trajecte: 'Port',
          propers_busos: [{ temps_arribada: 62_000 }],
        },
      ],
    },
  ],
};

/** Answers by TMB path; `override(path, n)` may replace any answer. */
function tmbApi(override = () => null) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    calls.push({
      url,
      path: parsed.pathname,
      params: parsed.searchParams,
      init,
    });
    const custom = override(parsed.pathname, calls.length);
    if (custom?.status === 'throw') throw new Error('network down');
    if (custom)
      return new Response(JSON.stringify(custom.body ?? {}), {
        status: custom.status ?? 200,
      });
    const body = {
      '/v1/transit/linies/metro/estacions': METRO_BODY,
      '/v1/transit/parades': BUS_BODY,
      '/v1/transit/linies/metro': LINES_BODY,
      '/v1/transit/linies/bus': BUS_LINES_BODY,
      '/v1/itransit/metro/estacions': IMETRO_BODY,
      '/v1/itransit/bus/parades/108': IBUS_BODY,
    }[parsed.pathname];
    return new Response(JSON.stringify(body ?? {}), {
      status: body ? 200 : 404,
    });
  };
  return { fetchImpl, calls };
}

test('the catalogue asks TMB only for the fields a marker needs', () => {
  const urls = tmbCatalogUrls({ appId: 'a', appKey: 'b' });
  const metro = new URL(urls.metro);
  const bus = new URL(urls.bus);
  assert.equal(metro.pathname, '/v1/transit/linies/metro/estacions');
  assert.match(metro.searchParams.get('propertyName'), /CODI_GRUP_ESTACIO/);
  assert.match(metro.searchParams.get('propertyName'), /GEOMETRY/);
  assert.equal(bus.pathname, '/v1/transit/parades');
  assert.equal(
    bus.searchParams.get('propertyName'),
    'CODI_PARADA,NOM_PARADA,GEOMETRY',
  );
});

test('the catalogue is built once a day, shared, and kept when a refresh fails', async () => {
  let clock = 10_000;
  let fail = false;
  const { fetchImpl, calls } = tmbApi(() =>
    fail ? { status: 'throw' } : null,
  );
  const catalog = createTmbCatalogService({
    env: PAIR,
    fetchImpl,
    now: () => clock,
  });
  const [a, b] = await Promise.all([catalog.catalog(), catalog.catalog()]);
  assert.equal(
    calls.length,
    3,
    'one metro, one bus and one line request, shared',
  );
  assert.equal(a, b);
  assert.deepEqual(
    a.metro.map((s) => [s.id, s.codes]),
    [['6660100', [100, 300]]],
  );
  assert.deepEqual(a.bus, [
    { id: '108', name: 'Plaça B', lat: 41.37, lon: 2.15 },
  ]);
  for (const call of calls) assert.equal(call.init.redirect, 'error');
  clock += TMB_CATALOG_TTL_MS;
  fail = true;
  assert.equal(
    await catalog.catalog(),
    a,
    'a failed refresh serves the old copy',
  );
  assert.equal(calls.length, 6);
  assert.deepEqual(await catalog.metroCodes('6660100'), [100, 300]);
  assert.equal(await catalog.hasBusStop('999'), false);
});

test('the catalogue needs a key and reports a refused one', async () => {
  const none = createTmbCatalogService({
    env: {},
    fetchImpl: tmbApi().fetchImpl,
  });
  await assert.rejects(none.catalog(), { code: 'no_key' });
  const refused = createTmbCatalogService({
    env: PAIR,
    fetchImpl: tmbApi(() => ({ status: 403 })).fetchImpl,
  });
  await assert.rejects(refused.catalog(), { code: 'rejected' });
});

test('metro arrivals ask once for every code of the station group', async () => {
  let clock = 50_000;
  const { fetchImpl, calls } = tmbApi();
  const service = createTmbArrivalsService({
    env: PAIR,
    fetchImpl,
    now: () => clock,
  });
  const [a, b] = await Promise.all([
    service.arrivals('metro', '6660100'),
    service.arrivals('metro', '6660100'),
  ]);
  assert.equal(a, b);
  const imetro = calls.filter((c) => c.path === '/v1/itransit/metro/estacions');
  assert.equal(imetro.length, 1, 'concurrent clicks share one request');
  assert.equal(imetro[0].params.get('estacions'), '100,300');
  assert.equal(imetro[0].init.redirect, 'error');
  assert.deepEqual(a, {
    kind: 'metro',
    id: '6660100',
    fetchedAt: 1_000,
    routes: [
      {
        line: 'L1',
        color: null,
        destination: 'Nord',
        track: 1,
        arrivals: [61_000],
      },
    ],
  });
  clock += TMB_ARRIVALS_TTL_MS - 1;
  await service.arrivals('metro', '6660100');
  assert.equal(
    calls.filter((c) => c.path.startsWith('/v1/itransit')).length,
    1,
    'cached for 15 s',
  );
  clock += 1;
  await service.arrivals('metro', '6660100');
  assert.equal(
    calls.filter((c) => c.path.startsWith('/v1/itransit')).length,
    2,
  );
  assert.doesNotMatch(JSON.stringify(a), /fixture-id|fixture-secret/);
});

test('only stations and stops in the catalogue can be asked about', async () => {
  const { fetchImpl, calls } = tmbApi();
  const service = createTmbArrivalsService({ env: PAIR, fetchImpl });
  assert.equal((await service.arrivals('bus', '108')).routes[0].line, 'H16');
  await assert.rejects(service.arrivals('bus', '109'), { code: 'not_found' });
  await assert.rejects(service.arrivals('metro', '999'), { code: 'not_found' });
  await assert.rejects(service.arrivals('bus', '../transit'), {
    code: 'not_found',
  });
  await assert.rejects(service.arrivals('tram', '1'), { code: 'not_found' });
  assert.ok(
    calls.every((c) => !c.path.includes('..') && !c.path.endsWith('/109')),
    'nothing outside the catalogue reaches TMB',
  );
});

test('upstream arrival calls stop at the per-minute ceiling', async () => {
  let clock = 0;
  const stops = Array.from({ length: TMB_ARRIVALS_PER_MINUTE + 1 }, (_, i) =>
    String(1000 + i),
  );
  const { fetchImpl, calls } = tmbApi((path) => {
    if (path === '/v1/transit/parades')
      return {
        body: {
          type: 'FeatureCollection',
          features: stops.map((id) => ({
            geometry: point(2.1, 41.3),
            properties: { CODI_PARADA: Number(id), NOM_PARADA: `P${id}` },
          })),
        },
      };
    if (path.startsWith('/v1/itransit/bus/')) return { body: IBUS_BODY };
    return null;
  });
  const service = createTmbArrivalsService({
    env: PAIR,
    fetchImpl,
    now: () => clock,
  });
  for (const id of stops.slice(0, -1)) await service.arrivals('bus', id);
  await assert.rejects(service.arrivals('bus', stops.at(-1)), { code: 'busy' });
  assert.equal(
    calls.filter((c) => c.path.startsWith('/v1/itransit')).length,
    TMB_ARRIVALS_PER_MINUTE,
  );
  clock += 60_000;
  await service.arrivals('bus', stops.at(-1));
});

test('the station and arrival routes map TMB failures to plain status codes', async () => {
  const handlers = new Map();
  let refuse = false;
  const plugin = tmbProxy({
    env: PAIR,
    fetchImpl: tmbApi((path) =>
      refuse && path.startsWith('/v1/itransit') ? { status: 401 } : null,
    ).fetchImpl,
  });
  plugin.configureServer({
    middlewares: { use: (path, fn) => handlers.set(path, fn) },
  });
  const call = async (path, url, method = 'GET') => {
    const res = {
      code: 0,
      headers: {},
      body: '',
      writeHead(code, headers) {
        this.code = code;
        Object.assign(this.headers, headers);
      },
      setHeader() {},
      end(text) {
        this.body = text;
      },
    };
    await handlers.get(path)(
      { method, url, headers: { host: 'localhost:4173' }, socket: {} },
      res,
    );
    return res;
  };
  const stations = await call('/api/tmb/stations', '/');
  assert.equal(stations.code, 200);
  assert.equal(JSON.parse(stations.body).metro.length, 1);
  const metro = await call('/api/tmb/arrivals', '/metro/6660100');
  assert.equal(metro.code, 200);
  assert.equal(JSON.parse(metro.body).routes[0].destination, 'Nord');
  assert.equal(
    (await call('/api/tmb/arrivals', '/metro/6660100/extra')).code,
    404,
  );
  assert.equal((await call('/api/tmb/arrivals', '/bus/109')).code, 404);
  assert.equal((await call('/api/tmb/arrivals', '/bus/108', 'POST')).code, 405);
  refuse = true;
  const refused = await call('/api/tmb/arrivals', '/bus/108');
  assert.equal(refused.code, 502);
  assert.deepEqual(JSON.parse(refused.body), { error: 'rejected' });
  for (const res of [stations, metro, refused])
    assert.doesNotMatch(res.body, /fixture-id|fixture-secret/);

  const keyless = new Map();
  tmbProxy({ env: {}, fetchImpl: tmbApi().fetchImpl }).configureServer({
    middlewares: { use: (path, fn) => keyless.set(path, fn) },
  });
  const res = {
    code: 0,
    body: '',
    writeHead(code) {
      this.code = code;
    },
    setHeader() {},
    end(text) {
      this.body = text;
    },
  };
  await keyless.get('/api/tmb/stations')(
    {
      method: 'GET',
      url: '/',
      headers: { host: 'localhost:4173' },
      socket: {},
    },
    res,
  );
  assert.equal(res.code, 503);
  assert.deepEqual(JSON.parse(res.body), { error: 'no_key' });
});

test('the catalogue carries metro line geometry, and survives without it', async () => {
  const { fetchImpl, calls } = tmbApi();
  const catalog = createTmbCatalogService({ env: PAIR, fetchImpl });
  const { lines } = await catalog.catalog();
  assert.deepEqual(lines, [
    { name: 'L1', color: 'CE1126', paths: [[2.17, 41.38, 2.18, 41.39]] },
  ]);
  const linesCall = calls.find((c) => c.path === '/v1/transit/linies/metro');
  assert.equal(
    linesCall.params.get('propertyName'),
    'NOM_LINIA,COLOR_LINIA,ORDRE_LINIA,GEOMETRY',
  );
  const broken = createTmbCatalogService({
    env: PAIR,
    fetchImpl: tmbApi((path) =>
      path === '/v1/transit/linies/metro' ? { status: 500 } : null,
    ).fetchImpl,
  });
  const fallback = await broken.catalog();
  assert.deepEqual(fallback.lines, []);
  assert.equal(fallback.metro.length, 1, 'stations still served');
});

test('bus routes are asked for once a day, trimmed, and kept when a refresh fails', async () => {
  const url = new URL(tmbBusLinesUrl({ appId: 'a', appKey: 'b' }));
  assert.equal(url.pathname, '/v1/transit/linies/bus');
  assert.match(url.searchParams.get('propertyName'), /GEOMETRY/);
  assert.match(url.searchParams.get('propertyName'), /DESC_LINIA/);
  let clock = 1_000;
  let fail = false;
  const { fetchImpl, calls } = tmbApi(() => (fail ? { status: 500 } : null));
  const service = createTmbBusLinesService({
    env: PAIR,
    fetchImpl,
    now: () => clock,
  });
  const [a, b] = await Promise.all([service.lines(), service.lines()]);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(a.lines, [
    {
      name: '24',
      desc: 'Pl. Catalunya / El Carmel',
      color: 'DA291C',
      paths: [
        [2.16, 41.38, 2.17, 41.39],
        [2.17, 41.39, 2.16, 41.38],
      ],
    },
  ]);
  clock += TMB_CATALOG_TTL_MS;
  fail = true;
  assert.deepEqual(
    await service.lines(),
    a,
    "yesterday's routes are still right",
  );
  assert.equal(calls.length, 2);
  await assert.rejects(
    createTmbBusLinesService({ env: {}, fetchImpl }).lines(),
    (error) => error.code === 'no_key',
  );
  await assert.rejects(
    createTmbBusLinesService({
      env: PAIR,
      fetchImpl: tmbApi(() => ({ status: 401 })).fetchImpl,
    }).lines(),
    (error) => error.code === 'rejected',
  );
});

test('the bus route list is served on its exact path, GET only', async () => {
  const handlers = new Map();
  const plugin = tmbProxy({ env: PAIR, fetchImpl: tmbApi().fetchImpl });
  plugin.configureServer({
    middlewares: { use: (path, fn) => handlers.set(path, fn) },
  });
  const call = async (url, method = 'GET') => {
    const res = {
      code: 0,
      body: '',
      writeHead(code) {
        this.code = code;
      },
      setHeader() {},
      end(text) {
        this.body = text;
      },
    };
    await handlers.get('/api/tmb/bus-lines')(
      { method, url, headers: { host: 'localhost:4173' }, socket: {} },
      res,
    );
    return res;
  };
  const ok = await call('/');
  assert.equal(ok.code, 200);
  assert.equal(JSON.parse(ok.body).lines[0].name, '24');
  assert.doesNotMatch(ok.body, /fixture-secret/);
  assert.equal((await call('/x')).code, 404);
  assert.equal((await call('/', 'POST')).code, 405);
});
