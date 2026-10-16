/**
 * Hand-made GTFS-Realtime TripUpdates for tests: trips with an optional
 * trip delay, and stops with a time (epoch ms) and an optional (signed)
 * delay. Not operator data.
 */
import { PbfWriter } from 'pbf';

/**
 * @param {Array<{tripId: string, delay?: number,
 *   stops: Array<{stopId: string, time?: number, delay?: number}>}>} trips
 * @param {number} timestamp Header time, epoch ms.
 * @returns {Uint8Array}
 */
export function encodeTripUpdates(trips, timestamp) {
  const pbf = new PbfWriter();
  pbf.writeMessage(
    1,
    (_, out) => {
      out.writeStringField(1, '2.0');
      out.writeVarintField(3, Math.round(timestamp / 1000));
    },
    null,
  );
  for (const trip of trips)
    pbf.writeMessage(
      2,
      (t, out) => {
        out.writeStringField(1, t.tripId);
        out.writeMessage(
          3,
          (u, w) => {
            w.writeMessage(1, (d, x) => x.writeStringField(1, d.tripId), u);
            for (const stop of u.stops)
              w.writeMessage(
                2,
                (s, x) => {
                  x.writeMessage(
                    2,
                    (e, y) => {
                      if (Number.isFinite(e.delay))
                        y.writeVarintField(1, e.delay);
                      if (Number.isFinite(e.time))
                        y.writeVarintField(2, Math.round(e.time / 1000));
                    },
                    s,
                  );
                  x.writeStringField(4, s.stopId);
                },
                stop,
              );
            if (Number.isFinite(u.delay)) w.writeVarintField(5, u.delay);
          },
          t,
        );
      },
      trip,
    );
  return pbf.finish();
}
