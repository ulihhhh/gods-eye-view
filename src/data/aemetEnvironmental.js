import * as Cesium from 'cesium';
import { registerPickOwner, resolvePickId, unregisterPickOwner } from './pickRegistry.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';

/**
 * AEMET OpenData environmental networks (Phase A10) — ozone and solar
 * radiation, the plan's one deliberate exception to "one layer per dataset
 * for now": both are small, sparse station networks (a few dozen sites
 * each) sharing the same shape (points, joined to `aemetStations.js`'s own
 * station list by `idema`), too thin individually to justify separate
 * toggle-panel rows.
 *
 * The plan's guessed endpoint paths (`redes-especiales/ozono`, `.../
 * radiacion`) don't exist; the real ones — found in AEMET's own published
 * OpenAPI spec, not guessed — are `red/especial/ozono` and `red/especial/
 * radiacion`, and return **CSV, not JSON**, genuinely UTF-8-encoded (the
 * first AEMET feed in this app where that's actually true rather than a
 * lying ISO-8859-15 declaration) — see `weatherProviderRequests.js`'s own
 * section comment and `aemetEnvironmentalProxy()`'s for the full trail.
 *
 * A network-type chip (matching the plan's own proposal) switches which
 * metric drives point color; the other metric is always shown on the
 * click-to-inspect card regardless of the active chip, since a station can
 * report ozone, radiation, or both.
 */

export const AEMET_ENVIRONMENTAL_SELECTED_OVERLAY_SOURCE_ID = 'aemet-environmental-selected';
export const AEMET_ENVIRONMENTAL_SELECTED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

const API_URL = '/api/aemet/environmental';

const COLOR_UNKNOWN_RGB = [90, 100, 110];
const COLOR_OUTLINE = Cesium.Color.BLACK.withAlpha(0.6);
const POINT_ALPHA = 0.92;
/** Same reasoning as `aemetStations.js`'s identical constant — RELATIVE_TO_GROUND does the real clamping work. */
const POINT_HEIGHT_OFFSET_M = 2.0;

/** Real-world total-column-ozone range over Spain (Dobson Units) — confirmed live, values cluster 280-315. */
export const OZONE_COLOR_STOPS = Object.freeze([
  Object.freeze({ du: 260, rgb: [80, 90, 220] }),
  Object.freeze({ du: 285, rgb: [110, 170, 230] }),
  Object.freeze({ du: 300, rgb: [160, 210, 160] }),
  Object.freeze({ du: 315, rgb: [230, 190, 90] }),
  Object.freeze({ du: 340, rgb: [220, 110, 60] }),
]);

/** Real-world daily global-radiation-sum range over Spain (10·kJ/m²) — confirmed live, values cluster 1500-3600. */
export const RADIATION_COLOR_STOPS = Object.freeze([
  Object.freeze({ sum: 500, rgb: [60, 70, 140] }),
  Object.freeze({ sum: 1500, rgb: [70, 140, 200] }),
  Object.freeze({ sum: 2500, rgb: [230, 200, 70] }),
  Object.freeze({ sum: 3600, rgb: [230, 110, 30] }),
]);

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function interpolateStops(value, stops, keyName) {
  if (!Number.isFinite(value)) return null;
  if (value <= stops[0][keyName]) return stops[0].rgb;
  if (value >= stops[stops.length - 1][keyName]) return stops[stops.length - 1].rgb;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (value >= a[keyName] && value <= b[keyName]) {
      const t = (value - a[keyName]) / (b[keyName] - a[keyName]);
      return [
        Math.round(lerp(a.rgb[0], b.rgb[0], t)),
        Math.round(lerp(a.rgb[1], b.rgb[1], t)),
        Math.round(lerp(a.rgb[2], b.rgb[2], t)),
      ];
    }
  }
  return stops[stops.length - 1].rgb; // unreachable, kept for defensiveness
}

/** @param {number} ozoneDobson @returns {[number,number,number]|null} */
export function ozoneColorRgb(ozoneDobson) {
  return interpolateStops(ozoneDobson, OZONE_COLOR_STOPS, 'du');
}

/** @param {number} globalRadiationSum @returns {[number,number,number]|null} */
export function radiationColorRgb(globalRadiationSum) {
  return interpolateStops(globalRadiationSum, RADIATION_COLOR_STOPS, 'sum');
}

/** RGB bytes → a Cesium.Color at this layer's standard marker alpha. */
function colorFromRgb([r, g, b], alpha = POINT_ALPHA) {
  return Cesium.Color.fromBytes(r, g, b, Math.round(alpha * 255));
}

/**
 * The color a station's point should show under a given network-type mode —
 * `COLOR_UNKNOWN_RGB` when that station has no reading for the active
 * network (e.g. a radiation-only station while the ozone chip is active).
 * Pure, exported for tests.
 * @param {object} station
 * @param {'ozone'|'radiation'} networkType
 * @param {number} [alpha]
 * @returns {Cesium.Color}
 */
export function environmentalStationColor(station, networkType, alpha = POINT_ALPHA) {
  const rgb = networkType === 'radiation'
    ? radiationColorRgb(station?.globalRadiationSum)
    : ozoneColorRgb(station?.ozoneDobson);
  return colorFromRgb(rgb ?? COLOR_UNKNOWN_RGB, alpha);
}

/**
 * Title + detail lines for the in-world selected-station card. Always shows
 * both metrics when known, regardless of the active chip. Pure, exported
 * for tests.
 * @param {object} station
 * @returns {{title: string, details: string[]}}
 */
export function buildAemetEnvironmentalSelectionCopy(station) {
  const title = station?.name || station?.indicativo || 'Station';
  const details = [];
  details.push(Number.isFinite(station?.ozoneDobson) ? `Ozone ${station.ozoneDobson} DU` : 'Ozone: no data');
  details.push(
    Number.isFinite(station?.globalRadiationSum)
      ? `Radiation ${station.globalRadiationSum} (10·kJ/m²)`
      : 'Radiation: no data',
  );
  return { title, details };
}

/**
 * Build the protected selected-station overlay entry. Mirrors
 * `createAemetUvIndexSelectedOverlayEntry`'s field set exactly.
 * @param {string} id
 * @param {Cesium.Cartesian3} position
 * @param {object} station
 * @param {'ozone'|'radiation'} networkType
 * @returns {object|null}
 */
export function createAemetEnvironmentalSelectedOverlayEntry(id, position, station, networkType) {
  if (!id || !position) return null;
  const { title, details } = buildAemetEnvironmentalSelectionCopy(station);
  const rgb = networkType === 'radiation'
    ? (radiationColorRgb(station?.globalRadiationSum) ?? COLOR_UNKNOWN_RGB)
    : (ozoneColorRgb(station?.ozoneDobson) ?? COLOR_UNKNOWN_RGB);
  return {
    id: String(id),
    position,
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title,
    details,
    accent: `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`,
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

/** Validate the proxy's payload shape before replacing the last good snapshot. */
export function normalizeAemetEnvironmentalPayload(payload) {
  if (!Array.isArray(payload?.stations)) return null;
  const rows = [];
  for (const station of payload.stations) {
    const lat = Number(station?.lat);
    const lon = Number(station?.lon);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) continue;
    if (!station?.indicativo || !station?.name) continue;
    rows.push(station);
  }
  return rows;
}

export function createAemetEnvironmentalLayer({ overlayHost = DEFAULT_OVERLAY_HOST } = {}) {
  let _viewer = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  /** @type {'ozone'|'radiation'} */
  let _networkType = 'ozone';
  /** @type {Map<string, object>} indicativo -> its latest normalized station record */
  let _stationById = new Map();
  /** @type {string|null} currently selected station's indicativo, or null */
  let _selectedId = null;
  /** @type {Cesium.Entity|null} the enlarged highlight point for the selection */
  let _selectedEntity = null;
  /** @type {Cesium.ScreenSpaceEventHandler|null} */
  let _clickHandler = null;

  /** Same RELATIVE_TO_GROUND treatment as `aemetStations.js`/`aemetUvIndex.js` — see their own comments for why. */
  function _stationPosition(station) {
    return Cesium.Cartesian3.fromDegrees(station.lon, station.lat, POINT_HEIGHT_OFFSET_M);
  }

  function _recolorAll() {
    if (!_dataSource) return;
    for (const entity of _dataSource.entities.values) {
      if (entity === _selectedEntity) continue;
      const id = String(entity.id || '').slice('aemet-environmental:'.length);
      const station = _stationById.get(id);
      if (station && entity.point) entity.point.color = environmentalStationColor(station, _networkType);
    }
  }

  function _clearSelection() {
    if (_selectedId) {
      const original = _dataSource?.entities.getById(`aemet-environmental:${_selectedId}`);
      if (original?.point) original.point.show = true;
    }
    if (_selectedEntity && _viewer) _viewer.entities.remove(_selectedEntity);
    _selectedId = null;
    _selectedEntity = null;
    overlayHost.clearSource(AEMET_ENVIRONMENTAL_SELECTED_OVERLAY_SOURCE_ID);
  }

  function _selectStation(id) {
    const station = _stationById.get(id);
    const original = _dataSource?.entities.getById(`aemet-environmental:${id}`);
    if (!station || !original?.position || !_viewer) return;
    _clearSelection();
    _selectedId = id;
    original.point.show = false;
    const position = original.position.getValue(Cesium.JulianDate.now());
    _selectedEntity = _viewer.entities.add({
      position,
      point: {
        pixelSize: 14,
        color: environmentalStationColor(station, _networkType, 1),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    const entry = createAemetEnvironmentalSelectedOverlayEntry(id, position, station, _networkType);
    if (entry) {
      overlayHost.setEntries(
        AEMET_ENVIRONMENTAL_SELECTED_OVERLAY_SOURCE_ID,
        [entry],
        AEMET_ENVIRONMENTAL_SELECTED_OVERLAY_SOURCE_OPTIONS,
      );
    }
  }

  function _onKeyDown(e) {
    if (e.key === 'Escape' && _selectedId) _clearSelection();
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
        if (pickedId?.startsWith('aemet-environmental:')) {
          _selectStation(pickedId.slice('aemet-environmental:'.length));
          return;
        }
      }
      if (_selectedId) _clearSelection();
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

  const layer = {
    id: 'aemet-environmental',
    name: 'AEMET Environmental Networks',
    icon: '🧪',
    source: 'AEMET OpenData · Spain',
    updateInterval: 300000,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('aemet-environmental');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _networkType = 'ozone';
      _stationById = new Map();
      overlayHost.setVisible(AEMET_ENVIRONMENTAL_SELECTED_OVERLAY_SOURCE_ID, false);
      console.log('[Data:AemetEnvironmental] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(AEMET_ENVIRONMENTAL_SELECTED_OVERLAY_SOURCE_ID, true);
      _installClickHandler(viewer);
      registerPickOwner('aemet-environmental', (pickedId) => String(pickedId).startsWith('aemet-environmental:'));
    },

    disable() {
      _enabled = false;
      _clearSelection();
      if (_dataSource) _dataSource.show = false;
      overlayHost.setVisible(AEMET_ENVIRONMENTAL_SELECTED_OVERLAY_SOURCE_ID, false);
      _removeClickHandler();
      unregisterPickOwner('aemet-environmental');
    },

    /**
     * `{ networkType: 'ozone'|'radiation' }` switches which metric drives
     * point color — the network-type chip this phase's plan called for.
     * Rejects (`false`) any other value; both metrics stay visible on the
     * click card regardless of which is active.
     */
    setParams(params = {}) {
      if (params.networkType !== undefined) {
        if (params.networkType !== 'ozone' && params.networkType !== 'radiation') return false;
        if (params.networkType !== _networkType) {
          _networkType = params.networkType;
          _recolorAll();
          if (_selectedId) _selectStation(_selectedId); // re-render the highlight + card in the new mode
        }
      }
      return true;
    },

    getRowControls() {
      const isOzone = _networkType === 'ozone';
      return {
        chips: [{
          id: 'networkType',
          label: isOzone ? 'OZONE' : 'RADIATION',
          active: true,
          state: 'active',
          title: isOzone
            ? 'Coloring by total-column ozone — click to switch to solar radiation'
            : 'Coloring by daily solar radiation — click to switch to ozone',
          params: { networkType: isOzone ? 'radiation' : 'ozone' },
        }],
        legend: [],
      };
    },

    async update() {
      try {
        const response = await fetch(API_URL);
        if (response.status === 503) {
          _lastError = 'AEMET_API_KEY not configured';
          return false;
        }
        if (!response.ok) {
          _lastError = `AEMET HTTP ${response.status}`;
          console.warn(`[Data:AemetEnvironmental] API returned ${response.status}`);
          return false;
        }

        const payload = await response.json();
        const stations = normalizeAemetEnvironmentalPayload(payload);
        if (!stations) {
          _lastError = 'Malformed AEMET response';
          return false;
        }

        const nextEntities = [];
        const nextStationById = new Map();
        for (const station of stations) {
          nextStationById.set(station.indicativo, station);
          nextEntities.push(new Cesium.Entity({
            id: `aemet-environmental:${station.indicativo}`,
            position: _stationPosition(station),
            point: {
              pixelSize: 9,
              color: environmentalStationColor(station, _networkType),
              outlineColor: COLOR_OUTLINE,
              outlineWidth: 1,
              heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
              // Deliberately NOT disableDepthTestDistance — normal depth
              // testing against the globe hides a station on the far side
              // of Earth, same as aemetStations.js/aemetUvIndex.js.
            },
            name: station.name || station.indicativo,
            properties: { ...station },
          }));
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        _stationById = nextStationById;

        if (_selectedId) {
          if (_stationById.has(_selectedId)) _selectStation(_selectedId);
          else _clearSelection();
        }

        _count = stations.length;
        _lastUpdate = Date.now();
        _lastError = payload.stale ? 'Serving stale AEMET data (upstream unavailable)' : null;
        console.log(`[Data:AemetEnvironmental] Updated: ${_count} stations`);
        return true;
      } catch (e) {
        console.warn('[Data:AemetEnvironmental] Fetch error:', e);
        _lastError = 'AEMET network error';
        return false;
      }
    },

    destroy(viewer) {
      _clearSelection();
      _removeClickHandler();
      unregisterPickOwner('aemet-environmental');
      overlayHost.setVisible(AEMET_ENVIRONMENTAL_SELECTED_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _stationById = new Map();
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _viewer = null;
    },

    /** Snapshot the layer's in-memory stations as plain JSON-safe objects for the analyst query engine. */
    getAnalystRecords(maxCount = 200) {
      if (!_dataSource || !_dataSource.show) return [];
      const entities = _dataSource.entities.values;
      if (!entities.length) return [];
      const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 200;
      const now = Cesium.JulianDate.now();
      const result = [];
      for (const entity of entities) {
        if (result.length >= limit) break;
        const p = entity.properties;
        const get = (key) => p?.[key]?.getValue(now) ?? null;
        result.push({
          indicativo: get('indicativo'),
          name: get('name'),
          lat: get('lat'),
          lon: get('lon'),
          ozoneDobson: get('ozoneDobson'),
          globalRadiationSum: get('globalRadiationSum'),
        });
      }
      return result;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },

    // Test-only hooks: exercise the real selection state machine directly,
    // bypassing Cesium.ScreenSpaceEventHandler/document (unavailable under
    // plain Node — see hasDom() above), same as aemetUvIndex.js's own hooks.
    _selectStationForTest(id) {
      _selectStation(id);
    },
    _clearSelectionForTest() {
      _clearSelection();
    },
    _selectedIdForTest() {
      return _selectedId;
    },
    _networkTypeForTest() {
      return _networkType;
    },
  };
  return layer;
}

const aemetEnvironmentalLayer = createAemetEnvironmentalLayer();

export default aemetEnvironmentalLayer;
