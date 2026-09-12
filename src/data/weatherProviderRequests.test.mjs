import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AEMET_LIGHTNING_ENVELOPE_URL,
  AEMET_STATIONS_ENVELOPE_URL,
  AEMET_STATION_STALE_MS,
  AEMET_WARNINGS_ENVELOPE_URL,
  AEMET_WARNING_LEVEL_RANK,
  aemetLightningEnvelopeUrl,
  aemetMunicipioForecastEnvelopeUrl,
  aemetMunicipiosEnvelopeUrl,
  aemetStationsEnvelopeUrl,
  aemetWarningsEnvelopeUrl,
  filterActiveAemetWarnings,
  filterFreshAemetStations,
  filterUpcomingAemetForecastHours,
  findNearestAemetMunicipio,
  haversineDistanceKm,
  madridCivilNow,
  normalizeAemetHourlyForecast,
  normalizeAemetMunicipioRecord,
  normalizeAemetMunicipiosSnapshot,
  normalizeAemetStationRecord,
  normalizeAemetStationsSnapshot,
  normalizeAemetWarningsSnapshot,
  parseAemetCapAlert,
  parseAemetCapTar,
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
    temperatureMinC: 24,
    temperatureMaxC: 24.6,
    dewPointC: 19.1,
    humidityPct: 74,
    pressureHpa: 1017.4,
    pressureSeaLevelHpa: 1021.1,
    windSpeedMs: 1.1,
    windDirectionDeg: 202,
    windDirectionStdDevDeg: 24,
    windSpeedStdDevMs: 0.4,
    windGustMs: 3.9,
    windGustDirectionDeg: 230,
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

// ---------------------------------------------------------------------------
// Avisos (warnings)
// ---------------------------------------------------------------------------

test('the warnings envelope URL embeds the key as a query param, never a path segment', () => {
  assert.equal(
    aemetWarningsEnvelopeUrl('abc.def.ghi'),
    `${AEMET_WARNINGS_ENVELOPE_URL}?api_key=abc.def.ghi`,
  );
});

/** Build a minimal (uncompressed) POSIX tar buffer from {name, content} entries, for testing the reader. */
function buildTestTar(files) {
  const BLOCK = 512;
  const chunks = [];
  for (const { name, content } of files) {
    const header = Buffer.alloc(BLOCK);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'utf8'); // mode
    header.write('0000000\0', 108, 8, 'utf8'); // uid
    header.write('0000000\0', 116, 8, 'utf8'); // gid
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8'); // size, octal
    header.write('00000000000\0', 136, 12, 'utf8'); // mtime
    header.write('        ', 148, 8, 'utf8'); // checksum placeholder (unvalidated by the reader)
    header[156] = '0'.charCodeAt(0); // typeflag: regular file
    header.write('ustar\0', 257, 6, 'utf8'); // magic
    header.write('00', 263, 2, 'utf8'); // version
    chunks.push(header);
    const body = Buffer.from(content, 'utf8');
    chunks.push(body);
    const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(BLOCK * 2)); // end-of-archive marker
  return Buffer.concat(chunks);
}

test('tar reader extracts regular files with correct names and content', () => {
  const tar = buildTestTar([
    { name: 'a.xml', content: '<alert>one</alert>' },
    { name: 'b.xml', content: '<alert>two</alert>'.repeat(200) }, // spans multiple 512-byte blocks
  ]);
  const entries = parseAemetCapTar(tar);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'a.xml');
  assert.equal(entries[0].content.toString('utf8'), '<alert>one</alert>');
  assert.equal(entries[1].content.toString('utf8'), '<alert>two</alert>'.repeat(200));
});

test('tar reader stops cleanly at the end-of-archive marker rather than reading past it', () => {
  const tar = buildTestTar([{ name: 'only.xml', content: 'x' }]);
  assert.equal(parseAemetCapTar(tar).length, 1);
});

test('tar reader degrades gracefully on truncated/malformed input instead of throwing', () => {
  assert.deepEqual(parseAemetCapTar(Buffer.alloc(0)), []);
  assert.deepEqual(parseAemetCapTar(Buffer.alloc(100)), []); // shorter than one header block
  const tar = buildTestTar([{ name: 'a.xml', content: 'hello world' }]);
  const truncated = tar.subarray(0, 600); // header + partial body, no end marker
  assert.doesNotThrow(() => parseAemetCapTar(truncated));
});

// A real alert pulled from the live API (2026-09-12) — Lanzarote, a
// temperature warning, TWO disjoint polygon rings under one zone (Lanzarote
// + La Graciosa), confirming multi-polygon zones parse correctly. Paired
// es-ES/en-GB `<info>` blocks are exactly what AEMET always ships.
const LANZAROTE_ALERT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns = "urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>2.49.0.0.724.0.ES.20260912093213.659101ATTA14181789205533</identifier>
  <sender>http://www.aemet.es</sender>
  <sent>2026-09-12T09:32:13-00:00</sent>
  <status>Actual</status>
  <msgType>Alert</msgType>
  <scope>Public</scope>
  <info>
    <language>es-ES</language>
    <category>Met</category>
    <event>Aviso de temperaturas máximas de nivel amarillo</event>
    <responseType>Monitor</responseType>
    <urgency>Future</urgency>
    <severity>Moderate</severity>
    <certainty>Likely</certainty>
    <eventCode>
      <valueName>AEMET-Meteoalerta fenomeno</valueName>
      <value>AT;Temperaturas máximas</value>
    </eventCode>
    <effective>2026-09-12T10:32:13+01:00</effective>
    <onset>2026-09-14T11:00:00+01:00</onset>
    <expires>2026-09-14T18:59:59+01:00</expires>
    <senderName>AEMET. Agencia Estatal de Meteorología</senderName>
    <headline>Aviso de temperaturas máximas de nivel amarillo. Lanzarote</headline>
    <description>Temperatura máxima: 34 ºC. Afectando principalmente en zonas de interior.</description>
    <instruction>Esté atento. Manténgase informado de la predicción meteorológica más actualizada.</instruction>
    <web>https://www.aemet.es/es/eltiempo/prediccion/avisos</web>
    <contact>AEMET</contact>
    <parameter>
      <valueName>AEMET-Meteoalerta nivel</valueName>
      <value>amarillo</value>
    </parameter>
    <parameter>
      <valueName>AEMET-Meteoalerta parametro</valueName>
      <value>TA;Temperatura máxima;34 ºC</value>
    </parameter>
    <parameter>
      <valueName>AEMET-Meteoalerta probabilidad</valueName>
      <value>40%-70%</value>
    </parameter>
    <area>
      <areaDesc>Lanzarote</areaDesc>
      <polygon>28.85,-13.87 28.89,-13.88 28.89,-13.86 28.85,-13.87</polygon>
      <polygon>29.22,-13.53 29.27,-13.52 29.28,-13.48 29.23,-13.5 29.22,-13.53</polygon>
      <geocode>
        <valueName>AEMET-Meteoalerta zona</valueName>
        <value>659101</value>
      </geocode>
    </area>
  </info>
  <info>
    <language>en-GB</language>
    <category>Met</category>
    <event>Moderate high-temperature warning</event>
    <responseType>Monitor</responseType>
    <urgency>Future</urgency>
    <severity>Moderate</severity>
    <certainty>Likely</certainty>
    <eventCode>
      <valueName>AEMET-Meteoalerta fenomeno</valueName>
      <value>AT;Temperaturas máximas</value>
    </eventCode>
    <effective>2026-09-12T10:32:13+01:00</effective>
    <onset>2026-09-14T11:00:00+01:00</onset>
    <expires>2026-09-14T18:59:59+01:00</expires>
    <senderName>AEMET. State Meteorological Agency</senderName>
    <headline>Moderate high-temperature warning. Lanzarote</headline>
    <description>Maximum temperature: 34 ºC.</description>
    <instruction>Be aware, keep up to date with the latest weather forecast.</instruction>
    <web>https://www.aemet.es/en/eltiempo/prediccion/avisos</web>
    <contact>AEMET</contact>
    <parameter>
      <valueName>AEMET-Meteoalerta nivel</valueName>
      <value>amarillo</value>
    </parameter>
    <area>
      <areaDesc>Lanzarote</areaDesc>
      <polygon>28.85,-13.87 28.89,-13.88 28.89,-13.86 28.85,-13.87</polygon>
      <geocode>
        <valueName>AEMET-Meteoalerta zona</valueName>
        <value>659101</value>
      </geocode>
    </area>
  </info>
</alert>
`;

test('parses a real alert: es-ES chosen over en-GB, both polygon rings, every field', () => {
  const alert = parseAemetCapAlert(LANZAROTE_ALERT_XML);
  assert.equal(alert.event, 'Aviso de temperaturas máximas de nivel amarillo');
  assert.equal(alert.level, 'amarillo');
  assert.equal(alert.severity, 'Moderate');
  assert.equal(alert.phenomenonCode, 'AT');
  assert.equal(alert.phenomenonName, 'Temperaturas máximas');
  assert.equal(alert.probability, '40%-70%');
  assert.equal(alert.onsetMs, Date.parse('2026-09-14T11:00:00+01:00'));
  assert.equal(alert.expiresMs, Date.parse('2026-09-14T18:59:59+01:00'));
  assert.match(alert.description, /34 ºC/);
  assert.match(alert.instruction, /Esté atento/);
  assert.equal(alert.areas.length, 1);
  const [area] = alert.areas;
  assert.equal(area.geocode, '659101');
  assert.equal(area.name, 'Lanzarote');
  assert.equal(area.polygons.length, 2, 'Lanzarote + La Graciosa as two disjoint rings');
  assert.deepEqual(area.polygons[0][0], [28.85, -13.87]);
  assert.equal(area.polygons[0].length, 4);
  assert.equal(area.polygons[1].length, 5);
});

test('an alert with no es-ES info, no phenomenon, or no usable area is skipped, not fabricated', () => {
  assert.equal(parseAemetCapAlert(''), null);
  assert.equal(parseAemetCapAlert('<alert><info><language>en-GB</language><event>x</event></info></alert>'), null);
  assert.equal(
    parseAemetCapAlert('<alert><info><language>es-ES</language></info></alert>'),
    null,
    'no <event> at all',
  );
  assert.equal(
    parseAemetCapAlert(
      '<alert><info><language>es-ES</language><event>x</event><area><areaDesc>Z</areaDesc></area></info></alert>',
    ),
    null,
    'area with no polygon',
  );
  assert.equal(
    parseAemetCapAlert(
      '<alert><info><language>es-ES</language><event>x</event>'
      + '<area><areaDesc>Z</areaDesc><polygon>1,1 2,2</polygon><geocode><valueName>AEMET-Meteoalerta zona</valueName><value>1</value></geocode></area>'
      + '</info></alert>',
    ),
    null,
    'a polygon with fewer than 3 points cannot enclose anything',
  );
});

test('XML entities in free-text fields decode correctly', () => {
  const alert = parseAemetCapAlert(
    '<alert><info><language>es-ES</language><event>Aviso &amp; tal</event>'
    + '<description>Riesgo &lt;alto&gt; &quot;hoy&quot;</description>'
    + '<area><areaDesc>Z</areaDesc><polygon>1,1 2,2 3,3</polygon>'
    + '<geocode><valueName>AEMET-Meteoalerta zona</valueName><value>1</value></geocode></area>'
    + '</info></alert>',
  );
  assert.equal(alert.event, 'Aviso & tal');
  assert.equal(alert.description, 'Riesgo <alto> "hoy"');
});

// A trimmed real "verde" bulletin shape: ONE phenomenon+level bundles MANY
// zones nationwide (most of the country reports no risk most of the time).
function verdeAlertFixture(zones) {
  const areas = zones
    .map(({ geocode, name }) => `
    <area>
      <areaDesc>${name}</areaDesc>
      <polygon>1,1 2,2 3,3</polygon>
      <geocode><valueName>AEMET-Meteoalerta zona</valueName><value>${geocode}</value></geocode>
    </area>`)
    .join('');
  return `<alert><info>
    <language>es-ES</language>
    <event>Aviso de temperaturas máximas de nivel verde</event>
    <eventCode><valueName>AEMET-Meteoalerta fenomeno</valueName><value>AT;Temperaturas máximas</value></eventCode>
    <onset>2026-09-12T00:00:00+00:00</onset>
    <expires>2099-01-01T00:00:00+00:00</expires>
    <parameter><valueName>AEMET-Meteoalerta nivel</valueName><value>verde</value></parameter>
    ${areas}
  </info></alert>`;
}

test('a bulletin bundling many zones under one phenomenon parses every area', () => {
  const alert = parseAemetCapAlert(verdeAlertFixture([
    { geocode: '610401', name: 'Zone A' },
    { geocode: '610402', name: 'Zone B' },
    { geocode: '610403', name: 'Zone C' },
  ]));
  assert.equal(alert.level, 'verde');
  assert.equal(alert.areas.length, 3);
  assert.deepEqual(alert.areas.map((a) => a.geocode), ['610401', '610402', '610403']);
});

test('snapshot aggregation merges a zone appearing in several alerts into one record with every phenomenon', () => {
  const windAlert = parseAemetCapAlert(
    '<alert><info><language>es-ES</language><event>Aviso de vientos de nivel amarillo</event>'
    + '<eventCode><valueName>AEMET-Meteoalerta fenomeno</valueName><value>VI;Vientos</value></eventCode>'
    + '<onset>2026-09-12T00:00:00+00:00</onset><expires>2099-01-01T00:00:00+00:00</expires>'
    + '<parameter><valueName>AEMET-Meteoalerta nivel</valueName><value>amarillo</value></parameter>'
    + '<area><areaDesc>Same Zone</areaDesc><polygon>1,1 2,2 3,3</polygon>'
    + '<geocode><valueName>AEMET-Meteoalerta zona</valueName><value>999999</value></geocode></area>'
    + '</info></alert>',
  );
  const coastalAlert = parseAemetCapAlert(
    '<alert><info><language>es-ES</language><event>Aviso costero de nivel naranja</event>'
    + '<eventCode><valueName>AEMET-Meteoalerta fenomeno</valueName><value>CO;Costeros</value></eventCode>'
    + '<onset>2026-09-12T00:00:00+00:00</onset><expires>2099-01-01T00:00:00+00:00</expires>'
    + '<parameter><valueName>AEMET-Meteoalerta nivel</valueName><value>naranja</value></parameter>'
    + '<area><areaDesc>Same Zone</areaDesc><polygon>1,1 2,2 3,3</polygon>'
    + '<geocode><valueName>AEMET-Meteoalerta zona</valueName><value>999999</value></geocode></area>'
    + '</info></alert>',
  );
  const zones = normalizeAemetWarningsSnapshot([windAlert, coastalAlert]);
  assert.equal(zones.length, 1, 'one zone, not two — merged by geocode');
  assert.equal(zones[0].geocode, '999999');
  assert.equal(zones[0].phenomena.length, 2);
  assert.deepEqual(zones[0].phenomena.map((p) => p.code), ['VI', 'CO']);
});

test('normalization tolerates non-array/malformed input the same way the stations normalizer does', () => {
  assert.deepEqual(normalizeAemetWarningsSnapshot(null), []);
  assert.deepEqual(normalizeAemetWarningsSnapshot(undefined), []);
  assert.deepEqual(normalizeAemetWarningsSnapshot([null, undefined]), []);
});

test('level rank: verde is 0 (not a warning), ranks strictly increase to rojo', () => {
  assert.deepEqual(AEMET_WARNING_LEVEL_RANK, { verde: 0, amarillo: 1, naranja: 2, rojo: 3 });
});

test('active-warnings filter drops verde and expired phenomena, keeps a zone only if something real remains', () => {
  const now = Date.parse('2026-09-12T12:00:00+00:00');
  const zones = [
    {
      geocode: 'A', name: 'All verde', polygons: [[[1, 1], [2, 2], [3, 3]]],
      phenomena: [{ code: 'AT', level: 'verde', expiresMs: now + 86_400_000, onsetMs: now - 1000 }],
    },
    {
      geocode: 'B', name: 'Expired amarillo', polygons: [[[1, 1], [2, 2], [3, 3]]],
      phenomena: [{ code: 'VI', level: 'amarillo', expiresMs: now - 1000, onsetMs: now - 86_400_000 }],
    },
    {
      geocode: 'C', name: 'Live amarillo + naranja', polygons: [[[1, 1], [2, 2], [3, 3]]],
      phenomena: [
        { code: 'VI', level: 'amarillo', expiresMs: now + 3600_000, onsetMs: now - 1000, event: 'Wind' },
        { code: 'CO', level: 'naranja', expiresMs: now + 3600_000, onsetMs: now + 1000, event: 'Coastal' },
      ],
    },
    {
      geocode: 'D', name: 'No expiry recorded', polygons: [[[1, 1], [2, 2], [3, 3]]],
      phenomena: [{ code: 'PR', level: 'rojo', expiresMs: null, onsetMs: now - 1000 }],
    },
  ];
  const active = filterActiveAemetWarnings(zones, now);
  assert.deepEqual(active.map((z) => z.geocode), ['C'], 'only the zone with a live non-verde phenomenon survives');
  const zoneC = active[0];
  assert.equal(zoneC.level, 'naranja', 'zone level is its HIGHEST active phenomenon');
  assert.equal(zoneC.levelRank, 2);
  assert.equal(zoneC.phenomena.length, 2, 'both phenomena kept, not just the highest');
  const wind = zoneC.phenomena.find((p) => p.code === 'VI');
  const coastal = zoneC.phenomena.find((p) => p.code === 'CO');
  assert.equal(wind.inEffect, true, 'onset already passed');
  assert.equal(coastal.inEffect, false, 'onset still in the future');
});

test('active-warnings filter tolerates non-array input', () => {
  assert.deepEqual(filterActiveAemetWarnings(null), []);
  assert.deepEqual(filterActiveAemetWarnings(undefined), []);
});

// ---------------------------------------------------------------------------
// Phase A2 — municipio forecast. Fixtures below are trimmed real shapes
// captured from a live pull against `maestro/municipios` and
// `prediccion/especifica/municipio/horaria/28079` (Madrid), the same
// "real fixture, not synthetic" discipline used for the stations/warnings
// tests above.
// ---------------------------------------------------------------------------

const REAL_MADRID_MUNICIPIO = Object.freeze({
  latitud: '40º24\'30.282876"',
  id_old: '28001',
  url: 'madrid-id28079',
  latitud_dec: '40.40841191',
  altitud: '657',
  capital: 'Madrid',
  num_hab: '3165235',
  zona_comarcal: '722802',
  destacada: '1',
  nombre: 'Madrid',
  longitud_dec: '-3.68760088',
  id: 'id28079',
  longitud: '-3º41\'15.363168"',
});

test('municipio/forecast envelope URLs embed the key as a query param', () => {
  assert.ok(aemetMunicipiosEnvelopeUrl('K').endsWith('?api_key=K'));
  assert.ok(aemetMunicipiosEnvelopeUrl('K').startsWith('https://opendata.aemet.es/opendata/api/maestro/municipios'));
  const forecastUrl = aemetMunicipioForecastEnvelopeUrl('K', '28079');
  assert.ok(forecastUrl.includes('/municipio/horaria/28079?'), 'municipio id is a path segment, key is a query param');
  assert.ok(forecastUrl.endsWith('api_key=K'));
});

test('normalizeAemetMunicipioRecord extracts the INE code from AEMET\'s "id" field, not "id_old"', () => {
  const record = normalizeAemetMunicipioRecord(REAL_MADRID_MUNICIPIO);
  // "28079" (from id: "id28079") is the value the live forecast endpoint
  // actually accepted; "28001" (id_old) is a different, legacy code that a
  // live pull confirmed the forecast endpoint rejects.
  assert.equal(record.id, '28079');
  assert.equal(record.name, 'Madrid');
  assert.ok(Math.abs(record.lat - 40.40841191) < 1e-6);
  assert.ok(Math.abs(record.lon - -3.68760088) < 1e-6);
  assert.equal(record.altitudeM, 657);
  assert.equal(record.populationCount, 3165235);
});

test('normalizeAemetMunicipioRecord rejects a record with no usable id or coordinates', () => {
  assert.equal(normalizeAemetMunicipioRecord({ ...REAL_MADRID_MUNICIPIO, id: '28079' }), null, 'missing "id..." prefix');
  assert.equal(normalizeAemetMunicipioRecord({ ...REAL_MADRID_MUNICIPIO, latitud_dec: 'not-a-number' }), null);
  assert.equal(normalizeAemetMunicipioRecord({ ...REAL_MADRID_MUNICIPIO, nombre: '', capital: '' }), null, 'no usable name');
  assert.equal(normalizeAemetMunicipioRecord(null), null);
});

test('normalizeAemetMunicipiosSnapshot drops invalid rows without dropping the batch', () => {
  const rows = normalizeAemetMunicipiosSnapshot([REAL_MADRID_MUNICIPIO, { id: 'garbage' }, null]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, '28079');
  assert.deepEqual(normalizeAemetMunicipiosSnapshot(null), []);
});

test('haversineDistanceKm is zero for identical points and roughly right for a known pair', () => {
  assert.equal(haversineDistanceKm(40.4, -3.7, 40.4, -3.7), 0);
  // Madrid to Barcelona is ~500 km great-circle.
  const distance = haversineDistanceKm(40.4168, -3.7038, 41.3874, 2.1686);
  assert.ok(distance > 480 && distance < 520, `expected ~500km, got ${distance}`);
});

test('findNearestAemetMunicipio picks the closest candidate by great-circle distance', () => {
  const madrid = { id: '28079', name: 'Madrid', lat: 40.4168, lon: -3.7038 };
  const barcelona = { id: '08019', name: 'Barcelona', lat: 41.3874, lon: 2.1686 };
  const result = findNearestAemetMunicipio([madrid, barcelona], 40.42, -3.70);
  assert.equal(result.municipio.id, '28079');
  assert.ok(result.distanceKm < 5);
});

test('findNearestAemetMunicipio tolerates an empty list or bad coordinates', () => {
  assert.equal(findNearestAemetMunicipio([], 40, -3), null);
  assert.equal(findNearestAemetMunicipio([{ id: '1', lat: 0, lon: 0 }], NaN, -3), null);
});

/** Trimmed from a real `prediccion/especifica/municipio/horaria/28079` pull (Madrid, one day). */
const REAL_HOURLY_FORECAST_DAY = Object.freeze({
  fecha: '2026-09-12T00:00:00',
  estadoCielo: [
    { value: '12', periodo: '08', descripcion: 'Poco nuboso' },
    { value: '11', periodo: '09', descripcion: 'Despejado' },
  ],
  precipitacion: [
    { value: '0', periodo: '08' },
    { value: '0', periodo: '09' },
  ],
  temperatura: [
    { value: '18', periodo: '08' },
    { value: '20', periodo: '09' },
  ],
  vientoAndRachaMax: [
    { direccion: ['NE'], velocidad: ['12'], periodo: '08' },
    { value: '22', periodo: '08' }, // gust entry — no `direccion`, must be ignored
    { direccion: ['NE'], velocidad: ['13'], periodo: '09' },
    { value: '22', periodo: '09' },
  ],
});

const REAL_HOURLY_FORECAST_RESPONSE = Object.freeze([{
  origen: {},
  elaborado: '2026-09-12T14:25:12',
  nombre: 'Madrid',
  provincia: 'Madrid',
  prediccion: { dia: [REAL_HOURLY_FORECAST_DAY] },
  id: '28079',
  version: '1.0',
}]);

test('normalizeAemetHourlyForecast assembles one record per hour from four periodo-keyed arrays', () => {
  const forecast = normalizeAemetHourlyForecast(REAL_HOURLY_FORECAST_RESPONSE);
  assert.equal(forecast.municipioId, '28079');
  assert.equal(forecast.name, 'Madrid');
  assert.equal(forecast.province, 'Madrid');
  assert.equal(forecast.elaborated, '2026-09-12T14:25:12');
  assert.equal(forecast.hours.length, 2);
  const [h08, h09] = forecast.hours;
  assert.deepEqual(h08, {
    dateIso: '2026-09-12',
    hour: 8,
    temperatureC: 18,
    skyDescription: 'Poco nuboso',
    precipitationMm: 0,
    windSpeedKmh: 12,
    windDirection: 'NE',
  });
  assert.equal(h09.temperatureC, 20);
  assert.equal(h09.windSpeedKmh, 13, 'the gust-only entry at the same periodo must not override the wind entry');
});

test('normalizeAemetHourlyForecast keeps hours in chronological order across day boundaries', () => {
  const dayTwo = {
    ...REAL_HOURLY_FORECAST_DAY,
    fecha: '2026-09-13T00:00:00',
    temperatura: [{ value: '15', periodo: '00' }],
    estadoCielo: [], precipitacion: [], vientoAndRachaMax: [],
  };
  const forecast = normalizeAemetHourlyForecast([{
    ...REAL_HOURLY_FORECAST_RESPONSE[0],
    prediccion: { dia: [dayTwo, REAL_HOURLY_FORECAST_DAY] }, // deliberately out of order
  }]);
  assert.deepEqual(forecast.hours.map((h) => `${h.dateIso}T${h.hour}`), [
    '2026-09-12T8', '2026-09-12T9', '2026-09-13T0',
  ]);
});

test('normalizeAemetHourlyForecast drops the "24" (next-midnight) periodo rather than misreading it as hour 24', () => {
  const day = { ...REAL_HOURLY_FORECAST_DAY, temperatura: [{ value: '10', periodo: '24' }], estadoCielo: [], precipitacion: [], vientoAndRachaMax: [] };
  const forecast = normalizeAemetHourlyForecast([{ ...REAL_HOURLY_FORECAST_RESPONSE[0], prediccion: { dia: [day] } }]);
  assert.deepEqual(forecast.hours, []);
});

test('normalizeAemetHourlyForecast returns null for a malformed/empty response', () => {
  assert.equal(normalizeAemetHourlyForecast([]), null);
  assert.equal(normalizeAemetHourlyForecast([{ prediccion: {} }]), null);
  assert.equal(normalizeAemetHourlyForecast(null), null);
});

test('madridCivilNow reads Europe/Madrid civil time, not the process timezone, across both DST states', () => {
  // 2026-07-01T10:00:00Z is CEST (+2) → 12:00 local.
  assert.deepEqual(madridCivilNow(Date.parse('2026-07-01T10:00:00Z')), { dateIso: '2026-07-01', hour: 12 });
  // 2026-01-01T10:00:00Z is CET (+1) → 11:00 local.
  assert.deepEqual(madridCivilNow(Date.parse('2026-01-01T10:00:00Z')), { dateIso: '2026-01-01', hour: 11 });
  // Just before midnight UTC in winter (+1) rolls into the next Madrid day.
  assert.deepEqual(madridCivilNow(Date.parse('2026-01-01T23:30:00Z')), { dateIso: '2026-01-02', hour: 0 });
});

test('filterUpcomingAemetForecastHours drops the past and caps the result', () => {
  const hours = [
    { dateIso: '2026-09-12', hour: 8, temperatureC: 18 },
    { dateIso: '2026-09-12', hour: 9, temperatureC: 20 },
    { dateIso: '2026-09-12', hour: 10, temperatureC: 21 },
    { dateIso: '2026-09-13', hour: 0, temperatureC: 15 },
  ];
  const upcoming = filterUpcomingAemetForecastHours(hours, { dateIso: '2026-09-12', hour: 9 }, 2);
  assert.deepEqual(upcoming.map((h) => h.hour), [9, 10], 'hour 8 is in the past; capped to 2 results');
});

test('filterUpcomingAemetForecastHours tolerates non-array input', () => {
  assert.deepEqual(filterUpcomingAemetForecastHours(null, { dateIso: '2026-09-12', hour: 0 }), []);
});

test('the lightning envelope URL embeds the key as a query param, matching every other AEMET envelope', () => {
  assert.equal(
    aemetLightningEnvelopeUrl('K'),
    `${AEMET_LIGHTNING_ENVELOPE_URL}?api_key=K`,
  );
  assert.ok(!aemetLightningEnvelopeUrl('K').includes('K/'), 'the key is never a path segment');
});
