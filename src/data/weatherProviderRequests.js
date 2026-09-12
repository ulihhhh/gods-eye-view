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
 *   humidityPct: number|null, pressureHpa: number|null, windSpeedMs: number|null,
 *   windDirectionDeg: number|null, windGustMs: number|null, precipitationMm: number|null}|null}
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
    humidityPct: finiteOrNull(raw?.hr),
    pressureHpa: finiteOrNull(raw?.pres),
    windSpeedMs: finiteOrNull(raw?.vv),
    windDirectionDeg: finiteOrNull(raw?.dv),
    windGustMs: finiteOrNull(raw?.vmax),
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
