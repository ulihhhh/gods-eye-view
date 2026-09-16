/**
 * Renders the AEMET temperature-gradient overlay: an IDW-interpolated raster
 * (`temperatureInterpolation.js`) painted to an offscreen canvas and clipped
 * to a region's outline — then handed back as a data URL ready for
 * `new Cesium.SingleTileImageryProvider({ url, rectangle })`. CCAA borders
 * are NOT baked in here — at this canvas's resolution (~1.5km/pixel for the
 * mainland region) stroked borders turned into visible staircases once
 * zoomed in. `aemetStations.js` draws them separately as real vector Cesium
 * polylines instead, which stay crisp at any zoom.
 *
 * Kept DOM-dependent parts (canvas) behind an injectable `createCanvas`, the
 * same seam `aemetWeatherImagery.js` uses for `loadImage`, so the pure grid
 * math above it stays node-testable while this module itself only runs in a
 * real browser.
 *
 * Two SEPARATE regions/images, not one: the Canary Islands sit ~1,000 km
 * southwest of the mainland, so a single raster rectangle spanning both
 * would waste most of its canvas on empty ocean. Instead each region gets
 * its own tightly-cropped bbox, raster, and clip path — and `aemetStations.js`
 * mounts one `Cesium.ImageryLayer` per region returned here. IDW still runs
 * against the FULL station list for both regions (not just each region's own
 * stations): the hash grid in `temperatureInterpolation.js` finds nearest
 * neighbors by absolute distance, and mainland/Canary stations are far
 * enough apart that neither region's cells end up pulling from the other's
 * stations anyway.
 */

import { buildIdwGrid } from './temperatureInterpolation.js';
import { getCcaaFeatures } from './spainBoundaries.js';
import { temperatureColorRgb } from './aemetStations.js';

const CANARY_PROVINCE_IDS = new Set(['las-palmas', 'santa-cruz-de-tenerife']);

const BBOX_PADDING_DEG = 0.15;
const GRID_CELLS_X = 180;
/** Canvas pixels per grid cell — smooths the blocky IDW grid via the browser's own bilinear upscale on drawImage. */
const OUTPUT_SCALE = 3;
const HEATMAP_ALPHA = 0.55;

function defaultCreateCanvas(width, height) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function computeBbox(features) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const feature of features) {
    for (const ring of feature.rings) {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  return [minLon - BBOX_PADDING_DEG, minLat - BBOX_PADDING_DEG, maxLon + BBOX_PADDING_DEG, maxLat + BBOX_PADDING_DEG];
}

/** lon/lat → canvas pixel, top = north (row 0), matching `buildIdwGrid`'s own orientation. */
function project([lon, lat], bbox, width, height) {
  const [west, south, east, north] = bbox;
  return [
    ((lon - west) / (east - west)) * width,
    ((north - lat) / (north - south)) * height,
  ];
}

function ringToPath2D(ring, bbox, width, height) {
  const path = new Path2D();
  ring.forEach((point, i) => {
    const [x, y] = project(point, bbox, width, height);
    if (i === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  });
  path.closePath();
  return path;
}

/** Paint the IDW grid into a same-size raster canvas, one pixel per cell, transparent where the grid has no data. */
function paintGridCanvas(grid, createCanvas) {
  const { values, cellsX, cellsY } = grid;
  const canvas = createCanvas(cellsX, cellsY);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(cellsX, cellsY);
  const alphaByte = Math.round(HEATMAP_ALPHA * 255);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const o = i * 4;
    if (!Number.isFinite(v)) {
      imageData.data[o + 3] = 0;
      continue;
    }
    const rgb = temperatureColorRgb(v) ?? [145, 164, 180];
    imageData.data[o] = rgb[0];
    imageData.data[o + 1] = rgb[1];
    imageData.data[o + 2] = rgb[2];
    imageData.data[o + 3] = alphaByte;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/** Build one region's raster+clip image, or `null` for an empty feature set / no DOM. */
function buildRegionImage(features, points, createCanvas) {
  if (!features.length) return null;
  const bbox = computeBbox(features);

  const grid = buildIdwGrid(points, bbox, { cellsX: GRID_CELLS_X });
  const rasterCanvas = paintGridCanvas(grid, createCanvas);
  if (!rasterCanvas) return null; // no DOM

  const outputWidth = grid.cellsX * OUTPUT_SCALE;
  const outputHeight = grid.cellsY * OUTPUT_SCALE;
  const outputCanvas = createCanvas(outputWidth, outputHeight);
  if (!outputCanvas) return null;
  const ctx = outputCanvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;

  const allRings = features.flatMap((f) => f.rings);
  const clipPath = new Path2D();
  for (const ring of allRings) clipPath.addPath(ringToPath2D(ring, bbox, outputWidth, outputHeight));

  ctx.save();
  ctx.clip(clipPath);
  ctx.drawImage(rasterCanvas, 0, 0, outputWidth, outputHeight);
  ctx.restore();

  return { dataUrl: outputCanvas.toDataURL('image/png'), bbox };
}

/**
 * Build the gradient overlay images for the given station readings — one per
 * region (mainland+Baleares+Ceuta/Melilla, and the Canary Islands).
 * @param {Array<{lat: number, lon: number, temperatureC: number}>} stations
 * @param {object} [options]
 * @param {(w: number, h: number) => HTMLCanvasElement|null} [options.createCanvas]
 * @returns {Promise<Array<{dataUrl: string, bbox: [number, number, number, number]}>>}
 *   Empty when there's no DOM (headless/test) or no usable station data. A
 *   region with no boundary features (shouldn't happen with the bundled
 *   pack) or no DOM is simply omitted rather than failing the whole call.
 */
export async function buildTemperatureGradientImages(stations, { createCanvas = defaultCreateCanvas } = {}) {
  const allFeatures = await getCcaaFeatures();
  const mainlandFeatures = allFeatures.filter((f) => !CANARY_PROVINCE_IDS.has(f.id));
  const canaryFeatures = allFeatures.filter((f) => CANARY_PROVINCE_IDS.has(f.id));

  const points = (stations || [])
    .filter((s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lon) && Number.isFinite(s?.temperatureC))
    .map((s) => ({ lat: s.lat, lon: s.lon, value: s.temperatureC }));
  if (!points.length) return [];

  const images = [];
  for (const features of [mainlandFeatures, canaryFeatures]) {
    const image = buildRegionImage(features, points, createCanvas);
    if (image) images.push(image);
  }
  return images;
}
