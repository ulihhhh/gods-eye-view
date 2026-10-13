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
import { PbfReader } from 'pbf';
import { GTFS_MAX_ENTITIES, GTFS_MAX_STRING_CHARS } from './gtfsRealtime.js';
import { parseCsv } from './gtfsCsv.js';

export { parseCsv };

/** AMB stop ids are six digits ("000108" is TMB's stop 108). */
export const AMB_STOP_ID_PATTERN = /^\d{6}$/;

/** Arrivals kept per line and destination. */
export const AMB_ARRIVALS_PER_ROUTE = 3;

/** A prediction this far in the past is a bus that has gone. */
const DEPARTED_GRACE_MS = 60_000;

/** Stop time updates read per trip; a long route has well under 100 stops. */
const MAX_STOPS_PER_TRIP = 400;

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

// --- GTFS-Realtime TripUpdates ----------------------------------------------

function readBoundedString(pbf, target) {
  const value = pbf.readString();
  if (value.length <= GTFS_MAX_STRING_CHARS) return value;
  target.oversize = true;
  return null;
}

function readHeader(tag, header, pbf) {
  if (tag === 2) header.incrementality = pbf.readVarint();
  else if (tag === 3) header.timestamp = pbf.readVarint();
}

function readTrip(tag, trip, pbf) {
  if (tag === 1) trip.tripId = readBoundedString(pbf, trip);
  else if (tag === 5) trip.routeId = readBoundedString(pbf, trip);
  else if (tag === 4) trip.scheduleRelationship = pbf.readVarint();
}

function readVehicle(tag, vehicle, pbf) {
  if (tag === 1) vehicle.id = readBoundedString(pbf, vehicle);
  else if (tag === 2) vehicle.label = readBoundedString(pbf, vehicle);
}

function readStopTimeEvent(tag, event, pbf) {
  if (tag === 1) event.delay = pbf.readSVarint();
  else if (tag === 2) event.time = pbf.readVarint();
}

function readStopTimeUpdate(tag, update, pbf) {
  if (tag === 1) update.stopSequence = pbf.readVarint();
  else if (tag === 2) update.arrival = pbf.readMessage(readStopTimeEvent, {});
  else if (tag === 3) update.departure = pbf.readMessage(readStopTimeEvent, {});
  else if (tag === 4) update.stopId = readBoundedString(pbf, update);
  else if (tag === 5) update.scheduleRelationship = pbf.readVarint();
}

function readTripUpdate(tag, tripUpdate, pbf) {
  if (tag === 1) tripUpdate.trip = pbf.readMessage(readTrip, {});
  else if (tag === 3) tripUpdate.vehicle = pbf.readMessage(readVehicle, {});
  else if (tag === 2) {
    if (tripUpdate.stops.length >= MAX_STOPS_PER_TRIP) return;
    tripUpdate.stops.push(pbf.readMessage(readStopTimeUpdate, {}));
  }
}

function readEntity(tag, entity, pbf) {
  if (tag === 1) entity.id = readBoundedString(pbf, entity);
  else if (tag === 2) entity.isDeleted = pbf.readBoolean();
  else if (tag === 3)
    entity.tripUpdate = pbf.readMessage(readTripUpdate, { stops: [] });
}

function readMessage(tag, message, pbf) {
  if (tag === 1) message.header = pbf.readMessage(readHeader, {});
  else if (tag === 2) {
    if (message.entities.length >= GTFS_MAX_ENTITIES) {
      message.truncated = true;
      return;
    }
    message.entities.push(pbf.readMessage(readEntity, {}));
  }
}

/** StopTimeUpdate.ScheduleRelationship.SKIPPED and TripDescriptor CANCELED. */
const STOP_SKIPPED = 1;
const TRIP_CANCELED = 3;

/**
 * Decode a TripUpdates feed into plain trips with their predicted stop
 * times (epoch ms). Skipped stops, cancelled trips and deleted entities are
 * left out.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {{timestamp: number|null, trips: Array<{tripId: string,
 *   routeId: string|null, vehicleId: string|null, vehicleLabel: string|null,
 *   stops: Array<{stopId: string, time: number}>}>}}
 */
export function decodeTripUpdates(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const message = new PbfReader(view).readFields(readMessage, {
    header: {},
    entities: [],
    truncated: false,
  });
  const trips = [];
  for (const entity of message.entities) {
    const update = entity.tripUpdate;
    if (!update || entity.isDeleted || entity.oversize) continue;
    const trip = update.trip || {};
    if (!trip.tripId || trip.oversize) continue;
    if (trip.scheduleRelationship === TRIP_CANCELED) continue;
    const stops = [];
    for (const stop of update.stops) {
      if (!stop.stopId || stop.oversize) continue;
      if (stop.scheduleRelationship === STOP_SKIPPED) continue;
      const seconds = stop.arrival?.time ?? stop.departure?.time;
      if (!Number.isFinite(seconds) || seconds <= 0) continue;
      stops.push({ stopId: stop.stopId, time: seconds * 1000 });
    }
    trips.push({
      tripId: trip.tripId,
      routeId: trip.routeId || null,
      vehicleId: update.vehicle?.id || null,
      vehicleLabel: update.vehicle?.label || null,
      stops,
    });
  }
  const seconds = message.header?.timestamp;
  return {
    timestamp: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
    trips,
  };
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
