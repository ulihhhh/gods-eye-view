import { validTransitIdentifier } from '../sources/transitHistory.js';
export {
  validTransitIdentifier,
  fetchTransitHistory,
} from '../sources/transitHistory.js';

/**
 * @module transitProxy
 * @description Pure server-side mechanics for the `/api/transit` proxy.
 *
 * Kept free of Vite/Node middleware state (the terrainHeightsProxy pattern)
 * so path resolution, snapshot shaping, and the cache/stale policy can be
 * exercised by the offline node:test suite. The middleware in vite.config.js
 * only does I/O: fetch the registered upstream, hand the bytes here, send.
 */

import {
  GTFS_INCREMENTALITY_FULL_DATASET,
  decodeVehiclePositions,
} from './gtfsRealtime.js';
import { getTransitFeed } from './transitFeeds.js';
import { decodeFgcGeotren } from './fgcGeotren.js';
import { applyServiceFields } from './transitServiceFields.js';
import {
  TRANSIT_STANDARD_STOP_RELATION,
  TRANSIT_STOP_RELATIONS,
} from './transitStopRelation.js';

/** Fresh window: a snapshot younger than this is served without refetching. */
export const TRANSIT_PROXY_TTL_MS = 15_000;
/** Serve-stale window: after an upstream failure, a snapshot this old still ships (marked stale). */
export const TRANSIT_PROXY_STALE_MAX_MS = 10 * 60_000;
/** Upstream fetch timeout. National feeds (Entur ≈ 1.4 MB) need headroom. */
export const TRANSIT_PROXY_TIMEOUT_MS = 15_000;
/** Hard cap on upstream bytes: the largest registered feed is well under 1 MB. */
export const TRANSIT_PROXY_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Redirect hops followed before a feed is declared unreachable. */
export const TRANSIT_MAX_REDIRECTS = 3;
/**
 * The 3xx codes that actually mean "go somewhere else". 304 is NOT one of them:
 * it is the successful answer to a conditional request and carries no Location,
 * so treating the whole 3xx range as a redirect turns every healthy unchanged
 * feed into a failure and walks it up the backoff ladder.
 */
export const TRANSIT_REDIRECT_STATUSES = Object.freeze([
  301, 302, 303, 307, 308,
]);

/**
 * Whether an upstream status is a redirect this proxy should follow.
 * @param {number} status
 * @returns {boolean}
 */
export function isTransitRedirectStatus(status) {
  return TRANSIT_REDIRECT_STATUSES.includes(Number(status));
}
/**
 * Admission window for upstream requests. One browser polls a feed every 15 s
 * (4/min); the allowance leaves room for a second tab and a manual reload, and
 * the global figure bounds what this process can ask of ALL operators at once.
 */
export const TRANSIT_ADMISSION_WINDOW_MS = 60_000;
export const TRANSIT_ADMISSION_MAX_PER_FEED = 8;
export const TRANSIT_ADMISSION_MAX_GLOBAL = 40;
/**
 * Cooldown ladder after consecutive upstream failures, in ms. A cold feed that
 * is simply down must not be re-asked once per poll for the whole session: the
 * first retry is quick, the last rung is five minutes, and the ladder resets on
 * the first success.
 */
export const TRANSIT_BACKOFF_LADDER_MS = Object.freeze([
  5_000, 15_000, 60_000, 300_000,
]);

/**
 * Resolve `/vehicles/<feedId>` (the path after the `/api/transit` mount) to a
 * registered feed. Anything else — a different route, an unknown id, path
 * tricks, a query string — resolves to null and the caller 404s.
 * @param {string} url Request URL relative to the mount point.
 * @returns {{ route: 'feeds' } | { route: 'vehicles', feed: object } | null}
 */
export function resolveTransitRoute(url) {
  const pathname = String(url || '').split('?')[0];
  if (pathname === '/feeds' || pathname === '/feeds/')
    return { route: 'feeds' };
  const match = /^\/(vehicles|trail)\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return null;
  let id, vehicleId;
  try {
    id = decodeURIComponent(match[2]);
    vehicleId = match[3] === undefined ? null : decodeURIComponent(match[3]);
  } catch {
    return null;
  }
  const feed = getTransitFeed(id);
  if (!feed) return null;
  if (match[1] === 'vehicles')
    return vehicleId === null ? { route: 'vehicles', feed } : null;
  return feed.historyRetention === true && validTransitIdentifier(vehicleId)
    ? { route: 'trail', feed, vehicleId }
    : null;
}

/**
 * Request headers for one upstream fetch.
 *
 * Three of these are obligations, not politeness. Feeds that ask consumers to
 * identify themselves get their header from the registry (Entur requires
 * `ET-Client-Name`; OVapi asks that the User-Agent say who you are). OVapi also
 * asks anyone polling faster than once a minute to send conditional-request
 * validators and to accept gzip, so both are sent to every feed: harmless
 * where it is not asked for, and it spares each operator a full body whenever
 * nothing has changed.
 *
 * @param {object} feed Registry entry.
 * @param {{etag?: string|null, lastModified?: string|null}} [validators] From the cached snapshot.
 * @returns {Record<string, string>}
 */
export function transitUpstreamHeaders(feed, validators = null) {
  return {
    'User-Agent':
      'gods-eye-view-transit-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)',
    Accept: transitFormatFor(feed).accept,
    'Accept-Encoding': 'gzip',
    ...(validators?.etag ? { 'If-None-Match': validators.etag } : {}),
    ...(validators?.lastModified
      ? { 'If-Modified-Since': validators.lastModified }
      : {}),
    ...(feed?.headers || {}),
  };
}

/**
 * Only https upstreams are fetched.
 * @param {string} url Request or response URL.
 * @returns {boolean}
 */
export function isAcceptableTransitUpstreamUrl(url) {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Decide whether one redirect hop may be followed, BEFORE it is requested.
 *
 * Checking the FINAL url after `redirect: 'follow'` is too late: by then the
 * disallowed host has already been contacted, has already seen this server's
 * request, and has already answered. So every hop is resolved here first and a
 * hop that leaves the feed's own origin, or drops to plain http, is refused —
 * the same rule the CCTV frame proxy applies to camera images.
 *
 * @param {string} originUrl The registered feed URL (defines the allowed origin).
 * @param {string} currentUrl The URL that produced this redirect (for relative Location).
 * @param {string|null} location Raw `Location` header value.
 * @returns {{ ok: true, url: string } | { ok: false, reason: string }}
 */
export function transitRedirectDecision(originUrl, currentUrl, location) {
  if (!location)
    return { ok: false, reason: 'redirect without a Location header' };
  let origin;
  let next;
  try {
    origin = new URL(originUrl).origin;
    next = new URL(location, currentUrl);
  } catch {
    return { ok: false, reason: 'redirect target is not a valid URL' };
  }
  if (next.protocol !== 'https:')
    return { ok: false, reason: 'redirect left https' };
  if (next.origin !== origin)
    return { ok: false, reason: `redirect left ${origin}` };
  return { ok: true, url: next.toString() };
}

/**
 * Cooldown before the next upstream attempt after `failures` consecutive
 * failures. Zero while the feed is healthy.
 * @param {number} failures Consecutive failures (0 = none).
 * @returns {number} ms to wait before the next upstream attempt.
 */
export function nextTransitBackoffMs(failures) {
  const count = Number.isFinite(failures) ? Math.floor(failures) : 0;
  if (count <= 0) return 0;
  const index = Math.min(count, TRANSIT_BACKOFF_LADDER_MS.length) - 1;
  return TRANSIT_BACKOFF_LADDER_MS[index];
}

/**
 * Error thrown when a feed's shape is unusable rather than merely unavailable.
 * Carries `transitReason` so the middleware can answer honestly.
 */
export class TransitFeedShapeError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'TransitFeedShapeError';
    this.transitReason = reason;
  }
}

/**
 * Give every vehicle a best-available report time, and say WHERE it came from.
 *
 * A feed that omits `VehiclePosition.timestamp` is not reporting "now" — it is
 * reporting nothing, and treating the moment WE fetched as the moment the bus
 * was there is how a five-minute-old fix gets drawn as live. The ladder is
 * explicit instead: the vehicle's own timestamp, else the feed header's
 * timestamp (the operator's own statement about the snapshot), else fetch time,
 * which is labelled as a guess so the layer can age it conservatively.
 *
 * @param {object[]} vehicles Normalized vehicle records.
 * @param {number|null} headerTimestamp Feed header timestamp (epoch seconds).
 * @param {number} fetchedAtS Fetch time (epoch seconds).
 * @returns {object[]} Records with `timestamp` and `timestampSource` set.
 */
export function repairVehicleTimestamps(vehicles, headerTimestamp, fetchedAtS) {
  const header =
    Number.isFinite(headerTimestamp) && headerTimestamp > 0
      ? headerTimestamp
      : null;
  return (vehicles || []).map((vehicle) => {
    if (Number.isFinite(vehicle.timestamp) && vehicle.timestamp > 0) {
      return { ...vehicle, timestampSource: 'vehicle' };
    }
    if (header !== null)
      return { ...vehicle, timestamp: header, timestampSource: 'header' };
    return { ...vehicle, timestamp: fetchedAtS, timestampSource: 'fetch' };
  });
}

/** Accept header for GTFS-Realtime protobuf feeds. */
const GTFS_RT_ACCEPT =
  'application/x-protobuf, application/octet-stream;q=0.9, */*;q=0.1';

/**
 * Upstream formats by the registry's optional `format` field, each with the
 * Accept header it is asked with and a decoder returning the shape
 * `decodeVehiclePositions` returns (`{version, timestamp, incrementality,
 * entityCount, truncated, vehicles}`). A feed without `format` is
 * GTFS-Realtime protobuf. A new non-GTFS source adds one entry here and one
 * decoder module, and the rest of the proxy does not change.
 */
export const TRANSIT_FORMATS = Object.freeze({
  'gtfs-rt': Object.freeze({
    accept: GTFS_RT_ACCEPT,
    decode: decodeVehiclePositions,
  }),
  // FGC's Geotren positions, Opendatasoft v1 JSON (see fgcGeotren.js).
  'fgc-geotren': Object.freeze({
    accept: 'application/json',
    decode: decodeFgcGeotren,
  }),
});

/**
 * The format entry for a feed. An unknown format is a shape fault, never a
 * silent fallback to protobuf: decoding JSON as protobuf yields garbage.
 * @param {object|null} feed Registry entry.
 * @returns {{accept: string, decode: (bytes: Uint8Array) => object}}
 */
export function transitFormatFor(feed) {
  const id = feed?.format || 'gtfs-rt';
  const format = Object.hasOwn(TRANSIT_FORMATS, id)
    ? TRANSIT_FORMATS[id]
    : null;
  if (!format) {
    throw new TransitFeedShapeError(`unknown feed format ${id}`, 'format');
  }
  return format;
}

/** Longest per-feed minimum interval honoured: past it a feed is not live. */
export const TRANSIT_MAX_MIN_INTERVAL_MS = 10 * 60_000;

/**
 * How long one snapshot of this feed answers before the operator is asked
 * again: the proxy TTL, or the feed's own `minIntervalMs` when it is longer.
 * Operators with a daily quota (FGC's open-data API allows 5,000 requests a
 * day per IP) set it so a session polling all day stays inside the quota;
 * browsers still poll every 15 s and get the cached snapshot.
 * @param {object|null} feed Registry entry.
 * @returns {number} ms.
 */
export function transitFeedTtlMs(feed) {
  const own = Number(feed?.minIntervalMs);
  if (!Number.isFinite(own) || own <= TRANSIT_PROXY_TTL_MS)
    return TRANSIT_PROXY_TTL_MS;
  return Math.min(own, TRANSIT_MAX_MIN_INTERVAL_MS);
}

/**
 * Decode upstream bytes into the JSON snapshot the browser consumes.
 *
 * A DIFFERENTIAL feed is refused outright. Differential GTFS-Realtime carries
 * only what changed, so reading one as if it were a full snapshot would make
 * every unmentioned vehicle look like it had vanished. Deletion semantics are
 * not implemented, so the honest answer is to decline the feed, not to render
 * a wrong one.
 *
 * @param {object} feed Registry entry.
 * @param {Uint8Array|ArrayBuffer} bytes Raw GTFS-RT FeedMessage.
 * @param {number} [now=Date.now()] Fetch time (ms epoch).
 * @param {{stopNames?: Readonly<Record<string, string>>|null,
 *   stopPlaces?: Readonly<Record<string, [number, number]>>|null}} [options]
 *   `stopNames`: the feed's station dictionary (`feed.stopNames()`), when
 *   loaded; each vehicle whose `stopId` it names gains `stopName`.
 *   `stopPlaces`: the feed's station positions (`feed.stopPlaces()`); each
 *   vehicle whose stop it places gains `stopLat` / `stopLon`.
 *   `tripUpdates`: the feed's TripUpdates index (registry `tripUpdates`),
 *   when fetched; vehicles gain next stops with times and a delay.
 *   `tripDetails`: the feed's static trip lookup (registry `tripDetails`),
 *   when loaded; vehicles gain a service name and destination (see
 *   transitServiceFields.js).
 * @returns {{ feedId: string, name: string, fetchedAt: number, feedTimestamp: number|null,
 *   version: string|null, entityCount: number, truncated: boolean, count: number, vehicles: object[] }}
 */
export function buildTransitSnapshot(
  feed,
  bytes,
  now = Date.now(),
  {
    stopNames = null,
    stopPlaces = null,
    tripUpdates = null,
    tripDetails = null,
  } = {},
) {
  const decoded = transitFormatFor(feed).decode(bytes);
  if (decoded.incrementality !== GTFS_INCREMENTALITY_FULL_DATASET) {
    throw new TransitFeedShapeError(
      `feed is differential (incrementality ${decoded.incrementality})`,
      'differential',
    );
  }
  return {
    feedId: feed.id,
    name: feed.name,
    fetchedAt: now,
    feedTimestamp: decoded.timestamp,
    version: decoded.version,
    entityCount: decoded.entityCount,
    truncated: decoded.truncated,
    count: decoded.vehicles.length,
    vehicles: repairVehicleTimestamps(
      applyStopPlaces(
        applyServiceFields(
          applyStopNames(
            applyStatusSemantics(
              feed,
              applyDerivedRoutes(feed, decoded.vehicles),
            ),
            stopNames,
          ),
          {
            stopNames,
            tripUpdates,
            tripDetails,
            stopKey: feed.tripUpdates?.stopKey ?? null,
            now,
          },
        ),
        stopPlaces,
      ),
      decoded.timestamp,
      Math.floor(now / 1000),
    ),
  };
}

/** Longest station name a feed's dictionary may supply. */
export const TRANSIT_MAX_STOP_NAME_CHARS = 120;

/**
 * Name each vehicle's stop from the feed's station dictionary, so the card
 * can say "next stop Sarrià" instead of "next stop SR". Vehicles whose stop
 * the dictionary does not know keep their bare `stopId`.
 * @param {object[]} vehicles
 * @param {Readonly<Record<string, string>>|null} stopNames
 * @returns {object[]}
 */
export function applyStopNames(vehicles, stopNames) {
  if (!stopNames || typeof stopNames !== 'object') return vehicles;
  return vehicles.map((vehicle) => {
    const id = vehicle?.stopId;
    const name =
      typeof id === 'string' && Object.hasOwn(stopNames, id)
        ? String(stopNames[id] ?? '').trim()
        : '';
    if (!name || name.length > TRANSIT_MAX_STOP_NAME_CHARS) return vehicle;
    return { ...vehicle, stopName: name };
  });
}

/**
 * Place each vehicle's stop from the feed's station positions, so the layer
 * can turn a train that has only one fix toward where it is going.
 * Positions outside the valid range are ignored.
 * @param {object[]} vehicles
 * @param {Readonly<Record<string, [number, number]>>|null} stopPlaces
 *   `{stopId: [lat, lon]}`.
 * @returns {object[]}
 */
export function applyStopPlaces(vehicles, stopPlaces) {
  if (!stopPlaces || typeof stopPlaces !== 'object') return vehicles;
  return vehicles.map((vehicle) => {
    const id = vehicle?.stopId;
    const place =
      typeof id === 'string' && Object.hasOwn(stopPlaces, id)
        ? stopPlaces[id]
        : null;
    const [lat, lon] = Array.isArray(place) ? place : [];
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    )
      return vehicle;
    return { ...vehicle, stopLat: lat, stopLon: lon };
  });
}

/**
 * Say what each vehicle's status means for this feed. Most feeds follow the
 * GTFS-Realtime reading; a feed whose operator uses the statuses differently
 * declares `interpretStatus(record) → {stopRelation?, positionUntrusted?}`
 * (Renfe's Cercanías feed reports the station a train LEFT as the one it is
 * in transit to). `positionUntrusted` marks a report whose position the
 * operator is known to fill with something other than the vehicle's place;
 * the layer keeps the vehicle but does not move it there.
 * @param {object} feed Registry entry.
 * @param {object[]} vehicles
 * Feeds without the hook are left as they are: the card reads their
 * `status` the standard way.
 * @returns {object[]} Records with `stopRelation` where known, and
 *   `positionUntrusted: true` where declared.
 */
export function applyStatusSemantics(feed, vehicles) {
  if (typeof feed?.interpretStatus !== 'function') return vehicles;
  return vehicles.map((vehicle) => {
    const own = feed.interpretStatus(vehicle) || {};
    const relation = Object.hasOwn(own, 'stopRelation')
      ? own.stopRelation
      : TRANSIT_STANDARD_STOP_RELATION[vehicle?.status];
    const known = TRANSIT_STOP_RELATIONS.includes(relation) && vehicle?.stopId;
    if (!known && own.positionUntrusted !== true) return vehicle;
    return {
      ...vehicle,
      ...(known ? { stopRelation: relation } : {}),
      ...(own.positionUntrusted === true ? { positionUntrusted: true } : {}),
    };
  });
}

/**
 * Drop the vehicles another feed already reports, for a feed whose registry
 * row names it in `yieldsTo`. One operator can publish the same train in two
 * feeds (Renfe's Catalan regional lines appear in both its Cercanías and its
 * long-distance feed, kilometres apart), and two markers for one train read
 * as two trains. The preferred feed keeps it; this one yields.
 * @param {object} snapshot Snapshot from `buildTransitSnapshot`.
 * @param {object[]|null} preferredVehicles The preferred feed's latest vehicles,
 *   or null when that feed has not been fetched yet.
 * @returns {object} Snapshot without the shared vehicles, `yielded` = how many.
 */
export function excludeYieldedVehicles(snapshot, preferredVehicles) {
  if (!Array.isArray(preferredVehicles) || !preferredVehicles.length) {
    return { ...snapshot, yielded: 0 };
  }
  const taken = new Set(preferredVehicles.map((vehicle) => vehicle?.id));
  const vehicles = snapshot.vehicles.filter(
    (vehicle) => !taken.has(vehicle.id),
  );
  return {
    ...snapshot,
    count: vehicles.length,
    yielded: snapshot.vehicles.length - vehicles.length,
    vehicles,
  };
}

/** Longest line or platform code a feed's `deriveRoute` may supply. */
export const TRANSIT_DERIVED_CODE_MAX_CHARS = 8;

function boundedCode(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= TRANSIT_DERIVED_CODE_MAX_CHARS
    ? value
    : null;
}

/**
 * Apply a feed's optional `deriveRoute(record)` to decoded vehicles, for
 * feeds that leave `trip.route_id` empty but name the line elsewhere (Renfe
 * Cercanías puts it, and the platform, in the vehicle label). A route the
 * feed itself published always wins; derived values are short strings or
 * nothing, and a feed without the hook is returned untouched.
 * @param {object} feed Registry entry.
 * @param {object[]} vehicles Normalized vehicle records.
 * @returns {object[]} Records, with `routeId` and `platform` where derived.
 */
export function applyDerivedRoutes(feed, vehicles) {
  if (typeof feed?.deriveRoute !== 'function') return vehicles;
  return vehicles.map((vehicle) => {
    const derived = feed.deriveRoute(vehicle) || {};
    const routeId = vehicle.routeId ? null : boundedCode(derived.routeId);
    const platform = boundedCode(derived.platform);
    if (!routeId && !platform) return vehicle;
    return {
      ...vehicle,
      ...(routeId ? { routeId } : {}),
      ...(platform ? { platform } : {}),
    };
  });
}

/** Longest Retry-After honoured from an operator. */
export const TRANSIT_MAX_RETRY_AFTER_MS = 15 * 60_000;

/**
 * Parse a Retry-After header (delay seconds or an HTTP date) into ms from
 * `now`, capped so a hostile or broken value cannot park a feed for hours.
 * @param {string|null|undefined} value Header value.
 * @param {number} [now=Date.now()]
 * @returns {number} ms, 0 when absent or unparsable.
 */
export function transitRetryAfterMs(value, now = Date.now()) {
  const text = String(value ?? '').trim();
  if (!text) return 0;
  const ms = /^\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(ms, TRANSIT_MAX_RETRY_AFTER_MS);
}

/**
 * Classify a cache entry for the request policy.
 * @param {{ at: number }|null|undefined} entry Cached snapshot (`at` = fetch ms).
 * @param {number} now
 * @param {number} [ttlMs] Fresh window for this feed (`transitFeedTtlMs`).
 * @returns {'none'|'fresh'|'stale'|'expired'}
 */
export function transitCacheState(entry, now, ttlMs = TRANSIT_PROXY_TTL_MS) {
  if (!entry || !Number.isFinite(entry.at)) return 'none';
  const age = now - entry.at;
  if (age < 0) return 'fresh';
  if (age < ttlMs) return 'fresh';
  if (age < TRANSIT_PROXY_STALE_MAX_MS) return 'stale';
  return 'expired';
}

/**
 * Response headers for a snapshot. `X-GEV-Cache` mirrors the other proxies
 * (HIT / MISS / INFLIGHT / STALE-ERROR) so the layer can surface staleness.
 * @param {'HIT'|'MISS'|'INFLIGHT'|'STALE-ERROR'} cacheState
 * @param {string} [upstreamHost]
 * @returns {Record<string, string>}
 */
export function transitResponseHeaders(
  cacheState,
  upstreamHost = '',
  contactedAt = null,
  ttlMs = TRANSIT_PROXY_TTL_MS,
) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control':
      cacheState === 'STALE-ERROR'
        ? 'no-store'
        : `public, max-age=${Math.floor(ttlMs / 1000)}`,
    'X-GEV-Cache': cacheState,
    ...(upstreamHost ? { 'X-Transit-Upstream': upstreamHost } : {}),
    // When the operator last ANSWERED, which is not when the body was fetched.
    // A feed whose file has not changed answers 304 forever, and the body we
    // keep serving carries its original fetch time; without this the browser
    // would read a healthy revalidated feed as one that had gone silent.
    ...(Number.isFinite(contactedAt)
      ? { 'X-Transit-Contact': String(Math.floor(contactedAt)) }
      : {}),
  };
}
