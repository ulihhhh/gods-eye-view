/**
 * @module gtfsAlerts
 * @description Minimal GTFS-Realtime decoder for service Alerts feeds
 * (Renfe, FGC, AMB): each alert's text in every language it is given in,
 * when it applies, and the routes, stops and trips it names.
 *
 * Field numbers (gtfs-realtime.proto, v2.0):
 *   FeedEntity       1 id, 2 is_deleted, 5 alert
 *   Alert            1 active_period[], 5 informed_entity[], 6 cause,
 *                    7 effect, 10 header_text, 11 description_text
 *   TimeRange        1 start, 2 end (POSIX seconds)
 *   EntitySelector   1 agency_id, 2 route_id, 4 trip, 5 stop_id
 *   TripDescriptor   1 trip_id, 5 route_id
 *   TranslatedString 1 translation[] → Translation 1 text, 2 language
 *
 * Text is plain: control characters become spaces, runs of space collapse,
 * and a header or description past its cap is cut at a word with "…". No
 * alert URL is read, and nothing here is ever rendered as HTML. Bounded like
 * `gtfsRealtime.js`. Pure: no Cesium, no Node built-ins.
 */
import { PbfReader } from 'pbf';
import { GTFS_MAX_ENTITIES, GTFS_MAX_STRING_CHARS } from './gtfsRealtime.js';

/** Alerts kept from one feed (FGC publishes ~330, mostly per trip). */
export const ALERTS_MAX = 2_000;
/** Longest header kept, and longest description. */
export const ALERTS_MAX_HEADER_CHARS = 300;
export const ALERTS_MAX_DESCRIPTION_CHARS = 600;
/** Per alert: languages, active periods and informed entities kept. */
const MAX_LANGUAGES = 4;
const MAX_PERIODS = 32;
const MAX_ENTITIES = 400;
const MAX_ID_CHARS = 128;

/** GTFS-Realtime Alert.Effect and Alert.Cause, by number. */
const EFFECTS = Object.freeze([
  null,
  'NO_SERVICE',
  'REDUCED_SERVICE',
  'SIGNIFICANT_DELAYS',
  'DETOUR',
  'ADDITIONAL_SERVICE',
  'MODIFIED_SERVICE',
  'OTHER_EFFECT',
  'UNKNOWN_EFFECT',
  'STOP_MOVED',
  'NO_EFFECT',
  'ACCESSIBILITY_ISSUE',
]);
const CAUSES = Object.freeze([
  null,
  'UNKNOWN_CAUSE',
  'OTHER_CAUSE',
  'TECHNICAL_PROBLEM',
  'STRIKE',
  'DEMONSTRATION',
  'ACCIDENT',
  'HOLIDAY',
  'WEATHER',
  'MAINTENANCE',
  'CONSTRUCTION',
  'POLICE_ACTIVITY',
  'MEDICAL_EMERGENCY',
]);

function readBoundedString(pbf, target) {
  const value = pbf.readString();
  if (value.length <= GTFS_MAX_STRING_CHARS) return value;
  target.oversize = true;
  return null;
}

/**
 * Plain, bounded text.
 * @param {unknown} value
 * @param {number} max
 * @returns {string|null}
 */
export function alertText(value, max) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function readTranslation(tag, translation, pbf) {
  if (tag === 1) translation.text = readBoundedString(pbf, translation);
  else if (tag === 2)
    translation.language = readBoundedString(pbf, translation);
}

function readTranslated(tag, translated, pbf) {
  if (tag !== 1 || translated.list.length >= MAX_LANGUAGES) return;
  translated.list.push(pbf.readMessage(readTranslation, {}));
}

function readTimeRange(tag, range, pbf) {
  if (tag === 1) range.start = pbf.readVarint();
  else if (tag === 2) range.end = pbf.readVarint();
}

function readTrip(tag, trip, pbf) {
  if (tag === 1) trip.tripId = readBoundedString(pbf, trip);
  else if (tag === 5) trip.routeId = readBoundedString(pbf, trip);
}

function readSelector(tag, selector, pbf) {
  if (tag === 2) selector.routeId = readBoundedString(pbf, selector);
  else if (tag === 4) selector.trip = pbf.readMessage(readTrip, {});
  else if (tag === 5) selector.stopId = readBoundedString(pbf, selector);
}

function readAlert(tag, alert, pbf) {
  if (tag === 1) {
    if (alert.periods.length < MAX_PERIODS)
      alert.periods.push(pbf.readMessage(readTimeRange, {}));
  } else if (tag === 5) {
    if (alert.selectors.length < MAX_ENTITIES)
      alert.selectors.push(pbf.readMessage(readSelector, {}));
  } else if (tag === 6) alert.cause = pbf.readVarint();
  else if (tag === 7) alert.effect = pbf.readVarint();
  else if (tag === 10)
    alert.header = pbf.readMessage(readTranslated, { list: [] });
  else if (tag === 11)
    alert.description = pbf.readMessage(readTranslated, { list: [] });
}

function readEntity(tag, entity, pbf) {
  if (tag === 1) entity.id = readBoundedString(pbf, entity);
  else if (tag === 2) entity.isDeleted = pbf.readBoolean();
  else if (tag === 5)
    entity.alert = pbf.readMessage(readAlert, { periods: [], selectors: [] });
}

function readMessage(tag, message, pbf) {
  if (tag !== 2) return;
  if (message.entities.length >= GTFS_MAX_ENTITIES) return;
  message.entities.push(pbf.readMessage(readEntity, {}));
}

/** `{language: text}` of a TranslatedString; "" for an unnamed language. */
function translations(translated, max) {
  const out = {};
  for (const { text, language } of translated?.list || []) {
    const clean = alertText(text, max);
    if (!clean) continue;
    const key = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(language || '')
      ? language.toLowerCase()
      : '';
    if (!Object.hasOwn(out, key)) out[key] = clean;
  }
  return out;
}

/** Ids are trimmed: Renfe pads its GTFS fields with spaces. */
const id = (value) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= MAX_ID_CHARS ? text : null;
};

/**
 * @typedef {{id: string, header: Readonly<Record<string, string>>,
 *   description: Readonly<Record<string, string>>,
 *   cause: string|null, effect: string|null,
 *   periods: Array<{start: number|null, end: number|null}>,
 *   routes: string[], stops: string[], trips: string[]}} TransitAlert
 *   `periods` in epoch ms; an empty list means "always".
 */

/**
 * Decode an Alerts feed. An alert with no header reads its description as
 * one; alerts with neither, deleted entities and over-long records are left
 * out.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {TransitAlert[]}
 */
export function decodeAlerts(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const message = new PbfReader(view).readFields(readMessage, {
    entities: [],
  });
  const alerts = [];
  for (const entity of message.entities) {
    const alert = entity.alert;
    if (!alert || entity.isDeleted || entity.oversize || alert.oversize)
      continue;
    // Renfe sends only a description: it is the header then, and kept in
    // full as the description when the header had to be cut.
    let header = translations(alert.header, ALERTS_MAX_HEADER_CHARS);
    let description = translations(
      alert.description,
      ALERTS_MAX_DESCRIPTION_CHARS,
    );
    if (!Object.keys(header).length) {
      header = translations(alert.description, ALERTS_MAX_HEADER_CHARS);
      if (Object.keys(header).every((key) => header[key] === description[key]))
        description = {};
    }
    if (!Object.keys(header).length) continue;
    const routes = new Set();
    const stops = new Set();
    const trips = new Set();
    for (const selector of alert.selectors) {
      if (selector.oversize) continue;
      const route = id(selector.routeId) ?? id(selector.trip?.routeId);
      if (route) routes.add(route);
      const stop = id(selector.stopId);
      if (stop) stops.add(stop);
      const trip = id(selector.trip?.tripId);
      if (trip) trips.add(trip);
    }
    alerts.push({
      id: id(entity.id) ?? `alert-${alerts.length + 1}`,
      header: Object.freeze(header),
      description: Object.freeze(description),
      cause: CAUSES[alert.cause] ?? null,
      effect: EFFECTS[alert.effect] ?? null,
      periods: alert.periods.map(({ start, end }) => ({
        start: Number.isFinite(start) && start > 0 ? start * 1000 : null,
        end: Number.isFinite(end) && end > 0 ? end * 1000 : null,
      })),
      routes: [...routes],
      stops: [...stops],
      trips: [...trips],
    });
    if (alerts.length >= ALERTS_MAX) break;
  }
  return alerts;
}

/**
 * Whether an alert applies at `now`: no period means always.
 * @param {{periods: Array<{start: number|null, end: number|null}>}} alert
 * @param {number} now
 */
export function alertActive(alert, now) {
  if (!alert?.periods?.length) return true;
  return alert.periods.some(
    ({ start, end }) => (start ?? -Infinity) <= now && now < (end ?? Infinity),
  );
}
