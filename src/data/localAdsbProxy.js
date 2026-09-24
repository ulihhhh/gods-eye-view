// Pure server-side mechanics for the local ADS-B receiver tap proxy
// (issue #57). Kept free of Vite/Node middleware state so cache and fetch
// behavior can be exercised by the offline node:test suite without a real
// dump1090/readsb instance.
//
// The receiver base URL is operator-configured (LOCAL_ADSB_BASE_URL env var,
// read by the caller — never taken from the request), not client-supplied.
// This app supports LAN-sharing (see README "Sharing an instance"), and a
// proxy that fetched whatever host a request named would let any LAN visitor
// turn a shared instance into an open relay against the operator's internal
// network. Fixing the target server-side closes that off entirely.

/** dump1090-fa/readsb's own default HTTP port. */
export const DEFAULT_LOCAL_ADSB_BASE_URL = 'http://localhost:8080';

/** How long a fetched snapshot is served before the next request refetches it. */
export const LOCAL_ADSB_CACHE_TTL_MS = 2000;

const FETCH_TIMEOUT_MS = 4000;

/** Hard cap on aircraft rows served per snapshot — matches Flights-layer scale. */
const MAX_AIRCRAFT = 500;

/** Numeric readsb fields passed through verbatim when finite. */
const NUMERIC_FIELDS = Object.freeze([
  'alt_geom',
  'gs',
  'ias',
  'tas',
  'mach',
  'track',
  'track_rate',
  'roll',
  'mag_heading',
  'true_heading',
  'baro_rate',
  'geom_rate',
  'nav_qnh',
  'nav_altitude_mcp',
  'nav_altitude_fms',
  'nav_heading',
  'nic',
  'nac_p',
  'nac_v',
  'sil',
  'version',
  'seen',
  'seen_pos',
  'rssi',
  'messages',
]);

const finiteOrNull = (value) =>
  value !== null && value !== '' && Number.isFinite(Number(value))
    ? Number(value)
    : null;

/**
 * Validate and sanitize one dump1090/readsb aircraft.json row into a
 * client-safe readsb-shaped row (the same shape adsb.lol serves, so the
 * shared civil-flight engine's `readsbSnapshot` consumes it unchanged).
 * Only whitelisted, type-checked fields survive — never the raw upstream
 * object. Returns null for anything without a valid ICAO identity or a
 * usable position; position-less (Mode-S-only) contacts are counted by the
 * snapshot instead of plotted.
 * @param {object} raw
 * @returns {object|null}
 */
export function normalizeLocalAdsbAircraft(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const hex = typeof raw.hex === 'string' ? raw.hex.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{6}$/.test(hex)) return null;
  const lat = finiteOrNull(raw.lat);
  const lon = finiteOrNull(raw.lon);
  if (lat == null || Math.abs(lat) > 90) return null;
  if (lon == null || Math.abs(lon) > 180) return null;

  const rawAlt = raw.alt_baro ?? raw.altitude;
  const row = {
    hex,
    lat,
    lon,
    alt_baro: rawAlt === 'ground' ? 'ground' : finiteOrNull(rawAlt),
  };
  const flight = typeof raw.flight === 'string' ? raw.flight.trim() : '';
  if (flight) row.flight = flight;
  for (const key of NUMERIC_FIELDS) {
    const value = finiteOrNull(raw[key]);
    if (value != null) row[key] = value;
  }
  // Legacy dump1090 (pre-readsb field names).
  if (row.gs == null && finiteOrNull(raw.speed) != null)
    row.gs = Number(raw.speed);
  if (typeof raw.squawk === 'string' && /^[0-7]{4}$/.test(raw.squawk))
    row.squawk = raw.squawk;
  if (typeof raw.emergency === 'string' && /^[a-z]{1,16}$/.test(raw.emergency))
    row.emergency = raw.emergency;
  if (typeof raw.category === 'string' && /^[A-D][0-7]$/.test(raw.category))
    row.category = raw.category;
  return row;
}

/**
 * Validate and normalize a raw dump1090/readsb `aircraft.json` body.
 * Returns null for anything that isn't at least a plausible payload of that
 * shape (tar1090 and readsb both serve `{now, aircraft: [...]}`).
 * `ac` holds positioned rows (readsb/adsb.lol naming); `heard` counts every
 * valid contact, including Mode-S-only ones with no position yet.
 * @param {unknown} json
 * @returns {{receiverNowS:number|null, now:number|null, heard:number, ac:Array}|null}
 */
export function normalizeLocalAdsbSnapshot(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  if (!Array.isArray(json.aircraft)) return null;
  const ac = [];
  let heard = 0;
  for (const raw of json.aircraft) {
    if (typeof raw?.hex === 'string' && /^[0-9a-f]{6}$/i.test(raw.hex.trim()))
      heard += 1;
    if (ac.length >= MAX_AIRCRAFT) continue;
    const row = normalizeLocalAdsbAircraft(raw);
    if (row) ac.push(row);
  }
  const receiverNowS = finiteOrNull(json.now);
  return { receiverNowS, now: receiverNowS, heard, ac };
}

/** dump1090-fa keeps at most this many rotating history_N.json files. */
const MAX_HISTORY_FILES = 120;

/**
 * Build a readsb-style trace (`{timestamp, trace: [[offsetS, lat, lon, alt]]}`,
 * the shape adsb.lol's /trace serves) for one aircraft from dump1090's
 * rotating history snapshots, oldest first. Pure — the caller supplies the
 * already-fetched history bodies.
 * @param {Array<unknown>} historyBodies
 * @param {string} hex
 * @returns {{timestamp:number, trace:Array<Array<number|string|null>>}|null}
 */
export function buildLocalAdsbTrace(historyBodies, hex) {
  const id = String(hex || '')
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(id)) return null;
  const points = [];
  for (const body of historyBodies) {
    const snapshot = normalizeLocalAdsbSnapshot(body);
    if (!snapshot || snapshot.receiverNowS == null) continue;
    const row = snapshot.ac.find((candidate) => candidate.hex === id);
    if (!row) continue;
    const atS = snapshot.receiverNowS - (row.seen_pos ?? 0);
    points.push([atS, row.lat, row.lon, row.alt_baro]);
  }
  if (!points.length) return { timestamp: 0, trace: [] };
  points.sort((a, b) => a[0] - b[0]);
  const deduped = points.filter(
    (point, index) => index === 0 || point[0] !== points[index - 1][0],
  );
  const timestamp = deduped[0][0];
  return {
    timestamp,
    trace: deduped.map(([atS, lat, lon, alt]) => [
      Math.round((atS - timestamp) * 10) / 10,
      lat,
      lon,
      alt,
    ]),
  };
}

/**
 * Fetch every current history_N.json from the receiver (count advertised by
 * its receiver.json). Unreadable files are skipped — a trail is best-effort.
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{receiver:object|null, bodies:Array<unknown>}>}
 */
export async function fetchLocalAdsbHistory({
  baseUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
} = {}) {
  const root = `${String(baseUrl).replace(/\/+$/, '')}/data`;
  const getJson = async (name) => {
    try {
      const response = await fetchImpl(`${root}/${name}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  };
  const receiver = await getJson('receiver.json');
  const count = Math.min(
    MAX_HISTORY_FILES,
    Math.max(0, Math.floor(finiteOrNull(receiver?.history) ?? 0)),
  );
  const bodies = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      getJson(`history_${index}.json`),
    ),
  );
  return { receiver, bodies: bodies.filter(Boolean) };
}

/**
 * The receiver's own advertised position (dump1090 --lat/--lon), if set.
 * @param {unknown} receiver receiver.json body
 * @returns {{lat:number, lon:number}|null}
 */
export function localReceiverPosition(receiver) {
  const lat = finiteOrNull(receiver?.lat);
  const lon = finiteOrNull(receiver?.lon);
  if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return null;
  return { lat, lon };
}

/**
 * Fetch one snapshot from the configured local receiver. Throws a typed
 * error (`.reason`: 'unreachable' | 'http_error' | 'malformed') rather than
 * returning a partial result — the caller decides whether a stale cached
 * snapshot can cover for the failure.
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {(ms:number)=>AbortSignal} [options.makeSignal]
 * @returns {Promise<{receiverNowS:number|null, aircraft:Array}>}
 */
export async function fetchLocalAdsbSnapshot({
  baseUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
  makeSignal = (ms) => AbortSignal.timeout(ms),
} = {}) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/data/aircraft.json`;
  let response;
  try {
    response = await fetchImpl(url, { signal: makeSignal(timeoutMs) });
  } catch (error) {
    const wrapped = new Error(
      `local receiver unreachable: ${error?.message || error}`,
    );
    wrapped.reason = 'unreachable';
    throw wrapped;
  }
  if (!response.ok) {
    const error = new Error(`local receiver returned HTTP ${response.status}`);
    error.reason = 'http_error';
    throw error;
  }
  let body;
  try {
    body = await response.json();
  } catch {
    const error = new Error('local receiver returned invalid JSON');
    error.reason = 'malformed';
    throw error;
  }
  const snapshot = normalizeLocalAdsbSnapshot(body);
  if (!snapshot) {
    const error = new Error(
      'local receiver JSON is not a recognizable aircraft.json payload',
    );
    error.reason = 'malformed';
    throw error;
  }
  return snapshot;
}

/**
 * Static demo snapshot for local development without a real dump1090/readsb
 * instance (opt in with LOCAL_ADSB_MOCK=1 — see vite.config.js). Positioned
 * near Austin, TX, where this app's default camera fly-to lands, so enabling
 * the layer shows something immediately. Shaped exactly like a raw upstream
 * `aircraft.json` body — it flows through the same `normalizeLocalAdsbSnapshot`
 * path as a real fetch would, rather than skipping validation. This is a
 * deliberately separate, explicitly-flagged code path — never a silent
 * fallback for a genuine upstream failure, which must keep reporting as a
 * failure (see resolveLocalAdsbRequest), not fabricated data.
 * @param {()=>number} [now]
 * @returns {{now:number, aircraft:Array<object>}}
 */
export function mockLocalAdsbSnapshot(now = Date.now) {
  return {
    now: Math.floor(now() / 1000),
    aircraft: [
      {
        hex: 'a1b2c3',
        flight: 'MOCK01',
        lat: 30.3,
        lon: -97.7,
        alt_baro: 8000,
        track: 90,
        gs: 250,
        seen: 0.4,
      },
      {
        hex: 'd4e5f6',
        flight: 'MOCK02',
        lat: 30.2,
        lon: -97.8,
        alt_baro: 15000,
        track: 200,
        gs: 380,
        seen: 1.1,
      },
      {
        hex: '112233',
        flight: null,
        lat: 30.35,
        lon: -97.65,
        alt_baro: 3200,
        track: 45,
        gs: 140,
        seen: 2.8,
      },
      {
        hex: '445566',
        flight: 'MOCK04',
        lat: 30.15,
        lon: -97.6,
        alt_baro: 'ground',
        track: 0,
        gs: 12,
        seen: 0.1,
      },
    ],
  };
}

/**
 * Resolve one `/api/local-adsb` request against a short-lived in-memory
 * cache keyed by base URL. A fresh entry is served as-is; an expired one is
 * refreshed, falling back to the last good snapshot (flagged `stale: true`)
 * on fetch failure so one missed poll doesn't blank the layer. No upstream
 * and no prior cache is reported as a failure, never fabricated.
 * @param {object} options
 * @param {Map<string, {at:number, snapshot:object}>} options.cache
 * @param {string} options.baseUrl
 * @param {number} [options.ttlMs]
 * @param {()=>number} [options.now]
 * @param {(opts:{baseUrl:string})=>Promise<object>} [options.fetchSnapshot]
 * @returns {Promise<{status:number, body:object}>}
 */
export async function resolveLocalAdsbRequest({
  cache,
  baseUrl,
  ttlMs = LOCAL_ADSB_CACHE_TTL_MS,
  now = Date.now,
  fetchSnapshot = fetchLocalAdsbSnapshot,
}) {
  const cached = cache.get(baseUrl);
  const nowMs = now();
  if (cached && nowMs - cached.at < ttlMs) {
    return { status: 200, body: { ...cached.snapshot, stale: false, baseUrl } };
  }
  try {
    const snapshot = await fetchSnapshot({ baseUrl });
    cache.set(baseUrl, { at: nowMs, snapshot });
    return { status: 200, body: { ...snapshot, stale: false, baseUrl } };
  } catch (error) {
    if (cached) {
      return {
        status: 200,
        body: { ...cached.snapshot, stale: true, baseUrl },
      };
    }
    return {
      status: 502,
      body: { error: error?.reason || 'unreachable', baseUrl },
    };
  }
}
