/**
 * TMB (Transports Metropolitans de Barcelona) next-arrival data — pure
 * helpers shared by the server proxy (`server/providers/tmb.js`) and the
 * `tmb-arrivals` layer. No Cesium, no network: the proxy hands these TMB's
 * parsed JSON, and the layer hands them the proxy's normalized answers.
 *
 * TMB publishes arrival predictions only (iMetro, iBus), never vehicle
 * positions, so the layer draws stations and stops and answers a click with
 * the next arrivals there. Its licence binds reuse to the application named
 * at registration and asks for the source and the date to be cited — hence
 * the "Source: TMB · <time>" line on every card. Fork-local.
 */

/** Metro station groups (`CODI_GRUP_ESTACIO`) are 7-digit codes today. */
export const TMB_METRO_ID_PATTERN = /^\d{1,7}$/;

/** Bus stop codes (`CODI_PARADA`) top out at 4 digits today. */
export const TMB_BUS_ID_PATTERN = /^\d{1,6}$/;

/** Arrivals kept per route and direction: enough for "2 min, 6 min, 11 min". */
export const TMB_ARRIVALS_PER_ROUTE = 3;

/** Route rows on one card before the rest fold into "+N more". */
export const TMB_CARD_MAX_ROUTES = 8;

/** A prediction this far in the past is a train or bus that has gone. */
const DEPARTED_GRACE_MS = 60_000;

const HEX_COLOR = /^[0-9A-Fa-f]{6}$/;

function finiteCoordinate(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  );
}

function pointOf(feature) {
  const coordinates = feature?.geometry?.coordinates;
  if (feature?.geometry?.type !== 'Point' || !Array.isArray(coordinates))
    return null;
  const lon = Number(coordinates[0]);
  const lat = Number(coordinates[1]);
  return finiteCoordinate(lat, lon) ? { lat, lon } : null;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function color(value) {
  const hex = text(value);
  return HEX_COLOR.test(hex) ? hex.toUpperCase() : null;
}

/**
 * One marker per metro station group from TMB's per-line station list
 * (`/transit/linies/metro/estacions`): Catalunya is one row each for L1 and
 * L3, but one place to click and one iMetro request with both codes.
 * Planned stations (not yet open) are dropped.
 * @param {unknown} collection GeoJSON FeatureCollection from TMB.
 * @returns {Array<{id: string, name: string, lat: number, lon: number,
 *   codes: number[], lines: Array<{name: string, color: string|null}>}>|null}
 *   null when the payload is not a FeatureCollection.
 */
export function buildTmbMetroStations(collection) {
  if (!Array.isArray(collection?.features)) return null;
  /** @type {Map<string, {name: string, points: Array<{lat: number, lon: number}>, codes: Set<number>, lines: Map<string, {name: string, color: string|null, order: number}>}>} */
  const groups = new Map();
  for (const feature of collection.features) {
    const p = feature?.properties || {};
    if (/planific/i.test(text(p.NOM_TIPUS_ESTAT))) continue;
    const group = String(p.CODI_GRUP_ESTACIO ?? '');
    const code = Number(p.CODI_ESTACIO);
    const point = pointOf(feature);
    const name = text(p.NOM_ESTACIO);
    if (!TMB_METRO_ID_PATTERN.test(group) || !Number.isInteger(code)) continue;
    if (!point || !name) continue;
    let entry = groups.get(group);
    if (!entry) {
      entry = { name, points: [], codes: new Set(), lines: new Map() };
      groups.set(group, entry);
    }
    entry.points.push(point);
    entry.codes.add(code);
    const line = text(p.NOM_LINIA);
    if (line && !entry.lines.has(line)) {
      const order = Number(p.ORDRE_LINIA);
      entry.lines.set(line, {
        name: line,
        color: color(p.COLOR_LINIA),
        order: Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER,
      });
    }
  }
  const stations = [];
  for (const [id, entry] of groups) {
    const lat =
      entry.points.reduce((sum, point) => sum + point.lat, 0) /
      entry.points.length;
    const lon =
      entry.points.reduce((sum, point) => sum + point.lon, 0) /
      entry.points.length;
    stations.push({
      id,
      name: entry.name,
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
      codes: [...entry.codes].sort((a, b) => a - b),
      lines: [...entry.lines.values()]
        .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
        .map(({ name, color: lineColor }) => ({ name, color: lineColor })),
    });
  }
  return stations.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Bus stops from TMB's stop list (`/transit/parades`), trimmed to what a
 * marker and a click need.
 * @param {unknown} collection GeoJSON FeatureCollection from TMB.
 * @returns {Array<{id: string, name: string, lat: number, lon: number}>|null}
 */
export function buildTmbBusStops(collection) {
  if (!Array.isArray(collection?.features)) return null;
  const stops = new Map();
  for (const feature of collection.features) {
    const p = feature?.properties || {};
    const id = String(p.CODI_PARADA ?? '');
    const point = pointOf(feature);
    const name = text(p.NOM_PARADA);
    if (!TMB_BUS_ID_PATTERN.test(id) || !point || !name || stops.has(id))
      continue;
    stops.set(id, {
      id,
      name,
      lat: Number(point.lat.toFixed(6)),
      lon: Number(point.lon.toFixed(6)),
    });
  }
  return [...stops.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

/**
 * Metro line geometry from TMB's line list (`/transit/linies/metro`), as flat
 * [lon, lat, …] paths with the line's own colour, in TMB's line order.
 * @param {unknown} collection GeoJSON FeatureCollection from TMB.
 * @returns {Array<{name: string, color: string|null, paths: number[][]}>|null}
 */
export function buildTmbMetroLines(collection) {
  if (!Array.isArray(collection?.features)) return null;
  const lines = [];
  for (const feature of collection.features) {
    const p = feature?.properties || {};
    const name = text(p.NOM_LINIA);
    const geometry = feature?.geometry;
    const parts =
      geometry?.type === 'MultiLineString'
        ? geometry.coordinates
        : geometry?.type === 'LineString'
          ? [geometry.coordinates]
          : [];
    const paths = [];
    for (const part of Array.isArray(parts) ? parts : []) {
      const flat = [];
      for (const point of Array.isArray(part) ? part : []) {
        const lon = Number(point?.[0]);
        const lat = Number(point?.[1]);
        if (finiteCoordinate(lat, lon))
          flat.push(Number(lon.toFixed(6)), Number(lat.toFixed(6)));
      }
      if (flat.length >= 4) paths.push(flat);
    }
    if (!name || !paths.length) continue;
    const order = Number(p.ORDRE_LINIA);
    lines.push({
      name,
      color: color(p.COLOR_LINIA),
      order: Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER,
      paths,
    });
  }
  return lines
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map(({ name, color: lineColor, paths }) => ({
      name,
      color: lineColor,
      paths,
    }));
}

function arrivalTimes(list, field = 'temps_arribada') {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => Number(item?.[field]))
    .filter((ms) => Number.isFinite(ms) && ms > 0)
    .sort((a, b) => a - b)
    .slice(0, TMB_ARRIVALS_PER_ROUTE);
}

function firstArrival(route) {
  return route.arrivals[0] ?? Number.POSITIVE_INFINITY;
}

/**
 * Normalize an iMetro answer (`/itransit/metro/estacions?estacions=…`).
 * @param {unknown} body Parsed TMB JSON.
 * @returns {{fetchedAt: number|null, routes: Array<{line: string,
 *   color: string|null, destination: string, track: number|null,
 *   arrivals: number[]}>}|null} null when the shape is not iMetro's.
 */
export function normalizeTmbMetroArrivals(body) {
  if (!Array.isArray(body?.linies)) return null;
  const routes = [];
  for (const line of body.linies) {
    for (const station of Array.isArray(line?.estacions)
      ? line.estacions
      : []) {
      const track = Number(station?.codi_via);
      for (const trip of Array.isArray(station?.linies_trajectes)
        ? station.linies_trajectes
        : []) {
        const name = text(trip?.nom_linia) || text(line?.nom_linia);
        if (!name) continue;
        routes.push({
          line: name,
          color: color(trip?.color_linia) || color(line?.color_linia),
          destination: text(trip?.desti_trajecte),
          track: Number.isInteger(track) ? track : null,
          arrivals: arrivalTimes(trip?.propers_trens),
        });
      }
    }
  }
  routes.sort(
    (a, b) =>
      a.line.localeCompare(b.line, 'en', { numeric: true }) ||
      (a.track ?? 0) - (b.track ?? 0) ||
      firstArrival(a) - firstArrival(b),
  );
  const fetchedAt = Number(body.timestamp);
  return { fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : null, routes };
}

/**
 * Normalize an iBus answer (`/itransit/bus/parades/{code}`). TMB's own and
 * AMB lines that call at a TMB stop both come back here.
 * @param {unknown} body Parsed TMB JSON.
 * @returns {{fetchedAt: number|null, name: string, routes: Array<{
 *   line: string, color: null, destination: string, track: null,
 *   arrivals: number[]}>}|null}
 */
export function normalizeTmbBusArrivals(body) {
  if (!Array.isArray(body?.parades)) return null;
  const routes = [];
  let name = '';
  for (const stop of body.parades) {
    name ||= text(stop?.nom_parada);
    for (const trip of Array.isArray(stop?.linies_trajectes)
      ? stop.linies_trajectes
      : []) {
      const line = text(trip?.nom_linia);
      if (!line) continue;
      routes.push({
        line,
        color: null,
        destination: text(trip?.desti_trajecte),
        track: null,
        arrivals: arrivalTimes(trip?.propers_busos),
      });
    }
  }
  routes.sort(
    (a, b) =>
      firstArrival(a) - firstArrival(b) ||
      a.line.localeCompare(b.line, 'en', { numeric: true }),
  );
  const fetchedAt = Number(body.timestamp);
  return {
    fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : null,
    name,
    routes,
  };
}

/**
 * "now", "1 min", "12 min" — TMB predicts to the second for metro and to
 * the minute for bus, and a countdown reads better than a clock time.
 * @param {number} arrivalMs
 * @param {number} nowMs
 * @returns {string|null} null once the vehicle has gone.
 */
export function formatTmbEta(arrivalMs, nowMs) {
  const delta = arrivalMs - nowMs;
  if (delta < -DEPARTED_GRACE_MS) return null;
  if (delta <= 30_000) return 'now';
  return `${Math.max(1, Math.round(delta / 60_000))} min`;
}

/** Clock time in Barcelona, independent of the viewer's own time zone. */
export function formatTmbClock(ms) {
  return new Date(ms).toLocaleTimeString('en-GB', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Title and detail lines of the selected station or stop card.
 * AMB stops (`kind: 'amb'`) share the card: same rows, AMB's stop code and
 * source line.
 * @param {{kind: 'metro'|'bus'|'amb', place: {id: string, name: string,
 *   code?: string,
 *   lines?: Array<{name: string}>}, arrivals?: {fetchedAt: number|null,
 *   routes: Array<{line: string, destination: string, arrivals: number[]}>}|null,
 *   status?: 'loading'|'ready'|'error', error?: string|null, now: number}} input
 * @returns {{title: string, details: string[]}}
 */
export function buildTmbArrivalsCopy({
  kind,
  place,
  arrivals = null,
  status = 'ready',
  error = null,
  now,
}) {
  const metro = kind === 'metro';
  const operator = kind === 'amb' ? 'AMB' : 'TMB';
  const title = `${metro ? '🚇' : '🚏'} ${place?.name || place?.id || operator}`;
  const details = [];
  if (metro) {
    const lines = (place?.lines || []).map((line) => line.name).join(' ');
    details.push(`Metro station · TMB${lines ? ` · ${lines}` : ''}`);
  } else {
    const code = kind === 'amb' ? place?.code || place?.id : place?.id;
    details.push(
      code ? `Bus stop ${code} · ${operator}` : `Bus stop · ${operator}`,
    );
  }
  if (status === 'loading' && !arrivals) {
    details.push(`Asking ${operator} for the next arrivals…`);
    return { title, details };
  }
  if (status === 'error' && !arrivals) {
    details.push(error || `${operator} arrivals unavailable`);
    return { title, details };
  }
  const rows = [];
  for (const route of arrivals?.routes || []) {
    const etas = route.arrivals
      .map((ms) => formatTmbEta(ms, now))
      .filter(Boolean);
    if (!etas.length) continue;
    const towards = route.destination ? ` → ${route.destination}` : '';
    rows.push(`${route.line}${towards} · ${etas.join(', ')}`);
  }
  if (!rows.length) details.push('No arrivals reported right now');
  details.push(...rows.slice(0, TMB_CARD_MAX_ROUTES));
  if (rows.length > TMB_CARD_MAX_ROUTES)
    details.push(`+${rows.length - TMB_CARD_MAX_ROUTES} more`);
  if (status === 'error' && error)
    details.push(`${error} · showing last answer`);
  const at = arrivals?.fetchedAt;
  const source =
    kind === 'amb' ? 'AMB Mobilitat' : `TMB ${metro ? 'iMetro' : 'iBus'}`;
  details.push(
    `Source: ${source}${Number.isFinite(at) ? ` · ${formatTmbClock(at)}` : ''}`,
  );
  return { title, details };
}
