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
 */

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
  }),
]);
