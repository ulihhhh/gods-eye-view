import { createTransitHistory } from './transitHistoryStore.js';
/**
 * GTFS-Realtime transit proxy for the Transit data layer.
 *
 * Only URLs registered in `src/data/transitFeeds.js` are ever fetched — the
 * browser names a registered id, never a URL. Pure request/cache mechanics
 * live in `src/data/transitProxy.js` so the offline suite covers them.
 */

import { coalesceProxyRequest, readResponseBytesCapped } from './httpBody.js';
import { makeRateLimiter } from './rateLimit.js';
import { publicTransitCatalog } from '../data/transitFeeds.js';
import {
  TRANSIT_ADMISSION_MAX_GLOBAL,
  TRANSIT_ADMISSION_MAX_PER_FEED,
  TRANSIT_ADMISSION_WINDOW_MS,
  TRANSIT_MAX_REDIRECTS,
  TRANSIT_PROXY_MAX_BODY_BYTES,
  TRANSIT_PROXY_TIMEOUT_MS,
  TransitFeedShapeError,
  buildTransitSnapshot,
  excludeYieldedVehicles,
  isAcceptableTransitUpstreamUrl,
  isTransitRedirectStatus,
  nextTransitBackoffMs,
  resolveTransitRoute,
  transitCacheState,
  transitFeedTtlMs,
  transitRetryAfterMs,
  transitRedirectDecision,
  transitResponseHeaders,
  transitUpstreamHeaders,
} from '../data/transitProxy.js';
import { indexTripUpdates } from '../data/transitServiceFields.js';
import { decodeAlerts } from '../data/gtfsAlerts.js';
import { publicTransitAlerts } from '../data/transitServiceFields.js';
import {
  buildTimetableArrivals,
  buildTransitArrivals,
} from '../data/transitArrivals.js';
import { readZipTextEntries, zipEntryLines } from '../data/zipEntries.js';

/** A TripUpdates index this old is no longer joined to positions. */
export const TRANSIT_TRIP_UPDATES_STALE_MS = 5 * 60_000;
/** Static trip details (registry `tripDetails`): refresh, retry, limits. */
export const TRANSIT_TRIP_DETAILS_REFRESH_MS = 24 * 60 * 60_000;
export const TRANSIT_TRIP_DETAILS_RETRY_MS = 60 * 60_000;
export const TRANSIT_TRIP_DETAILS_TIMEOUT_MS = 120_000;
export const TRANSIT_TRIP_DETAILS_MAX_BYTES = 64 * 1024 * 1024;
/** A streamed timetable entry (Renfe Cercanías' stop_times.txt is ≈280 MB). */
export const TRANSIT_TIMETABLE_MAX_ENTRY_BYTES = 512 * 1024 * 1024;

/** `YYYYMMDD` of an instant in a feed's time zone (a timetable's `builtFor`). */
function localDayKey(ms, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    ...(timeZone ? { timeZone } : {}),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(ms)
    .replaceAll('-', '');
}

/**
 * Fetch a registered feed, resolving each redirect hop BEFORE following it.
 *
 * `redirect: 'follow'` hands the hop to the runtime and only lets us inspect
 * where it landed — by which point a disallowed host has already been
 * contacted and has already answered. Each hop is therefore requested with
 * `redirect: 'manual'` and its `Location` checked against the feed's own https
 * origin first, the rule the CCTV frame proxy applies to camera images.
 *
 * @param {object} feed Registry entry.
 * @param {AbortSignal} signal Abort signal for the whole hop chain.
 * @param {typeof fetch} [fetchImpl] Injected for tests.
 * @param {{etag?: string|null, lastModified?: string|null}} [validators] Cached validators.
 * @returns {Promise<{response: Response, finalUrl: string}>}
 */
export async function fetchTransitFeed(
  feed,
  signal,
  fetchImpl = fetch,
  validators = null,
) {
  let current = feed.url;
  for (let hop = 0; hop <= TRANSIT_MAX_REDIRECTS; hop += 1) {
    const response = await fetchImpl(current, {
      signal,
      headers: transitUpstreamHeaders(feed, validators),
      redirect: 'manual',
    });
    // Only a real redirect is followed. A 304 is the successful answer to our
    // own conditional request and has no Location; sending it round this loop
    // fails a feed that is simply unchanged.
    if (!isTransitRedirectStatus(response?.status)) {
      return { response, finalUrl: current };
    }
    const decision = transitRedirectDecision(
      feed.url,
      current,
      response.headers.get('location'),
    );
    try {
      await response.body?.cancel();
    } catch {
      /* no-op */
    }
    if (!decision.ok) throw new Error(`upstream ${decision.reason}`);
    if (hop === TRANSIT_MAX_REDIRECTS) {
      throw new Error('upstream redirected too many times');
    }
    current = decision.url;
  }
  throw new Error('upstream redirected too many times');
}

/** How far back a vehicle's recent stretch reaches, and how many fixes. */
export const TRANSIT_RECENT_WINDOW_MS = 8 * 60_000;
export const TRANSIT_RECENT_MAX_FIXES = 8;

/**
 * Vite plugin: GTFS-Realtime VehiclePositions proxy for the Transit layer.
 *
 *   GET /api/transit/feeds              → public catalog (coverage + credit)
 *   GET /api/transit/vehicles/<feedId>  → decoded snapshot as JSON
 *   GET /api/transit/arrivals/<feedId>/<stationId> → the station's next
 *       trains (feeds with `tripUpdates`; see src/data/transitArrivals.js)
 *   GET /api/transit/alerts/<feedId>    → the feed's active service alerts
 *       (feeds with `alerts`; see src/data/gtfsAlerts.js)
 *
 * Only URLs in `src/data/transitFeeds.js` are ever fetched — the browser
 * names a registered id, never a URL (SECURITY.md). Redirects are resolved hop
 * by hop and must stay on the feed's own https origin. Bytes are capped at
 * TRANSIT_PROXY_MAX_BODY_BYTES and decoded server-side, so the browser never
 * parses protobuf. Per feed: 15 s memory cache, single-flight refresh, and
 * serve-stale-on-failure for up to 10 minutes (the launch-library pattern).
 * No disk cache — transit positions are worthless after a few minutes.
 *
 * Two backstops sit in front of every upstream request. A fixed-window
 * admission limiter bounds how often this process may ask any one operator,
 * and all of them together, no matter how many browser tabs are open. A
 * per-feed cooldown ladder then keeps a feed that is genuinely down from being
 * re-asked once per poll for a whole session: consecutive failures push the
 * next permitted attempt out to five minutes, and one success resets it.
 *
 * @param {{fetchImpl?: typeof fetch}} [options]
 * @returns {{handle: (request: Request) => Promise<Response>, close: () => void}}
 */
export function createTransitService({ fetchImpl = fetch } = {}) {
  /** @type {Map<string, {at:number, body:string, host:string}>} feedId → snapshot */
  const cache = new Map();
  const history = createTransitHistory();
  const admitHistory = makeRateLimiter({
    windowMs: 60000,
    max: 30,
    globalMax: 120,
  });
  // Station boards are computed from cached data, but each one parses a
  // snapshot: bounded like the trail reads.
  const admitArrivals = makeRateLimiter({
    windowMs: 60000,
    max: 60,
    globalMax: 240,
  });
  let closed = false;
  const inFlight = new Map();
  const controllers = new Set();
  /** @type {Map<string, {failures:number, nextAttemptAt:number, reason:string}>} */
  const cooldown = new Map();
  const admit = makeRateLimiter({
    windowMs: TRANSIT_ADMISSION_WINDOW_MS,
    max: TRANSIT_ADMISSION_MAX_PER_FEED,
    globalMax: TRANSIT_ADMISSION_MAX_GLOBAL,
  });

  function reply(status, body, headers) {
    return new Response(body, { status, headers });
  }

  function noteFailure(feedId, reason, now, minWaitMs = 0) {
    const previous = cooldown.get(feedId);
    const failures = (previous?.failures || 0) + 1;
    const wait = Math.max(nextTransitBackoffMs(failures), minWaitMs);
    cooldown.set(feedId, { failures, nextAttemptAt: now + wait, reason });
    return wait;
  }

  /** @type {Map<string, {promise: Promise<object|null>, at: number}>} */
  const stopDictionaryLoads = new Map();

  /**
   * One of the feed's station dictionaries (registry `stopNames()` or
   * `stopPlaces()`), loaded once and shared. A failed load serves the
   * snapshot without it and is retried after a minute, never on every poll.
   * @param {object} feed
   * @param {'stopNames'|'stopPlaces'} hook
   * @param {number} now
   * @returns {Promise<Readonly<Record<string, unknown>>|null>}
   */
  function stopDictionaryFor(feed, hook, now) {
    if (typeof feed[hook] !== 'function') return Promise.resolve(null);
    const key = `${feed.id}\u0000${hook}`;
    const known = stopDictionaryLoads.get(key);
    if (known && (known.ok || now - known.at < 60_000)) return known.promise;
    const load = {
      at: now,
      ok: false,
      promise: Promise.resolve()
        .then(() => feed[hook]())
        .then(
          (dictionary) => {
            load.ok = Boolean(dictionary);
            return dictionary || null;
          },
          (error) => {
            console.warn(
              `[transit] ${feed.id} station ${hook === 'stopNames' ? 'names' : 'positions'} unavailable:`,
              error?.message || error,
            );
            return null;
          },
        ),
    };
    stopDictionaryLoads.set(key, load);
    return load.promise;
  }

  /**
   * GTFS-Realtime companions of a feed's positions, by registry hook: the
   * TripUpdates index and the service Alerts.
   */
  const COMPANIONS = Object.freeze({
    tripUpdates: Object.freeze({
      decode: indexTripUpdates,
      label: 'trip updates', // i18n-ignore: console log only
    }),
    alerts: Object.freeze({ decode: decodeAlerts, label: 'alerts' }),
  });

  /** @type {Map<string, {at: number, fetchedAt: number|null, index: object|null, promise: Promise<object|null>|null}>} feed id + hook → load */
  const companionLoads = new Map();
  const companionKey = (feed, hook) => `${feed.id}\u0000${hook}`;

  /**
   * One of the feed's GTFS-Realtime companions (registry `tripUpdates` or
   * `alerts`: `{url, minIntervalMs?}`), fetched at most once per its own
   * interval (`minIntervalMs`, else the proxy TTL) and shared by every
   * request. A failed fetch keeps the last answer while it is younger than
   * TRANSIT_TRIP_UPDATES_STALE_MS, and is not retried before the interval
   * passes. Never rejects: positions are served without it rather than not
   * at all.
   * @param {object} feed
   * @param {'tripUpdates'|'alerts'} hook
   * @param {number} now
   * @returns {Promise<object|null>}
   */
  function companionFor(feed, hook, now) {
    const source = feed[hook];
    if (!source?.url) return Promise.resolve(null);
    const key = companionKey(feed, hook);
    const known = companionLoads.get(key);
    if (known?.promise) return known.promise;
    const usable = (load) =>
      load?.index && now - load.fetchedAt < TRANSIT_TRIP_UPDATES_STALE_MS
        ? load.index
        : null;
    if (known && now - known.at < transitFeedTtlMs(source))
      return Promise.resolve(usable(known));
    const load = {
      at: now,
      fetchedAt: known?.fetchedAt ?? null,
      index: known?.index ?? null,
      promise: null,
    };
    load.promise = (async () => {
      const controller = new AbortController();
      controllers.add(controller);
      const timeout = setTimeout(
        () => controller.abort(),
        TRANSIT_PROXY_TIMEOUT_MS,
      );
      try {
        const { response, finalUrl } = await fetchTransitFeed(
          { ...feed, url: source.url, format: 'gtfs-rt' },
          controller.signal,
          fetchImpl,
        );
        if (!isAcceptableTransitUpstreamUrl(finalUrl))
          throw new Error('upstream is not https');
        if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
        const bytes = await readResponseBytesCapped(
          response,
          TRANSIT_PROXY_MAX_BODY_BYTES,
        );
        load.index = COMPANIONS[hook].decode(bytes);
        load.fetchedAt = now;
      } catch (error) {
        if (!closed)
          console.warn(
            `[transit] ${feed.id} ${COMPANIONS[hook].label} unavailable:`,
            error?.message || error,
          );
      } finally {
        clearTimeout(timeout);
        controller.abort();
        controllers.delete(controller);
        load.promise = null;
      }
      return usable(load);
    })();
    companionLoads.set(key, load);
    return load.promise;
  }

  /** The feed's TripUpdates index (`tripId → {delaySec, stops}`). */
  const tripUpdatesFor = (feed, now) => companionFor(feed, 'tripUpdates', now);
  /** The feed's service alerts (src/data/gtfsAlerts.js). */
  const alertsFor = (feed, now) => companionFor(feed, 'alerts', now);
  const companionFetchedAt = (feed, hook) =>
    companionLoads.get(companionKey(feed, hook))?.fetchedAt ?? null;

  /** @type {Map<string, {at: number, lookup: Map<string, object>|null, timetable: object|null, etag: string|null, lastModified: string|null, loading: boolean}>} */
  const tripDetailLoads = new Map();

  /**
   * The feed's static trip lookup (registry `tripDetails: {url, files,
   * build, maxBytes?, maxEntryBytes?}`): a GTFS zip read once a day
   * (conditional request), the named files handed to `build`. Returns what
   * is loaded NOW and never waits: the first positions after a start go out
   * without service names, and a failed load keeps the previous lookup and
   * is retried after an hour.
   * @param {object} feed
   * @param {number} now
   * @returns {Map<string, object>|null}
   */
  function tripDetailsFor(feed, now) {
    const source = feed.tripDetails;
    if (!source?.url || typeof source.build !== 'function') return null;
    const known = tripDetailLoads.get(feed.id);
    if (known && (known.loading || now < known.at)) return known.lookup;
    const load = {
      at: now + TRANSIT_TRIP_DETAILS_RETRY_MS,
      lookup: known?.lookup ?? null,
      timetable: known?.timetable ?? null,
      etag: known?.etag ?? null,
      lastModified: known?.lastModified ?? null,
      loading: true,
    };
    tripDetailLoads.set(feed.id, load);
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(
      () => controller.abort(),
      TRANSIT_TRIP_DETAILS_TIMEOUT_MS,
    );
    (async () => {
      const { response, finalUrl } = await fetchTransitFeed(
        {
          ...feed,
          url: source.url,
          format: 'gtfs-rt',
          headers: { ...feed.headers, Accept: 'application/zip, */*;q=0.1' },
        },
        controller.signal,
        fetchImpl,
        // A timetable is for the days around the day it was built: a new
        // day asks for the whole zip again even if it has not changed.
        load.lookup &&
          (!source.timetable ||
            load.timetable?.builtFor === localDayKey(now, feed.timeZone))
          ? { etag: load.etag, lastModified: load.lastModified }
          : null,
      );
      if (!isAcceptableTransitUpstreamUrl(finalUrl))
        throw new Error('upstream is not https');
      if (response.status === 304 && load.lookup) {
        await response.body?.cancel();
      } else {
        if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
        const bytes = await readResponseBytesCapped(
          response,
          Math.min(
            source.maxBytes || TRANSIT_TRIP_DETAILS_MAX_BYTES,
            TRANSIT_TRIP_DETAILS_MAX_BYTES,
          ),
        );
        const files = await readZipTextEntries(
          bytes,
          source.files,
          Math.min(
            source.maxEntryBytes || TRANSIT_TRIP_DETAILS_MAX_BYTES,
            TRANSIT_TRIP_DETAILS_MAX_BYTES,
          ),
        );
        const lookup = source.build(files);
        if (!(lookup instanceof Map) || !lookup.size)
          throw new Error('no trips in the schedule');
        load.lookup = lookup;
        if (typeof source.timetable === 'function') {
          // The station boards' timetable; the trip details stand without it.
          try {
            load.timetable = await source.timetable({
              files,
              lines: (name) =>
                zipEntryLines(bytes, name, TRANSIT_TIMETABLE_MAX_ENTRY_BYTES),
              now: Date.now(),
              timeZone: feed.timeZone,
            });
          } catch (error) {
            if (!closed)
              console.warn(
                `[transit] ${feed.id} timetable unavailable:`,
                error?.message || error,
              );
          }
        }
        load.etag = response.headers.get('etag');
        load.lastModified = response.headers.get('last-modified');
      }
      load.at =
        Date.now() + (source.refreshMs || TRANSIT_TRIP_DETAILS_REFRESH_MS);
    })()
      .catch((error) => {
        if (!closed)
          console.warn(
            `[transit] ${feed.id} trip details unavailable:`,
            error?.message || error,
          );
      })
      .finally(() => {
        clearTimeout(timeout);
        controller.abort();
        controllers.delete(controller);
        load.loading = false;
      });
    return load.lookup;
  }

  /**
   * The feed's station timetable (registry `tripDetails.timetable`), built
   * with its trip details; null until the first load has finished.
   * @param {object} feed
   * @param {number} now
   */
  function timetableFor(feed, now) {
    tripDetailsFor(feed, now);
    return tripDetailLoads.get(feed.id)?.timetable ?? null;
  }

  /**
   * The stretch each vehicle travelled just before its current position, from
   * the retained history (`recent: [[tMs, lat, lon], …]`, oldest first), so a
   * browser that sees it for the first time can play it from a few minutes
   * back at once, instead of holding it still until enough reports arrive.
   * Feeds without history are untouched.
   * @param {object} feed
   * @param {object} snapshot
   * @param {number} now
   * @returns {object}
   */
  function attachRecent(feed, snapshot, now) {
    if (feed.historyRetention !== true) return snapshot;
    for (const vehicle of snapshot.vehicles) {
      const recent = history.recent(
        feed.id,
        vehicle.id,
        vehicle.lat,
        vehicle.lon,
        {
          sinceMs: now - TRANSIT_RECENT_WINDOW_MS,
          limit: TRANSIT_RECENT_MAX_FIXES,
        },
      );
      if (recent.length) vehicle.recent = recent;
    }
    return snapshot;
  }

  /**
   * Apply the registry's `yieldsTo`: drop vehicles the preferred feed reported
   * in its latest cached snapshot (fresh or serve-stale). Before that feed has
   * been fetched there is nothing to yield to, and both feeds show the train.
   */
  function yieldShared(feed, snapshot) {
    if (!feed.yieldsTo) return snapshot;
    const preferred = cache.get(feed.yieldsTo);
    if (
      !preferred ||
      transitCacheState(preferred, snapshot.fetchedAt) === 'expired'
    )
      return excludeYieldedVehicles(snapshot, null);
    let vehicles = null;
    try {
      vehicles = JSON.parse(preferred.body).vehicles;
    } catch {
      vehicles = null;
    }
    return excludeYieldedVehicles(snapshot, vehicles);
  }

  async function refresh(feed, now) {
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(
      () => controller.abort(),
      TRANSIT_PROXY_TIMEOUT_MS,
    );
    const previous = cache.get(feed.id);
    // Asked beside the positions, not after them.
    const tripUpdates = tripUpdatesFor(feed, now);
    const alerts = alertsFor(feed, now);
    try {
      const { response, finalUrl } = await fetchTransitFeed(
        feed,
        controller.signal,
        fetchImpl,
        previous
          ? { etag: previous.etag, lastModified: previous.lastModified }
          : null,
      );
      if (closed) throw new Error('Transit provider closed');
      if (!isAcceptableTransitUpstreamUrl(finalUrl)) {
        throw new Error('upstream is not https');
      }
      // Nothing changed upstream: keep the snapshot we have and restart its
      // freshness window rather than asking for a body we already hold.
      if (response.status === 304 && previous) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        // `at` restarts the freshness window; `contactedAt` records that the
        // operator answered just now. They are different facts: the body still
        // carries the fetch time of the payload it holds, and reading that as
        // "when did we last hear from them" would age a feed that is answering
        // every single request into silence.
        const revalidated = { ...previous, at: now, contactedAt: now };
        cache.set(feed.id, revalidated);
        cooldown.delete(feed.id);
        return revalidated;
      }
      if (!response.ok) {
        const error = new Error(`upstream HTTP ${response.status}`);
        error.upstreamStatus = response.status;
        error.retryAfterMs = transitRetryAfterMs(
          response.headers?.get?.('retry-after'),
        );
        throw error;
      }
      const bytes = await readResponseBytesCapped(
        response,
        TRANSIT_PROXY_MAX_BODY_BYTES,
      );
      const [stopNames, stopPlaces, tripIndex, alertList] = await Promise.all([
        stopDictionaryFor(feed, 'stopNames', now),
        stopDictionaryFor(feed, 'stopPlaces', now),
        tripUpdates,
        alerts,
      ]);
      const snapshot = yieldShared(
        feed,
        buildTransitSnapshot(feed, bytes, now, {
          stopNames,
          stopPlaces,
          tripUpdates: tripIndex,
          tripDetails: tripDetailsFor(feed, now),
          alerts: alertList,
        }),
      );
      if (closed) throw new Error('Transit provider closed');
      history.ingest(feed, snapshot.vehicles, Date.now());
      attachRecent(feed, snapshot, Date.now());
      const entry = {
        at: snapshot.fetchedAt,
        contactedAt: snapshot.fetchedAt,
        body: JSON.stringify(snapshot),
        host: new URL(finalUrl).hostname,
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
      };
      cache.set(feed.id, entry);
      cooldown.delete(feed.id);
      return entry;
    } finally {
      clearTimeout(timeout);
      controller.abort();
      controllers.delete(controller);
    }
  }

  /**
   * A station's next trains: the feed's cached TripUpdates index joined to
   * its position snapshot, read through `handle` so the snapshot keeps its
   * own cache, limits and backoff. No request of its own to the operator.
   */
  async function arrivals(feed, stationId, url) {
    if (!admitArrivals(feed.id))
      return reply(
        429,
        JSON.stringify({ error: 'Transit arrivals read limit reached' }),
        {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Retry-After': '60',
        },
      );
    const now = Date.now();
    let vehicles = null;
    try {
      const positions = await handle(
        new Request(
          `${url.origin}/api/transit/vehicles/${encodeURIComponent(feed.id)}`,
        ),
      );
      if (positions.ok) vehicles = (await positions.json()).vehicles ?? null;
    } catch {
      vehicles = null;
    }
    const [index, stopNames] = await Promise.all([
      tripUpdatesFor(feed, now),
      stopDictionaryFor(feed, 'stopNames', now),
    ]);
    if (stopNames && !Object.hasOwn(stopNames, stationId))
      return reply(404, JSON.stringify({ error: 'Unknown station' }), {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
    // A timetable feed lists from its timetable, the trip updates only
    // moving it; otherwise the trip updates are the board.
    const scheduled = typeof feed.tripDetails?.timetable === 'function';
    const timetable = scheduled ? timetableFor(feed, now) : null;
    if (scheduled ? !timetable : !index)
      return reply(
        503,
        JSON.stringify({
          error: scheduled
            ? 'Timetable not loaded yet'
            : 'Trip updates unavailable',
          feedId: feed.id,
        }),
        {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Retry-After': scheduled ? '15' : '60',
        },
      );
    const body = {
      feedId: feed.id,
      stationId,
      station: stopNames?.[stationId] ?? null,
      fetchedAt: companionFetchedAt(feed, 'tripUpdates'),
      positions: Array.isArray(vehicles),
      tripUpdates: Boolean(index),
      ...(scheduled ? { timetable: timetable.builtFor } : {}),
      arrivals: scheduled
        ? buildTimetableArrivals({
            stationId,
            timetable,
            tripUpdates: index,
            vehicles,
            stopNames,
            now,
          })
        : buildTransitArrivals({
            stationId,
            tripUpdates: index,
            vehicles,
            stopKey: feed.tripUpdates.stopKey ?? null,
            stopPlatform: feed.tripUpdates.stopPlatform ?? null,
            stopNames,
            now,
          }),
    };
    return reply(200, JSON.stringify(body), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }

  async function handle(incoming) {
    const url = new URL(incoming.url);
    if (!url.pathname.startsWith('/api/transit/'))
      return reply(404, JSON.stringify({ error: 'Unknown transit feed' }), {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
    const req = {
      method: incoming.method,
      url: url.pathname.slice('/api/transit'.length) + url.search,
    };
    if (closed)
      return reply(503, JSON.stringify({ error: 'Transit provider closed' }), {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
    if (req.method !== 'GET') {
      return reply(
        405,
        JSON.stringify({ error: 'Method Not Allowed' }),
        transitResponseHeaders('NONE'),
      );
    }
    const route = resolveTransitRoute(req.url);
    if (!route) {
      return reply(404, JSON.stringify({ error: 'Unknown transit feed' }), {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
    }
    if (route.route === 'feeds') {
      return reply(200, JSON.stringify({ feeds: publicTransitCatalog() }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      });
    }
    const { feed } = route;
    const now = Date.now();
    if (route.route === 'trail') {
      if (!admitHistory(feed.id)) {
        return reply(
          429,
          JSON.stringify({ error: 'Transit history read limit reached' }),
          {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Retry-After': '60',
          },
        );
      }
      return reply(
        200,
        JSON.stringify(history.get(feed.id, route.vehicleId, now)),
        { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      );
    }
    if (route.route === 'arrivals') return arrivals(feed, route.stationId, url);
    if (route.route === 'alerts') {
      const list = await alertsFor(feed, now);
      if (!list)
        return reply(
          503,
          JSON.stringify({ error: 'Alerts unavailable', feedId: feed.id }),
          {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Retry-After': '60',
          },
        );
      return reply(
        200,
        JSON.stringify({
          feedId: feed.id,
          fetchedAt: companionFetchedAt(feed, 'alerts'),
          alerts: publicTransitAlerts(list, now),
        }),
        {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=60',
        },
      );
    }
    const cached = cache.get(feed.id);
    const ttlMs = transitFeedTtlMs(feed);
    const feedTtlSeconds = Math.ceil(ttlMs / 1000);
    const state = transitCacheState(cached, now, ttlMs);
    if (state === 'fresh') {
      return reply(
        200,
        cached.body,
        transitResponseHeaders('HIT', cached.host, cached.contactedAt, ttlMs),
      );
    }

    // Answer without contacting the operator: the cached snapshot when there
    // is one, otherwise an honest "unavailable, come back in N seconds".
    const answerWithoutUpstream = (reason, retryAfterS) => {
      if (state === 'stale' && cached) {
        // The contact time stays as old as it is: a feed being served from
        // cache during an outage has NOT answered, and saying otherwise
        // would keep a dead feed on the globe.
        return reply(
          200,
          cached.body,
          transitResponseHeaders(
            'STALE-ERROR',
            cached.host,
            cached.contactedAt,
          ),
        );
      }
      return reply(
        503,
        JSON.stringify({
          error: 'Transit feed unavailable',
          feedId: feed.id,
          retryInSec: retryAfterS,
        }),
        {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-GEV-Cache': 'NONE',
          'Retry-After': String(retryAfterS),
          'X-Transit-Backoff': reason,
        },
      );
    };

    const waiting = cooldown.get(feed.id);
    if (waiting && waiting.nextAttemptAt > now && !inFlight.has(feed.id)) {
      return answerWithoutUpstream(
        'cooldown',
        Math.max(1, Math.ceil((waiting.nextAttemptAt - now) / 1000)),
      );
    }
    if (!inFlight.has(feed.id) && !admit(feed.id)) {
      return answerWithoutUpstream('rate-limited', feedTtlSeconds);
    }

    const request = coalesceProxyRequest(inFlight, feed.id, () =>
      refresh(feed, now),
    );
    try {
      const fresh = await request.promise;
      return reply(
        200,
        fresh.body,
        transitResponseHeaders(
          request.shared ? 'INFLIGHT' : 'MISS',
          fresh.host,
          fresh.contactedAt,
          ttlMs,
        ),
      );
    } catch (error) {
      const differential = error instanceof TransitFeedShapeError;
      // A shape fault condemns what we already hold. The cached copy was
      // decoded under the assumption this feed is a full snapshot, and that
      // assumption has just been shown false — leaving it in place would let
      // the very next request serve it back as a 200.
      if (differential) cache.delete(feed.id);
      if (!request.shared) {
        // A 429 is the operator asking us to slow down: wait what it asks
        // (at least a minute, at most fifteen) rather than the short first
        // rungs of the outage ladder, which would spend more of its quota.
        const wait = noteFailure(
          feed.id,
          error?.message || String(error),
          Date.now(),
          error?.upstreamStatus === 429
            ? Math.max(60_000, error.retryAfterMs || 0)
            : 0,
        );
        console.warn(
          `[transit-proxy] ${feed.id} unavailable: ${error?.message || error} — next attempt in ${Math.round(wait / 1000)}s`,
        );
      }
      // A differential feed is a shape fault, not an outage: serving the old
      // snapshot would hide a feed this decoder must not render at all.
      if (state === 'stale' && cached && !differential) {
        // The contact time is the last SUCCESSFUL one. This request failed,
        // so it does not advance — otherwise a dead feed would look like one
        // answering on time.
        return reply(
          200,
          cached.body,
          transitResponseHeaders(
            'STALE-ERROR',
            cached.host,
            cached.contactedAt,
          ),
        );
      }
      const pending = cooldown.get(feed.id);
      const retryAfterS = pending
        ? Math.max(1, Math.ceil((pending.nextAttemptAt - Date.now()) / 1000))
        : feedTtlSeconds;
      return reply(
        differential ||
          error?.code === 'RESPONSE_TOO_LARGE' ||
          Number.isInteger(error?.upstreamStatus)
          ? 502
          : 504,
        JSON.stringify({
          error: differential
            ? 'Transit feed is differential and is not supported'
            : 'Transit feed unavailable',
          feedId: feed.id,
          retryInSec: retryAfterS,
        }),
        {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-GEV-Cache': 'NONE',
          'Retry-After': String(retryAfterS),
        },
      );
    }
  }

  function close() {
    closed = true;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    history.clear();
    cache.clear();
    cooldown.clear();
  }
  return { handle, close };
}
