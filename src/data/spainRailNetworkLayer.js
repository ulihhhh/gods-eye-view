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
import { loadBundledJson } from './bundledJson.js';

/**
 * Rail network (Spain, fork-local) — the Cercanías / Rodalies and FGC lines
 * drawn on the ground in the operators' own colours, over the whole national
 * railway network in neutral grey at the same width, and the Cercanías, FGC
 * and AV/LD/MD stations as points once the camera is down at street scale. Clicking a line or a
 * station names it on a card.
 *
 * Static geometry from bundled packs: `scripts/build-spain-transit-network.mjs`
 * (Renfe and FGC open data) and `scripts/build-spain-rail-ign.mjs` (IGN's
 * INSPIRE transport networks), all CC BY 4.0; nothing here is fetched from
 * an operator. The live trains stay in the Transit layer, so either layer
 * can be shown alone.
 */

const LAYER_ID = 'spain-rail-network';
const LINES_URL = new URL(
  './local_data/spain_transit/lines.json',
  import.meta.url,
);
const STATIONS_URL = new URL(
  './local_data/spain_transit/stations.json',
  import.meta.url,
);
const IGN_URL = new URL(
  './local_data/spain_transit/ign_rail.json',
  import.meta.url,
);

export const SPAIN_RAIL_SELECTED_OVERLAY_SOURCE_ID = 'spain-rail-selected';
const SELECTED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

/** Station points show only once the camera is this close. */
export const SPAIN_RAIL_STATION_MAX_DISTANCE_M = 75_000;
/** Line width on screen, the same for every network. */
export const SPAIN_RAIL_LINE_WIDTH_PX = 3;
/** The national network has no line colours: one neutral grey, for its
 * track and for the stations no coloured line serves. */
const NETWORK_RGB = [205, 210, 220];

/** Lines without an operator colour (FGC's Montserrat rack railway). */
const FALLBACK_LINE_RGB = [160, 168, 176];
/** Station points match the Barcelona metro's: line colour, white for an
 * interchange, the network grey when no coloured line passes. */
const INTERCHANGE_RGB = [235, 235, 235];
const COLOR_OUTLINE = Cesium.Color.BLACK.withAlpha(0.6);
const POINT_HEIGHT_OFFSET_M = 2.0;

/**
 * Cercanías networks ("núcleos") by the two-digit prefix of their route and
 * shape ids. 45–47 are the metre-gauge networks (Cartagena, Ferrol, León).
 */
export const CERCANIAS_NETWORKS = Object.freeze({
  10: 'Cercanías Madrid',
  20: 'Cercanías Asturias',
  30: 'Cercanías Sevilla',
  31: 'Cercanías Cádiz',
  32: 'Cercanías Málaga',
  40: 'Cercanías Valencia',
  41: 'Cercanías Murcia / Alicante',
  45: 'Cercanías Cartagena',
  46: 'Cercanías Ferrol',
  47: 'Cercanías León',
  51: 'Rodalies de Catalunya',
  60: 'Cercanías Bilbao',
  61: 'Cercanías San Sebastián',
  62: 'Cercanías Santander',
  70: 'Cercanías Zaragoza',
});

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

function hexToRgb(hex) {
  if (!/^[0-9A-Fa-f]{6}$/.test(String(hex || ''))) return null;
  const value = Number.parseInt(hex, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbHex(rgb) {
  return `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** The network a line belongs to, as a reader would name it. */
export function spainRailNetworkLabel(line) {
  if (line?.network === 'fgc') return 'FGC';
  return CERCANIAS_NETWORKS[line?.group] || 'Renfe Cercanías';
}

/** Line colour, or the neutral fallback. */
export function spainRailLineRgb(line) {
  return hexToRgb(line?.color) ?? FALLBACK_LINE_RGB;
}

/**
 * Validate the lines pack: keep lines with a name and at least one path of
 * two or more finite points.
 * @returns {object[]|null}
 */
export function normalizeSpainRailLines(pack) {
  if (!Array.isArray(pack?.lines)) return null;
  return pack.lines.filter(
    (line) =>
      line &&
      typeof line.line === 'string' &&
      Array.isArray(line.paths) &&
      line.paths.length > 0 &&
      line.paths.every(
        (path) =>
          Array.isArray(path) &&
          path.length >= 4 &&
          path.length % 2 === 0 &&
          path.every(Number.isFinite),
      ),
  );
}

/** Validate the IGN pack: flat paths of two or more finite points. */
export function normalizeSpainRailIgnPaths(pack) {
  if (!Array.isArray(pack?.paths)) return null;
  return pack.paths.filter(
    (path) =>
      Array.isArray(path) &&
      path.length >= 4 &&
      path.length % 2 === 0 &&
      path.every(Number.isFinite),
  );
}

/**
 * Stations with a point, from the stations pack: Cercanías and FGC, then the
 * AV/LD/MD stations Cercanías does not already have (Renfe uses one station
 * code across both packs).
 * @param {object|null} [linesPack] The lines pack, for each station's lines.
 * @returns {Array<{id: string, network: string, code: string, name: string,
 *   lat: number, lon: number, lines: Array<{name: string, color: string|null}>}>}
 */
export function spainRailStationsFromPack(pack, linesPack = null) {
  const stations = [];
  const allLines = Array.isArray(linesPack?.lines) ? linesPack.lines : [];
  const cercanias = pack?.networks?.['renfe-cercanias'] || {};
  for (const network of ['renfe-cercanias', 'fgc', 'renfe-ld']) {
    for (const [code, entry] of Object.entries(
      pack?.networks?.[network] || {},
    )) {
      if (network === 'renfe-ld' && Object.hasOwn(cercanias, code)) continue;
      const [name, lat, lon] = Array.isArray(entry) ? entry : [];
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      // Lines serving the station, from the lines pack's `stationLines`.
      const served = new Map();
      for (const index of linesPack?.stationLines?.[network]?.[code] || []) {
        const line = allLines[index];
        if (line && typeof line.line === 'string' && !served.has(line.line))
          served.set(line.line, {
            name: line.line,
            color: /^[0-9A-Fa-f]{6}$/.test(String(line.color || ''))
              ? line.color
              : null,
          });
      }
      stations.push({
        id: `${network}:${code}`,
        network,
        code,
        name: String(name),
        lat,
        lon,
        lines: [...served.values()],
      });
    }
  }
  return stations;
}

/**
 * Station point colour: its line's colour, white where lines of different
 * colours meet, the network grey when no coloured line passes.
 * @returns {[number, number, number]}
 */
export function spainRailStationRgb(station) {
  const colours = new Set(
    (station?.lines || []).map((line) => line.color).filter(Boolean),
  );
  if (colours.size === 1) return hexToRgb([...colours][0]) ?? NETWORK_RGB;
  return colours.size > 1 ? INTERCHANGE_RGB : NETWORK_RGB;
}

/**
 * The networks a row pill switches: Cercanías / Rodalies, FGC, and the
 * national network (IGN track and the AV/LD/MD stations). `stations` hides
 * or shows every station point of the networks that are on.
 */
export const SPAIN_RAIL_DEFAULT_PARAMS = Object.freeze({
  cercanias: true,
  fgc: true,
  national: true,
  stations: true,
});

const SPAIN_RAIL_CHIPS = Object.freeze([
  Object.freeze({
    key: 'cercanias',
    label: 'CERCANÍAS',
    title: 'Renfe Cercanías / Rodalies lines and stations',
  }),
  Object.freeze({
    key: 'fgc',
    label: 'FGC',
    title: 'FGC lines and stations',
  }),
  Object.freeze({
    key: 'national',
    label: 'AV/LD',
    title: 'National rail network (IGN) and AV/LD/MD stations',
  }),
  Object.freeze({
    key: 'stations',
    label: 'STATIONS',
    title: 'Station points',
  }),
]);

/**
 * Which pill owns a line or a station: `cercanias`, `fgc` or `national`.
 * @param {{network?: string}} item
 * @returns {'cercanias'|'fgc'|'national'}
 */
export function spainRailGroup(item) {
  if (item?.network === 'fgc') return 'fgc';
  if (item?.network === 'renfe-ld') return 'national';
  return 'cercanias';
}

/**
 * The row's pills, one per network plus STATIONS, each switching on its own.
 * @param {typeof SPAIN_RAIL_DEFAULT_PARAMS} params
 * @returns {{chips: object[], legend: object[]}}
 */
export function spainRailRowControls(params) {
  return {
    chips: SPAIN_RAIL_CHIPS.map(({ key, label, title }) => ({
      id: key,
      label,
      active: params[key],
      state: params[key] ? 'active' : 'idle',
      title,
      params: { [key]: !params[key] },
    })),
    legend: [],
  };
}

/** Entity / instance ids: `spain-rail-network:line:<n>`, `…:station:<id>`. */
export function parseSpainRailPickId(pickedId) {
  const match =
    /^spain-rail-network:(line|station|ign):([A-Za-z0-9:_-]{1,40})$/.exec(
      String(pickedId || ''),
    );
  return match ? { kind: match[1], key: match[2] } : null;
}

/** Card copy for a line, a national-network track or a station. */
export function buildSpainRailCopy(kind, item) {
  if (kind === 'ign') {
    return {
      title: '🛤 Railway',
      details: [
        'Spanish rail network (mainline track)',
        'Source: © Instituto Geográfico Nacional — SCNE',
      ],
    };
  }
  if (kind === 'line') {
    return {
      title: `🛤 ${item.line}`,
      details: [
        `${spainRailNetworkLabel(item)} · line`,
        `Source: ${item.network === 'fgc' ? 'FGC' : 'Renfe Operadora'} open data`,
      ],
    };
  }
  const fgc = item.network === 'fgc';
  const lines = (item.lines || []).map((line) => line.name).join(' ');
  const kindLabel = fgc
    ? 'FGC station'
    : item.network === 'renfe-ld'
      ? 'Renfe AV/LD/MD station'
      : 'Renfe Cercanías station';
  return {
    title: `🚉 ${item.name}`,
    details: [
      `${kindLabel} · ${item.code}`,
      ...(lines ? [`Lines: ${lines}`] : []),
      `Source: ${fgc ? 'FGC' : 'Renfe Operadora'} open data`,
    ],
  };
}

export function createSpainRailNetworkLayer({
  overlayHost = DEFAULT_OVERLAY_HOST,
  loadJson = loadBundledJson,
} = {}) {
  let _viewer = null;
  let _dataSource = null;
  /**
   * One ground-polyline primitive per network, so a pill switches it
   * without rebuilding anything.
   * @type {{national: Cesium.GroundPolylinePrimitive|null,
   *   cercanias: Cesium.GroundPolylinePrimitive|null,
   *   fgc: Cesium.GroundPolylinePrimitive|null}}
   */
  const _primitives = { national: null, cercanias: null, fgc: null };
  let _params = { ...SPAIN_RAIL_DEFAULT_PARAMS };
  let _lines = [];
  let _ignPaths = [];
  /** @type {Map<string, object>} station id → station */
  let _stations = new Map();
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _selectedKey = null;
  /** @type {Cesium.ScreenSpaceEventHandler|null} */
  let _clickHandler = null;

  function _stationPosition(station) {
    return Cesium.Cartesian3.fromDegrees(
      station.lon,
      station.lat,
      POINT_HEIGHT_OFFSET_M,
    );
  }

  function _clearSelection() {
    _selectedKey = null;
    overlayHost.clearSource(SPAIN_RAIL_SELECTED_OVERLAY_SOURCE_ID);
  }

  function _showCard(key, kind, item, position) {
    if (!position) return;
    _selectedKey = key;
    const { title, details } = buildSpainRailCopy(kind, item);
    const rgb =
      kind === 'line'
        ? spainRailLineRgb(item)
        : kind === 'ign'
          ? NETWORK_RGB
          : spainRailStationRgb(item);
    overlayHost.setEntries(
      SPAIN_RAIL_SELECTED_OVERLAY_SOURCE_ID,
      [
        {
          id: key,
          position,
          variant: 'selected',
          selected: true,
          protected: true,
          paintLane: 'selected',
          collisionGroup: 'ambient-card',
          priority: Number.MAX_SAFE_INTEGER,
          title,
          details,
          accent: rgbHex(rgb),
          interactive: false,
          anchorRadiusPx: 7,
          minAnchorGapPx: 11,
          verticalOnly: true,
          placement: 'above',
          edgeFade: 'keyhole',
          horizonCull: true,
          terrainOcclusion: false,
        },
      ],
      SELECTED_OVERLAY_SOURCE_OPTIONS,
    );
  }

  function _select(pickedId, clickPosition) {
    const parsed = parseSpainRailPickId(pickedId);
    if (!parsed) return false;
    if (parsed.kind === 'ign') {
      const path = _ignPaths[Number(parsed.key)];
      if (!path || !clickPosition) return false;
      _showCard(pickedId, 'ign', null, clickPosition);
      return true;
    }
    if (parsed.kind === 'station') {
      const station = _stations.get(parsed.key);
      if (!station) return false;
      _showCard(pickedId, 'station', station, _stationPosition(station));
      return true;
    }
    const line = _lines[Number(parsed.key)];
    if (!line) return false;
    const [lon, lat] = line.paths[0];
    _showCard(
      pickedId,
      'line',
      line,
      clickPosition ?? Cesium.Cartesian3.fromDegrees(lon, lat, 0),
    );
    return true;
  }

  function _onKeyDown(e) {
    if (e.key === 'Escape' && _selectedKey) _clearSelection();
  }

  const hasDom = () => typeof document !== 'undefined';

  function _installClickHandler(viewer) {
    if (_clickHandler || !hasDom() || !viewer?.scene?.canvas) return;
    _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      const picked = viewer.scene.pick(click.position);
      const pickedId = picked ? resolvePickId(picked) : null;
      if (parseSpainRailPickId(pickedId)) {
        let position = null;
        try {
          position = viewer.scene.pickPosition(click.position) || null;
        } catch {
          position = null;
        }
        if (_select(pickedId, position)) return;
      }
      if (_selectedKey) _clearSelection();
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

  function _removeLines() {
    for (const group of Object.keys(_primitives)) {
      if (_primitives[group] && _viewer)
        _viewer.scene.groundPrimitives.remove(_primitives[group]);
      _primitives[group] = null;
    }
  }

  /** Apply the layer switch and the pills to every primitive and station. */
  function _applyVisibility() {
    for (const [group, primitive] of Object.entries(_primitives))
      if (primitive) primitive.show = _enabled && _params[group];
    if (_dataSource) {
      _dataSource.entities.suspendEvents();
      for (const entity of _dataSource.entities.values) {
        const station = _stations.get(
          parseSpainRailPickId(entity.id)?.key ?? '',
        );
        entity.show = Boolean(
          station && _params.stations && _params[spainRailGroup(station)],
        );
      }
      _dataSource.entities.resumeEvents();
    }
    // A card about something the pills just hid closes with it.
    const selected = parseSpainRailPickId(_selectedKey);
    if (selected) {
      const item =
        selected.kind === 'station'
          ? _stations.get(selected.key)
          : selected.kind === 'line'
            ? _lines[Number(selected.key)]
            : { network: 'renfe-ld' };
      const shown =
        selected.kind === 'station'
          ? _params.stations && _params[spainRailGroup(item)]
          : _params[spainRailGroup(item)];
      if (!shown) _clearSelection();
    }
  }

  function _groundPolylines(instances) {
    return _viewer.scene.groundPrimitives.add(
      new Cesium.GroundPolylinePrimitive({
        geometryInstances: instances,
        appearance: new Cesium.PolylineColorAppearance(),
        classificationType: Cesium.ClassificationType.BOTH,
        asynchronous: true,
        show: false, // _applyVisibility decides
      }),
    );
  }

  function _buildLines() {
    _removeLines();
    if (!_viewer?.scene?.groundPrimitives || !_lines.length) return;
    let supported = false;
    try {
      supported = Cesium.GroundPolylinePrimitive.isSupported(_viewer.scene);
    } catch {
      supported = false; // no WebGL context to ask
    }
    if (!supported) {
      _lastError = 'Ground polylines unsupported here — stations only';
      return;
    }
    // The national network first, so the operators' coloured lines draw on
    // top of the same track.
    if (_ignPaths.length) {
      const color = Cesium.ColorGeometryInstanceAttribute.fromColor(
        Cesium.Color.fromBytes(...NETWORK_RGB, 235),
      );
      _primitives.national = _groundPolylines(
        _ignPaths.map(
          (path, index) =>
            new Cesium.GeometryInstance({
              id: `${LAYER_ID}:ign:${index}`,
              geometry: new Cesium.GroundPolylineGeometry({
                positions: Cesium.Cartesian3.fromDegreesArray(path),
                width: SPAIN_RAIL_LINE_WIDTH_PX,
              }),
              attributes: { color },
            }),
        ),
      );
    }
    const instances = { cercanias: [], fgc: [] };
    _lines.forEach((line, index) => {
      const [r, g, b] = spainRailLineRgb(line);
      const color = Cesium.ColorGeometryInstanceAttribute.fromColor(
        Cesium.Color.fromBytes(r, g, b, 235),
      );
      for (const path of line.paths) {
        instances[spainRailGroup(line)].push(
          new Cesium.GeometryInstance({
            id: `${LAYER_ID}:line:${index}`,
            geometry: new Cesium.GroundPolylineGeometry({
              positions: Cesium.Cartesian3.fromDegreesArray(path),
              width: SPAIN_RAIL_LINE_WIDTH_PX,
            }),
            attributes: { color },
          }),
        );
      }
    });
    for (const group of ['cercanias', 'fgc'])
      if (instances[group].length)
        _primitives[group] = _groundPolylines(instances[group]);
    _applyVisibility();
  }

  function _buildStations(stations) {
    if (!_dataSource) return;
    _dataSource.entities.suspendEvents();
    _dataSource.entities.removeAll();
    for (const station of stations) {
      const [r, g, b] = spainRailStationRgb(station);
      _dataSource.entities.add(
        new Cesium.Entity({
          id: `${LAYER_ID}:station:${station.id}`,
          position: _stationPosition(station),
          name: station.name,
          point: {
            pixelSize: 9,
            color: Cesium.Color.fromBytes(r, g, b, 235),
            outlineColor: COLOR_OUTLINE,
            outlineWidth: 1,
            heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
              0,
              SPAIN_RAIL_STATION_MAX_DISTANCE_M,
            ),
            // Same reasoning as the Barcelona arrivals layer: drawn over the
            // photorealistic mesh within its display distance only.
            disableDepthTestDistance: SPAIN_RAIL_STATION_MAX_DISTANCE_M,
          },
        }),
      );
    }
    _dataSource.entities.resumeEvents();
    _applyVisibility();
  }

  const layer = {
    id: LAYER_ID,
    name: 'Rail network (Spain)',
    icon: '🛤',
    source: 'Renfe Cercanías · FGC open data',
    // Static packs: read once; the interval only re-checks a failed read.
    updateInterval: 3_600_000,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      overlayHost.setVisible(SPAIN_RAIL_SELECTED_OVERLAY_SOURCE_ID, false);
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      _applyVisibility();
      overlayHost.setVisible(SPAIN_RAIL_SELECTED_OVERLAY_SOURCE_ID, true);
      _installClickHandler(viewer);
      registerPickOwner(LAYER_ID, (pickedId) =>
        Boolean(parseSpainRailPickId(pickedId)),
      );
    },

    disable() {
      _enabled = false;
      _clearSelection();
      if (_dataSource) _dataSource.show = false;
      _applyVisibility();
      overlayHost.setVisible(SPAIN_RAIL_SELECTED_OVERLAY_SOURCE_ID, false);
      _removeClickHandler();
      unregisterPickOwner(LAYER_ID);
    },

    async update() {
      if (_lines.length) return true; // static: built once
      try {
        const [linesPack, stationsPack, ignPack] = await Promise.all([
          loadJson(LINES_URL),
          loadJson(STATIONS_URL),
          // The national network is context: the layer still works without it.
          loadJson(IGN_URL).catch((error) => {
            console.warn('[Data:SpainRail] IGN network unavailable:', error);
            return null;
          }),
        ]);
        const lines = normalizeSpainRailLines(linesPack);
        if (!lines) {
          _lastError = 'Malformed rail lines pack';
          return false;
        }
        const stations = spainRailStationsFromPack(stationsPack, linesPack);
        _lines = lines;
        _ignPaths = normalizeSpainRailIgnPaths(ignPack) || [];
        _stations = new Map(stations.map((station) => [station.id, station]));
        _lastError = null;
        _buildLines();
        _buildStations(stations);
        _count = lines.length + _ignPaths.length + stations.length;
        _lastUpdate = Date.now();
        return true;
      } catch (error) {
        console.warn('[Data:SpainRail] Pack load error:', error);
        _lastError = 'Rail network pack unavailable';
        return false;
      }
    },

    destroy(viewer) {
      _clearSelection();
      _removeClickHandler();
      unregisterPickOwner(LAYER_ID);
      overlayHost.setVisible(SPAIN_RAIL_SELECTED_OVERLAY_SOURCE_ID, false);
      _removeLines();
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _lines = [];
      _ignPaths = [];
      _stations = new Map();
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _viewer = null;
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },

    /**
     * `{cercanias, fgc, national, stations}` booleans, from the row's pills
     * or a share link. Any subset may be given; unknown keys are ignored.
     */
    setParams(params = {}) {
      let changed = false;
      for (const key of Object.keys(SPAIN_RAIL_DEFAULT_PARAMS)) {
        if (params[key] === undefined) continue;
        const next = params[key] !== false;
        if (_params[key] !== next) changed = true;
        _params[key] = next;
      }
      if (changed) _applyVisibility();
      return true;
    },

    getParams() {
      return { ..._params };
    },

    getRowControls() {
      return spainRailRowControls(_params);
    },

    // Test-only hooks.
    _selectForTest(pickedId, position) {
      return _select(pickedId, position);
    },
    _selectedKeyForTest() {
      return _selectedKey;
    },
  };
  return layer;
}

const spainRailNetworkLayer = createSpainRailNetworkLayer();

export default spainRailNetworkLayer;
