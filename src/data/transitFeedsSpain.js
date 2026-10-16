/**
 * @module transitFeedsSpain
 * @description Spanish rows of the Transit feed registry: Renfe's two
 * keyless GTFS-Realtime VehiclePositions feeds. The same admission rules as
 * `transitFeeds.js` apply (no key, open terms that were read, real
 * coordinates); this module only keeps the Spanish rows in one place, and the
 * registry splices them in.
 *
 * Pure data + pure helpers, like the registry itself: no Cesium, no Node
 * built-ins, and no import from `transitFeeds.js` (which imports this file).
 * Station names, station positions and track geometry come from bundled
 * packs, loaded only when a feed is first used (`stopNames`, `stopPlaces`,
 * `trackGeometry`). Renfe reads its stop statuses its own way
 * (`interpretStatus`), and all three feeds repeat a position with a newer
 * time while the train moves on (`staleRepeats`).
 */
import {
  spainStationNames,
  spainStationPlaces,
} from './spainTransitStations.js';
import { spainTrackLines } from './spainTrackGeometry.js';
import {
  buildCercaniasTripDetails,
  buildRenfeLdTripDetails,
} from './renfeTripDetails.js';

/**
 * Renfe Cercanías labels are `<line>-<train>` with an optional platform
 * suffix, documented on the dataset page: "La información del andén
 * (Platform) en el que el tren se va a posicionar se informa dentro del
 * atributo label", e.g. `C1-23537-PLATF.(3)`. Lines carry an optional
 * lower-case branch letter (`C4a`, `C8b`).
 */
const CERCANIAS_LABEL =
  /^([A-Z][A-Z0-9]{0,4}[a-z]?)-(\d{1,8})(?:-PLATF\.\(([A-Za-z0-9]{1,4})\))?$/;

/** Trip ids end with the same line code: `3083L23534C1`, `1083L27304C4a`. */
const CERCANIAS_TRIP = /^\d{1,6}L\d{1,8}([A-Z][A-Z0-9]{0,4}[a-z]?)$/;

/**
 * Line and platform for one Cercanías vehicle. The feed leaves
 * `trip.route_id` empty, so the line comes from the label, or from the trip
 * id when the label does not parse. Nothing is guessed: an unparsable label
 * and trip id leave the record without a line.
 * @param {{label?: string|null, tripId?: string|null}} record
 * @returns {{routeId?: string, platform?: string}}
 */
export function renfeCercaniasRoute(record) {
  const label = typeof record?.label === 'string' ? record.label : '';
  const fromLabel = CERCANIAS_LABEL.exec(label);
  if (fromLabel) {
    return {
      routeId: fromLabel[1],
      ...(fromLabel[3] ? { platform: fromLabel[3] } : {}),
    };
  }
  const trip = typeof record?.tripId === 'string' ? record.tripId : '';
  const fromTrip = CERCANIAS_TRIP.exec(trip);
  return fromTrip ? { routeId: fromTrip[1] } : {};
}

/**
 * Both Renfe feeds are trains and nothing else, so their mode is a fact
 * about the fleet, not a guess. It has to be RESOLVED: a defaulted mode is
 * held to the `unknown` speed ceiling (~200 km/h), which would refuse the
 * fixes of a high-speed train running at 300 km/h.
 * @returns {string}
 */
function railOnly() {
  return 'rail';
}

/**
 * How Renfe's Cercanías feed uses `current_status`, measured on live data
 * (2026-10-13, ~10 minutes, every núcleo):
 * - IN_TRANSIT_TO names the station the train LEFT: from the first report
 *   of 48 trains in transit, 39 then moved away from that station;
 * - INCOMING_AT names the next station, but its position is not the train's:
 *   69 % of them sit more than 120 km/h away from the train's last
 *   IN_TRANSIT_TO / STOPPED_AT position, often on the station after next;
 * - STOPPED_AT positions sit on the station (median 19 m) and stay put.
 * @param {{status?: string|null}} record
 * @returns {{stopRelation?: string, positionUntrusted?: boolean}}
 */
export function renfeCercaniasStatus(record) {
  if (record?.status === 'IN_TRANSIT_TO') return { stopRelation: 'left' };
  if (record?.status === 'INCOMING_AT')
    return { stopRelation: 'arriving', positionUntrusted: true };
  return {};
}

/**
 * Renfe's AV/LD/MD feed: IN_TRANSIT_TO is the next station (69 of 93 trains
 * then moved toward it), but a STOPPED_AT train is a median 11 km from its
 * station and keeps moving, so that station is the last one it served.
 * @param {{status?: string|null}} record
 * @returns {{stopRelation?: string}}
 */
export function renfeLdStatus(record) {
  return record?.status === 'STOPPED_AT' ? { stopRelation: 'last' } : {};
}

/** Terms shared by every Renfe dataset (data.renfe.com/legal). */
const RENFE_TERMS = Object.freeze({
  quote:
    'Las presentes condiciones generales permiten la reutilización de los documentos sometidos a ellas para fines comerciales y no comerciales.',
  note: 'Each dataset page lists CC BY 4.0, and data.renfe.com/legal adds the Spanish public-sector reuse terms: cite the source ("Origen de los datos: Renfe Operadora"), keep the update date (the feed header time the card shows), do not distort the data, and do not suggest Renfe takes part in, sponsors or supports the reuse, so the credit is text only. No key, no stated rate limit.',
});

/**
 * Peninsular centre. A circle reaching Portbou (≈ 610 km) and Cádiz also
 * holds Lisbon and Toulouse; polling there only fetches a ~20 KB file with no
 * train in view, and no other feed covers either city.
 */
const SPAIN_CENTER = Object.freeze({ lat: 40.0, lon: -3.7 });

/** FGC lines that run as metro (GTFS `route_type` 1 in FGC's own routes). */
const FGC_METRO_LINES = new Set(['L6', 'L7', 'L8', 'L12']);

/**
 * Mode for an FGC line. Metro lines are subway; everything else FGC runs on
 * these networks is rail (S and R services, and the rack railways). Every
 * vehicle is resolved, never a guess: an unknown line is still an FGC train.
 * @param {string|null} routeId
 * @returns {string}
 */
export function fgcRouteMode(routeId) {
  return FGC_METRO_LINES.has(routeId) ? 'subway' : 'rail';
}

/** FGC's open-data terms, as the dataset's own metadata states them. */
const FGC_TERMS = Object.freeze({
  quote:
    'Creative Commons Attribution License 4.0 (cc-by 4.0) — attributions: Ferrocarrils de la Generalitat de Catalunya',
  note: 'Quoted from the dataset metadata of posicionament-dels-trens (and, identically, trip-updates-gtfs_realtime) on dadesobertes.fgc.cat. The anonymous API allows 5,000 requests a day per IP (X-RateLimit-* headers, reset at midnight UTC), shared by both datasets; minIntervalMs keeps one process polling each all day near 1,440 (2,880 together). Geotren regenerates about every two minutes, so asking more often gains nothing.',
});

/**
 * Renfe's static GTFS, read once a day for each trip's service and
 * destination (registry `tripDetails`; CC BY 4.0, data.renfe.com datasets
 * horarios-cercanias and horarios-de-alta-velocidad-larga-distancia-y-media-
 * distancia). Cercanías' `trips.txt` is ~17.5 MB, so the entry cap is
 * raised above the proxy's usual 16 MB.
 */
const RENFE_GTFS_FILES = Object.freeze(['routes.txt', 'trips.txt']);
const RENFE_CERCANIAS_TRIP_DETAILS = Object.freeze({
  url: 'https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip',
  files: RENFE_GTFS_FILES,
  maxBytes: 32 * 1024 * 1024,
  maxEntryBytes: 32 * 1024 * 1024,
  build: buildCercaniasTripDetails,
});
const RENFE_LD_TRIP_DETAILS = Object.freeze({
  url: 'https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip',
  files: RENFE_GTFS_FILES,
  maxBytes: 8 * 1024 * 1024,
  maxEntryBytes: 16 * 1024 * 1024,
  build: buildRenfeLdTripDetails,
});

/**
 * FGC's GTFS-Realtime TripUpdates: a predicted time at every stop left on
 * each trip, keyed by Geotren's trip id. The Opendatasoft file id has been
 * stable since the dataset was first read (2026-10-13); the dataset's
 * `records` endpoint lists it if it ever changes.
 */
const FGC_TRIP_UPDATES_URL =
  'https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets/trip-updates-gtfs_realtime/files/735985017f62fd33b2fe46e31ce53829';

/** FGC trip-update stops are a station code plus a platform digit ("PC1"). */
export function fgcTripStopKey(stopId) {
  return /^[A-Z0-9]{2,6}$/.test(stopId) ? stopId.slice(0, -1) : stopId;
}

/** …and that digit is the track the train uses ("PC1" → platform 1). */
export function fgcTripStopPlatform(stopId) {
  return /^[A-Z0-9]{1,5}[0-9]$/.test(stopId) ? stopId.slice(-1) : null;
}

/** Spanish registry rows, in presentation order. */
export const SPAIN_TRANSIT_FEEDS = Object.freeze([
  Object.freeze({
    id: 'renfe-cercanias',
    name: 'Renfe Cercanías',
    operator: 'Renfe Operadora',
    region: 'Spain (Cercanías / Rodalies)',
    center: SPAIN_CENTER,
    loadRadiusKm: 650,
    url: 'https://gtfsrt.renfe.com/vehicle_positions.pb',
    license: 'CC BY 4.0 and data.renfe.com reuse terms',
    licenseUrl: 'https://data.renfe.com/dataset/ubicacion-vehiculos',
    attribution: 'Renfe Operadora — datos abiertos',
    defaultEnabled: true,
    terms: RENFE_TERMS,
    defaultMode: 'rail',
    timeZone: 'Europe/Madrid',
    routeMode: railOnly,
    deriveRoute: renfeCercaniasRoute,
    interpretStatus: renfeCercaniasStatus,
    // A train's position often stays the same while its time moves on; only
    // a train stopped at a station is really standing there.
    staleRepeats: true,
    // The server keeps each train's recent positions, so a train the browser
    // sees for the first time can start moving from where it was.
    historyRetention: true,
    // Delay and next stop with its time (datos abiertos "Horarios de viaje
    // Cercanías", CC BY 4.0); destination from the static GTFS.
    tripUpdates: Object.freeze({
      url: 'https://gtfsrt.renfe.com/trip_updates.pb',
    }),
    tripDetails: RENFE_CERCANIAS_TRIP_DETAILS,
    stopNames: () => spainStationNames('renfe-cercanias'),
    stopPlaces: () => spainStationPlaces('renfe-cercanias'),
    trackGeometry: () => spainTrackLines('renfe-cercanias'),
  }),
  Object.freeze({
    id: 'renfe-ld',
    name: 'Renfe AV/LD/MD',
    operator: 'Renfe Operadora',
    region: 'Spain (high-speed, long and medium distance)',
    center: SPAIN_CENTER,
    loadRadiusKm: 750,
    url: 'https://gtfsrt.renfe.com/vehicle_positions_LD.pb',
    license: 'CC BY 4.0 and data.renfe.com reuse terms',
    licenseUrl: 'https://data.renfe.com/dataset/posicion-vehiculos-av-ld-md',
    attribution: 'Renfe Operadora — datos abiertos',
    defaultEnabled: true,
    terms: RENFE_TERMS,
    defaultMode: 'rail',
    timeZone: 'Europe/Madrid',
    routeMode: railOnly,
    // Catalan regional trains (R15, R16, R17…) are published in both feeds
    // under one train number, at positions up to kilometres apart. Cercanías
    // keeps them: it adds the line, the platform and the train's own time.
    yieldsTo: 'renfe-cercanias',
    interpretStatus: renfeLdStatus,
    staleRepeats: true,
    historyRetention: true,
    tripUpdates: Object.freeze({
      url: 'https://gtfsrt.renfe.com/trip_updates_LD.pb',
    }),
    // Service (AVE, ALVIA, MD…) and destination; trip ids carry the date.
    tripDetails: RENFE_LD_TRIP_DETAILS,
    stopNames: () => spainStationNames('renfe-ld'),
    stopPlaces: () => spainStationPlaces('renfe-ld'),
    trackGeometry: () => spainTrackLines('renfe-ld'),
  }),
  Object.freeze({
    id: 'fgc-geotren',
    name: 'FGC',
    operator: 'Ferrocarrils de la Generalitat de Catalunya',
    region: 'Barcelona metropolitan lines (FGC)',
    // Holds Barcelona, the Vallès, Manresa and Igualada: every line Geotren
    // publishes (Barcelona–Vallès and Llobregat–Anoia).
    center: Object.freeze({ lat: 41.5, lon: 1.95 }),
    loadRadiusKm: 60,
    url: 'https://dadesobertes.fgc.cat/api/records/1.0/search/?dataset=posicionament-dels-trens&rows=200',
    format: 'fgc-geotren',
    minIntervalMs: 60_000,
    // Geotren regenerates about every two minutes; the layer plays its
    // trains further behind real time instead of stalling them between
    // batches (see transitFeedTiming).
    reportIntervalMs: 120_000,
    license: 'CC BY 4.0',
    licenseUrl:
      'https://dadesobertes.fgc.cat/explore/dataset/posicionament-dels-trens/',
    attribution: 'Ferrocarrils de la Generalitat de Catalunya',
    defaultEnabled: true,
    terms: FGC_TERMS,
    defaultMode: 'rail',
    timeZone: 'Europe/Madrid',
    routeMode: fgcRouteMode,
    staleRepeats: true,
    historyRetention: true,
    tripUpdates: Object.freeze({
      url: FGC_TRIP_UPDATES_URL,
      minIntervalMs: 60_000,
      stopKey: fgcTripStopKey,
      stopPlatform: fgcTripStopPlatform,
    }),
    stopNames: () => spainStationNames('fgc'),
    stopPlaces: () => spainStationPlaces('fgc'),
    trackGeometry: () => spainTrackLines('fgc'),
  }),
]);
