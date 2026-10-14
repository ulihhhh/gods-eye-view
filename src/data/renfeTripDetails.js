/**
 * @module renfeTripDetails
 * @description What each Renfe trip is and where it goes, from Renfe's
 * static GTFS (CC BY 4.0, data.renfe.com), for the Transit registry's
 * `tripDetails` hook. The proxy downloads the zip once a day and keeps the
 * lookup these builders return; positions never wait for it.
 *
 * - Cercanías (`fomento_transit.zip`): the line is already in the live
 *   label; the destination is the second half of `route_long_name`, a
 *   fixed-width "origin (40 chars) - destination" field ("Chamartín - Clara
 *   Campoamor" has its own " - ", so it is not split on the dash).
 * - AV/LD/MD (`google_transit.zip`): `route_short_name` is the service
 *   (AVE, ALVIA, MD…); the first ten digits of `route_id` are the origin and
 *   destination station codes, named by the feed's station dictionary. Trip
 *   ids carry the date, so the file is read daily rather than bundled.
 *
 * Pure: no Cesium, no Node built-ins.
 */
import { parseCsv } from './gtfsCsv.js';

/** Longest service or destination text kept. */
const MAX_TEXT_CHARS = 60;

const clean = (value) => {
  const text = String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  return text && text.length <= MAX_TEXT_CHARS ? text : null;
};

/**
 * Trip id → details, sharing one frozen object per route.
 * @param {string} tripsCsv
 * @param {Map<string, object>} byRoute route id → details
 * @returns {Map<string, Readonly<object>>}
 */
function tripsToDetails(tripsCsv, byRoute) {
  const trips = new Map();
  for (const trip of parseCsv(tripsCsv)) {
    const tripId = String(trip.trip_id ?? '').trim();
    const details = byRoute.get(String(trip.route_id ?? '').trim());
    if (tripId && details) trips.set(tripId, details);
  }
  return trips;
}

/**
 * The destination of a Cercanías route, from its fixed-width long name.
 * @param {string} longName
 * @returns {string|null}
 */
export function cercaniasRouteDestination(longName) {
  const text = String(longName ?? '');
  if (text.length > 41 && text[40] === '-') return clean(text.slice(41));
  // Not the fixed-width layout: "Origin -Destination", split on the last
  // " -" (a space before the dash; "Aeropuerto-T4" has none).
  const at = text.lastIndexOf(' -');
  return at >= 0 ? clean(text.slice(at + 2)) : null;
}

/**
 * @param {Map<string, string>|Record<string, string>} files `routes.txt`
 *   and `trips.txt` text.
 * @returns {Map<string, Readonly<{destination?: string}>>}
 */
export function buildCercaniasTripDetails(files) {
  const get = (name) => (files instanceof Map ? files.get(name) : files[name]);
  const byRoute = new Map();
  for (const route of parseCsv(get('routes.txt'))) {
    const destination = cercaniasRouteDestination(route.route_long_name);
    if (destination)
      byRoute.set(
        String(route.route_id ?? '').trim(),
        Object.freeze({ destination }),
      );
  }
  return tripsToDetails(get('trips.txt'), byRoute);
}

/**
 * @param {Map<string, string>|Record<string, string>} files `routes.txt`
 *   and `trips.txt` text.
 * @returns {Map<string, Readonly<{serviceName?: string,
 *   destinationStopId?: string, originStopId?: string}>>}
 */
export function buildRenfeLdTripDetails(files) {
  const get = (name) => (files instanceof Map ? files.get(name) : files[name]);
  const byRoute = new Map();
  for (const route of parseCsv(get('routes.txt'))) {
    const routeId = String(route.route_id ?? '').trim();
    const serviceName = clean(route.route_short_name);
    const codes = /^(\d{5})(\d{5})/.exec(routeId);
    const details = {
      ...(serviceName ? { serviceName } : {}),
      ...(codes ? { originStopId: codes[1], destinationStopId: codes[2] } : {}),
    };
    if (Object.keys(details).length)
      byRoute.set(routeId, Object.freeze(details));
  }
  return tripsToDetails(get('trips.txt'), byRoute);
}
