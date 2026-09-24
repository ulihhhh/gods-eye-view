/**
 * Inverse-Distance-Weighting (IDW) interpolation for the AEMET temperature
 * gradient overlay — a pure grid-math module (no Cesium, no DOM, node
 * testable). `temperatureGradientRaster.js` turns the grid this produces
 * into a canvas texture; this module only knows about numbers.
 *
 * ~854 AEMET stations is few enough that a naive "every cell against every
 * station" pass is not actually slow (single-digit milliseconds even at a
 * few hundred cells per side), but a uniform hash-grid neighbor search is
 * used anyway so `maxNeighbors` genuinely limits how many stations influence
 * a cell (both for performance headroom and so one, say, mountain station
 * doesn't smear influence across the whole grid) rather than just capping
 * the count after computing every distance regardless.
 */

/** @typedef {{lat: number, lon: number, value: number}} InterpolationPoint */

const DEFAULT_POWER = 2;
const DEFAULT_MAX_NEIGHBORS = 12;
/** Ring-search cap: how many hash-grid rings to expand outward before giving up on a cell (→ NaN, transparent). */
const MAX_SEARCH_RINGS = 8;

/**
 * Uniform hash grid over a set of points, for fast "nearest few" queries.
 * Cell size is chosen so an average cell holds a handful of points.
 */
function buildHashGrid(points, cellSizeDeg) {
  const cells = new Map();
  const key = (cx, cy) => `${cx},${cy}`;
  for (const point of points) {
    const cx = Math.floor(point.lon / cellSizeDeg);
    const cy = Math.floor(point.lat / cellSizeDeg);
    const k = key(cx, cy);
    let bucket = cells.get(k);
    if (!bucket) {
      bucket = [];
      cells.set(k, bucket);
    }
    bucket.push(point);
  }
  return { cells, cellSizeDeg, key };
}

/**
 * Collect up to `maxNeighbors` points nearest to `(lon, lat)` by expanding a
 * ring of hash-grid cells outward until enough candidates are found (or
 * `MAX_SEARCH_RINGS` is exhausted). Returns `[]` when nothing is found within
 * range — the caller treats that as "no data for this cell".
 */
function findNearestNeighbors(hashGrid, lon, lat, maxNeighbors) {
  const { cells, cellSizeDeg, key } = hashGrid;
  const cx = Math.floor(lon / cellSizeDeg);
  const cy = Math.floor(lat / cellSizeDeg);
  const candidates = [];
  for (let ring = 0; ring <= MAX_SEARCH_RINGS; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        // Only the outermost shell of this ring — inner cells were already
        // collected by a smaller ring.
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const bucket = cells.get(key(cx + dx, cy + dy));
        if (bucket) candidates.push(...bucket);
      }
    }
    // One extra ring past "enough candidates" so a neighbor just outside the
    // current shell but closer than one still inside isn't missed.
    if (candidates.length >= maxNeighbors && ring > 0) break;
  }
  if (!candidates.length) return [];
  for (const point of candidates) {
    const dLon = point.lon - lon;
    const dLat = point.lat - lat;
    point._d2 = dLon * dLon + dLat * dLat;
  }
  candidates.sort((a, b) => a._d2 - b._d2);
  return candidates.slice(0, maxNeighbors);
}

/**
 * Classic IDW: `Σ(value_i / d_i^power) / Σ(1 / d_i^power)`. A neighbor
 * exactly at the query point returns its own value directly (avoids a
 * divide-by-zero blow-up).
 */
function idwAt(neighbors, power) {
  for (const n of neighbors) {
    if (n._d2 === 0) return n.value;
  }
  let weightedSum = 0;
  let weightSum = 0;
  for (const n of neighbors) {
    const w = 1 / n._d2 ** (power / 2);
    weightedSum += n.value * w;
    weightSum += w;
  }
  return weightSum > 0 ? weightedSum / weightSum : NaN;
}

/**
 * Build a regular `cellsX × cellsY` grid of IDW-interpolated values over
 * `bbox`, from a sparse set of `points`.
 *
 * @param {InterpolationPoint[]} points Station readings — non-finite `value`s are dropped.
 * @param {[number, number, number, number]} bbox `[west, south, east, north]`.
 * @param {object} [options]
 * @param {number} [options.cellsX=160]
 * @param {number} [options.cellsY]     Defaults to preserving bbox aspect ratio against cellsX.
 * @param {number} [options.power=2]
 * @param {number} [options.maxNeighbors=12]
 * @returns {{values: Float32Array, cellsX: number, cellsY: number, bbox: number[]}}
 *   `values` is row-major, top-to-bottom (row 0 = north edge), left-to-right
 *   — the same orientation a canvas's pixel buffer uses. `NaN` marks a cell
 *   with no nearby station data.
 */
export function buildIdwGrid(
  points,
  bbox,
  {
    cellsX = 160,
    cellsY = null,
    power = DEFAULT_POWER,
    maxNeighbors = DEFAULT_MAX_NEIGHBORS,
  } = {},
) {
  const [west, south, east, north] = bbox;
  const width = east - west;
  const height = north - south;
  const resolvedCellsY =
    cellsY ?? Math.max(1, Math.round(cellsX * (height / width)));

  const clean = points.filter(
    (p) =>
      Number.isFinite(p.lat) &&
      Number.isFinite(p.lon) &&
      Number.isFinite(p.value),
  );
  const values = new Float32Array(cellsX * resolvedCellsY).fill(NaN);
  if (!clean.length) return { values, cellsX, cellsY: resolvedCellsY, bbox };

  // Cell size tuned so a bucket holds a handful of stations on average —
  // dense enough to keep ring searches cheap, coarse enough that most
  // queries resolve within ring 0-1.
  const area = Math.max(width * height, 1e-6);
  const cellSizeDeg = Math.max(0.05, Math.sqrt((area * 6) / clean.length));
  const hashGrid = buildHashGrid(clean, cellSizeDeg);

  for (let row = 0; row < resolvedCellsY; row++) {
    const lat = north - ((row + 0.5) / resolvedCellsY) * height;
    for (let col = 0; col < cellsX; col++) {
      const lon = west + ((col + 0.5) / cellsX) * width;
      const neighbors = findNearestNeighbors(hashGrid, lon, lat, maxNeighbors);
      if (neighbors.length)
        values[row * cellsX + col] = idwAt(neighbors, power);
    }
  }

  return { values, cellsX, cellsY: resolvedCellsY, bbox };
}
