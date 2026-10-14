#!/usr/bin/env node
/**
 * Build src/data/local_data/spain_transit/ign_rail.json: Spain's whole
 * railway network (mainline "train" lines: conventional, high-speed and
 * metre gauge) from the IGN's INSPIRE transport networks WFS, for the Rail
 * network layer's national context lines.
 *
 * Source: Instituto Geográfico Nacional — "Redes de transporte de España"
 *   https://servicios.idee.es/wfs-inspire/transportes (WFS 2.0, GML 3.2,
 *   EPSG:4258 with lat/lon axis order). Licence CC BY 4.0 (scne.es), cite
 *   "© Instituto Geográfico Nacional — SCNE".
 *
 * The WFS splits the network into ~60,000 `tn-ra:RailwayLink` pieces with
 * geometry only; `tn-ra:RailwayLine` groups links into lines, and
 * `tn-ra:RailwayType` gives each line its type (train, metro, tramway,
 * funicular, cogRailway). Links on no line are sidings and yards.
 *
 * Transform (deterministic for the same inputs):
 *   1. Keep the links of lines typed `train` (metro, tram and funiculars
 *      come from the operators' own data, or not at all).
 *   2. Chain links that meet end to end into longer paths (fewer, longer
 *      polylines draw faster than 20,000 short ones).
 *   3. Douglas–Peucker at 50 m (national-scale context; the Cercanías and
 *      FGC lines carry the street-scale detail), 4 decimals (~11 m), flat
 *      [lon, lat, …] paths, sorted for a stable diff.
 *   4. Split off the track shared with Cercanías / FGC lines (`lines.json`,
 *      build it first) into `shared[]`: see split-spain-rail-shared.mjs.
 *
 * Usage:
 *   node scripts/build-spain-rail-ign.mjs [--cache DIR]
 * Downloads ~25 pages of lines and the links tile by tile (the IGN proxy
 * times out on large pages and on deep paging; tens of minutes). With
 * --cache, pages are kept in DIR and reused.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { simplifyPath } from './build-spain-transit-network.mjs';

export const IGN_WFS =
  'https://servicios.idee.es/wfs-inspire/transportes?service=WFS&version=2.0.0&request=GetFeature';

/** Douglas–Peucker tolerance for the national network. */
export const IGN_TOLERANCE_M = 50;
const DECIMALS = 4;

const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'data',
  'local_data',
  'spain_transit',
  'ign_rail.json',
);

const round = (value) => Number(Number(value).toFixed(DECIMALS));

function members(xml, tag) {
  return String(xml || '')
    .split('<wfs:member>')
    .slice(1)
    .filter((member) => member.includes(`<${tag} `));
}

const gmlId = (member) => /gml:id="([^"]+)"/.exec(member)?.[1] ?? null;

/** Id at the end of an xlink:href (`…&ID=X#X` → `X`). */
const hrefId = (href) => /#([A-Za-z0-9_-]+)$/.exec(href)?.[1] ?? null;

/**
 * Line id → type ("train", "metro", …) from `tn-ra:RailwayType` features.
 * @param {string[]} pages
 * @returns {Map<string, string>}
 */
export function parseRailwayTypes(pages) {
  const types = new Map();
  for (const page of pages) {
    for (const member of members(page, 'tn-ra:RailwayType')) {
      const type = /RailwayTypeValue\/(\w+)"/.exec(member)?.[1];
      if (!type) continue;
      for (const [, href] of member.matchAll(
        /<net:element[^>]*xlink:href="([^"]+)"/g,
      )) {
        const id = hrefId(href);
        if (id) types.set(id, type);
      }
    }
  }
  return types;
}

/**
 * Line id → its link ids, from `tn-ra:RailwayLine` features.
 * @param {string[]} pages
 * @returns {Map<string, string[]>}
 */
export function parseRailwayLines(pages) {
  const lines = new Map();
  for (const page of pages) {
    for (const member of members(page, 'tn-ra:RailwayLine')) {
      const id = gmlId(member);
      if (!id) continue;
      const links = [];
      for (const [, href] of member.matchAll(
        /<net:link[^>]*xlink:href="([^"]+)"/g,
      )) {
        const link = hrefId(href);
        if (link) links.push(link);
      }
      lines.set(id, links);
    }
  }
  return lines;
}

/**
 * Link id → [[lon, lat], …] from `tn-ra:RailwayLink` features. The CRS is
 * EPSG:4258, whose axis order is latitude first.
 * @param {string[]} pages
 * @param {Set<string>|null} [keep] Only these link ids, when given.
 * @returns {Map<string, Array<[number, number]>>}
 */
export function parseRailwayLinks(pages, keep = null) {
  const links = new Map();
  for (const page of pages) {
    for (const member of members(page, 'tn-ra:RailwayLink')) {
      const id = gmlId(member);
      if (!id || (keep && !keep.has(id))) continue;
      const list = /<gml:posList[^>]*>([^<]+)<\/gml:posList>/.exec(member)?.[1];
      if (!list) continue;
      const numbers = list.trim().split(/\s+/).map(Number);
      const points = [];
      for (let i = 0; i + 1 < numbers.length; i += 2) {
        const lat = numbers[i];
        const lon = numbers[i + 1];
        if (Number.isFinite(lat) && Number.isFinite(lon))
          points.push([lon, lat]);
      }
      if (points.length >= 2) links.set(id, points);
    }
  }
  return links;
}

/**
 * Join paths that meet end to end (within rounding) into longer paths. A
 * junction where three or more paths meet ends every chain through it, so a
 * branch is never folded into the main line backwards.
 * @param {Array<Array<[number, number]>>} paths
 * @returns {Array<Array<[number, number]>>}
 */
export function chainPaths(paths) {
  const key = ([lon, lat]) => `${round(lon)},${round(lat)}`;
  /** @type {Map<string, number[]>} endpoint → path indices touching it */
  const ends = new Map();
  paths.forEach((path, index) => {
    for (const point of [path[0], path.at(-1)]) {
      const k = key(point);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push(index);
    }
  });
  const used = new Uint8Array(paths.length);
  const oriented = (index, fromKey) =>
    key(paths[index][0]) === fromKey
      ? paths[index]
      : [...paths[index]].reverse();
  const nextFrom = (k) => {
    const touching = ends.get(k) || [];
    if (touching.length !== 2) return -1; // dead end or junction
    return touching.find((index) => !used[index]) ?? -1;
  };
  const chains = [];
  const walk = (start, fromKey) => {
    let chain = oriented(start, fromKey);
    used[start] = 1;
    for (;;) {
      const tail = key(chain.at(-1));
      const next = nextFrom(tail);
      if (next < 0) break;
      used[next] = 1;
      chain = chain.concat(oriented(next, tail).slice(1));
    }
    return chain;
  };
  // Start from ends that are not plain pass-throughs, then sweep loops.
  for (const [k, touching] of ends) {
    if (touching.length === 2) continue;
    for (const index of touching) if (!used[index]) chains.push(walk(index, k));
  }
  paths.forEach((path, index) => {
    if (!used[index]) chains.push(walk(index, key(path[0])));
  });
  return chains;
}

/**
 * The bundled national network pack.
 * @param {{typePages: string[], linePages: string[], linkPages: string[],
 *   generated: string}} input
 */
export function buildIgnRailPack({
  typePages,
  linePages,
  linkPages,
  generated,
}) {
  const types = parseRailwayTypes(typePages);
  const lines = parseRailwayLines(linePages);
  const trainLinks = new Set();
  for (const [lineId, links] of lines) {
    if (types.get(lineId) !== 'train') continue;
    for (const link of links) trainLinks.add(link);
  }
  const links = parseRailwayLinks(linkPages, trainLinks);
  const paths = chainPaths([...links.values()])
    .map((points) => {
      const flat = [];
      for (const [lon, lat] of simplifyPath(points, IGN_TOLERANCE_M)) {
        const x = round(lon);
        const y = round(lat);
        if (flat.length && flat.at(-2) === x && flat.at(-1) === y) continue;
        flat.push(x, y);
      }
      return flat;
    })
    .filter((flat) => flat.length >= 4)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || b.length - a.length);
  return {
    meta: {
      script: 'scripts/build-spain-rail-ign.mjs',
      generated,
      source: 'IGN — Redes de transporte de España (INSPIRE WFS, tn-ra)',
      licence: 'CC BY 4.0 — © Instituto Geográfico Nacional — SCNE',
      format: 'paths[] = [lon, lat, lon, lat, …]',
      toleranceM: IGN_TOLERANCE_M,
      trainLines: [...lines.keys()].filter((id) => types.get(id) === 'train')
        .length,
      links: links.size,
    },
    paths,
  };
}

async function fetchPage(url, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      const text = await response.text();
      if (response.ok && text.includes('wfs:FeatureCollection')) return text;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
  }
  throw new Error(`${url}: ${lastError?.message || lastError}`);
}

/**
 * One page of `size` features from `start`, cached. A page the IGN proxy
 * times out on (it cuts at ~60 s; a few lines carry thousands of links) is
 * fetched again as two halves, down to single features.
 * @returns {Promise<string[]>} pages
 */
async function fetchRange(typeName, start, size, cacheDir) {
  const cached =
    cacheDir &&
    path.join(cacheDir, `${typeName.replace(':', '_')}-${start}-${size}.xml`);
  if (cached && fs.existsSync(cached)) return [fs.readFileSync(cached, 'utf8')];
  try {
    // A large page gets one try before it is split; single features three.
    const page = await fetchPage(
      `${IGN_WFS}&typeNames=${typeName}&count=${size}&startIndex=${start}`,
      size > 1 ? 1 : 3,
    );
    if (cached) fs.writeFileSync(cached, page);
    return [page];
  } catch (error) {
    if (size <= 1) {
      // One feature the proxy never answers in time: skip it, say so, and
      // keep the rest of the network.
      skipped.push(`${typeName}#${start}`);
      console.warn(`\nSkipped ${typeName} at ${start}: ${error.message}`);
      return [
        `<wfs:FeatureCollection numberReturned="1"></wfs:FeatureCollection>`,
      ];
    }
    const half = Math.ceil(size / 2);
    return [
      ...(await fetchRange(typeName, start, half, cacheDir)),
      ...(await fetchRange(typeName, start + half, size - half, cacheDir)),
    ];
  }
}

/** Features the IGN proxy never answered for, reported at the end. */
const skipped = [];

const returnedIn = (pages) =>
  pages.reduce(
    (sum, page) => sum + Number(/numberReturned="(\d+)"/.exec(page)?.[1] ?? 0),
    0,
  );

async function fetchAll(typeName, pageSize, cacheDir) {
  const pages = [];
  for (let start = 0; ; start += pageSize) {
    const range = await fetchRange(typeName, start, pageSize, cacheDir);
    pages.push(...range);
    const returned = returnedIn(range);
    process.stdout.write(`\r${typeName}: ${start + returned}`);
    if (returned < pageSize) break;
  }
  process.stdout.write('\n');
  return pages;
}

/** Features per tile request; a tile that fills it is split in four. */
const TILE_LIMIT = 3000;

/** Peninsula and the Balearic Islands, in 1° tiles (the Canaries have no railway). */
const SPAIN_TILES = (() => {
  const tiles = [];
  for (let lat = 35; lat < 44; lat += 1)
    for (let lon = -10; lon < 5; lon += 1)
      tiles.push([lat, lon, lat + 1, lon + 1]);
  return tiles;
})();

/**
 * Railway links by area. Deep `startIndex` paging times out on the IGN's
 * server past ~24,000 features, so the links are fetched tile by tile from
 * index 0, splitting any tile that fills a page (quadtree). Links that cross
 * a tile edge come back twice; parsing keys them by id.
 */
async function fetchLinksByTiles(cacheDir) {
  const pages = [];
  const queue = [...SPAIN_TILES];
  let requests = 0;
  while (queue.length) {
    const [s, w, n, e] = queue.shift();
    const name = `tn-ra_RailwayLink-bbox-${s}_${w}_${n}_${e}`;
    const cached = cacheDir && path.join(cacheDir, `${name}.xml`);
    let page;
    if (cached && fs.existsSync(cached)) page = fs.readFileSync(cached, 'utf8');
    else {
      page = await fetchPage(
        `${IGN_WFS}&typeNames=tn-ra:RailwayLink&count=${TILE_LIMIT}&bbox=${s},${w},${n},${e},urn:ogc:def:crs:EPSG::4258`,
      );
      if (cached) fs.writeFileSync(cached, page);
    }
    requests += 1;
    const returned = Number(/numberReturned="(\d+)"/.exec(page)?.[1] ?? 0);
    if (returned >= TILE_LIMIT) {
      const lat = (s + n) / 2,
        lon = (w + e) / 2;
      queue.push(
        [s, w, lat, lon],
        [s, lon, lat, e],
        [lat, w, n, lon],
        [lat, lon, n, e],
      );
      continue;
    }
    pages.push(page);
    process.stdout.write(
      `\rtn-ra:RailwayLink: ${requests} tiles, ${queue.length} queued`,
    );
  }
  process.stdout.write('\n');
  return pages;
}

async function main(argv) {
  const cacheIndex = argv.indexOf('--cache');
  const cacheDir = cacheIndex >= 0 ? argv[cacheIndex + 1] : null;
  if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true });
  const typePages = await fetchAll('tn-ra:RailwayType', 500, cacheDir);
  const linePages = await fetchAll('tn-ra:RailwayLine', 20, cacheDir);
  const linkPages = await fetchLinksByTiles(cacheDir);
  const { splitBundledIgnPack } = await import('./split-spain-rail-shared.mjs');
  const pack = splitBundledIgnPack(
    buildIgnRailPack({
      typePages,
      linePages,
      linkPages,
      generated: new Date().toISOString().slice(0, 10),
    }),
  );
  pack.meta.skipped = skipped;
  fs.writeFileSync(OUT, `${JSON.stringify(pack)}\n`);
  if (skipped.length)
    console.warn(`Skipped ${skipped.length} features: ${skipped.join(', ')}`);
  const all = [...pack.paths, ...pack.shared.flatMap((group) => group.paths)];
  const points = all.reduce((sum, p) => sum + p.length / 2, 0);
  console.log(
    `Wrote ${path.relative(process.cwd(), OUT)} (${fs.statSync(OUT).size} bytes): ${pack.meta.trainLines} train lines, ${pack.meta.links} links → ${all.length} paths (${pack.meta.shared.sharedKm} km shared), ${points} points`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
