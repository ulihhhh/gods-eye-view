import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AEMET_FIRE_RISK_OVERLAY_SOURCE_ID,
  AEMET_FIRE_RISK_OVERLAY_SOURCE_OPTIONS,
  createAemetFireRiskLayer,
  createAemetFireRiskOverlayEntry,
  normalizeAemetFireRiskStatus,
} from './aemetFireRisk.js';

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

test('createAemetFireRiskOverlayEntry builds a clickable thumbnail entry carrying the image slot through unchanged', () => {
  const entry = createAemetFireRiskOverlayEntry(FAKE_IMAGE_SLOT, { fetchedAtMs: null, source: null }, FAKE_POSITION);
  assert.equal(entry.id, AEMET_FIRE_RISK_OVERLAY_SOURCE_ID);
  assert.equal(entry.variant, 'thumbnail');
  assert.equal(entry.position, FAKE_POSITION);
  assert.equal(entry.image, FAKE_IMAGE_SLOT);
  assert.equal(entry.requireImage, true);
  assert.equal(entry.interactive, true);
  assert.equal(entry.title, 'AEMET FIRE RISK');
  assert.equal(entry.thumbnailWidth > 0, true);
  assert.equal(entry.thumbnailHeight > 0, true);
});

test('createAemetFireRiskOverlayEntry renders a much bigger, protected, never-selected card when expanded', () => {
  const collapsed = createAemetFireRiskOverlayEntry(FAKE_IMAGE_SLOT, { fetchedAtMs: null, source: null, expanded: false }, FAKE_POSITION);
  const expanded = createAemetFireRiskOverlayEntry(FAKE_IMAGE_SLOT, { fetchedAtMs: null, source: null, expanded: true }, FAKE_POSITION);
  assert.ok(expanded.thumbnailWidth > collapsed.thumbnailWidth * 3, 'expanded is dramatically bigger, not a small bump');
  assert.ok(expanded.thumbnailHeight > collapsed.thumbnailHeight * 3);
  assert.equal(expanded.protected, true);
  assert.equal(expanded.priority, Number.MAX_SAFE_INTEGER);
  assert.equal(collapsed.protected, false);
  assert.equal(expanded.selected, false, 'never `selected: true` on a thumbnail — see aemetLightning.js for why that silently breaks sizing');
  assert.equal(collapsed.selected, false);
  assert.equal(expanded.title, 'AEMET FIRE RISK · CLICK TO COLLAPSE');
});

test('createAemetFireRiskOverlayEntry\'s title distinguishes today\'s estimate from tomorrow\'s fallback', () => {
  const today = createAemetFireRiskOverlayEntry(FAKE_IMAGE_SLOT, { fetchedAtMs: null, source: 'estimado' }, FAKE_POSITION);
  assert.equal(today.title, 'AEMET FIRE RISK · TODAY');
  const tomorrow = createAemetFireRiskOverlayEntry(FAKE_IMAGE_SLOT, { fetchedAtMs: null, source: 'previsto-1' }, FAKE_POSITION);
  assert.equal(tomorrow.title, 'AEMET FIRE RISK · TOMORROW');
  const unknown = createAemetFireRiskOverlayEntry(FAKE_IMAGE_SLOT, { fetchedAtMs: null, source: null }, FAKE_POSITION);
  assert.equal(unknown.title, 'AEMET FIRE RISK');
});

test('createAemetFireRiskOverlayEntry\'s title carries a relative freshness label when a fetch time is known', (t) => {
  const now = Date.UTC(2026, 8, 12, 12, 0, 0);
  t.mock.method(Date, 'now', () => now);
  const justNow = createAemetFireRiskOverlayEntry(FAKE_IMAGE_SLOT, { fetchedAtMs: now - 30_000, source: 'estimado' }, FAKE_POSITION);
  assert.equal(justNow.title, 'AEMET FIRE RISK · TODAY · JUST NOW');
  const hoursAgo = createAemetFireRiskOverlayEntry(FAKE_IMAGE_SLOT, { fetchedAtMs: now - 5 * 3600_000, source: 'previsto-1' }, FAKE_POSITION);
  assert.equal(hoursAgo.title, 'AEMET FIRE RISK · TOMORROW · 5H AGO');
});

test('normalizeAemetFireRiskStatus validates shape and coerces missing fields safely', () => {
  assert.deepEqual(normalizeAemetFireRiskStatus({ hasKey: true, lastFetch: 100, stale: false, source: 'estimado' }), {
    hasKey: true, lastFetch: 100, stale: false, source: 'estimado',
  });
  assert.deepEqual(normalizeAemetFireRiskStatus({}), { hasKey: false, lastFetch: null, stale: false, source: null });
  assert.equal(normalizeAemetFireRiskStatus(null), null);
});

test('update() with no key sets an error and never attempts to load an image', async () => {
  const overlayHost = fakeOverlayHost();
  let loadImageCalls = 0;
  const layer = createAemetFireRiskLayer({
    overlayHost,
    loadImage: async () => { loadImageCalls++; return null; },
  });
  const originalFetch = globalThis.fetch;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ hasKey: false, lastFetch: null, stale: false, source: null }) });
    const ok = await layer.update();
    assert.equal(ok, false);
    assert.equal(layer.getStats().error, 'AEMET_API_KEY not configured');
    assert.equal(loadImageCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('update() loads and publishes a new image only when lastFetch/source actually move', async () => {
  const overlayHost = fakeOverlayHost();
  let loadImageCalls = [];
  const layer = createAemetFireRiskLayer({
    overlayHost,
    loadImage: async (url) => { loadImageCalls.push(url); return { fakeImage: true }; },
  });
  const originalFetch = globalThis.fetch;
  let lastFetch = 1000;
  let source = 'previsto-1';
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ hasKey: true, lastFetch, stale: false, source }) });

    await layer.update();
    assert.equal(loadImageCalls.length, 1);
    assert.equal(layer._loadedFetchedAtForTest(), 1000);
    assert.equal(layer._loadedSourceForTest(), 'previsto-1');
    const published = overlayHost.calls.find(([type]) => type === 'entries');
    assert.equal(published[1], AEMET_FIRE_RISK_OVERLAY_SOURCE_ID);
    assert.deepEqual(published[3], AEMET_FIRE_RISK_OVERLAY_SOURCE_OPTIONS);

    // Same lastFetch AND source — no re-fetch.
    await layer.update();
    assert.equal(loadImageCalls.length, 1);

    // AEMET has since published today's real estimate — same lastFetch
    // timestamp coincidentally, but the SOURCE flipped, so this must still
    // reload (the bytes are a different map now).
    source = 'estimado';
    await layer.update();
    assert.equal(loadImageCalls.length, 2, 'a source flip alone must trigger a reload even if lastFetch did not move');
    assert.equal(layer._loadedSourceForTest(), 'estimado');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a null lastFetch on the very first poll still triggers an image load', async () => {
  const overlayHost = fakeOverlayHost();
  let loadImageCalls = [];
  const layer = createAemetFireRiskLayer({
    overlayHost,
    loadImage: async (url) => { loadImageCalls.push(url); return { fakeImage: true }; },
  });
  const originalFetch = globalThis.fetch;
  let statusCalls = 0;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = async () => {
      statusCalls++;
      const lastFetch = statusCalls === 1 ? null : 5000;
      const source = statusCalls === 1 ? null : 'estimado';
      return { ok: true, status: 200, json: async () => ({ hasKey: true, lastFetch, stale: false, source }) };
    };

    const ok = await layer.update();
    assert.equal(ok, true);
    assert.equal(loadImageCalls.length, 1);
    assert.equal(layer._loadedFetchedAtForTest(), 5000);
    assert.equal(layer._loadedSourceForTest(), 'estimado');

    await layer.update();
    assert.equal(loadImageCalls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a slow image load that resolves after disable() is dropped, not published', async () => {
  const overlayHost = fakeOverlayHost();
  let resolveImage;
  const layer = createAemetFireRiskLayer({
    overlayHost,
    loadImage: () => new Promise((resolve) => { resolveImage = resolve; }),
  });
  const originalFetch = globalThis.fetch;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ hasKey: true, lastFetch: 1000, stale: false, source: 'estimado' }) });

    const updatePromise = layer.update();
    while (!resolveImage) await Promise.resolve();
    layer.disable();
    resolveImage({ fakeImage: true });
    await updatePromise;

    assert.equal(layer._hasImageForTest(), false);
    assert.equal(overlayHost.calls.some(([type]) => type === 'entries'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a failed image load sets an error without crashing', async () => {
  const overlayHost = fakeOverlayHost();
  const layer = createAemetFireRiskLayer({
    overlayHost,
    loadImage: async () => null,
  });
  const originalFetch = globalThis.fetch;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ hasKey: true, lastFetch: 1000, stale: false, source: 'estimado' }) });
    const ok = await layer.update();
    assert.equal(ok, false);
    assert.equal(layer.getStats().error, 'AEMET fire-risk image failed to load');
    assert.equal(layer.getStats().count, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('re-enabling after a disable redisplays an already-loaded image without a new fetch', async () => {
  const overlayHost = fakeOverlayHost();
  const layer = createAemetFireRiskLayer({
    overlayHost,
    loadImage: async () => ({ fakeImage: true }),
  });
  const originalFetch = globalThis.fetch;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ hasKey: true, lastFetch: 1000, stale: false, source: 'estimado' }) });
    await layer.update();
    overlayHost.calls.length = 0;

    layer.disable();
    assert.deepEqual(overlayHost.calls.at(-1), ['visible', AEMET_FIRE_RISK_OVERLAY_SOURCE_ID, false]);

    layer.enable();
    const republished = overlayHost.calls.find(([type]) => type === 'entries');
    assert.ok(republished);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('_toggleExpandedForTest flips between the small and large card and republishes', async () => {
  const overlayHost = fakeOverlayHost();
  const layer = createAemetFireRiskLayer({
    overlayHost,
    loadImage: async () => ({ fakeImage: true }),
  });
  const originalFetch = globalThis.fetch;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ hasKey: true, lastFetch: 1000, stale: false, source: 'estimado' }) });
    await layer.update();

    assert.equal(layer._isExpandedForTest(), false);
    layer._toggleExpandedForTest();
    assert.equal(layer._isExpandedForTest(), true);
    const expandedEntry = overlayHost.calls.at(-1)[2][0];
    assert.equal(expandedEntry.thumbnailWidth, 640);
    assert.equal(expandedEntry.protected, true);

    layer._toggleExpandedForTest();
    assert.equal(layer._isExpandedForTest(), false);
    const collapsedEntry = overlayHost.calls.at(-1)[2][0];
    assert.equal(collapsedEntry.thumbnailWidth, 168);
    assert.equal(collapsedEntry.protected, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('disabling collapses an expanded card — a re-enable never resumes already expanded', async () => {
  const overlayHost = fakeOverlayHost();
  const layer = createAemetFireRiskLayer({
    overlayHost,
    loadImage: async () => ({ fakeImage: true }),
  });
  const originalFetch = globalThis.fetch;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ hasKey: true, lastFetch: 1000, stale: false, source: 'estimado' }) });
    await layer.update();
    layer._toggleExpandedForTest();
    assert.equal(layer._isExpandedForTest(), true);

    layer.disable();
    layer.enable();
    assert.equal(layer._isExpandedForTest(), false);
    const republished = overlayHost.calls.filter(([type]) => type === 'entries').at(-1);
    assert.equal(republished[2][0].thumbnailWidth, 168);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('destroy() clears the overlay source and resets stats', async () => {
  const overlayHost = fakeOverlayHost();
  const layer = createAemetFireRiskLayer({
    overlayHost,
    loadImage: async () => ({ fakeImage: true }),
  });
  const originalFetch = globalThis.fetch;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ hasKey: true, lastFetch: 1000, stale: false, source: 'estimado' }) });
    await layer.update();
    layer.destroy();
    assert.equal(layer.getStats().count, 0);
    assert.deepEqual(overlayHost.calls.at(-1), ['clear', AEMET_FIRE_RISK_OVERLAY_SOURCE_ID]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('network and HTTP errors from the status endpoint are reported, not thrown', async () => {
  const layer = createAemetFireRiskLayer({ overlayHost: fakeOverlayHost(), loadImage: async () => null });
  const originalFetch = globalThis.fetch;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    assert.equal(await layer.update(), false);
    assert.equal(layer.getStats().error, 'AEMET HTTP 500');

    globalThis.fetch = async () => { throw new Error('network down'); };
    assert.equal(await layer.update(), false);
    assert.equal(layer.getStats().error, 'AEMET network error');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
