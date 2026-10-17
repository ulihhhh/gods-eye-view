// Estimated feeds (fork-only): placed ahead by their server
// (`estimateLeadMs`) and played exactly that far behind, so a train is drawn
// where the estimate puts it now and its card does not say it is shown half a
// minute late; and the Transit row's ESTIMATED pill hides them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../../i18n/index.js';
import { createLagReservoir } from '../../data/contactPlayback.js';
import { getRegisteredTransitFeed } from '../../data/transitFeeds.js';
import { buildTransitSelectionCopy, transitFeedTiming } from './policy.js';
import { initializePlayback, recordFix } from './movement.js';
import { createControls } from './controls.js';
import {
  decodeLayerStateParams,
  encodeLayerStateParams,
  normalizeLayerState,
} from '../../data/layerState.js';

const T0 = Date.UTC(2026, 9, 17, 10, 12, 0);

test('an estimated row pins its playback delay to its lead', () => {
  const feed = getRegisteredTransitFeed('tmb-metro-estimated');
  assert.equal(feed.estimateLeadMs, 35_000);
  assert.equal(transitFeedTiming(feed).fixedDelayMs, 35_000);
  // A lead without an estimator is not a pin: reported feeds learn theirs.
  assert.equal(
    transitFeedTiming({ id: 'x', estimateLeadMs: 35_000 }).fixedDelayMs,
    undefined,
  );
});

test('a pinned delay is not relearned from report lags', () => {
  const entry = { mode: 'subway', modeInferred: false };
  initializePlayback(entry, null, createLagReservoir(), {
    ...transitFeedTiming(getRegisteredTransitFeed('tmb-metro-estimated')),
  });
  assert.equal(entry.track.targetDelayMs, 35_000);
  // Fixes received long after they were made would push a learned delay up.
  for (let i = 0; i < 6; i++) {
    const t = T0 + i * 15_000;
    const accepted = recordFix(
      entry,
      { t, lat: 41.4 - i * 0.001, lon: 2.17, bearingDeg: 180, flags: 0 },
      { receivedAt: t + 30_000, wallNowMs: t + 30_000, monoNowMs: i * 15_000 },
    );
    assert.equal(accepted.accepted, true);
    assert.equal(entry.track.targetDelayMs, 35_000);
  }

  const learned = { mode: 'subway', modeInferred: false };
  initializePlayback(learned, null, createLagReservoir(), {});
  for (let i = 0; i < 6; i++) {
    const t = T0 + i * 15_000;
    recordFix(
      learned,
      { t, lat: 41.4 - i * 0.001, lon: 2.17, bearingDeg: 180, flags: 0 },
      { receivedAt: t + 30_000, wallNowMs: t + 30_000, monoNowMs: i * 15_000 },
    );
  }
  assert.ok(learned.track.targetDelayMs > 35_000, 'reported feeds learn');
});

test('the card says only how far behind the estimate the display runs', () => {
  setLocale('en');
  const feed = getRegisteredTransitFeed('tmb-metro-estimated');
  const record = {
    id: 'L3-307',
    routeId: 'L3',
    lat: 41.4,
    lon: 2.17,
    timestamp: Math.floor(T0 / 1000) - 5,
    timestampSource: 'vehicle',
    estimated: true,
    estimatedFrom: 'predictions',
  };
  const entry = {
    sample: { actualDelayMs: 36_400, latestReportAgeMs: 5_000 },
    track: { policy: { fixedDelayMs: 35_000 }, count: 0 },
  };
  const copy = buildTransitSelectionCopy(
    feed,
    record,
    'subway',
    T0,
    null,
    entry,
  );
  assert.ok(copy.details.includes('Estimated 5 s ago · shown 1 s behind'));
  // A reported vehicle's lag is said in full.
  const reported = buildTransitSelectionCopy(
    { name: 'Feed', region: 'Region' },
    { ...record, estimated: false },
    'subway',
    T0,
    null,
    { ...entry, track: { policy: {}, count: 0 } },
  );
  assert.ok(reported.details.includes('Reported 5 s ago · shown 36 s behind'));
});

function controlsWith({ enabled = true, inRange = true } = {}) {
  const calls = { proximity: 0, stats: 0 };
  const state = {
    _enabled: enabled,
    _showEstimated: true,
    _estimatedInRange: inRange,
    _dataManager: { refreshLayerStats: () => (calls.stats += 1) },
  };
  const parts = {
    viewport: { runProximityCheck: () => (calls.proximity += 1) },
  };
  const { methods } = createControls({ state, parts });
  return { methods, state, calls };
}

test('the ESTIMATED pill shows only while an estimated feed covers the view', () => {
  setLocale('en');
  assert.deepEqual(
    controlsWith({ inRange: false }).methods.getRowControls().chips,
    [],
  );
  const { methods } = controlsWith();
  const [chip] = methods.getRowControls().chips;
  assert.equal(chip.id, 'estimated');
  assert.equal(chip.label, 'ESTIMATED');
  assert.equal(chip.active, true);
  assert.deepEqual(chip.params, { estimated: false });
});

test('switching estimates off re-runs the proximity check at once', () => {
  const { methods, state, calls } = controlsWith();
  assert.deepEqual(methods.getParams(), { estimated: true });
  assert.equal(methods.setParams({ estimated: false }), true);
  assert.equal(state._showEstimated, false);
  assert.equal(calls.proximity, 1);
  assert.equal(methods.getRowControls().chips[0].active, false);
  // The same value again, or an unrelated key, changes nothing.
  methods.setParams({ estimated: false });
  methods.setParams({});
  assert.equal(calls.proximity, 1);
  // A disabled layer keeps the choice for when it is switched on.
  const idle = controlsWith({ enabled: false });
  idle.methods.setParams({ estimated: false });
  assert.equal(idle.calls.proximity, 0);
  assert.equal(idle.state._showEstimated, false);
});

test('the choice travels in the share link as a Transit option', () => {
  const off = normalizeLayerState({
    enabledLayerIds: ['transit'],
    options: { transit: { estimated: false } },
  });
  const params = new URLSearchParams([['v', '2']]);
  encodeLayerStateParams(params, off);
  assert.equal(params.get('l'), 'j');
  assert.ok(params.get('lo').split('_').includes('j.e.0'));
  assert.deepEqual(decodeLayerStateParams(params).options.transit, {
    estimated: false,
  });
  // On is the default and is not written.
  const on = new URLSearchParams([['v', '2']]);
  encodeLayerStateParams(
    on,
    normalizeLayerState({ enabledLayerIds: ['transit'] }),
  );
  assert.ok(!(on.get('lo') || '').split('_').some((o) => o.startsWith('j.')));
});
