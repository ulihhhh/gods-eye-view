import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCercaniasTimetable,
  gtfsServiceDayStart,
  timetableDay,
} from './renfeTimetable.js';
import { readZipTextEntries, zipEntryLines } from './zipEntries.js';
import { buildTimetableArrivals } from './transitArrivals.js';
import {
  renfePositions,
  STOP_STATUS,
  zipArchive,
} from '../testSupport/renfeGtfsFixtures.mjs';
import { encodeTripUpdates } from './tripUpdatesFixtures.mjs';
import { createTransitService } from '../sources/transitService.js';

const NOW = Date.parse('2026-10-16T10:00:00Z'); // Friday, 12:00 in Madrid
const madrid = (iso) => Date.parse(`${iso}+02:00`); // CEST until 25 Oct
const pad = (text, width) => text.padEnd(width, ' ');

// Hand-made GTFS in Renfe Cercanías' shapes (space-padded fields, one
// service id per network and date). Not Renfe data.
const GTFS = {
  'calendar.txt': [
    pad(
      'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
      120,
    ),
    'FRI  ,0,0,0,0,1,0,0,20261001,20261031',
    'THU  ,0,0,0,1,0,0,0,20261015,20261015',
    'SAT  ,0,0,0,0,0,1,0,20261017,20261017',
    'MON  ,1,0,0,0,0,0,0,20261001,20261031',
  ].join('\r\n'),
  'routes.txt': [
    'route_id,route_short_name,route_long_name,route_type,route_color,route_text_color',
    `10T0001C1  ,C1  ,${pad('Principe Pio', 40)}-${pad('Aeropuerto-T4', 40)},2,75B6E0,FFFFFF`,
    `10T0050C3  ,C3  ,${pad('Aranjuez', 40)}-${pad('Chamartín - Clara Campoamor', 40)},2,952585,FFFFFF`,
  ].join('\n'),
  'trips.txt': [
    'route_id,service_id,trip_id,trip_headsign,wheelchair_accessible,block_id,shape_id',
    '10T0001C1,FRI  ,FRI100C1    ,       ,1,FRI100,10_C1',
    '10T0050C3,FRI  ,FRI200C3    ,       ,1,FRI200,10_C3',
    '10T0001C1,THU  ,THU300C1    ,       ,1,THU300,10_C1',
    '10T0001C1,SAT  ,SAT400C1    ,       ,1,SAT400,10_C1',
    '10T0001C1,MON  ,MON500C1    ,       ,1,MON500,10_C1',
  ].join('\n'),
  'stop_times.txt': [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'FRI100C1    ,12:04:00,12:05:00,18000,001',
    'FRI100C1    ,12:15:00,12:15:00,17000,002',
    'FRI100C1    ,12:30:00,12:30:00,10000,003',
    'FRI200C3    ,11:40:00,11:40:00,18000,005',
    'FRI200C3    ,12:20:00,12:20:00,17000,006',
    'THU300C1    ,24:10:00,24:10:00,18000,010',
    'SAT400C1    ,08:00:00,08:00:00,18000,001',
    'MON500C1    ,12:06:00,12:06:00,18000,001',
  ].join('\r\n'),
};

async function timetable(now = NOW) {
  const bytes = zipArchive(GTFS);
  const files = await readZipTextEntries(
    bytes,
    ['calendar.txt', 'routes.txt', 'trips.txt'],
    1024 * 1024,
  );
  return buildCercaniasTimetable({
    files,
    lines: (name) => zipEntryLines(bytes, name, 1024 * 1024),
    now,
  });
}

test('GTFS days count from local noon minus twelve hours', () => {
  assert.equal(
    gtfsServiceDayStart('20261016', 'Europe/Madrid'),
    Date.parse('2026-10-15T22:00:00Z'),
    'midnight on an ordinary day',
  );
  // The clocks go back at 03:00 on 25 October: noon is 11:00 UTC that day.
  assert.equal(
    gtfsServiceDayStart('20261025', 'Europe/Madrid'),
    Date.parse('2026-10-24T23:00:00Z'),
  );
  assert.equal(timetableDay(NOW), '20261016');
  assert.equal(timetableDay(Date.parse('2026-10-16T22:30:00Z')), '20261017');
});

test('zip entries stream as lines, deflated or stored, CRLF or not', async () => {
  for (const stored of [false, true]) {
    const bytes = zipArchive(
      { 'a.txt': 'one\r\ntwo\nthree', 'b.txt': 'x' },
      { stored },
    );
    const lines = [];
    for await (const line of zipEntryLines(bytes, 'a.txt', 1024))
      lines.push(line);
    assert.deepEqual(lines, ['one', 'two', 'three']);
    const missing = [];
    for await (const line of zipEntryLines(bytes, 'none.txt', 1024))
      missing.push(line);
    assert.deepEqual(missing, []);
  }
  await assert.rejects(async () => {
    for await (const line of zipEntryLines(
      zipArchive({ 'a.txt': 'x'.repeat(100) }),
      'a.txt',
      10,
    ))
      assert.ok(line);
  }, /too large/);
});

test('the timetable keeps yesterday, today and tomorrow, sorted per station', async () => {
  const { stations, trips, days, builtFor } = await timetable();
  assert.deepEqual(days, ['20261015', '20261016', '20261017']);
  assert.equal(builtFor, '20261016');
  assert.deepEqual(
    stations.get('18000').map(({ tripId, at, last }) => [tripId, at, last]),
    [
      // Thursday's train after midnight is a Friday call.
      ['THU300C1', madrid('2026-10-16T00:10:00'), true],
      ['FRI200C3', madrid('2026-10-16T11:40:00'), false],
      // The departure time, not the arrival.
      ['FRI100C1', madrid('2026-10-16T12:05:00'), false],
      ['SAT400C1', madrid('2026-10-17T08:00:00'), true],
    ],
    'Monday’s service is left out',
  );
  assert.equal(stations.get('10000')[0].last, true);
  assert.deepEqual(trips.get('FRI100C1'), {
    line: 'C1',
    destination: 'Aeropuerto-T4',
    originStopId: '18000',
  });
  assert.equal(
    trips.get('FRI200C3').destination,
    'Chamartín - Clara Campoamor',
  );
  assert.equal(trips.has('MON500C1'), false);
});

const NAMES = Object.freeze({
  18000: 'Madrid-Atocha Cercanías',
  17000: 'Madrid-Chamartín-Clara Campoamor',
  10000: 'Aeropuerto T4',
});

test('a station board moves the timetable by each train’s live delay', async () => {
  const board = buildTimetableArrivals({
    stationId: '18000',
    timetable: await timetable(),
    tripUpdates: new Map([
      // C3 is 25 minutes late: its 11:40 call is still ahead.
      ['FRI200C3', { delaySec: 1500, stops: [] }],
      ['FRI100C1', { delaySec: 180, stops: [{ stopId: '17000', time: 0 }] }],
    ]),
    vehicles: [
      {
        tripId: 'FRI100C1',
        routeId: 'C1',
        platform: '2',
        stopId: '18000',
        stopRelation: 'left',
      },
    ],
    stopNames: NAMES,
    now: NOW,
  });
  assert.deepEqual(
    board.map((row) => [row.tripId, row.at, row.delaySec, row.realtime]),
    [
      ['FRI200C3', madrid('2026-10-16T12:05:00'), 1500, true],
      ['FRI100C1', madrid('2026-10-16T12:08:00'), 180, true],
    ],
  );
  const [c3, c1] = board;
  assert.equal(c1.line, 'C1');
  assert.equal(c1.destination, 'Aeropuerto-T4');
  assert.equal(c1.platform, null, 'its platform is for Chamartín');
  assert.equal(c1.running, true);
  assert.equal(c3.running, false);
  assert.equal(c3.scheduledAt, madrid('2026-10-16T11:40:00'));
});

test('a timed stop gives its own time and platform; no live data reads as scheduled', async () => {
  const tt = await timetable();
  const ownTime = madrid('2026-10-16T12:17:00');
  const [atChamartin] = buildTimetableArrivals({
    stationId: '17000',
    timetable: tt,
    tripUpdates: new Map([
      [
        'FRI100C1',
        { delaySec: 0, stops: [{ stopId: '17000', time: ownTime }] },
      ],
    ]),
    vehicles: [{ tripId: 'FRI100C1', routeId: 'C1', platform: '4' }],
    now: NOW,
  });
  assert.equal(atChamartin.at, ownTime);
  assert.equal(atChamartin.platform, '4');

  const [unknown] = buildTimetableArrivals({
    stationId: '17000',
    timetable: tt,
    now: NOW,
  });
  assert.equal(unknown.realtime, false);
  assert.equal(unknown.at, unknown.scheduledAt);

  const [arrival] = buildTimetableArrivals({
    stationId: '10000',
    timetable: tt,
    stopNames: NAMES,
    now: NOW,
  });
  assert.equal(arrival.terminates, true);
  assert.equal(arrival.origin, 'Madrid-Atocha Cercanías');

  assert.deepEqual(
    buildTimetableArrivals({ stationId: '99999', timetable: tt, now: NOW }),
    [],
  );
  assert.deepEqual(
    buildTimetableArrivals({ stationId: '18000', timetable: null, now: NOW }),
    [],
  );
});

test('the service builds Cercanías boards from the daily timetable and live delays', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const calls = [];
  const service = createTransitService({
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('.zip'))
        return new Response(zipArchive(GTFS), { status: 200 });
      if (String(url).includes('trip_updates'))
        return new Response(
          encodeTripUpdates(
            [{ tripId: 'FRI100C1', delay: 120, stops: [] }],
            NOW,
          ),
          { status: 200 },
        );
      return new Response(
        renfePositions(
          [
            {
              tripId: 'FRI100C1',
              label: 'C1-100-PLATF.(3)',
              stopId: '18000',
              status: STOP_STATUS.STOPPED_AT,
            },
          ],
          Math.round(NOW / 1000),
        ),
        { status: 200 },
      );
    },
  });
  const get = (station) =>
    service.handle({
      url: `http://localhost/api/transit/arrivals/renfe-cercanias/${station}`,
      method: 'GET',
    });
  try {
    const first = await get('18000');
    assert.equal(first.status, 503, 'the timetable loads in the background');
    assert.equal(first.headers.get('Retry-After'), '15');
    // The download, unzip and build finish in real time (only Date is mocked).
    await new Promise((resolve) => setTimeout(resolve, 300));
    const response = await get('18000');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.timetable, '20261016');
    assert.equal(body.tripUpdates, true);
    const c1 = body.arrivals.find((row) => row.tripId === 'FRI100C1');
    assert.equal(c1.delaySec, 120);
    assert.equal(c1.at, madrid('2026-10-16T12:07:00'));
    assert.equal(c1.platform, '3', 'standing at Atocha');
    assert.equal(c1.line, 'C1');
    assert.equal(
      calls.filter((url) => url.endsWith('.zip')).length,
      1,
      'one timetable download',
    );
  } finally {
    service.close();
  }
});
