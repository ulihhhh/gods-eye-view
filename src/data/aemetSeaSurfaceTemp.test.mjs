import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AEMET_SEA_SURFACE_TEMP_OVERLAY_SOURCE_ID,
  AEMET_SEA_SURFACE_TEMP_OVERLAY_SOURCE_OPTIONS,
  createAemetSeaSurfaceTempLayer,
  createAemetSeaSurfaceTempOverlayEntry,
  normalizeAemetSeaSurfaceTempStatus,
} from './aemetSeaSurfaceTemp.js';

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

test('createAemetSeaSurfaceTempOverlayEntry builds a clickable thumbnail entry carrying the image slot through unchanged', () => {
  const entry = createAemetSeaSurfaceTempOverlayEntry(FAKE_IMAGE_SLOT, { fetchedAtMs: null }, FAKE_POSITION);
  assert.equal(entry.id, AEMET_SEA_SURFACE_TEMP_OVERLAY_SOURCE_ID);
  assert.equal(entry.variant, 'thumbnail');
  assert.equal(entry.position, FAKE_POSITION);
  assert.equal(entry.image, FAKE_IMAGE_SLOT);
  assert.equal(entry.requireImage, true);
  assert.equal(entry.interactive, true, 'clickable so it can expand — see the dedicated expand/collapse tests');
  assert.equal(entry.title, 'AEMET SEA SURFACE TEMP');
  assert.equal(entry.thumbnailWidth > 0, true);
  assert.equal(entry.thumbnailHeight > 0, true);
});

test('createAemetSeaSurfaceTempOverlayEntry renders a much bigger, protected card when expanded', () => {
  const collapsed = createAemetSeaSurfaceTempOverlayEntry(FAKE_IMAGE_SLOT, { fetchedAtMs: null, expanded: false }, FAKE_POSITION);
  const expanded = createAemetSeaSurfaceTempOverlayEntry(FAKE_IMAGE_SLOT, { fetchedAtMs: null, expanded: true }, FAKE_POSITION);
  assert.ok(expanded.thumbnailWidth > collapsed.thumbnailWidth * 2, 'expanded is dramatically bigger, not a small bump');
  assert.ok(expanded.thumbnailHeight > collapsed.thumbnailHeight * 2);
  assert.equal(expanded.protected, true, 'protected so the collision solver can never drop a deliberately-opened card');
  assert.equal(expanded.priority, Number.MAX_SAFE_INTEGER);
  assert.equal(collapsed.protected, false);
  assert.equal(expanded.selected, false, 'never `selected: true` on a thumbnail — see aemetLightning.js\'s comment for why that silently breaks sizing');
  assert.equal(expanded.title, 'AEMET SEA SURFACE TEMP · CLICK TO COLLAPSE');
  assert.equal(collapsed.title, 'AEMET SEA SURFACE TEMP');
});

test('createAemetSeaSurfaceTempOverlayEntry\'s title carries a relative freshness label when a fetch time is known', (t) => {
  const now = Date.UTC(2026, 8, 12, 12, 0, 0);
  t.mock.method(Date, 'now', () => now);
  const justNow = createAemetSeaSurfaceTempOverlayEntry(FAKE_IMAGE_SLOT, { fetchedAtMs: now - 30_000 }, FAKE_POSITION);
  assert.equal(justNow.title, 'AEMET SEA SURFACE TEMP · JUST NOW');
  const minutesAgo = createAemetSeaSurfaceTempOverlayEntry(FAKE_IMAGE_SLOT, { fetchedAtMs: now - 20 * 60_000 }, FAKE_POSITION);
  assert.equal(minutesAgo.title, 'AEMET SEA SURFACE TEMP · 20M AGO');
  const hoursAgo = createAemetSeaSurfaceTempOverlayEntry(FAKE_IMAGE_SLOT, { fetchedAtMs: now - 5 * 3600_000 }, FAKE_POSITION);
  assert.equal(hoursAgo.title, 'AEMET SEA SURFACE TEMP · 5H AGO');
});

test('normalizeAemetSeaSurfaceTempStatus validates shape and coerces missing fields safely', () => {
  assert.deepEqual(normalizeAemetSeaSurfaceTempStatus({ hasKey: true, lastFetch: 100, stale: false }), {
    hasKey: true, lastFetch: 100, stale: false,
  });
  assert.deepEqual(normalizeAemetSeaSurfaceTempStatus({}), { hasKey: false, lastFetch: null, stale: false });
  assert.equal(normalizeAemetSeaSurfaceTempStatus(null), null);
});

test('update() with no key sets an error and never attempts to load an image', async () => {
  const overlayHost = fakeOverlayHost();
  let loadImageCalls = 0;
  const layer = createAemetSeaSurfaceTempLayer({
    overlayHost,
    loadImage: async () => { loadImageCalls++; return null; },
  });
  const originalFetch = globalThis.fetch;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ hasKey: false, lastFetch: null, stale: false }) });
    const ok = await layer.update();
    assert.equal(ok, false);
    assert.equal(layer.getStats().error, 'AEMET_API_KEY not configured');
    assert.equal(loadImageCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('update() loads and publishes a new image only when lastFetch actually moves', async () => {
  const overlayHost = fakeOverlayHost();
  let loadImageCalls = [];
  const layer = createAemetSeaSurfaceTempLayer({
    overlayHost,
    loadImage: async (url) => { loadImageCalls.push(url); return { fakeImage: true }; },
  });
  const originalFetch = globalThis.fetch;
  let lastFetch = 1000;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ hasKey: true, lastFetch, stale: false }) });

    await layer.update();
    assert.equal(loadImageCalls.length, 1);
    assert.ok(loadImageCalls[0].includes(`ts=${lastFetch}`));
    assert.equal(layer._hasImageForTest(), true);
    assert.equal(layer._loadedFetchedAtForTest(), 1000);
    const published = overlayHost.calls.find(([type]) => type === 'entries');
    assert.equal(published[1], AEMET_SEA_SURFACE_TEMP_OVERLAY_SOURCE_ID);
    assert.deepEqual(published[3], AEMET_SEA_SURFACE_TEMP_OVERLAY_SOURCE_OPTIONS);

    // Same lastFetch on the next poll — no re-fetch of the image.
    await layer.update();
    assert.equal(loadImageCalls.length, 1, 'unchanged lastFetch must not re-trigger an image load');

    // AEMET actually refreshed the composite — a new load fires.
    lastFetch = 2000;
    await layer.update();
    assert.equal(loadImageCalls.length, 2);
    assert.equal(layer._loadedFetchedAtForTest(), 2000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a null lastFetch on the very first poll still triggers an image load (it means the proxy has never fetched, not "nothing new")', async () => {
  const overlayHost = fakeOverlayHost();
  let loadImageCalls = [];
  const layer = createAemetSeaSurfaceTempLayer({
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
      return { ok: true, status: 200, json: async () => ({ hasKey: true, lastFetch, stale: false }) };
    };

    const ok = await layer.update();
    assert.equal(ok, true);
    assert.equal(loadImageCalls.length, 1, 'a null lastFetch must still trigger a load attempt');
    assert.equal(layer._hasImageForTest(), true);
    assert.equal(layer._loadedFetchedAtForTest(), 5000, 'the re-read status timestamp is used, not an approximation');

    // Next poll reports that same 5000 timestamp — no redundant reload.
    await layer.update();
    assert.equal(loadImageCalls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a slow image load that resolves after disable() is dropped, not published', async () => {
  const overlayHost = fakeOverlayHost();
  let resolveImage;
  const layer = createAemetSeaSurfaceTempLayer({
    overlayHost,
    loadImage: () => new Promise((resolve) => { resolveImage = resolve; }),
  });
  const originalFetch = globalThis.fetch;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ hasKey: true, lastFetch: 1000, stale: false }) });

    const updatePromise = layer.update(); // image load now pending
    while (!resolveImage) await Promise.resolve(); // let update() reach the loadImage() call
    layer.disable();
    resolveImage({ fakeImage: true });
    await updatePromise;

    assert.equal(layer._hasImageForTest(), false, 'the stale load must not apply after disable()');
    assert.equal(overlayHost.calls.some(([type]) => type === 'entries'), false, 'nothing was ever published');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a failed image load sets an error without crashing', async () => {
  const overlayHost = fakeOverlayHost();
  const layer = createAemetSeaSurfaceTempLayer({
    overlayHost,
    loadImage: async () => null,
  });
  const originalFetch = globalThis.fetch;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ hasKey: true, lastFetch: 1000, stale: false }) });
    const ok = await layer.update();
    assert.equal(ok, false);
    assert.equal(layer.getStats().error, 'AEMET sea-surface-temp image failed to load');
    assert.equal(layer.getStats().count, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('re-enabling after a disable redisplays an already-loaded image without a new fetch', async () => {
  const overlayHost = fakeOverlayHost();
  const layer = createAemetSeaSurfaceTempLayer({
    overlayHost,
    loadImage: async () => ({ fakeImage: true }),
  });
  const originalFetch = globalThis.fetch;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ hasKey: true, lastFetch: 1000, stale: false }) });
    await layer.update();
    overlayHost.calls.length = 0;

    layer.disable();
    assert.deepEqual(overlayHost.calls.at(-1), ['visible', AEMET_SEA_SURFACE_TEMP_OVERLAY_SOURCE_ID, false]);

    layer.enable();
    const republished = overlayHost.calls.find(([type]) => type === 'entries');
    assert.ok(republished, 'the cached image redisplays immediately on re-enable');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('_toggleExpandedForTest flips between the small and large card and republishes', async () => {
  const overlayHost = fakeOverlayHost();
  const layer = createAemetSeaSurfaceTempLayer({
    overlayHost,
    loadImage: async () => ({ fakeImage: true }),
  });
  const originalFetch = globalThis.fetch;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ hasKey: true, lastFetch: 1000, stale: false }) });
    await layer.update();

    assert.equal(layer._isExpandedForTest(), false);
    layer._toggleExpandedForTest();
    assert.equal(layer._isExpandedForTest(), true);
    const expandedEntry = overlayHost.calls.at(-1)[2][0];
    assert.equal(expandedEntry.thumbnailWidth, 560);
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
  const layer = createAemetSeaSurfaceTempLayer({
    overlayHost,
    loadImage: async () => ({ fakeImage: true }),
  });
  const originalFetch = globalThis.fetch;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ hasKey: true, lastFetch: 1000, stale: false }) });
    await layer.update();
    layer._toggleExpandedForTest();
    assert.equal(layer._isExpandedForTest(), true);

    layer.disable();
    layer.enable();
    assert.equal(layer._isExpandedForTest(), false, 'disable() resets expanded state');
    const republished = overlayHost.calls.filter(([type]) => type === 'entries').at(-1);
    assert.equal(republished[2][0].thumbnailWidth, 168, 'redisplays at the small size, not still expanded');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('destroy() clears the overlay source and resets stats', async () => {
  const overlayHost = fakeOverlayHost();
  const layer = createAemetSeaSurfaceTempLayer({
    overlayHost,
    loadImage: async () => ({ fakeImage: true }),
  });
  const originalFetch = globalThis.fetch;
  try {
    layer.init();
    layer.enable();
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ hasKey: true, lastFetch: 1000, stale: false }) });
    await layer.update();
    layer.destroy();
    assert.equal(layer.getStats().count, 0);
    assert.deepEqual(overlayHost.calls.at(-1), ['clear', AEMET_SEA_SURFACE_TEMP_OVERLAY_SOURCE_ID]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('network and HTTP errors from the status endpoint are reported, not thrown', async () => {
  const layer = createAemetSeaSurfaceTempLayer({ overlayHost: fakeOverlayHost(), loadImage: async () => null });
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
