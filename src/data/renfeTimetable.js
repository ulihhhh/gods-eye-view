/**
 * @module renfeTimetable
 * @description Renfe's timetables for the days around today, from its two
 * static GTFS zips (CC BY 4.0, data.renfe.com): Cercanías
 * (`fomento_transit.zip`) and AV/LD/MD (`google_transit.zip`), for the
 * station boards (`/api/transit/arrivals`). Renfe's trip updates carry one
 * stop per train, so a station's times come from here, moved by the
 * train's live delay (src/data/transitArrivals.js).
 *
 * `calendar.txt` (and `calendar_dates.txt`, AV/LD's exceptions) name the
 * services that run on each day; `trips.txt` and `routes.txt` name each
 * trip; `stop_times.txt` (≈280 MB for Cercanías, 25 MB for AV/LD) is read
 * line by line and only the trips of the kept days are held. GTFS times are counted from noon minus twelve hours,
 * local time, and may pass 24:00 for trains after midnight.
 *
 * Pure: no Cesium, no Node built-ins.
 */
import { parseCsv } from './gtfsCsv.js';
import { cercaniasRouteDestination } from './renfeTripDetails.js';

/** Service days kept: yesterday (trains still running after midnight), today, tomorrow. */
export const RENFE_TIMETABLE_DAYS = Object.freeze([-1, 0, 1]);
/** Longest line or destination kept. */
const MAX_TEXT_CHARS = 60;
const WEEKDAYS = Object.freeze([
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]);

const clean = (value) => {
  const text = String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  return text && text.length <= MAX_TEXT_CHARS ? text : null;
};

/** Rows keyed by trimmed header names (Renfe pads every field with spaces). */
function rows(text) {
  return parseCsv(text).map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key.trim(),
        String(value ?? '').trim(),
      ]),
    ),
  );
}

/**
 * Offset of a time zone from UTC at an instant, in ms.
 * @param {number} ms
 * @param {string} timeZone
 */
function zoneOffsetMs(ms, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(ms)
      .map(({ type, value }) => [type, value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - (ms - (ms % 1000));
}

/**
 * The instant GTFS counts a service day's times from: local noon minus
 * twelve hours (midnight, except on the days the clocks change).
 * @param {string} day `YYYYMMDD`
 * @param {string} timeZone
 * @returns {number} epoch ms
 */
export function gtfsServiceDayStart(day, timeZone) {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(4, 6));
  const d = Number(day.slice(6, 8));
  const noonAsUtc = Date.UTC(y, m - 1, d, 12);
  return noonAsUtc - zoneOffsetMs(noonAsUtc, timeZone) - 12 * 3600_000;
}

/**
 * `YYYYMMDD` and weekday of an instant in a time zone, shifted by days.
 * @param {number} now
 * @param {string} timeZone
 * @param {number} offsetDays
 */
function localDay(now, timeZone, offsetDays) {
  const text = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const [y, m, d] = text.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + offsetDays));
  return {
    day: date.toISOString().slice(0, 10).replaceAll('-', ''),
    weekday: WEEKDAYS[date.getUTCDay()],
  };
}

/** "24:05:00" → seconds; null when malformed. */
function gtfsSeconds(text) {
  const match = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/.exec(text);
  return match
    ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    : null;
}

/**
 * @typedef {{tripId: string, at: number, last: boolean}} TimetableCall
 * @typedef {{line: string|null, train: string|null,
 *   destination: string|null, destinationStopId: string|null,
 *   originStopId: string|null, stops: number}} TimetableTrip
 * @typedef {{stations: Map<string, TimetableCall[]>,
 *   trips: Map<string, Readonly<TimetableTrip>>,
 *   days: string[], builtFor: string}} Timetable
 */

/**
 * A GTFS timetable for the days around `now`. `calendar_dates.txt`, when
 * given, adds (1) and removes (2) service days. A stop where the train
 * neither picks up nor drops off is left out.
 * @param {{files: Map<string, string>,
 *   lines: (name: string) => AsyncIterable<string>,
 *   describe: (trip: Record<string, string>, route: Record<string, string>|null) =>
 *     {line?: string|null, train?: string|null, destination?: string|null,
 *      destinationStopId?: string|null},
 *   now?: number, timeZone?: string}} options `files` holds `calendar.txt`,
 *   `routes.txt`, `trips.txt` and optionally `calendar_dates.txt`; `lines`
 *   streams `stop_times.txt`; `describe` names a trip.
 * @returns {Promise<Timetable>} each station's calls sorted by time
 *   (departure, else arrival); `builtFor` is today's `YYYYMMDD`.
 */
export async function buildGtfsTimetable({
  files,
  lines,
  describe,
  now = Date.now(),
  timeZone = 'Europe/Madrid',
}) {
  const days = RENFE_TIMETABLE_DAYS.map((offset) =>
    localDay(now, timeZone, offset),
  );
  /** service id → kept days it runs on */
  const services = new Map();
  const runs = (id) => {
    if (!services.has(id)) services.set(id, new Set());
    return services.get(id);
  };
  for (const row of rows(files.get('calendar.txt'))) {
    for (const { day, weekday } of days)
      if (row.start_date <= day && day <= row.end_date && row[weekday] === '1')
        runs(row.service_id).add(day);
  }
  const kept = new Set(days.map(({ day }) => day));
  if (files.has('calendar_dates.txt'))
    for (const row of rows(files.get('calendar_dates.txt'))) {
      if (!kept.has(row.date)) continue;
      if (row.exception_type === '1') runs(row.service_id).add(row.date);
      else if (row.exception_type === '2')
        runs(row.service_id).delete(row.date);
    }
  const starts = new Map(
    [...services].map(([id, set]) => [
      id,
      [...set].sort().map((day) => gtfsServiceDayStart(day, timeZone)),
    ]),
  );
  const routes = new Map(
    rows(files.get('routes.txt')).map((row) => [row.route_id, row]),
  );
  /** trip id → start instants of its service days */
  const tripStarts = new Map();
  const tripRows = new Map();
  for (const row of rows(files.get('trips.txt'))) {
    const at = starts.get(row.service_id);
    if (!at?.length || !row.trip_id) continue;
    tripStarts.set(row.trip_id, at);
    tripRows.set(row.trip_id, row);
  }

  const stations = new Map();
  const firstStop = new Map();
  /** trip id + day → its latest call, to mark the trip's last stop */
  const lastCall = new Map();
  /** trip id → stops it serves (a train sold as several trips is the longest) */
  const stopCounts = new Map();
  let column = null;
  for await (const raw of lines('stop_times.txt')) {
    if (column === null) {
      const header = raw.split(',').map((name) => name.trim());
      column = Object.fromEntries(
        [
          'stop_id',
          'arrival_time',
          'departure_time',
          'stop_sequence',
          'pickup_type',
          'drop_off_type',
        ].map((name) => [name, header.indexOf(name)]),
      );
      continue;
    }
    const comma = raw.indexOf(',');
    const tripId = raw.slice(0, comma).trim();
    const tripDays = tripStarts.get(tripId);
    if (!tripDays) continue;
    const cells = raw.split(',');
    const field = (name) =>
      column[name] < 0 ? '' : String(cells[column[name]] ?? '').trim();
    const stopId = field('stop_id');
    const seconds =
      gtfsSeconds(field('departure_time')) ??
      gtfsSeconds(field('arrival_time'));
    const sequence = Number(field('stop_sequence'));
    if (!stopId || seconds === null) continue;
    if (!firstStop.has(tripId) || sequence < firstStop.get(tripId).sequence)
      firstStop.set(tripId, { sequence, stopId });
    const passing =
      field('pickup_type') === '1' && field('drop_off_type') === '1';
    if (!passing) stopCounts.set(tripId, (stopCounts.get(tripId) || 0) + 1);
    for (const start of tripDays) {
      const call = { tripId, at: start + seconds * 1000, last: false };
      const key = `${tripId}\u0000${start}`;
      const previous = lastCall.get(key);
      if (!previous || sequence > previous.sequence)
        lastCall.set(key, { sequence, call });
      if (passing) continue;
      if (!stations.has(stopId)) stations.set(stopId, []);
      stations.get(stopId).push(call);
    }
  }
  for (const { call } of lastCall.values()) call.last = true;
  for (const calls of stations.values()) calls.sort((a, b) => a.at - b.at);

  const trips = new Map();
  for (const [tripId, row] of tripRows) {
    if (!firstStop.has(tripId)) continue;
    const named = describe(row, routes.get(row.route_id) ?? null) || {};
    trips.set(
      tripId,
      Object.freeze({
        line: clean(named.line),
        train: clean(named.train),
        destination: clean(named.destination),
        destinationStopId: clean(named.destinationStopId),
        originStopId: firstStop.get(tripId).stopId,
        stops: stopCounts.get(tripId) || 0,
      }),
    );
  }
  return {
    stations,
    trips,
    days: days.map(({ day }) => day),
    builtFor: timetableDay(now, timeZone),
  };
}

/**
 * The train number in a Cercanías trip id: service (`1001J`), train
 * (`19799`), line (`C1`, `R2N`).
 */
const CERCANIAS_TRIP_TRAIN = /^\d{4}[A-Z](\d+?)[A-Z][A-Za-z0-9]*$/;

/** Train numbers compare as numbers: LD writes `00190`, Cercanías `190`. */
function trainNumber(text) {
  return /^\d{1,8}$/.test(String(text ?? '')) ? String(Number(text)) : null;
}

/**
 * Cercanías: the line is `route_short_name`, the destination the second
 * half of the fixed-width `route_long_name`, the train number in the trip
 * id. One service id per network and date, and no `calendar_dates.txt`.
 * @param {{files: Map<string, string>,
 *   lines: (name: string) => AsyncIterable<string>,
 *   now?: number, timeZone?: string}} options
 * @returns {Promise<Timetable>}
 */
export function buildCercaniasTimetable(options) {
  return buildGtfsTimetable({
    ...options,
    describe: (trip, route) => ({
      line: route?.route_short_name,
      train: trainNumber(CERCANIAS_TRIP_TRAIN.exec(trip.trip_id)?.[1]),
      destination: cercaniasRouteDestination(route?.route_long_name),
    }),
  });
}

/**
 * AV/LD/MD: the service (AVE, ALVIA, MD…) and the train number name the
 * trip (`AVE 3100`); the destination is the station code in characters
 * 6–10 of `route_id`, named by the feed's station dictionary.
 * `calendar_dates.txt` removes days from long services.
 * @param {{files: Map<string, string>,
 *   lines: (name: string) => AsyncIterable<string>,
 *   now?: number, timeZone?: string}} options
 * @returns {Promise<Timetable>}
 */
export function buildRenfeLdTimetable(options) {
  return buildGtfsTimetable({
    ...options,
    describe: (trip, route) => {
      const service = clean(route?.route_short_name);
      const train = trainNumber(trip.trip_short_name);
      return {
        line: [service, train].filter(Boolean).join(' ') || null,
        train,
        destinationStopId:
          /^\d{5}(\d{5})/.exec(String(trip.route_id ?? ''))?.[1] ?? null,
      };
    },
  });
}

/**
 * Today's `YYYYMMDD` in a time zone (whether a timetable is still current).
 * @param {number} now
 * @param {string} timeZone
 */
export function timetableDay(now, timeZone = 'Europe/Madrid') {
  return localDay(now, timeZone, 0).day;
}
