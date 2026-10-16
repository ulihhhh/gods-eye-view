/**
 * Card lines for the optional service fields of a transit record
 * (`serviceName`, `destination`, `origin`, `delaySec`, `onTime`,
 * `nextStops`, `alerts`, `carLoads`, `vehicleType`; see
 * src/data/transitServiceFields.js). A record without
 * them gets nothing, so feeds that never set them keep their card as it was.
 */

import { englishText } from '../../data/englishText.js';
import { transitAlertText } from '../../data/transitAlertText.js';

/** Next stops named on the card; the rest are counted. */
export const TRANSIT_CARD_NEXT_STOPS = 4;
/** Alerts written out on the card; the rest are counted. */
export const TRANSIT_CARD_ALERTS = 2;

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

function punctuality(record, t) {
  if (Number.isFinite(record.delaySec)) {
    const minutes = Math.round(record.delaySec / 60);
    if (Math.abs(record.delaySec) < ON_TIME_S || minutes === 0)
      return t('On time');
    return minutes > 0
      ? t('+{minutes} min late', { minutes })
      : t('{minutes} min early', { minutes: -minutes });
  }
  if (record.onTime === true) return t('On time');
  if (record.onTime === false) return t('Running late');
  return null;
}

/**
 * @param {object} feed Registry entry (`timeZone` for clock times).
 * @param {object} record Vehicle record.
 * @param {Function} [t] The UI's t() (passed down by policy.js, which AI
 *   tools also import); English without it.
 * @returns {{routeLabel: string|null, destination: string|null,
 *   lines: string[], vehicleType: string|null}}
 */
export function transitServiceCopy(feed, record, t = englishText) {
  const lines = [];
  const service = [punctuality(record, t)];
  if (record.origin)
    service.push(t('from {origin}', { origin: record.origin }));
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
    lines.push(
      t('Next: {stops}', {
        stops: `${shown.join(' · ')}${more > 0 ? ` · +${more}` : ''}`,
      }),
    );
  }
  // Service alerts on the train's trip or line, as the operator words them.
  const alerts = Array.isArray(record.alerts) ? record.alerts : [];
  const shown = alerts
    .map((alert) => transitAlertText(alert?.header))
    .filter(Boolean)
    .slice(0, TRANSIT_CARD_ALERTS);
  for (const text of shown) lines.push(`⚠ ${text}`);
  const moreAlerts =
    alerts.length -
    shown.length +
    (Number.isFinite(record.alertsMore) ? record.alertsMore : 0);
  if (shown.length && moreAlerts > 0)
    // Only t() reaches this card (policy.js), so no tn(): one key per form.
    // The extractor reads a context only when it comes first.
    lines.push(
      moreAlerts === 1
        ? t('+{count} more alert', { context: 'train card', count: 1 })
        : t('+{count} more alerts', {
            context: 'train card',
            count: moreAlerts,
          }),
    );
  if (Array.isArray(record.carLoads) && record.carLoads.length)
    lines.push(
      t('Load by car: {loads}', {
        loads: record.carLoads.map((pct) => `${pct}%`).join(' · '),
      }),
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
