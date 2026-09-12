import * as Cesium from 'cesium';

/**
 * Local ADS-B receiver tap (issue #57) — Phase 0 of the local-SDR plan
 * (docs/plans/local-usb-sdr.md).
 *
 * Plots whatever a user's own dump1090/readsb instance (fed by their local
 * RTL-SDR dongle) is hearing right now, independent of the public,
 * aggregator-delayed Flights layer. The browser never talks to the receiver
 * directly — it polls the same-origin `/api/local-adsb` proxy, which is the
 * only thing that knows the configured receiver address (see
 * src/data/localAdsbProxy.js for why that's fixed server-side).
 *
 * Off by default: this layer starts disabled, matching issue #57's opt-in
 * requirement, and stays that way until something calls `enable()`. Not yet
 * wired into layerState.js/manager.js/the UI panel — that integration is
 * deliberately deferred until this mocked slice is verified end-to-end.
 */

const LOCAL_ADSB_ENDPOINT = '/api/local-adsb';

/** Bright magenta — deliberately distinct from Flights' white/amber/cyan palette. */
const LOCAL_ADSB_POINT_COLOR = Cesium.Color.fromCssColorString('#ff2ec4');
const LOCAL_ADSB_OUTLINE_COLOR = Cesium.Color.BLACK.withAlpha(0.6);

export function localAdsbEntityId(hex) {
  return `local-adsb:${hex}`;
}

/**
 * Map one normalized aircraft row (as served by `/api/local-adsb`) into
 * `Cesium.Entity` constructor options. Pure — no viewer needed — so the
 * visual contract (distinct color, label content) is unit-testable without a
 * real dump1090 instance or a real Cesium scene.
 * @param {{hex:string, flight:string|null, lat:number, lon:number,
 *   altitudeFt:number|null, groundSpeedKt:number|null}} row
 * @returns {object}
 */
export function buildLocalAdsbEntityOptions(row) {
  const label = row.flight || row.hex.toUpperCase();
  const altitudeText = Number.isFinite(row.altitudeFt) ? `${Math.round(row.altitudeFt)} ft` : 'alt unknown';
  return {
    id: localAdsbEntityId(row.hex),
    position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat, Math.max(0, row.altitudeFt ?? 0) * 0.3048),
    point: {
      pixelSize: 8,
      color: LOCAL_ADSB_POINT_COLOR,
      outlineColor: LOCAL_ADSB_OUTLINE_COLOR,
      outlineWidth: 1,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: `${label}\n${altitudeText}`,
      font: '12px monospace',
      fillColor: LOCAL_ADSB_POINT_COLOR,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 2,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: Cesium.VerticalOrigin.TOP,
      pixelOffset: new Cesium.Cartesian2(0, 10),
      showBackground: true,
      backgroundColor: Cesium.Color.BLACK.withAlpha(0.5),
    },
    properties: {
      hex: row.hex,
      flight: row.flight,
      altitudeFt: row.altitudeFt,
      groundSpeedKt: row.groundSpeedKt,
      source: 'local-adsb',
    },
  };
}

export function createLocalAdsbLayer() {
  let _dataSource = null;
  let _enabled = false;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _baseUrl = null;

  const layer = {
    id: 'local-adsb',
    name: 'Local ADS-B (own receiver)',
    icon: '📡',
    source: 'Local dump1090/readsb',
    // Short poll — the whole point of this layer (per issue #57) is showing
    // what the receiver hears right now, unlike the public Flights layer's
    // 30 s aggregator-delayed poll. Proxy-side caching (localAdsbProxy.js,
    // LOCAL_ADSB_CACHE_TTL_MS) absorbs most of the extra request rate.
    updateInterval: 3000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('local-adsb');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _enabled = false;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
      _baseUrl = null;
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
    },

    async update() {
      if (!_dataSource) return false;
      try {
        const response = await fetch(LOCAL_ADSB_ENDPOINT);
        const body = await response.json().catch(() => null);
        if (!body || !Array.isArray(body.aircraft)) {
          _lastError = body?.error || `local ADS-B proxy HTTP ${response.status}`;
          return false;
        }

        _dataSource.entities.removeAll();
        for (const row of body.aircraft) {
          _dataSource.entities.add(new Cesium.Entity(buildLocalAdsbEntityOptions(row)));
        }

        _count = body.aircraft.length;
        _stale = Boolean(body.stale);
        _baseUrl = body.baseUrl || null;
        _lastUpdate = Date.now();
        _lastError = null;
        return true;
      } catch {
        _lastError = 'local ADS-B network error';
        return false;
      }
    },

    destroy(viewer) {
      _enabled = false;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
      _baseUrl = null;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
        baseUrl: _baseUrl,
        enabled: _enabled,
      };
    },
  };
  return layer;
}

const localAdsbLayer = createLocalAdsbLayer();

export default localAdsbLayer;
