/**
 * @module fgcGeotren
 * @description Decoder for FGC's Geotren train positions (Ferrocarrils de la
 * Generalitat de Catalunya), read from the Opendatasoft v1 search API of
 * dadesobertes.fgc.cat, dataset `posicionament-dels-trens` (CC BY 4.0).
 *
 * FGC also publishes a GTFS-Realtime VehiclePositions file, but it is served
 * empty for long stretches and carries no route id, so a metro on L6 cannot be
 * told from a train on S1. Geotren names the line and is the source the
 * operator's own map uses. It is regenerated about every two minutes.
 *
 * Output is the shape `decodeVehiclePositions` returns, so the proxy treats
 * Geotren like any other feed. Pure: no Cesium, no Node built-ins.
 */

import {
  GTFS_INCREMENTALITY_FULL_DATASET,
  GTFS_MAX_STRING_CHARS,
  OCCUPANCY_STATUS,
  isPlausibleVehiclePosition,
} from './gtfsRealtime.js';

/** Most records accepted from one answer. FGC runs a few dozen trains. */
export const FGC_GEOTREN_MAX_RECORDS = 2_000;

/** Geotren's per-car crowding level (1 low, 2 medium, 3 high) → GTFS enum. */
const OCCUPANCY_BY_LEVEL = Object.freeze({
  1: OCCUPANCY_STATUS[1], // MANY_SEATS_AVAILABLE
  2: OCCUPANCY_STATUS[2], // FEW_SEATS_AVAILABLE
  3: OCCUPANCY_STATUS[3], // STANDING_ROOM_ONLY
});

const CAR_LEVEL_FIELDS = Object.freeze([
  'ocupacio_mi_tram',
  'ocupacio_ri_tram',
  'ocupacio_m1_tram',
  'ocupacio_m2_tram',
]);

function shortString(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= GTFS_MAX_STRING_CHARS ? text : null;
}

function finite(value) {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

/**
 * Position from the record: `geo_point_2d` is `[lat, lon]` in the v1 API;
 * the GeoJSON `geometry` (`[lon, lat]`) is the fallback.
 */
function positionOf(record) {
  const point = record?.fields?.geo_point_2d;
  if (Array.isArray(point) && point.length === 2) {
    return { lat: finite(point[0]), lon: finite(point[1]) };
  }
  const coordinates = record?.geometry?.coordinates;
  if (Array.isArray(coordinates) && coordinates.length === 2) {
    return { lat: finite(coordinates[1]), lon: finite(coordinates[0]) };
  }
  return { lat: null, lon: null };
}

/**
 * First station code of `properes_parades`, which Geotren publishes as
 * semicolon-joined JSON objects: `{"parada": "TR"};{"parada": "VP"}`.
 * @param {unknown} text
 * @returns {string|null}
 */
export function firstNextStop(text) {
  if (typeof text !== 'string') return null;
  const match = /"parada"\s*:\s*"([^"]{1,16})"/.exec(text);
  return match ? match[1] : null;
}

/** Busiest car's level mapped to the GTFS enum, or null without data. */
function occupancyOf(fields) {
  let level = 0;
  for (const name of CAR_LEVEL_FIELDS) {
    const value = finite(fields?.[name]);
    if (value !== null && value >= 1 && value <= 3)
      level = Math.max(level, value);
  }
  return OCCUPANCY_BY_LEVEL[level] || null;
}

/**
 * One Geotren record → a normalized vehicle record, or null when it cannot
 * be placed or identified. The unit (`ut`) is the vehicle: it survives from
 * one trip to the next, while Geotren's `id` changes with every trip and
 * becomes the trip id.
 * @param {object} record
 * @returns {object|null}
 */
export function normalizeGeotrenRecord(record) {
  const fields = record?.fields;
  if (!fields || typeof fields !== 'object') return null;
  const { lat, lon } = positionOf(record);
  if (!isPlausibleVehiclePosition(lat, lon)) return null;
  const tripId = shortString(fields.id);
  const id = shortString(fields.ut) || tripId;
  if (!id) return null;
  const parkedAt = shortString(fields.estacionat_a);
  const next = firstNextStop(fields.properes_parades);
  return {
    id,
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
    bearing: null,
    speedMps: null,
    timestamp: null,
    routeId: shortString(fields.lin),
    tripId,
    directionId: null,
    label: null,
    stopId: parkedAt || next,
    status: parkedAt ? 'STOPPED_AT' : next ? 'IN_TRANSIT_TO' : null,
    occupancy: occupancyOf(fields),
  };
}

/**
 * Decode a Geotren v1 search answer.
 *
 * A body that is not the expected JSON is an error, never an empty fleet: a
 * malformed answer must keep the last good snapshot on screen (served stale),
 * not wipe FGC off the map. The batch's `record_timestamp` (when the portal
 * processed it) becomes the header time; records carry no time of their own.
 * @param {Uint8Array|ArrayBuffer} bytes Raw response body.
 * @returns {{version: null, timestamp: number|null, incrementality: number,
 *   entityCount: number, truncated: boolean, vehicles: object[]}}
 */
export function decodeFgcGeotren(bytes) {
  const text = new TextDecoder().decode(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  );
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('Geotren answer is not JSON');
  }
  if (!body || !Array.isArray(body.records)) {
    throw new Error('Geotren answer has no records');
  }
  const truncated = body.records.length > FGC_GEOTREN_MAX_RECORDS;
  const records = body.records.slice(0, FGC_GEOTREN_MAX_RECORDS);
  let newest = null;
  const byId = new Map();
  for (const record of records) {
    const stamp = Date.parse(record?.record_timestamp);
    if (Number.isFinite(stamp) && (newest === null || stamp > newest))
      newest = stamp;
    const vehicle = normalizeGeotrenRecord(record);
    // One unit is one train: a duplicate keeps the first record seen.
    if (vehicle && !byId.has(vehicle.id)) byId.set(vehicle.id, vehicle);
  }
  return {
    version: null,
    timestamp: newest === null ? null : Math.floor(newest / 1000),
    incrementality: GTFS_INCREMENTALITY_FULL_DATASET,
    entityCount: records.length,
    truncated,
    vehicles: [...byId.values()],
  };
}
