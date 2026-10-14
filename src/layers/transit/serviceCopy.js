/**
 * Card lines for the optional service fields of a transit record
 * (`serviceName`, `destination`, `origin`, `delaySec`, `onTime`,
 * `nextStops`, `carLoads`, `vehicleType`; see src/data/transitServiceFields.js). A record without
 * them gets nothing, so feeds that never set them keep their card as it was.
 */

/** Next stops named on the card; the rest are counted. */
export const TRANSIT_CARD_NEXT_STOPS = 4;

/** Within this, a delay reads as on time (operators round to the minute). */
const ON_TIME_S = 60;

const formatters = new Map();

/** "19:04" in the feed's own time zone (or the viewer's, without one). */
export function transitClock(ms, timeZone = null) {
  const key = timeZone || '';
  if (!formatters.has(key)) {
    let format;
    try {
      format = new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        ...(timeZone ? { timeZone } : {}),
      });
    } catch {
      format = new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
      });
    }
    formatters.set(key, format);
  }
  return formatters.get(key).format(ms);
}

function punctuality(record) {
  if (Number.isFinite(record.delaySec)) {
    const minutes = Math.round(record.delaySec / 60);
    if (Math.abs(record.delaySec) < ON_TIME_S || minutes === 0)
      return 'On time';
    return minutes > 0 ? `+${minutes} min late` : `${-minutes} min early`;
  }
  if (record.onTime === true) return 'On time';
  if (record.onTime === false) return 'Running late';
  return null;
}

/**
 * @param {object} feed Registry entry (`timeZone` for clock times).
 * @param {object} record Vehicle record.
 * @returns {{routeLabel: string|null, destination: string|null,
 *   lines: string[], vehicleType: string|null}}
 */
export function transitServiceCopy(feed, record) {
  const lines = [];
  const service = [punctuality(record)];
  if (record.origin) service.push(`from ${record.origin}`);
  if (service.some(Boolean)) lines.push(service.filter(Boolean).join(' · '));
  const stops = Array.isArray(record.nextStops) ? record.nextStops : [];
  if (stops.length) {
    const shown = stops.slice(0, TRANSIT_CARD_NEXT_STOPS).map((stop) => {
      const name = stop.name || stop.stopId;
      return Number.isFinite(stop.at)
        ? `${name} ${transitClock(stop.at, feed?.timeZone)}`
        : name;
    });
    const more =
      stops.length -
      shown.length +
      (Number.isFinite(record.nextStopsMore) ? record.nextStopsMore : 0);
    lines.push(`Next: ${shown.join(' · ')}${more > 0 ? ` · +${more}` : ''}`);
  }
  if (Array.isArray(record.carLoads) && record.carLoads.length)
    lines.push(
      `Load by car: ${record.carLoads.map((pct) => `${pct}%`).join(' · ')}`,
    );
  return {
    // "ALVIA 04073": the service and the train number riders know.
    routeLabel: record.serviceName
      ? `${record.serviceName} ${record.label || record.id}`
      : null,
    destination: record.destination || null,
    lines,
    vehicleType: record.vehicleType || null,
  };
}
