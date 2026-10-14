/**
 * @module gtfsTripUpdates
 * @description Minimal GTFS-Realtime decoder for TripUpdates feeds: each live
 * trip with its delay and its predicted time at the stops still ahead.
 * Shared by the Barcelona arrivals proxy (AMB) and the Transit proxy's
 * registry hook `tripUpdates` (FGC, Renfe).
 *
 * Field numbers (gtfs-realtime.proto, v2.0):
 *   FeedEntity         1 id, 2 is_deleted, 3 trip_update
 *   TripUpdate         1 trip, 2 stop_time_update[], 3 vehicle, 4 timestamp,
 *                      5 delay
 *   StopTimeUpdate     1 stop_sequence, 2 arrival, 3 departure, 4 stop_id,
 *                      5 schedule_relationship
 *   StopTimeEvent      1 delay, 2 time
 *
 * Bounded like `gtfsRealtime.js`: entities past GTFS_MAX_ENTITIES and stops
 * past MAX_STOPS_PER_TRIP are left unread, and an over-long string drops the
 * record it belongs to. Pure: no Cesium, no Node built-ins.
 */
import { PbfReader } from 'pbf';
import { GTFS_MAX_ENTITIES, GTFS_MAX_STRING_CHARS } from './gtfsRealtime.js';

/** Stop time updates read per trip; a long route has well under 100 stops. */
const MAX_STOPS_PER_TRIP = 400;

/** StopTimeUpdate.ScheduleRelationship.SKIPPED and TripDescriptor CANCELED. */
const STOP_SKIPPED = 1;
const TRIP_CANCELED = 3;

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
  if (tag === 1) event.delay = pbf.readVarint(true);
  else if (tag === 2) event.time = pbf.readVarint(true);
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
  else if (tag === 5) tripUpdate.delay = pbf.readVarint(true);
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

const finiteInt = (value) => (Number.isFinite(value) ? value : null);

/**
 * Decode a TripUpdates feed into plain trips with their predicted stop
 * times (epoch ms). Skipped stops, cancelled trips and deleted entities are
 * left out. `delaySec` is the trip's own delay, else the delay of its first
 * stop that gives one; null when the feed says neither.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {{timestamp: number|null, trips: Array<{tripId: string,
 *   routeId: string|null, vehicleId: string|null, vehicleLabel: string|null,
 *   delaySec: number|null, stops: Array<{stopId: string, time: number}>}>}}
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
    let stopDelay = null;
    for (const stop of update.stops) {
      if (!stop.stopId || stop.oversize) continue;
      if (stop.scheduleRelationship === STOP_SKIPPED) continue;
      stopDelay ??= finiteInt(stop.arrival?.delay ?? stop.departure?.delay);
      const seconds = stop.arrival?.time ?? stop.departure?.time;
      if (!Number.isFinite(seconds) || seconds <= 0) continue;
      stops.push({ stopId: stop.stopId, time: seconds * 1000 });
    }
    trips.push({
      tripId: trip.tripId,
      routeId: trip.routeId || null,
      vehicleId: update.vehicle?.id || null,
      vehicleLabel: update.vehicle?.label || null,
      delaySec: finiteInt(update.delay) ?? stopDelay,
      stops,
    });
  }
  const seconds = message.header?.timestamp;
  return {
    timestamp: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
    trips,
  };
}
