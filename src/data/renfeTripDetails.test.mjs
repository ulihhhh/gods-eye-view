import test from 'node:test';
import assert from 'node:assert/strict';
import { readZipTextEntries } from './zipEntries.js';
import {
  renfePositions,
  zipArchive as zip,
} from '../testSupport/renfeGtfsFixtures.mjs';
import {
  buildCercaniasTripDetails,
  buildRenfeLdTripDetails,
  cercaniasRouteDestination,
} from './renfeTripDetails.js';
import { applyServiceFields } from './transitServiceFields.js';
import { getTransitFeed } from './transitFeeds.js';
import { buildTransitSelectionCopy } from '../layers/transit/policy.js';
import { createTransitService } from '../sources/transitService.js';

// Hand-made GTFS in Renfe's shapes (fixed-width, space-padded Cercanías
// fields; dated LD trip ids). Not Renfe data.
const pad = (text, width) => text.padEnd(width, ' ');
const CERCANIAS = {
  'routes.txt': [
    'route_id,route_short_name,route_long_name,route_type,route_color,route_text_color',
    `10T0001C1  ,C1  ,${pad('Principe Pio', 40)}-${pad('Aeropuerto-T4', 40)},2,75B6E0,FFFFFF`,
    `10T0045C2  ,C2  ,${pad('Guadalajara', 40)}-${pad('Chamartín - Clara Campoamor', 40)},2,00943D,FFFFFF`,
    `10T0050C3  ,C3  ,${pad('Aranjuez', 40)}-${pad('', 40)},2,952585,FFFFFF`,
  ].join('\n'),
  'trips.txt': [
    'route_id,service_id,trip_id,trip_headsign,wheelchair_accessible,block_id,shape_id',
    '10T0001C1,1001J,1001J19799C1,       ,1,1001J19799,10_C1',
    '10T0045C2,1001J,1001J22001C2,       ,1,1001J22001,10_C2',
    '10T0050C3,1001J,1001J33001C3,       ,1,1001J33001,10_C3',
  ].join('\n'),
};
const LD = {
  'routes.txt': [
    'route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_url,route_color,route_text_color',
    '1700014223GL023,1071,ALVIA,,,2,,F2F5F5,',
    '6000071801VL001,1071,AVE,,,2,,F2F5F5,',
  ].join('\n'),
  'trips.txt': [
    'route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,block_id,shape_id,wheelchair_accessible',
    '1700014223GL023,2026-10-142026-10-14040731,0407312026-10-14,,04073,,,,1',
    '6000071801VL001,2026-10-142026-10-14031001,0310012026-10-14,,03100,,,,1',
  ].join('\n'),
};

test('zip entries read back, deflated or stored, only the ones asked for', async () => {
  for (const stored of [false, true]) {
    const files = await readZipTextEntries(
      zip({ ...CERCANIAS, 'stop_times.txt': 'x' }, { stored }),
      ['routes.txt', 'trips.txt'],
      1024 * 1024,
    );
    assert.deepEqual([...files.keys()], ['routes.txt', 'trips.txt']);
    assert.equal(files.get('trips.txt'), CERCANIAS['trips.txt']);
  }
  await assert.rejects(
    readZipTextEntries(zip(CERCANIAS), ['trips.txt'], 10),
    /too large/,
  );
  await assert.rejects(
    readZipTextEntries(new Uint8Array(40), ['trips.txt'], 10),
    /no end of central directory/,
  );
});

test('Cercanías destinations come from the fixed-width long name', () => {
  assert.equal(
    cercaniasRouteDestination(
      `${pad('Guadalajara', 40)}-${pad('Chamartín - Clara Campoamor', 40)}`,
    ),
    'Chamartín - Clara Campoamor',
  );
  assert.equal(
    cercaniasRouteDestination('Lebrija -Lora del Rio'),
    'Lora del Rio',
  );
  assert.equal(cercaniasRouteDestination(`${pad('Aranjuez', 40)}-`), null);
  const trips = buildCercaniasTripDetails(CERCANIAS);
  assert.deepEqual(trips.get('1001J19799C1'), { destination: 'Aeropuerto-T4' });
  assert.equal(trips.has('1001J33001C3'), false, 'no destination, no entry');
});

test('AV/LD trips give the service and the origin and destination codes', () => {
  const trips = buildRenfeLdTripDetails(new Map(Object.entries(LD)));
  assert.deepEqual(trips.get('0407312026-10-14'), {
    serviceName: 'ALVIA',
    originStopId: '17000',
    destinationStopId: '14223',
  });
  const [train] = applyServiceFields(
    [{ id: '04073', label: '04073', tripId: '0407312026-10-14' }],
    {
      tripDetails: trips,
      stopNames: { 17000: 'Madrid-Chamartín', 14223: 'Santander' },
    },
  );
  assert.equal(train.serviceName, 'ALVIA');
  assert.equal(train.destination, 'Santander');
  assert.equal(train.origin, 'Madrid-Chamartín');
  const { title, details } = buildTransitSelectionCopy(
    getTransitFeed('renfe-ld'),
    { ...train, delaySec: 480, timestamp: 1 },
    'rail',
    2000,
    2000,
  );
  assert.equal(title, '🚆 ALVIA 04073 → Santander');
  assert.ok(details.includes('+8 min late · from Madrid-Chamartín'), details);
  const [own] = applyServiceFields(
    [{ id: 'x', tripId: '0407312026-10-14', destination: 'Own' }],
    { tripDetails: trips },
  );
  assert.equal(own.destination, 'Own', 'the feed’s own value wins');
});

test('the proxy reads the schedule once a day beside positions, never waiting for it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_791_970_000_000 });
  const calls = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const service = createTransitService({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith('.zip')) {
        await gate;
        return new Response(zip(CERCANIAS), { status: 200 });
      }
      if (url.includes('trip_updates'))
        return new Response(new Uint8Array(0), { status: 200 });
      return new Response(
        renfePositions(
          [{ tripId: '1001J19799C1', label: 'C1-19799' }],
          1_791_970_000,
        ),
        { status: 200 },
      );
    },
  });
  const get = async () =>
    (
      await service.handle({
        url: 'http://localhost/api/transit/vehicles/renfe-cercanias',
        method: 'GET',
      })
    ).json();
  try {
    const first = await get();
    assert.equal(first.vehicles[0].destination, undefined, 'not waited for');
    release();
    // The download, unzip and parse finish in the background (real time;
    // only Date is mocked).
    await new Promise((resolve) => setTimeout(resolve, 200));
    t.mock.timers.tick(16_000);
    const second = await get();
    assert.equal(second.vehicles[0].destination, 'Aeropuerto-T4');
    t.mock.timers.tick(16_000);
    await get();
    assert.equal(
      calls.filter((url) => url.endsWith('.zip')).length,
      1,
      'one schedule download',
    );
  } finally {
    service.close();
  }
});
