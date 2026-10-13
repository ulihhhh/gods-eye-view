/**
 * Track following for rail vehicles: given two reported positions of a
 * train and the track geometry it runs on, the path between them along the
 * track instead of the straight chord.
 *
 * Pure and dependency-free. The Transit layer asks it for every segment it
 * draws near the ground; when the two fixes do not both sit on one piece of
 * track (too far from it, different branches, or an implausible detour), it
 * answers null and the layer keeps the straight line it always drew.
 */

const M_PER_DEG = 111_320;

/** How far a fix may sit from the track and still be read as on it. */
export const TRACK_SNAP_MAX_M = 150;

/** Grid cell (degrees) for the segment index; ~1 km. */
const CELL_DEG = 0.01;

/**
 * A detour longer than this many times the straight distance (plus a fixed
 * allowance) is a wrong reading — a loop, a reversal, the other branch — not
 * the route the train took.
 */
const MAX_DETOUR_RATIO = 3;
const MAX_DETOUR_EXTRA_M = 500;

/**
 * Build a searchable index over track lines.
 * @param {Array<{routes?: string[]|null, paths: number[][]}>} lines Flat
 *   [lon, lat, …] paths; `routes` names the lines that run on them (null:
 *   any line, e.g. a national network without line names).
 * @returns {{paths: Array<{flat: number[], routes: Set<string>|null,
 *   cumulative: number[]}>, cells: Map<string, Array<[number, number]>>}}
 */
export function createTrackIndex(lines) {
  const paths = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const routes = Array.isArray(line?.routes)
      ? new Set(line.routes.map(String))
      : null;
    for (const flat of Array.isArray(line?.paths) ? line.paths : []) {
      if (!Array.isArray(flat) || flat.length < 4) continue;
      // Cumulative metres along the path, for arc-length positions.
      const cumulative = [0];
      for (let i = 2; i + 1 < flat.length; i += 2) {
        cumulative.push(
          cumulative.at(-1) +
            metres(flat[i - 2], flat[i - 1], flat[i], flat[i + 1]),
        );
      }
      paths.push({ flat, routes, cumulative });
    }
  }
  /** @type {Map<string, Array<[number, number]>>} cell → [pathIndex, segment] */
  const cells = new Map();
  paths.forEach((path, pathIndex) => {
    const { flat } = path;
    for (let s = 0; s + 3 < flat.length; s += 2) {
      const minX = Math.floor(Math.min(flat[s], flat[s + 2]) / CELL_DEG);
      const maxX = Math.floor(Math.max(flat[s], flat[s + 2]) / CELL_DEG);
      const minY = Math.floor(Math.min(flat[s + 1], flat[s + 3]) / CELL_DEG);
      const maxY = Math.floor(Math.max(flat[s + 1], flat[s + 3]) / CELL_DEG);
      for (let x = minX; x <= maxX; x++)
        for (let y = minY; y <= maxY; y++) {
          const key = `${x},${y}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push([pathIndex, s / 2]);
        }
    }
  });
  return { paths, cells };
}

function metres(lon1, lat1, lon2, lat2) {
  const cos = Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot((lon2 - lon1) * cos, lat2 - lat1) * M_PER_DEG;
}

/**
 * Nearest point of every candidate path to `point`, within the snap limit.
 * @returns {Map<number, {segment: number, t: number, distanceM: number, along: number}>}
 */
function projections(index, point, routeId) {
  const { lon, lat } = point;
  const reach = TRACK_SNAP_MAX_M / M_PER_DEG / Math.cos((lat * Math.PI) / 180);
  const best = new Map();
  const seen = new Set();
  const cos = Math.cos((lat * Math.PI) / 180);
  for (
    let x = Math.floor((lon - reach) / CELL_DEG);
    x <= Math.floor((lon + reach) / CELL_DEG);
    x++
  )
    for (
      let y = Math.floor((lat - reach) / CELL_DEG);
      y <= Math.floor((lat + reach) / CELL_DEG);
      y++
    ) {
      for (const [pathIndex, segment] of index.cells.get(`${x},${y}`) || []) {
        const key = pathIndex * 1e6 + segment;
        if (seen.has(key)) continue;
        seen.add(key);
        const path = index.paths[pathIndex];
        if (routeId && path.routes && !path.routes.has(routeId)) continue;
        const f = path.flat;
        const ax = f[segment * 2] * cos,
          ay = f[segment * 2 + 1],
          bx = f[segment * 2 + 2] * cos,
          by = f[segment * 2 + 3];
        const px = lon * cos,
          py = lat;
        const dx = bx - ax,
          dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2
          ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
          : 0;
        const distanceM =
          Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) * M_PER_DEG;
        if (distanceM > TRACK_SNAP_MAX_M) continue;
        const known = best.get(pathIndex);
        if (known && known.distanceM <= distanceM) continue;
        const along =
          path.cumulative[segment] +
          t * (path.cumulative[segment + 1] - path.cumulative[segment]);
        best.set(pathIndex, { segment, t, distanceM, along });
      }
    }
  return best;
}

/**
 * The path along the track from fix `a` to fix `b`, or null when no single
 * piece of track carries both (or the detour is implausible).
 * @param {ReturnType<typeof createTrackIndex>} index
 * @param {{lat: number, lon: number}} a
 * @param {{lat: number, lon: number}} b
 * @param {string|null} [routeId] Prefer track this line runs on; any track
 *   when the line is unknown or names no indexed path.
 * @returns {{lengthM: number, at: (fraction: number) => {lat: number, lon: number}}|null}
 */
export function pathBetween(index, a, b, routeId = null) {
  if (!index?.paths?.length) return null;
  const straight = metres(a.lon, a.lat, b.lon, b.lat);
  if (straight < 1) return null;
  const pick = (route) => {
    const fromA = projections(index, a, route);
    if (!fromA.size) return null;
    const fromB = projections(index, b, route);
    let choice = null;
    for (const [pathIndex, pa] of fromA) {
      const pb = fromB.get(pathIndex);
      if (!pb) continue;
      const lengthM = Math.abs(pb.along - pa.along);
      if (lengthM > straight * MAX_DETOUR_RATIO + MAX_DETOUR_EXTRA_M) continue;
      const score = pa.distanceM + pb.distanceM;
      if (!choice || score < choice.score)
        choice = { pathIndex, pa, pb, lengthM, score };
    }
    return choice;
  };
  const choice = (routeId && pick(String(routeId))) || pick(null);
  if (!choice || choice.lengthM < 1) return null;
  const path = index.paths[choice.pathIndex];
  const { pa, pb } = choice;
  const forward = pb.along >= pa.along;
  const f = path.flat;
  const pointAt = (segment, t) => [
    f[segment * 2] + (f[segment * 2 + 2] - f[segment * 2]) * t,
    f[segment * 2 + 1] + (f[segment * 2 + 3] - f[segment * 2 + 1]) * t,
  ];
  // The vertices strictly between the two projections, in travel order.
  const vertices = [pointAt(pa.segment, pa.t)];
  const along = [pa.along];
  if (forward) {
    for (let v = pa.segment + 1; v <= pb.segment; v++) {
      vertices.push([f[v * 2], f[v * 2 + 1]]);
      along.push(path.cumulative[v]);
    }
  } else {
    for (let v = pa.segment; v > pb.segment; v--) {
      vertices.push([f[v * 2], f[v * 2 + 1]]);
      along.push(path.cumulative[v]);
    }
  }
  vertices.push(pointAt(pb.segment, pb.t));
  along.push(pb.along);
  const start = along[0];
  const total = Math.abs(along.at(-1) - start);
  // The fixes sit up to TRACK_SNAP_MAX_M off the drawn track. Spread that
  // offset along the segment so the path keeps the track's shape but starts
  // and ends exactly at the reported positions: a train that stops, or a
  // straight segment that follows, then continues from the same point.
  const head = vertices[0];
  const tail = vertices.at(-1);
  const dLon0 = a.lon - head[0],
    dLat0 = a.lat - head[1],
    dLon1 = b.lon - tail[0],
    dLat1 = b.lat - tail[1];
  return {
    lengthM: total,
    at(fraction) {
      const clamped = Math.max(0, Math.min(1, fraction));
      const target = clamped * total;
      let lon = head[0],
        lat = head[1];
      for (let i = 1; i < vertices.length; i++) {
        const s0 = Math.abs(along[i - 1] - start);
        const s1 = Math.abs(along[i] - start);
        if (target <= s1 || i === vertices.length - 1) {
          const u = s1 > s0 ? Math.min(1, (target - s0) / (s1 - s0)) : 0;
          lon = vertices[i - 1][0] + (vertices[i][0] - vertices[i - 1][0]) * u;
          lat = vertices[i - 1][1] + (vertices[i][1] - vertices[i - 1][1]) * u;
          break;
        }
      }
      return {
        lon: lon + dLon0 * (1 - clamped) + dLon1 * clamped,
        lat: lat + dLat0 * (1 - clamped) + dLat1 * clamped,
      };
    },
  };
}
