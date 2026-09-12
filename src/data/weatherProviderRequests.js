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
