import { inflateRawSync } from 'node:zlib';
import { sameSiteGated } from './common/same-site.js';
import { readResponseBytesCapped } from './common/http.js';
import {
  AMB_STOP_ID_PATTERN,
  buildAmbArrivalsIndex,
  buildAmbLines,
  buildAmbRoutes,
  buildAmbStops,
  buildAmbTrips,
  decodeTripUpdates,
} from '../../src/data/ambArrivals.js';
import { decodeAlerts } from '../../src/data/gtfsAlerts.js';
import {
  ambAlertMarks,
  ambStopAlerts,
} from '../../src/data/barcelonaAlerts.js';

/**
 * AMB (Àrea Metropolitana de Barcelona) bus arrivals — keyless.
 *
 * Three fixed upstream files, all from ambmobilitat.cat:
 *   - the static GTFS zip (stops, lines, trip headsigns and line shapes),
 *     refreshed daily;
 *   - the GTFS-Realtime TripUpdates feed, refreshed at most every 30 s and
 *     shared by every stop, so the number of stops viewers ask about never
 *     changes the traffic sent to AMB;
 *   - the GTFS-Realtime Alerts feed, refreshed at most every two minutes
 *     and shared the same way.
 *
 * Routes:
 *   GET /api/amb/stops → {stops: [{id, code, name, lat, lon}], fetchedAt}
 *   GET /api/amb/lines → {lines: [{name, desc, color, paths}], fetchedAt}
 *     Each line's route as AMB publishes it, from the same daily GTFS.
 *   GET /api/amb/alerts → {stops: [stopId], fetchedAt}: the stops with an
 *     active alert of their own (the ALERTS pill).
 *   GET /api/amb/arrivals/<stopId> → {kind: 'amb', id, fetchedAt, routes,
 *     alerts: [{header}]} (the stop's active alerts, from alerts.bin)
 *     `fetchedAt` is the feed's own timestamp (the licence asks for the date
 *     of the last update to be cited).
 *   Errors: 404 {error:'not_found'}, 502 {error:'unavailable'}.
 *
 * Licence: authorisation under Spanish Law 37/2007 — cite AMB and the date,
 * do not alter the content.
 */

export const AMB_GTFS_URL =
  'https://www.ambmobilitat.cat/OpenData/google_transit.zip';
export const AMB_TRIP_UPDATES_URL =
  'https://www.ambmobilitat.cat/transit/trips-updates/trips.bin';

/** How long the static GTFS answers before a refresh (published daily). */
/** AMB's GTFS-Realtime service alerts (detours, stops moved). */
export const AMB_ALERTS_URL =
  'https://www.ambmobilitat.cat/transit/alerts/alerts.bin';
/** How long one alerts file answers every stop card. */
export const AMB_ALERTS_TTL_MS = 120_000;
const AMB_ALERTS_MAX_BYTES = 4 * 1024 * 1024;
export const AMB_SCHEDULE_TTL_MS = 24 * 60 * 60_000;

/** How long one TripUpdates download answers (AMB regenerates ~30 s). */
export const AMB_TRIP_UPDATES_TTL_MS = 30_000;

const AMB_REQUEST_TIMEOUT_MS = 30_000;
const AMB_GTFS_MAX_BYTES = 32 * 1024 * 1024;
const AMB_GTFS_ENTRY_MAX_BYTES = 16 * 1024 * 1024;
const AMB_TRIP_UPDATES_MAX_BYTES = 4 * 1024 * 1024;
const GTFS_FILES = ['stops.txt', 'routes.txt', 'trips.txt', 'shapes.txt'];

/** An AMB failure the routes turn into a status code. */
export class AmbError extends Error {
  /** @param {'not_found'|'unavailable'} code */
  constructor(code) {
    super(`AMB ${code}`);
    this.code = code;
  }
}

/**
 * Read named entries from a zip archive (stored or deflated), each under a
 * hard size cap. Only the central directory is trusted for offsets; no path
 * is ever written to disk.
 * @param {Buffer} buffer
 * @param {string[]} names
 * @param {number} maxEntryBytes
 * @returns {Map<string, Buffer>}
 */
export function readZipEntries(buffer, names, maxEntryBytes) {
  const wanted = new Set(names);
  const files = new Map();
  let eocd = buffer.length - 22;
  const floor = Math.max(0, buffer.length - 22 - 0xffff);
  while (eocd >= floor && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  if (eocd < floor) throw new Error('zip: no end of central directory');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('zip: bad central directory entry');
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (!wanted.has(name)) continue;
    if (size > maxEntryBytes) throw new Error(`zip: ${name} too large`);
    if (buffer.readUInt32LE(local) !== 0x04034b50)
      throw new Error('zip: bad local header');
    const start =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + compressed);
    if (method === 0) files.set(name, Buffer.from(data));
    else if (method === 8)
      files.set(name, inflateRawSync(data, { maxOutputLength: maxEntryBytes }));
    else throw new Error(`zip: unsupported method ${method}`);
  }
  return files;
}

async function fetchBytes(fetchImpl, url, maxBytes, headers = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(AMB_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new AmbError('unavailable');
  }
  if (response.status === 304) return { notModified: true, response };
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new AmbError('unavailable');
  }
  try {
    return {
      bytes: Buffer.from(await readResponseBytesCapped(response, maxBytes)),
      response,
    };
  } catch {
    throw new AmbError('unavailable');
  }
}

/**
 * Stops, schedule and live arrivals. `fetchImpl` and `now` are injectable
 * for tests.
 * @param {{fetchImpl?: typeof fetch, now?: () => number}} [options]
 */
export function createAmbArrivalsService({
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  /** @type {{stops: object[], stopIds: Set<string>, routes: Map, trips: Map, fetchedAt: number}|null} */
  let schedule = null;
  /** @type {Promise<object>|null} */
  let scheduleInflight = null;
  /** @type {{trips: object[], index: Map, feedAt: number|null, at: number, etag: string|null}|null} */
  let live = null;
  /** @type {Promise<object>|null} */
  let liveInflight = null;
  /** @type {{alerts: object[]|null, at: number}|null} */
  let alertsLoad = null;
  /** @type {Promise<object[]|null>|null} */
  let alertsInflight = null;

  /**
   * AMB's alerts, at most every two minutes; the last good list kept when
   * a refresh fails. Never rejects: stops are served without alerts.
   */
  async function currentAlerts() {
    if (alertsLoad && now() - alertsLoad.at < AMB_ALERTS_TTL_MS)
      return alertsLoad.alerts;
    alertsInflight ??= (async () => {
      try {
        const { bytes } = await fetchBytes(
          fetchImpl,
          AMB_ALERTS_URL,
          AMB_ALERTS_MAX_BYTES,
        );
        alertsLoad = { alerts: decodeAlerts(bytes), at: now() };
      } catch {
        alertsLoad = { alerts: alertsLoad?.alerts ?? null, at: now() };
      }
      return alertsLoad.alerts;
    })().finally(() => {
      alertsInflight = null;
    });
    return alertsInflight;
  }

  async function loadSchedule() {
    const { bytes } = await fetchBytes(
      fetchImpl,
      AMB_GTFS_URL,
      AMB_GTFS_MAX_BYTES,
    );
    let files;
    try {
      files = readZipEntries(bytes, GTFS_FILES, AMB_GTFS_ENTRY_MAX_BYTES);
    } catch {
      throw new AmbError('unavailable');
    }
    // Shapes only draw the lines; arrivals work without them.
    if (GTFS_FILES.some((name) => name !== 'shapes.txt' && !files.has(name)))
      throw new AmbError('unavailable');
    const stops = buildAmbStops(files.get('stops.txt').toString('utf8'));
    if (!stops.length) throw new AmbError('unavailable');
    const routesCsv = files.get('routes.txt').toString('utf8');
    const tripsCsv = files.get('trips.txt').toString('utf8');
    schedule = {
      stops,
      stopIds: new Set(stops.map((stop) => stop.id)),
      routes: buildAmbRoutes(routesCsv),
      trips: buildAmbTrips(tripsCsv),
      lines: files.has('shapes.txt')
        ? buildAmbLines({
            shapesCsv: files.get('shapes.txt').toString('utf8'),
            tripsCsv,
            routesCsv,
          })
        : [],
      fetchedAt: now(),
    };
    return schedule;
  }

  async function currentSchedule() {
    if (schedule && now() - schedule.fetchedAt < AMB_SCHEDULE_TTL_MS)
      return schedule;
    scheduleInflight ??= loadSchedule().finally(() => {
      scheduleInflight = null;
    });
    try {
      return await scheduleInflight;
    } catch (error) {
      if (schedule) return schedule; // yesterday's stops are still right
      throw error;
    }
  }

  async function loadLive(current) {
    const headers = live?.etag ? { 'If-None-Match': live.etag } : {};
    const result = await fetchBytes(
      fetchImpl,
      AMB_TRIP_UPDATES_URL,
      AMB_TRIP_UPDATES_MAX_BYTES,
      headers,
    );
    const at = now();
    let { trips, feedAt, etag } = live || {};
    if (!result.notModified || !live) {
      if (result.notModified) throw new AmbError('unavailable');
      try {
        ({ trips, timestamp: feedAt } = decodeTripUpdates(result.bytes));
      } catch {
        throw new AmbError('unavailable');
      }
      etag = result.response.headers.get('etag');
    }
    // Re-indexed even when the file is unchanged, so buses that have gone
    // drop off the list.
    live = {
      trips,
      feedAt,
      etag,
      at,
      index: buildAmbArrivalsIndex(trips, current, at),
    };
    return live;
  }

  async function currentLive(current) {
    if (live && now() - live.at < AMB_TRIP_UPDATES_TTL_MS) return live;
    liveInflight ??= loadLive(current).finally(() => {
      liveInflight = null;
    });
    return liveInflight;
  }

  return {
    /** @returns {Promise<{stops: object[], fetchedAt: number}>} */
    async stops() {
      const current = await currentSchedule();
      return { stops: current.stops, fetchedAt: current.fetchedAt };
    },
    /** @returns {Promise<{stops: string[], fetchedAt: number}>} the stops with an active alert of their own */
    async alertedStops() {
      const current = await currentSchedule();
      const alerts = await currentAlerts();
      return {
        stops: alerts ? ambAlertMarks(alerts, current.stopIds, now()) : [],
        fetchedAt: alertsLoad?.at ?? now(),
      };
    },
    /** @returns {Promise<{lines: object[], fetchedAt: number}>} */
    async lines() {
      const current = await currentSchedule();
      return { lines: current.lines, fetchedAt: current.fetchedAt };
    },
    /**
     * @param {string} stopId
     * @returns {Promise<{kind: 'amb', id: string, fetchedAt: number,
     *   routes: object[], alerts: object[]}>}
     */
    async arrivals(stopId) {
      const id = String(stopId || '');
      if (!AMB_STOP_ID_PATTERN.test(id)) throw new AmbError('not_found');
      const current = await currentSchedule();
      if (!current.stopIds.has(id)) throw new AmbError('not_found');
      const [result, alerts] = await Promise.all([
        currentLive(current),
        currentAlerts(),
      ]);
      const routes = result.index.get(id) || [];
      // The GTFS routes of the lines arriving here, which AMB's alerts name.
      const names = new Set(routes.map((route) => route.line));
      const routeIds = [...current.routes]
        .filter(([, route]) => names.has(route.name))
        .map(([routeId]) => routeId);
      return {
        kind: 'amb',
        id,
        fetchedAt: result.feedAt ?? result.at,
        routes,
        alerts: alerts ? ambStopAlerts(alerts, id, routeIds, now()) : [],
      };
    },
  };
}

function sendJson(res, code, payload) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function sendAmbError(res, error) {
  const code = error instanceof AmbError ? error.code : 'unavailable';
  sendJson(res, code === 'not_found' ? 404 : 502, { error: code });
}

/**
 * Vite plugin: `/api/amb/stops`, `/api/amb/lines` and
 * `/api/amb/arrivals/<stopId>`.
 * @param {Parameters<typeof createAmbArrivalsService>[0]} [options]
 * @returns {import('vite').Plugin}
 */
export function ambProxy(options = {}) {
  const service = createAmbArrivalsService(options);
  function install(server) {
    server.middlewares.use(
      '/api/amb/stops',
      sameSiteGated(async (req, res) => {
        const rest = String(req.url || '/').split('?')[0];
        if (rest !== '/' && rest !== '')
          return sendJson(res, 404, { error: 'not_found' });
        if (req.method !== 'GET')
          return sendJson(res, 405, { error: 'Method not allowed' });
        try {
          return sendJson(res, 200, await service.stops());
        } catch (error) {
          return sendAmbError(res, error);
        }
      }),
    );
    server.middlewares.use(
      '/api/amb/lines',
      sameSiteGated(async (req, res) => {
        const rest = String(req.url || '/').split('?')[0];
        if (rest !== '/' && rest !== '')
          return sendJson(res, 404, { error: 'not_found' });
        if (req.method !== 'GET')
          return sendJson(res, 405, { error: 'Method not allowed' });
        try {
          return sendJson(res, 200, await service.lines());
        } catch (error) {
          return sendAmbError(res, error);
        }
      }),
    );
    server.middlewares.use(
      '/api/amb/alerts',
      sameSiteGated(async (req, res) => {
        const rest = String(req.url || '/').split('?')[0];
        if (rest !== '/' && rest !== '')
          return sendJson(res, 404, { error: 'not_found' });
        if (req.method !== 'GET')
          return sendJson(res, 405, { error: 'Method not allowed' });
        try {
          return sendJson(res, 200, await service.alertedStops());
        } catch (error) {
          return sendAmbError(res, error);
        }
      }),
    );
    server.middlewares.use(
      '/api/amb/arrivals',
      sameSiteGated(async (req, res) => {
        if (req.method !== 'GET')
          return sendJson(res, 405, { error: 'Method not allowed' });
        const match = /^\/([^/?]+)\/?(?:\?.*)?$/.exec(String(req.url || ''));
        if (!match) return sendJson(res, 404, { error: 'not_found' });
        try {
          return sendJson(res, 200, await service.arrivals(match[1]));
        } catch (error) {
          return sendAmbError(res, error);
        }
      }),
    );
  }
  return {
    name: 'amb-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
