/**
 * @module transitServiceFields
 * @description Optional service fields for the Transit proxy's vehicle
 * records: where a train is going, where it came from, its next stops (with
 * predicted times when the feed has a TripUpdates companion), its delay.
 *
 * Feeds opt in through the registry: a decoder may set `destinationStopId`,
 * `originStopId` and `nextStopIds` (FGC's Geotren does); a row may declare
 * `tripUpdates: {url, minIntervalMs?, stopKey?}`, which the proxy fetches
 * beside the positions, and `tripDetails` (a static GTFS read daily into
 * `tripId → {serviceName?, destination?, destinationStopId?,
 * originStopId?}`, Renfe's), both joined here by `tripId`. Feeds that do
 * none of this are returned untouched. Pure: no Cesium, no Node built-ins.
 */
import { decodeTripUpdates } from './gtfsTripUpdates.js';
import { alertActive } from './gtfsAlerts.js';

/** Alerts carried per vehicle; the rest are counted. */
export const TRANSIT_MAX_VEHICLE_ALERTS = 3;
/** Alerts served by `/api/transit/alerts/<feedId>`. */
export const TRANSIT_MAX_PUBLIC_ALERTS = 500;

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

/** Fields a trip's static details may give a vehicle that lacks them. */
const DETAIL_FIELDS = Object.freeze([
  'serviceName',
  'destination',
  'destinationStopId',
  'originStopId',
  // The static GTFS route, which Renfe's alerts name.
  'gtfsRouteId',
]);

/** What a card needs of an alert: its text and effect. */
function alertSummary(alert) {
  return Object.freeze({
    header: alert.header,
    ...(alert.effect ? { effect: alert.effect } : {}),
  });
}

/**
 * Active alerts by the trip and the static GTFS route they name.
 * @param {Array<object>|null} alerts src/data/gtfsAlerts.js records
 * @param {number} now
 */
function indexAlerts(alerts, now) {
  if (!Array.isArray(alerts) || !alerts.length) return null;
  const byTrip = new Map();
  const byRoute = new Map();
  const add = (map, key, alert) => {
    if (!map.has(key)) map.set(key, []);
    const list = map.get(key);
    if (!list.includes(alert)) list.push(alert);
  };
  for (const alert of alerts) {
    if (!alertActive(alert, now)) continue;
    for (const trip of alert.trips || []) add(byTrip, trip, alert);
    for (const route of alert.routes || []) add(byRoute, route, alert);
  }
  return byTrip.size || byRoute.size ? { byTrip, byRoute } : null;
}

/** A vehicle's alerts, each text once (FGC repeats an alert per stop). */
function vehicleAlerts(vehicle, details, index) {
  if (!index) return [];
  const found = [];
  const texts = new Set();
  for (const alert of [
    ...(index.byTrip.get(vehicle?.tripId) || []),
    ...(index.byRoute.get(vehicle?.gtfsRouteId ?? details?.gtfsRouteId) || []),
  ]) {
    const text = JSON.stringify(alert.header);
    if (texts.has(text)) continue;
    texts.add(text);
    found.push(alert);
  }
  return found;
}

/**
 * The active alerts a browser layer matches itself (Rail network's line and
 * station cards), without the per-trip ones vehicles already carry.
 * @param {Array<object>} alerts
 * @param {number} now
 * @returns {Array<{id: string, header: object, description: object,
 *   effect: string|null, cause: string|null, start: number|null,
 *   routes: string[], stops: string[]}>}
 */
export function publicTransitAlerts(alerts, now) {
  return (Array.isArray(alerts) ? alerts : [])
    .filter(
      (alert) =>
        alertActive(alert, now) &&
        (alert.routes?.length || alert.stops?.length) &&
        !alert.trips?.length,
    )
    .slice(0, TRANSIT_MAX_PUBLIC_ALERTS)
    .map((alert) => ({
      id: alert.id,
      header: alert.header,
      description: alert.description,
      effect: alert.effect,
      cause: alert.cause,
      start:
        alert.periods
          ?.map((period) => period.start)
          .filter(Number.isFinite)
          .sort((a, b) => a - b)[0] ?? null,
      routes: alert.routes,
      stops: alert.stops,
    }));
}

/**
 * Add the service fields to decoded vehicles.
 *
 * - `serviceName` (AVE, ALVIA…), `destination`, `destinationStopId`,
 *   `originStopId`: from the trip's static details, where the vehicle has
 *   none of its own.
 * - `destination` / `origin`: names of `destinationStopId` / `originStopId`,
 *   when not already given.
 * - `nextStops: [{stopId, name?, at?}]` (at most TRANSIT_MAX_NEXT_STOPS) and
 *   `nextStopsMore` (how many more): from the trip's update when it has one,
 *   with predicted times (epoch ms) and stops already passed dropped; else
 *   from `nextStopIds`, without times.
 * - `delaySec`: the trip update's delay, when it gives one.
 * - `alerts: [{header, effect?}]` (at most TRANSIT_MAX_VEHICLE_ALERTS) and
 *   `alertsMore`: the active alerts naming the trip or its static GTFS
 *   route (`gtfsRouteId`, from the trip's details).
 * `nextStopIds` is consumed and not passed on.
 * @param {object[]} vehicles
 * @param {{stopNames?: Readonly<Record<string, string>>|null,
 *   tripUpdates?: Map<string, {delaySec: number|null,
 *     stops: Array<{stopId: string, time: number}>}>|null,
 *   tripDetails?: Map<string, Readonly<object>>|null,
 *   alerts?: Array<object>|null,
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
    tripDetails = null,
    alerts = null,
    stopKey = null,
    now = Date.now(),
  } = {},
) {
  const alertIndex = indexAlerts(alerts, now);
  return vehicles.map((vehicle) => {
    const update =
      tripUpdates && vehicle?.tripId ? tripUpdates.get(vehicle.tripId) : null;
    const details =
      tripDetails && vehicle?.tripId ? tripDetails.get(vehicle.tripId) : null;
    const hasOwn =
      vehicle?.destinationStopId ||
      vehicle?.originStopId ||
      Array.isArray(vehicle?.nextStopIds);
    const matched = vehicleAlerts(vehicle, details, alertIndex);
    if (!update && !details && !hasOwn && !matched.length) return vehicle;
    const { nextStopIds, ...record } = vehicle;
    if (matched.length) {
      record.alerts = matched
        .slice(0, TRANSIT_MAX_VEHICLE_ALERTS)
        .map(alertSummary);
      if (matched.length > TRANSIT_MAX_VEHICLE_ALERTS)
        record.alertsMore = matched.length - TRANSIT_MAX_VEHICLE_ALERTS;
    }
    for (const field of DETAIL_FIELDS)
      if (!record[field] && typeof details?.[field] === 'string')
        record[field] = details[field];
    const destination =
      !record.destination && nameOf(stopNames, record.destinationStopId);
    const origin = !record.origin && nameOf(stopNames, record.originStopId);
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
