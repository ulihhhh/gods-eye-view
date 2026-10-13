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
import { buildTmbArrivalsCopy } from './tmbArrivals.js';

/**
 * TMB next arrivals (fork-local) — Barcelona metro stations and TMB bus stops
 * as points; clicking one asks the server for its next arrivals and shows
 * them on a card that counts down and refreshes while it stays open.
 *
 * TMB publishes predictions only, no vehicle positions, so nothing here
 * moves. The developer key stays on the server: this layer only ever calls
 * `/api/tmb/stations` and `/api/tmb/arrivals/<kind>/<id>`, and without a key
 * it draws nothing and says so in its status line.
 *
 * Metro stations show from city scale; the ~2,700 bus stops only once the
 * camera is down at street scale, so a city view is not a carpet of dots.
 * Same point treatment as the AEMET point layers (RELATIVE_TO_GROUND, normal
 * depth testing).
 */

const LAYER_ID = 'tmb-arrivals';
const STATIONS_URL = '/api/tmb/stations';
const ARRIVALS_URL = '/api/tmb/arrivals';

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
export const TMB_METRO_MAX_DISTANCE_M = 40_000;
export const TMB_BUS_MAX_DISTANCE_M = 3_000;

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

/** Interchanges (several lines) are white; TMB's own line colour otherwise. */
const INTERCHANGE_RGB = [235, 235, 235];
const BUS_STOP_RGB = [218, 41, 28];
const UNKNOWN_RGB = [145, 164, 180];
const COLOR_OUTLINE = Cesium.Color.BLACK.withAlpha(0.6);
const POINT_HEIGHT_OFFSET_M = 2.0;

const STATUS_MESSAGES = Object.freeze({
  no_key: 'TMB developer key not configured — add it in POWER UP',
  rejected: 'TMB refused the developer key — check it in POWER UP',
  unavailable: 'TMB unavailable',
  busy: 'TMB request limit reached — retrying shortly',
  not_found: 'TMB no longer lists this stop',
});

function hexToRgb(hex) {
  if (!/^[0-9A-Fa-f]{6}$/.test(String(hex || ''))) return null;
  const value = Number.parseInt(hex, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * Marker colour of a station or stop.
 * @param {'metro'|'bus'} kind
 * @param {{lines?: Array<{color: string|null}>}} place
 * @returns {[number, number, number]}
 */
export function tmbPlaceColorRgb(kind, place) {
  if (kind === 'bus') return BUS_STOP_RGB;
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
  const match = /^tmb-arrivals:(metro|bus):(\d{1,7})$/.exec(
    String(entityId || ''),
  );
  return match ? { kind: match[1], id: match[2] } : null;
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
  const { title, details } = buildTmbArrivalsCopy({
    kind,
    place,
    arrivals,
    status,
    error,
    now,
  });
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

async function errorCodeOf(response) {
  try {
    const body = await response.json();
    if (typeof body?.error === 'string' && STATUS_MESSAGES[body.error])
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
  /** @type {Map<string, {kind: 'metro'|'bus', place: object}>} entity id → place */
  let _places = new Map();
  /**
   * The open card: which place, what TMB last said about it, and whether a
   * request is out. `generation` discards answers for a card already closed.
   * @type {{entityId: string, kind: 'metro'|'bus', place: object,
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
    let arrivals = null;
    let error = null;
    try {
      const response = await fetchImpl(
        `${ARRIVALS_URL}/${kind}/${encodeURIComponent(place.id)}`,
      );
      if (response.ok) arrivals = await response.json();
      else error = STATUS_MESSAGES[await errorCodeOf(response)];
      if (response.ok && !Array.isArray(arrivals?.routes)) {
        arrivals = null;
        error = 'Malformed TMB answer';
      }
    } catch {
      error = 'TMB network error';
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

  function _placeEntity(kind, place) {
    const rgb = tmbPlaceColorRgb(kind, place);
    const metro = kind === 'metro';
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
    name: 'TMB Arrivals',
    icon: '🚇',
    source: 'TMB iMetro / iBus · Barcelona',
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
      overlayHost.setVisible(TMB_ARRIVALS_SELECTED_OVERLAY_SOURCE_ID, true);
      _installClickHandler(viewer);
      registerPickOwner(LAYER_ID, (pickedId) =>
        Boolean(parseTmbPlaceEntityId(pickedId)),
      );
    },

    disable() {
      _enabled = false;
      _clearSelection();
      if (_dataSource) _dataSource.show = false;
      overlayHost.setVisible(TMB_ARRIVALS_SELECTED_OVERLAY_SOURCE_ID, false);
      _removeClickHandler();
      unregisterPickOwner(LAYER_ID);
    },

    async update() {
      try {
        const response = await fetchImpl(STATIONS_URL);
        if (!response.ok) {
          _lastError = STATUS_MESSAGES[await errorCodeOf(response)];
          return false;
        }
        const catalog = normalizeTmbCatalogPayload(await response.json());
        if (!catalog) {
          _lastError = 'Malformed TMB station list';
          return false;
        }
        if (!_dataSource) return false;
        const nextPlaces = new Map();
        const entities = [];
        for (const kind of /** @type {const} */ (['metro', 'bus'])) {
          for (const place of catalog[kind]) {
            nextPlaces.set(tmbPlaceEntityId(kind, place.id), { kind, place });
            entities.push(_placeEntity(kind, place));
          }
        }
        _dataSource.entities.suspendEvents();
        _dataSource.entities.removeAll();
        for (const entity of entities) _dataSource.entities.add(entity);
        _dataSource.entities.resumeEvents();
        _places = nextPlaces;
        if (_selection) {
          const still = _places.get(_selection.entityId);
          if (still) {
            _selection.place = still.place;
            _dataSource.entities.getById(_selection.entityId).point.show =
              false;
          } else {
            _clearSelection();
          }
        }
        _count = entities.length;
        _lastUpdate = now();
        _lastError = null;
        return true;
      } catch (error) {
        console.warn('[Data:TmbArrivals] Fetch error:', error);
        _lastError = 'TMB network error';
        return false;
      }
    },

    destroy(viewer) {
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
      for (const { kind, place } of _places.values()) {
        if (result.length >= limit) break;
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
