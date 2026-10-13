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
 * Station names and track geometry come from bundled packs, loaded only when
 * a feed is first used (`stopNames`, `trackGeometry`).
 */
import { spainStationNames } from './spainTransitStations.js';
import { spainTrackLines } from './spainTrackGeometry.js';

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
  note: 'Quoted from the dataset metadata of posicionament-dels-trens on dadesobertes.fgc.cat. The anonymous API allows 5,000 requests a day per IP (X-RateLimit-* headers, reset at midnight UTC); minIntervalMs keeps one process polling all day near 1,440. Geotren regenerates about every two minutes, so asking more often gains nothing.',
});

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
    routeMode: railOnly,
    deriveRoute: renfeCercaniasRoute,
    stopNames: () => spainStationNames('renfe-cercanias'),
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
    routeMode: railOnly,
    // Catalan regional trains (R15, R16, R17…) are published in both feeds
    // under one train number, at positions up to kilometres apart. Cercanías
    // keeps them: it adds the line, the platform and the train's own time.
    yieldsTo: 'renfe-cercanias',
    stopNames: () => spainStationNames('renfe-ld'),
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
    routeMode: fgcRouteMode,
    stopNames: () => spainStationNames('fgc'),
    trackGeometry: () => spainTrackLines('fgc'),
  }),
]);
