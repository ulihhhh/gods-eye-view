/**
 * Pairs each Spanish provincial capital (`spainCapitals.js`) with its nearest
 * live AEMET station reading, for the temperature-gradient overlay's capital
 * labels (`aemetStations.js`'s gradient view mode) — the standard weather-map
 * convention of point-labeling named cities, rather than one averaged number
 * per comunidad autónoma (CCAAs are climatically too mixed for a single
 * average to mean much — e.g. Castilla y León spans plateau to mountain).
 *
 * PURE — no Cesium/DOM dependency, node-testable.
 */

import { haversineKm } from './analystEngine.js';

/**
 * @param {{lat: number, lon: number}} capital
 * @param {Array<{lat: number, lon: number, temperatureC: number}>} stations
 *   Pre-filtered to finite lat/lon/temperatureC by the caller.
 * @returns {{station: object, distanceKm: number}|null}
 */
export function findNearestAemetStation(capital, stations) {
  if (!Number.isFinite(capital?.lat) || !Number.isFinite(capital?.lon)) return null;
  if (!Array.isArray(stations) || !stations.length) return null;
  let best = null;
  let bestKm = Infinity;
  for (const station of stations) {
    const km = haversineKm(capital.lat, capital.lon, station.lat, station.lon);
    if (km < bestKm) {
      bestKm = km;
      best = station;
    }
  }
  return best ? { station: best, distanceKm: bestKm } : null;
}

/**
 * @param {Array<{id: string, name: string, lat: number, lon: number}>} capitals
 * @param {Array<{id?: string, lat: number, lon: number, temperatureC: number}>} stations
 * @returns {Array<{capitalId: string, name: string, lat: number, lon: number,
 *   temperatureC: number, stationId: string|null, distanceKm: number}>}
 */
export function buildCapitalTemperatureRecords(capitals, stations) {
  const candidates = (stations || []).filter(
    (s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lon) && Number.isFinite(s?.temperatureC),
  );
  if (!candidates.length || !Array.isArray(capitals) || !capitals.length) return [];

  const records = [];
  for (const capital of capitals) {
    const match = findNearestAemetStation(capital, candidates);
    if (!match) continue;
    records.push({
      capitalId: capital.id,
      name: capital.name,
      lat: capital.lat,
      lon: capital.lon,
      temperatureC: match.station.temperatureC,
      stationId: match.station.id ?? null,
      distanceKm: match.distanceKm,
    });
  }
  return records;
}
