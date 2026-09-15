import * as Cesium from 'cesium';
import { registerPickOwner, resolvePickId, unregisterPickOwner } from './pickRegistry.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';

/**
 * AEMET OpenData beach forecast (Phase A7) — a real point layer, same shape
 * as `aemetUvIndex.js`. This plan originally flagged the phase as blocked
 * ("no beach code/coordinate list exists in this API"), the same kind of
 * problem A6's maritime forecast is still stuck on — but a real fix exists:
 * AEMET's own public website widget serves a keyless GeoJSON nomenclator of
 * every beach it forecasts for (160 nationwide), and its id scheme is
 * confirmed live to match `prediccion/especifica/playa/{id}` exactly. See
 * `AEMET_BEACHES_NOMENCLATOR_URL`'s comment in weatherProviderRequests.js
 * for the full trail; `aemetBeachesProxy()` does the nomenclator join and
 * the (necessarily per-beach) forecast sweep server-side, so this layer
 * only ever sees a flat, ready-to-plot array.
 *
 * Points are colored by water temperature — the one number a beachgoer
 * actually plans around — on a continuous gradient scaled to the real
 * range Spanish coastal waters see, not `temperatureColorScale.js`'s much
 * wider air-temperature scale. Same `RELATIVE_TO_GROUND` + no-
 * `disableDepthTestDistance` treatment Phase A0 established, applied from
 * the start.
 */

export const AEMET_BEACHES_SELECTED_OVERLAY_SOURCE_ID = 'aemet-beaches-selected';
export const AEMET_BEACHES_SELECTED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

const API_URL = '/api/aemet/beaches';

const COLOR_UNKNOWN_RGB = [145, 164, 180];
const COLOR_OUTLINE = Cesium.Color.BLACK.withAlpha(0.6);
const POINT_ALPHA = 0.92;
/** Same reasoning as `aemetStations.js`'s identical constant — RELATIVE_TO_GROUND does the real clamping work. */
const POINT_HEIGHT_OFFSET_M = 2.0;

/**
 * Sea-surface water temperature stops for Spanish coastal waters — a
 * narrower range than `temperatureColorScale.js`'s air-temperature scale
 * (winter Cantabrian/Atlantic lows around 14°C up to open-water summer
 * norms in the high 20s), but reusing that scale's exact blue → cyan →
 * green → yellow-green → gold → orange → red hues at each corresponding
 * stop, remapped onto water's own range — the same color always means the
 * same "how hot" regardless of whether it's air or sea temperature, and it
 * keeps both scales' "no red-green-only transitions" colorblind-safe
 * property.
 *
 * The top stop was 29°C until AEMET's and buoy-network records made that
 * clearly too low: Spain's Mediterranean coast has repeatedly logged
 * confirmed marine-heatwave readings above it in recent summers — the
 * Balearic Sea's basin-wide average hit 29.3°C on 11 Aug 2022, and the
 * Dragonera buoy alone hit 31.9°C on 12 Aug 2024 — so 29°C was clamping a
 * genuine "the sea is dangerously warm" reading to the same orange as an
 * ordinary summer day. Extended to 32°C with `temperatureColorScale.js`'s
 * 39°C red as the new top anchor, the same "give the exceptional reading
 * its own color" fix applied there.
 */
export const WATER_TEMP_COLOR_STOPS = Object.freeze([
  Object.freeze({ c: 14, rgb: [60, 130, 255] }),
  Object.freeze({ c: 18, rgb: [65, 190, 230] }),
  Object.freeze({ c: 21, rgb: [90, 210, 150] }),
  Object.freeze({ c: 24, rgb: [160, 220, 90] }),
  Object.freeze({ c: 26, rgb: [255, 200, 50] }),
  Object.freeze({ c: 29, rgb: [255, 130, 40] }),
  Object.freeze({ c: 32, rgb: [225, 50, 40] }),
]);

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Interpolate a water temperature (°C) to an [r,g,b] byte triple along
 * WATER_TEMP_COLOR_STOPS. Values outside the range clamp to the nearest end
 * stop. Returns `null` for a non-finite input.
 * @param {number} waterTempC
 * @returns {[number, number, number]|null}
 */
export function waterTempColorRgb(waterTempC) {
  if (!Number.isFinite(waterTempC)) return null;
  const stops = WATER_TEMP_COLOR_STOPS;
  if (waterTempC <= stops[0].c) return stops[0].rgb;
  if (waterTempC >= stops[stops.length - 1].c) return stops[stops.length - 1].rgb;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (waterTempC >= a.c && waterTempC <= b.c) {
      const t = (waterTempC - a.c) / (b.c - a.c);
      return [
        Math.round(lerp(a.rgb[0], b.rgb[0], t)),
        Math.round(lerp(a.rgb[1], b.rgb[1], t)),
        Math.round(lerp(a.rgb[2], b.rgb[2], t)),
      ];
    }
  }
  return stops[stops.length - 1].rgb; // unreachable, kept for defensiveness
}

/** RGB bytes → a Cesium.Color at this layer's standard marker alpha. */
function colorFromRgb([r, g, b], alpha = POINT_ALPHA) {
  return Cesium.Color.fromBytes(r, g, b, Math.round(alpha * 255));
}

function waterTempColor(waterTempC, alpha = POINT_ALPHA) {
  return colorFromRgb(waterTempColorRgb(waterTempC) ?? COLOR_UNKNOWN_RGB, alpha);
}

/**
 * Title + detail lines for the in-world selected-beach card. Pure, exported
 * for tests.
 * @param {object} beach
 * @returns {{title: string, details: string[]}}
 */
export function buildAemetBeachSelectionCopy(beach) {
  const title = beach?.name || beach?.id || 'Beach';
  const forecast = beach?.forecast || {};
  const details = [];
  details.push(
    Number.isFinite(forecast.waterTempC) ? `Water ${forecast.waterTempC}°C` : 'Water temp unknown',
  );
  if (Number.isFinite(forecast.maxTempC)) details.push(`Air max ${forecast.maxTempC}°C`);
  if (forecast.sky) details.push(String(forecast.sky));
  if (forecast.wind) details.push(`Wind: ${forecast.wind}`);
  if (forecast.waves) details.push(`Waves: ${forecast.waves}`);
  if (Number.isFinite(forecast.uvMax)) details.push(`UV max ${forecast.uvMax}`);
  return { title, details };
}

/**
 * Build the protected selected-beach overlay entry. Mirrors
 * `createAemetUvIndexSelectedOverlayEntry`'s field set exactly.
 * @param {string} id
 * @param {Cesium.Cartesian3} position
 * @param {object} beach
 * @returns {object|null}
 */
export function createAemetBeachSelectedOverlayEntry(id, position, beach) {
  if (!id || !position) return null;
  const { title, details } = buildAemetBeachSelectionCopy(beach);
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
    accent: `#${(waterTempColorRgb(beach?.forecast?.waterTempC) ?? COLOR_UNKNOWN_RGB).map((c) => c.toString(16).padStart(2, '0')).join('')}`,
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
export function normalizeAemetBeachesPayload(payload) {
  if (!Array.isArray(payload?.beaches)) return null;
  const rows = [];
  for (const beach of payload.beaches) {
    const lat = Number(beach?.lat);
    const lon = Number(beach?.lon);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) continue;
    if (!beach?.id || !beach?.name) continue;
    rows.push(beach);
  }
  return rows;
}

export function createAemetBeachesLayer({ overlayHost = DEFAULT_OVERLAY_HOST } = {}) {
  let _viewer = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  /** @type {Map<string, object>} beach id -> its latest normalized record */
  let _beachById = new Map();
  /** @type {string|null} currently selected beach id, or null */
  let _selectedId = null;
  /** @type {Cesium.Entity|null} the enlarged highlight point for the selection */
  let _selectedEntity = null;
  /** @type {Cesium.ScreenSpaceEventHandler|null} */
  let _clickHandler = null;

  /** Same RELATIVE_TO_GROUND treatment as `aemetStations.js`/`aemetUvIndex.js` — see their own comments for why. */
  function _beachPosition(beach) {
    return Cesium.Cartesian3.fromDegrees(beach.lon, beach.lat, POINT_HEIGHT_OFFSET_M);
  }

  function _clearSelection() {
    if (_selectedId) {
      const original = _dataSource?.entities.getById(`aemet-beaches:${_selectedId}`);
      if (original?.point) original.point.show = true;
    }
    if (_selectedEntity && _viewer) _viewer.entities.remove(_selectedEntity);
    _selectedId = null;
    _selectedEntity = null;
    overlayHost.clearSource(AEMET_BEACHES_SELECTED_OVERLAY_SOURCE_ID);
  }

  function _selectBeach(id) {
    const beach = _beachById.get(id);
    const original = _dataSource?.entities.getById(`aemet-beaches:${id}`);
    if (!beach || !original?.position || !_viewer) return;
    _clearSelection();
    _selectedId = id;
    original.point.show = false;
    const position = original.position.getValue(Cesium.JulianDate.now());
    _selectedEntity = _viewer.entities.add({
      position,
      point: {
        pixelSize: 14,
        color: waterTempColor(beach.forecast?.waterTempC, 1),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    const entry = createAemetBeachSelectedOverlayEntry(id, position, beach);
    if (entry) {
      overlayHost.setEntries(
        AEMET_BEACHES_SELECTED_OVERLAY_SOURCE_ID,
        [entry],
        AEMET_BEACHES_SELECTED_OVERLAY_SOURCE_OPTIONS,
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
        if (pickedId?.startsWith('aemet-beaches:')) {
          _selectBeach(pickedId.slice('aemet-beaches:'.length));
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
    id: 'aemet-beaches',
    name: 'AEMET Beach Forecast',
    icon: '🏖',
    source: 'AEMET OpenData · Spain',
    updateInterval: 300000,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('aemet-beaches');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _beachById = new Map();
      overlayHost.setVisible(AEMET_BEACHES_SELECTED_OVERLAY_SOURCE_ID, false);
      console.log('[Data:AemetBeaches] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(AEMET_BEACHES_SELECTED_OVERLAY_SOURCE_ID, true);
      _installClickHandler(viewer);
      registerPickOwner('aemet-beaches', (pickedId) => String(pickedId).startsWith('aemet-beaches:'));
    },

    disable() {
      _enabled = false;
      _clearSelection();
      if (_dataSource) _dataSource.show = false;
      overlayHost.setVisible(AEMET_BEACHES_SELECTED_OVERLAY_SOURCE_ID, false);
      _removeClickHandler();
      unregisterPickOwner('aemet-beaches');
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
          console.warn(`[Data:AemetBeaches] API returned ${response.status}`);
          return false;
        }

        const payload = await response.json();
        const beaches = normalizeAemetBeachesPayload(payload);
        if (!beaches) {
          _lastError = 'Malformed AEMET response';
          return false;
        }

        const nextEntities = [];
        const nextBeachById = new Map();
        for (const beach of beaches) {
          nextBeachById.set(beach.id, beach);
          nextEntities.push(new Cesium.Entity({
            id: `aemet-beaches:${beach.id}`,
            position: _beachPosition(beach),
            point: {
              pixelSize: 9,
              color: waterTempColor(beach.forecast?.waterTempC),
              outlineColor: COLOR_OUTLINE,
              outlineWidth: 1,
              heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
              // Deliberately NOT disableDepthTestDistance — normal depth
              // testing against the globe hides a beach on the far side of
              // Earth, same as aemetStations.js/aemetUvIndex.js.
            },
            name: beach.name || beach.id,
            properties: { ...beach },
          }));
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        _beachById = nextBeachById;

        if (_selectedId) {
          if (_beachById.has(_selectedId)) _selectBeach(_selectedId);
          else _clearSelection();
        }

        _count = beaches.length;
        _lastUpdate = Date.now();
        // `stale` alone doesn't mean trouble here: unlike every other AEMET
        // proxy's one atomic refresh, this one sweeps ~160 beaches in the
        // background over several minutes, so `stale` reads true for the
        // entire first sweep even though it's actively filling in — not
        // stuck. Only report degraded when stale AND no sweep is running.
        _lastError = payload.stale && !payload.sweeping ? 'Serving stale AEMET data (upstream unavailable)' : null;
        console.log(`[Data:AemetBeaches] Updated: ${_count} beaches`);
        return true;
      } catch (e) {
        console.warn('[Data:AemetBeaches] Fetch error:', e);
        _lastError = 'AEMET network error';
        return false;
      }
    },

    destroy(viewer) {
      _clearSelection();
      _removeClickHandler();
      unregisterPickOwner('aemet-beaches');
      overlayHost.setVisible(AEMET_BEACHES_SELECTED_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _beachById = new Map();
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _viewer = null;
    },

    /**
     * Snapshot the layer's in-memory beaches as plain JSON-safe objects for
     * the analyst query engine. Forecast fields are flattened to the top
     * level (`waterTempC`, not `forecast.waterTempC`) — `analystEngine.js`'s
     * `applyFilter`/sort access fields as `record[field]` with no nested-path
     * support, so a query like "beaches above 24 degrees" needs `waterTempC`
     * directly on the record, not buried in a sub-object.
     */
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
        const forecast = get('forecast') || {};
        result.push({
          id: get('id'),
          name: get('name'),
          lat: get('lat'),
          lon: get('lon'),
          waterTempC: forecast.waterTempC ?? null,
          maxTempC: forecast.maxTempC ?? null,
          uvMax: forecast.uvMax ?? null,
          sky: forecast.sky ?? null,
          wind: forecast.wind ?? null,
          waves: forecast.waves ?? null,
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
    _selectBeachForTest(id) {
      _selectBeach(id);
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

const aemetBeachesLayer = createAemetBeachesLayer();

export default aemetBeachesLayer;
