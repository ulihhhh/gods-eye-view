import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AEMET_STATIONS_ENVELOPE_URL,
  AEMET_STATION_STALE_MS,
  aemetStationsEnvelopeUrl,
  filterFreshAemetStations,
  normalizeAemetStationRecord,
  normalizeAemetStationsSnapshot,
} from './weatherProviderRequests.js';

test('the envelope URL embeds the key as a query param, never a path segment', () => {
  assert.equal(
    aemetStationsEnvelopeUrl('abc.def.ghi'),
    `${AEMET_STATIONS_ENVELOPE_URL}?api_key=abc.def.ghi`,
  );
  // AEMET keys are JWTs and contain '.', which encodeURIComponent leaves
  // alone — but a key with genuinely unsafe characters must still round-trip.
  assert.equal(
    aemetStationsEnvelopeUrl('has space&amp'),
    `${AEMET_STATIONS_ENVELOPE_URL}?api_key=has%20space%26amp`,
  );
});

// A trimmed real record from the live API (2026-09-12), confirming the exact
// field names this module reads.
const REAL_RECORD_FIXTURE = Object.freeze({
  idema: '0002I',
  lon: 0.871385,
  fint: '2026-09-11T21:00:00+0000',
  prec: 0,
  alt: 32,
  vmax: 3.9,
  vv: 1.1,
  dv: 202,
  lat: 40.95806,
  dmax: 230,
  ubi: 'VANDELLÓS',
  pres: 1017.4,
  hr: 74,
  stdvv: 0.4,
  pres_nmar: 1021.1,
  tamin: 24,
  ta: 24,
  tamax: 24.6,
  tpr: 19.1,
  stddv: 24,
});

test('normalizes a real station record into the flat shape the frontend renders', () => {
  const record = normalizeAemetStationRecord(REAL_RECORD_FIXTURE);
  assert.deepEqual(record, {
    id: '0002I',
    name: 'VANDELLÓS',
    lat: 40.95806,
    lon: 0.871385,
    altitudeM: 32,
    observedAtMs: Date.parse('2026-09-11T21:00:00+0000'),
    temperatureC: 24,
    humidityPct: 74,
    pressureHpa: 1017.4,
    windSpeedMs: 1.1,
    windDirectionDeg: 202,
    windGustMs: 3.9,
    precipitationMm: 0,
  });
});

test('a station missing id/lat/lon cannot be placed on a map and is skipped, not fabricated', () => {
  assert.equal(normalizeAemetStationRecord({ ...REAL_RECORD_FIXTURE, idema: '' }), null);
  assert.equal(normalizeAemetStationRecord({ ...REAL_RECORD_FIXTURE, lat: null }), null);
  assert.equal(normalizeAemetStationRecord({ ...REAL_RECORD_FIXTURE, lon: 'not-a-number' }), null);
  assert.equal(normalizeAemetStationRecord({ ...REAL_RECORD_FIXTURE, lat: 91 }), null, 'out-of-range latitude');
});

test('a station with a dead sensor keeps its place, with that one field null', () => {
  const { ta: _ta, ...noTemperature } = REAL_RECORD_FIXTURE;
  const record = normalizeAemetStationRecord(noTemperature);
  assert.equal(record.id, '0002I');
  assert.equal(record.temperatureC, null);
});

test('an unparsable name/timestamp degrades to null rather than throwing', () => {
  const record = normalizeAemetStationRecord({ ...REAL_RECORD_FIXTURE, ubi: '', fint: 'not-a-date' });
  assert.equal(record.name, null);
  assert.equal(record.observedAtMs, null);
});

test('snapshot dedup keeps the most recent of several trailing hourly rows per station', () => {
  const older = { ...REAL_RECORD_FIXTURE, fint: '2026-09-11T19:00:00+0000', ta: 20 };
  const newer = { ...REAL_RECORD_FIXTURE, fint: '2026-09-11T21:00:00+0000', ta: 24 };
  const otherStation = { ...REAL_RECORD_FIXTURE, idema: '9999X', ubi: 'OTHER', fint: '2026-09-11T20:00:00+0000' };
  const snapshot = normalizeAemetStationsSnapshot([older, newer, otherStation]);
  assert.equal(snapshot.length, 2);
  const vandellos = snapshot.find((s) => s.id === '0002I');
  assert.equal(vandellos.temperatureC, 24, 'the 21:00 row wins over the 19:00 row');
});

test('a station whose only rows have unparsable timestamps never wins the dedup over a real one', () => {
  const garbled = { ...REAL_RECORD_FIXTURE, fint: 'garbage', ta: 999 };
  const real = { ...REAL_RECORD_FIXTURE, fint: '2026-09-11T21:00:00+0000', ta: 24 };
  assert.equal(normalizeAemetStationsSnapshot([garbled, real])[0].temperatureC, 24);
  assert.equal(normalizeAemetStationsSnapshot([real, garbled])[0].temperatureC, 24, 'order must not matter');
});

test('snapshot normalization never throws on a malformed batch, and skips only the bad rows', () => {
  assert.deepEqual(normalizeAemetStationsSnapshot(null), []);
  assert.deepEqual(normalizeAemetStationsSnapshot(undefined), []);
  assert.deepEqual(normalizeAemetStationsSnapshot('not-an-array'), []);
  const mixed = normalizeAemetStationsSnapshot([REAL_RECORD_FIXTURE, { idema: '' }, null, 42]);
  assert.equal(mixed.length, 1);
});

test('freshness filter drops a station whose latest reading is older than the stale threshold', () => {
  const now = Date.parse('2026-09-12T00:00:00+0000');
  const fresh = { id: 'A', observedAtMs: now - 30 * 60_000 };
  const justStale = { id: 'B', observedAtMs: now - AEMET_STATION_STALE_MS - 1 };
  const noTimestamp = { id: 'C', observedAtMs: null };
  const result = filterFreshAemetStations([fresh, justStale, noTimestamp], now);
  assert.deepEqual(result.map((s) => s.id), ['A']);
});

test('freshness filter tolerates non-array input the same way the normalizer does', () => {
  assert.deepEqual(filterFreshAemetStations(null), []);
  assert.deepEqual(filterFreshAemetStations(undefined), []);
});
