/**
 * @module estimatedPositions
 * @description Position engine for vehicles whose operator publishes times,
 * not positions: TMB's metro (predicted arrivals) and, later, Swiss trains
 * (timetable plus delay). Each source builds one TIMELINE per vehicle, and
 * this module places the vehicle on it at an instant:
 *
 *   {id, routeId, tripId, label, destination?, routeColor?, stops: [{stopId, name?, lat,
 *     lon, arr, dep}]}
 *
 * with absolute times in ms and the stops in running order. Between two
 * stops the vehicle is interpolated along the segment's geometry
 * (`segmentPath`, a straight line when there is none); between a stop's
 * arrival and departure it stands at the stop.
 *
 * Every record it returns says `estimated: true`, so the layer can draw and
 * describe it as an estimate (docs/plans/transit-estimated-positions.md).
 *
 * Pure: no Cesium, no Node built-ins, no clock of its own. The smoother keeps
 * state between calls, but only what the caller passes it.
 */

/** How long a vehicle past its last stop's departure still stands there. */
export const ESTIMATE_END_GRACE_MS = 60_000;

/** Next stops carried on a record (the card names four). */
export const ESTIMATE_NEXT_STOPS = 6;

/** A held (backwards) correction is given up after this long. */
export const ESTIMATE_HOLD_MAX_MS = 90_000;

/** A correction longer than this is a reset, not a drift: taken at once. */
export const ESTIMATE_RESET_M = 3_000;

/** A vehicle not estimated for this long is forgotten by the smoother. */
export const ESTIMATE_FORGET_MS = 5 * 60_000;

/** A line colour as six hex digits, without `#` (GTFS `route_color`). */
const ROUTE_COLOR = /^[0-9A-Fa-f]{6}$/;

const EARTH_M = 6_371_000;
const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
export function distanceM(aLat, aLon, bLat, bLon) {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from north. */
export function bearingDeg(aLat, aLon, bLat, bLon) {
  const y = Math.sin(toRad(bLon - aLon)) * Math.cos(toRad(bLat));
  const x =
    Math.cos(toRad(aLat)) * Math.sin(toRad(bLat)) -
    Math.sin(toRad(aLat)) *
      Math.cos(toRad(bLat)) *
      Math.cos(toRad(bLon - aLon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validStop(stop) {
  return (
    stop &&
    typeof stop.stopId === 'string' &&
    stop.stopId !== '' &&
    finite(stop.lat) &&
    finite(stop.lon) &&
    Math.abs(stop.lat) <= 90 &&
    Math.abs(stop.lon) <= 180 &&
    finite(stop.arr) &&
    finite(stop.dep) &&
    stop.dep >= stop.arr
  );
}

/**
 * The usable stops of a timeline: valid, and never earlier than the stop
 * before. A stop that breaks the order is dropped, not reordered: a timeline
 * that runs backwards is a fault in the source, and guessing would move the
 * vehicle the wrong way.
 * @param {object} timeline
 * @returns {object[]}
 */
export function timelineStops(timeline) {
  const stops = [];
  for (const stop of Array.isArray(timeline?.stops) ? timeline.stops : []) {
    if (!validStop(stop)) continue;
    const last = stops.at(-1);
    if (last && stop.arr < last.dep) continue;
    stops.push(stop);
  }
  return stops;
}

/**
 * The polyline between two stops as [[lon, lat], …], from the caller's
 * geometry when it has the segment, else the straight line.
 */
function pathBetween(from, to, segmentPath) {
  const path = typeof segmentPath === 'function' ? segmentPath(from, to) : null;
  if (Array.isArray(path) && path.length >= 2) {
    const points = path.filter(
      (point) => Array.isArray(point) && finite(point[0]) && finite(point[1]),
    );
    if (points.length >= 2) return points;
  }
  return [
    [from.lon, from.lat],
    [to.lon, to.lat],
  ];
}

/**
 * The point a fraction of the way along a polyline, by distance, with the
 * bearing of the piece it falls on.
 * @param {number[][]} path [[lon, lat], …]
 * @param {number} fraction 0…1
 * @returns {{lat: number, lon: number, bearing: number|null}}
 */
export function pointAlong(path, fraction) {
  const pieces = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const [aLon, aLat] = path[i - 1];
    const [bLon, bLat] = path[i];
    const length = distanceM(aLat, aLon, bLat, bLon);
    pieces.push(length);
    total += length;
  }
  if (!(total > 0)) {
    const [lon, lat] = path[0];
    return { lat, lon, bearing: null };
  }
  let remaining = Math.min(1, Math.max(0, fraction)) * total;
  for (let i = 0; i < pieces.length; i++) {
    const [aLon, aLat] = path[i];
    const [bLon, bLat] = path[i + 1];
    if (pieces[i] === 0) continue;
    if (remaining <= pieces[i] || i === pieces.length - 1) {
      const f = Math.min(1, remaining / pieces[i]);
      return {
        lat: aLat + (bLat - aLat) * f,
        lon: aLon + (bLon - aLon) * f,
        bearing: bearingDeg(aLat, aLon, bLat, bLon),
      };
    }
    remaining -= pieces[i];
  }
  const [lon, lat] = path.at(-1);
  return { lat, lon, bearing: null };
}

function segmentBearing(from, to, segmentPath) {
  const path = pathBetween(from, to, segmentPath);
  return pointAlong(path, from === to ? 0 : 0.0001).bearing;
}

/**
 * Where a timeline puts its vehicle at instant `t`.
 *
 * - Before its first stop's departure the vehicle stands at that stop.
 * - Between a stop's arrival and departure it stands at the stop.
 * - Between a departure and the next arrival it runs along the segment.
 * - Past the last stop it stands there for ESTIMATE_END_GRACE_MS, then the
 *   timeline is over (null).
 *
 * `fromStopId` / `toStopId` / `fraction` say where on the timeline it is (at
 * a stop both ids are that stop), which the smoother uses to tell a vehicle
 * moving on from one moving back.
 *
 * @param {object} timeline
 * @param {number} t ms epoch.
 * @param {{segmentPath?: (from: object, to: object, timeline: object) => number[][]|null}} [options]
 *   `segmentPath` gets the timeline too, so a source can pick the track of
 *   the vehicle's own line.
 * @returns {{lat: number, lon: number, bearing: number|null,
 *   status: 'STOPPED_AT'|'IN_TRANSIT_TO', stopId: string, stopName: string|null,
 *   fromStopId: string, toStopId: string, fraction: number,
 *   nextIndex: number}|null}
 *   `nextIndex` is the first stop still ahead (or the one stood at).
 */
export function positionOnTimeline(timeline, t, options = {}) {
  const segmentPath =
    typeof options.segmentPath === 'function'
      ? (from, to) => options.segmentPath(from, to, timeline)
      : null;
  const stops = timelineStops(timeline);
  if (!stops.length || !finite(t)) return null;
  const at = (i) => {
    const stop = stops[i];
    const next = stops[i + 1];
    const prev = stops[i - 1];
    const bearing = next
      ? segmentBearing(stop, next, segmentPath)
      : prev
        ? segmentBearing(prev, stop, segmentPath)
        : null;
    return {
      lat: stop.lat,
      lon: stop.lon,
      bearing,
      // i18n-ignore: GTFS-Realtime status values, not text
      status: 'STOPPED_AT',
      stopId: stop.stopId,
      stopName: stop.name || null,
      fromStopId: stop.stopId,
      toStopId: stop.stopId,
      fraction: 0,
      nextIndex: i,
    };
  };
  if (t <= stops[0].dep) return at(0);
  for (let i = 0; i < stops.length - 1; i++) {
    const from = stops[i];
    const to = stops[i + 1];
    if (t < from.dep) return at(i);
    if (t < to.arr) {
      const span = to.arr - from.dep;
      const fraction = span > 0 ? (t - from.dep) / span : 1;
      const point = pointAlong(pathBetween(from, to, segmentPath), fraction);
      return {
        lat: point.lat,
        lon: point.lon,
        bearing: point.bearing,
        // i18n-ignore: GTFS-Realtime status values, not text
        status: 'IN_TRANSIT_TO',
        stopId: to.stopId,
        stopName: to.name || null,
        fromStopId: from.stopId,
        toStopId: to.stopId,
        fraction,
        nextIndex: i + 1,
      };
    }
  }
  const last = stops.length - 1;
  return t <= stops[last].dep + ESTIMATE_END_GRACE_MS ? at(last) : null;
}

/**
 * Whether estimate `next` sits behind `prev` on the same run: further back
 * on the segment it shared, still approaching a stop `prev` was already at
 * or past, or back at the stop `prev` had left.
 */
function behind(prev, next) {
  if (next.fromStopId === prev.fromStopId && next.toStopId === prev.toStopId)
    return next.fraction < prev.fraction;
  if (next.toStopId === prev.fromStopId && next.fromStopId !== prev.fromStopId)
    return true;
  return (
    prev.fromStopId !== prev.toStopId &&
    next.fromStopId === prev.fromStopId &&
    next.toStopId === prev.fromStopId
  );
}

/**
 * Keeps estimated vehicles from jumping when a prediction changes.
 *
 * - A correction BACKWARDS (the train is later than predicted) is held: the
 *   vehicle waits where it was until the estimate catches up, or for
 *   ESTIMATE_HOLD_MAX_MS, after which the new estimate is taken.
 * - A correction FORWARDS faster than `maxSpeedMps` is spread over the
 *   following calls, so the vehicle catches up at a train's speed instead of
 *   teleporting. Past ESTIMATE_RESET_M it is a reset and is taken at once.
 *
 * @param {{maxSpeedMps?: number}} [options]
 */
export function createEstimateSmoother({ maxSpeedMps = 25 } = {}) {
  /** @type {Map<string, {t: number, lat: number, lon: number, bearing: number|null, fromStopId: string, toStopId: string, fraction: number, holdSince: number|null, shown: object}>} */
  const last = new Map();

  return {
    /**
     * @param {string} id
     * @param {object} estimate positionOnTimeline's answer.
     * @param {number} t
     * @returns {object} The estimate to show (possibly held or eased).
     */
    smooth(id, estimate, t) {
      const prev = last.get(id);
      const remember = (shown, holdSince = null) => {
        last.set(id, {
          t,
          lat: shown.lat,
          lon: shown.lon,
          fromStopId: estimate.fromStopId,
          toStopId: estimate.toStopId,
          fraction: estimate.fraction,
          holdSince,
          shown,
        });
        return shown;
      };
      if (!prev || t <= prev.t) return remember(estimate);
      if (behind(prev, estimate)) {
        const since = prev.holdSince ?? prev.t;
        if (t - since < ESTIMATE_HOLD_MAX_MS) {
          // Keep the shown point and the place it stands for.
          last.set(id, { ...prev, t, holdSince: since });
          return prev.shown;
        }
        return remember(estimate);
      }
      const gap = distanceM(prev.lat, prev.lon, estimate.lat, estimate.lon);
      const reach = maxSpeedMps * Math.max(1, (t - prev.t) / 1000);
      if (gap <= reach || gap > ESTIMATE_RESET_M) return remember(estimate);
      const f = reach / gap;
      return remember({
        ...estimate,
        lat: prev.lat + (estimate.lat - prev.lat) * f,
        lon: prev.lon + (estimate.lon - prev.lon) * f,
        bearing: bearingDeg(prev.lat, prev.lon, estimate.lat, estimate.lon),
      });
    },
    /** Forget vehicles not estimated since `t - ESTIMATE_FORGET_MS`. */
    prune(t) {
      for (const [id, entry] of last)
        if (t - entry.t > ESTIMATE_FORGET_MS) last.delete(id);
    },
    get size() {
      return last.size;
    },
  };
}

/**
 * Vehicle records for the Transit layer from a set of timelines at `t`: the
 * normalized record shape every feed decoder returns, plus `estimated: true`
 * and `estimatedFrom` (what the estimate rests on, e.g. 'predictions' or
 * 'schedule'). Timelines with nothing to show at `t` are skipped.
 *
 * `madeAt` is when the estimate is made, if not at `t`: the place is for `t`
 * and the record's `timestamp` is `madeAt`, with `estimateLeadS` saying how
 * far ahead of it the place is (registry `estimateLeadMs`).
 *
 * @param {object[]} timelines
 * @param {number} t ms epoch the positions are for.
 * @param {{segmentPath?: Function, smoother?: ReturnType<typeof createEstimateSmoother>,
 *   source?: string, madeAt?: number}} [options]
 * @returns {object[]}
 */
export function estimateVehicles(
  timelines,
  t,
  { segmentPath, smoother = null, source = 'predictions', madeAt = t } = {},
) {
  const leadS = Math.round((t - madeAt) / 1000);
  const vehicles = [];
  const seen = new Set();
  for (const timeline of Array.isArray(timelines) ? timelines : []) {
    const id = typeof timeline?.id === 'string' ? timeline.id : '';
    if (!id || seen.has(id)) continue;
    const raw = positionOnTimeline(timeline, t, { segmentPath });
    if (!raw) continue;
    seen.add(id);
    const shown = smoother ? smoother.smooth(id, raw, t) : raw;
    const stops = timelineStops(timeline);
    const ahead = stops
      .slice(raw.status === 'STOPPED_AT' ? raw.nextIndex + 1 : raw.nextIndex)
      .filter((stop) => stop.arr >= t - 30_000);
    vehicles.push({
      id,
      lat: Number(shown.lat.toFixed(6)),
      lon: Number(shown.lon.toFixed(6)),
      bearing: finite(shown.bearing) ? Math.round(shown.bearing) : null,
      speedMps: null,
      timestamp: Math.floor(madeAt / 1000),
      routeId: timeline.routeId ?? null,
      tripId: timeline.tripId ?? null,
      directionId: null,
      label: timeline.label ?? null,
      stopId: shown.stopId,
      status: shown.status,
      occupancy: null,
      ...(shown.stopName ? { stopName: shown.stopName } : {}),
      ...(timeline.destination ? { destination: timeline.destination } : {}),
      ...(typeof timeline.routeColor === 'string' &&
      ROUTE_COLOR.test(timeline.routeColor)
        ? { routeColor: timeline.routeColor.toUpperCase() }
        : {}),
      ...(ahead.length
        ? {
            nextStops: ahead.slice(0, ESTIMATE_NEXT_STOPS).map((stop) => ({
              stopId: stop.stopId,
              ...(stop.name ? { name: stop.name } : {}),
              at: stop.arr,
            })),
            ...(ahead.length > ESTIMATE_NEXT_STOPS
              ? { nextStopsMore: ahead.length - ESTIMATE_NEXT_STOPS }
              : {}),
          }
        : {}),
      estimated: true,
      estimatedFrom: source,
      ...(leadS > 0 ? { estimateLeadS: leadS } : {}),
    });
  }
  smoother?.prune(t);
  return vehicles;
}
