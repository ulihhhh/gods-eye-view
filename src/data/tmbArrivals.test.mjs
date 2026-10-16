import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TMB_CARD_MAX_ROUTES,
  buildTmbArrivalsCopy,
  buildTmbBusStops,
  buildTmbMetroStations,
  formatTmbClock,
  formatTmbEta,
  normalizeTmbBusArrivals,
  normalizeTmbMetroArrivals,
} from './tmbArrivals.js';

// Hand-made fixtures in the shape of TMB's answers (field names as TMB
// publishes them). Not copies of TMB data: its licence binds reuse to the
// registered application.

const point = (lon, lat) => ({ type: 'Point', coordinates: [lon, lat] });

const METRO_LINES = {
  type: 'FeatureCollection',
  features: [
    {
      geometry: point(2.17, 41.386),
      properties: {
        CODI_GRUP_ESTACIO: 6660100,
        CODI_ESTACIO: 100,
        NOM_ESTACIO: 'Plaça Exemple',
        NOM_LINIA: 'L3',
        COLOR_LINIA: '1eb53a',
        ORDRE_LINIA: 3,
        NOM_TIPUS_ESTAT: 'Operatiu',
      },
    },
    {
      geometry: point(2.172, 41.388),
      properties: {
        CODI_GRUP_ESTACIO: 6660100,
        CODI_ESTACIO: 200,
        NOM_ESTACIO: 'Plaça Exemple',
        NOM_LINIA: 'L1',
        COLOR_LINIA: 'CE1126',
        ORDRE_LINIA: 1,
        NOM_TIPUS_ESTAT: 'Operatiu',
      },
    },
    {
      geometry: point(2.1, 41.3),
      properties: {
        CODI_GRUP_ESTACIO: 6660300,
        CODI_ESTACIO: 300,
        NOM_ESTACIO: 'Futura',
        NOM_LINIA: 'L9S',
        COLOR_LINIA: 'FB712B',
        ORDRE_LINIA: 11,
        NOM_TIPUS_ESTAT: 'Planificat',
      },
    },
    {
      geometry: null,
      properties: {
        CODI_GRUP_ESTACIO: 6660400,
        CODI_ESTACIO: 400,
        NOM_ESTACIO: 'Sense punt',
        NOM_LINIA: 'L5',
      },
    },
    {
      geometry: point(2.15, 41.4),
      properties: {
        CODI_GRUP_ESTACIO: 6660500,
        CODI_ESTACIO: 500,
        NOM_ESTACIO: 'Una línia',
        NOM_LINIA: 'L5',
        COLOR_LINIA: 'not-a-colour',
      },
    },
  ],
};

test('metro stations group per-line rows into one place with every code', () => {
  const stations = buildTmbMetroStations(METRO_LINES);
  assert.deepEqual(
    stations.map((s) => s.id),
    ['6660100', '6660500'],
    'planned stations and rows without a point are dropped',
  );
  const [interchange, single] = stations;
  assert.equal(interchange.name, 'Plaça Exemple');
  assert.deepEqual(interchange.codes, [100, 200]);
  assert.deepEqual(interchange.lines, [
    { name: 'L1', color: 'CE1126' },
    { name: 'L3', color: '1EB53A' },
  ]);
  assert.equal(interchange.lat, 41.387);
  assert.equal(interchange.lon, 2.171);
  assert.deepEqual(single.lines, [{ name: 'L5', color: null }]);
  assert.equal(buildTmbMetroStations({}), null);
});

test('bus stops keep id, name and point, once each', () => {
  const stops = buildTmbBusStops({
    type: 'FeatureCollection',
    features: [
      {
        geometry: point(2.15, 41.38),
        properties: { CODI_PARADA: 1491, NOM_PARADA: 'Carrer A' },
      },
      {
        geometry: point(2.15, 41.38),
        properties: { CODI_PARADA: 1491, NOM_PARADA: 'Carrer A' },
      },
      {
        geometry: point(2.14, 41.37),
        properties: { CODI_PARADA: 108, NOM_PARADA: 'Plaça B' },
      },
      {
        geometry: point(2.14, 141.37),
        properties: { CODI_PARADA: 7, NOM_PARADA: 'Fora' },
      },
      {
        geometry: point(2.14, 41.37),
        properties: { CODI_PARADA: 'x1', NOM_PARADA: 'Codi dolent' },
      },
    ],
  });
  assert.deepEqual(stops, [
    { id: '108', name: 'Plaça B', lat: 41.37, lon: 2.14 },
    { id: '1491', name: 'Carrer A', lat: 41.38, lon: 2.15 },
  ]);
  assert.equal(buildTmbBusStops(null), null);
});

const T0 = Date.UTC(2026, 9, 13, 10, 0, 0);

const IMETRO = {
  timestamp: T0,
  linies: [
    {
      nom_linia: 'L3',
      color_linia: '1EB53A',
      estacions: [
        {
          codi_via: 2,
          codi_estacio: 100,
          linies_trajectes: [
            {
              nom_linia: 'L3',
              color_linia: '1EB53A',
              desti_trajecte: 'Sud',
              propers_trens: [
                { codi_servei: '2', temps_arribada: T0 + 400_000 },
                { codi_servei: '1', temps_arribada: T0 + 100_000 },
              ],
            },
          ],
        },
      ],
    },
    {
      nom_linia: 'L1',
      estacions: [
        {
          codi_via: 1,
          linies_trajectes: [
            {
              desti_trajecte: 'Nord',
              propers_trens: [
                { temps_arribada: T0 + 20_000 },
                { temps_arribada: 'soon' },
              ],
            },
          ],
        },
      ],
    },
  ],
};

test('iMetro answers become one sorted row per line and direction', () => {
  const normalized = normalizeTmbMetroArrivals(IMETRO);
  assert.equal(normalized.fetchedAt, T0);
  assert.deepEqual(normalized.routes, [
    {
      line: 'L1',
      color: null,
      destination: 'Nord',
      track: 1,
      arrivals: [T0 + 20_000],
    },
    {
      line: 'L3',
      color: '1EB53A',
      destination: 'Sud',
      track: 2,
      arrivals: [T0 + 100_000, T0 + 400_000],
    },
  ]);
  assert.equal(normalizeTmbMetroArrivals({ linies: 'x' }), null);
  assert.deepEqual(normalizeTmbMetroArrivals({ linies: [] }).routes, []);
});

test('iBus answers sort by the next bus and include AMB lines', () => {
  const normalized = normalizeTmbBusArrivals({
    timestamp: T0,
    parades: [
      {
        codi_parada: '108',
        nom_parada: 'Plaça B',
        linies_trajectes: [
          {
            nom_linia: 'H16',
            desti_trajecte: 'Port',
            propers_busos: [{ temps_arribada: T0 + 300_000, id_bus: 1 }],
          },
          {
            nom_linia: 'L70',
            desti_trajecte: 'Sant Boi',
            propers_busos: [{ temps_arribada: T0 + 60_000 }],
          },
          { nom_linia: 'V7', desti_trajecte: 'Nord', propers_busos: [] },
        ],
      },
    ],
  });
  assert.equal(normalized.name, 'Plaça B');
  assert.deepEqual(
    normalized.routes.map((r) => [r.line, r.arrivals.length]),
    [
      ['L70', 1],
      ['H16', 1],
      ['V7', 0],
    ],
  );
  assert.equal(normalizeTmbBusArrivals({}), null);
});

test('countdowns read now, then whole minutes, and drop departed vehicles', () => {
  assert.equal(formatTmbEta(T0 + 30_000, T0), 'now');
  assert.equal(formatTmbEta(T0 - 50_000, T0), 'now');
  assert.equal(formatTmbEta(T0 - 61_000, T0), null);
  assert.equal(formatTmbEta(T0 + 50_000, T0), '1 min');
  assert.equal(formatTmbEta(T0 + 6.4 * 60_000, T0), '6 min');
  assert.equal(formatTmbClock(T0), '12:00', 'Barcelona time, CEST in October');
});

test('the card names the place, lists arrivals and cites TMB with the time', () => {
  const place = {
    id: '6660100',
    name: 'Plaça Exemple',
    lines: [{ name: 'L1' }, { name: 'L3' }],
  };
  const copy = buildTmbArrivalsCopy({
    kind: 'metro',
    place,
    arrivals: normalizeTmbMetroArrivals(IMETRO),
    now: T0,
  });
  assert.deepEqual(copy, {
    title: '🚇 Plaça Exemple',
    details: [
      'Metro station · TMB · L1 L3',
      'L1 → Nord · now',
      'L3 → Sud · 2 min, 7 min',
      'Source: TMB iMetro · 12:00',
    ],
  });
});

test('the card says what it is waiting for, and keeps the last answer on error', () => {
  const place = { id: '108', name: 'Plaça B' };
  assert.deepEqual(
    buildTmbArrivalsCopy({ kind: 'bus', place, status: 'loading', now: T0 })
      .details,
    ['Bus stop 108 · TMB', 'Asking TMB for the next arrivals…'],
  );
  assert.deepEqual(
    buildTmbArrivalsCopy({
      kind: 'bus',
      place,
      status: 'error',
      error: 'TMB unavailable',
      now: T0,
    }).details,
    ['Bus stop 108 · TMB', 'TMB unavailable'],
  );
  const kept = buildTmbArrivalsCopy({
    kind: 'bus',
    place,
    arrivals: { fetchedAt: T0, routes: [] },
    status: 'error',
    error: 'TMB unavailable',
    now: T0,
  }).details;
  assert.deepEqual(kept, [
    'Bus stop 108 · TMB',
    'No arrivals reported right now',
    'TMB unavailable · showing last answer',
    'Source: TMB iBus · 12:00',
  ]);
});

test('a busy stop folds the rest of its lines into "+N more"', () => {
  const routes = Array.from({ length: TMB_CARD_MAX_ROUTES + 3 }, (_, i) => ({
    line: `V${i}`,
    destination: '',
    arrivals: [T0 + (i + 2) * 60_000],
  }));
  const { details } = buildTmbArrivalsCopy({
    kind: 'bus',
    place: { id: '1', name: 'Parada' },
    arrivals: { fetchedAt: T0, routes },
    now: T0,
  });
  assert.equal(details.length, 1 + TMB_CARD_MAX_ROUTES + 2);
  assert.equal(details.at(-2), '+3 more');
  assert.equal(details[1], 'V0 · 2 min');
});

test('the card lists the place’s alerts above its arrivals, two at most', () => {
  const copy = buildTmbArrivalsCopy({
    kind: 'metro',
    place: { id: '6660100', name: 'Plaça Exemple', lines: [{ name: 'L1' }] },
    arrivals: {
      ...normalizeTmbMetroArrivals(IMETRO),
      alerts: [
        { header: { ca: 'Accés tancat', es: 'Acceso cerrado' } },
        { header: { en: 'Lift out of service' } },
        { header: { ca: 'Tercer avís' } },
      ],
    },
    now: T0,
  });
  assert.deepEqual(copy.details.slice(0, 4), [
    'Metro station · TMB · L1',
    '⚠ Acceso cerrado',
    '⚠ Lift out of service',
    '+1 more alert',
  ]);
});
