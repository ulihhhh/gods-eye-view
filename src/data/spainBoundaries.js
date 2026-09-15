/**
 * Bundled Spain comunidad-autónoma boundary polygons — offline, lazy-loaded,
 * cached in module scope. Same shape as `naturalEarthRegions.js`: a pure data
 * module (no Cesium import, node-testable), backed by a JSON pack under
 * `local_data/spain_boundaries/` (see that directory's `SOURCE.md` for
 * provenance/license).
 *
 * Used by the AEMET temperature-gradient overlay
 * (`temperatureGradientRaster.js`) to clip the interpolated raster to Spain's
 * outline and to draw CCAA borders as reference lines — not for any
 * per-region aggregation (that's a deliberately separate, not-yet-built,
 * choropleth approach).
 */

import { createRetryableLoader } from './retryableLoad.js';

/** @typedef {{id: string, name: string, rings: Array<Array<[number, number]>>}} CcaaFeature */

/**
 * Browser vs. Node take different paths on purpose: a dynamic
 * `import(..., { with: { type: 'json' } })` for a Vite-transformed
 * `?import`-suffixed specifier was found live to throw "Failed to fetch
 * dynamically imported module" in this Vite version (the dev server's own
 * response carries the right `Content-Type: application/json` — confirmed
 * with a direct fetch — but the browser's module loader rejects it anyway),
 * even though the exact same pattern is what `naturalEarthRegions.js` uses.
 * A plain `fetch()` sidesteps that dynamic-import machinery entirely and is
 * unaffected. Node has no such quirk, but a dynamic import needs the
 * attribute there to recognize the file as JSON at all under `node:test`.
 */
async function loadPackFile() {
  if (typeof document !== 'undefined' && typeof fetch === 'function') {
    const url = new URL('./local_data/spain_boundaries/ccaa.json', import.meta.url);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch ccaa.json: HTTP ${response.status}`);
    return response.json();
  }
  const mod = await import('./local_data/spain_boundaries/ccaa.json', {
    with: { type: 'json' },
  });
  return mod.default || mod;
}

/** @type {CcaaFeature[]|null} */
let _features = null;
/** @type {[number, number, number, number]|null} west, south, east, north */
let _bbox = null;

const loadPack = createRetryableLoader(async () => {
  const pack = await loadPackFile();
  _features = pack.features || [];
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const feature of _features) {
    for (const ring of feature.rings) {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  _bbox = [minLon, minLat, maxLon, maxLat];
  return { features: _features, bbox: _bbox };
});

/**
 * All CCAA/ciudad-autónoma features (19: 17 comunidades + Ceuta + Melilla).
 * @returns {Promise<CcaaFeature[]>}
 */
export async function getCcaaFeatures() {
  const { features } = await loadPack();
  return features;
}

/**
 * The bounding box covering every loaded CCAA polygon (mainland + Balearics +
 * Canary Islands + Ceuta/Melilla) — i.e. all of Spain.
 * @returns {Promise<[number, number, number, number]>} `[west, south, east, north]`
 */
export async function getSpainBbox() {
  const { bbox } = await loadPack();
  return bbox;
}

// exported for tests
export { loadPackFile as _loadPackFile };
