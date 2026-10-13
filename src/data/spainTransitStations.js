/**
 * Spanish station dictionaries for the Transit layer's feeds, from the pack
 * `scripts/build-spain-transit-network.mjs` writes (Renfe and FGC open data,
 * CC BY 4.0). Read through `loadBundledJson`, once, and shared.
 *
 * The registry rows in `transitFeedsSpain.js` hand `spainStationNames` to the
 * service as their `stopNames` loader; nothing else here runs until a Spanish
 * feed is first fetched.
 */
import { loadBundledJson } from './bundledJson.js';

const PACK_URL = new URL(
  './local_data/spain_transit/stations.json',
  import.meta.url,
);

/** @type {Promise<object>|null} */
let pack = null;
/** @type {Map<string, Readonly<Record<string, string>>>} */
const namesByNetwork = new Map();

function loadPack() {
  pack ??= loadBundledJson(PACK_URL).catch((error) => {
    pack = null; // let a later call try again
    throw error;
  });
  return pack;
}

/**
 * `{stopId: name}` for one network of the pack.
 * @param {'renfe-cercanias'|'renfe-ld'|'fgc'} network
 * @returns {Promise<Readonly<Record<string, string>>>}
 */
export async function spainStationNames(network) {
  const known = namesByNetwork.get(network);
  if (known) return known;
  const stations = (await loadPack())?.networks?.[network];
  if (!stations || typeof stations !== 'object')
    throw new Error(`No "${network}" stations in the Spain transit pack`);
  const names = Object.freeze(
    Object.fromEntries(
      Object.entries(stations)
        .filter(([, entry]) => Array.isArray(entry) && entry[0])
        .map(([id, entry]) => [id, String(entry[0])]),
    ),
  );
  namesByNetwork.set(network, names);
  return names;
}

/** @type {Map<string, Readonly<Record<string, [number, number]>>>} */
const placesByNetwork = new Map();

/**
 * `{stopId: [lat, lon]}` for one network of the pack: where each station is,
 * for the stations the pack places (FGC's funiculars have no point).
 * @param {'renfe-cercanias'|'renfe-ld'|'fgc'} network
 * @returns {Promise<Readonly<Record<string, [number, number]>>>}
 */
export async function spainStationPlaces(network) {
  const known = placesByNetwork.get(network);
  if (known) return known;
  const stations = (await loadPack())?.networks?.[network];
  if (!stations || typeof stations !== 'object')
    throw new Error(`No "${network}" stations in the Spain transit pack`);
  const places = Object.freeze(
    Object.fromEntries(
      Object.entries(stations)
        .filter(
          ([, entry]) =>
            Array.isArray(entry) &&
            Number.isFinite(entry[1]) &&
            Number.isFinite(entry[2]),
        )
        .map(([id, entry]) => [id, Object.freeze([entry[1], entry[2]])]),
    ),
  );
  placesByNetwork.set(network, places);
  return places;
}
