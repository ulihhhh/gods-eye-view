/**
 * Hand-made AMB fixtures shared by the AMB tests: GTFS text files in AMB's
 * column layout and a TripUpdates encoder. Not AMB data.
 */
import { PbfWriter } from 'pbf';

export const STOPS_CSV = [
  'stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,stop_url,wheelchair_boarding,out_of_service',
  '000108,108,"Plaça B",Marquesina,41.37376223,2.1471762,,0,0',
  '100005,100005,"Escola, nord",Pal,41.3627143,2.09633143,,1,0',
  '100006,100006,"Tancada",Pal,41.36,2.09,,1,1',
  '12,12,"Codi curt",Pal,41.36,2.09,,1,0',
  '100007,100007,"Sense punt",Pal,,,,1,0',
].join('\r\n');

export const ROUTES_CSV = [
  'route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_url,route_color,route_text_color',
  '129,73,"87","Horta-Gràcia",,3,,ffaa00,343434',
  '130,72,"A1","Aerobús",,3,,9fd6f6,333333',
].join('\n');

// Route 129 direction 0 runs mostly on `sh` (two trips) and once on `sh2`.
export const SHAPES_CSV = [
  'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
  'sh,41.4002,2.1602,2',
  'sh,41.4,2.16,0',
  'sh,41.4001,2.1601,1',
  'sh2,41.5,2.2,0',
  'sh2,41.5001,2.2001,1',
  'gone,41.6,2.3,0',
  'gone,41.6001,2.3001,1',
].join('\n');

export const TRIPS_CSV = [
  'route_id,service_id,trip_id,direction_id,shape_id,wheelchair_accessible,trip_short_name,trip_headsign',
  '129,s,129.1,0,sh,1,,Gràcia',
  '129,s,129.2,0,sh,1,,Gràcia',
  '129,s,129.3,0,sh2,1,,Gràcia',
  '130,s,130.1,1,sh,1,,"Aeroport T1"',
].join('\n');

/**
 * Encode a TripUpdates FeedMessage.
 * @param {number} timestamp seconds
 * @param {Array<{tripId: string, routeId?: string, vehicle?: string,
 *   canceled?: boolean, stops: Array<{stopId: string, time: number,
 *   skipped?: boolean}>}>} trips
 */
export function encodeTripUpdates(timestamp, trips) {
  const pbf = new PbfWriter();
  pbf.writeMessage(
    1,
    (header, out) => {
      out.writeStringField(1, '2.0');
      out.writeVarintField(2, 0);
      out.writeVarintField(3, header);
    },
    timestamp,
  );
  trips.forEach((trip, index) => {
    pbf.writeMessage(
      2,
      (t, out) => {
        out.writeStringField(1, `e${index}`);
        out.writeMessage(
          3,
          (u, w) => {
            w.writeMessage(
              1,
              (d, x) => {
                x.writeStringField(1, d.tripId);
                if (d.canceled) x.writeVarintField(4, 3);
                if (d.routeId) x.writeStringField(5, d.routeId);
              },
              u,
            );
            for (const stop of u.stops) {
              w.writeMessage(
                2,
                (s, x) => {
                  x.writeMessage(
                    2,
                    (time, y) => y.writeVarintField(2, time),
                    s.time,
                  );
                  x.writeStringField(4, s.stopId);
                  if (s.skipped) x.writeVarintField(5, 1);
                },
                stop,
              );
            }
            if (u.vehicle)
              w.writeMessage(
                3,
                (v, x) => {
                  x.writeStringField(1, v);
                  x.writeStringField(2, `#${v}`);
                },
                u.vehicle,
              );
          },
          t,
        );
      },
      trip,
    );
  });
  return pbf.finish();
}
