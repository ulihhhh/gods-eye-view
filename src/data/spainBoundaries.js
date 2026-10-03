/**
 * Bundled Spain PROVINCIAL boundary polygons — offline, lazy-loaded, cached
 * in module scope. Same shape as `naturalEarthRegions.js`: a pure data
 * module (no Cesium import, node-testable), backed by a JSON pack under
 * `local_data/spain_boundaries/` (see that directory's `SOURCE.md` for
 * provenance/license — Natural Earth's 10m admin-1 layer, which for Spain is
 * at province level: 50 provinces + Ceuta + Melilla, each carrying its
 * parent comunidad autónoma as `ccaaId`/`ccaaName`).
 *
 * Used by the AEMET temperature-gradient overlay
 * (`temperatureGradientRaster.js`) to clip the interpolated raster to Spain's
 * outline and to draw province border reference lines
 * (`aemetStations.js`'s `_buildBordersOnce`) — not for any per-region
 * aggregation (that's a deliberately separate, not-yet-built, choropleth
 * approach; `ccaaId`/`ccaaName` are carried through for a future caller that
 * wants to re-aggregate to CCAA level without a second data source).
 */

import { loadBundledJson } from './bundledJson.js';
import { createRetryableLoader } from './retryableLoad.js';

/** @typedef {{id: string, name: string, ccaaId: string, ccaaName: string, rings: Array<Array<[number, number]>>}} CcaaFeature */

/**
 * Read through the shared `loadBundledJson`: the browser fetches the pack as
 * plain JSON, Node reads the `file:` URL from disk. Never import the JSON as
 * a module — that makes the production build emit an unused JavaScript copy
 * of the pack (enforced by `bundledJson.test.mjs`).
 */
const PACK_URL = new URL(
  './local_data/spain_boundaries/provinces.json',
  import.meta.url,
);

function loadPackFile() {
  return loadBundledJson(PACK_URL);
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
 * All provincial features (52: 50 provinces + Ceuta + Melilla).
 * @returns {Promise<CcaaFeature[]>}
 */
export async function getCcaaFeatures() {
  const { features } = await loadPack();
  return features;
}

/**
 * The bounding box covering every loaded province polygon (mainland +
 * Balearics + Canary Islands + Ceuta/Melilla) — i.e. all of Spain.
 * @returns {Promise<[number, number, number, number]>} `[west, south, east, north]`
 */
export async function getSpainBbox() {
  const { bbox } = await loadPack();
  return bbox;
}

// exported for tests
export { loadPackFile as _loadPackFile };
