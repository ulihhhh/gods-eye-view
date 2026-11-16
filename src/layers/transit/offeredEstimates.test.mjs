// Fork-only: an estimated row needs a key the server may not have, so the
// layer polls it only once the server's catalog says it is offered.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OFFERED_ESTIMATES_REFRESH_MS,
  OFFERED_ESTIMATES_RETRY_MS,
  createViewport,
} from './viewport.js';
import { bindRenderer } from '../../render/rendererOf.js';

/** A camera port 5 km over central Barcelona. */
function viewerOverBarcelona() {
  const host = {};
  bindRenderer(host, {
    camera: {
      pose: () => ({ lon: 2.16, lat: 41.39, height: 5_000 }),
      viewRectangle: () => ({
        west: 2.12,
        south: 41.36,
        east: 2.2,
        north: 41.42,
      }),
      on: () => () => {},
    },
  });
  return host;
}

function setup({ rows }) {
  const polled = [];
  const reads = [];
  const state = {
    _enabled: true,
    _viewer: viewerOverBarcelona(),
    _activeFeeds: new Map(),
    _vehicles: new Map(),
    _cockpitSubjectKey: null,
    _inFlight: new Map(),
    _feedStatus: new Map(),
    _showEstimated: true,
    _estimatedInRange: false,
    _offeredEstimates: null,
    _offeredEstimatesAt: -Infinity,
    _offeredEstimatesLoading: false,
    _generation: 1,
    _cameraRevision: 0,
    _altitudeGateOpen: false,
  };
  const parts = {
    ingestion: {
      pollFeed: (feed) => polled.push(feed.id),
      removeFeedVehicles: () => {},
      sweepAgedVehicles: () => {},
    },
    rendering: { syncRenderHold: () => {}, requestVisibility: () => {} },
  };
  const source = {
    getFeeds: async () => {
      reads.push(Date.now());
      const answer = rows();
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const viewport = createViewport({
    state,
    services: { render: { governorRequestRender: () => {} } },
    parts,
    source,
  });
  return { state, viewport, polled, reads };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('an estimated row is polled only once the server offers it', async () => {
  const { state, viewport, polled, reads } = setup({
    rows: () => [{ id: 'fgc-geotren' }, { id: 'tmb-metro-estimated' }],
  });
  viewport.runProximityCheck();
  assert.equal(polled.includes('tmb-metro-estimated'), false);
  assert.equal(polled.includes('fgc-geotren'), true, 'others do not wait');
  assert.equal(state._estimatedInRange, false, 'no pill before the answer');
  await settle();
  assert.equal(reads.length, 1);
  assert.equal(polled.includes('tmb-metro-estimated'), true);
  assert.equal(state._estimatedInRange, true);
});

test('a row the server does not offer is never polled and shows no pill', async () => {
  const { state, viewport, polled, reads } = setup({
    rows: () => [{ id: 'fgc-geotren' }],
  });
  viewport.runProximityCheck();
  await settle();
  viewport.runProximityCheck();
  assert.equal(polled.includes('tmb-metro-estimated'), false);
  assert.equal(state._estimatedInRange, false);
  assert.equal(reads.length, 1, 'the catalog is not re-read every check');
});

test('the catalog is re-read after its refresh window, and soon after a failure', async () => {
  let offered = false;
  let fail = true;
  const { state, viewport, polled, reads } = setup({
    rows: () =>
      fail
        ? new Error('offline')
        : offered
          ? [{ id: 'tmb-metro-estimated' }]
          : [],
  });
  viewport.runProximityCheck();
  await settle();
  assert.equal(reads.length, 1);
  assert.equal(state._offeredEstimates, null);
  fail = false;
  state._offeredEstimatesAt -= OFFERED_ESTIMATES_RETRY_MS;
  viewport.runProximityCheck();
  await settle();
  assert.equal(reads.length, 2);
  assert.equal(polled.includes('tmb-metro-estimated'), false);
  // A key added later shows up at the next refresh, without a reload.
  offered = true;
  viewport.runProximityCheck();
  await settle();
  assert.equal(reads.length, 2, 'inside the refresh window');
  state._offeredEstimatesAt -= OFFERED_ESTIMATES_REFRESH_MS;
  viewport.runProximityCheck();
  await settle();
  assert.equal(reads.length, 3);
  assert.equal(polled.includes('tmb-metro-estimated'), true);
});
