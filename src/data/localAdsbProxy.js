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

/**
 * Validate and normalize one dump1090/readsb aircraft.json row into a
 * client-safe shape. Returns null for anything missing a usable identity or
 * position — never a partially-trusted guess.
 * @param {object} raw
 * @returns {{hex:string, flight:string|null, lat:number, lon:number,
 *   altitudeFt:number|null, trackDeg:number|null, groundSpeedKt:number|null,
 *   seenS:number|null}|null}
 */
export function normalizeLocalAdsbAircraft(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const hex = typeof raw.hex === 'string' ? raw.hex.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{6}$/.test(hex)) return null;
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) return null;
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) return null;

  const rawAlt = raw.alt_baro ?? raw.altitude;
  const altitudeFt =
    rawAlt === 'ground'
      ? 0
      : Number.isFinite(Number(rawAlt))
        ? Number(rawAlt)
        : null;
  const trackDeg = Number.isFinite(Number(raw.track))
    ? Number(raw.track)
    : null;
  const rawSpeed = raw.gs ?? raw.speed;
  const groundSpeedKt = Number.isFinite(Number(rawSpeed))
    ? Number(rawSpeed)
    : null;
  const flight = typeof raw.flight === 'string' ? raw.flight.trim() : '';
  const seenS = Number.isFinite(Number(raw.seen)) ? Number(raw.seen) : null;

  return {
    hex,
    flight: flight || null,
    lat,
    lon,
    altitudeFt,
    trackDeg,
    groundSpeedKt,
    seenS,
  };
}

/**
 * Validate and normalize a raw dump1090/readsb `aircraft.json` body.
 * Returns null for anything that isn't at least a plausible payload of that
 * shape (tar1090 and readsb both serve `{now, aircraft: [...]}`).
 * @param {unknown} json
 * @returns {{receiverNowS:number|null, aircraft:Array}|null}
 */
export function normalizeLocalAdsbSnapshot(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  if (!Array.isArray(json.aircraft)) return null;
  const aircraft = [];
  for (const raw of json.aircraft) {
    const row = normalizeLocalAdsbAircraft(raw);
    if (row) aircraft.push(row);
    if (aircraft.length >= MAX_AIRCRAFT) break;
  }
  const receiverNowS = Number.isFinite(Number(json.now))
    ? Number(json.now)
    : null;
  return { receiverNowS, aircraft };
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
