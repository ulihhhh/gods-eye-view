#!/usr/bin/env node
/**
 * Build src/data/local_data/spain_transit/stations.json: the station
 * dictionary the Transit layer's Spanish feeds use to name stops, from the
 * operators' own open data.
 *
 * Sources (all CC BY 4.0):
 *   - Renfe Cercanías / Rodalies GTFS
 *     https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip
 *   - Renfe AV / LD / MD GTFS
 *     https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip
 *     (data.renfe.com — cite "Renfe Operadora", no endorsement implied)
 *   - FGC open data (dadesobertes.fgc.cat): `codigo-estaciones` (the station
 *     initials Geotren reports, "PC" → Pl. Catalunya) and `gtfs_stops` (for
 *     their coordinates).
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
 *
 * Usage:
 *   node scripts/build-spain-transit-network.mjs            # download
 *   node scripts/build-spain-transit-network.mjs --from DIR # DIR/cer.zip,
 *     DIR/av.zip, DIR/fgc/codigo-estaciones.json, DIR/fgc/gtfs_stops.json
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
});

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

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function stopsFromZip(buffer, label) {
  const files = readZipEntries(buffer, ['stops.txt'], ZIP_ENTRY_MAX_BYTES);
  const stops = files.get('stops.txt');
  if (!stops) throw new Error(`${label}: stops.txt missing from the GTFS zip`);
  return stops.toString('utf8');
}

async function main(argv) {
  const fromIndex = argv.indexOf('--from');
  const from = fromIndex >= 0 ? argv[fromIndex + 1] : null;
  const read = (file) => fs.readFileSync(path.join(from, file));
  const [cer, ld, codes, stops] = from
    ? [
        read('cer.zip'),
        read('av.zip'),
        read('fgc/codigo-estaciones.json'),
        read('fgc/gtfs_stops.json'),
      ]
    : await Promise.all([
        download(SOURCES.renfeCercanias),
        download(SOURCES.renfeLd),
        download(SOURCES.fgcStationCodes),
        download(SOURCES.fgcStops),
      ]);
  const pack = buildStationsPack({
    cercaniasStops: stopsFromZip(cer, 'Renfe Cercanías'),
    ldStops: stopsFromZip(ld, 'Renfe AV/LD/MD'),
    fgcCodes: JSON.parse(codes.toString('utf8')),
    fgcStops: JSON.parse(stops.toString('utf8')),
    generated: new Date().toISOString().slice(0, 10),
  });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, 'stations.json');
  fs.writeFileSync(out, `${JSON.stringify(pack)}\n`);
  const counts = Object.entries(pack.networks)
    .map(([network, entries]) => `${network} ${Object.keys(entries).length}`)
    .join(', ');
  console.log(
    `Wrote ${path.relative(process.cwd(), out)} (${fs.statSync(out).size} bytes): ${counts}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
