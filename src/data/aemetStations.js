import * as Cesium from 'cesium';

/**
 * AEMET OpenData live weather station pins — Spain only (~850 stations).
 *
 * Polls the /api/aemet/stations proxy (server/providers/weather/aemet.js),
 * which already dedups AEMET's raw ~12-trailing-hourly-rows-per-station feed
 * down to one current reading per station and hides the two-step
 * envelope/datos fetch. This layer's only job is turning that flat station
 * list into colored points with a click-through InfoBox — no polling
 * cadence tricks, no camera-proximity gating (unlike bikeshare's nationwide
 * multi-city scale, ~850 fixed points nationwide is cheap to just keep live).
 */

const API_URL = '/api/aemet/stations';

const COLOR_UNKNOWN = Cesium.Color.fromCssColorString('#91a4b4').withAlpha(0.75);
const COLOR_OUTLINE = Cesium.Color.BLACK.withAlpha(0.6);

/**
 * Stepped temperature palette, coldest to hottest — matches this codebase's
 * existing stepped-band convention (see earthquakes.js's depth bands,
 * bikeshare.js's availability bands) rather than a smooth gradient.
 */
function temperatureColor(temperatureC) {
  if (temperatureC == null || !Number.isFinite(temperatureC)) return COLOR_UNKNOWN;
  if (temperatureC <= 0) return Cesium.Color.fromCssColorString('#3b6cff');
  if (temperatureC <= 10) return Cesium.Color.fromCssColorString('#3bb6ff');
  if (temperatureC <= 20) return Cesium.Color.fromCssColorString('#3bffb0');
  if (temperatureC <= 25) return Cesium.Color.fromCssColorString('#ffe23b');
  if (temperatureC <= 30) return Cesium.Color.fromCssColorString('#ff9d3b');
  return Cesium.Color.fromCssColorString('#ff3b3b');
}

function fmt(value, unit, digits = 0) {
  return Number.isFinite(value) ? `${value.toFixed(digits)}${unit}` : '—';
}

/** Small HTML description for Cesium's default click InfoBox. Pure, exported for tests. */
export function buildAemetStationDescription(station) {
  const observed = Number.isFinite(station?.observedAtMs)
    ? new Date(station.observedAtMs).toLocaleString()
    : 'unknown';
  return (
    `<table class="cesium-infoBox-defaultTable">`
    + `<tbody>`
    + `<tr><th>Station</th><td>${station?.id ?? '—'}</td></tr>`
    + `<tr><th>Temperature</th><td>${fmt(station?.temperatureC, '°C', 1)}</td></tr>`
    + `<tr><th>Humidity</th><td>${fmt(station?.humidityPct, '%')}</td></tr>`
    + `<tr><th>Pressure</th><td>${fmt(station?.pressureHpa, ' hPa', 1)}</td></tr>`
    + `<tr><th>Wind</th><td>${fmt(station?.windSpeedMs, ' m/s', 1)}`
    + `${Number.isFinite(station?.windDirectionDeg) ? ` @ ${station.windDirectionDeg.toFixed(0)}°` : ''}</td></tr>`
    + `<tr><th>Gust</th><td>${fmt(station?.windGustMs, ' m/s', 1)}</td></tr>`
    + `<tr><th>Precipitation</th><td>${fmt(station?.precipitationMm, ' mm', 1)}</td></tr>`
    + `<tr><th>Altitude</th><td>${fmt(station?.altitudeM, ' m')}</td></tr>`
    + `<tr><th>Observed</th><td>${observed}</td></tr>`
    + `</tbody></table>`
  );
}

/** Validate the proxy's payload shape before replacing the last good snapshot. */
export function normalizeAemetStationsPayload(payload) {
  if (!Array.isArray(payload?.stations)) return null;
  const rows = [];
  for (const station of payload.stations) {
    const lat = Number(station?.lat);
    const lon = Number(station?.lon);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) continue;
    if (!station?.id) continue;
    rows.push(station);
  }
  return rows;
}

export function createAemetStationsLayer() {
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;

  const layer = {
    id: 'aemet-stations',
    name: 'AEMET Weather Stations',
    icon: '🌡',
    source: 'AEMET OpenData · Spain',
    updateInterval: 300000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('aemet-stations');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      console.log('[Data:AemetStations] Initialized');
    },

    enable(viewer) {
      if (_dataSource) _dataSource.show = true;
    },

    disable(viewer) {
      if (_dataSource) _dataSource.show = false;
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
        for (const station of stations) {
          nextEntities.push(new Cesium.Entity({
            id: `aemet-station:${station.id}`,
            position: Cesium.Cartesian3.fromDegrees(station.lon, station.lat),
            point: {
              pixelSize: 7,
              color: temperatureColor(station.temperatureC),
              outlineColor: COLOR_OUTLINE,
              outlineWidth: 1,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            name: station.name || station.id,
            description: buildAemetStationDescription(station),
            properties: { ...station },
          }));
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);

        _count = stations.length;
        _lastUpdate = Date.now();
        _lastError = payload.stale ? 'Serving stale AEMET data (upstream unavailable)' : null;
        console.log(`[Data:AemetStations] Updated: ${_count} stations`);
        return true;
      } catch (e) {
        console.warn('[Data:AemetStations] Fetch error:', e);
        _lastError = 'AEMET network error';
        return false;
      }
    },

    destroy(viewer) {
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
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
      const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 2000;
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
          humidityPct: get('humidityPct'),
          pressureHpa: get('pressureHpa'),
          windSpeedMs: get('windSpeedMs'),
          windDirectionDeg: get('windDirectionDeg'),
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
  };
  return layer;
}

const aemetStationsLayer = createAemetStationsLayer();

export default aemetStationsLayer;
