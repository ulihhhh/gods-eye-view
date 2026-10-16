/**
 * Hand-made GTFS-Realtime Alerts for tests, in the operators' shapes
 * (Renfe: description only; FGC: one alert per trip and stop, no language;
 * AMB: Catalan and Spanish). Not operator data.
 */
import { PbfWriter } from 'pbf';

function embed(writer, tag, build) {
  const inner = new PbfWriter();
  build(inner);
  writer.writeBytesField(tag, inner.finish());
}

function translated(writer, tag, texts) {
  embed(writer, tag, (out) => {
    for (const [language, text] of Object.entries(texts))
      embed(out, 1, (t) => {
        t.writeStringField(1, text);
        if (language) t.writeStringField(2, language);
      });
  });
}

/**
 * @param {Array<{id: string, deleted?: boolean,
 *   header?: Record<string, string>, description?: Record<string, string>,
 *   effect?: number, cause?: number,
 *   periods?: Array<{start?: number, end?: number}>,
 *   routes?: string[], stops?: string[],
 *   trips?: Array<{tripId: string, routeId?: string}>}>} alerts
 *   `periods` in epoch seconds.
 * @returns {Uint8Array}
 */
export function encodeAlerts(alerts) {
  const writer = new PbfWriter();
  embed(writer, 1, (h) => {
    h.writeStringField(1, '2.0');
    h.writeVarintField(3, 1_792_140_000);
  });
  for (const alert of alerts)
    embed(writer, 2, (entity) => {
      entity.writeStringField(1, alert.id);
      if (alert.deleted) entity.writeBooleanField(2, true);
      embed(entity, 5, (out) => {
        for (const period of alert.periods || [])
          embed(out, 1, (p) => {
            if (period.start) p.writeVarintField(1, period.start);
            if (period.end) p.writeVarintField(2, period.end);
          });
        for (const route of alert.routes || [])
          embed(out, 5, (e) => e.writeStringField(2, route));
        for (const stop of alert.stops || [])
          embed(out, 5, (e) => e.writeStringField(5, stop));
        for (const trip of alert.trips || [])
          embed(out, 5, (e) =>
            embed(e, 4, (t) => {
              t.writeStringField(1, trip.tripId);
              if (trip.routeId) t.writeStringField(5, trip.routeId);
            }),
          );
        if (alert.cause) out.writeVarintField(6, alert.cause);
        if (alert.effect) out.writeVarintField(7, alert.effect);
        if (alert.header) translated(out, 10, alert.header);
        if (alert.description) translated(out, 11, alert.description);
      });
    });
  return writer.finish();
}
