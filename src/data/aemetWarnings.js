import * as Cesium from 'cesium';
import { registerPickOwner, resolvePickId, unregisterPickOwner } from './pickRegistry.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';

/**
 * AEMET OpenData live weather-warning (avisos) zone polygons — Spain only
 * (~233 avisos zones, ~9 typically active on an ordinary day).
 *
 * Polls the /api/aemet/warnings proxy (server/providers/weather/aemet.js),
 * which already extracts AEMET's CAP-XML-in-a-tar feed, suppresses `verde`
 * ("nothing to see here" — AEMET bundles it for most of the country per
 * phenomenon as a matter of course) and expired phenomena, and ranks each
 * zone by its highest currently-active level. This layer's job is turning
 * that zone list into colored polygons with click-to-inspect — same
 * click-to-inspect pattern as aemetStations.js (this app runs Cesium with
 * `infoBox: false`), adapted for polygons: a zone can have several disjoint
 * rings (e.g. Lanzarote + La Graciosa), so selection highlights every ring
 * belonging to a zone rather than swapping one point for a bigger one.
 */

export const AEMET_WARNINGS_SELECTED_OVERLAY_SOURCE_ID = 'aemet-warnings-selected';
export const AEMET_WARNINGS_SELECTED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

const API_URL = '/api/aemet/warnings';

/**
 * Discrete 3-step palette — unlike temperature, an avisos level has no
 * "in-between": a zone is amarillo, naranja, or rojo, never something
 * blended. Colors follow AEMET's own public meteoalerta convention.
 */
const LEVEL_COLOR_RGB = Object.freeze({
  amarillo: [255, 214, 0],
  naranja: [255, 140, 0],
  rojo: [220, 20, 20],
});
const COLOR_UNKNOWN_RGB = [145, 164, 180];
const FILL_ALPHA = 0.35;
const SELECTED_FILL_ALPHA = 0.6;
const OUTLINE_COLOR = Cesium.Color.BLACK.withAlpha(0.7);
const OUTLINE_COLOR_SELECTED = Cesium.Color.WHITE;
/** Nominal anchor height (m) for the selection card — zones have no single "ground point" the way a station does. */
const SELECTION_ANCHOR_HEIGHT_M = 300;

function levelFill(level, alpha) {
  const [r, g, b] = LEVEL_COLOR_RGB[level] ?? COLOR_UNKNOWN_RGB;
  return Cesium.Color.fromBytes(r, g, b, Math.round(alpha * 255));
}

function fmt(value, unit, digits = 0) {
  return Number.isFinite(value) ? `${value.toFixed(digits)}${unit}` : null;
}

function fmtTime(ms) {
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : null;
}

const LEVEL_LABEL = Object.freeze({ amarillo: 'Amarillo', naranja: 'Naranja', rojo: 'Rojo' });

/**
 * One compact line per phenomenon for the click-to-inspect card: level,
 * event, and validity window. A zone can carry more than one — e.g. a live
 * wind warning AND an upcoming coastal one — every one gets its own line,
 * nothing collapsed away. Pure, exported for tests.
 * @param {object} phenomenon One entry of a zone's `phenomena` array.
 * @returns {string}
 */
export function buildAemetWarningPhenomenonLine(phenomenon) {
  const level = LEVEL_LABEL[phenomenon?.level] || phenomenon?.level || '—';
  const name = phenomenon?.name || phenomenon?.event || 'Aviso';
  const window = phenomenon?.inEffect === false
    ? `from ${fmtTime(phenomenon?.onsetMs) ?? '?'}`
    : `until ${fmtTime(phenomenon?.expiresMs) ?? '?'}`;
  const probability = phenomenon?.probability ? ` (${phenomenon.probability})` : '';
  return `${level} ${name}${probability} — ${window}`;
}

/**
 * Title + detail lines for the in-world selected-zone card (worldOverlay
 * 'selected' variant, mirrors aemetStations.js's
 * buildAemetStationSelectionCopy). One line per active phenomenon; a
 * phenomenon's own `description`/`instruction` text is available via
 * `getAnalystRecords()` but left out of this compact card by design — a
 * zone with 2-3 simultaneous phenomena already fills the card with just
 * their headline lines. Pure, exported for tests.
 * @param {object} zone
 * @returns {{title: string, details: string[]}}
 */
export function buildAemetWarningSelectionCopy(zone) {
  const title = zone?.name || zone?.geocode || 'Zone';
  const phenomena = Array.isArray(zone?.phenomena) ? zone.phenomena : [];
  const details = phenomena.length
    ? phenomena.map(buildAemetWarningPhenomenonLine)
    : ['No active warning'];
  return { title, details };
}

/**
 * Build the protected selected-zone overlay entry. Mirrors
 * createAemetStationSelectedOverlayEntry's field set exactly.
 * @param {string} geocode
 * @param {Cesium.Cartesian3} position
 * @param {object} zone
 * @returns {object|null}
 */
export function createAemetWarningSelectedOverlayEntry(geocode, position, zone) {
  if (!geocode || !position) return null;
  const { title, details } = buildAemetWarningSelectionCopy(zone);
  return {
    id: String(geocode),
    position,
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title,
    details,
    accent: `#${(LEVEL_COLOR_RGB[zone?.level] ?? COLOR_UNKNOWN_RGB).map((c) => c.toString(16).padStart(2, '0')).join('')}`,
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

/**
 * The centroid of a zone's first polygon ring — zones have no single natural
 * "ground point" the way a station does, so this is a pragmatic anchor for
 * the selection card, not a geometric center of the whole (possibly
 * multi-ring) zone. Pure, exported for tests.
 * @param {number[][][]} polygons `[[[lat, lon], ...], ...]`
 * @returns {{lat: number, lon: number}|null}
 */
export function aemetWarningZoneAnchor(polygons) {
  const ring = polygons?.[0];
  if (!Array.isArray(ring) || !ring.length) return null;
  let sumLat = 0;
  let sumLon = 0;
  for (const [lat, lon] of ring) {
    sumLat += lat;
    sumLon += lon;
  }
  return { lat: sumLat / ring.length, lon: sumLon / ring.length };
}

/** `[[lat, lon], ...]` → a flat `[lon, lat, lon, lat, ...]` array for `Cesium.Cartesian3.fromDegreesArray`. */
function ringToLonLatFlat(ring) {
  const flat = [];
  for (const [lat, lon] of ring) flat.push(lon, lat);
  return flat;
}

/** Validate the proxy's payload shape before replacing the last good snapshot. */
export function normalizeAemetWarningsPayload(payload) {
  if (!Array.isArray(payload?.zones)) return null;
  const rows = [];
  for (const zone of payload.zones) {
    if (!zone?.geocode || !Array.isArray(zone?.polygons) || !zone.polygons.length) continue;
    const validRings = zone.polygons.filter(
      (ring) => Array.isArray(ring) && ring.length >= 3
        && ring.every(([lat, lon]) => Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lon) && Math.abs(lon) <= 180),
    );
    if (!validRings.length) continue;
    rows.push({ ...zone, polygons: validRings });
  }
  return rows;
}

export function createAemetWarningsLayer({ overlayHost = DEFAULT_OVERLAY_HOST } = {}) {
  let _viewer = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  /** @type {Map<string, object>} zone geocode -> its latest normalized record */
  let _zoneById = new Map();
  /** @type {Map<string, string[]>} zone geocode -> its ring entity ids */
  let _entityIdsByZone = new Map();
  /** @type {string|null} currently selected zone geocode, or null */
  let _selectedGeocode = null;

  function _zoneEntities(geocode) {
    const ids = _entityIdsByZone.get(geocode) || [];
    return ids.map((id) => _dataSource?.entities.getById(id)).filter(Boolean);
  }

  function _paintZone(geocode, highlighted) {
    const zone = _zoneById.get(geocode);
    if (!zone) return;
    for (const entity of _zoneEntities(geocode)) {
      if (!entity.polygon) continue;
      entity.polygon.material = new Cesium.ColorMaterialProperty(
        levelFill(zone.level, highlighted ? SELECTED_FILL_ALPHA : FILL_ALPHA),
      );
      entity.polygon.outlineColor = highlighted ? OUTLINE_COLOR_SELECTED : OUTLINE_COLOR;
      entity.polygon.outlineWidth = highlighted ? 3 : 1;
    }
  }

  function _clearSelection() {
    if (_selectedGeocode) _paintZone(_selectedGeocode, false);
    _selectedGeocode = null;
    overlayHost.clearSource(AEMET_WARNINGS_SELECTED_OVERLAY_SOURCE_ID);
  }

  function _selectZone(geocode) {
    const zone = _zoneById.get(geocode);
    if (!zone || !_zoneEntities(geocode).length || !_viewer) return;
    _clearSelection();
    _selectedGeocode = geocode;
    _paintZone(geocode, true);
    const anchor = aemetWarningZoneAnchor(zone.polygons);
    const position = anchor
      ? Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat, SELECTION_ANCHOR_HEIGHT_M)
      : null;
    const entry = position ? createAemetWarningSelectedOverlayEntry(geocode, position, zone) : null;
    if (entry) {
      overlayHost.setEntries(
        AEMET_WARNINGS_SELECTED_OVERLAY_SOURCE_ID,
        [entry],
        AEMET_WARNINGS_SELECTED_OVERLAY_SOURCE_OPTIONS,
      );
    }
  }

  function _onKeyDown(e) {
    if (e.key === 'Escape' && _selectedGeocode) _clearSelection();
  }

  // Same DOM constraint as aemetStations.js's click handler — see that
  // file's hasDom() comment for why this is guarded rather than assumed.
  const hasDom = () => typeof document !== 'undefined';
  let _clickHandler = null;

  function _installClickHandler(viewer) {
    if (_clickHandler || !hasDom() || !viewer?.scene?.canvas) return;
    _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      const picked = viewer.scene.pick(click.position);
      if (picked) {
        const pickedId = resolvePickId(picked);
        if (pickedId?.startsWith('aemet-warning:')) {
          // id shape: aemet-warning:<geocode>:<ringIndex> — geocode itself
          // is a plain digit string with no colons, so index 1 is exact.
          _selectZone(pickedId.split(':')[1]);
          return;
        }
      }
      if (_selectedGeocode) _clearSelection();
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
    id: 'aemet-warnings',
    name: 'AEMET Weather Warnings',
    icon: '⚠',
    source: 'AEMET OpenData · Spain',
    updateInterval: 300000,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('aemet-warnings');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _zoneById = new Map();
      _entityIdsByZone = new Map();
      overlayHost.setVisible(AEMET_WARNINGS_SELECTED_OVERLAY_SOURCE_ID, false);
      console.log('[Data:AemetWarnings] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(AEMET_WARNINGS_SELECTED_OVERLAY_SOURCE_ID, true);
      _installClickHandler(viewer);
      registerPickOwner('aemet-warnings', (pickedId) => String(pickedId).startsWith('aemet-warning:'));
    },

    disable(viewer) {
      _enabled = false;
      _clearSelection();
      if (_dataSource) _dataSource.show = false;
      overlayHost.setVisible(AEMET_WARNINGS_SELECTED_OVERLAY_SOURCE_ID, false);
      _removeClickHandler();
      unregisterPickOwner('aemet-warnings');
    },

    async update(viewer) {
      try {
        const response = await fetch(API_URL);
        if (response.status === 503) {
          _lastError = 'AEMET_API_KEY not configured';
          return false;
        }
        if (!response.ok) {
          _lastError = `AEMET HTTP ${response.status}`;
          console.warn(`[Data:AemetWarnings] API returned ${response.status}`);
          return false;
        }

        const payload = await response.json();
        const zones = normalizeAemetWarningsPayload(payload);
        if (!zones) {
          _lastError = 'Malformed AEMET response';
          return false;
        }

        const nextEntities = [];
        const nextZoneById = new Map();
        const nextEntityIdsByZone = new Map();
        for (const zone of zones) {
          nextZoneById.set(zone.geocode, zone);
          const ids = [];
          zone.polygons.forEach((ring, ringIndex) => {
            const id = `aemet-warning:${zone.geocode}:${ringIndex}`;
            ids.push(id);
            nextEntities.push(new Cesium.Entity({
              id,
              name: zone.name || zone.geocode,
              // No height/perPositionHeight/extrudedHeight: Cesium drapes an
              // un-heighted polygon on whatever terrain is loaded
              // (GroundPrimitive), the polygon equivalent of a point's
              // ground clamp — deliberately checked, not assumed, given
              // aemetStations.js's own history with this exact class of bug.
              polygon: {
                hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(ringToLonLatFlat(ring))),
                material: new Cesium.ColorMaterialProperty(levelFill(zone.level, FILL_ALPHA)),
                outline: true,
                outlineColor: OUTLINE_COLOR,
                outlineWidth: 1,
              },
              properties: { geocode: zone.geocode, name: zone.name, level: zone.level, levelRank: zone.levelRank, phenomena: zone.phenomena },
            }));
          });
          nextEntityIdsByZone.set(zone.geocode, ids);
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        _zoneById = nextZoneById;
        _entityIdsByZone = nextEntityIdsByZone;

        // A refresh must not silently drop an open selection — re-resolve it
        // against the fresh data (updating the card's phenomena live) rather
        // than leaving it pointed at now-destroyed entities.
        if (_selectedGeocode) {
          if (_zoneById.has(_selectedGeocode)) _selectZone(_selectedGeocode);
          else _clearSelection();
        }

        _count = zones.length;
        _lastUpdate = Date.now();
        _lastError = payload.stale ? 'Serving stale AEMET data (upstream unavailable)' : null;
        console.log(`[Data:AemetWarnings] Updated: ${_count} active zones`);
        return true;
      } catch (e) {
        console.warn('[Data:AemetWarnings] Fetch error:', e);
        _lastError = 'AEMET network error';
        return false;
      }
    },

    destroy(viewer) {
      _clearSelection();
      _removeClickHandler();
      unregisterPickOwner('aemet-warnings');
      overlayHost.setVisible(AEMET_WARNINGS_SELECTED_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _zoneById = new Map();
      _entityIdsByZone = new Map();
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _viewer = null;
    },

    /**
     * Snapshot the layer's in-memory zones (one row per zone, not per ring)
     * as plain JSON-safe objects for the analyst query engine. On-demand
     * only, mirrors aemetStations.js.
     * @param {number} [maxCount=2000]
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 2000;
      const now = Cesium.JulianDate.now();
      const result = [];
      const seen = new Set();
      for (const entity of _dataSource.entities.values) {
        if (result.length >= limit) break;
        const p = entity.properties;
        const geocode = p?.geocode?.getValue(now) ?? null;
        if (!geocode || seen.has(geocode)) continue;
        seen.add(geocode);
        result.push({
          geocode,
          name: p?.name?.getValue(now) ?? null,
          level: p?.level?.getValue(now) ?? null,
          levelRank: p?.levelRank?.getValue(now) ?? null,
          phenomena: p?.phenomena?.getValue(now) ?? [],
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

    // Test-only hooks — see aemetStations.js's identical hooks for why:
    // exercise the real selection state machine directly, bypassing
    // Cesium.ScreenSpaceEventHandler/document (unavailable under plain
    // Node). Not part of the layer contract other callers should use.
    _selectZoneForTest(geocode) {
      _selectZone(geocode);
    },
    _clearSelectionForTest() {
      _clearSelection();
    },
    _selectedGeocodeForTest() {
      return _selectedGeocode;
    },
  };
  return layer;
}

const aemetWarningsLayer = createAemetWarningsLayer();

export default aemetWarningsLayer;
