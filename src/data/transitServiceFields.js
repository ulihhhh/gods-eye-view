/**
 * @module transitServiceFields
 * @description Optional service fields for the Transit proxy's vehicle
 * records: where a train is going, where it came from, its next stops (with
 * predicted times when the feed has a TripUpdates companion), its delay.
 *
 * Feeds opt in through the registry: a decoder may set `destinationStopId`,
 * `originStopId` and `nextStopIds` (FGC's Geotren does), and a row may
 * declare `tripUpdates: {url, minIntervalMs?, stopKey?}`, which the proxy
 * fetches beside the positions and joins here by `tripId`. Feeds that do
 * neither are returned untouched. Pure: no Cesium, no Node built-ins.
 */
import { decodeTripUpdates } from './gtfsTripUpdates.js';

/** Next stops carried per vehicle; the card shows fewer. */
export const TRANSIT_MAX_NEXT_STOPS = 8;
/** A predicted time this far in the past is a stop the train has left. */
const PASSED_GRACE_MS = 30_000;
/** Longest station name carried. */
const MAX_NAME_CHARS = 120;
/** Delays past this are a feed fault, not a train (Renfe's reach 90 min). */
const MAX_DELAY_S = 6 * 3600;

/**
 * TripUpdates bytes → `tripId → {delaySec, stops}`.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Map<string, {delaySec: number|null,
 *   stops: Array<{stopId: string, time: number}>}>}
 */
export function indexTripUpdates(bytes) {
  const index = new Map();
  for (const trip of decodeTripUpdates(bytes).trips) {
    if (!index.has(trip.tripId))
      index.set(trip.tripId, { delaySec: trip.delaySec, stops: trip.stops });
  }
  return index;
}

function nameOf(stopNames, id) {
  if (!stopNames || typeof id !== 'string' || !Object.hasOwn(stopNames, id))
    return null;
  const name = String(stopNames[id] ?? '').trim();
  return name && name.length <= MAX_NAME_CHARS ? name : null;
}

/**
 * Add the service fields to decoded vehicles.
 *
 * - `destination` / `origin`: names of `destinationStopId` / `originStopId`.
 * - `nextStops: [{stopId, name?, at?}]` (at most TRANSIT_MAX_NEXT_STOPS) and
 *   `nextStopsMore` (how many more): from the trip's update when it has one,
 *   with predicted times (epoch ms) and stops already passed dropped; else
 *   from `nextStopIds`, without times.
 * - `delaySec`: the trip update's delay, when it gives one.
 * `nextStopIds` is consumed and not passed on.
 * @param {object[]} vehicles
 * @param {{stopNames?: Readonly<Record<string, string>>|null,
 *   tripUpdates?: Map<string, {delaySec: number|null,
 *     stops: Array<{stopId: string, time: number}>}>|null,
 *   stopKey?: ((stopId: string) => string)|null, now?: number}} [options]
 *   `stopKey` maps a trip update's stop id to the feed's station id (FGC
 *   adds a platform digit: "PC1" is Pl. Catalunya).
 * @returns {object[]}
 */
export function applyServiceFields(
  vehicles,
  {
    stopNames = null,
    tripUpdates = null,
    stopKey = null,
    now = Date.now(),
  } = {},
) {
  return vehicles.map((vehicle) => {
    const update =
      tripUpdates && vehicle?.tripId ? tripUpdates.get(vehicle.tripId) : null;
    const hasOwn =
      vehicle?.destinationStopId ||
      vehicle?.originStopId ||
      Array.isArray(vehicle?.nextStopIds);
    if (!update && !hasOwn) return vehicle;
    const { nextStopIds, ...record } = vehicle;
    const destination = nameOf(stopNames, record.destinationStopId);
    const origin = nameOf(stopNames, record.originStopId);
    if (destination) record.destination = destination;
    if (origin) record.origin = origin;
    let stops = [];
    if (update) {
      for (const { stopId, time } of update.stops) {
        if (time < now - PASSED_GRACE_MS) continue;
        const id = typeof stopKey === 'function' ? stopKey(stopId) : stopId;
        stops.push({ stopId: id, at: time });
      }
      if (
        Number.isFinite(update.delaySec) &&
        Math.abs(update.delaySec) <= MAX_DELAY_S
      )
        record.delaySec = update.delaySec;
    }
    if (!stops.length && Array.isArray(nextStopIds))
      stops = nextStopIds.map((stopId) => ({ stopId }));
    if (stops.length) {
      record.nextStops = stops.slice(0, TRANSIT_MAX_NEXT_STOPS).map((stop) => {
        const name = nameOf(stopNames, stop.stopId);
        return name ? { ...stop, name } : stop;
      });
      const more = stops.length - record.nextStops.length;
      if (more > 0) record.nextStopsMore = more;
    }
    return record;
  });
}
