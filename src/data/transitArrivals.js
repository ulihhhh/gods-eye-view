/**
 * @module transitArrivals
 * @description A station's next trains, built from the feed's TripUpdates
 * (registry `tripUpdates`) joined by `tripId` to the vehicles of its latest
 * position snapshot. The trip update gives the time at the station; the
 * vehicle, when the train is already running, gives its line, destination
 * and punctuality. A trip with no vehicle yet is still listed, named from
 * its last stop. A train whose trip ends at the station is listed as an
 * arrival (`terminates`). Served by `/api/transit/arrivals/<feedId>/<stationId>`;
 * nothing here asks the operator for anything. Pure: no Cesium, no Node
 * built-ins.
 */

/** Trains listed per station. */
export const TRANSIT_ARRIVALS_MAX = 12;
/** A train due this long ago is still at the platform. */
const DEPARTED_GRACE_MS = 30_000;
/** Times past this are a feed fault, not tonight's last train. */
const HORIZON_MS = 3 * 3600_000;
/** Longest line, platform or station name carried. */
const MAX_CODE_CHARS = 16;
const MAX_NAME_CHARS = 120;

function bounded(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= max ? text : null;
}

function nameOf(stopNames, id) {
  if (!stopNames || typeof id !== 'string' || !Object.hasOwn(stopNames, id))
    return null;
  return bounded(String(stopNames[id] ?? ''), MAX_NAME_CHARS);
}

/**
 * @param {{stationId: string,
 *   tripUpdates: Map<string, {delaySec: number|null,
 *     stops: Array<{stopId: string, time: number}>}>|null,
 *   vehicles?: object[]|null,
 *   stopKey?: ((stopId: string) => string)|null,
 *   stopPlatform?: ((stopId: string) => string|null)|null,
 *   stopNames?: Readonly<Record<string, string>>|null,
 *   now?: number, limit?: number}} options
 * @returns {Array<{tripId: string, at: number, line: string|null,
 *   destination: string|null, origin: string|null, platform: string|null,
 *   delaySec: number|null, onTime: boolean|null, terminates: boolean,
 *   running: boolean}>} soonest first
 */
export function buildTransitArrivals({
  stationId,
  tripUpdates,
  vehicles = null,
  stopKey = null,
  stopPlatform = null,
  stopNames = null,
  now = Date.now(),
  limit = TRANSIT_ARRIVALS_MAX,
}) {
  if (!tripUpdates || typeof stationId !== 'string' || !stationId) return [];
  const keyOf = (stopId) =>
    typeof stopKey === 'function' ? stopKey(stopId) : stopId;
  const byTrip = new Map();
  for (const vehicle of Array.isArray(vehicles) ? vehicles : [])
    if (typeof vehicle?.tripId === 'string' && !byTrip.has(vehicle.tripId))
      byTrip.set(vehicle.tripId, vehicle);
  const rows = [];
  for (const [tripId, update] of tripUpdates) {
    const stops = Array.isArray(update?.stops) ? update.stops : [];
    const index = stops.findIndex(
      (stop) =>
        keyOf(stop.stopId) === stationId &&
        Number.isFinite(stop.time) &&
        stop.time >= now - DEPARTED_GRACE_MS &&
        stop.time <= now + HORIZON_MS,
    );
    if (index < 0) continue;
    const stop = stops[index];
    const vehicle = byTrip.get(tripId) ?? null;
    const lastId = stops.length ? keyOf(stops.at(-1).stopId) : null;
    const terminates = index === stops.length - 1;
    rows.push({
      tripId,
      at: stop.time,
      line: bounded(vehicle?.routeId, MAX_CODE_CHARS),
      destination:
        bounded(vehicle?.destination, MAX_NAME_CHARS) ??
        (terminates ? null : nameOf(stopNames, lastId)),
      // Where a train ending here comes from (the vehicle's own origin).
      origin: bounded(vehicle?.origin, MAX_NAME_CHARS),
      platform:
        typeof stopPlatform === 'function'
          ? bounded(stopPlatform(stop.stopId), MAX_CODE_CHARS)
          : null,
      delaySec: Number.isFinite(update.delaySec)
        ? update.delaySec
        : Number.isFinite(vehicle?.delaySec)
          ? vehicle.delaySec
          : null,
      onTime: typeof vehicle?.onTime === 'boolean' ? vehicle.onTime : null,
      terminates,
      running: Boolean(vehicle),
    });
  }
  rows.sort((a, b) => a.at - b.at || a.tripId.localeCompare(b.tripId));
  return rows.slice(0, Math.max(0, limit));
}
