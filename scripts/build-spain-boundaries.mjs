#!/usr/bin/env node
/**
 * Build src/data/local_data/spain_boundaries/provinces.json from Natural
 * Earth's 10m admin-1 states/provinces dataset, filtered to Spain.
 *
 * Source:  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson
 * License: Public domain (Natural Earth) — same source family already
 *          bundled in this repo for local_data/natural_earth/{regions,marine}.json.
 *
 * Replaces the previous click_that_hood-sourced comunidad-autónoma-level
 * pack (19 features): that source's raw major-boundary rings were already
 * ~96% preserved even at the old pack's simplification tolerance, so it had
 * no more real detail to give. Natural Earth's admin-1 layer is at PROVINCE
 * level for Spain (52 features: 50 provinces + Ceuta + Melilla) and carries
 * ~3.8x the vertex density on real (non-noise) rings — genuine added detail,
 * not interpolation.
 *
 * Transform (deterministic):
 *   1. Filter world features to `properties.admin === 'Spain'`.
 *   2. Outer rings only (holes dropped, matching the previous pack's
 *      convention — none of these boundaries meaningfully have any).
 *   3. Douglas-Peucker simplification per ring, tolerance 0.001° (~100 m) —
 *      light cleanup of redundant collinear points, not a resolution cut:
 *      the raw data is already close to its native resolution.
 *   4. Coordinates rounded to 4 decimals (~11 m); consecutive duplicates
 *      dropped; rings re-closed; rings that collapse below 4 points dropped
 *      (tiny islet/rock noise, indistinguishable from digitization noise at
 *      this tolerance — same call the previous pack's build made).
 *   5. Each feature keeps `id` (slugified `name`), `name` (as given by
 *      Natural Earth), `ccaaId`/`ccaaName` (slugified/raw `region` property
 *      — the parent comunidad autónoma, free from the source data), `rings`.
 *   6. Features sorted by `id` for a stable diff.
 *
 * Usage:
 *   node scripts/build-spain-boundaries.mjs [raw.geojson]
 * With no argument it downloads the live dataset; with an argument it reads
 * the given raw GeoJSON file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)),
  '..', 'src', 'data', 'local_data', 'spain_boundaries', 'provinces.json');
const TOLERANCE = 0.001; // degrees, ~100 m
const DECIMALS = 4;

/** Perpendicular distance from point p to segment a-b (in degrees, planar — fine at this scale). */
function segDist(p, a, b) {
  let [x, y] = p; const [x1, y1] = a; const [x2, y2] = b;
  let dx = x2 - x1; let dy = y2 - y1;
  if (dx !== 0 || dy !== 0) {
    const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x -= x2; y -= y2; return Math.hypot(x, y); }
    if (t > 0) { x -= x1 + dx * t; y -= y1 + dy * t; return Math.hypot(x, y); }
  }
  return Math.hypot(x - x1, y - y1);
}

/** Iterative Douglas-Peucker on an open point list. */
function douglasPeucker(points, tolerance) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = 0; let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segDist(points[i], points[first], points[last]);
      if (d > maxDist) { maxDist = d; index = i; }
    }
    if (maxDist > tolerance && index !== -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const round = (v) => Number(v.toFixed(DECIMALS));

/** Simplify + round one ring; returns null if it degenerates. */
function processRing(ring) {
  // GeoJSON rings are closed (first == last); simplify the open part.
  const open = ring.length > 1
    && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
    ? ring.slice(0, -1) : ring.slice();
  const simplified = douglasPeucker(open, TOLERANCE).map(([lon, lat]) => [round(lon), round(lat)]);
  const out = [];
  for (const pt of simplified) {
    const prev = out[out.length - 1];
    if (prev && prev[0] === pt[0] && prev[1] === pt[1]) continue;
    out.push(pt);
  }
  if (out.length < 4) return null;
  out.push([out[0][0], out[0][1]]); // re-close
  return out;
}

/** Same slugification convention as the previous pack's `id` field: lowercase, diacritics stripped, non-alphanumerics → '-'. */
function slug(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function outerRingsOf(feature) {
  const geom = feature.geometry;
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  return polys.map((poly) => poly[0]); // outer ring only, holes dropped
}

async function main() {
  let rawText;
  if (process.argv[2]) {
    rawText = fs.readFileSync(process.argv[2], 'utf8');
    console.log(`read ${process.argv[2]}`);
  } else {
    console.log(`fetching ${SOURCE_URL}`);
    const res = await fetch(SOURCE_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${SOURCE_URL}`);
    rawText = await res.text();
  }
  const raw = JSON.parse(rawText);
  if (raw.type !== 'FeatureCollection' || !Array.isArray(raw.features)) {
    throw new Error('unexpected payload: not a FeatureCollection');
  }

  const spainFeatures = raw.features.filter((f) => f.properties?.admin === 'Spain');
  if (spainFeatures.length < 50) throw new Error(`expected ~52 Spain features, got ${spainFeatures.length}`);

  let inVerts = 0; let outVerts = 0;
  const features = [];
  for (const f of spainFeatures) {
    const name = f.properties?.name;
    const region = f.properties?.region;
    if (!name || !region || !f.geometry) {
      throw new Error(`feature missing name/region/geometry: ${JSON.stringify(f.properties)}`);
    }
    const rings = [];
    for (const ring of outerRingsOf(f)) {
      inVerts += ring.length;
      const r = processRing(ring);
      if (r) { rings.push(r); outVerts += r.length; }
    }
    if (!rings.length) throw new Error(`geometry collapsed for ${name}`);
    features.push({ id: slug(name), name, ccaaId: slug(region), ccaaName: region, rings });
  }
  features.sort((a, b) => a.id.localeCompare(b.id));

  const out = {
    meta: {
      source: 'Natural Earth 10m admin-1 states/provinces (nvkelso/natural-earth-vector, public domain) — filtered to admin=Spain',
      description: 'Spain provincial boundaries (50 provinces + Ceuta + Melilla) with parent comunidad-autónoma, outer-ring only, Douglas-Peucker simplified',
      epsilonDeg: TOLERANCE,
      featureCount: features.length,
    },
    features,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(out)}\n`);
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`wrote ${OUT}: ${features.length} features, ${inVerts} → ${outVerts} vertices, ${kb} KB`);
}

main().catch((err) => { console.error(err); process.exit(1); });
