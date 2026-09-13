import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AEMET_WEATHER_IMAGERY_OVERLAY_SOURCE_ID,
  AEMET_WEATHER_IMAGERY_OVERLAY_SOURCE_OPTIONS,
  createAemetWeatherImageryLayer,
  createAemetWeatherImageryOverlayEntry,
  normalizeAemetWeatherImageryStatus,
} from './aemetWeatherImagery.js';

const FAKE_POSITION = { x: 1, y: 2, z: 3 };
const FAKE_IMAGE_SLOT = Object.freeze({ frame: { fakeImage: true }, stamp: 123 });

function fakeOverlayHost() {
  const calls = [];
  return {
    calls,
    setEntries: (...args) => calls.push(['entries', ...args]),
    setVisible: (...args) => calls.push(['visible', ...args]),
    clearSource: (...args) => calls.push(['clear', ...args]),
  };
}

/** A `fetch` stub whose response depends on which of the 3 status URLs is hit. */
function fetchByMap({ lightning, fireRisk, sst }) {
  return async (url) => {
    if (url.includes('/lightning')) return lightning(url);
    if (url.includes('/fire-risk')) return fireRisk(url);
    if (url.includes('/sea-surface-temp')) return sst(url);
    throw new Error(`unexpected fetch: ${url}`);
  };
}

function okStatus(body) {
  return { ok: true, status: 200, json: async () => body };
}

test('createAemetWeatherImageryOverlayEntry builds a clickable thumbnail entry, sized and accented per map', () => {
  const lightning = createAemetWeatherImageryOverlayEntry('lightning', FAKE_IMAGE_SLOT, { fetchedAtMs: null }, FAKE_POSITION);
  const fireRisk = createAemetWeatherImageryOverlayEntry('fireRisk', FAKE_IMAGE_SLOT, { fetchedAtMs: null }, FAKE_POSITION);
  const sst = createAemetWeatherImageryOverlayEntry('sst', FAKE_IMAGE_SLOT, { fetchedAtMs: null }, FAKE_POSITION);

  for (const entry of [lightning, fireRisk, sst]) {
    assert.equal(entry.id, AEMET_WEATHER_IMAGERY_OVERLAY_SOURCE_ID, 'all three publish under the SAME single source id');
    assert.equal(entry.variant, 'thumbnail');
    assert.equal(entry.position, FAKE_POSITION);
    assert.equal(entry.image, FAKE_IMAGE_SLOT);
    assert.equal(entry.requireImage, true);
    assert.equal(entry.interactive, true);
    assert.equal(entry.selected, false);
  }
  assert.equal(lightning.title, 'AEMET LIGHTNING');
  assert.equal(fireRisk.title, 'AEMET FIRE RISK');
  assert.equal(sst.title, 'AEMET SEA SURFACE TEMP');
  // Each map keeps its own previously-tuned sizing and accent — not a
  // one-size-fits-all merge that would reintroduce the placement failures
  // each original phase's own live debugging found and fixed.
  assert.notEqual(lightning.accent, fireRisk.accent);
  assert.notEqual(fireRisk.accent, sst.accent);
  assert.deepEqual([lightning.thumbnailWidth, lightning.thumbnailHeight], [168, 126]);
  assert.deepEqual([fireRisk.thumbnailWidth, fireRisk.thumbnailHeight], [168, 112]);
  assert.deepEqual([sst.thumbnailWidth, sst.thumbnailHeight], [168, 130]);
});

test('createAemetWeatherImageryOverlayEntry renders a much bigger, protected card when expanded, per map', () => {
  const collapsed = createAemetWeatherImageryOverlayEntry('fireRisk', FAKE_IMAGE_SLOT, { fetchedAtMs: null, expanded: false }, FAKE_POSITION);
  const expanded = createAemetWeatherImageryOverlayEntry('fireRisk', FAKE_IMAGE_SLOT, { fetchedAtMs: null, expanded: true }, FAKE_POSITION);
  assert.equal(expanded.thumbnailWidth, 640);
  assert.equal(expanded.thumbnailHeight, 427);
  assert.equal(expanded.protected, true);
  assert.equal(expanded.priority, Number.MAX_SAFE_INTEGER);
  assert.equal(collapsed.protected, false);
  assert.equal(expanded.selected, false, 'never selected on a thumbnail — breaks measureOverlayEntry sizing');
  assert.equal(expanded.title, 'AEMET FIRE RISK · CLICK TO COLLAPSE');
});

test('fire-risk\'s source field renders TODAY/TOMORROW; the other two maps ignore it', () => {
  const today = createAemetWeatherImageryOverlayEntry('fireRisk', FAKE_IMAGE_SLOT, { fetchedAtMs: null, source: 'estimado' }, FAKE_POSITION);
  const tomorrow = createAemetWeatherImageryOverlayEntry('fireRisk', FAKE_IMAGE_SLOT, { fetchedAtMs: null, source: 'previsto-1' }, FAKE_POSITION);
  assert.equal(today.title, 'AEMET FIRE RISK · TODAY');
  assert.equal(tomorrow.title, 'AEMET FIRE RISK · TOMORROW');
  const lightningWithSource = createAemetWeatherImageryOverlayEntry('lightning', FAKE_IMAGE_SLOT, { fetchedAtMs: null, source: 'estimado' }, FAKE_POSITION);
  assert.equal(lightningWithSource.title, 'AEMET LIGHTNING', 'lightning has no source field to render');
});

test('normalizeAemetWeatherImageryStatus validates shape and coerces missing fields safely', () => {
  assert.deepEqual(normalizeAemetWeatherImageryStatus({ hasKey: true, lastFetch: 100, stale: false }), {
    hasKey: true, lastFetch: 100, stale: false, source: null,
  });
  assert.deepEqual(normalizeAemetWeatherImageryStatus({}), { hasKey: false, lastFetch: null, stale: false, source: null });
  assert.equal(normalizeAemetWeatherImageryStatus(null), null);
});

test('getRowControls returns three distinct pills, one per map, lightning active by default', () => {
  const layer = createAemetWeatherImageryLayer({ overlayHost: fakeOverlayHost() });
  layer.init();
  const { chips } = layer.getRowControls();
  assert.equal(chips.length, 3);
  const ids = chips.map((c) => c.id);
  assert.deepEqual(new Set(ids).size, 3, 'each chip has a unique id — required for the panel to route clicks correctly');
  assert.deepEqual(ids, ['lightning', 'fireRisk', 'sst']);
  assert.equal(chips.find((c) => c.id === 'lightning').active, true);
  assert.equal(chips.find((c) => c.id === 'fireRisk').active, false);
  assert.equal(chips.find((c) => c.id === 'sst').active, false);
  for (const chip of chips) assert.deepEqual(Object.keys(chip.params), ['activeMap']);
});

test('setParams({ activeMap }) switches which pill is active and rejects an unknown map', () => {
  const layer = createAemetWeatherImageryLayer({ overlayHost: fakeOverlayHost() });
  layer.init();
  assert.equal(layer.setParams({ activeMap: 'fireRisk' }), true);
  assert.equal(layer._activeMapForTest(), 'fireRisk');
  assert.equal(layer.getRowControls().chips.find((c) => c.id === 'fireRisk').active, true);
  assert.equal(layer.setParams({ activeMap: 'not-a-real-map' }), false, 'an unknown map must be rejected, not silently accepted');
  assert.equal(layer._activeMapForTest(), 'fireRisk', 'a rejected setParams must not have changed state');
  assert.equal(layer.setParams({}), true, 'an empty params object is a no-op accept, not a rejection');
});

test('update() loads all three maps independently in the background, even though only one is shown', async () => {
  const overlayHost = fakeOverlayHost();
  const loaded = [];
  const layer = createAemetWeatherImageryLayer({
    overlayHost,
    loadImage: async (url) => { loaded.push(url); return { fakeImage: true }; },
  });
  const originalFetch = globalThis.fetch;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = fetchByMap({
      lightning: () => okStatus({ hasKey: true, lastFetch: 1000, stale: false }),
      fireRisk: () => okStatus({ hasKey: true, lastFetch: 2000, stale: false, source: 'estimado' }),
      sst: () => okStatus({ hasKey: true, lastFetch: 3000, stale: false }),
    });
    await layer.update();

    assert.equal(layer._hasImageForTest('lightning'), true);
    assert.equal(layer._hasImageForTest('fireRisk'), true);
    assert.equal(layer._hasImageForTest('sst'), true);
    assert.equal(loaded.length, 3, 'all three feeds load, not just the active one');

    // Only ONE overlay entry is ever published — for the active map only.
    const published = overlayHost.calls.filter(([type]) => type === 'entries').at(-1);
    assert.equal(published[2].length, 1);
    assert.match(published[2][0].title, /^AEMET LIGHTNING/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('switching the active pill after all three have loaded redisplays instantly with no new fetch', async () => {
  const overlayHost = fakeOverlayHost();
  let loadCalls = 0;
  const layer = createAemetWeatherImageryLayer({
    overlayHost,
    loadImage: async () => { loadCalls++; return { fakeImage: true }; },
  });
  const originalFetch = globalThis.fetch;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = fetchByMap({
      lightning: () => okStatus({ hasKey: true, lastFetch: 1000, stale: false }),
      fireRisk: () => okStatus({ hasKey: true, lastFetch: 2000, stale: false, source: 'previsto-1' }),
      sst: () => okStatus({ hasKey: true, lastFetch: 3000, stale: false }),
    });
    await layer.update();
    assert.equal(loadCalls, 3);
    overlayHost.calls.length = 0;

    layer.setParams({ activeMap: 'sst' });
    assert.equal(loadCalls, 3, 'switching pills never triggers a fetch — the image is already cached');
    const publishedAfterSwitch = overlayHost.calls.filter(([type]) => type === 'entries').at(-1);
    assert.match(publishedAfterSwitch[2][0].title, /^AEMET SEA SURFACE TEMP/);

    layer.setParams({ activeMap: 'fireRisk' });
    const publishedFireRisk = overlayHost.calls.filter(([type]) => type === 'entries').at(-1);
    assert.match(publishedFireRisk[2][0].title, /^AEMET FIRE RISK · TOMORROW/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('one map failing to load does not block the other two (per-map failure isolation)', async () => {
  const overlayHost = fakeOverlayHost();
  const layer = createAemetWeatherImageryLayer({
    overlayHost,
    loadImage: async () => ({ fakeImage: true }),
  });
  const originalFetch = globalThis.fetch;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = fetchByMap({
      lightning: () => okStatus({ hasKey: true, lastFetch: 1000, stale: false }),
      fireRisk: () => ({ ok: false, status: 500 }),
      sst: () => okStatus({ hasKey: true, lastFetch: 3000, stale: false }),
    });
    await layer.update();

    assert.equal(layer._hasImageForTest('lightning'), true);
    assert.equal(layer._hasImageForTest('sst'), true);
    assert.equal(layer._hasImageForTest('fireRisk'), false);

    layer.setParams({ activeMap: 'fireRisk' });
    assert.equal(layer.getStats().error, 'AEMET HTTP 500', 'the currently-active map surfaces its OWN error');
    assert.equal(layer.getStats().count, 0);

    layer.setParams({ activeMap: 'lightning' });
    assert.equal(layer.getStats().error, null, 'switching back to a healthy map clears the error the panel shows');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a slow image load that resolves after disable() is dropped, not published', async () => {
  const overlayHost = fakeOverlayHost();
  let resolveLightning;
  const layer = createAemetWeatherImageryLayer({
    overlayHost,
    loadImage: (url) => {
      if (url.includes('lightning')) return new Promise((resolve) => { resolveLightning = resolve; });
      return Promise.resolve({ fakeImage: true });
    },
  });
  const originalFetch = globalThis.fetch;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = fetchByMap({
      lightning: () => okStatus({ hasKey: true, lastFetch: 1000, stale: false }),
      fireRisk: () => okStatus({ hasKey: true, lastFetch: 2000, stale: false }),
      sst: () => okStatus({ hasKey: true, lastFetch: 3000, stale: false }),
    });

    const updatePromise = layer.update();
    while (!resolveLightning) await Promise.resolve();
    layer.disable();
    resolveLightning({ fakeImage: true });
    await updatePromise;

    assert.equal(layer._hasImageForTest('lightning'), false, 'the stale load must not apply after disable()');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('_toggleExpandedForTest flips the shared expand state for whichever map is active', async () => {
  const overlayHost = fakeOverlayHost();
  const layer = createAemetWeatherImageryLayer({
    overlayHost,
    loadImage: async () => ({ fakeImage: true }),
  });
  const originalFetch = globalThis.fetch;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = fetchByMap({
      lightning: () => okStatus({ hasKey: true, lastFetch: 1000, stale: false }),
      fireRisk: () => okStatus({ hasKey: true, lastFetch: 2000, stale: false }),
      sst: () => okStatus({ hasKey: true, lastFetch: 3000, stale: false }),
    });
    await layer.update();

    assert.equal(layer._isExpandedForTest(), false);
    layer._toggleExpandedForTest();
    assert.equal(layer._isExpandedForTest(), true);
    let entry = overlayHost.calls.at(-1)[2][0];
    assert.equal(entry.thumbnailWidth, 560, 'lightning\'s own expanded width');
    assert.equal(entry.protected, true);

    // Switching maps while expanded keeps the expand state, sized for the new map.
    layer.setParams({ activeMap: 'fireRisk' });
    entry = overlayHost.calls.at(-1)[2][0];
    assert.equal(layer._isExpandedForTest(), true);
    assert.equal(entry.thumbnailWidth, 640, 'fire-risk\'s own expanded width, not lightning\'s');
    assert.equal(entry.protected, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('disabling collapses an expanded card; re-enabling redisplays at the small size', async () => {
  const overlayHost = fakeOverlayHost();
  const layer = createAemetWeatherImageryLayer({
    overlayHost,
    loadImage: async () => ({ fakeImage: true }),
  });
  const originalFetch = globalThis.fetch;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = fetchByMap({
      lightning: () => okStatus({ hasKey: true, lastFetch: 1000, stale: false }),
      fireRisk: () => okStatus({ hasKey: true, lastFetch: 2000, stale: false }),
      sst: () => okStatus({ hasKey: true, lastFetch: 3000, stale: false }),
    });
    await layer.update();
    layer._toggleExpandedForTest();
    assert.equal(layer._isExpandedForTest(), true);

    layer.disable();
    layer.enable();
    assert.equal(layer._isExpandedForTest(), false, 'disable() resets expanded state');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('disabling and re-enabling preserves which pill was active — unlike expand state, that choice is not reset', async () => {
  const overlayHost = fakeOverlayHost();
  const layer = createAemetWeatherImageryLayer({
    overlayHost,
    loadImage: async () => ({ fakeImage: true }),
  });
  const originalFetch = globalThis.fetch;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = fetchByMap({
      lightning: () => okStatus({ hasKey: true, lastFetch: 1000, stale: false }),
      fireRisk: () => okStatus({ hasKey: true, lastFetch: 2000, stale: false }),
      sst: () => okStatus({ hasKey: true, lastFetch: 3000, stale: false }),
    });
    await layer.update();
    layer.setParams({ activeMap: 'sst' });

    layer.disable();
    layer.enable();
    assert.equal(layer._activeMapForTest(), 'sst', 'the chosen map survives a disable/enable cycle');

    layer.init(); // a fresh boot, unlike a mere disable/enable, does reset it
    assert.equal(layer._activeMapForTest(), 'lightning');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('destroy() clears the overlay source and resets stats', async () => {
  const overlayHost = fakeOverlayHost();
  const layer = createAemetWeatherImageryLayer({
    overlayHost,
    loadImage: async () => ({ fakeImage: true }),
  });
  const originalFetch = globalThis.fetch;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = fetchByMap({
      lightning: () => okStatus({ hasKey: true, lastFetch: 1000, stale: false }),
      fireRisk: () => okStatus({ hasKey: true, lastFetch: 2000, stale: false }),
      sst: () => okStatus({ hasKey: true, lastFetch: 3000, stale: false }),
    });
    await layer.update();
    layer.destroy();
    assert.equal(layer.getStats().count, 0);
    assert.deepEqual(overlayHost.calls.at(-1), ['clear', AEMET_WEATHER_IMAGERY_OVERLAY_SOURCE_ID]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('network errors from a status endpoint are reported per-map, not thrown', async () => {
  const layer = createAemetWeatherImageryLayer({ overlayHost: fakeOverlayHost(), loadImage: async () => null });
  const originalFetch = globalThis.fetch;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = async () => { throw new Error('network down'); };
    const ok = await layer.update();
    assert.equal(ok, false);
    assert.equal(layer.getStats().error, 'AEMET network error');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AEMET_WEATHER_IMAGERY_OVERLAY_SOURCE_OPTIONS keeps a real, non-zero collision capacity', () => {
  assert.equal(AEMET_WEATHER_IMAGERY_OVERLAY_SOURCE_OPTIONS.collisionCapacity, 1);
});
