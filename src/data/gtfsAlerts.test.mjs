import test from 'node:test';
import assert from 'node:assert/strict';
import { alertActive, alertText, decodeAlerts } from './gtfsAlerts.js';
import { encodeAlerts } from './gtfsAlertsFixtures.mjs';
import { transitAlertText } from './transitAlertText.js';
import {
  applyServiceFields,
  publicTransitAlerts,
  TRANSIT_MAX_VEHICLE_ALERTS,
} from './transitServiceFields.js';
import { resolveTransitRoute } from './transitProxy.js';
import { buildTransitSelectionCopy } from '../layers/transit/policy.js';
import { getTransitFeed } from './transitFeeds.js';
import { createTransitService } from '../sources/transitService.js';

const NOW = Date.parse('2026-10-16T10:30:00Z');
const s = (iso) => Math.round(Date.parse(iso) / 1000);

const ALERTS = [
  {
    // Renfe: no header, a Spanish description, padded route ids.
    id: 'AVISO_1',
    description: {
      es: '#MadC3 #MadC4 Los trenes recuperan\nsus frecuencias de paso habituales.',
    },
    periods: [{ start: s('2026-10-07T06:44:00Z') }],
    routes: ['10T0099C3  ', '10T0033C3'],
  },
  {
    // AMB: Catalan and Spanish, a detour on a route and its stops.
    id: '28357',
    header: {
      ca: 'Desviament provisional al carrer Marina',
      es: 'Desvío provisional en la calle Marina',
    },
    effect: 4,
    cause: 9,
    periods: [
      { start: s('2026-10-15T21:00:00Z'), end: s('2026-10-20T21:00:00Z') },
    ],
    routes: ['216'],
    stops: ['000038', '003231'],
  },
  {
    // FGC: one per trip and stop, no language.
    id: 'OBS_1',
    header: { '': 'Últim cotxe reservat escolar' },
    effect: 8,
    periods: [
      { start: s('2026-10-16T01:00:00Z'), end: s('2026-10-17T01:00:00Z') },
    ],
    stops: ['SR'],
    trips: [{ tripId: 'fgc-trip-1' }],
  },
  {
    id: 'OBS_2',
    header: { '': 'Últim cotxe reservat escolar' },
    stops: ['GR'],
    trips: [{ tripId: 'fgc-trip-1' }],
  },
  { id: 'gone', deleted: true, header: { es: 'Borrado' } },
  { id: 'empty', routes: ['X'] },
  {
    id: 'later',
    header: { es: 'Obras en noviembre' },
    periods: [{ start: s('2026-11-01T00:00:00Z') }],
    routes: ['10T0099C3'],
  },
];

test('alerts decode with their text, effect, cause, period and entities', () => {
  const alerts = decodeAlerts(encodeAlerts(ALERTS));
  assert.deepEqual(
    alerts.map((alert) => alert.id),
    ['AVISO_1', '28357', 'OBS_1', 'OBS_2', 'later'],
    'deleted and textless alerts are left out',
  );
  const [renfe, amb, fgc] = alerts;
  assert.deepEqual(renfe.header, {
    es: '#MadC3 #MadC4 Los trenes recuperan sus frecuencias de paso habituales.',
  });
  assert.deepEqual(renfe.description, {}, 'the description became the header');
  assert.deepEqual(renfe.routes, ['10T0099C3', '10T0033C3'], 'ids trimmed');
  assert.deepEqual(renfe.periods, [
    { start: Date.parse('2026-10-07T06:44:00Z'), end: null },
  ]);
  assert.equal(amb.effect, 'DETOUR');
  assert.equal(amb.cause, 'MAINTENANCE');
  assert.deepEqual(amb.stops, ['000038', '003231']);
  assert.deepEqual(fgc.header, { '': 'Últim cotxe reservat escolar' });
  assert.deepEqual(fgc.trips, ['fgc-trip-1']);
});

test('alert text is plain and bounded; periods decide whether it applies', () => {
  assert.equal(alertText('a\u0000b\r\n  c', 50), 'a b c');
  assert.equal(alertText('one two three four', 12), 'one two…');
  assert.equal(alertText('   ', 10), null);
  const [renfe, , , , later] = decodeAlerts(encodeAlerts(ALERTS));
  assert.equal(alertActive(renfe, NOW), true, 'open-ended');
  assert.equal(alertActive(later, NOW), false, 'not yet');
  assert.equal(alertActive({ periods: [] }, NOW), true, 'no period: always');
});

test('card text prefers English, then Spanish, then Catalan, without hashtags', () => {
  assert.equal(
    transitAlertText({ ca: 'Desviament', es: 'Desvío', en: 'Detour' }),
    'Detour',
  );
  assert.equal(transitAlertText({ ca: 'Desviament', es: 'Desvío' }), 'Desvío');
  assert.equal(transitAlertText({ '': 'Enllaç' }), 'Enllaç');
  assert.equal(
    transitAlertText({ es: '#MadC3 #MadC4 Los trenes recuperan' }),
    'Los trenes recuperan',
  );
  assert.equal(transitAlertText({ es: 'uno dos tres cuatro' }, 10), 'uno dos…');
  assert.equal(transitAlertText(null), null);
});

test('vehicles carry the alerts on their trip or static route, each text once', () => {
  const alerts = decodeAlerts(encodeAlerts(ALERTS));
  const [fgc, renfe, plain] = applyServiceFields(
    [
      { id: 'u1', tripId: 'fgc-trip-1' },
      { id: 'c3', tripId: 'renfe-trip' },
      { id: 'other', tripId: 'none' },
    ],
    {
      alerts,
      tripDetails: new Map([['renfe-trip', { gtfsRouteId: '10T0099C3' }]]),
      now: NOW,
    },
  );
  assert.equal(fgc.alerts.length, 1, 'repeated per stop, shown once');
  assert.deepEqual(fgc.alerts[0].header, {
    '': 'Últim cotxe reservat escolar',
  });
  assert.equal(renfe.gtfsRouteId, '10T0099C3');
  assert.equal(renfe.alerts.length, 1, 'November’s works are not yet active');
  assert.equal(plain.alerts, undefined);

  const many = Array.from({ length: 5 }, (_, i) => ({
    id: `a${i}`,
    header: { es: `Aviso ${i}` },
    periods: [],
    routes: [],
    stops: [],
    trips: ['t'],
  }));
  const [crowded] = applyServiceFields([{ id: 'v', tripId: 't' }], {
    alerts: many,
    now: NOW,
  });
  assert.equal(crowded.alerts.length, TRANSIT_MAX_VEHICLE_ALERTS);
  assert.equal(crowded.alertsMore, 2);
});

test('the train card writes out two alerts and counts the rest', () => {
  const record = {
    id: 'v',
    label: 'C3-1',
    routeId: 'C3',
    timestamp: 1,
    alerts: [
      { header: { es: '#MadC3 Los trenes recuperan su frecuencia.' } },
      { header: { es: 'Ascensor fuera de servicio.' } },
      { header: { es: 'Obras.' } },
    ],
    alertsMore: 1,
  };
  const { details } = buildTransitSelectionCopy(
    getTransitFeed('renfe-cercanias'),
    record,
    'rail',
    2000,
    2000,
  );
  assert.ok(details.includes('⚠ Los trenes recuperan su frecuencia.'), details);
  assert.ok(details.includes('⚠ Ascensor fuera de servicio.'), details);
  assert.ok(details.includes('+2 more alerts'), details);
});

test('the public list is the active route and stop alerts, not per-trip ones', () => {
  const list = publicTransitAlerts(decodeAlerts(encodeAlerts(ALERTS)), NOW);
  assert.deepEqual(
    list.map((alert) => alert.id),
    ['AVISO_1', '28357'],
  );
  assert.equal(list[0].start, Date.parse('2026-10-07T06:44:00Z'));
  assert.equal('trips' in list[0], false);
});

test('alerts resolve only for feeds that publish them', () => {
  assert.equal(resolveTransitRoute('/alerts/renfe-cercanias').route, 'alerts');
  assert.equal(resolveTransitRoute('/alerts/fgc-geotren').route, 'alerts');
  assert.equal(resolveTransitRoute('/alerts/renfe-ld'), null);
  assert.equal(resolveTransitRoute('/alerts/mbta'), null);
  assert.equal(resolveTransitRoute('/alerts/fgc-geotren/x'), null);
});

test('the service reads alerts beside positions, at most every two minutes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const calls = [];
  const geotren = JSON.stringify({
    nhits: 1,
    records: [
      {
        record_timestamp: new Date(NOW).toISOString(),
        fields: {
          id: 'fgc-trip-1',
          ut: 'u1',
          lin: 'S1',
          origen: 'PC',
          desti: 'TR',
          en_hora: 'True',
          geo_point_2d: [41.4, 2.15],
          dir: 'A',
          properes_parades: '{"parada": "GR"}',
        },
      },
    ],
  });
  const service = createTransitService({
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes('alerts-gtfs'))
        return new Response(encodeAlerts(ALERTS), { status: 200 });
      if (String(url).includes('trip-updates'))
        return new Response(new Uint8Array(0), { status: 200 });
      return new Response(geotren, { status: 200 });
    },
  });
  const get = (path) =>
    service.handle({ url: `http://localhost${path}`, method: 'GET' });
  try {
    const { vehicles } = await (
      await get('/api/transit/vehicles/fgc-geotren')
    ).json();
    assert.deepEqual(vehicles[0].alerts, [
      {
        header: { '': 'Últim cotxe reservat escolar' },
        effect: 'UNKNOWN_EFFECT',
      },
    ]);
    const response = await get('/api/transit/alerts/fgc-geotren');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=60');
    const body = await response.json();
    assert.equal(body.feedId, 'fgc-geotren');
    assert.equal(body.fetchedAt, NOW);
    assert.deepEqual(
      body.alerts.map((alert) => alert.id),
      ['AVISO_1', '28357'],
    );
    t.mock.timers.tick(60_000);
    await get('/api/transit/vehicles/fgc-geotren');
    await get('/api/transit/alerts/fgc-geotren');
    assert.equal(
      calls.filter((url) => url.includes('alerts-gtfs')).length,
      1,
      'one alerts request in two minutes',
    );
  } finally {
    service.close();
  }
});
