import { sameSiteGated } from './common/same-site.js';
import { readResponseJsonCapped } from './common/http.js';
import {
  TMB_BUS_ID_PATTERN,
  TMB_METRO_ID_PATTERN,
  buildTmbBusLines,
  buildTmbBusStops,
  buildTmbMetroLines,
  buildTmbMetroStations,
  normalizeTmbBusArrivals,
  normalizeTmbMetroArrivals,
} from '../../src/data/tmbArrivals.js';
import {
  normalizeTmbBusAlerts,
  normalizeTmbMetroAlerts,
  tmbAlertMarks,
  tmbBusStopAlerts,
  tmbMetroStationAlerts,
} from '../../src/data/barcelonaAlerts.js';
import {
  createEstimateSmoother,
  estimateVehicles,
} from '../../src/data/estimatedPositions.js';
import {
  buildTmbMetroNetwork,
  tmbMetroNetworkCodes,
  tmbMetroSegmentPaths,
  tmbMetroTimelines,
} from '../../src/data/tmbMetroTimelines.js';

/**
 * TMB (Transports Metropolitans de Barcelona) developer API — key handling.
 *
 * The API needs an `app_id` + `app_key` pair (developer.tmb.cat), and its
 * licence binds reuse to the application named at registration, so this
 * provider is fork-local and server-side only: the pair lives in `.env`
 * (`TMB_APP_ID`, `TMB_APP_KEY`, set from the POWER UP panel) and never
 * reaches the browser, a response body, or a log line.
 *
 * Routes:
 *   GET /api/tmb/status → {hasKey, state, checkedAt}
 *     state: 'ok' | 'rejected' (TMB refused the pair) | 'unavailable'
 *     (TMB unreachable or answering something else) | null (no key).
 *   GET /api/tmb/stations → {metro: [...], bus: [...], lines: [...], fetchedAt}
 *     Metro station groups, bus stops and metro line geometry, trimmed and
 *     cached for a day.
 *   GET /api/tmb/metro-lines → {lines: [{name, paths}], fetchedAt}: the
 *     metro track alone (from the stations catalogue), which the Transit
 *     layer follows between estimated metro fixes.
 *   GET /api/tmb/bus-lines → {lines: [{name, desc, color, paths}], fetchedAt}
 *     Bus line geometry, cached for a day; asked for apart from the
 *     stations because it is larger and only drawn at street scale.
 *   GET /api/tmb/alerts → {metro: [group], bus: [code], lines: [name],
 *     fetchedAt}: the stations and stops with an active alert of their
 *     own, and the metro lines with a line-wide one (the ALERTS pill).
 *   GET /api/tmb/arrivals/metro/<group> and /api/tmb/arrivals/bus/<code>
 *     → {kind, id, fetchedAt, routes: [...], alerts: [{header}]}: next
 *     arrivals, cached 15 s, and the place's active service alerts (TMB's
 *     alerts lists, cached two minutes).
 *     The id must name a station or stop in the catalogue; the server
 *     builds the TMB URL, so the browser never chooses what is fetched.
 *   Errors: 503 {error:'no_key'}, 502 {error:'rejected'|'unavailable'},
 *   404 {error:'not_found'}, 429 {error:'busy'}.
 *
 * The check is one small request (metro line codes only), cached for ten
 * minutes per key pair and single-flight, so a page polling the status
 * cannot turn into traffic against the user's TMB application.
 */

/** Base of every TMB API request. Fixed: callers never supply a URL. */
export const TMB_API_BASE = 'https://api.tmb.cat/v1';

/** How long one credential check answers for the same key pair. */
export const TMB_STATUS_TTL_MS = 10 * 60_000;

/** Upstream timeout for the credential check. */
export const TMB_STATUS_TIMEOUT_MS = 15_000;

/**
 * The configured credential pair, or null when either half is missing.
 * @param {Record<string, string|undefined>} env
 * @returns {{appId: string, appKey: string}|null}
 */
export function tmbCredentials(env) {
  const appId = String(env?.TMB_APP_ID || '').trim();
  const appKey = String(env?.TMB_APP_KEY || '').trim();
  return appId && appKey ? { appId, appKey } : null;
}

/**
 * The URL of the credential check: the metro line list, trimmed to its
 * codes so the answer stays small.
 * @param {{appId: string, appKey: string}} credentials
 * @returns {string}
 */
export function tmbStatusUrl({ appId, appKey }) {
  const params = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    propertyName: 'CODI_LINIA',
  });
  return `${TMB_API_BASE}/transit/linies/metro?${params}`;
}

/**
 * Classify TMB's answer to the credential check without echoing it.
 * @param {number} status HTTP status.
 * @param {unknown} body Parsed JSON body, or null.
 * @returns {'ok'|'rejected'|'unavailable'}
 */
export function classifyTmbStatus(status, body) {
  if (status === 401 || status === 403) return 'rejected';
  if (status === 200 && body && body.type === 'FeatureCollection') return 'ok';
  return 'unavailable';
}

/**
 * Credential-check service. `env` and `fetchImpl` are injectable for tests.
 * @param {{env?: Record<string, string|undefined>, fetchImpl?: typeof fetch,
 *   now?: () => number}} [options]
 * @returns {{status: () => Promise<{hasKey: boolean, state: string|null,
 *   checkedAt: number|null}>}}
 */
export function createTmbStatusService({
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  /** @type {{pair: string, state: string, checkedAt: number}|null} */
  let last = null;
  /** @type {{pair: string, promise: Promise<object>}|null} */
  let inflight = null;

  async function check(credentials, pair) {
    let state = 'unavailable';
    try {
      const response = await fetchImpl(tmbStatusUrl(credentials), {
        headers: { Accept: 'application/json' },
        // Never follow a redirect: the URL carries the key pair.
        redirect: 'error',
        signal: AbortSignal.timeout(TMB_STATUS_TIMEOUT_MS),
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      state = classifyTmbStatus(response.status, body);
    } catch {
      state = 'unavailable';
    }
    last = { pair, state, checkedAt: now() };
    return last;
  }

  async function status() {
    const credentials = tmbCredentials(env);
    if (!credentials) return { hasKey: false, state: null, checkedAt: null };
    const pair = `${credentials.appId}\u0000${credentials.appKey}`;
    if (last?.pair === pair && now() - last.checkedAt < TMB_STATUS_TTL_MS) {
      return { hasKey: true, state: last.state, checkedAt: last.checkedAt };
    }
    if (inflight?.pair !== pair) {
      const promise = check(credentials, pair).finally(() => {
        if (inflight?.promise === promise) inflight = null;
      });
      inflight = { pair, promise };
    }
    const result = await inflight.promise;
    return { hasKey: true, state: result.state, checkedAt: result.checkedAt };
  }

  return { status };
}

/** How long the station and stop catalogue answers before a refresh. */
export const TMB_CATALOG_TTL_MS = 24 * 60 * 60_000;

/** How long one station's or stop's arrivals answer for every viewer. */
export const TMB_ARRIVALS_TTL_MS = 15_000;

/**
 * Upstream arrival requests allowed per rolling minute, across all ids. One
 * open card costs four a minute; this only stops a loop or a script from
 * spending the user's TMB application quota.
 */
export const TMB_ARRIVALS_PER_MINUTE = 30;

const TMB_REQUEST_TIMEOUT_MS = 15_000;
const TMB_CATALOG_MAX_BYTES = 8 * 1024 * 1024;
const TMB_ARRIVALS_MAX_BYTES = 512 * 1024;

const METRO_STATION_FIELDS = [
  'CODI_GRUP_ESTACIO',
  'CODI_ESTACIO',
  'NOM_ESTACIO',
  'NOM_LINIA',
  'COLOR_LINIA',
  'ORDRE_LINIA',
  'NOM_TIPUS_ESTAT',
  'GEOMETRY',
];
const BUS_STOP_FIELDS = ['CODI_PARADA', 'NOM_PARADA', 'GEOMETRY'];
const METRO_LINE_FIELDS = [
  'NOM_LINIA',
  'COLOR_LINIA',
  'ORDRE_LINIA',
  'GEOMETRY',
];
const BUS_LINE_FIELDS = [
  'NOM_LINIA',
  'DESC_LINIA',
  'COLOR_LINIA',
  'ORDRE_LINIA',
  'GEOMETRY',
];

/** A TMB failure the routes turn into a status code, never into its body. */
export class TmbError extends Error {
  /**
   * @param {'no_key'|'rejected'|'unavailable'|'not_found'|'busy'} code
   */
  constructor(code) {
    super(`TMB ${code}`);
    this.code = code;
  }
}

/** HTTP status for each TmbError code. */
export const TMB_ERROR_STATUS = Object.freeze({
  no_key: 503,
  rejected: 502,
  unavailable: 502,
  not_found: 404,
  busy: 429,
});

/**
 * A keyed TMB URL for one fixed path.
 * @param {string} path Path under TMB_API_BASE, starting with '/'.
 * @param {{appId: string, appKey: string}} credentials
 * @param {Record<string, string>} [params]
 * @returns {string}
 */
export function tmbApiUrl(path, { appId, appKey }, params = {}) {
  const query = new URLSearchParams({
    ...params,
    app_id: appId,
    app_key: appKey,
  });
  return `${TMB_API_BASE}${path}?${query}`;
}

/** Catalogue URLs: only the fields a marker and a click need. */
export function tmbCatalogUrls(credentials) {
  return {
    metro: tmbApiUrl('/transit/linies/metro/estacions', credentials, {
      propertyName: METRO_STATION_FIELDS.join(','),
    }),
    bus: tmbApiUrl('/transit/parades', credentials, {
      propertyName: BUS_STOP_FIELDS.join(','),
    }),
    lines: tmbApiUrl('/transit/linies/metro', credentials, {
      propertyName: METRO_LINE_FIELDS.join(','),
    }),
  };
}

/** Bus line list URL: names, colours and geometry only. */
export function tmbBusLinesUrl(credentials) {
  return tmbApiUrl('/transit/linies/bus', credentials, {
    propertyName: BUS_LINE_FIELDS.join(','),
  });
}

/** iMetro URL for every per-line code of one station group. */
export function tmbMetroArrivalsUrl(codes, credentials) {
  return tmbApiUrl('/itransit/metro/estacions', credentials, {
    estacions: codes.join(','),
  });
}

/** Service alerts as TMB's website shows them, metro or bus. */
export function tmbAlertsUrl(kind, credentials) {
  return tmbApiUrl(`/alerts/${kind}/channels/WEB`, credentials);
}

/** How long one alerts list answers every card. */
export const TMB_ALERTS_TTL_MS = 120_000;
const TMB_ALERTS_MAX_BYTES = 2 * 1024 * 1024;

/** iBus URL for one stop. */
export function tmbBusArrivalsUrl(code, credentials) {
  return tmbApiUrl(
    `/itransit/bus/parades/${encodeURIComponent(code)}`,
    credentials,
  );
}

/**
 * Fetch one keyed TMB URL and parse its JSON under a byte cap. Never follows
 * a redirect and never puts the URL or the body in an error.
 * @returns {Promise<unknown>}
 */
async function fetchTmbJson(fetchImpl, url, maxBytes) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(TMB_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new TmbError('unavailable');
  }
  if (response.status === 401 || response.status === 403) {
    void response.body?.cancel().catch(() => {});
    throw new TmbError('rejected');
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new TmbError('unavailable');
  }
  try {
    return await readResponseJsonCapped(response, maxBytes);
  } catch {
    throw new TmbError('unavailable');
  }
}

/**
 * Station and stop catalogue: two TMB requests a day, single-flight, and
 * the last good copy kept when a refresh fails.
 * @param {{env?: Record<string, string|undefined>, fetchImpl?: typeof fetch,
 *   now?: () => number}} [options]
 */
export function createTmbCatalogService({
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  /** @type {{pair: string, catalog: object, metroById: Map<string, object>, busIds: Set<string>, fetchedAt: number}|null} */
  let last = null;
  /** @type {{pair: string, promise: Promise<object>}|null} */
  let inflight = null;

  async function load(credentials, pair) {
    const urls = tmbCatalogUrls(credentials);
    const [metroBody, busBody, linesBody] = await Promise.all([
      fetchTmbJson(fetchImpl, urls.metro, TMB_CATALOG_MAX_BYTES),
      fetchTmbJson(fetchImpl, urls.bus, TMB_CATALOG_MAX_BYTES),
      // The line geometry decorates the map; stations work without it.
      fetchTmbJson(fetchImpl, urls.lines, TMB_CATALOG_MAX_BYTES).catch(
        (error) => {
          if (error?.code === 'rejected') throw error;
          return null;
        },
      ),
    ]);
    const metro = buildTmbMetroStations(metroBody);
    const bus = buildTmbBusStops(busBody);
    if (!metro?.length || !bus?.length) throw new TmbError('unavailable');
    const lines = buildTmbMetroLines(linesBody) || [];
    const fetchedAt = now();
    last = {
      pair,
      catalog: { metro, bus, lines, fetchedAt },
      metroById: new Map(metro.map((station) => [station.id, station])),
      busIds: new Set(bus.map((stop) => stop.id)),
      fetchedAt,
    };
    return last;
  }

  async function current() {
    const credentials = tmbCredentials(env);
    if (!credentials) throw new TmbError('no_key');
    const pair = `${credentials.appId}\u0000${credentials.appKey}`;
    const fresh =
      last?.pair === pair && now() - last.fetchedAt < TMB_CATALOG_TTL_MS;
    if (fresh) return last;
    if (inflight?.pair !== pair) {
      const promise = load(credentials, pair).finally(() => {
        if (inflight?.promise === promise) inflight = null;
      });
      inflight = { pair, promise };
    }
    try {
      return await inflight.promise;
    } catch (error) {
      // A day-old station list is still right; a refused key is not.
      if (last?.pair === pair && error?.code !== 'rejected') return last;
      throw error;
    }
  }

  return {
    /** @returns {Promise<{metro: object[], bus: object[], fetchedAt: number}>} */
    async catalog() {
      return (await current()).catalog;
    },
    /** @returns {Promise<number[]|null>} per-line codes of one group */
    async metroCodes(group) {
      return (await current()).metroById.get(group)?.codes ?? null;
    },
    /** @returns {Promise<object|null>} one station group (codes, lines) */
    async metroStation(group) {
      return (await current()).metroById.get(group) ?? null;
    },
    /** @returns {Promise<boolean>} */
    async hasBusStop(code) {
      return (await current()).busIds.has(code);
    },
  };
}

/**
 * Bus line geometry: one TMB request a day, single-flight, and the last good
 * copy kept when a refresh fails (never when TMB refused the key).
 * @param {{env?: Record<string, string|undefined>, fetchImpl?: typeof fetch,
 *   now?: () => number}} [options]
 */
export function createTmbBusLinesService({
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  /** @type {{pair: string, value: object, fetchedAt: number}|null} */
  let last = null;
  /** @type {{pair: string, promise: Promise<object>}|null} */
  let inflight = null;

  async function load(credentials, pair) {
    const body = await fetchTmbJson(
      fetchImpl,
      tmbBusLinesUrl(credentials),
      TMB_CATALOG_MAX_BYTES,
    );
    const lines = buildTmbBusLines(body);
    if (!lines?.length) throw new TmbError('unavailable');
    const fetchedAt = now();
    last = { pair, value: { lines, fetchedAt }, fetchedAt };
    return last;
  }

  return {
    /** @returns {Promise<{lines: object[], fetchedAt: number}>} */
    async lines() {
      const credentials = tmbCredentials(env);
      if (!credentials) throw new TmbError('no_key');
      const pair = `${credentials.appId}\u0000${credentials.appKey}`;
      if (last?.pair === pair && now() - last.fetchedAt < TMB_CATALOG_TTL_MS)
        return last.value;
      if (inflight?.pair !== pair) {
        const promise = load(credentials, pair).finally(() => {
          if (inflight?.promise === promise) inflight = null;
        });
        inflight = { pair, promise };
      }
      try {
        return (await inflight.promise).value;
      } catch (error) {
        if (last?.pair === pair && error?.code !== 'rejected')
          return last.value;
        throw error;
      }
    },
  };
}

/**
 * TMB's metro and bus alerts: one request per kind every two minutes at
 * most, single-flight, the last good list kept when a refresh fails (never
 * when TMB refused the key). Never rejects: a card without alerts is better
 * than no card.
 * @param {{env?: Record<string, string|undefined>, fetchImpl?: typeof fetch,
 *   now?: () => number}} [options]
 */
export function createTmbAlertsService({
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  /** @type {Map<string, {pair: string, alerts: object[], at: number}>} */
  const last = new Map();
  /** @type {Map<string, {pair: string, promise: Promise<object[]|null>}>} */
  const inflight = new Map();
  const normalize = {
    metro: normalizeTmbMetroAlerts,
    bus: normalizeTmbBusAlerts,
  };

  async function load(kind, credentials, pair) {
    try {
      const body = await fetchTmbJson(
        fetchImpl,
        tmbAlertsUrl(kind, credentials),
        TMB_ALERTS_MAX_BYTES,
      );
      const alerts = normalize[kind](body);
      last.set(kind, { pair, alerts, at: now() });
      return alerts;
    } catch (error) {
      const known = last.get(kind);
      if (error?.code === 'rejected') last.delete(kind);
      else if (known?.pair === pair) {
        // Not asked again before the interval passes.
        known.at = now();
        return known.alerts;
      }
      return null;
    }
  }

  return {
    /**
     * @param {'metro'|'bus'} kind
     * @returns {Promise<object[]|null>}
     */
    async list(kind) {
      if (!normalize[kind]) return null;
      const credentials = tmbCredentials(env);
      if (!credentials) return null;
      const pair = `${credentials.appId}\u0000${credentials.appKey}`;
      const known = last.get(kind);
      if (known?.pair === pair && now() - known.at < TMB_ALERTS_TTL_MS)
        return known.alerts;
      const pending = inflight.get(kind);
      if (pending?.pair === pair) return pending.promise;
      const promise = load(kind, credentials, pair).finally(() => {
        if (inflight.get(kind)?.promise === promise) inflight.delete(kind);
      });
      inflight.set(kind, { pair, promise });
      return promise;
    },
  };
}

/**
 * Next arrivals at one station group or bus stop: cached per id, one
 * request in flight per id, and a per-minute ceiling on upstream calls.
 * Each answer carries the place's active alerts (`alerts: [{header}]`).
 * @param {{env?: Record<string, string|undefined>, fetchImpl?: typeof fetch,
 *   now?: () => number, catalog?: ReturnType<typeof createTmbCatalogService>}} [options]
 */
export function createTmbArrivalsService({
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
  catalog = createTmbCatalogService({ env, fetchImpl, now }),
  alerts = createTmbAlertsService({ env, fetchImpl, now }),
} = {}) {
  /** @type {Map<string, {at: number, value: object}>} */
  const cache = new Map();

  /** The place's active alerts; none when TMB's lists are unavailable. */
  async function placeAlerts(kind, id, value) {
    try {
      const list = await alerts.list(kind);
      if (!list) return [];
      if (kind === 'metro')
        return tmbMetroStationAlerts(
          list,
          await catalog.metroStation(id),
          now(),
        );
      return tmbBusStopAlerts(
        list,
        id,
        (value.routes || []).map((route) => route.line),
        now(),
      );
    } catch {
      return [];
    }
  }
  /** @type {Map<string, Promise<object>>} */
  const inflight = new Map();
  /** @type {number[]} upstream call times in the last minute */
  let calls = [];

  async function fetchArrivals(kind, id, credentials) {
    let url;
    if (kind === 'metro') {
      const codes = await catalog.metroCodes(id);
      if (!codes?.length) throw new TmbError('not_found');
      url = tmbMetroArrivalsUrl(codes, credentials);
    } else {
      if (!(await catalog.hasBusStop(id))) throw new TmbError('not_found');
      url = tmbBusArrivalsUrl(id, credentials);
    }
    const at = now();
    calls = calls.filter((t) => at - t < 60_000);
    if (calls.length >= TMB_ARRIVALS_PER_MINUTE) throw new TmbError('busy');
    calls.push(at);
    const body = await fetchTmbJson(fetchImpl, url, TMB_ARRIVALS_MAX_BYTES);
    const normalized =
      kind === 'metro'
        ? normalizeTmbMetroArrivals(body)
        : normalizeTmbBusArrivals(body);
    if (!normalized) throw new TmbError('unavailable');
    const value = {
      kind,
      id,
      fetchedAt: normalized.fetchedAt ?? at,
      routes: normalized.routes,
    };
    cache.set(`${kind}:${id}`, { at, value });
    // Forget answers nobody can use any more, so the map stays small.
    for (const [key, entry] of cache) {
      if (at - entry.at >= TMB_ARRIVALS_TTL_MS) cache.delete(key);
    }
    return value;
  }

  return {
    /**
     * @param {'metro'|'bus'} kind
     * @param {string} id
     * @returns {Promise<object>}
     */
    async arrivals(kind, id) {
      const pattern =
        kind === 'metro' ? TMB_METRO_ID_PATTERN : TMB_BUS_ID_PATTERN;
      if ((kind !== 'metro' && kind !== 'bus') || !pattern.test(String(id)))
        throw new TmbError('not_found');
      const credentials = tmbCredentials(env);
      if (!credentials) throw new TmbError('no_key');
      const key = `${kind}:${id}`;
      const hit = cache.get(key);
      let value;
      if (hit && now() - hit.at < TMB_ARRIVALS_TTL_MS) value = hit.value;
      else {
        if (!inflight.has(key)) {
          const promise = fetchArrivals(kind, String(id), credentials).finally(
            () => inflight.delete(key),
          );
          inflight.set(key, promise);
        }
        value = await inflight.get(key);
      }
      return { ...value, alerts: await placeAlerts(kind, String(id), value) };
    },
  };
}

/** How long one iMetro answer for the whole network feeds the estimate. */
export const TMB_METRO_ESTIMATE_TTL_MS = 15_000;

/** Past this, a failed refresh no longer falls back to the last answer. */
export const TMB_METRO_ESTIMATE_STALE_MS = 3 * 60_000;

/** A train's top speed for easing a corrected estimate (L9 runs at 90 km/h). */
const TMB_METRO_MAX_SPEED_MPS = 25;

const TMB_METRO_NETWORK_FIELDS = [
  'CODI_ESTACIO',
  'NOM_ESTACIO',
  'NOM_LINIA',
  'ORDRE_ESTACIO',
  'GEOMETRY',
];

/** A failed line-geometry read is retried after this, not after a day. */
export const TMB_METRO_TRACK_RETRY_MS = 10 * 60_000;

/** The metro lines' geometry, for putting estimated trains on the track. */
export function tmbMetroLinesUrl(credentials) {
  return tmbApiUrl('/transit/linies/metro', credentials, {
    propertyName: 'NOM_LINIA,GEOMETRY',
  });
}

/** Every metro station with its line order: the estimator's network. */
export function tmbMetroNetworkUrl(credentials) {
  return tmbApiUrl('/transit/linies/metro/estacions', credentials, {
    propertyName: TMB_METRO_NETWORK_FIELDS.join(','),
  });
}

/**
 * Estimated metro positions for the Transit layer (registry row
 * `tmb-metro-estimated`, `estimate: 'tmb-metro'`). TMB publishes no train
 * positions; iMetro's predicted arrivals for every station, asked in ONE
 * request (about 100 KB) at most every TMB_METRO_ESTIMATE_TTL_MS, become one
 * timeline per train (tmbMetroTimelines.js), and the position engine places
 * each train on it at the moment of the call (estimatedPositions.js).
 *
 * Learned segment running times and the smoother live as long as the
 * process. A failed iMetro refresh keeps estimating from the last answer for
 * TMB_METRO_ESTIMATE_STALE_MS, so a short outage does not freeze the trains;
 * a refused key is never papered over.
 *
 * @param {{env?: Record<string, string|undefined>, fetchImpl?: typeof fetch,
 *   now?: () => number}} [options]
 */
export function createTmbMetroEstimator({
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  /** @type {{pair: string, value: object, fetchedAt: number}|null} */
  let network = null;
  /** @type {{pair: string, timelines: object[], timestamp: number|null, fetchedAt: number}|null} */
  let predictions = null;
  /** @type {Map<string, Promise<object>>} */
  const inflight = new Map();
  const runtimes = new Map();
  const smoother = createEstimateSmoother({
    maxSpeedMps: TMB_METRO_MAX_SPEED_MPS,
  });

  function once(key, load) {
    if (!inflight.has(key)) {
      const promise = load().finally(() => inflight.delete(key));
      inflight.set(key, promise);
    }
    return inflight.get(key);
  }

  async function networkFor(credentials, pair) {
    if (
      network?.pair === pair &&
      now() - network.fetchedAt < TMB_CATALOG_TTL_MS
    )
      return network.value;
    try {
      return await once(`network:${pair}`, async () => {
        const body = await fetchTmbJson(
          fetchImpl,
          tmbMetroNetworkUrl(credentials),
          TMB_CATALOG_MAX_BYTES,
        );
        const value = buildTmbMetroNetwork(body);
        if (!value) throw new TmbError('unavailable');
        // The line geometry puts the trains on the track; without it they
        // run straight between stations, as before.
        const lines = await fetchTmbJson(
          fetchImpl,
          tmbMetroLinesUrl(credentials),
          TMB_CATALOG_MAX_BYTES,
        ).catch((error) => {
          if (error?.code === 'rejected') throw error;
          return null;
        });
        value.segmentPath = tmbMetroSegmentPaths(buildTmbMetroLines(lines));
        network = { pair, value, fetchedAt: now() };
        return value;
      });
    } catch (error) {
      if (network?.pair === pair && error?.code !== 'rejected') {
        // Keep the old network, and do not ask again before the retry wait.
        network = {
          ...network,
          fetchedAt: Math.max(
            network.fetchedAt,
            now() - TMB_CATALOG_TTL_MS + TMB_METRO_TRACK_RETRY_MS,
          ),
        };
        return network.value;
      }
      throw error;
    }
  }

  /** The network, re-read early when its line geometry did not load. */
  async function currentNetwork(credentials, pair) {
    if (
      network?.pair === pair &&
      !network.value.segmentPath &&
      now() - network.fetchedAt >= TMB_METRO_TRACK_RETRY_MS
    )
      network = { ...network, fetchedAt: -Infinity };
    return networkFor(credentials, pair);
  }

  async function predictionsFor(credentials, pair) {
    if (
      predictions?.pair === pair &&
      now() - predictions.fetchedAt < TMB_METRO_ESTIMATE_TTL_MS
    )
      return predictions;
    const net = await currentNetwork(credentials, pair);
    try {
      return await once(`predictions:${pair}`, async () => {
        const body = await fetchTmbJson(
          fetchImpl,
          tmbMetroArrivalsUrl(tmbMetroNetworkCodes(net), credentials),
          TMB_ARRIVALS_MAX_BYTES,
        );
        if (!Array.isArray(body?.linies)) throw new TmbError('unavailable');
        const fetchedAt = now();
        const stamp = Number(body.timestamp);
        // Running times are learned once per answer, not once per estimate.
        predictions = {
          pair,
          segmentPath: net.segmentPath,
          timelines: tmbMetroTimelines(body, net, { runtimes }),
          timestamp: Number.isFinite(stamp) ? Math.floor(stamp / 1000) : null,
          fetchedAt,
        };
        return predictions;
      });
    } catch (error) {
      if (
        predictions?.pair === pair &&
        error?.code !== 'rejected' &&
        now() - predictions.fetchedAt < TMB_METRO_ESTIMATE_STALE_MS
      )
        return predictions;
      throw error;
    }
  }

  return {
    host: 'api.tmb.cat',
    /** Whether the key pair is configured. */
    available() {
      return tmbCredentials(env) !== null;
    },
    /**
     * @param {{now?: number, leadMs?: number}} [options] `leadMs`: place the
     *   trains this far ahead of `now` (registry `estimateLeadMs`).
     * @returns {Promise<{timestamp: number|null, sourceFetchedAt: number,
     *   vehicles: object[]}>}
     */
    async estimate({ now: at = now(), leadMs = 0 } = {}) {
      const credentials = tmbCredentials(env);
      if (!credentials) throw new TmbError('no_key');
      const pair = `${credentials.appId}\u0000${credentials.appKey}`;
      const current = await predictionsFor(credentials, pair);
      return {
        timestamp: current.timestamp,
        sourceFetchedAt: current.fetchedAt,
        vehicles: estimateVehicles(
          current.timelines,
          at + (Number.isFinite(leadMs) && leadMs > 0 ? leadMs : 0),
          {
            smoother,
            source: 'predictions',
            madeAt: at,
            segmentPath: current.segmentPath ?? undefined,
          },
        ),
      };
    },
  };
}

/**
 * The metro lines' track alone, for the Transit layer to follow between two
 * estimated fixes (registry `trackGeometry` of `tmb-metro-estimated`): the
 * stations catalogue without its stations and stops.
 * @param {{lines?: Array<{name: string, paths: number[][]}>, fetchedAt?: number}} catalog
 */
export function tmbMetroLinesBody(catalog) {
  return {
    lines: (Array.isArray(catalog?.lines) ? catalog.lines : []).map(
      ({ name, paths }) => ({ name, paths }),
    ),
    fetchedAt: catalog?.fetchedAt ?? null,
  };
}

function sendJson(res, code, payload, headers = {}) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function sendTmbError(res, error) {
  const code = error instanceof TmbError ? error.code : 'unavailable';
  sendJson(
    res,
    TMB_ERROR_STATUS[code] ?? 502,
    { error: code },
    code === 'busy' ? { 'Retry-After': '60' } : {},
  );
}

/**
 * Vite plugin: `/api/tmb/status` for development and preview.
 * @param {Parameters<typeof createTmbStatusService>[0]} [options]
 * @returns {import('vite').Plugin}
 */
export function tmbProxy(options = {}) {
  const service = createTmbStatusService(options);
  const catalog = createTmbCatalogService(options);
  const alerts = createTmbAlertsService(options);
  const arrivals = createTmbArrivalsService({ ...options, catalog, alerts });
  const busLines = createTmbBusLinesService(options);
  function install(server) {
    server.middlewares.use(
      '/api/tmb/status',
      sameSiteGated(async (req, res) => {
        const rest = String(req.url || '/').split('?')[0];
        if (rest !== '/' && rest !== '')
          return sendJson(res, 404, { error: 'Not found' });
        if (req.method !== 'GET')
          return sendJson(res, 405, { error: 'Method not allowed' });
        return sendJson(res, 200, await service.status());
      }),
    );
    server.middlewares.use(
      '/api/tmb/stations',
      sameSiteGated(async (req, res) => {
        const rest = String(req.url || '/').split('?')[0];
        if (rest !== '/' && rest !== '')
          return sendJson(res, 404, { error: 'not_found' });
        if (req.method !== 'GET')
          return sendJson(res, 405, { error: 'Method not allowed' });
        try {
          return sendJson(res, 200, await catalog.catalog());
        } catch (error) {
          return sendTmbError(res, error);
        }
      }),
    );
    server.middlewares.use(
      '/api/tmb/metro-lines',
      sameSiteGated(async (req, res) => {
        const rest = String(req.url || '/').split('?')[0];
        if (rest !== '/' && rest !== '')
          return sendJson(res, 404, { error: 'not_found' });
        if (req.method !== 'GET')
          return sendJson(res, 405, { error: 'Method not allowed' });
        try {
          return sendJson(res, 200, tmbMetroLinesBody(await catalog.catalog()));
        } catch (error) {
          return sendTmbError(res, error);
        }
      }),
    );
    server.middlewares.use(
      '/api/tmb/bus-lines',
      sameSiteGated(async (req, res) => {
        const rest = String(req.url || '/').split('?')[0];
        if (rest !== '/' && rest !== '')
          return sendJson(res, 404, { error: 'not_found' });
        if (req.method !== 'GET')
          return sendJson(res, 405, { error: 'Method not allowed' });
        try {
          return sendJson(res, 200, await busLines.lines());
        } catch (error) {
          return sendTmbError(res, error);
        }
      }),
    );
    server.middlewares.use(
      '/api/tmb/alerts',
      sameSiteGated(async (req, res) => {
        const rest = String(req.url || '/').split('?')[0];
        if (rest !== '/' && rest !== '')
          return sendJson(res, 404, { error: 'not_found' });
        if (req.method !== 'GET')
          return sendJson(res, 405, { error: 'Method not allowed' });
        try {
          const places = await catalog.catalog();
          const [metro, bus] = await Promise.all([
            alerts.list('metro'),
            alerts.list('bus'),
          ]);
          return sendJson(res, 200, {
            ...tmbAlertMarks({
              metro,
              bus,
              stations: places.metro,
              stops: places.bus,
              now: Date.now(),
            }),
            fetchedAt: Date.now(),
          });
        } catch (error) {
          return sendTmbError(res, error);
        }
      }),
    );
    server.middlewares.use(
      '/api/tmb/arrivals',
      sameSiteGated(async (req, res) => {
        if (req.method !== 'GET')
          return sendJson(res, 405, { error: 'Method not allowed' });
        const match = /^\/(metro|bus)\/([^/?]+)\/?(?:\?.*)?$/.exec(
          String(req.url || ''),
        );
        if (!match) return sendJson(res, 404, { error: 'not_found' });
        try {
          return sendJson(
            res,
            200,
            await arrivals.arrivals(match[1], match[2]),
          );
        } catch (error) {
          return sendTmbError(res, error);
        }
      }),
    );
  }
  return {
    name: 'tmb-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
