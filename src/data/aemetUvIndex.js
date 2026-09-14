import * as Cesium from 'cesium';
import { registerPickOwner, resolvePickId, unregisterPickOwner } from './pickRegistry.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';

/**
 * AEMET OpenData UV-index forecast (Phase A8) — a real point layer, not the
 * ambient-thumbnail shape Phases A4/A5 needed: `prediccion/especifica/uvi/0`
 * returns plain structured JSON (59 provincial-capital cities, each keyed by
 * the same 5-digit INE municipio code `maestro/municipios` already uses),
 * joined to real lat/lon server-side by `aemetUvIndexProxy()`. This layer's
 * job is exactly `aemetStations.js`'s: colored points + click-to-inspect,
 * mirrored rather than shared (this codebase's convention for per-layer
 * variations on a proven pattern).
 *
 * Points use the SAME `RELATIVE_TO_GROUND` + no-`disableDepthTestDistance`
 * treatment Phase A0 arrived at only after two rounds of live-verified
 * bugs (terrain sinking, globe-occlusion failure) — applied here from the
 * start rather than re-discovering it.
 */

export const AEMET_UV_INDEX_SELECTED_OVERLAY_SOURCE_ID = 'aemet-uv-index-selected';
export const AEMET_UV_INDEX_SELECTED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

const API_URL = '/api/aemet/uv-index';

const COLOR_UNKNOWN_RGB = [145, 164, 180];
const COLOR_OUTLINE = Cesium.Color.BLACK.withAlpha(0.6);
const POINT_ALPHA = 0.92;
/** Same reasoning as `aemetStations.js`'s identical constant — RELATIVE_TO_GROUND does the real clamping work. */
const POINT_HEIGHT_OFFSET_M = 2.0;

/**
 * WHO/EPA-standard UV Index scale stops (Low/Moderate/High/Very High/
 * Extreme), continuously interpolated between neighbors — same "gradient,
 * not stepped bands" approach `TEMPERATURE_COLOR_STOPS` uses, for the same
 * reason: two close UV values (e.g. 7 and 8, the High/Very-High boundary)
 * should read as visibly different, not identical within a band.
 */
export const UV_INDEX_COLOR_STOPS = Object.freeze([
  Object.freeze({ uv: 0, rgb: [65, 176, 60] }), // Low
  Object.freeze({ uv: 3, rgb: [255, 215, 0] }), // Moderate
  Object.freeze({ uv: 6, rgb: [255, 140, 0] }), // High
  Object.freeze({ uv: 8, rgb: [220, 20, 20] }), // Very High
  Object.freeze({ uv: 11, rgb: [140, 40, 200] }), // Extreme
]);

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Interpolate a UV index value to an [r,g,b] byte triple along
 * `UV_INDEX_COLOR_STOPS`. Values outside the range clamp to the nearest end
 * stop. Returns `null` for a non-finite input.
 * @param {number} uvIndex
 * @returns {[number, number, number]|null}
 */
export function uvIndexColorRgb(uvIndex) {
  if (!Number.isFinite(uvIndex)) return null;
  const stops = UV_INDEX_COLOR_STOPS;
  if (uvIndex <= stops[0].uv) return stops[0].rgb;
  if (uvIndex >= stops[stops.length - 1].uv) return stops[stops.length - 1].rgb;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (uvIndex >= a.uv && uvIndex <= b.uv) {
      const t = (uvIndex - a.uv) / (b.uv - a.uv);
      return [
        Math.round(lerp(a.rgb[0], b.rgb[0], t)),
        Math.round(lerp(a.rgb[1], b.rgb[1], t)),
        Math.round(lerp(a.rgb[2], b.rgb[2], t)),
      ];
    }
  }
  return stops[stops.length - 1].rgb; // unreachable, kept for defensiveness
}

/**
 * WHO's named UV Index risk category for a value, or `null` when unknown.
 * @param {number} uvIndex
 * @returns {string|null}
 */
export function uvIndexCategory(uvIndex) {
  if (!Number.isFinite(uvIndex)) return null;
  if (uvIndex < 3) return 'Low';
  if (uvIndex < 6) return 'Moderate';
  if (uvIndex < 8) return 'High';
  if (uvIndex < 11) return 'Very High';
  return 'Extreme';
}

/** RGB bytes → a Cesium.Color at this layer's standard marker alpha. */
function colorFromRgb([r, g, b], alpha = POINT_ALPHA) {
  return Cesium.Color.fromBytes(r, g, b, Math.round(alpha * 255));
}

function uvIndexColor(uvIndex, alpha = POINT_ALPHA) {
  return colorFromRgb(uvIndexColorRgb(uvIndex) ?? COLOR_UNKNOWN_RGB, alpha);
}

/**
 * Title + detail lines for the in-world selected-city card. Pure, exported
 * for tests.
 * @param {object} city
 * @returns {{title: string, details: string[]}}
 */
export function buildAemetUvIndexSelectionCopy(city) {
  const title = city?.name || city?.municipioId || 'City';
  const category = uvIndexCategory(city?.uvIndex);
  const details = [
    `UV index ${Number.isFinite(city?.uvIndex) ? city.uvIndex : '—'}${category ? ` · ${category}` : ''}`,
  ];
  return { title, details };
}

/**
 * Build the protected selected-city overlay entry. Mirrors
 * `createAemetStationSelectedOverlayEntry`'s field set exactly.
 * @param {string} id
 * @param {Cesium.Cartesian3} position
 * @param {object} city
 * @returns {object|null}
 */
export function createAemetUvIndexSelectedOverlayEntry(id, position, city) {
  if (!id || !position) return null;
  const { title, details } = buildAemetUvIndexSelectionCopy(city);
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
    accent: `#${(uvIndexColorRgb(city?.uvIndex) ?? COLOR_UNKNOWN_RGB).map((c) => c.toString(16).padStart(2, '0')).join('')}`,
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
export function normalizeAemetUvIndexPayload(payload) {
  if (!Array.isArray(payload?.cities)) return null;
  const rows = [];
  for (const city of payload.cities) {
    const lat = Number(city?.lat);
    const lon = Number(city?.lon);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) continue;
    if (!city?.municipioId || !Number.isFinite(city?.uvIndex)) continue;
    rows.push(city);
  }
  return rows;
}

export function createAemetUvIndexLayer({ overlayHost = DEFAULT_OVERLAY_HOST } = {}) {
  let _viewer = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  /** @type {Map<string, object>} municipio id -> its latest normalized city record */
  let _cityById = new Map();
  /** @type {string|null} currently selected city's municipio id, or null */
  let _selectedId = null;
  /** @type {Cesium.Entity|null} the enlarged highlight point for the selection */
  let _selectedEntity = null;
  /** @type {Cesium.ScreenSpaceEventHandler|null} */
  let _clickHandler = null;

  /** Same RELATIVE_TO_GROUND treatment as `aemetStations.js` — see its own comment for why. */
  function _cityPosition(city) {
    return Cesium.Cartesian3.fromDegrees(city.lon, city.lat, POINT_HEIGHT_OFFSET_M);
  }

  function _clearSelection() {
    if (_selectedId) {
      const original = _dataSource?.entities.getById(`aemet-uv-index:${_selectedId}`);
      if (original?.point) original.point.show = true;
    }
    if (_selectedEntity && _viewer) _viewer.entities.remove(_selectedEntity);
    _selectedId = null;
    _selectedEntity = null;
    overlayHost.clearSource(AEMET_UV_INDEX_SELECTED_OVERLAY_SOURCE_ID);
  }

  function _selectCity(id) {
    const city = _cityById.get(id);
    const original = _dataSource?.entities.getById(`aemet-uv-index:${id}`);
    if (!city || !original?.position || !_viewer) return;
    _clearSelection();
    _selectedId = id;
    original.point.show = false;
    const position = original.position.getValue(Cesium.JulianDate.now());
    _selectedEntity = _viewer.entities.add({
      position,
      point: {
        pixelSize: 14,
        color: uvIndexColor(city.uvIndex, 1),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
        // Only the ONE selected marker skips depth testing, matching
        // aemetStations.js's exact convention.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    const entry = createAemetUvIndexSelectedOverlayEntry(id, position, city);
    if (entry) {
      overlayHost.setEntries(
        AEMET_UV_INDEX_SELECTED_OVERLAY_SOURCE_ID,
        [entry],
        AEMET_UV_INDEX_SELECTED_OVERLAY_SOURCE_OPTIONS,
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
        if (pickedId?.startsWith('aemet-uv-index:')) {
          _selectCity(pickedId.slice('aemet-uv-index:'.length));
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
    id: 'aemet-uv-index',
    name: 'AEMET UV Index',
    icon: '☀',
    source: 'AEMET OpenData · Spain',
    updateInterval: 300000,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('aemet-uv-index');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _cityById = new Map();
      overlayHost.setVisible(AEMET_UV_INDEX_SELECTED_OVERLAY_SOURCE_ID, false);
      console.log('[Data:AemetUvIndex] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(AEMET_UV_INDEX_SELECTED_OVERLAY_SOURCE_ID, true);
      _installClickHandler(viewer);
      registerPickOwner('aemet-uv-index', (pickedId) => String(pickedId).startsWith('aemet-uv-index:'));
    },

    disable() {
      _enabled = false;
      _clearSelection();
      if (_dataSource) _dataSource.show = false;
      overlayHost.setVisible(AEMET_UV_INDEX_SELECTED_OVERLAY_SOURCE_ID, false);
      _removeClickHandler();
      unregisterPickOwner('aemet-uv-index');
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
          console.warn(`[Data:AemetUvIndex] API returned ${response.status}`);
          return false;
        }

        const payload = await response.json();
        const cities = normalizeAemetUvIndexPayload(payload);
        if (!cities) {
          _lastError = 'Malformed AEMET response';
          return false;
        }

        const nextEntities = [];
        const nextCityById = new Map();
        for (const city of cities) {
          nextCityById.set(city.municipioId, city);
          nextEntities.push(new Cesium.Entity({
            id: `aemet-uv-index:${city.municipioId}`,
            position: _cityPosition(city),
            point: {
              pixelSize: 9,
              color: uvIndexColor(city.uvIndex),
              outlineColor: COLOR_OUTLINE,
              outlineWidth: 1,
              heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
              // Deliberately NOT disableDepthTestDistance — normal depth
              // testing against the globe hides a city on the far side of
              // Earth, same as aemetStations.js.
            },
            name: city.name || city.municipioId,
            properties: { ...city },
          }));
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        _cityById = nextCityById;

        if (_selectedId) {
          if (_cityById.has(_selectedId)) _selectCity(_selectedId);
          else _clearSelection();
        }

        _count = cities.length;
        _lastUpdate = Date.now();
        _lastError = payload.stale ? 'Serving stale AEMET data (upstream unavailable)' : null;
        console.log(`[Data:AemetUvIndex] Updated: ${_count} cities`);
        return true;
      } catch (e) {
        console.warn('[Data:AemetUvIndex] Fetch error:', e);
        _lastError = 'AEMET network error';
        return false;
      }
    },

    destroy(viewer) {
      _clearSelection();
      _removeClickHandler();
      unregisterPickOwner('aemet-uv-index');
      overlayHost.setVisible(AEMET_UV_INDEX_SELECTED_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _cityById = new Map();
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _viewer = null;
    },

    /** Snapshot the layer's in-memory cities as plain JSON-safe objects for the analyst query engine. */
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
          municipioId: get('municipioId'),
          name: get('name'),
          lat: get('lat'),
          lon: get('lon'),
          uvIndex: get('uvIndex'),
          isCanaryIslands: get('isCanaryIslands'),
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
    // plain Node — see hasDom() above), same as aemetStations.js's own hooks.
    _selectCityForTest(id) {
      _selectCity(id);
    },
    _clearSelectionForTest() {
      _clearSelection();
    },
    _selectedIdForTest() {
      return _selectedId;
    },
  };
  return layer;
}

const aemetUvIndexLayer = createAemetUvIndexLayer();

export default aemetUvIndexLayer;
