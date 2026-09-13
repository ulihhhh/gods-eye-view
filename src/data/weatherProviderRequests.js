/**
 * Portable AEMET OpenData request/response mechanics — pure, no Node imports,
 * no fetch. Shared by the server-side proxy (server/providers/weather/aemet.js)
 * and its tests, mirroring how src/data/spaceProviderRequests.js and
 * src/data/firmsCsv.js split "how to talk to the upstream" from "how to run
 * the proxy" for CelesTrak and FIRMS.
 *
 * AEMET's own API answers every request with an envelope —
 * {descripcion, estado, datos, metadatos} — where `datos` is a SECOND url
 * holding the real payload; a caller fetches that once `estado === 200`.
 * That two-step indirection, and the ISO-8859-15 encoding of the second
 * response (confirmed against the live API — UTF-8-decoding it mangles
 * accented station names, e.g. "VANDELL�S" instead of "VANDELLÓS"), are
 * upstream quirks this proxy layer exists to hide from the browser; the
 * client only ever sees a flat, UTF-8 JSON array.
 */

/** All-stations current-conditions envelope. */
export const AEMET_STATIONS_ENVELOPE_URL =
  'https://opendata.aemet.es/opendata/api/observacion/convencional/todas';

/** Build the envelope request URL for a given key. Never logged — embeds the key. */
export function aemetStationsEnvelopeUrl(apiKey) {
  return `${AEMET_STATIONS_ENVELOPE_URL}?api_key=${encodeURIComponent(apiKey)}`;
}

/**
 * A station is unusable without a place to put it on the map. Every other
 * field degrades to `null` rather than dropping the record — a station with
 * a dead temperature sensor still belongs on the globe.
 */
function finiteOrNull(value) {
  // Number(null) is 0 and Number('') is 0 — both finite, and both wrong: a
  // sensor AEMET didn't report must never coerce into a real-looking zero.
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize one raw AEMET observation record. Returns `null` when the record
 * cannot be placed on a map (missing id/lat/lon) — the caller skips it rather
 * than failing the whole batch, since a single malformed station is common in
 * a ~10k-record feed and must never blank out the other ~850.
 * @param {object} raw One element of the `datos` JSON array.
 * @returns {{id: string, name: string|null, lat: number, lon: number,
 *   altitudeM: number|null, observedAtMs: number|null, temperatureC: number|null,
 *   temperatureMinC: number|null, temperatureMaxC: number|null, dewPointC: number|null,
 *   humidityPct: number|null, pressureHpa: number|null, pressureSeaLevelHpa: number|null,
 *   windSpeedMs: number|null, windDirectionDeg: number|null, windDirectionStdDevDeg: number|null,
 *   windSpeedStdDevMs: number|null, windGustMs: number|null, windGustDirectionDeg: number|null,
 *   precipitationMm: number|null}|null}
 */
export function normalizeAemetStationRecord(raw) {
  const id = String(raw?.idema ?? '').trim();
  const lat = finiteOrNull(raw?.lat);
  const lon = finiteOrNull(raw?.lon);
  if (!id || lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const name = typeof raw?.ubi === 'string' && raw.ubi.trim() ? raw.ubi.trim() : null;
  const observedAtMs = Date.parse(raw?.fint);
  return {
    id,
    name,
    lat,
    lon,
    altitudeM: finiteOrNull(raw?.alt),
    observedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : null,
    temperatureC: finiteOrNull(raw?.ta),
    // Trailing-hour min/max, not a daily extreme — AEMET's own field names
    // (tamin/tamax) don't say over what window; treat as short-term only.
    temperatureMinC: finiteOrNull(raw?.tamin),
    temperatureMaxC: finiteOrNull(raw?.tamax),
    dewPointC: finiteOrNull(raw?.tpr),
    humidityPct: finiteOrNull(raw?.hr),
    pressureHpa: finiteOrNull(raw?.pres),
    // Sea-level-corrected — comparable across stations at different
    // altitudes, unlike raw station pressure above.
    pressureSeaLevelHpa: finiteOrNull(raw?.pres_nmar),
    windSpeedMs: finiteOrNull(raw?.vv),
    windDirectionDeg: finiteOrNull(raw?.dv),
    // Turbulence/gustiness indicators, not a reading of anything directly —
    // kept for completeness (analyst records, future use) but deliberately
    // left out of the compact click-to-inspect card.
    windDirectionStdDevDeg: finiteOrNull(raw?.stddv),
    windSpeedStdDevMs: finiteOrNull(raw?.stdvv),
    windGustMs: finiteOrNull(raw?.vmax),
    windGustDirectionDeg: finiteOrNull(raw?.dmax),
    precipitationMm: finiteOrNull(raw?.prec),
  };
}

/**
 * The live feed carries up to ~12 trailing hourly readings per station
 * (confirmed against the real API: ~9.8k records, ~850 unique `idema`), not
 * one row per station — this reduces it to exactly one row per station,
 * keeping the most recent `fint`. A station with an unparsable/missing
 * timestamp is treated as older than any real timestamp so a station that DOES
 * report a valid time always wins the dedup, never a garbled one.
 * @param {Array<object>} rawRecords The raw `datos` JSON array.
 * @returns {Array<ReturnType<typeof normalizeAemetStationRecord>>}
 */
export function normalizeAemetStationsSnapshot(rawRecords) {
  if (!Array.isArray(rawRecords)) return [];
  const latestById = new Map();
  for (const raw of rawRecords) {
    const record = normalizeAemetStationRecord(raw);
    if (!record) continue;
    const existing = latestById.get(record.id);
    if (!existing || (record.observedAtMs ?? -Infinity) > (existing.observedAtMs ?? -Infinity)) {
      latestById.set(record.id, record);
    }
  }
  return [...latestById.values()];
}

/** A station reading older than this is treated as offline, not "current". */
export const AEMET_STATION_STALE_MS = 3 * 3600_000;

/**
 * Drop stations whose most recent reading is older than
 * `AEMET_STATION_STALE_MS` — applied at serve/render time (like
 * firmsCsv.js's `filterTrailing24h`) so a cache entry served hours after it
 * was fetched still reflects "current" correctly against the caller's clock,
 * and a station with no parsable timestamp at all is treated as stale (never
 * shown as if it were live).
 * @param {Array<ReturnType<typeof normalizeAemetStationRecord>>} stations
 * @param {number} [now]
 */
export function filterFreshAemetStations(stations, now = Date.now()) {
  if (!Array.isArray(stations)) return [];
  return stations.filter(
    (station) => Number.isFinite(station?.observedAtMs) && now - station.observedAtMs <= AEMET_STATION_STALE_MS,
  );
}

// ---------------------------------------------------------------------------
// Avisos (warnings) — a second AEMET feed, same envelope indirection, very
// different payload: the `datos` url here is a plain (NOT gzipped, despite
// the .tar.gz filename AEMET gives it — confirmed against real bytes) POSIX
// tar archive of CAP 1.2 XML files, one per (phenomenon × level × zone-group)
// bulletin. Unlike the stations feed, the individual XML files ARE genuinely
// UTF-8 (confirmed against real bytes: decoding as UTF-8 gives correct
// "Meteorología", decoding as latin1 mangles it into "MeteorologÃ­a" — the
// REVERSE of the stations encoding bug, and reusing that fix here would be
// wrong). Each CAP alert carries its own warning-zone polygon(s) inline, so
// there is no separate zone shapefile/GeoJSON to source at all.
// ---------------------------------------------------------------------------

/** Nationwide latest-elaborated avisos envelope. */
export const AEMET_WARNINGS_ENVELOPE_URL =
  'https://opendata.aemet.es/opendata/api/avisos_cap/ultimoelaborado/area/esp';

/** Build the envelope request URL for a given key. Never logged — embeds the key. */
export function aemetWarningsEnvelopeUrl(apiKey) {
  return `${AEMET_WARNINGS_ENVELOPE_URL}?api_key=${encodeURIComponent(apiKey)}`;
}

/**
 * AEMET's 4-level avisos scale, ranked low to high. `verde` ("nothing to see
 * here") is intentionally rank 0 — AEMET bundles a verde bulletin for
 * essentially the whole country per phenomenon as a matter of course, and
 * rendering it as a warning polygon would paint most of Spain green at all
 * times for no signal. Every consumer of this rank table treats 0 as
 * "not a warning", never as "the mildest warning".
 */
export const AEMET_WARNING_LEVEL_RANK = Object.freeze({
  verde: 0,
  amarillo: 1,
  naranja: 2,
  rojo: 3,
});

/**
 * Read one 512-byte-aligned POSIX (ustar) tar archive. Hand-rolled rather
 * than a dependency: the format is simple, fixed, and entirely AEMET-
 * controlled — the same reasoning this codebase already applies to
 * `parseFirmsCsv`/`parseDotenvText` instead of pulling in a library for a
 * small, trusted, well-known shape. Only regular files (typeflag '0' or the
 * legacy '\0') are returned; directory/link entries are skipped. Tolerant
 * of a truncated/malformed trailer (stops at the first header that doesn't
 * look like a real header) rather than throwing, since a body this large
 * degrading gracefully beats losing every zone to one bad byte.
 * @param {Buffer} buffer Raw tar bytes.
 * @returns {Array<{name: string, content: Buffer}>}
 */
export function parseAemetCapTar(buffer) {
  const BLOCK = 512;
  const entries = [];
  let offset = 0;
  const readCString = (start, length) => {
    let end = start;
    while (end < start + length && buffer[end] !== 0) end += 1;
    return buffer.toString('utf8', start, end);
  };
  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break; // end-of-archive marker
    const name = readCString(offset, 100);
    const prefix = readCString(offset + 345, 155);
    const sizeField = readCString(offset + 124, 12).trim();
    const size = sizeField ? parseInt(sizeField, 8) : NaN;
    if (!name || !Number.isFinite(size) || size < 0) break; // not a real header — stop, don't guess
    const typeflag = String.fromCharCode(header[156] || 0);
    offset += BLOCK;
    if (offset + size > buffer.length) break; // truncated body — stop, don't slice past the end
    if (typeflag === '0' || typeflag === '\u0000') {
      entries.push({
        name: prefix ? `${prefix}/${name}` : name,
        content: Buffer.from(buffer.subarray(offset, offset + size)),
      });
    }
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}

const XML_ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" });

/** Decode the small, fixed set of XML entities CAP text fields actually use. */
function decodeXmlEntities(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => XML_ENTITIES[name]);
}

/** First `<tag>...</tag>` match within `text`, trimmed and entity-decoded, or `null`. */
function extractTag(text, tag) {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? decodeXmlEntities(match[1].trim()) : null;
}

/** Every `<tag>...</tag>` match's inner content, in document order, undecoded (caller's choice). */
function extractAllTagBlocks(text, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  const blocks = [];
  let match = re.exec(text);
  while (match) {
    blocks.push(match[1]);
    match = re.exec(text);
  }
  return blocks;
}

/**
 * CAP's `<valueName>NAME</valueName><value>VALUE</value>` pairs, scoped to
 * one container tag (`eventCode`, `parameter`, or `geocode`) by exact name.
 */
function extractNamedValue(text, containerTag, valueName) {
  const re = new RegExp(
    `<${containerTag}>\\s*<valueName>${valueName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</valueName>\\s*<value>([\\s\\S]*?)</value>\\s*</${containerTag}>`,
  );
  const match = text.match(re);
  return match ? decodeXmlEntities(match[1].trim()) : null;
}

/** One `<polygon>lat,lon lat,lon ...</polygon>` body → `[[lat, lon], ...]`, dropping unparsable pairs. */
function parsePolygonRing(text) {
  const points = [];
  for (const pair of text.trim().split(/\s+/)) {
    const [lat, lon] = pair.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) points.push([lat, lon]);
  }
  return points;
}

/**
 * Parse one CAP 1.2 alert XML string into its structured Spanish-language
 * content. Returns `null` when the alert has no `es-ES` `<info>` block, no
 * recognized phenomenon/level, or no area with a usable polygon — a
 * malformed alert is skipped, never fabricated, matching
 * `normalizeAemetStationRecord`'s "unusable record → null, not a crash"
 * contract. AEMET always ships a paired `en-GB` block too; `es-ES` is used
 * for consistency with station names (`ubi`) already being Spanish.
 * @param {string} xml One extracted `.xml` file's UTF-8 text.
 * @returns {{event: string, level: string|null, severity: string|null,
 *   phenomenonCode: string|null, phenomenonName: string|null,
 *   probability: string|null, onsetMs: number|null, expiresMs: number|null,
 *   headline: string|null, description: string|null, instruction: string|null,
 *   areas: Array<{geocode: string, name: string|null, polygons: number[][][]}>}|null}
 */
export function parseAemetCapAlert(xml) {
  if (typeof xml !== 'string' || !xml.includes('<info>')) return null;
  const infoBlocks = extractAllTagBlocks(xml, 'info');
  const esInfo = infoBlocks.find((block) => extractTag(block, 'language') === 'es-ES');
  if (!esInfo) return null;

  const event = extractTag(esInfo, 'event');
  if (!event) return null;
  const phenomenonRaw = extractNamedValue(esInfo, 'eventCode', 'AEMET-Meteoalerta fenomeno');
  const [phenomenonCode, phenomenonName] = phenomenonRaw
    ? phenomenonRaw.split(';').map((part) => part.trim())
    : [null, null];
  const level = extractNamedValue(esInfo, 'parameter', 'AEMET-Meteoalerta nivel');
  const onsetMs = Date.parse(extractTag(esInfo, 'onset') ?? '');
  const expiresMs = Date.parse(extractTag(esInfo, 'expires') ?? '');

  const areas = [];
  for (const areaBlock of extractAllTagBlocks(esInfo, 'area')) {
    const geocode = extractNamedValue(areaBlock, 'geocode', 'AEMET-Meteoalerta zona');
    if (!geocode) continue;
    const polygons = extractAllTagBlocks(areaBlock, 'polygon')
      .map(parsePolygonRing)
      .filter((ring) => ring.length >= 3);
    if (!polygons.length) continue;
    areas.push({ geocode, name: extractTag(areaBlock, 'areaDesc'), polygons });
  }
  if (!areas.length) return null;

  return {
    event,
    level: level || null,
    severity: extractTag(esInfo, 'severity'),
    phenomenonCode,
    phenomenonName,
    probability: extractNamedValue(esInfo, 'parameter', 'AEMET-Meteoalerta probabilidad'),
    onsetMs: Number.isFinite(onsetMs) ? onsetMs : null,
    expiresMs: Number.isFinite(expiresMs) ? expiresMs : null,
    headline: extractTag(esInfo, 'headline'),
    description: extractTag(esInfo, 'description'),
    instruction: extractTag(esInfo, 'instruction'),
    areas,
  };
}

/**
 * Aggregate parsed alerts by warning zone. A zone can appear in several
 * alerts (one per phenomenon currently elaborated for it, e.g. wind AND
 * coastal at once) — this merges them into one record per zone with every
 * phenomenon it currently carries, `verde` included (filtered out later by
 * `filterActiveAemetWarnings`, not here, so a zone's full status is still
 * knowable if ever needed). A zone's name/polygons are taken from the first
 * alert that mentions it; AEMET reports the same geometry for a zone across
 * every phenomenon, so this is not a meaningful choice between conflicting
 * data.
 * @param {Array<ReturnType<typeof parseAemetCapAlert>>} alerts
 * @returns {Array<{geocode: string, name: string|null, polygons: number[][][],
 *   phenomena: Array<{code: string|null, name: string|null, event: string,
 *   level: string|null, description: string|null, instruction: string|null,
 *   probability: string|null, onsetMs: number|null, expiresMs: number|null}>}>}
 */
export function normalizeAemetWarningsSnapshot(alerts) {
  if (!Array.isArray(alerts)) return [];
  const zonesByGeocode = new Map();
  for (const alert of alerts) {
    if (!alert) continue;
    for (const area of alert.areas) {
      let zone = zonesByGeocode.get(area.geocode);
      if (!zone) {
        zone = { geocode: area.geocode, name: area.name, polygons: area.polygons, phenomena: [] };
        zonesByGeocode.set(area.geocode, zone);
      }
      zone.phenomena.push({
        code: alert.phenomenonCode,
        name: alert.phenomenonName,
        event: alert.event,
        level: alert.level,
        description: alert.description,
        instruction: alert.instruction,
        probability: alert.probability,
        onsetMs: alert.onsetMs,
        expiresMs: alert.expiresMs,
      });
    }
  }
  return [...zonesByGeocode.values()];
}

/** A zone reading with no recorded expiry is never treated as active — never guess it's current. */
function isPhenomenonActive(phenomenon, now) {
  return Boolean(phenomenon?.level)
    && phenomenon.level !== 'verde'
    && Number.isFinite(phenomenon.expiresMs)
    && phenomenon.expiresMs > now;
}

/**
 * Drop expired and `verde` phenomena, then drop zones left with nothing —
 * applied at serve time (like `filterFreshAemetStations`) so a cached
 * response still reflects "current" against the caller's clock. Each
 * surviving zone is tagged with `levelRank`/`level` from its HIGHEST active
 * phenomenon (a zone with both an amarillo wind warning and a naranja
 * coastal one renders as naranja, but the detail card still lists both).
 * @param {ReturnType<typeof normalizeAemetWarningsSnapshot>} zones
 * @param {number} [now]
 * @returns {Array<{geocode: string, name: string|null, polygons: number[][][],
 *   level: string, levelRank: number, phenomena: Array<{code: string|null,
 *   name: string|null, event: string, description: string|null,
 *   instruction: string|null, probability: string|null, onsetMs: number|null,
 *   expiresMs: number|null, inEffect: boolean}>}>}
 */
// ---------------------------------------------------------------------------
// Municipio forecast (Phase A2) — a third AEMET feed, same envelope
// indirection again, backing an on-demand "next hours" lookup rather than a
// polled snapshot: `maestro/municipios` (a fixed, rarely-changing 8k-row
// lookup table, confirmed live) supplies municipio id/name/lat/lon, and
// `prediccion/especifica/municipio/horaria/{municipio}` returns that
// municipio's hourly forecast for ~today plus the next 2 days. Confirmed
// live against the real API rather than guessed from the endpoint's one-line
// docs summary, per this plan's own discipline.
// ---------------------------------------------------------------------------

/** Nationwide municipio lookup table envelope (id/name/lat/lon/altitude/population). */
export const AEMET_MUNICIPIOS_ENVELOPE_URL =
  'https://opendata.aemet.es/opendata/api/maestro/municipios';

/** Build the envelope request URL for a given key. Never logged — embeds the key. */
export function aemetMunicipiosEnvelopeUrl(apiKey) {
  return `${AEMET_MUNICIPIOS_ENVELOPE_URL}?api_key=${encodeURIComponent(apiKey)}`;
}

/** Build the hourly-forecast envelope request URL for one municipio id (e.g. "28079"). */
export function aemetMunicipioForecastEnvelopeUrl(apiKey, municipioId) {
  return `https://opendata.aemet.es/opendata/api/prediccion/especifica/municipio/horaria/${encodeURIComponent(municipioId)}?api_key=${encodeURIComponent(apiKey)}`;
}

/**
 * Normalize one raw `maestro/municipios` record. AEMET's `id` field is
 * `"id" + the 5-digit INE municipio code` (e.g. `"id28079"`) — confirmed live
 * to be the exact value the forecast endpoint's `{municipio}` path segment
 * wants (`"28079"`), which is NOT the same as the record's own `id_old`
 * field (a different, legacy code that the forecast endpoint rejects).
 * Returns `null` for a record with no usable id or coordinates, matching
 * `normalizeAemetStationRecord`'s "unusable record → null" contract.
 * @param {object} raw One element of the `maestro/municipios` JSON array.
 * @returns {{id: string, name: string, lat: number, lon: number,
 *   altitudeM: number|null, populationCount: number|null}|null}
 */
export function normalizeAemetMunicipioRecord(raw) {
  const idMatch = /^id(\d+)$/.exec(String(raw?.id ?? '').trim());
  if (!idMatch) return null;
  const lat = finiteOrNull(raw?.latitud_dec);
  const lon = finiteOrNull(raw?.longitud_dec);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const name = (typeof raw?.nombre === 'string' && raw.nombre.trim())
    || (typeof raw?.capital === 'string' && raw.capital.trim())
    || null;
  if (!name) return null;
  return {
    id: idMatch[1],
    name,
    lat,
    lon,
    altitudeM: finiteOrNull(raw?.altitud),
    populationCount: finiteOrNull(raw?.num_hab),
  };
}

/**
 * @param {Array<object>} rawRecords The raw `maestro/municipios` JSON array.
 * @returns {Array<ReturnType<typeof normalizeAemetMunicipioRecord>>}
 */
export function normalizeAemetMunicipiosSnapshot(rawRecords) {
  if (!Array.isArray(rawRecords)) return [];
  const result = [];
  for (const raw of rawRecords) {
    const record = normalizeAemetMunicipioRecord(raw);
    if (record) result.push(record);
  }
  return result;
}

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance between two lat/lon points, in km. */
export function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/**
 * Nearest municipio to a lat/lon (a station's, or any clicked point) by
 * straight-line great-circle distance — a click-to-inspect forecast doesn't
 * need administrative-boundary precision, just "close enough to be the
 * locally relevant forecast", which every AEMET station location already is
 * by construction (all ~850 stations sit inside Spain, where this 8k-entry
 * municipio table has dense coverage). O(n) linear scan over ~8k records is
 * cheap enough for one on-demand click; no spatial index needed.
 * @param {Array<ReturnType<typeof normalizeAemetMunicipioRecord>>} municipios
 * @param {number} lat
 * @param {number} lon
 * @returns {{municipio: object, distanceKm: number}|null}
 */
export function findNearestAemetMunicipio(municipios, lat, lon) {
  if (!Array.isArray(municipios) || !municipios.length) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let best = null;
  let bestDistanceKm = Infinity;
  for (const municipio of municipios) {
    const distanceKm = haversineDistanceKm(lat, lon, municipio.lat, municipio.lon);
    if (distanceKm < bestDistanceKm) {
      bestDistanceKm = distanceKm;
      best = municipio;
    }
  }
  return best ? { municipio: best, distanceKm: bestDistanceKm } : null;
}

/**
 * AEMET's hourly `estadoCielo`/`precipitacion`/`temperatura`/`humedadRelativa`
 * arrays are each keyed by their own `periodo` (a zero-padded hour-of-day
 * string, e.g. `"09"`), so one hour's full picture has to be assembled by
 * matching `periodo` across four separate arrays rather than read off one.
 * `vientoAndRachaMax` is the odd one out: it interleaves TWO entry shapes at
 * the same `periodo` — a wind entry (`{direccion: [...], velocidad: [...],
 * periodo}`) and a gust entry (`{value, periodo}`, no `direccion` key) —
 * confirmed against real bytes; only the wind-shaped entries are used here,
 * gust is left for a future pass rather than guessed at.
 */
function indexByPeriodo(entries) {
  const byPeriodo = new Map();
  for (const entry of entries ?? []) {
    if (entry?.periodo !== undefined) byPeriodo.set(String(entry.periodo), entry);
  }
  return byPeriodo;
}

/**
 * Parse the `datos` payload of `prediccion/especifica/municipio/horaria/*`
 * into a flat, chronologically-ordered list of hourly forecast points.
 * Deliberately does NOT compute an epoch timestamp: AEMET's `fecha`/`periodo`
 * fields are naive local (Europe/Madrid) civil time with no UTC offset
 * anywhere in this response (unlike the CAP warnings feed's `onset`/
 * `expires`, which DO carry an explicit `+01:00`/`+02:00` offset) — silently
 * running them through `Date.parse` would let the SERVER's own timezone (not
 * Spain's) decide what "future" means, a wrong-timezone bug that would be
 * invisible in a UTC-scheduled CI run but wrong for a real user. `dateIso` +
 * `hour` are kept as the plain civil values AEMET published; filtering
 * "upcoming" against a caller-supplied civil "now" (see
 * `filterUpcomingAemetForecastHours`) compares like-for-like instead.
 * @param {Array<object>} raw The `datos` JSON array (always one element per
 *   requested municipio).
 * @returns {{municipioId: string, name: string|null, province: string|null,
 *   elaborated: string|null, hours: Array<{dateIso: string, hour: number,
 *   temperatureC: number|null, skyDescription: string|null,
 *   precipitationMm: number|null, windSpeedKmh: number|null,
 *   windDirection: string|null}>}|null}
 */
export function normalizeAemetHourlyForecast(raw) {
  const record = Array.isArray(raw) ? raw[0] : null;
  const days = record?.prediccion?.dia;
  if (!record || !Array.isArray(days)) return null;

  const hours = [];
  for (const day of days) {
    const dateIso = typeof day?.fecha === 'string' ? day.fecha.slice(0, 10) : null;
    if (!dateIso) continue;
    const temperaturaByHour = indexByPeriodo(day.temperatura);
    const skyByHour = indexByPeriodo(day.estadoCielo);
    const precipByHour = indexByPeriodo(day.precipitacion);
    const windByHour = new Map();
    for (const entry of day.vientoAndRachaMax ?? []) {
      if (Array.isArray(entry?.direccion) && entry.periodo !== undefined) {
        windByHour.set(String(entry.periodo), entry);
      }
    }
    // Union of every periodo any field reports for this day, not just
    // temperature's — a hierarchical AEMET failure in one array must not
    // hide an hour the others still have data for.
    const periodos = new Set([
      ...temperaturaByHour.keys(),
      ...skyByHour.keys(),
      ...precipByHour.keys(),
      ...windByHour.keys(),
    ]);
    for (const periodo of periodos) {
      const hour = Number(periodo);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue; // "24" = next day's midnight, not this day's
      const wind = windByHour.get(periodo);
      hours.push({
        dateIso,
        hour,
        temperatureC: finiteOrNull(temperaturaByHour.get(periodo)?.value),
        skyDescription: skyByHour.get(periodo)?.descripcion || null,
        precipitationMm: finiteOrNull(precipByHour.get(periodo)?.value),
        windSpeedKmh: finiteOrNull(wind?.velocidad?.[0]),
        windDirection: (typeof wind?.direccion?.[0] === 'string' && wind.direccion[0]) || null,
      });
    }
  }
  hours.sort((a, b) => (a.dateIso === b.dateIso ? a.hour - b.hour : a.dateIso < b.dateIso ? -1 : 1));

  return {
    municipioId: String(record.id ?? ''),
    name: typeof record.nombre === 'string' ? record.nombre : null,
    province: typeof record.provincia === 'string' ? record.provincia : null,
    elaborated: typeof record.elaborado === 'string' ? record.elaborado : null,
    hours,
  };
}

/**
 * Madrid civil "now" — every AEMET forecast timestamp in this feed is
 * naive Europe/Madrid local time (see `normalizeAemetHourlyForecast`), so
 * "upcoming" has to be judged against the same civil clock, not the
 * server's own timezone or a raw UTC epoch comparison.
 * @param {number} [nowMs]
 * @returns {{dateIso: string, hour: number}}
 */
export function madridCivilNow(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  // Intl's midnight hour can format as "24" depending on locale/engine; fold
  // it back to "00" so it compares correctly against `normalizeAemetHourlyForecast`'s
  // 0–23 hour range rather than silently sorting after every real hour.
  const hour = Number(get('hour')) % 24;
  return { dateIso: `${get('year')}-${get('month')}-${get('day')}`, hour };
}

/**
 * Drop hours strictly before `civilNow`, then cap to `limit` — the Phase-A2
 * equivalent of `filterFreshAemetStations`/`filterActiveAemetWarnings`,
 * applied at serve time so a cached forecast still reads as "upcoming"
 * against the caller's clock rather than the moment it was fetched.
 * @param {ReturnType<typeof normalizeAemetHourlyForecast>['hours']} hours
 * @param {{dateIso: string, hour: number}} civilNow
 * @param {number} [limit]
 */
export function filterUpcomingAemetForecastHours(hours, civilNow, limit = 6) {
  if (!Array.isArray(hours)) return [];
  const isUpcoming = (h) => h.dateIso > civilNow.dateIso
    || (h.dateIso === civilNow.dateIso && h.hour >= civilNow.hour);
  return hours.filter(isUpcoming).slice(0, Math.max(0, limit));
}

// ---------------------------------------------------------------------------
// Lightning (Phase A4) — a fourth AEMET feed, same two-step envelope, but the
// `datos` payload is opaque: a pre-rendered GIF composite (confirmed live —
// `image/gif`, 640×480), not raw strike coordinates. AEMET's own metadata
// describes it as "rayos registrados en el período de 12 horas anteriores",
// refreshed "cada seis horas o 00Z, 06Z, 12Z, 18Z" — this API exposes no
// separate strike list, so there is nothing to parse or normalize here
// beyond building the envelope URL; the image bytes pass straight through
// the proxy to the browser.
// ---------------------------------------------------------------------------

/** Nationwide lightning-activity composite envelope. */
export const AEMET_LIGHTNING_ENVELOPE_URL =
  'https://opendata.aemet.es/opendata/api/red/rayos/mapa';

/** Build the envelope request URL for a given key. Never logged — embeds the key. */
export function aemetLightningEnvelopeUrl(apiKey) {
  return `${AEMET_LIGHTNING_ENVELOPE_URL}?api_key=${encodeURIComponent(apiKey)}`;
}

// ---------------------------------------------------------------------------
// Forest-fire risk (Phase A5) — a fifth AEMET feed, same two-step envelope,
// same "opaque legend-annotated raster, nothing to parse" shape as lightning.
// Confirmed live: a 1525×1017 `image/png` per area (`p` Península, `b`
// Baleares, `c` Canarias) with AEMET's own header/legend/logo baked into the
// pixels (6-level risk scale: muy bajo/bajo/moderado/alto/muy alto/extremo) —
// no bounding box anywhere in the response, same as lightning. NOT a FIRMS
// duplicate: this is a predictive meteorological risk index, not detected
// fires.
//
// `estimado` (today) returned 404 "No hay datos que satisfagan esos
// criterios" at the time this was verified — not every area/day always has
// a published product — while `previsto/dia/1` (tomorrow) succeeded
// immediately after. The proxy tries `estimado` first and falls back to
// `previsto` day 1 rather than assuming "today" is always available.
// ---------------------------------------------------------------------------

/** Today's estimated risk-map envelope for one area (`p`/`b`/`c`). */
export function aemetFireRiskEstimadoEnvelopeUrl(apiKey, area) {
  return `https://opendata.aemet.es/opendata/api/incendios/mapasriesgo/estimado/area/${encodeURIComponent(area)}?api_key=${encodeURIComponent(apiKey)}`;
}

/** Forecast risk-map envelope for one area and day (`1`/`2`/`3` — mañana/pasado mañana/dentro de 3 días). */
export function aemetFireRiskPrevistoEnvelopeUrl(apiKey, area, dia) {
  return `https://opendata.aemet.es/opendata/api/incendios/mapasriesgo/previsto/dia/${encodeURIComponent(dia)}/area/${encodeURIComponent(area)}?api_key=${encodeURIComponent(apiKey)}`;
}

// ---------------------------------------------------------------------------
// UV index (Phase A8) — a sixth AEMET feed, same two-step envelope, but
// GENUINELY the friendliest shape encountered in this whole plan: confirmed
// live, `prediccion/especifica/uvi/{dia}` returns real structured JSON — a
// flat list of 59 provincial-capital cities, each with a 5-digit INE
// municipio code (the exact same code `maestro/municipios` already keys on
// for Phase A2's forecast tooltip — `id: "02003"` here is the same value as
// `normalizeAemetMunicipioRecord`'s `id` after stripping the `"id"` prefix)
// and a plain numeric UV index value. No image, no legend to decode, no
// missing-geometry problem the way A6/A7 have — the proxy joins each city to
// its lat/lon via the already-proven municipios lookup and this ships as a
// real point layer, not an ambient thumbnail.
// ---------------------------------------------------------------------------

/** UV-index forecast envelope for one day-offset (`0` = today, confirmed live). */
export function aemetUvIndexEnvelopeUrl(apiKey, dia) {
  return `https://opendata.aemet.es/opendata/api/prediccion/especifica/uvi/${encodeURIComponent(dia)}?api_key=${encodeURIComponent(apiKey)}`;
}

/**
 * Normalize one raw `CIUDAD` entry from the UV-index payload. Returns `null`
 * for a record with no usable municipio id or UV value — matching every
 * other normalize function's "unusable record → null" contract.
 * @param {object} raw
 * @returns {{municipioId: string, name: string, uvIndex: number, isCanaryIslands: boolean}|null}
 */
export function normalizeAemetUvIndexRecord(raw) {
  const municipioId = String(raw?.id ?? '').trim();
  const uvIndex = finiteOrNull(raw?.uv);
  if (!/^\d+$/.test(municipioId) || uvIndex === null) return null;
  const name = typeof raw?.valor === 'string' && raw.valor.trim() ? raw.valor.trim() : null;
  if (!name) return null;
  return {
    municipioId,
    name,
    uvIndex,
    isCanaryIslands: raw?.canarias === '1' || raw?.canarias === 1,
  };
}

/**
 * @param {object} payload The `datos` JSON object (`{FECHA_ELABORACION,
 *   FECHA_VALIDEZ, CIUDAD: [...]}`).
 * @returns {{elaborated: string|null, validAt: string|null,
 *   cities: Array<ReturnType<typeof normalizeAemetUvIndexRecord>>}|null}
 */
export function normalizeAemetUvIndexSnapshot(payload) {
  if (!Array.isArray(payload?.CIUDAD)) return null;
  const cities = [];
  for (const raw of payload.CIUDAD) {
    const record = normalizeAemetUvIndexRecord(raw);
    if (record) cities.push(record);
  }
  return {
    elaborated: typeof payload.FECHA_ELABORACION === 'string' ? payload.FECHA_ELABORACION : null,
    validAt: typeof payload.FECHA_VALIDEZ === 'string' ? payload.FECHA_VALIDEZ : null,
    cities,
  };
}

// ---------------------------------------------------------------------------
// Sea-surface temperature (Phase A9) — a seventh AEMET feed, same two-step
// envelope, same "opaque legend-annotated raster, nothing to parse" shape
// as lightning/fire-risk. Confirmed live: `satelites/producto/sst` returns
// a real `image/gif`, 1000×773, showing actual EUMETSAT OSI SAF sea-surface
// temperature data (credited "AEMET / EUMETSAT OSI SAF" on the image
// itself — AEMET is redistributing a EUMETSAT satellite product here, not
// an AEMET-original observation) for the wider Iberia/Mediterranean/NW
// Africa region — a real color-coded temperature map (0–35°C legend), not
// just Spain. No bounding box anywhere in the response, same as every
// other opaque-image AEMET feed — ships as the same ambient click-to-expand
// world-overlay thumbnail Phase A4 established. `periodicidad: "1 vez al
// día"` per the live metadatos pull.
// ---------------------------------------------------------------------------

/** Sea-surface-temperature composite envelope. */
export const AEMET_SEA_SURFACE_TEMP_ENVELOPE_URL =
  'https://opendata.aemet.es/opendata/api/satelites/producto/sst';

/** Build the envelope request URL for a given key. Never logged — embeds the key. */
export function aemetSeaSurfaceTempEnvelopeUrl(apiKey) {
  return `${AEMET_SEA_SURFACE_TEMP_ENVELOPE_URL}?api_key=${encodeURIComponent(apiKey)}`;
}

export function filterActiveAemetWarnings(zones, now = Date.now()) {
  if (!Array.isArray(zones)) return [];
  const result = [];
  for (const zone of zones) {
    const active = (zone?.phenomena ?? []).filter((phenomenon) => isPhenomenonActive(phenomenon, now));
    if (!active.length) continue;
    const levelRank = Math.max(...active.map((p) => AEMET_WARNING_LEVEL_RANK[p.level] ?? 0));
    const level = Object.keys(AEMET_WARNING_LEVEL_RANK).find(
      (candidate) => AEMET_WARNING_LEVEL_RANK[candidate] === levelRank,
    );
    result.push({
      geocode: zone.geocode,
      name: zone.name,
      polygons: zone.polygons,
      level,
      levelRank,
      phenomena: active.map((p) => ({
        code: p.code,
        name: p.name,
        event: p.event,
        description: p.description,
        instruction: p.instruction,
        probability: p.probability,
        onsetMs: p.onsetMs,
        expiresMs: p.expiresMs,
        inEffect: Number.isFinite(p.onsetMs) ? p.onsetMs <= now : true,
      })),
    });
  }
  return result;
}
