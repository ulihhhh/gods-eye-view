/**
 * Test fixtures in Renfe's shapes, hand-made (not Renfe data): a zip
 * builder for static GTFS, and Cercanías VehiclePositions (no route id,
 * the line in the label).
 */
import { deflateRawSync } from 'node:zlib';
import { PbfWriter } from 'pbf';

/** A zip with the given entries, deflated unless `stored` (CRCs left 0). */
export function zipArchive(entries, { stored = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text, 'utf8');
    const data = stored ? raw : deflateRawSync(raw);
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

function embed(writer, tag, build) {
  const inner = new PbfWriter();
  build(inner);
  writer.writeBytesField(tag, inner.finish());
}

/** GTFS-RT VehicleStopStatus. */
export const STOP_STATUS = Object.freeze({
  INCOMING_AT: 0,
  STOPPED_AT: 1,
  IN_TRANSIT_TO: 2,
});

/**
 * Cercanías positions: one entity per train.
 * @param {Array<{tripId: string, label: string, lat?: number, lon?: number,
 *   stopId?: string, status?: number}>} trains
 * @param {number} timestamp epoch seconds
 * @returns {Uint8Array}
 */
export function renfePositions(trains, timestamp) {
  const writer = new PbfWriter();
  embed(writer, 1, (h) => {
    h.writeStringField(1, '2.0');
    h.writeVarintField(3, timestamp);
  });
  trains.forEach((train, index) => {
    embed(writer, 2, (entity) => {
      entity.writeStringField(1, `e${index + 1}`);
      embed(entity, 4, (vehicle) => {
        embed(vehicle, 1, (trip) => trip.writeStringField(1, train.tripId));
        embed(vehicle, 2, (p) => {
          p.writeFloatField(1, train.lat ?? 40.42);
          p.writeFloatField(2, train.lon ?? -3.72);
        });
        if (Number.isInteger(train.status))
          vehicle.writeVarintField(4, train.status);
        vehicle.writeVarintField(5, timestamp);
        if (train.stopId) vehicle.writeStringField(7, train.stopId);
        embed(vehicle, 8, (d) => {
          d.writeStringField(1, train.label.split('-')[1] ?? train.label);
          d.writeStringField(2, train.label);
        });
      });
    });
  });
  return writer.finish();
}
