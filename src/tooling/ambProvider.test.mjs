import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  AMB_GTFS_URL,
  AMB_TRIP_UPDATES_TTL_MS,
  AMB_TRIP_UPDATES_URL,
  ambProxy,
  createAmbArrivalsService,
  readZipEntries,
} from '../../server/providers/amb.js';
import {
  ROUTES_CSV,
  STOPS_CSV,
  TRIPS_CSV,
  encodeTripUpdates,
} from '../data/ambArrivalsFixtures.mjs';

/** A zip with each file deflated (or stored when `store` names it). */
function makeZip(files, store = new Set()) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8');
    const method = store.has(name) ? 0 : 8;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const GTFS_ZIP = makeZip(
  {
    'agency.txt': 'agency_id,agency_name\n1,Exemple\n',
    'stops.txt': STOPS_CSV,
    'routes.txt': ROUTES_CSV,
    'trips.txt': TRIPS_CSV,
  },
  new Set(['routes.txt']),
);

const NOW = 1_800_000_000_000;
const at = (minutes) => Math.round(NOW / 1000 + minutes * 60);

function ambApi({
  feed = () =>
    encodeTripUpdates(NOW / 1000, [
      { tripId: '129.1', stops: [{ stopId: '100005', time: at(4) }] },
    ]),
  gtfs = () => GTFS_ZIP,
} = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === AMB_GTFS_URL) {
      const body = gtfs();
      return body
        ? new Response(body, { status: 200 })
        : new Response('', { status: 500 });
    }
    if (url === AMB_TRIP_UPDATES_URL) {
      if (init?.headers?.['If-None-Match'] === 'W/"v1"')
        return new Response(null, { status: 304 });
      const body = feed();
      return body
        ? new Response(body, { status: 200, headers: { etag: 'W/"v1"' } })
        : new Response('', { status: 503 });
    }
    return new Response('', { status: 404 });
  };
  return { fetchImpl, calls };
}

test('zip entries are read deflated or stored, and only the names asked for', () => {
  const files = readZipEntries(
    GTFS_ZIP,
    ['stops.txt', 'routes.txt'],
    1024 * 1024,
  );
  assert.deepEqual([...files.keys()].sort(), ['routes.txt', 'stops.txt']);
  assert.equal(files.get('routes.txt').toString('utf8'), ROUTES_CSV);
  assert.throws(() => readZipEntries(GTFS_ZIP, ['trips.txt'], 10), /too large/);
  assert.throws(
    () => readZipEntries(Buffer.from('not a zip at all, sorry'), ['x'], 10),
    /end of central directory/,
  );
});

test('stops come from the static GTFS, once a day for every caller', async () => {
  const { fetchImpl, calls } = ambApi();
  const service = createAmbArrivalsService({ fetchImpl, now: () => NOW });
  const [a, b] = await Promise.all([service.stops(), service.stops()]);
  assert.equal(a.stops.length, 2);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'error');
});

test('arrivals at any stop share one trip-updates download per 30 s, revalidated by ETag', async () => {
  let clock = NOW;
  const { fetchImpl, calls } = ambApi();
  const service = createAmbArrivalsService({ fetchImpl, now: () => clock });
  const first = await service.arrivals('100005');
  assert.deepEqual(first, {
    kind: 'amb',
    id: '100005',
    fetchedAt: NOW,
    routes: [
      {
        line: '87',
        color: 'FFAA00',
        destination: 'Gràcia',
        track: null,
        arrivals: [at(4) * 1000],
      },
    ],
  });
  assert.deepEqual((await service.arrivals('000108')).routes, []);
  const feedCalls = () => calls.filter((c) => c.url === AMB_TRIP_UPDATES_URL);
  assert.equal(feedCalls().length, 1, 'a second stop reads the same download');
  clock += AMB_TRIP_UPDATES_TTL_MS;
  const later = await service.arrivals('100005');
  assert.equal(feedCalls().length, 2);
  assert.equal(feedCalls()[1].init.headers['If-None-Match'], 'W/"v1"');
  assert.deepEqual(later.routes, first.routes, 'a 304 keeps the last trips');
  clock += 10 * 60_000;
  assert.deepEqual(
    (await service.arrivals('100005')).routes,
    [],
    'and re-indexes, so gone buses drop off',
  );
});

test('unknown stops never reach AMB, and AMB failures are plain errors', async () => {
  const { fetchImpl, calls } = ambApi({ feed: () => null });
  const service = createAmbArrivalsService({ fetchImpl, now: () => NOW });
  await assert.rejects(service.arrivals('999999'), { code: 'not_found' });
  await assert.rejects(service.arrivals('../x'), { code: 'not_found' });
  await assert.rejects(
    service.arrivals('100006'),
    { code: 'not_found' },
    'out of service',
  );
  assert.ok(calls.every((c) => c.url !== AMB_TRIP_UPDATES_URL));
  await assert.rejects(service.arrivals('100005'), { code: 'unavailable' });
  const broken = createAmbArrivalsService({
    fetchImpl: ambApi({ gtfs: () => null }).fetchImpl,
  });
  await assert.rejects(broken.stops(), { code: 'unavailable' });
});

test('the AMB routes answer GET only and map errors to status codes', async () => {
  const handlers = new Map();
  ambProxy({ fetchImpl: ambApi().fetchImpl, now: () => NOW }).configureServer({
    middlewares: { use: (path, fn) => handlers.set(path, fn) },
  });
  const call = async (path, url, method = 'GET') => {
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
    await handlers.get(path)(
      { method, url, headers: { host: 'localhost:4173' }, socket: {} },
      res,
    );
    return res;
  };
  const stops = await call('/api/amb/stops', '/');
  assert.equal(stops.code, 200);
  assert.equal(JSON.parse(stops.body).stops[0].id, '000108');
  assert.equal((await call('/api/amb/stops', '/extra')).code, 404);
  const arrivals = await call('/api/amb/arrivals', '/100005');
  assert.equal(arrivals.code, 200);
  assert.equal(JSON.parse(arrivals.body).routes[0].line, '87');
  assert.equal((await call('/api/amb/arrivals', '/999999')).code, 404);
  assert.equal((await call('/api/amb/arrivals', '/100005/x')).code, 404);
  assert.equal((await call('/api/amb/arrivals', '/100005', 'POST')).code, 405);
});
