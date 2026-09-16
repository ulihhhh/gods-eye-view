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

/**
 * AEMET OpenData live weather station pins — Spain only (~850 stations).
 *
 * Polls the /api/aemet/stations proxy (server/providers/weather/aemet.js),
 * which already dedups AEMET's raw ~12-trailing-hourly-rows-per-station feed
 * down to one current reading per station and hides the two-step
 * envelope/datos fetch. This layer's only job is turning that flat station
 * list into colored points with click-to-inspect — no polling cadence
 * tricks, no camera-proximity gating (unlike bikeshare's nationwide
 * multi-city scale, ~850 fixed points nationwide is cheap to just keep live).
 *
 * Click-to-inspect follows bikeshare.js's pattern exactly (this app runs
 * Cesium with `infoBox: false`, so the built-in InfoBox is not an option):
 * a `ScreenSpaceEventHandler` picks a station, hides its base point, and
 * shows a bigger highlighted point plus a floating detail card through the
 * shared worldOverlay host (`variant: 'selected'`) — the same in-world card
 * mechanism bikeshare's station selection and earthquakes' magnitude labels
 * both already use, not a DOM sidebar or the disabled Cesium InfoBox.
 */

export const AEMET_STATIONS_SELECTED_OVERLAY_SOURCE_ID =
  'aemet-stations-selected';
export const AEMET_STATIONS_SELECTED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

const API_URL = '/api/aemet/stations';

const COLOR_UNKNOWN_RGB = [145, 164, 180];
const COLOR_OUTLINE = Cesium.Color.BLACK.withAlpha(0.6);
const POINT_ALPHA = 0.92;
/**
 * Vertical offset (m) above ground, via `heightReference: RELATIVE_TO_GROUND`
 * (not CLAMP_TO_GROUND, and not a one-time `scene.sampleHeight()` snapshot —
 * see below for why both of those were tried and replaced).
 *
 * History, so this isn't re-litigated: `CLAMP_TO_GROUND` (height 0) visibly
 * sank points into sloped terrain once real elevation data, not just the
 * ellipsoid, was loaded and the camera was close. The first fix sampled real
 * terrain height once per station via `scene.sampleHeight()` and baked it
 * into a static position — bikeshare.js does the same thing successfully,
 * but bikeshare only samples for stations near wherever the camera ALREADY
 * is (camera-proximity-gated per-city loading), so the relevant terrain
 * tiles are essentially always already loaded. This layer samples all ~850
 * stations across all of Spain regardless of camera position — most samples
 * land on terrain tiles that aren't loaded yet and silently fail, falling
 * back to a flat ellipsoid height, and WHICH stations succeed vs. fall back
 * depends on wherever the camera happened to be during that specific 5-min
 * poll. Different polls landing on different tiles-loaded state is exactly
 * what looked like points sitting at "inexact positions" and drifting as the
 * camera moved. `RELATIVE_TO_GROUND` fixes this at the root: Cesium
 * maintains the clamp continuously against whatever terrain is ACTUALLY
 * loaded at render time (the same mechanism CLAMP_TO_GROUND already uses),
 * so there is no stale one-time sample to go wrong.
 */
const POINT_HEIGHT_OFFSET_M = 2.0;

/**
 * Smooth temperature gradient, coldest to hottest. Anchor stops chosen for a
 * readable spread across the temperatures AEMET's Spain network actually
 * reports (roughly -10°C mountain lows to 40°C+ summer highs), linearly
 * interpolated between neighbors — a genuinely continuous gradient rather
 * than the small number of visually-identical stepped bands this started
 * with. Exported and pure (plain RGB bytes, no Cesium) so it's testable
 * without a Cesium.Color round-trip.
 */
export const TEMPERATURE_COLOR_STOPS = Object.freeze([
  Object.freeze({ c: -10, rgb: [40, 60, 170] }),
  Object.freeze({ c: 0, rgb: [59, 108, 255] }),
  Object.freeze({ c: 10, rgb: [59, 182, 255] }),
  Object.freeze({ c: 18, rgb: [70, 220, 190] }),
  Object.freeze({ c: 24, rgb: [140, 230, 90] }),
  Object.freeze({ c: 28, rgb: [255, 210, 60] }),
  Object.freeze({ c: 33, rgb: [255, 140, 50] }),
  Object.freeze({ c: 40, rgb: [230, 40, 40] }),
]);

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Interpolate a temperature (°C) to an [r,g,b] byte triple along
 * TEMPERATURE_COLOR_STOPS. Values outside the range clamp to the nearest
 * end stop rather than extrapolating. Returns `null` for a non-finite input
 * — the caller substitutes a neutral "unknown" color, never a guessed one.
 * @param {number} temperatureC
 * @returns {[number, number, number]|null}
 */
export function temperatureColorRgb(temperatureC) {
  if (!Number.isFinite(temperatureC)) return null;
  const stops = TEMPERATURE_COLOR_STOPS;
  if (temperatureC <= stops[0].c) return stops[0].rgb;
  if (temperatureC >= stops[stops.length - 1].c)
    return stops[stops.length - 1].rgb;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (temperatureC >= a.c && temperatureC <= b.c) {
      const t = (temperatureC - a.c) / (b.c - a.c);
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

function temperatureColor(temperatureC, alpha = POINT_ALPHA) {
  return colorFromRgb(
    temperatureColorRgb(temperatureC) ?? COLOR_UNKNOWN_RGB,
    alpha,
  );
}

function fmt(value, unit, digits = 0) {
  return Number.isFinite(value) ? `${value.toFixed(digits)}${unit}` : '—';
}

/** `fmt(deg, '°')` prefixed with " @ ", or '' when the direction is unknown. */
function atDeg(direction) {
  return Number.isFinite(direction) ? ` @ ${direction.toFixed(0)}°` : '';
}

/** Small HTML description, kept for any future re-enable of Cesium's InfoBox. */
export function buildAemetStationDescription(station) {
  const observed = Number.isFinite(station?.observedAtMs)
    ? new Date(station.observedAtMs).toLocaleString()
    : 'unknown';
  const hasRange =
    Number.isFinite(station?.temperatureMinC) &&
    Number.isFinite(station?.temperatureMaxC);
  return (
    `<table class="cesium-infoBox-defaultTable">` +
    `<tbody>` +
    `<tr><th>Station</th><td>${station?.id ?? '—'}</td></tr>` +
    `<tr><th>Temperature</th><td>${fmt(station?.temperatureC, '°C', 1)}` +
    `${hasRange ? ` (${station.temperatureMinC.toFixed(1)}–${station.temperatureMaxC.toFixed(1)}°C)` : ''}</td></tr>` +
    `<tr><th>Dew point</th><td>${fmt(station?.dewPointC, '°C', 1)}</td></tr>` +
    `<tr><th>Humidity</th><td>${fmt(station?.humidityPct, '%')}</td></tr>` +
    `<tr><th>Pressure</th><td>${fmt(station?.pressureHpa, ' hPa', 1)}</td></tr>` +
    `<tr><th>Sea-level pressure</th><td>${fmt(station?.pressureSeaLevelHpa, ' hPa', 1)}</td></tr>` +
    `<tr><th>Wind</th><td>${fmt(station?.windSpeedMs, ' m/s', 1)}${atDeg(station?.windDirectionDeg)}` +
    `${
      Number.isFinite(station?.windSpeedStdDevMs) ||
      Number.isFinite(station?.windDirectionStdDevDeg)
        ? ` (σ ${fmt(station?.windSpeedStdDevMs, ' m/s', 1)}${atDeg(station?.windDirectionStdDevDeg)})`
        : ''
    }</td></tr>` +
    `<tr><th>Gust</th><td>${fmt(station?.windGustMs, ' m/s', 1)}${atDeg(station?.windGustDirectionDeg)}</td></tr>` +
    `<tr><th>Precipitation</th><td>${fmt(station?.precipitationMm, ' mm', 1)}</td></tr>` +
    `<tr><th>Altitude</th><td>${fmt(station?.altitudeM, ' m')}</td></tr>` +
    `<tr><th>Observed</th><td>${observed}</td></tr>` +
    `</tbody></table>`
  );
}

/**
 * Title + detail lines for the in-world selected-station card (worldOverlay
 * 'selected' variant — see bikeshare.js's buildSelectionLabel for the same
 * shape). Every field the raw AEMET record carries is represented somewhere
 * here — nothing held back for "the card would get cluttered," per an
 * explicit call: show it all, let missing fields fall out of their segment
 * quietly rather than printing a placeholder for every reading a station
 * simply doesn't report. Pure, exported for tests.
 * @param {object} station
 * @returns {{title: string, details: string[]}}
 */
export function buildAemetStationSelectionCopy(station) {
  const title = station?.name || station?.id || 'Station';
  const hasRange =
    Number.isFinite(station?.temperatureMinC) &&
    Number.isFinite(station?.temperatureMaxC);
  const details = [
    `${fmt(station?.temperatureC, '°C', 1)}` +
      `${hasRange ? ` (${station.temperatureMinC.toFixed(1)}–${station.temperatureMaxC.toFixed(1)})` : ''}` +
      `${Number.isFinite(station?.dewPointC) ? ` · dew ${station.dewPointC.toFixed(1)}°C` : ''}` +
      ` · ${fmt(station?.humidityPct, '% RH')}`,
    `Wind ${fmt(station?.windSpeedMs, ' m/s', 1)}${atDeg(station?.windDirectionDeg)}` +
      `${
        Number.isFinite(station?.windSpeedStdDevMs) ||
        Number.isFinite(station?.windDirectionStdDevDeg)
          ? ` (σ${fmt(station?.windSpeedStdDevMs, ' m/s', 1)}${atDeg(station?.windDirectionStdDevDeg)})`
          : ''
      }` +
      `${
        Number.isFinite(station?.windGustMs)
          ? ` · gust ${station.windGustMs.toFixed(1)} m/s${atDeg(station?.windGustDirectionDeg)}`
          : ''
      }`,
    `${fmt(station?.pressureHpa, ' hPa', 1)}` +
      `${Number.isFinite(station?.pressureSeaLevelHpa) ? ` · MSL ${station.pressureSeaLevelHpa.toFixed(1)} hPa` : ''}`,
    `${fmt(station?.precipitationMm, ' mm', 1)} precip` +
      `${Number.isFinite(station?.altitudeM) ? ` · ${station.altitudeM.toFixed(0)} m altitude` : ''}`,
  ];
  return { title, details };
}

/**
 * Phase A2 — one compact line summarizing the next few upcoming hours from
 * `/api/aemet/forecast`'s `hours` array (already filtered to "upcoming" and
 * capped server-side, see `filterUpcomingAemetForecastHours`). Returns
 * `null` for no/empty input so the caller can simply omit the line rather
 * than showing an empty "Next hours:" — this fires async, well after the
 * base card already rendered, so absence must be silent, not a placeholder.
 * @param {Array<{hour: number, temperatureC: number|null}>} hours
 * @param {number} [take=4]
 * @returns {string|null}
 */
export function buildAemetForecastSummaryLine(hours, take = 4) {
  if (!Array.isArray(hours) || !hours.length) return null;
  const parts = hours
    .slice(0, take)
    .map(
      (h) =>
        `${String(h.hour).padStart(2, '0')}:00 ${fmt(h.temperatureC, '°C', 0)}`,
    );
  if (!parts.length) return null;
  return `Next hours: ${parts.join(' · ')}`;
}

/**
 * Build the protected selected-station overlay entry. Mirrors
 * createBikeshareSelectedOverlayEntry's field set exactly.
 * `forecastLine` is optional (Phase A2's async "next hours" summary,
 * appended once it arrives — the base card renders immediately without it).
 * @param {string} id
 * @param {Cesium.Cartesian3} position
 * @param {object} station
 * @param {string|null} [forecastLine]
 * @returns {object|null}
 */
export function createAemetStationSelectedOverlayEntry(
  id,
  position,
  station,
  forecastLine = null,
) {
  if (!id || !position) return null;
  const { title, details } = buildAemetStationSelectionCopy(station);
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
    details: forecastLine ? [...details, forecastLine] : details,
    accent: `#${(
      temperatureColorRgb(station?.temperatureC) ?? COLOR_UNKNOWN_RGB
    )
      .map((c) => c.toString(16).padStart(2, '0'))
      .join('')}`,
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

/** Validate `/api/aemet/forecast`'s payload shape before using it to extend a card. */
export function normalizeAemetForecastPayload(payload) {
  if (!Array.isArray(payload?.hours)) return null;
  return payload.hours;
}

/** Validate the proxy's payload shape before replacing the last good snapshot. */
export function normalizeAemetStationsPayload(payload) {
  if (!Array.isArray(payload?.stations)) return null;
  const rows = [];
  for (const station of payload.stations) {
    const lat = Number(station?.lat);
    const lon = Number(station?.lon);
    if (
      !Number.isFinite(lat) ||
      Math.abs(lat) > 90 ||
      !Number.isFinite(lon) ||
      Math.abs(lon) > 180
    )
      continue;
    if (!station?.id) continue;
    rows.push(station);
  }
  return rows;
}

export function createAemetStationsLayer({
  overlayHost = DEFAULT_OVERLAY_HOST,
} = {}) {
  let _viewer = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  /** @type {Map<string, object>} station id -> its latest normalized record */
  let _stationById = new Map();
  /** @type {string|null} currently selected station id, or null */
  let _selectedId = null;
  /** @type {Cesium.Entity|null} the enlarged highlight point for the selection */
  let _selectedEntity = null;
  /** @type {Cesium.ScreenSpaceEventHandler|null} */
  let _clickHandler = null;
  /**
   * Bumped on every select/clear so a Phase-A2 forecast fetch that resolves
   * after the user has already moved on (reselected a different station,
   * cleared the selection, or the layer was disabled) can recognize it's
   * stale and silently drop its result instead of overwriting a newer card.
   */
  let _selectionToken = 0;

  /**
   * A station's world position. The height component is `POINT_HEIGHT_OFFSET_M`
   * — meaningless on its own, but `heightReference: RELATIVE_TO_GROUND` on
   * the point graphics (see the entity-build loop in update() and the
   * highlight in _selectStation) tells Cesium to treat it as an offset above
   * whatever terrain is actually loaded, recomputed continuously rather than
   * sampled once. See POINT_HEIGHT_OFFSET_M's comment for why a one-time
   * `scene.sampleHeight()` snapshot (tried first) was wrong for this layer.
   */
  function _stationPosition(station) {
    return Cesium.Cartesian3.fromDegrees(
      station.lon,
      station.lat,
      POINT_HEIGHT_OFFSET_M,
    );
  }

  function _clearSelection() {
    if (_selectedId) {
      const original = _dataSource?.entities.getById(
        `aemet-station:${_selectedId}`,
      );
      if (original?.point) original.point.show = true;
    }
    if (_selectedEntity && _viewer) _viewer.entities.remove(_selectedEntity);
    _selectedId = null;
    _selectedEntity = null;
    _selectionToken += 1;
    overlayHost.clearSource(AEMET_STATIONS_SELECTED_OVERLAY_SOURCE_ID);
  }

  /**
   * Phase A2: fetch the "next hours" forecast for the selected station's
   * location and, if that selection is still current when the response
   * arrives, re-render the same overlay entry with the forecast line
   * appended. Best-effort by design — a failed/slow/malformed forecast
   * response simply leaves the card exactly as the synchronous render in
   * `_selectStation` already left it, never blocking or replacing it with
   * an error state (the current-conditions reading is the important part;
   * the forecast is a bonus line).
   * @param {string} id
   * @param {object} station
   * @param {number} token Captured at call time; a mismatch at resolution
   *   means the user has since selected something else or cleared — drop
   *   the result rather than racing a newer card.
   */
  async function _fetchAndApplyForecast(id, station, token) {
    try {
      const response = await fetch(
        `/api/aemet/forecast?lat=${encodeURIComponent(station.lat)}&lon=${encodeURIComponent(station.lon)}`,
      );
      if (!response.ok) return;
      const payload = await response.json();
      if (token !== _selectionToken || _selectedId !== id) return; // stale — user has moved on
      const hours = normalizeAemetForecastPayload(payload);
      const line = hours ? buildAemetForecastSummaryLine(hours) : null;
      if (!line || !_selectedEntity) return;
      const position = _selectedEntity.position?.getValue(
        Cesium.JulianDate.now(),
      );
      const entry = createAemetStationSelectedOverlayEntry(
        id,
        position,
        station,
        line,
      );
      if (entry) {
        overlayHost.setEntries(
          AEMET_STATIONS_SELECTED_OVERLAY_SOURCE_ID,
          [entry],
          AEMET_STATIONS_SELECTED_OVERLAY_SOURCE_OPTIONS,
        );
      }
    } catch {
      /* forecast is a nice-to-have addition to an already-shown card, never fatal */
    }
  }

  function _selectStation(id) {
    const station = _stationById.get(id);
    const original = _dataSource?.entities.getById(`aemet-station:${id}`);
    if (!station || !original?.position || !_viewer) return;
    _clearSelection();
    _selectedId = id;
    const token = (_selectionToken += 1);
    original.point.show = false;
    const position = original.position.getValue(Cesium.JulianDate.now());
    _selectedEntity = _viewer.entities.add({
      position,
      point: {
        pixelSize: 14,
        color: temperatureColor(station.temperatureC, 1),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        // Same RELATIVE_TO_GROUND treatment as the base point (see
        // POINT_HEIGHT_OFFSET_M) — the raw `position` above only carries the
        // small offset value, not a real height, until this reference tells
        // Cesium to clamp it against whatever terrain is loaded right now.
        heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
        // Only the ONE selected marker skips depth testing, so it stays
        // legible when highlighted — every other station point below keeps
        // normal depth testing against the globe (see the entity-build loop
        // in update()); that is what makes the far side of Earth correctly
        // hide its stations instead of showing through, as it did before.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    const entry = createAemetStationSelectedOverlayEntry(id, position, station);
    if (entry) {
      overlayHost.setEntries(
        AEMET_STATIONS_SELECTED_OVERLAY_SOURCE_ID,
        [entry],
        AEMET_STATIONS_SELECTED_OVERLAY_SOURCE_OPTIONS,
      );
    }
    // Fire-and-forget from every real caller (the base card above is already
    // complete and correct without this — see `_fetchAndApplyForecast`'s own
    // contract); returned only so `_selectStationForTest` can let a test
    // await it deterministically instead of racing a microtask.
    return _fetchAndApplyForecast(id, station, token);
  }

  function _onKeyDown(e) {
    if (e.key === 'Escape' && _selectedId) _clearSelection();
  }

  // Real Cesium.ScreenSpaceEventHandler/document listeners need a real
  // browser DOM (throws "document is not defined" under plain Node) — same
  // constraint bikeshare.js's own click handler has, which is why its tests
  // exercise _selectStation/_clearSelection directly rather than through
  // enable(). Guarded rather than assumed, so enable()/disable() stay safe
  // to call from a headless/fake-viewer test without a DOM, and this stays
  // real defensive behavior in production too (no canvas yet ⇒ no handler).
  const hasDom = () => typeof document !== 'undefined';

  function _installClickHandler(viewer) {
    if (_clickHandler || !hasDom() || !viewer?.scene?.canvas) return;
    _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      const picked = viewer.scene.pick(click.position);
      if (picked) {
        if (picked.id === _selectedEntity) return; // clicking the highlight itself: no-op
        const pickedId = resolvePickId(picked);
        if (pickedId?.startsWith('aemet-station:')) {
          _selectStation(pickedId.slice('aemet-station:'.length));
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
    id: 'aemet-stations',
    name: 'AEMET Weather Stations',
    icon: '🌡',
    source: 'AEMET OpenData · Spain',
    updateInterval: 300000,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('aemet-stations');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _stationById = new Map();
      overlayHost.setVisible(AEMET_STATIONS_SELECTED_OVERLAY_SOURCE_ID, false);
      console.log('[Data:AemetStations] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(AEMET_STATIONS_SELECTED_OVERLAY_SOURCE_ID, true);
      _installClickHandler(viewer);
      registerPickOwner('aemet-stations', (pickedId) =>
        String(pickedId).startsWith('aemet-station:'),
      );
    },

    disable(viewer) {
      _enabled = false;
      _clearSelection();
      if (_dataSource) _dataSource.show = false;
      overlayHost.setVisible(AEMET_STATIONS_SELECTED_OVERLAY_SOURCE_ID, false);
      _removeClickHandler();
      unregisterPickOwner('aemet-stations');
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
          console.warn(`[Data:AemetStations] API returned ${response.status}`);
          return false;
        }

        const payload = await response.json();
        const stations = normalizeAemetStationsPayload(payload);
        if (!stations) {
          _lastError = 'Malformed AEMET response';
          return false;
        }

        const nextEntities = [];
        const nextStationById = new Map();
        for (const station of stations) {
          nextStationById.set(station.id, station);
          nextEntities.push(
            new Cesium.Entity({
              id: `aemet-station:${station.id}`,
              position: _stationPosition(station),
              point: {
                pixelSize: 7,
                color: temperatureColor(station.temperatureC),
                outlineColor: COLOR_OUTLINE,
                outlineWidth: 1,
                // RELATIVE_TO_GROUND, not CLAMP_TO_GROUND or a one-time
                // sampleHeight() snapshot — see POINT_HEIGHT_OFFSET_M's
                // comment for the full history of why. This keeps the point
                // continuously clamped against whatever terrain is actually
                // loaded, with a small real clearance so it doesn't sink into
                // a slope up close.
                heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
                // Deliberately NOT disableDepthTestDistance here: normal depth
                // testing against the globe is what hides a station on the far
                // side of Earth. Only the one selected highlight (see
                // _selectStation) is exempted from that.
              },
              name: station.name || station.id,
              description: buildAemetStationDescription(station),
              properties: { ...station },
            }),
          );
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        _stationById = nextStationById;

        // A refresh must not silently drop an open selection — re-resolve it
        // against the fresh data (which also means the card's numbers update
        // live) rather than leaving it pointed at now-destroyed entities.
        if (_selectedId) {
          if (_stationById.has(_selectedId)) _selectStation(_selectedId);
          else _clearSelection();
        }

        _count = stations.length;
        _lastUpdate = Date.now();
        _lastError = payload.stale
          ? 'Serving stale AEMET data (upstream unavailable)'
          : null;
        console.log(`[Data:AemetStations] Updated: ${_count} stations`);
        return true;
      } catch (e) {
        console.warn('[Data:AemetStations] Fetch error:', e);
        _lastError = 'AEMET network error';
        return false;
      }
    },

    destroy(viewer) {
      _clearSelection();
      _removeClickHandler();
      unregisterPickOwner('aemet-stations');
      overlayHost.setVisible(AEMET_STATIONS_SELECTED_OVERLAY_SOURCE_ID, false);
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

    /**
     * Snapshot the layer's in-memory stations as plain JSON-safe objects for
     * the analyst query engine. On-demand only, mirrors earthquakes.js.
     * @param {number} [maxCount=2000]
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const entities = _dataSource.entities.values;
      if (!entities.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const now = Cesium.JulianDate.now();
      const result = [];
      for (const entity of entities) {
        if (result.length >= limit) break;
        const p = entity.properties;
        const get = (key) => p?.[key]?.getValue(now) ?? null;
        result.push({
          id: get('id'),
          name: get('name'),
          lat: get('lat'),
          lon: get('lon'),
          altitudeM: get('altitudeM'),
          temperatureC: get('temperatureC'),
          temperatureMinC: get('temperatureMinC'),
          temperatureMaxC: get('temperatureMaxC'),
          dewPointC: get('dewPointC'),
          humidityPct: get('humidityPct'),
          pressureHpa: get('pressureHpa'),
          pressureSeaLevelHpa: get('pressureSeaLevelHpa'),
          windSpeedMs: get('windSpeedMs'),
          windDirectionDeg: get('windDirectionDeg'),
          windSpeedStdDevMs: get('windSpeedStdDevMs'),
          windDirectionStdDevDeg: get('windDirectionStdDevDeg'),
          windGustMs: get('windGustMs'),
          windGustDirectionDeg: get('windGustDirectionDeg'),
          precipitationMm: get('precipitationMm'),
          observedAtMs: get('observedAtMs'),
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
    // plain Node — see hasDom() above), the same way bikeshare.js's own
    // tests bypass its click handler. Not part of the layer contract other
    // callers should use.
    // Returns the Phase-A2 forecast fetch's promise so a test can `await` it
    // deterministically instead of racing a microtask.
    _selectStationForTest(id) {
      return _selectStation(id);
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

const aemetStationsLayer = createAemetStationsLayer();

export default aemetStationsLayer;
