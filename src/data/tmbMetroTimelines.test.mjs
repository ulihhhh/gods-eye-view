import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TMB_METRO_DWELL_MS,
  buildTmbMetroNetwork,
  learnTmbMetroRuntimes,
  tmbMetroNetworkCodes,
  tmbMetroSegmentPaths,
  tmbMetroTimelines,
  tmbMetroTrains,
} from './tmbMetroTimelines.js';
import { estimateVehicles } from './estimatedPositions.js';

const T0 = Date.UTC(2026, 9, 17, 10, 12, 0);
const s = (seconds) => T0 + seconds * 1000;

/** A five-station line, ordered north to south, in TMB's station list shape. */
function station(code, order, name, lat, line = 'L3') {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [2.17, lat] },
    properties: {
      CODI_ESTACIO: code,
      NOM_ESTACIO: name,
      NOM_LINIA: line,
      ORDRE_ESTACIO: order,
    },
  };
}
const CATALOG = {
  type: 'FeatureCollection',
  features: [
    station(301, 1, 'Uno', 41.42),
    station(302, 2, 'Dos', 41.41),
    station(303, 3, 'Tres', 41.4),
    station(304, 4, 'Cuatro', 41.39),
    station(305, 5, 'Cinco', 41.38),
    station(901, 1, 'Nueve', 41.3, 'L9S'),
    // Not usable: no geometry.
    { type: 'Feature', properties: { CODI_ESTACIO: 999, NOM_LINIA: 'L3' } },
  ],
};

/** iMetro's answer: per station and track, the next trains with times. */
function imetro(entries) {
  const stations = new Map();
  for (const [code, track, service, at, destination] of entries) {
    const key = `${code}|${track}`;
    if (!stations.has(key))
      stations.set(key, {
        codi_via: track,
        codi_estacio: code,
        linies_trajectes: [
          {
            nom_linia: 'L3',
            desti_trajecte: destination,
            propers_trens: [],
          },
        ],
      });
    stations.get(key).linies_trajectes[0].propers_trens.push({
      codi_servei: service,
      temps_arribada: at,
    });
  }
  return {
    timestamp: T0,
    linies: [{ nom_linia: 'L3', estacions: [...stations.values()] }],
  };
}

const NETWORK = buildTmbMetroNetwork(CATALOG);

test('the network indexes stations by code and by line order', () => {
  assert.equal(NETWORK.byCode.size, 6);
  assert.equal(NETWORK.byCode.get(303).name, 'Tres');
  assert.equal(NETWORK.byLineOrder.get('L3').get(4), 304);
  assert.deepEqual(
    tmbMetroNetworkCodes(NETWORK),
    [301, 302, 303, 304, 305, 901],
  );
  assert.equal(buildTmbMetroNetwork({}), null);
});

test('a service code is one train, its arrivals sorted per track', () => {
  const trains = tmbMetroTrains(
    imetro([
      [304, 1, '307', s(150), 'Cinco'],
      [303, 1, '307', s(60), 'Cinco'],
      [305, 1, '307', s(240), 'Cinco'],
      [305, 1, '308', s(30), 'Cinco'],
    ]),
    NETWORK,
  );
  assert.deepEqual([...trains.keys()], ['L3|307', 'L3|308']);
  assert.deepEqual(
    trains
      .get('L3|307')
      .tracks.get(1)
      .map((call) => call.code),
    [303, 304, 305],
  );
});

test('segment running times are learned from consecutive predictions', () => {
  const trains = tmbMetroTrains(
    imetro([
      [303, 1, '307', s(60), 'Cinco'],
      [304, 1, '307', s(150), 'Cinco'],
      [302, 1, '308', s(10), 'Cinco'],
      [303, 1, '308', s(90), 'Cinco'],
      [304, 1, '308', s(170), 'Cinco'],
    ]),
    NETWORK,
  );
  const runtimes = learnTmbMetroRuntimes(trains);
  assert.equal(runtimes.get('303>304'), 90_000); // upper median of 80 s and 90 s
  assert.equal(runtimes.get('302>303'), 80_000);
  // A later answer moves the average, not replaces it.
  learnTmbMetroRuntimes(
    tmbMetroTrains(
      imetro([
        [302, 1, '309', s(0), 'Cinco'],
        [303, 1, '309', s(180), 'Cinco'],
      ]),
      NETWORK,
    ),
    runtimes,
  );
  assert.equal(runtimes.get('302>303'), 80_000 + 0.3 * 100_000);
});

test('a train is placed on the segment before its first predicted station', () => {
  const body = imetro([
    [303, 1, '307', s(40), 'Cinco'],
    [304, 1, '307', s(130), 'Cinco'],
    [305, 1, '307', s(220), 'Cinco'],
  ]);
  const [timeline] = tmbMetroTimelines(body, NETWORK);
  assert.equal(timeline.id, 'L3-307');
  assert.equal(timeline.destination, 'Cinco');
  assert.deepEqual(
    timeline.stops.map((stop) => stop.stopId),
    ['302', '303', '304', '305'],
  );
  // 302→303 is unmeasured; 303→304 and 304→305 are 90 s. The fallback is
  // distance at the fallback speed, plus the stand.
  const [from] = timeline.stops;
  assert.equal(from.dep - from.arr, TMB_METRO_DWELL_MS);
  assert.ok(from.dep < s(40));
  const [record] = estimateVehicles([timeline], T0);
  assert.equal(record.estimated, true);
  assert.equal(record.status, 'IN_TRANSIT_TO');
  assert.equal(record.stopId, '303');
  assert.equal(record.stopName, 'Tres');
  assert.ok(record.lat < 41.41 && record.lat > 41.4);
  assert.equal(record.nextStops[0].name, 'Tres');
});

test('the learned running time places a train further along its segment', () => {
  const body = imetro([
    [303, 1, '307', s(30), 'Cinco'],
    [304, 1, '307', s(120), 'Cinco'],
    // Another train measures 302→303 at 120 s.
    [302, 1, '308', s(200), 'Cinco'],
    [303, 1, '308', s(320), 'Cinco'],
  ]);
  const timelines = tmbMetroTimelines(body, NETWORK);
  const train = timelines.find((timeline) => timeline.id === 'L3-307');
  const [from] = train.stops;
  assert.equal(from.dep, s(30) - (120_000 - TMB_METRO_DWELL_MS));
});

test('at a terminus a train runs on the track it reaches first', () => {
  const body = imetro([
    // Train 311 reaches the north terminus (order 1) on track 2, then turns
    // and is predicted southbound on track 1.
    [302, 2, '311', s(20), 'Uno'],
    [301, 2, '311', s(100), 'Uno'],
    [301, 1, '311', s(300), 'Cinco'],
    [302, 1, '311', s(390), 'Cinco'],
    // Another southbound train tells which way track 1 runs.
    [303, 1, '312', s(10), 'Cinco'],
    [304, 1, '312', s(100), 'Cinco'],
  ]);
  const train = tmbMetroTimelines(body, NETWORK).find(
    (timeline) => timeline.id === 'L3-311',
  );
  assert.deepEqual(
    train.stops.map((stop) => stop.stopId),
    ['303', '302', '301'],
  );
  assert.equal(train.destination, 'Uno');
});

test('a train waiting at the start of the line stands at the terminus', () => {
  const body = imetro([
    [301, 1, '320', s(120), 'Cinco'],
    [302, 1, '320', s(210), 'Cinco'],
  ]);
  const [timeline] = tmbMetroTimelines(body, NETWORK);
  assert.equal(timeline.stops[0].stopId, '301');
  const [record] = estimateVehicles([timeline], T0);
  assert.equal(record.status, 'STOPPED_AT');
  assert.equal(record.stopId, '301');
});

test('a train with one prediction and no known direction is left out', () => {
  const body = imetro([[303, 1, '330', s(50), 'Cinco']]);
  assert.deepEqual(tmbMetroTimelines(body, NETWORK), []);
});

test('an implausible gap cuts the timeline; unknown stations are ignored', () => {
  const body = imetro([
    [302, 1, '340', s(10), 'Cinco'],
    [303, 1, '340', s(100), 'Cinco'],
    [304, 1, '340', s(100 + 873), 'Cinco'],
    [777, 1, '340', s(120), 'Cinco'],
  ]);
  const [timeline] = tmbMetroTimelines(body, NETWORK);
  assert.deepEqual(
    timeline.stops.map((stop) => stop.stopId),
    ['301', '302', '303'],
  );
});

test('malformed answers give no timelines', () => {
  assert.deepEqual(tmbMetroTimelines(null, NETWORK), []);
  assert.deepEqual(tmbMetroTimelines({ linies: 'x' }, NETWORK), []);
  assert.deepEqual(tmbMetroTimelines(imetro([]), null), []);
});

test('a train carries its line colour from iMetro', () => {
  const body = imetro([
    [302, 1, '350', s(40), 'Cinco'],
    [303, 1, '350', s(130), 'Cinco'],
  ]);
  for (const station of body.linies[0].estacions)
    station.linies_trajectes[0].color_linia = '1eb53a';
  const [timeline] = tmbMetroTimelines(body, NETWORK);
  assert.equal(timeline.routeColor, '1EB53A');
  const [record] = estimateVehicles([timeline], T0);
  assert.equal(record.routeColor, '1EB53A');
  // Without a colour the record has none, and the layer uses the mode's.
  const [plain] = tmbMetroTimelines(
    imetro([
      [302, 1, '351', s(40), 'Cinco'],
      [303, 1, '351', s(130), 'Cinco'],
    ]),
    NETWORK,
  );
  assert.equal('routeColor' in plain, false);
});

test('a train runs along its own line between stations, not the chord', () => {
  // L3 bends east between Dos (41.41) and Tres (41.40): the track goes out
  // to 2.175 and back. An L1 track runs straight nearby and must not be used.
  const lines = [
    {
      name: 'L3',
      paths: [
        [2.17, 41.42, 2.17, 41.41, 2.175, 41.405, 2.17, 41.4, 2.17, 41.39],
      ],
    },
    { name: 'L1', paths: [[2.171, 41.42, 2.171, 41.39]] },
  ];
  const segmentPath = tmbMetroSegmentPaths(lines);
  const body = imetro([
    [302, 1, '360', s(-10), 'Cinco'],
    [303, 1, '360', s(80), 'Cinco'],
    [304, 1, '360', s(170), 'Cinco'],
  ]);
  const [timeline] = tmbMetroTimelines(body, NETWORK);
  // Halfway between Dos's departure (−10 s + 20 s stand) and Tres (80 s).
  const [record] = estimateVehicles([timeline], s(45), { segmentPath });
  assert.equal(record.stopId, '303');
  assert.ok(Math.abs(record.lon - 2.175) < 0.0005, `lon ${record.lon}`);
  assert.ok(Math.abs(record.lat - 41.405) < 0.0005, `lat ${record.lat}`);
  // The same pair is answered from the cache.
  const from = timeline.stops[1];
  const to = timeline.stops[2];
  assert.equal(
    segmentPath(from, to, timeline),
    segmentPath(from, to, timeline),
  );
  // Stations away from any track run straight (null), as before.
  const far = (stopId, lat) => ({ stopId, lat, lon: 2.3, arr: 0, dep: 0 });
  assert.equal(segmentPath(far('a', 41.41), far('b', 41.4), timeline), null);
  assert.equal(tmbMetroSegmentPaths(null), null);
  assert.equal(tmbMetroSegmentPaths([{ name: 'L3', paths: [] }]), null);
});
