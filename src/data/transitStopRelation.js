/**
 * How a vehicle's reported stop relates to it: `at` (stopped there),
 * `arriving`, `next`, `left` (it departed from there) or `last` (the last stop
 * it served). The proxy sets `stopRelation` for a feed that reads its statuses
 * its own way (`interpretStatus`); every other feed follows GTFS-Realtime's
 * `current_status`.
 */
/** Every relation a record may carry. */
export const TRANSIT_STOP_RELATIONS = Object.freeze([
  'at',
  'arriving',
  'next',
  'left',
  'last',
]);

/** GTFS-Realtime's reading of `current_status`. */
export const TRANSIT_STANDARD_STOP_RELATION = Object.freeze({
  STOPPED_AT: 'at',
  INCOMING_AT: 'arriving',
  IN_TRANSIT_TO: 'next',
});

/**
 * @param {{stopRelation?: string, status?: string, stopId?: string}|null} record
 * @returns {string|null}
 */
export function transitStopRelation(record) {
  if (!record?.stopId) return null;
  if (typeof record.stopRelation === 'string') return record.stopRelation;
  return TRANSIT_STANDARD_STOP_RELATION[record.status] ?? null;
}
