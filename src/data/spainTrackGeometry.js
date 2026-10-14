/**
 * Track geometry for the Spanish transit feeds, so their trains run along
 * the drawn track (registry `trackGeometry`, read by the Transit layer's
 * track following). From the bundled packs the Rail network layer draws:
 * Cercanías / Rodalies and FGC lines (`lines.json`) and the IGN's national
 * network (`ign_rail.json`). Read through `loadBundledJson`, once each.
 */
import { loadBundledJson } from './bundledJson.js';

const LINES_URL = new URL(
  './local_data/spain_transit/lines.json',
  import.meta.url,
);
const IGN_URL = new URL(
  './local_data/spain_transit/ign_rail.json',
  import.meta.url,
);

/** @type {Map<URL, Promise<any>>} */
const packs = new Map();

function pack(url) {
  if (!packs.has(url))
    packs.set(
      url,
      loadBundledJson(url).catch((error) => {
        packs.delete(url); // a later call may try again
        throw error;
      }),
    );
  return packs.get(url);
}

const validPath = (path) =>
  Array.isArray(path) &&
  path.length >= 4 &&
  path.length % 2 === 0 &&
  path.every(Number.isFinite);

function operatorLines(lines, network, named) {
  return (Array.isArray(lines) ? lines : [])
    .filter((line) => line?.network === network)
    .map((line) => ({
      // FGC merges lines that share one geometry: "S9 · L8".
      routes: named ? String(line.line).split(' · ') : null,
      paths: (line.paths || []).filter(validPath),
    }))
    .filter((line) => line.paths.length);
}

/**
 * Track lines for one Spanish feed.
 * @param {'renfe-cercanias'|'renfe-ld'|'fgc'} feed
 * @returns {Promise<Array<{routes: string[]|null, paths: number[][]}>>}
 */
export async function spainTrackLines(feed) {
  const { lines } = await pack(LINES_URL);
  if (feed === 'renfe-cercanias')
    return operatorLines(lines, 'renfe-cercanias', true);
  if (feed === 'fgc') return operatorLines(lines, 'fgc', true);
  if (feed === 'renfe-ld') {
    // Long-distance trains run anywhere on the national network, including
    // the track it shares with Cercanías and FGC (`shared`, which the Rail
    // network layer may not draw); the Cercanías track is part of it where
    // the IGN pack is coarser.
    const ign = await pack(IGN_URL).catch(() => null);
    const ignPaths = [
      ...(Array.isArray(ign?.paths) ? ign.paths : []),
      ...(Array.isArray(ign?.shared) ? ign.shared : []).flatMap((group) =>
        Array.isArray(group?.paths) ? group.paths : [],
      ),
    ].filter(validPath);
    return [
      ...(ignPaths.length ? [{ routes: null, paths: ignPaths }] : []),
      ...operatorLines(lines, 'renfe-cercanias', false),
    ];
  }
  throw new Error(`No track geometry for "${feed}"`);
}
