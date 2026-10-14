#!/usr/bin/env node
/**
 * Split the IGN national network (`ign_rail.json`) into the track only it
 * draws and the track it shares with a Cercanías / Rodalies or FGC line
 * (`lines.json`), so the Rail network layer can draw shared track once, in
 * the operator's colour, and bring the grey back only where that operator's
 * pill is off.
 *
 * The two packs never coincide to the metre (the IGN is simplified at 50 m,
 * the operators' lines at 10 m), so "shared" means: within SHARED_MAX_M of
 * an operator line for a sustained run of at least SHARED_MIN_RUN_M. Shorter
 * runs are crossings and stay exclusive; short gaps between shared runs are
 * closed so a shared stretch does not leave grey stubs.
 *
 * Output (written back into ign_rail.json, deterministic for the same
 * inputs):
 *   paths[]  = track only the IGN draws (flat [lon, lat, …], as before)
 *   shared[] = {networks: ['renfe-cercanias' | 'fgc', …], paths: [...]},
 *              the track within reach of those operators' lines
 *
 * Usage:
 *   node scripts/split-spain-rail-shared.mjs
 * Rerunnable: the current pack's exclusive and shared paths are chained back
 * together first. `build-spain-rail-ign.mjs` runs the same split.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chainPaths, IGN_TOLERANCE_M } from './build-spain-rail-ign.mjs';
import { simplifyPath } from './build-spain-transit-network.mjs';

/** How close the IGN track must sit to an operator line to share it. */
export const SHARED_MAX_M = 70;
/** A shared stretch shorter than this is a crossing, not shared track. */
export const SHARED_MIN_RUN_M = 200;
/** An exclusive gap shorter than this between shared stretches is closed. */
export const SHARED_MAX_GAP_M = 150;
/** Sample spacing along the IGN track. */
const STEP_M = 20;
const DECIMALS = 4;

const M_PER_DEG = 111_320;
const CELL_DEG = 0.01;

const DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'data',
  'local_data',
  'spain_transit',
);
const IGN_PACK = path.join(DIR, 'ign_rail.json');
const LINES_PACK = path.join(DIR, 'lines.json');

const round = (value) => Number(Number(value).toFixed(DECIMALS));

/** Metres east/north of a reference latitude, for short distances. */
function toLocal(lon, lat, cos) {
  return [lon * cos * M_PER_DEG, lat * M_PER_DEG];
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const length2 = dx * dx + dy * dy;
  const t =
    length2 > 0
      ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2))
      : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Grid index over operator line segments.
 * @param {Array<{network: string, paths: number[][]}>} lines
 */
export function createOperatorIndex(lines) {
  /** @type {Map<string, Array<[number[], number, string]>>} */
  const cells = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    if (!line?.network) continue;
    for (const flat of Array.isArray(line.paths) ? line.paths : []) {
      for (let s = 0; s + 3 < flat.length; s += 2) {
        const minX = Math.floor(Math.min(flat[s], flat[s + 2]) / CELL_DEG);
        const maxX = Math.floor(Math.max(flat[s], flat[s + 2]) / CELL_DEG);
        const minY = Math.floor(Math.min(flat[s + 1], flat[s + 3]) / CELL_DEG);
        const maxY = Math.floor(Math.max(flat[s + 1], flat[s + 3]) / CELL_DEG);
        for (let x = minX; x <= maxX; x++)
          for (let y = minY; y <= maxY; y++) {
            const key = `${x},${y}`;
            if (!cells.has(key)) cells.set(key, []);
            cells.get(key).push([flat, s, line.network]);
          }
      }
    }
  }
  return cells;
}

/** Networks with a line within `maxM` of a point. */
function networksNear(cells, lon, lat, maxM) {
  const cos = Math.cos((lat * Math.PI) / 180);
  const [px, py] = toLocal(lon, lat, cos);
  const cx = Math.floor(lon / CELL_DEG);
  const cy = Math.floor(lat / CELL_DEG);
  const near = new Set();
  for (let x = cx - 1; x <= cx + 1; x++)
    for (let y = cy - 1; y <= cy + 1; y++)
      for (const [flat, s, network] of cells.get(`${x},${y}`) || []) {
        if (near.has(network)) continue;
        const [ax, ay] = toLocal(flat[s], flat[s + 1], cos);
        const [bx, by] = toLocal(flat[s + 2], flat[s + 3], cos);
        if (segmentDistance(px, py, ax, ay, bx, by) <= maxM) near.add(network);
      }
  return near;
}

const metres = (lon1, lat1, lon2, lat2) =>
  Math.hypot(
    (lon2 - lon1) * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180),
    lat2 - lat1,
  ) * M_PER_DEG;

/**
 * Samples along a flat path, every STEP_M or closer, vertices included:
 * {lon, lat, s (metres along), seg (segment the sample lies on)}.
 */
function samplePath(flat) {
  const samples = [];
  let along = 0;
  for (let i = 0; i + 3 < flat.length; i += 2) {
    const [lon1, lat1, lon2, lat2] = flat.slice(i, i + 4);
    const length = metres(lon1, lat1, lon2, lat2);
    const steps = Math.max(1, Math.ceil(length / STEP_M));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      samples.push({
        lon: lon1 + (lon2 - lon1) * t,
        lat: lat1 + (lat2 - lat1) * t,
        s: along + length * t,
        seg: i / 2,
      });
    }
    along += length;
  }
  // The end, as the last vertex (a segment index past the last segment).
  samples.push({
    lon: flat.at(-2),
    lat: flat.at(-1),
    s: along,
    seg: flat.length / 2 - 1,
  });
  return samples;
}

/**
 * Runs of equal labels: [{label, from, to}] over sample indices (inclusive).
 */
function runsOf(labels) {
  const runs = [];
  labels.forEach((label, index) => {
    if (runs.length && runs.at(-1).label === label) runs.at(-1).to = index;
    else runs.push({ label, from: index, to: index });
  });
  return runs;
}

/**
 * Per-sample labels: '' for exclusive track, otherwise the sorted networks
 * (joined with ',') the sample is shared with, after dropping short shared
 * runs and closing short gaps.
 */
function sharedLabels(samples, near, { minRunM, maxGapM }) {
  const length = (run) => samples[run.to].s - samples[run.from].s;
  let shared = near.map((set) => set.size > 0);
  // Close short exclusive gaps between shared stretches, then drop short
  // shared stretches (crossings, junction throats).
  for (const run of runsOf(shared))
    if (
      !run.label &&
      run.from > 0 &&
      run.to < samples.length - 1 &&
      length(run) < maxGapM
    )
      for (let i = run.from; i <= run.to; i++) shared[i] = true;
  for (const run of runsOf(shared))
    if (run.label && length(run) < minRunM)
      for (let i = run.from; i <= run.to; i++) shared[i] = false;
  // Within a shared stretch, the networks it is shared with: those near for
  // at least SHARED_MIN_RUN_M of it (a brief brush with another operator's
  // line does not hide the grey from that operator's pill too).
  const labels = new Array(samples.length).fill('');
  for (const run of runsOf(shared)) {
    if (!run.label) continue;
    const metresNear = new Map();
    for (let i = run.from; i < run.to; i++)
      for (const network of near[i])
        metresNear.set(
          network,
          (metresNear.get(network) || 0) + samples[i + 1].s - samples[i].s,
        );
    const networks = [...metresNear]
      .filter(([, m]) => m >= Math.min(minRunM, length(run) / 2))
      .map(([network]) => network)
      .sort();
    const label = networks.length
      ? networks.join(',')
      : [...metresNear].sort((a, b) => b[1] - a[1])[0][0];
    for (let i = run.from; i <= run.to; i++) labels[i] = label;
  }
  return labels;
}

/** The flat path from sample `from` to sample `to`, original vertices kept. */
function slicePath(flat, samples, from, to) {
  const points = [[samples[from].lon, samples[from].lat]];
  for (let v = samples[from].seg + 1; v <= samples[to].seg; v++)
    points.push([flat[v * 2], flat[v * 2 + 1]]);
  points.push([samples[to].lon, samples[to].lat]);
  const out = [];
  for (const [lon, lat] of points) {
    const x = round(lon);
    const y = round(lat);
    if (out.length && out.at(-2) === x && out.at(-1) === y) continue;
    out.push(x, y);
  }
  return out;
}

/**
 * Split IGN paths into exclusive and shared track.
 * @param {number[][]} ignPaths Flat [lon, lat, …] paths.
 * @param {Array<{network: string, paths: number[][]}>} lines Operator lines.
 * @returns {{paths: number[][], shared: Array<{networks: string[],
 *   paths: number[][]}>, stats: {exclusiveKm: number, sharedKm: number}}}
 */
export function splitSharedTrack(
  ignPaths,
  lines,
  {
    maxM = SHARED_MAX_M,
    minRunM = SHARED_MIN_RUN_M,
    maxGapM = SHARED_MAX_GAP_M,
  } = {},
) {
  const cells = createOperatorIndex(lines);
  const exclusive = [];
  /** @type {Map<string, number[][]>} */
  const shared = new Map();
  let exclusiveM = 0;
  let sharedM = 0;
  for (const flat of ignPaths) {
    if (!Array.isArray(flat) || flat.length < 4) continue;
    const samples = samplePath(flat);
    const near = samples.map(({ lon, lat }) =>
      networksNear(cells, lon, lat, maxM),
    );
    const labels = sharedLabels(samples, near, { minRunM, maxGapM });
    for (const run of runsOf(labels)) {
      // Neighbouring pieces meet at the first sample of the next run.
      const from = run.from;
      const to = run.to < samples.length - 1 ? run.to + 1 : run.to;
      const piece = slicePath(flat, samples, from, to);
      if (piece.length < 4) continue;
      const m = samples[to].s - samples[from].s;
      if (run.label) {
        if (!shared.has(run.label)) shared.set(run.label, []);
        shared.get(run.label).push(piece);
        sharedM += m;
      } else {
        exclusive.push(piece);
        exclusiveM += m;
      }
    }
  }
  const byStart = (a, b) => a[0] - b[0] || a[1] - b[1] || b.length - a.length;
  return {
    paths: exclusive.sort(byStart),
    shared: [...shared]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, paths]) => ({
        networks: label.split(','),
        paths: paths.sort(byStart),
      })),
    stats: {
      exclusiveKm: Math.round(exclusiveM / 1000),
      sharedKm: Math.round(sharedM / 1000),
    },
  };
}

/**
 * Every IGN path in a pack, exclusive and shared, chained back together and
 * simplified again (drops the cut points an earlier split added).
 */
export function ignPackTrack(pack) {
  const flats = [
    ...(Array.isArray(pack?.paths) ? pack.paths : []),
    ...(Array.isArray(pack?.shared) ? pack.shared : []).flatMap((group) =>
      Array.isArray(group?.paths) ? group.paths : [],
    ),
  ];
  const points = flats.map((flat) => {
    const list = [];
    for (let i = 0; i + 1 < flat.length; i += 2)
      list.push([flat[i], flat[i + 1]]);
    return list;
  });
  return chainPaths(points).map((list) =>
    simplifyPath(list, IGN_TOLERANCE_M).flatMap(([lon, lat]) => [
      round(lon),
      round(lat),
    ]),
  );
}

/**
 * The IGN pack with its track split against the operator lines pack.
 * @param {object} ignPack
 * @param {object} linesPack
 */
export function splitIgnPack(ignPack, linesPack) {
  const { paths, shared, stats } = splitSharedTrack(
    ignPackTrack(ignPack),
    linesPack?.lines,
  );
  return {
    meta: {
      ...ignPack.meta,
      format:
        'paths[] = [lon, lat, lon, lat, …] (IGN-only track); shared[] = {networks, paths} (track within reach of those operators’ lines)',
      shared: {
        script: 'scripts/split-spain-rail-shared.mjs',
        maxM: SHARED_MAX_M,
        minRunM: SHARED_MIN_RUN_M,
        maxGapM: SHARED_MAX_GAP_M,
        ...stats,
      },
    },
    paths,
    shared,
  };
}

/** Split the bundled pack in place. */
export function splitBundledIgnPack(ignPack) {
  const linesPack = JSON.parse(fs.readFileSync(LINES_PACK, 'utf8'));
  return splitIgnPack(ignPack, linesPack);
}

function main() {
  const before = fs.statSync(IGN_PACK).size;
  const pack = splitBundledIgnPack(
    JSON.parse(fs.readFileSync(IGN_PACK, 'utf8')),
  );
  fs.writeFileSync(IGN_PACK, `${JSON.stringify(pack)}\n`);
  const { exclusiveKm, sharedKm } = pack.meta.shared;
  console.log(
    `Wrote ${path.relative(process.cwd(), IGN_PACK)} (${before} → ${fs.statSync(IGN_PACK).size} bytes): ${exclusiveKm} km IGN-only, ${sharedKm} km shared (${pack.shared
      .map((group) => `${group.networks.join('+')}: ${group.paths.length}`)
      .join(', ')})`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
