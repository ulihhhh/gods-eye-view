// An estimated vehicle (a position worked out from times, not reported) is
// said to be one on its card (estimatedPositions.js). It is drawn with the
// solid sprite in its line colour; the hollow sprite stays available.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, t } from '../../i18n/index.js';
import {
  TRANSIT_MODE_COLORS,
  buildTransitSelectionCopy,
  createTransitSelectedOverlayEntry,
  transitRouteColorCss,
} from './policy.js';
import { transitIcon } from '../../data/transitIcons.js';

const feed = {
  name: 'TMB Metro (estimated)',
  region: 'Barcelona metro (estimated positions)',
  timeZone: 'Europe/Madrid',
};
const now = Date.UTC(2026, 9, 17, 10, 12, 0);
const record = {
  id: 'L3-307',
  label: '307',
  routeId: 'L3',
  lat: 41.38,
  lon: 2.17,
  bearing: 180,
  speedMps: null,
  timestamp: Math.floor(now / 1000) - 5,
  timestampSource: 'vehicle',
  stopId: '326',
  stopName: 'Liceu',
  status: 'IN_TRANSIT_TO',
  occupancy: null,
  destination: 'Zona Universitària',
  nextStops: [{ stopId: '326', name: 'Liceu', at: now + 40_000 }],
  estimated: true,
  estimatedFrom: 'predictions',
};

test('the card says the position is estimated and from what', () => {
  setLocale('en');
  const copy = buildTransitSelectionCopy(feed, record, 'subway', now);
  assert.equal(copy.title, '🚇 Route L3 → Zona Universitària');
  assert.deepEqual(copy.details, [
    'Subway · TMB Metro (estimated) · Barcelona metro (estimated positions)',
    'Estimated position · from arrival predictions',
    'Estimated 5 s ago',
    'Next: Liceu 12:12',
    'Estimated next stop Liceu',
    'Shown at street level · depth not in the feed',
    'Vehicle L3-307 · 307',
  ]);
  const standing = buildTransitSelectionCopy(
    feed,
    { ...record, status: 'STOPPED_AT', estimatedFrom: 'schedule' },
    'subway',
    now,
  );
  assert.ok(
    standing.details.includes('Estimated position · from timetable and delays'),
  );
  assert.ok(standing.details.includes('Estimated at Liceu'));
});

test('a reported vehicle keeps its card unchanged', () => {
  setLocale('en');
  const { estimated: _e, estimatedFrom: _f, ...reported } = record;
  const copy = buildTransitSelectionCopy(feed, reported, 'subway', now);
  assert.ok(copy.details.includes('Reported 5 s ago'));
  assert.ok(copy.details.includes('Last report: next stop Liceu'));
  assert.ok(!copy.details.some((line) => line.startsWith('Estimated')));
});

test('the estimate lines are translated', () => {
  setLocale('es');
  try {
    const copy = buildTransitSelectionCopy(
      feed,
      record,
      'subway',
      now,
      null,
      null,
      t,
    );
    assert.ok(
      copy.details.includes(
        'Posición estimada · a partir de las llegadas previstas',
      ),
    );
    assert.ok(copy.details.includes('Estimado hace 5 s'));
  } finally {
    setLocale('en');
  }
});

test('the hollow sprite is still available, with its own cached entry', () => {
  for (const style of ['normal', 'thermal', 'retro']) {
    const solid = transitIcon('subway', undefined, { style });
    const hollow = transitIcon('subway', undefined, { style, estimated: true });
    assert.notEqual(solid, hollow, style);
    const svg = Buffer.from(hollow.split(',')[1], 'base64').toString();
    assert.match(svg, /stroke="white" stroke-width="5"/);
  }
});

test('a line colour paints the card accent; without one the mode colour stays', () => {
  assert.equal(transitRouteColorCss({ routeColor: '1eb53a' }), '#1EB53A');
  for (const bad of [undefined, null, 'red', '#1EB53A', 'GGGGGG', 123456])
    assert.equal(transitRouteColorCss({ routeColor: bad }), null, String(bad));
  const copy = { title: 'x', details: [] };
  const lined = createTransitSelectedOverlayEntry(
    'k',
    { x: 1 },
    copy,
    'subway',
    '#1EB53A',
  );
  assert.equal(lined.accent, '#1EB53A');
  const plain = createTransitSelectedOverlayEntry(
    'k',
    { x: 1 },
    copy,
    'subway',
  );
  assert.equal(plain.accent, TRANSIT_MODE_COLORS.subway);
});
