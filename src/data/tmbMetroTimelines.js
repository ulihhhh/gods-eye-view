/**
 * @module tmbMetroTimelines
 * @description TMB's metro as timelines for the position engine
 * (estimatedPositions.js). TMB publishes no train positions, only iMetro's
 * next arrivals per station and track. Measured on 2026-10-17
 * (docs/plans/transit-estimated-positions.md, section 3):
 *
 * - one request with every station code answers for the whole network;
 * - `codi_servei` names ONE train: the same code is listed at the six to nine
 *   stations ahead of it, with growing arrival times. That list is the
 *   train's timeline forward;
 * - at a terminus the same code moves to the other track, so a train is
 *   `line | codi_servei` and its current run is the track it reaches first;
 * - the gap between a train's arrivals at two consecutive stations is the
 *   segment's running time (stop included), so the segment a train is on now
 *   can be placed without a timetable.
 *
 * Pure: no Cesium, no Node built-ins, no clock of its own.
 */

import { distanceM } from './estimatedPositions.js';

/** Assumed stand at a station, inside the measured station-to-station gap. */
export const TMB_METRO_DWELL_MS = 20_000;

/** Speed for a segment no train has measured yet (stop included). */
export const TMB_METRO_FALLBACK_SPEED_MPS = 8.5;

/** A gap this long between two predicted arrivals is a fault, not a run. */
export const TMB_METRO_MAX_GAP_MS = 10 * 60_000;

/** Weight of a new measurement in a segment's running time. */
const RUNTIME_WEIGHT = 0.3;

/** Segment running times outside this range are not believed. */
const RUNTIME_MIN_MS = 30_000;
const RUNTIME_MAX_MS = 6 * 60_000;

/** Longest line, service or station name carried. */
const MAX_TEXT = 80;

function text(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : '';
}

/** A line's colour as TMB gives it (`1EB53A`), upper-case, or null. */
function lineColor(value) {
  const hex = text(value).replace(/^#/, '');
  return /^[0-9A-Fa-f]{6}$/.test(hex) ? hex.toUpperCase() : null;
}

/**
 * Every metro station by its per-line code, from TMB's station list
 * (`/transit/linies/metro/estacions` with `CODI_ESTACIO`, `NOM_ESTACIO`,
 * `NOM_LINIA`, `ORDRE_ESTACIO` and the geometry). Planned stations are kept:
 * the catalogue has marked running lines as planned (L10N on 2026-10-17),
 * and only stations iMetro lists trains for are ever used.
 * @param {unknown} collection GeoJSON FeatureCollection.
 * @returns {{byCode: Map<number, {code: number, name: string, line: string,
 *   order: number, lat: number, lon: number}>,
 *   byLineOrder: Map<string, Map<number, number>>}|null}
 */
export function buildTmbMetroNetwork(collection) {
  if (!Array.isArray(collection?.features)) return null;
  const byCode = new Map();
  const byLineOrder = new Map();
  for (const feature of collection.features) {
    const p = feature?.properties || {};
    const code = Number(p.CODI_ESTACIO);
    const order = Number(p.ORDRE_ESTACIO);
    const line = text(p.NOM_LINIA);
    const name = text(p.NOM_ESTACIO);
    const [lon, lat] = Array.isArray(feature?.geometry?.coordinates)
      ? feature.geometry.coordinates.map(Number)
      : [];
    if (!Number.isInteger(code) || !Number.isInteger(order) || !line || !name)
      continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || byCode.has(code)) continue;
    byCode.set(code, {
      code,
      name,
      line,
      order,
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
    });
    if (!byLineOrder.has(line)) byLineOrder.set(line, new Map());
    byLineOrder.get(line).set(order, code);
  }
  return byCode.size ? { byCode, byLineOrder } : null;
}

/** Every station code in the network, for the one iMetro request. */
export function tmbMetroNetworkCodes(network) {
  return [...(network?.byCode?.keys() ?? [])].sort((a, b) => a - b);
}

/**
 * The trains in one iMetro answer, each with its predicted arrivals per
 * track: `line|service` → {line, service, tracks: Map<track, [{code, at,
 * destination}]>}.
 * @param {unknown} body Parsed iMetro JSON.
 * @param {{byCode: Map<number, object>}} network
 * @returns {Map<string, {line: string, service: string, color: string|null, tracks: Map<number, Array<{code: number, at: number, destination: string}>>}>}
 */
export function tmbMetroTrains(body, network) {
  const trains = new Map();
  for (const line of Array.isArray(body?.linies) ? body.linies : []) {
    for (const station of Array.isArray(line?.estacions)
      ? line.estacions
      : []) {
      const code = Number(station?.codi_estacio);
      const track = Number(station?.codi_via);
      if (!network.byCode.has(code) || !Number.isInteger(track)) continue;
      for (const trip of Array.isArray(station?.linies_trajectes)
        ? station.linies_trajectes
        : []) {
        const lineName = text(trip?.nom_linia) || text(line?.nom_linia);
        if (!lineName) continue;
        const destination = text(trip?.desti_trajecte);
        const color =
          lineColor(trip?.color_linia) || lineColor(line?.color_linia);
        for (const next of Array.isArray(trip?.propers_trens)
          ? trip.propers_trens
          : []) {
          const service = text(String(next?.codi_servei ?? ''));
          const at = Number(next?.temps_arribada);
          if (!/^[A-Za-z0-9]{1,8}$/.test(service) || !Number.isFinite(at))
            continue;
          const key = `${lineName}|${service}`;
          let train = trains.get(key);
          if (!train) {
            train = { line: lineName, service, color, tracks: new Map() };
            trains.set(key, train);
          }
          if (!train.tracks.has(track)) train.tracks.set(track, []);
          train.tracks.get(track).push({ code, at, destination });
          train.color ||= color;
        }
      }
    }
  }
  for (const train of trains.values())
    for (const calls of train.tracks.values())
      calls.sort((a, b) => a.at - b.at);
  return trains;
}

/**
 * Fold the running times this answer measures into `runtimes`
 * (`from>to` → ms, a moving average), and return it. Each train's
 * consecutive predicted arrivals on one track measure one segment.
 * @param {ReturnType<typeof tmbMetroTrains>} trains
 * @param {Map<string, number>} [runtimes]
 * @returns {Map<string, number>}
 */
export function learnTmbMetroRuntimes(trains, runtimes = new Map()) {
  const samples = new Map();
  for (const train of trains.values()) {
    for (const calls of train.tracks.values()) {
      for (let i = 1; i < calls.length; i++) {
        const gap = calls[i].at - calls[i - 1].at;
        if (gap < RUNTIME_MIN_MS || gap > RUNTIME_MAX_MS) continue;
        const key = `${calls[i - 1].code}>${calls[i].code}`;
        if (!samples.has(key)) samples.set(key, []);
        samples.get(key).push(gap);
      }
    }
  }
  for (const [key, gaps] of samples) {
    gaps.sort((a, b) => a - b);
    const median = gaps[gaps.length >> 1];
    const known = runtimes.get(key);
    runtimes.set(
      key,
      Number.isFinite(known)
        ? Math.round(known + (median - known) * RUNTIME_WEIGHT)
        : median,
    );
  }
  return runtimes;
}

/**
 * Which way along the station order each line's tracks run (+1 or −1),
 * from the trains that list two or more stations on them.
 */
function trackDirections(trains, network) {
  const votes = new Map();
  for (const train of trains.values()) {
    for (const [track, calls] of train.tracks) {
      if (calls.length < 2) continue;
      const a = network.byCode.get(calls[0].code);
      const b = network.byCode.get(calls.at(-1).code);
      if (!a || !b || a.order === b.order) continue;
      const key = `${train.line}|${track}`;
      votes.set(key, (votes.get(key) || 0) + Math.sign(b.order - a.order));
    }
  }
  const directions = new Map();
  for (const [key, vote] of votes)
    if (vote) directions.set(key, Math.sign(vote));
  return directions;
}

function stopFor(station, arr, dep) {
  return {
    stopId: String(station.code),
    name: station.name,
    lat: station.lat,
    lon: station.lon,
    arr,
    dep,
  };
}

/**
 * Timelines for the position engine from one iMetro answer.
 *
 * Each train's current run is the track it reaches first. Its stops are the
 * stations it is predicted at (standing TMB_METRO_DWELL_MS at each), cut at
 * the first gap longer than TMB_METRO_MAX_GAP_MS, and preceded by the
 * station it is coming from, which it left one segment running time before
 * the first prediction. At the start of a line there is no station before,
 * and the train stands at the terminus until it is due to leave.
 *
 * @param {unknown} body Parsed iMetro JSON.
 * @param {ReturnType<typeof buildTmbMetroNetwork>} network
 * @param {{runtimes?: Map<string, number>, dwellMs?: number}} [options]
 *   `runtimes`: learned segment times (learnTmbMetroRuntimes), updated with
 *   this answer's measurements.
 * @returns {object[]}
 */
export function tmbMetroTimelines(
  body,
  network,
  { runtimes = new Map(), dwellMs = TMB_METRO_DWELL_MS } = {},
) {
  if (!network?.byCode) return [];
  const trains = tmbMetroTrains(body, network);
  learnTmbMetroRuntimes(trains, runtimes);
  const directions = trackDirections(trains, network);
  const timelines = [];
  for (const train of trains.values()) {
    let run = null;
    let runTrack = null;
    for (const [track, calls] of train.tracks) {
      if (!run || calls[0].at < run[0].at) {
        run = calls;
        runTrack = track;
      }
    }
    // One call per station: a repeated station keeps its first time.
    const calls = [];
    for (const call of run) {
      if (calls.some((seen) => seen.code === call.code)) continue;
      const prev = calls.at(-1);
      if (prev && call.at - prev.at > TMB_METRO_MAX_GAP_MS) break;
      calls.push(call);
    }
    const stations = calls.map((call) => network.byCode.get(call.code));
    const stops = calls.map((call, i) => {
      const next = calls[i + 1];
      const dep = next
        ? Math.min(call.at + dwellMs, call.at + (next.at - call.at) / 2)
        : call.at + dwellMs;
      return stopFor(stations[i], call.at, dep);
    });
    const direction = directions.get(`${train.line}|${runTrack}`);
    const first = stations[0];
    const fromCode = direction
      ? network.byLineOrder.get(first.line)?.get(first.order - direction)
      : null;
    const from = Number.isInteger(fromCode)
      ? network.byCode.get(fromCode)
      : null;
    if (from) {
      const runtime =
        runtimes.get(`${from.code}>${first.code}`) ??
        (distanceM(from.lat, from.lon, first.lat, first.lon) /
          TMB_METRO_FALLBACK_SPEED_MPS) *
          1000 +
          dwellMs;
      const dep = calls[0].at - Math.max(0, runtime - dwellMs);
      stops.unshift(stopFor(from, dep - dwellMs, dep));
    } else if (!direction) {
      // Nothing says which way the train is going, so where it is now
      // cannot be told from where it will be.
      continue;
    }
    timelines.push({
      id: `${train.line}-${train.service}`,
      routeId: train.line,
      tripId: train.service,
      label: train.service,
      ...(calls[0].destination ? { destination: calls[0].destination } : {}),
      ...(train.color ? { routeColor: train.color } : {}),
      stops,
    });
  }
  return timelines.sort((a, b) => a.id.localeCompare(b.id));
}
