import * as Cesium from 'cesium';
import {
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from './pickRegistry.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import { getLocale, msg, t, tn } from '../i18n/index.js';
import { buildTmbArrivalsCopy } from './tmbArrivals.js';

/**
 * Barcelona next arrivals (fork-local) — TMB metro stations, TMB bus stops
 * and AMB metropolitan bus stops as points; clicking one asks the server for
 * its next arrivals and shows them on a card that counts down and refreshes
 * while it stays open.
 *
 * Neither operator publishes vehicle positions, so nothing here moves.
 * - TMB (keyed): the developer key stays on the server. This layer only
 *   calls `/api/tmb/stations` and `/api/tmb/arrivals/<kind>/<id>`.
 * - AMB (keyless): `/api/amb/stops` and `/api/amb/arrivals/<stopId>`.
 * - Bus routes, drawn at street scale: `/api/tmb/bus-lines` (keyed) and
 *   `/api/amb/lines`, both served by the server from the operators' own
 *   data, never bundled (TMB's licence binds it to the app; AMB's forbids
 *   altering it).
 * A stop both list (same code: AMB "000108" is TMB 108) is drawn once, as
 * TMB's: iBus already includes the AMB lines that call there. Without a TMB
 * key the layer still draws every AMB stop and says the rest needs the key.
 *
 * Metro stations show from city scale; bus stops only once the camera is
 * down at street scale, so a city view is not a carpet of dots.
 */

const LAYER_ID = 'tmb-arrivals';
const STATIONS_URL = '/api/tmb/stations';
const AMB_STOPS_URL = '/api/amb/stops';
const TMB_BUS_LINES_URL = '/api/tmb/bus-lines';
const AMB_LINES_URL = '/api/amb/lines';
const TMB_ALERTS_URL = '/api/tmb/alerts';
const AMB_ALERTS_URL = '/api/amb/alerts';

/** Arrivals URL of a station or stop. */
function arrivalsUrl(kind, id) {
  return kind === 'amb'
    ? `/api/amb/arrivals/${encodeURIComponent(id)}`
    : `/api/tmb/arrivals/${kind}/${encodeURIComponent(id)}`;
}

export const TMB_ARRIVALS_SELECTED_OVERLAY_SOURCE_ID = 'tmb-arrivals-selected';
export const TMB_ARRIVALS_SELECTED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

/** Card repaint (countdown) and the age at which it asks again. */
export const TMB_CARD_TICK_MS = 5_000;
export const TMB_CARD_REFRESH_MS = 15_000;

/** Camera distances beyond which each kind of marker is not drawn. */
// Metro: 137 points, readable from a whole-metropolitan-area view. Bus stops
// (TMB and AMB, ~6,000): only once the camera is down at neighbourhood scale.
export const TMB_METRO_MAX_DISTANCE_M = 75_000;
export const TMB_BUS_MAX_DISTANCE_M = 5_000;

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

/** Interchanges (several lines) are white; TMB's own line colour otherwise. */
const INTERCHANGE_RGB = [235, 235, 235];
const BUS_STOP_RGB = [218, 41, 28];
/** AMB's own metropolitan-bus amber, so its stops read apart from TMB's. */
const AMB_STOP_RGB = [255, 170, 0];
const UNKNOWN_RGB = [145, 164, 180];
const COLOR_OUTLINE = Cesium.Color.BLACK.withAlpha(0.6);
const POINT_HEIGHT_OFFSET_M = 2.0;

const AMB_STATUS_MESSAGES = Object.freeze({
  unavailable: msg('AMB unavailable'),
  not_found: msg('AMB no longer lists this stop'),
});

/** Shown, with AMB stops still drawn, when TMB's half needs the key. */
const TMB_KEY_HINT = Object.freeze({
  no_key: msg(
    'AMB stops only — metro and TMB buses need the TMB key (POWER UP)',
  ),
  rejected: msg('AMB stops only — TMB refused the developer key (POWER UP)'),
});

const STATUS_MESSAGES = Object.freeze({
  no_key: msg('TMB developer key not configured — add it in POWER UP'),
  rejected: msg('TMB refused the developer key — check it in POWER UP'),
  unavailable: msg('TMB unavailable'),
  busy: msg('TMB request limit reached — retrying shortly'),
  not_found: msg('TMB no longer lists this stop'),
});

function hexToRgb(hex) {
  if (!/^[0-9A-Fa-f]{6}$/.test(String(hex || ''))) return null;
  const value = Number.parseInt(hex, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * Marker colour of a station or stop.
 * @param {'metro'|'bus'|'amb'} kind
 * @param {{lines?: Array<{color: string|null}>}} place
 * @returns {[number, number, number]}
 */
export function tmbPlaceColorRgb(kind, place) {
  if (kind === 'bus') return BUS_STOP_RGB;
  if (kind === 'amb') return AMB_STOP_RGB;
  const lines = place?.lines || [];
  if (lines.length > 1) return INTERCHANGE_RGB;
  return hexToRgb(lines[0]?.color) ?? UNKNOWN_RGB;
}

function rgbHex(rgb) {
  return `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** Entity id of a station or stop: `tmb-arrivals:<kind>:<id>`. */
export function tmbPlaceEntityId(kind, id) {
  return `${LAYER_ID}:${kind}:${id}`;
}

/** Inverse of `tmbPlaceEntityId`, or null for anything else. */
export function parseTmbPlaceEntityId(entityId) {
  const match = /^tmb-arrivals:(metro|bus|amb):(\d{1,7})$/.exec(
    String(entityId || ''),
  );
  return match ? { kind: match[1], id: match[2] } : null;
}

function validLine(line) {
  return (
    line &&
    typeof line.name === 'string' &&
    Array.isArray(line.paths) &&
    line.paths.length > 0 &&
    line.paths.every(
      (path) =>
        Array.isArray(path) &&
        path.length >= 4 &&
        path.length % 2 === 0 &&
        path.every(Number.isFinite),
    )
  );
}

/**
 * Validate a bus line list (`/api/tmb/bus-lines`, `/api/amb/lines`); null
 * when it is not one.
 * @returns {{lines: object[], fetchedAt: number|null}|null}
 */
export function normalizeBusLinesPayload(payload) {
  if (!Array.isArray(payload?.lines)) return null;
  return {
    lines: payload.lines.filter(validLine),
    fetchedAt: Number.isFinite(payload.fetchedAt) ? payload.fetchedAt : null,
  };
}

/**
 * Bus route width on screen: half the metro's, and a little transparent.
 * TMB's H, V and D buses and AMB's lines share colours with metro lines;
 * the width says which is which.
 */
export const TMB_BUS_LINE_WIDTH_PX = 2;

/** Length of the pieces a bus route is drawn in, in metres. */
export const BUS_LINE_PIECE_M = 2_000;

/**
 * Cut a flat [lon, lat, …] path into consecutive pieces of about `pieceM`
 * metres that share their end points. Cesium judges an instance's display
 * distance from its centre, so a 20 km route drawn whole would vanish while
 * the camera sat over one end of it; in pieces, the routes appear around the
 * camera the way the stops do.
 * @param {number[]} flat
 * @param {number} [pieceM]
 * @returns {number[][]}
 */
export function splitPathIntoPieces(flat, pieceM = BUS_LINE_PIECE_M) {
  const pieces = [];
  let piece = [flat[0], flat[1]];
  let length = 0;
  for (let i = 2; i + 1 < flat.length; i += 2) {
    const cos = Math.cos((flat[i + 1] * Math.PI) / 180);
    length +=
      Math.hypot((flat[i] - flat[i - 2]) * cos, flat[i + 1] - flat[i - 1]) *
      111_320;
    piece.push(flat[i], flat[i + 1]);
    if (length >= pieceM && i + 2 < flat.length) {
      pieces.push(piece);
      piece = [flat[i], flat[i + 1]];
      length = 0;
    }
  }
  if (piece.length >= 4) pieces.push(piece);
  return pieces;
}

/** Validate the proxy's catalogue before replacing the last good one. */
export function normalizeTmbCatalogPayload(payload) {
  if (!Array.isArray(payload?.metro) || !Array.isArray(payload?.bus))
    return null;
  const valid = (place) =>
    place &&
    typeof place.id === 'string' &&
    typeof place.name === 'string' &&
    Number.isFinite(place.lat) &&
    Number.isFinite(place.lon) &&
    Math.abs(place.lat) <= 90 &&
    Math.abs(place.lon) <= 180;
  return {
    metro: payload.metro.filter(valid),
    bus: payload.bus.filter(valid),
    // Older servers sent no line geometry; the stations still work.
    lines: Array.isArray(payload.lines) ? payload.lines.filter(validLine) : [],
  };
}

/** Metro line width on screen. */
export const TMB_METRO_LINE_WIDTH_PX = 4;

/** Validate the AMB proxy's stop list; null when it is not one. */
export function normalizeAmbStopsPayload(payload) {
  if (!Array.isArray(payload?.stops)) return null;
  return payload.stops.filter(
    (stop) =>
      stop &&
      /^\d{6}$/.test(String(stop.id)) &&
      typeof stop.name === 'string' &&
      Number.isFinite(stop.lat) &&
      Number.isFinite(stop.lon) &&
      Math.abs(stop.lat) <= 90 &&
      Math.abs(stop.lon) <= 180,
  );
}

/**
 * Every place the layer draws, keyed by entity id. TMB's stops win where
 * AMB lists the same stop code (`alsoAmb`); AMB's fill in everywhere else.
 * @param {{metro: object[], bus: object[]}|null} tmb
 * @param {object[]|null} amb
 * @returns {Map<string, {kind: 'metro'|'bus'|'amb', place: object,
 *   alsoAmb?: boolean}>}
 */
export function mergeArrivalPlaces(tmb, amb) {
  const places = new Map();
  for (const kind of /** @type {const} */ (['metro', 'bus'])) {
    for (const place of tmb?.[kind] || [])
      places.set(tmbPlaceEntityId(kind, place.id), { kind, place });
  }
  const tmbStops = new Set((tmb?.bus || []).map((stop) => stop.id));
  for (const stop of amb || []) {
    const code = String(Number(stop.id));
    if (tmbStops.has(code)) {
      places.get(tmbPlaceEntityId('bus', code)).alsoAmb = true;
      continue;
    }
    places.set(tmbPlaceEntityId('amb', stop.id), { kind: 'amb', place: stop });
  }
  return places;
}

/**
 * What the row's pills switch: metro stations, TMB bus stops, AMB bus stops,
 * and the drawn routes (metro and bus) apart from their stops.
 */
export const TMB_ARRIVALS_DEFAULT_PARAMS = Object.freeze({
  metro: true,
  tmbBus: true,
  ambBus: true,
  lines: true,
  // Marks the stations, stops and metro lines with service alerts.
  alerts: false,
});

const TMB_ARRIVALS_CHIPS = Object.freeze([
  Object.freeze({ key: 'metro', label: msg('METRO'), title: msg('TMB metro') }),
  Object.freeze({
    key: 'tmbBus',
    label: msg('TMB BUS'),
    title: msg('TMB buses'),
  }),
  Object.freeze({
    key: 'ambBus',
    label: msg('AMB BUS'),
    title: msg('AMB metropolitan buses'),
  }),
  Object.freeze({
    key: 'lines',
    label: msg('LINES'),
    title: msg('Metro and bus routes (stops stay)'),
  }),
  Object.freeze({
    key: 'alerts',
    label: msg('ALERTS'),
    title: msg('Mark stations, stops and metro lines with service alerts'),
  }),
]);

/** The mark of a place or line with an alert: amber, as on the cards. */
const ALERT_RGB = [255, 176, 0];
const ALERT_HALO_WIDTH_PX = 9;
/** How often the ALERTS pill asks again while on. */
export const TMB_ALERT_MARKS_REFRESH_MS = 120_000;

/**
 * Entity ids the ALERTS pill marks. An AMB stop TMB also serves is drawn as
 * TMB's bus stop (`000108` is `108`).
 * @param {{metro?: string[], bus?: string[]}|null} tmb `/api/tmb/alerts`
 * @param {{stops?: string[]}|null} amb `/api/amb/alerts`
 * @param {Map<string, object>} places entity id → place
 * @returns {Set<string>}
 */
export function tmbAlertedEntityIds(tmb, amb, places) {
  const ids = new Set();
  for (const id of tmb?.metro || []) ids.add(tmbPlaceEntityId('metro', id));
  for (const id of tmb?.bus || []) ids.add(tmbPlaceEntityId('bus', id));
  for (const id of amb?.stops || []) {
    const own = tmbPlaceEntityId('amb', id);
    ids.add(
      places?.has(own) ? own : tmbPlaceEntityId('bus', String(Number(id))),
    );
  }
  return new Set([...ids].filter((id) => places?.has(id)));
}

/**
 * Whether the pills show a place. A stop both operators serve is drawn as
 * TMB's and stays while either bus pill is on.
 * @param {{kind: string, alsoAmb?: boolean}} entry
 * @param {typeof TMB_ARRIVALS_DEFAULT_PARAMS} params
 * @returns {boolean}
 */
export function tmbPlaceShown(entry, params) {
  if (entry?.kind === 'metro') return params.metro;
  if (entry?.kind === 'bus')
    return params.tmbBus || (Boolean(entry.alsoAmb) && params.ambBus);
  return entry?.kind === 'amb' && params.ambBus;
}

/**
 * The row's pills, each switching on its own.
 * @param {typeof TMB_ARRIVALS_DEFAULT_PARAMS} params
 * @returns {{chips: object[], legend: object[]}}
 */
export function tmbArrivalsRowControls(params) {
  return {
    chips: TMB_ARRIVALS_CHIPS.map(({ key, label, title }) => ({
      id: key,
      label: t(label),
      active: params[key],
      state: params[key] ? 'active' : 'idle',
      title: t(title),
      params: { [key]: !params[key] },
    })),
    legend: [],
  };
}

/**
 * The protected selected-place overlay entry, same field set as the AEMET
 * point layers' cards.
 */
export function createTmbSelectedOverlayEntry({
  kind,
  place,
  position,
  arrivals,
  status,
  error,
  now,
}) {
  if (!place || !position) return null;
  const { title, details } = buildTmbArrivalsCopy(
    { kind, place, arrivals, status, error, now },
    { t, tn, locale: getLocale() },
  );
  return {
    id: tmbPlaceEntityId(kind, place.id),
    position,
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title,
    details,
    accent: rgbHex(tmbPlaceColorRgb(kind, place)),
    interactive: false,
    anchorRadiusPx: 9,
    minAnchorGapPx: 11,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}

async function errorCodeOf(response, messages = STATUS_MESSAGES) {
  try {
    const body = await response.json();
    if (typeof body?.error === 'string' && messages[body.error])
      return body.error;
  } catch {
    /* fall through */
  }
  return response.status === 503 ? 'no_key' : 'unavailable';
}

export function createTmbArrivalsLayer({
  overlayHost = DEFAULT_OVERLAY_HOST,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = Date.now,
  setIntervalImpl = (...args) => globalThis.setInterval(...args),
  clearIntervalImpl = (...args) => globalThis.clearInterval(...args),
} = {}) {
  let _viewer = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  /** @type {Map<string, {kind: 'metro'|'bus'|'amb', place: object}>} entity id → place */
  let _places = new Map();
  /**
   * The open card: which place, what TMB last said about it, and whether a
   * request is out. `generation` discards answers for a card already closed.
   * @type {{entityId: string, kind: 'metro'|'bus'|'amb', place: object,
   *   arrivals: object|null, status: 'loading'|'ready'|'error',
   *   error: string|null, askedAt: number, inFlight: boolean,
   *   generation: number}|null}
   */
  let _selection = null;
  let _generation = 0;
  /** @type {Cesium.Entity|null} */
  let _selectedEntity = null;
  let _tick = null;
  /** @type {Cesium.ScreenSpaceEventHandler|null} */
  let _clickHandler = null;
  /** @type {Cesium.GroundPolylinePrimitive|null} metro line geometry */
  let _linesPrimitive = null;
  /** The metro lines drawn, for the ALERTS pill's halo. */
  let _metroLines = [];
  /** What the ALERTS pill marks: place entity ids and metro line names. */
  let _alertMarks = { places: new Set(), lines: new Set() };
  let _alertHalo = null;
  let _alertTick = null;
  let _alertAnswers = { tmb: null, amb: null };
  /** Bus route geometry per operator, and the server fetch time drawn. */
  const _busLines = {
    tmb: { primitive: null, key: null },
    amb: { primitive: null, key: null },
  };
  let _params = { ...TMB_ARRIVALS_DEFAULT_PARAMS };

  function _removeBusLines(operator) {
    for (const name of operator ? [operator] : ['tmb', 'amb']) {
      const slot = _busLines[name];
      if (slot.primitive && _viewer?.scene?.groundPrimitives)
        _viewer.scene.groundPrimitives.remove(slot.primitive);
      slot.primitive = null;
      slot.key = null;
    }
  }

  /** Apply the layer switch and the pills to every primitive and place. */
  function _applyVisibility() {
    if (_linesPrimitive)
      _linesPrimitive.show = _enabled && _params.metro && _params.lines;
    if (_alertHalo)
      _alertHalo.show =
        _enabled && _params.alerts && _params.metro && _params.lines;
    if (_busLines.tmb.primitive)
      _busLines.tmb.primitive.show =
        _enabled && _params.tmbBus && _params.lines;
    if (_busLines.amb.primitive)
      _busLines.amb.primitive.show =
        _enabled && _params.ambBus && _params.lines;
    if (_dataSource) {
      _dataSource.entities.suspendEvents();
      for (const entity of _dataSource.entities.values) {
        const entry = _places.get(entity.id);
        entity.show = Boolean(entry && tmbPlaceShown(entry, _params));
      }
      _dataSource.entities.resumeEvents();
    }
    // A card about a place the pills just hid closes with it.
    if (_selection) {
      const entry = _places.get(_selection.entityId);
      if (!entry || !tmbPlaceShown(entry, _params)) _clearSelection();
    }
  }

  /**
   * One operator's bus routes on the ground in their line colours, shown
   * only at street scale (the bus stops' distance), in pieces so they
   * appear around the camera. Not pickable: a click belongs to the stops.
   * @param {'tmb'|'amb'} operator
   * @param {object[]} lines
   * @param {number|null} key Server fetch time.
   */
  function _drawBusLines(operator, lines, key) {
    const slot = _busLines[operator];
    if (key !== null && key === slot.key && slot.primitive) return;
    _removeBusLines(operator);
    if (!lines.length || !_viewer?.scene?.groundPrimitives) return;
    let supported = false;
    try {
      supported = Cesium.GroundPolylinePrimitive.isSupported(_viewer.scene);
    } catch {
      supported = false; // no WebGL context to ask
    }
    if (!supported) return;
    const distance =
      new Cesium.DistanceDisplayConditionGeometryInstanceAttribute(
        0,
        TMB_BUS_MAX_DISTANCE_M + BUS_LINE_PIECE_M / 2,
      );
    const instances = [];
    for (const line of lines) {
      const [r, g, b] = hexToRgb(line.color) ?? UNKNOWN_RGB;
      const color = Cesium.ColorGeometryInstanceAttribute.fromColor(
        Cesium.Color.fromBytes(r, g, b, 170),
      );
      for (const path of line.paths) {
        for (const piece of splitPathIntoPieces(path)) {
          instances.push(
            new Cesium.GeometryInstance({
              geometry: new Cesium.GroundPolylineGeometry({
                positions: Cesium.Cartesian3.fromDegreesArray(piece),
                width: TMB_BUS_LINE_WIDTH_PX,
              }),
              attributes: { color, distanceDisplayCondition: distance },
            }),
          );
        }
      }
    }
    slot.primitive = _viewer.scene.groundPrimitives.add(
      new Cesium.GroundPolylinePrimitive({
        geometryInstances: instances,
        appearance: new Cesium.PolylineColorAppearance(),
        classificationType: Cesium.ClassificationType.BOTH,
        allowPicking: false,
        asynchronous: true,
        show: false, // _applyVisibility decides
      }),
    );
    slot.key = key;
    // The metro stays on top of the bus routes that arrive after it.
    if (_linesPrimitive)
      _viewer.scene.groundPrimitives.raiseToTop?.(_linesPrimitive);
    _applyVisibility();
  }

  let _busLinesRequest = null;
  /** Load both operators' routes (one load at a time) and draw them. */
  function _refreshBusLines() {
    _busLinesRequest ??= Promise.all([
      _loadBusLines(TMB_BUS_LINES_URL),
      _loadBusLines(AMB_LINES_URL),
    ])
      .then(([tmbBus, ambBus]) => {
        if (!_viewer) return;
        _drawBusLines('amb', ambBus.lines, ambBus.fetchedAt);
        _drawBusLines('tmb', tmbBus.lines, tmbBus.fetchedAt);
      })
      .finally(() => {
        _busLinesRequest = null;
      });
    return _busLinesRequest;
  }

  /** @returns {Promise<{lines: object[], fetchedAt: number|null}>} one operator's bus routes, or none */
  async function _loadBusLines(url) {
    try {
      const response = await fetchImpl(url);
      if (!response.ok) return { lines: [], fetchedAt: null };
      return (
        normalizeBusLinesPayload(await response.json()) || {
          lines: [],
          fetchedAt: null,
        }
      );
    } catch (error) {
      console.warn('[Data:TmbArrivals] bus routes fetch error:', error);
      return { lines: [], fetchedAt: null };
    }
  }

  function _removeAlertHalo() {
    if (_alertHalo && _viewer?.scene?.groundPrimitives)
      _viewer.scene.groundPrimitives.remove(_alertHalo);
    _alertHalo = null;
  }

  /** Restyle the places and redraw the halo from the last answers. */
  function _applyAlertMarks() {
    const on = _enabled && _params.alerts;
    _alertMarks = on
      ? {
          places: tmbAlertedEntityIds(
            _alertAnswers.tmb,
            _alertAnswers.amb,
            _places,
          ),
          lines: new Set(_alertAnswers.tmb?.lines || []),
        }
      : { places: new Set(), lines: new Set() };
    if (_dataSource) {
      _dataSource.entities.suspendEvents();
      for (const entity of _dataSource.entities.values) {
        const entry = _places.get(entity.id);
        if (!entry || !entity.point) continue;
        const marked = _alertMarks.places.has(entity.id);
        const metro = entry.kind === 'metro';
        entity.point.outlineColor = marked
          ? Cesium.Color.fromBytes(...ALERT_RGB, 255)
          : COLOR_OUTLINE;
        entity.point.outlineWidth = marked ? 3 : 1;
        entity.point.pixelSize = (metro ? 9 : 6) + (marked ? 3 : 0);
      }
      _dataSource.entities.resumeEvents();
    }
    _removeAlertHalo();
    const lines = _metroLines.filter((line) =>
      _alertMarks.lines.has(line.name),
    );
    let supported = false;
    try {
      supported =
        lines.length > 0 &&
        Boolean(_viewer?.scene?.groundPrimitives) &&
        Cesium.GroundPolylinePrimitive.isSupported(_viewer.scene);
    } catch {
      supported = false; // no WebGL context to ask
    }
    if (supported) {
      const color = Cesium.ColorGeometryInstanceAttribute.fromColor(
        Cesium.Color.fromBytes(...ALERT_RGB, 150),
      );
      _alertHalo = _viewer.scene.groundPrimitives.add(
        new Cesium.GroundPolylinePrimitive({
          geometryInstances: lines.flatMap((line) =>
            line.paths.map(
              (path) =>
                new Cesium.GeometryInstance({
                  geometry: new Cesium.GroundPolylineGeometry({
                    positions: Cesium.Cartesian3.fromDegreesArray(path),
                    width: ALERT_HALO_WIDTH_PX,
                  }),
                  attributes: { color },
                }),
            ),
          ),
          appearance: new Cesium.PolylineColorAppearance(),
          classificationType: Cesium.ClassificationType.BOTH,
          allowPicking: false,
          asynchronous: true,
          show: false,
        }),
      );
    }
    _applyVisibility();
  }

  /** Ask both operators which places have alerts; either may fail alone. */
  async function _askAlertMarks() {
    const read = async (url) => {
      try {
        const response = await fetchImpl(url);
        return response.ok ? await response.json() : null;
      } catch {
        return null;
      }
    };
    const [tmb, amb] = await Promise.all([
      read(TMB_ALERTS_URL),
      read(AMB_ALERTS_URL),
    ]);
    _alertAnswers = { tmb, amb };
    if (_params.alerts) _applyAlertMarks();
  }

  /** Start or stop asking with the ALERTS pill. */
  function _syncAlertPill() {
    const on = _enabled && _params.alerts;
    if (on && _alertTick === null) {
      void _askAlertMarks();
      _alertTick = setIntervalImpl(
        () => void _askAlertMarks(),
        TMB_ALERT_MARKS_REFRESH_MS,
      );
    } else if (!on && _alertTick !== null) {
      clearIntervalImpl(_alertTick);
      _alertTick = null;
    }
    _applyAlertMarks();
  }

  function _removeMetroLines() {
    if (_linesPrimitive && _viewer?.scene?.groundPrimitives)
      _viewer.scene.groundPrimitives.remove(_linesPrimitive);
    _linesPrimitive = null;
  }

  /**
   * TMB's metro lines on the ground in their own colours, under the station
   * points. Not pickable: a click there belongs to the stations.
   */
  function _drawMetroLines(lines) {
    _removeMetroLines();
    if (!lines.length || !_viewer?.scene?.groundPrimitives) return;
    let supported = false;
    try {
      supported = Cesium.GroundPolylinePrimitive.isSupported(_viewer.scene);
    } catch {
      supported = false; // no WebGL context to ask
    }
    if (!supported) return;
    const instances = [];
    for (const line of lines) {
      const [r, g, b] = hexToRgb(line.color) ?? UNKNOWN_RGB;
      const color = Cesium.ColorGeometryInstanceAttribute.fromColor(
        Cesium.Color.fromBytes(r, g, b, 230),
      );
      for (const path of line.paths) {
        instances.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.GroundPolylineGeometry({
              positions: Cesium.Cartesian3.fromDegreesArray(path),
              width: TMB_METRO_LINE_WIDTH_PX,
            }),
            attributes: { color },
          }),
        );
      }
    }
    _linesPrimitive = _viewer.scene.groundPrimitives.add(
      new Cesium.GroundPolylinePrimitive({
        geometryInstances: instances,
        appearance: new Cesium.PolylineColorAppearance(),
        classificationType: Cesium.ClassificationType.BOTH,
        allowPicking: false,
        asynchronous: true,
        show: _enabled,
      }),
    );
  }

  function _placePosition(place) {
    return Cesium.Cartesian3.fromDegrees(
      place.lon,
      place.lat,
      POINT_HEIGHT_OFFSET_M,
    );
  }

  function _publishCard() {
    if (!_selection) return;
    const entry = createTmbSelectedOverlayEntry({
      kind: _selection.kind,
      place: _selection.place,
      position: _placePosition(_selection.place),
      arrivals: _selection.arrivals,
      status: _selection.status,
      error: _selection.error,
      now: now(),
    });
    if (entry) {
      overlayHost.setEntries(
        TMB_ARRIVALS_SELECTED_OVERLAY_SOURCE_ID,
        [entry],
        TMB_ARRIVALS_SELECTED_OVERLAY_SOURCE_OPTIONS,
      );
    }
  }

  async function _askArrivals() {
    const selection = _selection;
    if (!selection || selection.inFlight) return;
    selection.inFlight = true;
    selection.askedAt = now();
    const { kind, place, generation } = selection;
    const messages = kind === 'amb' ? AMB_STATUS_MESSAGES : STATUS_MESSAGES;
    const operator = kind === 'amb' ? 'AMB' : 'TMB';
    let arrivals = null;
    let error = null;
    try {
      const response = await fetchImpl(arrivalsUrl(kind, place.id));
      if (response.ok) arrivals = await response.json();
      else error = messages[await errorCodeOf(response, messages)];
      if (response.ok && !Array.isArray(arrivals?.routes)) {
        arrivals = null;
        error =
          operator === 'AMB'
            ? msg('Malformed AMB answer')
            : msg('Malformed TMB answer');
      }
    } catch {
      error =
        operator === 'AMB'
          ? msg('AMB network error')
          : msg('TMB network error');
    }
    if (_selection?.generation !== generation) return;
    selection.inFlight = false;
    if (arrivals) {
      selection.arrivals = arrivals;
      selection.status = 'ready';
      selection.error = null;
    } else {
      selection.status = 'error';
      selection.error = error;
    }
    _publishCard();
  }

  function _onTick() {
    if (!_selection) return;
    if (now() - _selection.askedAt >= TMB_CARD_REFRESH_MS) void _askArrivals();
    _publishCard();
  }

  function _clearSelection() {
    if (_selection) {
      const original = _dataSource?.entities.getById(_selection.entityId);
      if (original?.point) original.point.show = true;
    }
    if (_selectedEntity && _viewer) _viewer.entities.remove(_selectedEntity);
    if (_tick !== null) clearIntervalImpl(_tick);
    _tick = null;
    _selection = null;
    _selectedEntity = null;
    overlayHost.clearSource(TMB_ARRIVALS_SELECTED_OVERLAY_SOURCE_ID);
  }

  function _selectPlace(entityId) {
    const known = _places.get(entityId);
    const original = _dataSource?.entities.getById(entityId);
    if (!known || !original || !_viewer) return;
    _clearSelection();
    _generation += 1;
    _selection = {
      entityId,
      kind: known.kind,
      place: known.place,
      arrivals: null,
      status: 'loading',
      error: null,
      askedAt: 0,
      inFlight: false,
      generation: _generation,
    };
    original.point.show = false;
    const rgb = tmbPlaceColorRgb(known.kind, known.place);
    _selectedEntity = _viewer.entities.add({
      position: _placePosition(known.place),
      point: {
        pixelSize: 14,
        color: Cesium.Color.fromBytes(rgb[0], rgb[1], rgb[2], 255),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    _publishCard();
    void _askArrivals();
    _tick = setIntervalImpl(_onTick, TMB_CARD_TICK_MS);
  }

  function _onKeyDown(e) {
    if (e.key === 'Escape' && _selection) _clearSelection();
  }

  const hasDom = () => typeof document !== 'undefined';

  function _installClickHandler(viewer) {
    if (_clickHandler || !hasDom() || !viewer?.scene?.canvas) return;
    _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      const picked = viewer.scene.pick(click.position);
      if (picked) {
        if (picked.id === _selectedEntity) return;
        const pickedId = resolvePickId(picked);
        if (parseTmbPlaceEntityId(pickedId)) {
          _selectPlace(pickedId);
          return;
        }
      }
      if (_selection) _clearSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    document.addEventListener('keydown', _onKeyDown);
  }

  function _removeClickHandler() {
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
    if (hasDom()) document.removeEventListener('keydown', _onKeyDown);
  }

  /** @returns {Promise<{catalog: object|null, code?: string, error?: string}>} */
  async function _loadTmbCatalog() {
    try {
      const response = await fetchImpl(STATIONS_URL);
      if (!response.ok) {
        const code = await errorCodeOf(response);
        return { catalog: null, code, error: STATUS_MESSAGES[code] };
      }
      const catalog = normalizeTmbCatalogPayload(await response.json());
      return catalog
        ? { catalog }
        : { catalog: null, error: msg('Malformed TMB station list') };
    } catch (error) {
      console.warn('[Data:TmbArrivals] TMB fetch error:', error);
      return { catalog: null, error: msg('TMB network error') };
    }
  }

  /** @returns {Promise<{stops: object[]|null, error?: string}>} */
  async function _loadAmbStops() {
    try {
      const response = await fetchImpl(AMB_STOPS_URL);
      if (!response.ok) return { stops: null, error: msg('AMB unavailable') };
      const stops = normalizeAmbStopsPayload(await response.json());
      return stops
        ? { stops }
        : { stops: null, error: msg('Malformed AMB stop list') };
    } catch (error) {
      console.warn('[Data:TmbArrivals] AMB fetch error:', error);
      return { stops: null, error: msg('AMB network error') };
    }
  }

  function _placeEntity(kind, place) {
    const rgb = tmbPlaceColorRgb(kind, place);
    const metro = kind === 'metro';
    // AMB stops share the TMB bus stops' street-scale distance.
    const maxDistance = metro
      ? TMB_METRO_MAX_DISTANCE_M
      : TMB_BUS_MAX_DISTANCE_M;
    return new Cesium.Entity({
      id: tmbPlaceEntityId(kind, place.id),
      position: _placePosition(place),
      point: {
        pixelSize: metro ? 9 : 6,
        color: Cesium.Color.fromBytes(rgb[0], rgb[1], rgb[2], 235),
        outlineColor: COLOR_OUTLINE,
        outlineWidth: 1,
        heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
          0,
          maxDistance,
        ),
        // Drawn over the photorealistic mesh for as far as it is drawn at all.
        // A station point averages its platforms, so it often lands under a
        // square or a building and the mesh would hide it and take the click
        // (Plaça de Catalunya). The display distance already keeps it off the
        // far side of the globe, which is why the AEMET layers depth-test.
        disableDepthTestDistance: maxDistance,
      },
      name: place.name,
    });
  }

  const layer = {
    id: LAYER_ID,
    name: 'Barcelona Arrivals (TMB · AMB)',
    icon: '🚇',
    source: 'TMB iMetro / iBus · AMB Mobilitat',
    // The catalogue changes rarely and the server keeps it for a day; this
    // only re-reads the server's copy.
    updateInterval: 3_600_000,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _places = new Map();
      overlayHost.setVisible(TMB_ARRIVALS_SELECTED_OVERLAY_SOURCE_ID, false);
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      _applyVisibility();
      overlayHost.setVisible(TMB_ARRIVALS_SELECTED_OVERLAY_SOURCE_ID, true);
      _installClickHandler(viewer);
      registerPickOwner(LAYER_ID, (pickedId) =>
        Boolean(parseTmbPlaceEntityId(pickedId)),
      );
      _syncAlertPill();
    },

    disable() {
      _enabled = false;
      _clearSelection();
      if (_dataSource) _dataSource.show = false;
      _syncAlertPill();
      overlayHost.setVisible(TMB_ARRIVALS_SELECTED_OVERLAY_SOURCE_ID, false);
      _removeClickHandler();
      unregisterPickOwner(LAYER_ID);
    },

    async update() {
      // Routes decorate the map and are large: they load on their own,
      // and the stops never wait for them.
      void _refreshBusLines();
      const [tmb, amb] = await Promise.all([
        _loadTmbCatalog(),
        _loadAmbStops(),
      ]);
      if (!tmb.catalog && !amb.stops) {
        _lastError = tmb.error || amb.error;
        return false;
      }
      if (!_dataSource) return false;
      _places = mergeArrivalPlaces(tmb.catalog, amb.stops);
      const entities = [];
      for (const [, { kind, place }] of _places)
        entities.push(_placeEntity(kind, place));
      _dataSource.entities.suspendEvents();
      _dataSource.entities.removeAll();
      for (const entity of entities) _dataSource.entities.add(entity);
      _dataSource.entities.resumeEvents();
      if (tmb.catalog) {
        _metroLines = tmb.catalog.lines || [];
        _drawMetroLines(tmb.catalog.lines);
      }
      if (_params.alerts) _applyAlertMarks();
      else _applyVisibility();
      if (_selection) {
        const still = _places.get(_selection.entityId);
        if (still) {
          _selection.place = still.place;
          _dataSource.entities.getById(_selection.entityId).point.show = false;
        } else {
          _clearSelection();
        }
      }
      _count = entities.length;
      _lastUpdate = now();
      // Half a map is still a map: say which half is missing.
      _lastError = tmb.catalog
        ? amb.stops
          ? null
          : amb.error
        : (TMB_KEY_HINT[tmb.code] ?? tmb.error);
      return true;
    },

    destroy(viewer) {
      if (_alertTick !== null) clearIntervalImpl(_alertTick);
      _alertTick = null;
      _removeAlertHalo();
      _alertAnswers = { tmb: null, amb: null };
      _removeMetroLines();
      _removeBusLines();
      _clearSelection();
      _removeClickHandler();
      unregisterPickOwner(LAYER_ID);
      overlayHost.setVisible(TMB_ARRIVALS_SELECTED_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _places = new Map();
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _viewer = null;
    },

    /**
     * Stations and stops for the analyst query engine, flattened. Arrivals
     * are not included: they are fetched per click, not held for every stop.
     */
    getAnalystRecords(maxCount = 200) {
      if (!_enabled) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 200;
      const result = [];
      for (const entry of _places.values()) {
        if (result.length >= limit) break;
        if (!tmbPlaceShown(entry, _params)) continue; // what the map shows
        const { kind, place } = entry;
        result.push({
          id: place.id,
          name: place.name,
          kind,
          lines: (place.lines || []).map((line) => line.name).join(' '),
          lat: place.lat,
          lon: place.lon,
        });
      }
      return result;
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },

    /**
     * `{metro, tmbBus, ambBus, lines, alerts}` booleans, from the row's
     * pills or a share link. Any subset may be given; unknown keys are
     * ignored.
     */
    setParams(params = {}) {
      let changed = false;
      const alertsBefore = _params.alerts;
      for (const key of Object.keys(TMB_ARRIVALS_DEFAULT_PARAMS)) {
        if (params[key] === undefined) continue;
        const next = params[key] !== false;
        if (_params[key] !== next) changed = true;
        _params[key] = next;
      }
      if (_params.alerts !== alertsBefore) _syncAlertPill();
      else if (changed) _applyVisibility();
      return true;
    },

    getParams() {
      return { ..._params };
    },

    getRowControls() {
      return tmbArrivalsRowControls(_params);
    },

    // Test-only hooks: drive the real selection state machine without a
    // Cesium click handler (no DOM under plain Node).
    _selectPlaceForTest(entityId) {
      _selectPlace(entityId);
    },
    _clearSelectionForTest() {
      _clearSelection();
    },
    _tickForTest() {
      _onTick();
    },
    _selectionForTest() {
      return _selection;
    },
  };
  return layer;
}

const tmbArrivalsLayer = createTmbArrivalsLayer();

export default tmbArrivalsLayer;
