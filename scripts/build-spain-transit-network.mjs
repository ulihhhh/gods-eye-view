#!/usr/bin/env node
/**
 * Build the Spain transit network packs in src/data/local_data/spain_transit/
 * from the operators' own open data:
 *   - stations.json — the station dictionary the Transit layer's Spanish
 *     feeds use to name stops;
 *   - lines.json — Cercanías / Rodalies and FGC line geometry with the
 *     operators' line colours, for the Rail network layer.
 *
 * Sources (all CC BY 4.0):
 *   - Renfe Cercanías / Rodalies GTFS
 *     https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip
 *   - Renfe AV / LD / MD GTFS
 *     https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip
 *     (data.renfe.com — cite "Renfe Operadora", no endorsement implied)
 *   - FGC open data (dadesobertes.fgc.cat): `codigo-estaciones` (the station
 *     initials Geotren reports, "PC" → Pl. Catalunya), `gtfs_stops` (for
 *     their coordinates) and `gtfs_routes` (each line's geometry and colour).
 *
 * Transform (deterministic for the same inputs):
 *   1. Renfe: stops.txt → `{stop_id: [name, lat, lon]}` per network. Ids are
 *      the five-digit station codes the GTFS-Realtime feeds report; names are
 *      trimmed and their inner spaces collapsed (the Cercanías file pads its
 *      columns, FGC doubles a few).
 *   2. FGC: initials → `[name, lat, lon]`, coordinates from the first GTFS stop
 *      whose id is those initials plus an optional platform digit (bus stops
 *      skipped). Initials with no GTFS stop keep their name only.
 *   3. Coordinates rounded to 5 decimals (~1 m); keys sorted for a stable diff.
 *   4. Lines: Cercanías shapes.txt, one direction per line (the `_INV`
 *      shapes run the same track back), coloured from routes.txt (the most
 *      common colour where a line has two); FGC lines from `gtfs_routes`,
 *      bus and shapeless routes dropped, lines sharing one geometry merged
 *      ("R5 · R50"). Every path simplified with Douglas–Peucker at 10 m and
 *      stored flat as [lon, lat, lon, lat, …].
 *
 * Usage:
 *   node scripts/build-spain-transit-network.mjs            # download
 *   node scripts/build-spain-transit-network.mjs --from DIR # DIR/cer.zip,
 *     DIR/av.zip, DIR/fgc/{codigo-estaciones,gtfs_stops,gtfs_routes}.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseCsv } from '../src/data/gtfsCsv.js';
import { readZipEntries } from '../server/providers/amb.js';

export const SOURCES = Object.freeze({
  renfeCercanias:
    'https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip',
  renfeLd: 'https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip',
  fgcStationCodes:
    'https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets/codigo-estaciones/exports/json',
  fgcStops:
    'https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets/gtfs_stops/exports/json',
  fgcRoutes:
    'https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets/gtfs_routes/exports/json',
});

/** Douglas–Peucker tolerance for line geometry. */
export const LINE_TOLERANCE_M = 10;

const OUT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'data',
  'local_data',
  'spain_transit',
);
const ZIP_ENTRY_MAX_BYTES = 64 * 1024 * 1024;
const DECIMALS = 5;

const round = (value) => Number(Number(value).toFixed(DECIMALS));

/** Trimmed, with runs of spaces collapsed ("Terrassa  Estació del nord"). */
const cleanName = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim();

function validPoint(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

function sortedObject(entries) {
  return Object.fromEntries(
    [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/**
 * Renfe stops.txt → `{id: [name, lat, lon]}`.
 * @param {string} stopsCsv
 * @returns {Record<string, [string, number, number]>}
 */
export function buildRenfeStations(stopsCsv) {
  const stations = new Map();
  for (const row of parseCsv(stopsCsv)) {
    const id = String(row.stop_id || '').trim();
    const name = cleanName(row.stop_name);
    const latText = String(row.stop_lat || '').trim();
    const lonText = String(row.stop_lon || '').trim();
    const lat = latText ? Number(latText) : NaN;
    const lon = lonText ? Number(lonText) : NaN;
    if (!/^\d{1,8}$/.test(id) || !name || !validPoint(lat, lon)) continue;
    if (!stations.has(id)) stations.set(id, [name, round(lat), round(lon)]);
  }
  return sortedObject(stations);
}

/**
 * FGC station initials → `[name, lat, lon]` (or `[name]` without a point).
 * @param {Array<{inicials?: string, nom_estacio?: string}>} codes
 * @param {Array<{stop_id?: string, stop_coordinates?: {lat: number, lon: number}}>} stops
 * @returns {Record<string, [string, number, number]|[string]>}
 */
export function buildFgcStations(codes, stops) {
  const points = new Map();
  for (const stop of Array.isArray(stops) ? stops : []) {
    const match = /^([A-Z][A-Z0-9]{0,3}?)(\d?)$/.exec(
      String(stop?.stop_id || ''),
    );
    const lat = Number(stop?.stop_coordinates?.lat);
    const lon = Number(stop?.stop_coordinates?.lon);
    if (!match || !validPoint(lat, lon)) continue;
    if (!points.has(match[1])) points.set(match[1], [round(lat), round(lon)]);
  }
  const stations = new Map();
  for (const code of Array.isArray(codes) ? codes : []) {
    const initials = String(code?.inicials || '').trim();
    const name = cleanName(code?.nom_estacio);
    if (!/^[A-Z][A-Z0-9]{0,3}$/.test(initials) || !name) continue;
    if (stations.has(initials)) continue;
    const point = points.get(initials);
    stations.set(initials, point ? [name, ...point] : [name]);
  }
  return sortedObject(stations);
}

/**
 * The bundled pack: one dictionary per network the Transit feeds name.
 * @param {{cercaniasStops: string, ldStops: string, fgcCodes: object[],
 *   fgcStops: object[], generated: string}} input
 */
export function buildStationsPack({
  cercaniasStops,
  ldStops,
  fgcCodes,
  fgcStops,
  generated,
}) {
  return {
    meta: {
      script: 'scripts/build-spain-transit-network.mjs',
      generated,
      format:
        'networks.<network>.<stopId> = [name, lat, lon] (lat/lon may be absent)',
      licence:
        'CC BY 4.0 — Renfe Operadora (data.renfe.com), FGC (dadesobertes.fgc.cat)',
    },
    networks: {
      'renfe-cercanias': buildRenfeStations(cercaniasStops),
      'renfe-ld': buildRenfeStations(ldStops),
      fgc: buildFgcStations(fgcCodes, fgcStops),
    },
  };
}

const METRES_PER_DEGREE = 111_320;

/** Perpendicular distance (m) from p to segment a–b, local equirectangular. */
function segmentDistanceM(p, a, b, cosLat) {
  const ax = a[0] * cosLat;
  const bx = b[0] * cosLat;
  const px = p[0] * cosLat;
  const dx = bx - ax;
  const dy = b[1] - a[1];
  let t = 0;
  if (dx !== 0 || dy !== 0)
    t = Math.max(
      0,
      Math.min(1, ((px - ax) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)),
    );
  return (
    Math.hypot(px - (ax + t * dx), p[1] - (a[1] + t * dy)) * METRES_PER_DEGREE
  );
}

/**
 * Douglas–Peucker on [lon, lat] points (iterative, so a long line cannot
 * overflow the stack). Endpoints always kept.
 * @param {Array<[number, number]>} points
 * @param {number} toleranceM
 * @returns {Array<[number, number]>}
 */
export function simplifyPath(points, toleranceM = LINE_TOLERANCE_M) {
  if (points.length <= 2) return points.slice();
  const cosLat = Math.cos(
    (points.reduce((sum, p) => sum + p[1], 0) / points.length) *
      (Math.PI / 180),
  );
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let farthest = -1;
    let distance = toleranceM;
    for (let i = first + 1; i < last; i += 1) {
      const d = segmentDistanceM(
        points[i],
        points[first],
        points[last],
        cosLat,
      );
      if (d > distance) {
        distance = d;
        farthest = i;
      }
    }
    if (farthest >= 0) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Simplified, rounded, flat [lon, lat, …]; consecutive duplicates dropped. */
function flatPath(points) {
  const flat = [];
  for (const [lon, lat] of simplifyPath(points)) {
    const x = round(lon);
    const y = round(lat);
    if (flat.length && flat.at(-2) === x && flat.at(-1) === y) continue;
    flat.push(x, y);
  }
  return flat.length >= 4 ? flat : null;
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return (
    [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ??
    null
  );
}

const HEX_COLOUR = /^[0-9A-F]{6}$/;

/**
 * Cercanías / Rodalies lines from the GTFS shapes, one direction each.
 * @param {string} shapesCsv
 * @param {string} routesCsv
 * @returns {Array<{network: string, group: string, line: string,
 *   color: string|null, mode: string, paths: number[][]}>}
 */
export function buildCercaniasLines(shapesCsv, routesCsv) {
  const colours = new Map();
  for (const row of parseCsv(routesCsv)) {
    const group = String(row.route_id || '')
      .trim()
      .slice(0, 2);
    const line = String(row.route_short_name || '').trim();
    const colour = String(row.route_color || '')
      .trim()
      .toUpperCase();
    if (!/^\d{2}$/.test(group) || !line || !HEX_COLOUR.test(colour)) continue;
    const key = `${group}_${line}`;
    if (!colours.has(key)) colours.set(key, []);
    colours.get(key).push(colour);
  }
  const shapes = new Map();
  for (const row of parseCsv(shapesCsv)) {
    const id = String(row.shape_id || '').trim();
    if (!/^\d{2}_[A-Za-z0-9]+$/.test(id)) continue; // `_INV` and odd ids
    const lat = Number(row.shape_pt_lat);
    const lon = Number(row.shape_pt_lon);
    const sequence = Number(row.shape_pt_sequence);
    if (!validPoint(lat, lon) || !Number.isFinite(sequence)) continue;
    if (!shapes.has(id)) shapes.set(id, []);
    shapes.get(id).push([sequence, lon, lat]);
  }
  const lines = [];
  for (const [id, raw] of [...shapes].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [group, line] = id.split('_');
    raw.sort((a, b) => a[0] - b[0]);
    const path = flatPath(raw.map(([, lon, lat]) => [lon, lat]));
    if (!path) continue;
    lines.push({
      network: 'renfe-cercanias',
      group,
      line,
      color: mostCommon(colours.get(id) || []),
      mode: 'rail',
      paths: [path],
    });
  }
  return lines;
}

const FGC_MODES = Object.freeze({
  Subway: 'subway',
  Rail: 'rail',
  Funicular: 'funicular',
});

/**
 * FGC lines from the `gtfs_routes` export, which carries each line's
 * MultiLineString. Lines that share one geometry are merged.
 * @param {object[]} routes
 */
export function buildFgcLines(routes) {
  const byGeometry = new Map();
  for (const route of Array.isArray(routes) ? routes : []) {
    const mode = FGC_MODES[route?.route_type];
    const line = String(
      route?.route_short_name || route?.route_id || '',
    ).trim();
    const geometry = route?.shape?.geometry;
    if (!mode || !line || geometry?.type !== 'MultiLineString') continue;
    const paths = (geometry.coordinates || [])
      .map((part) =>
        flatPath(
          (Array.isArray(part) ? part : [])
            .map(([lon, lat]) => [Number(lon), Number(lat)])
            .filter(([lon, lat]) => validPoint(lat, lon)),
        ),
      )
      .filter(Boolean);
    if (!paths.length) continue;
    const key = JSON.stringify(paths);
    const colour = String(route.route_color || '')
      .trim()
      .toUpperCase();
    const known = byGeometry.get(key);
    if (known) {
      known.line = `${known.line} · ${line}`;
      continue;
    }
    byGeometry.set(key, {
      network: 'fgc',
      group: 'fgc',
      line,
      color: HEX_COLOUR.test(colour) && colour !== '000000' ? colour : null,
      mode,
      paths,
    });
  }
  return [...byGeometry.values()];
}

/** The bundled lines pack. */
export function buildLinesPack({
  cercaniasShapes,
  cercaniasRoutes,
  fgcRoutes,
  generated,
}) {
  return {
    meta: {
      script: 'scripts/build-spain-transit-network.mjs',
      generated,
      format:
        'lines[] = {network, group (Cercanías núcleo or "fgc"), line, color, mode, paths: [[lon, lat, lon, lat, …]]}',
      toleranceM: LINE_TOLERANCE_M,
      licence:
        'CC BY 4.0 — Renfe Operadora (data.renfe.com), FGC (dadesobertes.fgc.cat)',
    },
    lines: [
      ...buildCercaniasLines(cercaniasShapes, cercaniasRoutes),
      ...buildFgcLines(fgcRoutes),
    ],
  };
}

/** How close a line must pass to count as serving a station. */
export const STATION_LINE_MAX_M = 80;

/**
 * Which drawn lines serve each station, by geometry: a line serves a station
 * when its track passes within STATION_LINE_MAX_M of it. (The GTFS says so
 * through stop_times, a quarter-gigabyte file; the track says it too.)
 * @param {{networks: Record<string, Record<string, Array>>}} stationsPack
 * @param {Array<{network: string, paths: number[][]}>} lines
 * @returns {Record<string, Record<string, number[]>>} network → stopId →
 *   indices into `lines`
 */
export function assignStationLines(stationsPack, lines) {
  const result = {};
  for (const network of ['renfe-cercanias', 'fgc']) {
    const byStation = {};
    const stations = stationsPack?.networks?.[network] || {};
    const candidates = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.network === network);
    for (const [id, entry] of Object.entries(stations)) {
      const [, lat, lon] = entry;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const cosLat = Math.cos((lat * Math.PI) / 180);
      const p = [lon, lat];
      const served = [];
      for (const { line, index } of candidates) {
        let near = false;
        for (const path of line.paths) {
          for (let i = 0; i + 3 < path.length && !near; i += 2) {
            // Cheap reject before the exact distance.
            if (
              Math.abs(path[i + 1] - lat) > 0.01 &&
              Math.abs(path[i + 3] - lat) > 0.01
            )
              continue;
            near =
              segmentDistanceM(
                p,
                [path[i], path[i + 1]],
                [path[i + 2], path[i + 3]],
                cosLat,
              ) <= STATION_LINE_MAX_M;
          }
          if (near) break;
        }
        if (near) served.push(index);
      }
      if (served.length) byStation[id] = served;
    }
    result[network] = byStation;
  }
  return result;
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function filesFromZip(buffer, names, label) {
  const files = readZipEntries(buffer, names, ZIP_ENTRY_MAX_BYTES);
  return names.map((name) => {
    const file = files.get(name);
    if (!file) throw new Error(`${label}: ${name} missing from the GTFS zip`);
    return file.toString('utf8');
  });
}

async function main(argv) {
  const fromIndex = argv.indexOf('--from');
  const from = fromIndex >= 0 ? argv[fromIndex + 1] : null;
  const read = (file) => fs.readFileSync(path.join(from, file));
  const [cer, ld, codes, stops, fgcRoutes] = from
    ? [
        read('cer.zip'),
        read('av.zip'),
        read('fgc/codigo-estaciones.json'),
        read('fgc/gtfs_stops.json'),
        read('fgc/gtfs_routes.json'),
      ]
    : await Promise.all([
        download(SOURCES.renfeCercanias),
        download(SOURCES.renfeLd),
        download(SOURCES.fgcStationCodes),
        download(SOURCES.fgcStops),
        download(SOURCES.fgcRoutes),
      ]);
  const generated = new Date().toISOString().slice(0, 10);
  const [cerStops, cerShapes, cerRoutes] = filesFromZip(
    cer,
    ['stops.txt', 'shapes.txt', 'routes.txt'],
    'Renfe Cercanías',
  );
  const [ldStops] = filesFromZip(ld, ['stops.txt'], 'Renfe AV/LD/MD');
  const stations = buildStationsPack({
    cercaniasStops: cerStops,
    ldStops,
    fgcCodes: JSON.parse(codes.toString('utf8')),
    fgcStops: JSON.parse(stops.toString('utf8')),
    generated,
  });
  const lines = buildLinesPack({
    cercaniasShapes: cerShapes,
    cercaniasRoutes: cerRoutes,
    fgcRoutes: JSON.parse(fgcRoutes.toString('utf8')),
    generated,
  });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const write = (name, pack, summary) => {
    const out = path.join(OUT_DIR, name);
    fs.writeFileSync(out, `${JSON.stringify(pack)}\n`);
    console.log(
      `Wrote ${path.relative(process.cwd(), out)} (${fs.statSync(out).size} bytes): ${summary}`,
    );
  };
  write(
    'stations.json',
    stations,
    Object.entries(stations.networks)
      .map(([network, entries]) => `${network} ${Object.keys(entries).length}`)
      .join(', '),
  );
  const points = lines.lines.reduce(
    (sum, line) => sum + line.paths.reduce((n, p) => n + p.length / 2, 0),
    0,
  );
  lines.stationLines = assignStationLines(stations, lines.lines);
  lines.meta.stationLines = `network.<stopId> = [line indices], lines within ${STATION_LINE_MAX_M} m`;
  const served = Object.values(lines.stationLines).reduce(
    (sum, byStation) => sum + Object.keys(byStation).length,
    0,
  );
  write(
    'lines.json',
    lines,
    `${lines.lines.length} lines, ${points} points, ${served} stations on a line`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
