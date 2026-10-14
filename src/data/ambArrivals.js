/**
 * AMB (Àrea Metropolitana de Barcelona) bus arrivals — pure helpers for the
 * server proxy (`server/providers/amb.js`).
 *
 * AMB publishes, keyless, a static GTFS (`google_transit.zip`, daily) and a
 * GTFS-Realtime TripUpdates feed (`trips.bin`, every ~30 s) for the
 * metropolitan buses that are not TMB's. There are no vehicle positions, so
 * arrivals at a stop are read from the trip updates: every live trip lists
 * its predicted time at each stop still ahead of it. The static GTFS names
 * the line, its colour and the trip's headsign.
 *
 * Reuse is authorised under Spanish Law 37/2007: cite AMB and the date of the
 * last update, and do not alter the content.
 */
import { parseCsv } from './gtfsCsv.js';
import { decodeTripUpdates } from './gtfsTripUpdates.js';

export { parseCsv, decodeTripUpdates };

/** AMB stop ids are six digits ("000108" is TMB's stop 108). */
export const AMB_STOP_ID_PATTERN = /^\d{6}$/;

/** Arrivals kept per line and destination. */
export const AMB_ARRIVALS_PER_ROUTE = 3;

/** A prediction this far in the past is a bus that has gone. */
const DEPARTED_GRACE_MS = 60_000;

// --- Static GTFS ------------------------------------------------------------

/**
 * Stops a marker can be drawn for: in service, six-digit id, real point.
 * @param {string} stopsCsv `stops.txt`
 * @returns {Array<{id: string, code: string, name: string, lat: number, lon: number}>}
 */
export function buildAmbStops(stopsCsv) {
  const stops = [];
  const seen = new Set();
  for (const row of parseCsv(stopsCsv)) {
    const id = row.stop_id?.trim();
    // Number('') is 0: an empty coordinate must not become a point at sea.
    const lat = row.stop_lat?.trim() ? Number(row.stop_lat) : NaN;
    const lon = row.stop_lon?.trim() ? Number(row.stop_lon) : NaN;
    const name = row.stop_name?.trim();
    if (!AMB_STOP_ID_PATTERN.test(id || '') || seen.has(id)) continue;
    if (row.out_of_service?.trim() === '1') continue;
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    seen.add(id);
    stops.push({
      id,
      code: String(row.stop_code || '').trim() || String(Number(id)),
      name,
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
    });
  }
  return stops.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Line names and colours by route id.
 * @param {string} routesCsv `routes.txt`
 * @returns {Map<string, {name: string, color: string|null}>}
 */
export function buildAmbRoutes(routesCsv) {
  const routes = new Map();
  for (const row of parseCsv(routesCsv)) {
    const id = row.route_id?.trim();
    const name = row.route_short_name?.trim() || row.route_long_name?.trim();
    if (!id || !name) continue;
    const color = row.route_color?.trim().toUpperCase();
    routes.set(id, {
      name,
      color: /^[0-9A-F]{6}$/.test(color || '') ? color : null,
    });
  }
  return routes;
}

/**
 * Route and headsign by trip id.
 * @param {string} tripsCsv `trips.txt`
 * @returns {Map<string, {routeId: string, headsign: string}>}
 */
export function buildAmbTrips(tripsCsv) {
  const trips = new Map();
  for (const row of parseCsv(tripsCsv)) {
    const id = row.trip_id?.trim();
    const routeId = row.route_id?.trim();
    if (!id || !routeId) continue;
    trips.set(id, { routeId, headsign: row.trip_headsign?.trim() || '' });
  }
  return trips;
}

/**
 * Each line's route on the map, from the static GTFS: per line and
 * direction the shape most of its trips follow, as AMB publishes it (points
 * kept, rounded to 6 decimals, ~0.1 m), with the line's name, description
 * and colour. Lines without a shape are left out.
 * @param {{shapesCsv: string, tripsCsv: string, routesCsv: string}} files
 * @returns {Array<{name: string, desc: string, color: string|null,
 *   paths: number[][]}>} In line-name order.
 */
export function buildAmbLines({ shapesCsv, tripsCsv, routesCsv }) {
  // Trips per shape, per line and direction.
  const usage = new Map();
  for (const row of parseCsv(tripsCsv)) {
    const routeId = row.route_id?.trim();
    const shapeId = row.shape_id?.trim();
    if (!routeId || !shapeId) continue;
    const key = `${routeId}\u0000${row.direction_id?.trim() || ''}`;
    if (!usage.has(key)) usage.set(key, new Map());
    const counts = usage.get(key);
    counts.set(shapeId, (counts.get(shapeId) || 0) + 1);
  }
  const chosen = new Map(); // shapeId → the route ids drawn along it
  for (const [key, counts] of usage) {
    const [shapeId] = [...counts].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0];
    if (!chosen.has(shapeId)) chosen.set(shapeId, new Set());
    chosen.get(shapeId).add(key.split('\u0000')[0]);
  }
  const points = new Map(); // shapeId → [[sequence, lon, lat]]
  for (const row of parseCsv(shapesCsv)) {
    const shapeId = row.shape_id?.trim();
    if (!chosen.has(shapeId)) continue;
    const lat = row.shape_pt_lat?.trim() ? Number(row.shape_pt_lat) : NaN;
    const lon = row.shape_pt_lon?.trim() ? Number(row.shape_pt_lon) : NaN;
    const sequence = Number(row.shape_pt_sequence);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (!Number.isFinite(sequence)) continue;
    if (!points.has(shapeId)) points.set(shapeId, []);
    points.get(shapeId).push([sequence, lon, lat]);
  }
  const routes = new Map();
  for (const row of parseCsv(routesCsv)) {
    const id = row.route_id?.trim();
    const name = row.route_short_name?.trim() || row.route_long_name?.trim();
    if (!id || !name) continue;
    const color = row.route_color?.trim().toUpperCase();
    routes.set(id, {
      name,
      desc: (row.route_long_name?.trim() || '').slice(0, 120),
      color: /^[0-9A-F]{6}$/.test(color || '') ? color : null,
      paths: [],
    });
  }
  for (const [shapeId, routeIds] of chosen) {
    const list = points.get(shapeId);
    if (!list || list.length < 2) continue;
    list.sort((a, b) => a[0] - b[0]);
    const flat = [];
    for (const [, lon, lat] of list)
      flat.push(Number(lon.toFixed(6)), Number(lat.toFixed(6)));
    for (const routeId of routeIds) routes.get(routeId)?.paths.push(flat);
  }
  return [...routes.values()]
    .filter((route) => route.paths.length)
    .sort((a, b) => a.name.localeCompare(b.name, 'ca', { numeric: true }));
}

/**
 * Arrivals by stop: one row per line and destination, soonest first, with
 * buses already gone dropped. Built once per feed refresh so a click is a
 * map lookup.
 * @param {ReturnType<typeof decodeTripUpdates>['trips']} trips
 * @param {{routes: Map<string, {name: string, color: string|null}>,
 *   trips: Map<string, {routeId: string, headsign: string}>}} schedule
 * @param {number} now epoch ms
 * @returns {Map<string, Array<{line: string, color: string|null,
 *   destination: string, track: null, arrivals: number[]}>>}
 */
export function buildAmbArrivalsIndex(trips, schedule, now) {
  /** @type {Map<string, Map<string, {line: string, color: string|null, destination: string, track: null, arrivals: number[]}>>} */
  const byStop = new Map();
  for (const trip of trips) {
    const planned = schedule.trips.get(trip.tripId);
    const routeId = trip.routeId || planned?.routeId;
    const route = routeId ? schedule.routes.get(routeId) : null;
    if (!route) continue;
    const destination = planned?.headsign || '';
    for (const stop of trip.stops) {
      if (stop.time < now - DEPARTED_GRACE_MS) continue;
      let rows = byStop.get(stop.stopId);
      if (!rows) {
        rows = new Map();
        byStop.set(stop.stopId, rows);
      }
      const key = `${route.name}\u0000${destination}`;
      let row = rows.get(key);
      if (!row) {
        row = {
          line: route.name,
          color: route.color,
          destination,
          track: null,
          arrivals: [],
        };
        rows.set(key, row);
      }
      row.arrivals.push(stop.time);
    }
  }
  const index = new Map();
  for (const [stopId, rows] of byStop) {
    const list = [...rows.values()].map((row) => ({
      ...row,
      arrivals: row.arrivals
        .sort((a, b) => a - b)
        .slice(0, AMB_ARRIVALS_PER_ROUTE),
    }));
    list.sort(
      (a, b) =>
        a.arrivals[0] - b.arrivals[0] ||
        a.line.localeCompare(b.line, 'en', { numeric: true }),
    );
    index.set(stopId, list);
  }
  return index;
}
