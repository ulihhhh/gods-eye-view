/**
 * @module renfeTimetable
 * @description Renfe Cercanías' timetable for the days around today, from
 * its static GTFS (`fomento_transit.zip`, CC BY 4.0, data.renfe.com), for
 * the station boards (`/api/transit/arrivals`). Renfe's trip updates carry
 * one stop per train, so a station's times come from here, moved by the
 * train's live delay (src/data/transitArrivals.js).
 *
 * `calendar.txt` names the services that run on each day (Cercanías has one
 * service id per network and date, and no `calendar_dates.txt`);
 * `trips.txt` and `routes.txt` give each trip its line and destination;
 * `stop_times.txt` (≈280 MB) is read line by line and only the trips of the
 * kept days are held. GTFS times are counted from noon minus twelve hours,
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
 * @typedef {{stations: Map<string, TimetableCall[]>,
 *   trips: Map<string, Readonly<{line: string|null,
 *     destination: string|null, originStopId: string|null}>>,
 *   days: string[], builtFor: string}} Timetable
 */

/**
 * @param {{files: Map<string, string>,
 *   lines: (name: string) => AsyncIterable<string>,
 *   now?: number, timeZone?: string}} options `files` holds `calendar.txt`,
 *   `routes.txt` and `trips.txt`; `lines` streams `stop_times.txt`.
 * @returns {Promise<Timetable>} each station's calls sorted by time
 *   (departure, else arrival); `builtFor` is today's `YYYYMMDD`.
 */
export async function buildCercaniasTimetable({
  files,
  lines,
  now = Date.now(),
  timeZone = 'Europe/Madrid',
}) {
  const days = RENFE_TIMETABLE_DAYS.map((offset) =>
    localDay(now, timeZone, offset),
  );
  /** service id → start instants of the kept days it runs on */
  const services = new Map();
  for (const row of rows(files.get('calendar.txt'))) {
    for (const { day, weekday } of days) {
      if (row.start_date > day || row.end_date < day || row[weekday] !== '1')
        continue;
      if (!services.has(row.service_id)) services.set(row.service_id, []);
      services.get(row.service_id).push(gtfsServiceDayStart(day, timeZone));
    }
  }
  const routes = new Map();
  for (const row of rows(files.get('routes.txt')))
    routes.set(row.route_id, {
      line: clean(row.route_short_name),
      destination: cercaniasRouteDestination(row.route_long_name),
    });
  /** trip id → start instants of its service days */
  const tripStarts = new Map();
  const tripRoutes = new Map();
  for (const row of rows(files.get('trips.txt'))) {
    const starts = services.get(row.service_id);
    if (!starts || !row.trip_id) continue;
    tripStarts.set(row.trip_id, starts);
    tripRoutes.set(row.trip_id, routes.get(row.route_id) ?? null);
  }

  const stations = new Map();
  const firstStop = new Map();
  /** trip id → its latest call, to mark the trip's last stop */
  const lastCall = new Map();
  let column = null;
  for await (const raw of lines('stop_times.txt')) {
    if (column === null) {
      const header = raw.split(',').map((name) => name.trim());
      column = Object.fromEntries(
        ['stop_id', 'arrival_time', 'departure_time', 'stop_sequence'].map(
          (name) => [name, header.indexOf(name)],
        ),
      );
      continue;
    }
    const comma = raw.indexOf(',');
    const tripId = raw.slice(0, comma).trim();
    const starts = tripStarts.get(tripId);
    if (!starts) continue;
    const cells = raw.split(',');
    const field = (name) => String(cells[column[name]] ?? '').trim();
    const stopId = field('stop_id');
    const seconds =
      gtfsSeconds(field('departure_time')) ??
      gtfsSeconds(field('arrival_time'));
    const sequence = Number(field('stop_sequence'));
    if (!stopId || seconds === null) continue;
    if (!firstStop.has(tripId) || sequence < firstStop.get(tripId).sequence)
      firstStop.set(tripId, { sequence, stopId });
    if (!stations.has(stopId)) stations.set(stopId, []);
    for (const start of starts) {
      const call = { tripId, at: start + seconds * 1000, last: false };
      stations.get(stopId).push(call);
      const key = `${tripId}\u0000${start}`;
      const previous = lastCall.get(key);
      if (!previous || sequence > previous.sequence)
        lastCall.set(key, { sequence, call });
    }
  }
  for (const { call } of lastCall.values()) call.last = true;
  for (const calls of stations.values()) calls.sort((a, b) => a.at - b.at);

  const trips = new Map();
  for (const [tripId, route] of tripRoutes) {
    if (!firstStop.has(tripId)) continue;
    trips.set(
      tripId,
      Object.freeze({
        line: route?.line ?? null,
        destination: route?.destination ?? null,
        originStopId: firstStop.get(tripId).stopId,
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
 * Today's `YYYYMMDD` in a time zone (whether a timetable is still current).
 * @param {number} now
 * @param {string} timeZone
 */
export function timetableDay(now, timeZone = 'Europe/Madrid') {
  return localDay(now, timeZone, 0).day;
}
