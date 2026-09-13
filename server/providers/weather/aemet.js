import path from 'node:path';
import { promises as fsp } from 'node:fs';

import {
  AEMET_BEACHES_NOMENCLATOR_URL,
  aemetBeachForecastEnvelopeUrl,
  aemetFireRiskEstimadoEnvelopeUrl,
  aemetFireRiskPrevistoEnvelopeUrl,
  aemetLightningEnvelopeUrl,
  aemetMunicipioForecastEnvelopeUrl,
  aemetMunicipiosEnvelopeUrl,
  aemetSeaSurfaceTempEnvelopeUrl,
  aemetStationsEnvelopeUrl,
  aemetUvIndexEnvelopeUrl,
  aemetWarningsEnvelopeUrl,
  filterActiveAemetWarnings,
  filterFreshAemetStations,
  filterUpcomingAemetForecastHours,
  findNearestAemetMunicipio,
  madridCivilNow,
  normalizeAemetBeachesNomenclator,
  normalizeAemetBeachForecastRecord,
  normalizeAemetHourlyForecast,
  normalizeAemetMunicipiosSnapshot,
  normalizeAemetStationsSnapshot,
  normalizeAemetUvIndexSnapshot,
  normalizeAemetWarningsSnapshot,
  parseAemetCapAlert,
  parseAemetCapTar,
} from '../../../src/data/weatherProviderRequests.js';

/**
 * AEMET OpenData live station-observations proxy with a memory + disk cache.
 * Upstream: https://opendata.aemet.es/opendata/api/observacion/convencional/todas
 *
 * AEMET's API is a two-step fetch: the request above returns
 * {descripcion, estado, datos, metadatos}, and `datos` is a SECOND url
 * holding the real ~9.8k-row observation array (confirmed live: ~854 unique
 * stations, up to ~12 trailing hourly rows each — deduplicated to one row per
 * station by src/data/weatherProviderRequests.js). That second response is
 * served as `text/plain;charset=ISO-8859-15`, confirmed against the live API
 * — decoding it as UTF-8 mangles accented station names (e.g. "VANDELL�S"
 * instead of "VANDELLÓS"), so it's read as a Buffer and decoded with Node's
 * built-in `latin1` (ISO-8859-1, close enough to -15 for Spanish place names)
 * rather than trusted to `res.json()`.
 *
 * AEMET's stated cap is roughly 50 requests/minute per key; station data
 * itself only updates hourly, so TTL 20 min plus a fresh-enough disk cache
 * (.gev-cache/aemet-stations.json) keeps normal usage far under that even
 * across dev-server restarts. Pattern mirrors firmsProxy/celestrakProxy.
 *
 * Routes:
 *   GET /api/aemet/stations        → {fetchedAt, stale, ttlMs, count, stations}
 *   GET /api/aemet/stations/status → {hasKey, lastFetch, count, stale, ttlMs}
 *
 * Keyless (no AEMET_API_KEY): /api/aemet/stations → 503 {error:'no_key'};
 * status → {hasKey:false}. Upstream is never touched without a key.
 *
 * @returns {import('vite').Plugin}
 */
export function aemetStationsProxy() {
  const TTL_MS = 20 * 60_000;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const CACHE_PATH = path.join(CACHE_DIR, 'aemet-stations.json');

  /** @type {?{at: number, stations: Array<object>}} */
  let mem = null;
  let diskChecked = false;
  /** @type {?Promise<?{at: number, stations: Array<object>}>} single-flight refresh */
  let inflight = null;

  const mapKey = () => String(process.env.AEMET_API_KEY || '').trim();

  async function readDiskOnce() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      if (Number.isFinite(parsed?.at) && Array.isArray(parsed?.stations)) mem = parsed;
    } catch {
      /* no disk cache yet */
    }
  }

  async function writeDisk(entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(CACHE_PATH, JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[aemet-proxy] cache write failed:', err?.message || err);
    }
  }

  /**
   * The two-step fetch. Throws on any failure (HTTP error, non-200 `estado`,
   * missing `datos`, unparsable payload) so the caller can serve stale.
   * Never logs the URL — it embeds the key.
   */
  async function fetchUpstream(key) {
    const envelopeRes = await fetch(aemetStationsEnvelopeUrl(key), {
      signal: AbortSignal.timeout(20_000),
    });
    if (!envelopeRes.ok) throw new Error(`HTTP ${envelopeRes.status}`);
    const envelope = await envelopeRes.json();
    if (envelope?.estado !== 200 || typeof envelope?.datos !== 'string') {
      throw new Error(`AEMET estado ${envelope?.estado ?? 'unknown'}: ${envelope?.descripcion || 'no datos url'}`);
    }
    const dataRes = await fetch(envelope.datos, { signal: AbortSignal.timeout(20_000) });
    if (!dataRes.ok) throw new Error(`HTTP ${dataRes.status} fetching datos`);
    const buffer = Buffer.from(await dataRes.arrayBuffer());
    const records = JSON.parse(buffer.toString('latin1'));
    return normalizeAemetStationsSnapshot(records);
  }

  async function refreshUpstream(key) {
    const stations = await fetchUpstream(key);
    return { at: Date.now(), stations };
  }

  /** Cache entry → response payload, re-filtered to "fresh" at serve time. */
  function buildPayload(entry, stale) {
    const stations = filterFreshAemetStations(entry.stations, Date.now());
    return {
      fetchedAt: entry.at,
      stale,
      ttlMs: TTL_MS,
      count: stations.length,
      stations,
    };
  }

  return {
    name: 'aemet-stations-proxy',
    configureServer(server) {
      server.middlewares.use('/api/aemet/stations', async (req, res) => {
        const sendJson = (status, obj) => {
          if (res.headersSent) return;
          res.writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(obj));
        };
        try {
          const subPath = String(req.url || '').split('?')[0];
          const key = mapKey();
          await readDiskOnce();

          if (subPath === '/status') {
            sendJson(200, {
              hasKey: Boolean(key),
              lastFetch: mem ? mem.at : null,
              count: mem ? filterFreshAemetStations(mem.stations, Date.now()).length : null,
              stale: mem ? Date.now() - mem.at >= TTL_MS : false,
              ttlMs: TTL_MS,
            });
            return;
          }

          if (!key) {
            sendJson(503, { error: 'no_key' });
            return;
          }

          const entry = mem;
          if (entry && Date.now() - entry.at < TTL_MS) {
            sendJson(200, buildPayload(entry, false));
            return;
          }
          // Stale or missing → refresh, single-flight (concurrent requests
          // share one upstream pass). Capture the promise locally BEFORE
          // awaiting: the .finally() nulls `inflight` the moment it settles.
          if (!inflight) {
            inflight = refreshUpstream(key)
              .then(async (fresh) => {
                mem = fresh;
                await writeDisk(fresh);
                return fresh;
              })
              .catch((err) => {
                console.warn(
                  `[aemet-proxy] refresh failed (${err?.message || err}) — serving cache if any`,
                );
                return null;
              })
              .finally(() => {
                inflight = null;
              });
          }
          const pending = inflight;
          const fresh = await pending;
          if (fresh) {
            sendJson(200, buildPayload(fresh, false));
          } else if (entry) {
            sendJson(200, buildPayload(entry, true)); // upstream down — stale beats empty
          } else {
            sendJson(502, { error: 'aemet fetch failed and no cache available' });
          }
        } catch (err) {
          console.warn('[aemet-proxy] error:', err?.message || err);
          sendJson(500, { error: 'aemet proxy error' });
        }
      });
    },
  };
}

/**
 * AEMET OpenData live weather-warnings (avisos) proxy with a memory + disk
 * cache. Upstream: https://opendata.aemet.es/opendata/api/avisos_cap/ultimoelaborado/area/esp
 *
 * Same two-step envelope as the stations proxy, but the `datos` payload is
 * a different shape entirely: a plain (NOT gzipped, despite the `.tar.gz`
 * filename AEMET gives it — confirmed against real bytes) POSIX tar archive
 * of ~190 CAP 1.2 XML files, one per (phenomenon × level × zone-group)
 * bulletin AEMET currently has elaborated. Unlike the stations feed, the
 * individual XML files ARE genuinely UTF-8 (confirmed live — decoding as
 * UTF-8 gives correct "Meteorología", latin1 mangles it into
 * "MeteorologÃ­a", the REVERSE of the stations encoding bug) — decoded with
 * `.toString('utf8')` per extracted file, never latin1.
 *
 * Every CAP alert carries its own warning-zone polygon(s) inline, so there
 * is no separate zone shapefile/GeoJSON to fetch or keep in sync.
 * `AEMET-Meteoalerta nivel` verde ("nothing to see here") is bundled for
 * essentially the whole country per phenomenon as a matter of course;
 * `filterActiveAemetWarnings` (src/data/weatherProviderRequests.js) drops it
 * along with anything already expired, so only zones with a real active
 * amarillo/naranja/rojo phenomenon ever reach the browser.
 *
 * Warnings can escalate faster than station readings update, so TTL is
 * shorter than the stations proxy's 20 min — still trivial against AEMET's
 * ~50 req/min cap (2 requests per refresh, a handful of times an hour).
 *
 * Routes:
 *   GET /api/aemet/warnings        → {fetchedAt, stale, ttlMs, count, zones}
 *   GET /api/aemet/warnings/status → {hasKey, lastFetch, count, stale, ttlMs}
 *
 * Keyless (no AEMET_API_KEY): /api/aemet/warnings → 503 {error:'no_key'};
 * status → {hasKey:false}. Upstream is never touched without a key.
 *
 * @returns {import('vite').Plugin}
 */
export function aemetWarningsProxy() {
  const TTL_MS = 12 * 60_000;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const CACHE_PATH = path.join(CACHE_DIR, 'aemet-warnings.json');

  /** @type {?{at: number, zones: Array<object>}} */
  let mem = null;
  let diskChecked = false;
  /** @type {?Promise<?{at: number, zones: Array<object>}>} single-flight refresh */
  let inflight = null;

  const mapKey = () => String(process.env.AEMET_API_KEY || '').trim();

  async function readDiskOnce() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      if (Number.isFinite(parsed?.at) && Array.isArray(parsed?.zones)) mem = parsed;
    } catch {
      /* no disk cache yet */
    }
  }

  async function writeDisk(entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(CACHE_PATH, JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[aemet-warnings-proxy] cache write failed:', err?.message || err);
    }
  }

  /**
   * The two-step fetch plus tar/CAP-XML extraction. Throws on any failure
   * (HTTP error, non-200 `estado`, missing `datos`) so the caller can serve
   * stale; an individual unparsable XML entry is skipped by
   * `parseAemetCapAlert`/`parseAemetCapTar` rather than failing the whole
   * batch — the same "one bad record must not blank ~230 good zones"
   * posture as the stations proxy. Never logs the URL — it embeds the key.
   */
  async function fetchUpstream(key) {
    const envelopeRes = await fetch(aemetWarningsEnvelopeUrl(key), {
      signal: AbortSignal.timeout(20_000),
    });
    if (!envelopeRes.ok) throw new Error(`HTTP ${envelopeRes.status}`);
    const envelope = await envelopeRes.json();
    if (envelope?.estado !== 200 || typeof envelope?.datos !== 'string') {
      throw new Error(`AEMET estado ${envelope?.estado ?? 'unknown'}: ${envelope?.descripcion || 'no datos url'}`);
    }
    const tarRes = await fetch(envelope.datos, { signal: AbortSignal.timeout(30_000) });
    if (!tarRes.ok) throw new Error(`HTTP ${tarRes.status} fetching datos`);
    const buffer = Buffer.from(await tarRes.arrayBuffer());
    const entries = parseAemetCapTar(buffer);
    const alerts = [];
    for (const entry of entries) {
      if (!entry.name.endsWith('.xml')) continue;
      const alert = parseAemetCapAlert(entry.content.toString('utf8'));
      if (alert) alerts.push(alert);
    }
    return normalizeAemetWarningsSnapshot(alerts);
  }

  async function refreshUpstream(key) {
    const zones = await fetchUpstream(key);
    return { at: Date.now(), zones };
  }

  /** Cache entry → response payload, re-filtered to "active" at serve time. */
  function buildPayload(entry, stale) {
    const zones = filterActiveAemetWarnings(entry.zones, Date.now());
    return {
      fetchedAt: entry.at,
      stale,
      ttlMs: TTL_MS,
      count: zones.length,
      zones,
    };
  }

  return {
    name: 'aemet-warnings-proxy',
    configureServer(server) {
      server.middlewares.use('/api/aemet/warnings', async (req, res) => {
        const sendJson = (status, obj) => {
          if (res.headersSent) return;
          res.writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(obj));
        };
        try {
          const subPath = String(req.url || '').split('?')[0];
          const key = mapKey();
          await readDiskOnce();

          if (subPath === '/status') {
            sendJson(200, {
              hasKey: Boolean(key),
              lastFetch: mem ? mem.at : null,
              count: mem ? filterActiveAemetWarnings(mem.zones, Date.now()).length : null,
              stale: mem ? Date.now() - mem.at >= TTL_MS : false,
              ttlMs: TTL_MS,
            });
            return;
          }

          if (!key) {
            sendJson(503, { error: 'no_key' });
            return;
          }

          const entry = mem;
          if (entry && Date.now() - entry.at < TTL_MS) {
            sendJson(200, buildPayload(entry, false));
            return;
          }
          if (!inflight) {
            inflight = refreshUpstream(key)
              .then(async (fresh) => {
                mem = fresh;
                await writeDisk(fresh);
                return fresh;
              })
              .catch((err) => {
                console.warn(
                  `[aemet-warnings-proxy] refresh failed (${err?.message || err}) — serving cache if any`,
                );
                return null;
              })
              .finally(() => {
                inflight = null;
              });
          }
          const pending = inflight;
          const fresh = await pending;
          if (fresh) {
            sendJson(200, buildPayload(fresh, false));
          } else if (entry) {
            sendJson(200, buildPayload(entry, true)); // upstream down — stale beats empty
          } else {
            sendJson(502, { error: 'aemet warnings fetch failed and no cache available' });
          }
        } catch (err) {
          console.warn('[aemet-warnings-proxy] error:', err?.message || err);
          sendJson(500, { error: 'aemet warnings proxy error' });
        }
      });
    },
  };
}

/**
 * AEMET OpenData on-demand "next hours" municipio-forecast proxy (Phase A2).
 * Upstream: `maestro/municipios` (a fixed, nationwide id/name/lat/lon lookup
 * table, ~8.1k rows, confirmed live) + `prediccion/especifica/municipio/
 * horaria/{municipio}` (that municipio's hourly forecast).
 *
 * Unlike the two proxies above, this is deliberately query-driven rather
 * than a polled whole-country snapshot — a click supplies a lat/lon (e.g. an
 * `aemet-stations` pin), the server resolves it to the nearest municipio
 * (`findNearestAemetMunicipio`, a plain great-circle nearest-neighbor scan —
 * accurate enough for "which municipio is this station in", and no spatial
 * index is worth building for an ~8k-row one-off lookup), and returns that
 * municipio's upcoming hours. The municipio table itself barely ever
 * changes, so it gets a long TTL and lives in memory only (no disk cache —
 * unlike stations/warnings, there is no "serve yesterday's snapshot while
 * upstream is down" story that matters here: without the table, `datos`
 * from the second call would have to be re-derived anyway, and re-fetching
 * once every #TTL is cheap). Per-municipio forecasts get their own short-TTL
 * memory cache, keyed by municipio id, capped at `MAX_CACHED_MUNICIPIOS`
 * entries (evicting the oldest) — most usage clicks a handful of the same
 * regions repeatedly, so an unbounded map isn't worth guarding against, but
 * an explicit cap costs nothing and rules it out.
 *
 * Every AEMET hourly timestamp is naive Europe/Madrid civil time with no UTC
 * offset (see `normalizeAemetHourlyForecast`'s own comment) — "upcoming" is
 * judged via `madridCivilNow()`, not the server process's own timezone.
 *
 * Routes:
 *   GET /api/aemet/forecast?lat=<>&lon=<> → {fetchedAt, stale, ttlMs,
 *     municipio: {id, name, lat, lon, distanceKm}, hours: [...]}
 *   GET /api/aemet/forecast/status → {hasKey, municipiosLoaded,
 *     municipiosLastFetch, cachedForecastCount}
 *
 * Keyless (no AEMET_API_KEY): /api/aemet/forecast → 503 {error:'no_key'};
 * status → {hasKey:false}. A missing/invalid lat/lon → 400 {error:'bad_request'}.
 * Upstream is never touched without a key.
 *
 * @returns {import('vite').Plugin}
 */
export function aemetForecastProxy() {
  const MUNICIPIOS_TTL_MS = 24 * 3600_000;
  const FORECAST_TTL_MS = 45 * 60_000;
  const MAX_CACHED_MUNICIPIOS = 300;

  /** @type {?{at: number, municipios: Array<object>}} */
  let municipiosMem = null;
  /** @type {?Promise<Array<object>>} single-flight municipios refresh */
  let municipiosInflight = null;
  /** @type {Map<string, {at: number, forecast: object}>} municipio id -> cached forecast, insertion-ordered for LRU-ish eviction */
  const forecastByMunicipio = new Map();
  /** @type {Map<string, Promise<object>>} municipio id -> in-flight forecast fetch */
  const forecastInflight = new Map();

  const apiKey = () => String(process.env.AEMET_API_KEY || '').trim();

  async function fetchEnvelope(url, timeoutMs = 20_000) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const envelope = await res.json();
    if (envelope?.estado !== 200 || typeof envelope?.datos !== 'string') {
      throw new Error(`AEMET estado ${envelope?.estado ?? 'unknown'}: ${envelope?.descripcion || 'no datos url'}`);
    }
    const dataRes = await fetch(envelope.datos, { signal: AbortSignal.timeout(timeoutMs) });
    if (!dataRes.ok) throw new Error(`HTTP ${dataRes.status} fetching datos`);
    // Both feeds below are served as ISO-8859-15 despite being JSON, same
    // gotcha as the stations feed (confirmed live) — decode as latin1, never
    // trust res.json() to guess right.
    const buffer = Buffer.from(await dataRes.arrayBuffer());
    return JSON.parse(buffer.toString('latin1'));
  }

  async function ensureMunicipios(key) {
    if (municipiosMem && Date.now() - municipiosMem.at < MUNICIPIOS_TTL_MS) return municipiosMem.municipios;
    if (!municipiosInflight) {
      municipiosInflight = fetchEnvelope(aemetMunicipiosEnvelopeUrl(key), 30_000)
        .then((raw) => {
          const municipios = normalizeAemetMunicipiosSnapshot(raw);
          municipiosMem = { at: Date.now(), municipios };
          return municipios;
        })
        .finally(() => {
          municipiosInflight = null;
        });
    }
    const fresh = await municipiosInflight.catch(() => null);
    if (fresh) return fresh;
    if (municipiosMem) return municipiosMem.municipios; // upstream down — stale beats empty
    throw new Error('municipio lookup table unavailable');
  }

  async function fetchForecastFor(key, municipioId) {
    const raw = await fetchEnvelope(aemetMunicipioForecastEnvelopeUrl(key, municipioId), 20_000);
    const forecast = normalizeAemetHourlyForecast(raw);
    if (!forecast) throw new Error('malformed municipio forecast response');
    return forecast;
  }

  /**
   * @returns {Promise<{forecast: object, fetchedAt: number, stale: boolean}>}
   */
  async function ensureForecast(key, municipioId) {
    const cached = forecastByMunicipio.get(municipioId);
    if (cached && Date.now() - cached.at < FORECAST_TTL_MS) {
      return { forecast: cached.forecast, fetchedAt: cached.at, stale: false };
    }
    let pending = forecastInflight.get(municipioId);
    if (!pending) {
      pending = fetchForecastFor(key, municipioId).finally(() => {
        forecastInflight.delete(municipioId);
      });
      forecastInflight.set(municipioId, pending);
    }
    try {
      const forecast = await pending;
      const at = Date.now();
      forecastByMunicipio.delete(municipioId); // re-insert at the end → most-recently-used
      forecastByMunicipio.set(municipioId, { at, forecast });
      while (forecastByMunicipio.size > MAX_CACHED_MUNICIPIOS) {
        forecastByMunicipio.delete(forecastByMunicipio.keys().next().value);
      }
      return { forecast, fetchedAt: at, stale: false };
    } catch (err) {
      if (cached) return { forecast: cached.forecast, fetchedAt: cached.at, stale: true }; // upstream down — stale beats empty
      throw err;
    }
  }

  return {
    name: 'aemet-forecast-proxy',
    configureServer(server) {
      server.middlewares.use('/api/aemet/forecast', async (req, res) => {
        const sendJson = (status, obj) => {
          if (res.headersSent) return;
          res.writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(obj));
        };
        try {
          const url = new URL(req.url || '', 'http://internal');
          const key = apiKey();

          if (url.pathname === '/status') {
            sendJson(200, {
              hasKey: Boolean(key),
              municipiosLoaded: municipiosMem ? municipiosMem.municipios.length : 0,
              municipiosLastFetch: municipiosMem ? municipiosMem.at : null,
              cachedForecastCount: forecastByMunicipio.size,
            });
            return;
          }

          if (!key) {
            sendJson(503, { error: 'no_key' });
            return;
          }

          const lat = Number(url.searchParams.get('lat'));
          const lon = Number(url.searchParams.get('lon'));
          if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) {
            sendJson(400, { error: 'bad_request' });
            return;
          }

          const municipios = await ensureMunicipios(key);
          const nearest = findNearestAemetMunicipio(municipios, lat, lon);
          if (!nearest) {
            sendJson(502, { error: 'aemet municipio lookup failed and no cache available' });
            return;
          }

          const { forecast, fetchedAt, stale } = await ensureForecast(key, nearest.municipio.id);

          sendJson(200, {
            fetchedAt,
            stale,
            ttlMs: FORECAST_TTL_MS,
            municipio: {
              id: nearest.municipio.id,
              name: nearest.municipio.name,
              lat: nearest.municipio.lat,
              lon: nearest.municipio.lon,
              distanceKm: nearest.distanceKm,
            },
            hours: filterUpcomingAemetForecastHours(forecast.hours, madridCivilNow()),
          });
        } catch (err) {
          console.warn('[aemet-forecast-proxy] error:', err?.message || err);
          sendJson(502, { error: 'aemet forecast fetch failed and no cache available' });
        }
      });
    },
  };
}

/**
 * AEMET OpenData lightning-activity composite proxy (Phase A4). Upstream:
 * https://opendata.aemet.es/opendata/api/red/rayos/mapa
 *
 * Same two-step envelope as the other AEMET feeds, but the `datos` payload
 * is opaque binary — a pre-rendered GIF composite (confirmed live:
 * `image/gif`, 640×480, AEMET's own province-outline map with lightning
 * strikes plotted on it, plus a baked-in legend strip; NOT a raw strike
 * coordinate list, and NOT georeferenced in any machine-readable way this
 * API exposes). There is nothing to parse: the bytes pass straight through.
 *
 * AEMET refreshes this "cada seis horas o 00Z, 06Z, 12Z, 18Z" (confirmed via
 * its own metadatos description) — far slower than stations/warnings — so
 * this proxy deliberately uses a 6-hour TTL and, unlike those two, a
 * memory-ONLY cache: an image this infrequently updated has no meaningful
 * "serve yesterday's snapshot across a server restart" story beyond what a
 * fresh fetch already costs (one cheap envelope + one image fetch), unlike
 * the higher-frequency feeds where disk persistence avoids re-fetching a
 * near-identical response on every dev-server restart.
 *
 * Routes:
 *   GET /api/aemet/lightning        → raw image bytes, `Content-Type` from
 *     upstream (confirmed `image/gif`)
 *   GET /api/aemet/lightning/status → {hasKey, lastFetch, stale, ttlMs,
 *     contentType}
 *
 * Keyless (no AEMET_API_KEY): /api/aemet/lightning → 503 {error:'no_key'};
 * status → {hasKey:false}. Upstream is never touched without a key.
 *
 * @returns {import('vite').Plugin}
 */
export function aemetLightningProxy() {
  const TTL_MS = 6 * 3600_000;

  /** @type {?{at: number, buffer: Buffer, contentType: string}} */
  let mem = null;
  /** @type {?Promise<?{at: number, buffer: Buffer, contentType: string}>} single-flight refresh */
  let inflight = null;

  const apiKey = () => String(process.env.AEMET_API_KEY || '').trim();

  /**
   * The two-step fetch. Throws on any failure so the caller can serve
   * stale. Never logs the URL — it embeds the key.
   */
  async function fetchUpstream(key) {
    const envelopeRes = await fetch(aemetLightningEnvelopeUrl(key), {
      signal: AbortSignal.timeout(20_000),
    });
    if (!envelopeRes.ok) throw new Error(`HTTP ${envelopeRes.status}`);
    const envelope = await envelopeRes.json();
    if (envelope?.estado !== 200 || typeof envelope?.datos !== 'string') {
      throw new Error(`AEMET estado ${envelope?.estado ?? 'unknown'}: ${envelope?.descripcion || 'no datos url'}`);
    }
    const dataRes = await fetch(envelope.datos, { signal: AbortSignal.timeout(20_000) });
    if (!dataRes.ok) throw new Error(`HTTP ${dataRes.status} fetching datos`);
    const buffer = Buffer.from(await dataRes.arrayBuffer());
    const contentType = (dataRes.headers.get('content-type') || 'image/gif').split(';')[0].trim();
    return { at: Date.now(), buffer, contentType };
  }

  return {
    name: 'aemet-lightning-proxy',
    configureServer(server) {
      server.middlewares.use('/api/aemet/lightning', async (req, res) => {
        const sendJson = (status, obj) => {
          if (res.headersSent) return;
          res.writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(obj));
        };
        try {
          const subPath = String(req.url || '').split('?')[0];
          const key = apiKey();

          if (subPath === '/status') {
            sendJson(200, {
              hasKey: Boolean(key),
              lastFetch: mem ? mem.at : null,
              stale: mem ? Date.now() - mem.at >= TTL_MS : false,
              ttlMs: TTL_MS,
              contentType: mem ? mem.contentType : null,
            });
            return;
          }

          if (!key) {
            sendJson(503, { error: 'no_key' });
            return;
          }

          const entry = mem;
          if (entry && Date.now() - entry.at < TTL_MS) {
            res.writeHead(200, { 'Content-Type': entry.contentType, 'Cache-Control': 'no-store' });
            res.end(entry.buffer);
            return;
          }
          if (!inflight) {
            inflight = fetchUpstream(key)
              .then((fresh) => {
                mem = fresh;
                return fresh;
              })
              .catch((err) => {
                console.warn(
                  `[aemet-lightning-proxy] refresh failed (${err?.message || err}) — serving cache if any`,
                );
                return null;
              })
              .finally(() => {
                inflight = null;
              });
          }
          const pending = inflight;
          const fresh = await pending;
          if (fresh) {
            res.writeHead(200, { 'Content-Type': fresh.contentType, 'Cache-Control': 'no-store' });
            res.end(fresh.buffer);
          } else if (entry) {
            res.writeHead(200, { 'Content-Type': entry.contentType, 'Cache-Control': 'no-store' }); // upstream down — stale beats empty
            res.end(entry.buffer);
          } else {
            sendJson(502, { error: 'aemet lightning fetch failed and no cache available' });
          }
        } catch (err) {
          console.warn('[aemet-lightning-proxy] error:', err?.message || err);
          sendJson(500, { error: 'aemet lightning proxy error' });
        }
      });
    },
  };
}

/**
 * AEMET OpenData forest-fire meteorological risk-map proxy (Phase A5).
 * Upstream: `incendios/mapasriesgo/estimado/area/{area}` (today), falling
 * back to `incendios/mapasriesgo/previsto/dia/1/area/{area}` (tomorrow)
 * when "today" has no published product yet — confirmed live: `estimado`
 * returned 404 "No hay datos que satisfagan esos criterios" while
 * `previsto/dia/1` succeeded immediately after, so a real deployment can't
 * assume "today" is always available.
 *
 * Same "opaque legend-annotated raster, nothing to parse" shape as
 * `aemetLightningProxy()`: a real pull returned a 1525×1017 `image/png`
 * with AEMET's own header/legend/logo baked in (confirmed live), no
 * bounding box anywhere in the response. v1 fixes `area` to `p` (Península)
 * — Baleares/Canarias are a future per-layer chip, not built here.
 *
 * `periodicidad: diario` per the live metadatos pull — a 3h TTL (well
 * inside that cadence) and a memory-only cache, same reasoning as lightning
 * (an image this infrequently updated has no "survive a restart" story
 * worth disk persistence).
 *
 * Routes:
 *   GET /api/aemet/fire-risk        → raw image bytes, `Content-Type` from
 *     upstream (confirmed `image/png`)
 *   GET /api/aemet/fire-risk/status → {hasKey, lastFetch, stale, ttlMs,
 *     contentType, source: 'estimado'|'previsto-1'}
 *
 * Keyless (no AEMET_API_KEY): /api/aemet/fire-risk → 503 {error:'no_key'};
 * status → {hasKey:false}. Upstream is never touched without a key.
 *
 * @returns {import('vite').Plugin}
 */
export function aemetFireRiskProxy() {
  const TTL_MS = 3 * 3600_000;
  const AREA = 'p';

  /** @type {?{at: number, buffer: Buffer, contentType: string, source: string}} */
  let mem = null;
  /** @type {?Promise<?{at: number, buffer: Buffer, contentType: string, source: string}>} single-flight refresh */
  let inflight = null;

  const apiKey = () => String(process.env.AEMET_API_KEY || '').trim();

  /** One envelope+datos fetch. Throws on any failure — the caller decides what to try next. */
  async function fetchOne(envelopeUrl, timeoutMs = 20_000) {
    const envelopeRes = await fetch(envelopeUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!envelopeRes.ok) throw new Error(`HTTP ${envelopeRes.status}`);
    const envelope = await envelopeRes.json();
    if (envelope?.estado !== 200 || typeof envelope?.datos !== 'string') {
      throw new Error(`AEMET estado ${envelope?.estado ?? 'unknown'}: ${envelope?.descripcion || 'no datos url'}`);
    }
    const dataRes = await fetch(envelope.datos, { signal: AbortSignal.timeout(timeoutMs) });
    if (!dataRes.ok) throw new Error(`HTTP ${dataRes.status} fetching datos`);
    const buffer = Buffer.from(await dataRes.arrayBuffer());
    const contentType = (dataRes.headers.get('content-type') || 'image/png').split(';')[0].trim();
    return { buffer, contentType };
  }

  /**
   * `estimado` first, `previsto` day 1 on ANY failure of the first — not
   * just a 404, since a transient envelope/datos error on "today" should
   * fall back the same way a genuine "not published yet" does, rather than
   * surfacing an error when tomorrow's map is perfectly servable.
   */
  async function fetchUpstream(key) {
    try {
      const result = await fetchOne(aemetFireRiskEstimadoEnvelopeUrl(key, AREA));
      return { at: Date.now(), source: 'estimado', ...result };
    } catch (estimadoErr) {
      try {
        const result = await fetchOne(aemetFireRiskPrevistoEnvelopeUrl(key, AREA, '1'));
        return { at: Date.now(), source: 'previsto-1', ...result };
      } catch (previstoErr) {
        throw new Error(`estimado: ${estimadoErr?.message || estimadoErr}; previsto-1: ${previstoErr?.message || previstoErr}`);
      }
    }
  }

  return {
    name: 'aemet-fire-risk-proxy',
    configureServer(server) {
      server.middlewares.use('/api/aemet/fire-risk', async (req, res) => {
        const sendJson = (status, obj) => {
          if (res.headersSent) return;
          res.writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(obj));
        };
        try {
          const subPath = String(req.url || '').split('?')[0];
          const key = apiKey();

          if (subPath === '/status') {
            sendJson(200, {
              hasKey: Boolean(key),
              lastFetch: mem ? mem.at : null,
              stale: mem ? Date.now() - mem.at >= TTL_MS : false,
              ttlMs: TTL_MS,
              contentType: mem ? mem.contentType : null,
              source: mem ? mem.source : null,
            });
            return;
          }

          if (!key) {
            sendJson(503, { error: 'no_key' });
            return;
          }

          const entry = mem;
          if (entry && Date.now() - entry.at < TTL_MS) {
            res.writeHead(200, { 'Content-Type': entry.contentType, 'Cache-Control': 'no-store' });
            res.end(entry.buffer);
            return;
          }
          if (!inflight) {
            inflight = fetchUpstream(key)
              .then((fresh) => {
                mem = fresh;
                return fresh;
              })
              .catch((err) => {
                console.warn(
                  `[aemet-fire-risk-proxy] refresh failed (${err?.message || err}) — serving cache if any`,
                );
                return null;
              })
              .finally(() => {
                inflight = null;
              });
          }
          const pending = inflight;
          const fresh = await pending;
          if (fresh) {
            res.writeHead(200, { 'Content-Type': fresh.contentType, 'Cache-Control': 'no-store' });
            res.end(fresh.buffer);
          } else if (entry) {
            res.writeHead(200, { 'Content-Type': entry.contentType, 'Cache-Control': 'no-store' }); // upstream down — stale beats empty
            res.end(entry.buffer);
          } else {
            sendJson(502, { error: 'aemet fire-risk fetch failed and no cache available' });
          }
        } catch (err) {
          console.warn('[aemet-fire-risk-proxy] error:', err?.message || err);
          sendJson(500, { error: 'aemet fire-risk proxy error' });
        }
      });
    },
  };
}

/**
 * AEMET OpenData UV-index proxy (Phase A8). Upstream:
 * `prediccion/especifica/uvi/0` (today, confirmed live) — the friendliest
 * shape found in this whole plan: real structured JSON, 59 provincial-
 * capital cities, each keyed by the SAME 5-digit INE municipio code
 * `maestro/municipios` already uses for Phase A2's forecast tooltip. No
 * image, no legend, no missing-geometry problem — this proxy joins each
 * city to its lat/lon via the same municipios lookup `aemetForecastProxy()`
 * already established (re-fetched/cached independently here rather than
 * sharing state across proxy closures, matching this file's existing
 * convention of self-contained proxies — a second 24h-cached fetch of an
 * ~8k-row table once a day is trivial against AEMET's ~50 req/min cap).
 *
 * TTL 3h (same reasoning as fire-risk: well inside the daily cadence
 * `FECHA_ELABORACION`/`FECHA_VALIDEZ` imply), memory-only cache for both
 * the municipios table and the UV snapshot itself.
 *
 * Routes:
 *   GET /api/aemet/uv-index        → {fetchedAt, stale, ttlMs, count,
 *     elaborated, validAt, cities: [{municipioId, name, uvIndex,
 *     isCanaryIslands, lat, lon}]}
 *   GET /api/aemet/uv-index/status → {hasKey, lastFetch, count, stale, ttlMs}
 *
 * Keyless (no AEMET_API_KEY): /api/aemet/uv-index → 503 {error:'no_key'};
 * status → {hasKey:false}. Upstream is never touched without a key.
 *
 * @returns {import('vite').Plugin}
 */
export function aemetUvIndexProxy() {
  const MUNICIPIOS_TTL_MS = 24 * 3600_000;
  const UV_TTL_MS = 3 * 3600_000;
  const DIA = '0'; // today — confirmed live; forecast day offsets are a future extension, not built here

  /** @type {?{at: number, municipios: Array<object>}} */
  let municipiosMem = null;
  /** @type {?Promise<Array<object>>} single-flight municipios refresh */
  let municipiosInflight = null;
  /** @type {?{at: number, cities: Array<object>}} */
  let mem = null;
  /** @type {?Promise<?{at: number, cities: Array<object>}>} single-flight refresh */
  let inflight = null;

  const apiKey = () => String(process.env.AEMET_API_KEY || '').trim();

  async function fetchEnvelope(url, timeoutMs = 20_000) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const envelope = await res.json();
    if (envelope?.estado !== 200 || typeof envelope?.datos !== 'string') {
      throw new Error(`AEMET estado ${envelope?.estado ?? 'unknown'}: ${envelope?.descripcion || 'no datos url'}`);
    }
    const dataRes = await fetch(envelope.datos, { signal: AbortSignal.timeout(timeoutMs) });
    if (!dataRes.ok) throw new Error(`HTTP ${dataRes.status} fetching datos`);
    // Same ISO-8859-15-despite-being-JSON gotcha as stations/forecast —
    // decode as latin1, never trust res.json() to guess right.
    const buffer = Buffer.from(await dataRes.arrayBuffer());
    return JSON.parse(buffer.toString('latin1'));
  }

  async function ensureMunicipios(key) {
    if (municipiosMem && Date.now() - municipiosMem.at < MUNICIPIOS_TTL_MS) return municipiosMem.municipios;
    if (!municipiosInflight) {
      municipiosInflight = fetchEnvelope(aemetMunicipiosEnvelopeUrl(key), 30_000)
        .then((raw) => {
          const municipios = normalizeAemetMunicipiosSnapshot(raw);
          municipiosMem = { at: Date.now(), municipios };
          return municipios;
        })
        .finally(() => {
          municipiosInflight = null;
        });
    }
    const fresh = await municipiosInflight.catch(() => null);
    if (fresh) return fresh;
    if (municipiosMem) return municipiosMem.municipios; // upstream down — stale beats empty
    throw new Error('municipio lookup table unavailable');
  }

  async function fetchUpstream(key) {
    const [raw, municipios] = await Promise.all([
      fetchEnvelope(aemetUvIndexEnvelopeUrl(key, DIA), 20_000),
      ensureMunicipios(key),
    ]);
    const snapshot = normalizeAemetUvIndexSnapshot(raw);
    if (!snapshot) throw new Error('malformed UV-index response');
    const municipioById = new Map(municipios.map((m) => [m.id, m]));
    const cities = [];
    for (const city of snapshot.cities) {
      const municipio = municipioById.get(city.municipioId);
      if (!municipio) continue; // no coordinates to plot this one — drop it, don't fabricate a position
      cities.push({ ...city, lat: municipio.lat, lon: municipio.lon });
    }
    return { at: Date.now(), elaborated: snapshot.elaborated, validAt: snapshot.validAt, cities };
  }

  return {
    name: 'aemet-uv-index-proxy',
    configureServer(server) {
      server.middlewares.use('/api/aemet/uv-index', async (req, res) => {
        const sendJson = (status, obj) => {
          if (res.headersSent) return;
          res.writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(obj));
        };
        try {
          const subPath = String(req.url || '').split('?')[0];
          const key = apiKey();

          if (subPath === '/status') {
            sendJson(200, {
              hasKey: Boolean(key),
              lastFetch: mem ? mem.at : null,
              count: mem ? mem.cities.length : null,
              stale: mem ? Date.now() - mem.at >= UV_TTL_MS : false,
              ttlMs: UV_TTL_MS,
            });
            return;
          }

          if (!key) {
            sendJson(503, { error: 'no_key' });
            return;
          }

          const entry = mem;
          if (entry && Date.now() - entry.at < UV_TTL_MS) {
            sendJson(200, {
              fetchedAt: entry.at, stale: false, ttlMs: UV_TTL_MS,
              count: entry.cities.length, elaborated: entry.elaborated, validAt: entry.validAt, cities: entry.cities,
            });
            return;
          }
          if (!inflight) {
            inflight = fetchUpstream(key)
              .then((fresh) => {
                mem = fresh;
                return fresh;
              })
              .catch((err) => {
                console.warn(
                  `[aemet-uv-index-proxy] refresh failed (${err?.message || err}) — serving cache if any`,
                );
                return null;
              })
              .finally(() => {
                inflight = null;
              });
          }
          const pending = inflight;
          const fresh = await pending;
          const payload = fresh || entry;
          if (payload) {
            sendJson(200, {
              fetchedAt: payload.at, stale: !fresh, ttlMs: UV_TTL_MS,
              count: payload.cities.length, elaborated: payload.elaborated, validAt: payload.validAt, cities: payload.cities,
            });
          } else {
            sendJson(502, { error: 'aemet uv-index fetch failed and no cache available' });
          }
        } catch (err) {
          console.warn('[aemet-uv-index-proxy] error:', err?.message || err);
          sendJson(500, { error: 'aemet uv-index proxy error' });
        }
      });
    },
  };
}

/**
 * AEMET OpenData sea-surface-temperature composite proxy (Phase A9).
 * Upstream: https://opendata.aemet.es/opendata/api/satelites/producto/sst
 *
 * Same "opaque legend-annotated raster, nothing to parse" shape as
 * `aemetLightningProxy()`/`aemetFireRiskProxy()`: a real pull returned a
 * 1000×773 `image/gif` — an actual EUMETSAT OSI SAF sea-surface-temperature
 * satellite product AEMET redistributes (credited "AEMET / EUMETSAT OSI
 * SAF" on the image itself), covering the wider Iberia/Mediterranean/NW
 * Africa region, not just Spain — with a 0–35°C color legend and AEMET/
 * EUMETSAT logos baked into the pixels. No bounding box anywhere in the
 * response, same as every other opaque-image AEMET feed.
 *
 * `periodicidad: "1 vez al día"` per the live metadatos pull — a 6-hour TTL
 * (generous headroom inside that daily cadence, matching lightning's own
 * TTL) and a memory-only cache, same reasoning as every other opaque-image
 * proxy in this file (an image this infrequently updated has no "survive a
 * restart" story worth disk persistence).
 *
 * Routes:
 *   GET /api/aemet/sea-surface-temp        → raw image bytes, `Content-Type`
 *     from upstream (confirmed `image/gif`)
 *   GET /api/aemet/sea-surface-temp/status → {hasKey, lastFetch, stale,
 *     ttlMs, contentType}
 *
 * Keyless (no AEMET_API_KEY): /api/aemet/sea-surface-temp → 503
 * {error:'no_key'}; status → {hasKey:false}. Upstream is never touched
 * without a key.
 *
 * @returns {import('vite').Plugin}
 */
export function aemetSeaSurfaceTempProxy() {
  const TTL_MS = 6 * 3600_000;

  /** @type {?{at: number, buffer: Buffer, contentType: string}} */
  let mem = null;
  /** @type {?Promise<?{at: number, buffer: Buffer, contentType: string}>} single-flight refresh */
  let inflight = null;

  const apiKey = () => String(process.env.AEMET_API_KEY || '').trim();

  async function fetchUpstream(key) {
    const envelopeRes = await fetch(aemetSeaSurfaceTempEnvelopeUrl(key), {
      signal: AbortSignal.timeout(20_000),
    });
    if (!envelopeRes.ok) throw new Error(`HTTP ${envelopeRes.status}`);
    const envelope = await envelopeRes.json();
    if (envelope?.estado !== 200 || typeof envelope?.datos !== 'string') {
      throw new Error(`AEMET estado ${envelope?.estado ?? 'unknown'}: ${envelope?.descripcion || 'no datos url'}`);
    }
    const dataRes = await fetch(envelope.datos, { signal: AbortSignal.timeout(20_000) });
    if (!dataRes.ok) throw new Error(`HTTP ${dataRes.status} fetching datos`);
    const buffer = Buffer.from(await dataRes.arrayBuffer());
    const contentType = (dataRes.headers.get('content-type') || 'image/gif').split(';')[0].trim();
    return { at: Date.now(), buffer, contentType };
  }

  return {
    name: 'aemet-sea-surface-temp-proxy',
    configureServer(server) {
      server.middlewares.use('/api/aemet/sea-surface-temp', async (req, res) => {
        const sendJson = (status, obj) => {
          if (res.headersSent) return;
          res.writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(obj));
        };
        try {
          const subPath = String(req.url || '').split('?')[0];
          const key = apiKey();

          if (subPath === '/status') {
            sendJson(200, {
              hasKey: Boolean(key),
              lastFetch: mem ? mem.at : null,
              stale: mem ? Date.now() - mem.at >= TTL_MS : false,
              ttlMs: TTL_MS,
              contentType: mem ? mem.contentType : null,
            });
            return;
          }

          if (!key) {
            sendJson(503, { error: 'no_key' });
            return;
          }

          const entry = mem;
          if (entry && Date.now() - entry.at < TTL_MS) {
            res.writeHead(200, { 'Content-Type': entry.contentType, 'Cache-Control': 'no-store' });
            res.end(entry.buffer);
            return;
          }
          if (!inflight) {
            inflight = fetchUpstream(key)
              .then((fresh) => {
                mem = fresh;
                return fresh;
              })
              .catch((err) => {
                console.warn(
                  `[aemet-sea-surface-temp-proxy] refresh failed (${err?.message || err}) — serving cache if any`,
                );
                return null;
              })
              .finally(() => {
                inflight = null;
              });
          }
          const pending = inflight;
          const fresh = await pending;
          if (fresh) {
            res.writeHead(200, { 'Content-Type': fresh.contentType, 'Cache-Control': 'no-store' });
            res.end(fresh.buffer);
          } else if (entry) {
            res.writeHead(200, { 'Content-Type': entry.contentType, 'Cache-Control': 'no-store' }); // upstream down — stale beats empty
            res.end(entry.buffer);
          } else {
            sendJson(502, { error: 'aemet sea-surface-temp fetch failed and no cache available' });
          }
        } catch (err) {
          console.warn('[aemet-sea-surface-temp-proxy] error:', err?.message || err);
          sendJson(500, { error: 'aemet sea-surface-temp proxy error' });
        }
      });
    },
  };
}

/**
 * AEMET beach-forecast proxy (Phase A7).
 *
 * The plan originally flagged this phase as blocked ("no beach code/
 * coordinate list exists in this API"), same shape as Phase A6's maritime-
 * zone blocker. Unblocked by a real find: AEMET's own public website widget
 * (aemet.es, not opendata.aemet.es — no API key) serves a GeoJSON
 * nomenclator of all 160 beaches it forecasts for, and its `ID` field is
 * confirmed live to be the exact id `prediccion/especifica/playa/{id}`
 * expects. This is an undocumented internal endpoint of AEMET's own site,
 * not part of the official OpenData contract — see
 * `AEMET_BEACHES_NOMENCLATOR_URL`'s own comment in weatherProviderRequests.js
 * for the full live-verification trail.
 *
 * Unlike every other AEMET feed here, there is no bulk "all beaches"
 * endpoint — each beach's forecast is its own two-step envelope/datos round
 * trip. A first attempt fetched all 160 with a concurrency-8 worker pool and
 * hit real, confirmed-live AEMET rate limiting partway through: the envelope
 * endpoint returns a `Remaining-request-endpoint` response header (confirmed
 * live to be scoped per api-key-and-endpoint-path, independent of every
 * other AEMET proxy's own budget) that started around 39–40 and was
 * exhausted — with 429s on the rest — after roughly 20 concurrent calls in
 * quick succession. The `datos` short-link fetch that follows a successful
 * envelope call carries no such header and was never observed to 429, so
 * only the envelope call needs pacing.
 *
 * Rebuilt as a slow, fully-sequential, non-blocking BACKGROUND sweep instead
 * of a concurrent one a request awaits: `PACE_MS` between beaches keeps
 * steady-state usage well under the observed budget, and the sweep also
 * reads the live `Remaining-request-endpoint` value after every call,
 * cooling down for `THROTTLE_COOLDOWN_MS` whenever it (or an explicit 429)
 * signals the budget is nearly spent — real-time feedback instead of a
 * blind guess at AEMET's own limit. A full pass over 160 beaches takes
 * several minutes; no HTTP request ever waits for it; the route always
 * responds immediately with whatever is already cached, which fills in
 * across this layer's own 5-minute poll interval rather than in one
 * blocking round trip. An individual beach's failed fetch never drops its
 * last-known reading — only a fresh success overwrites `beachById`.
 */
export function aemetBeachesProxy({
  // Conservative pacing against the observed ~39-40 request budget for this
  // specific endpoint: one beach every 2.5s is 24/min, comfortably under
  // that ceiling with margin for the budget's own refill behavior. Injectable
  // (like `loadImage`/`overlayHost` on the frontend layers) so tests can run
  // a whole sweep without either sleeping in real time or fighting fake
  // timers against a fire-and-forget background loop — never overridden in
  // production, where the real pacing is what protects the real budget.
  paceMs = 2500,
  throttleCooldownMs = 65_000, // AEMET's own bucket appears to be roughly a 1-minute window
} = {}) {
  const NOMENCLATOR_TTL_MS = 24 * 3600_000;
  const FORECAST_TTL_MS = 6 * 3600_000;
  const THROTTLE_FLOOR = 5;

  /** @type {?{at: number, beaches: Array<{id:string,name:string,lat:number,lon:number}>}} */
  let nomenclatorMem = null;
  /** @type {?Promise<Array<object>>} single-flight nomenclator refresh */
  let nomenclatorInflight = null;
  /** @type {Map<string, {name:string,lat:number,lon:number,forecast:object,updatedAt:number}>} */
  const beachById = new Map();
  // Two separate clocks: `lastAttemptAt` throttles how often a new full
  // sweep is even started (advances once the sweep finishes, success or
  // not, so a fully-down upstream doesn't restart a sweep on every request);
  // `lastSuccessAt` is what "freshness" actually means to a caller (advances
  // only when at least one beach's forecast was genuinely refreshed this
  // sweep). Collapsing these into one timestamp would report a wholesale-
  // failed sweep as fresh simply because an attempt just happened.
  let lastAttemptAt = null;
  let lastSuccessAt = null;
  let sweeping = false;

  const apiKey = () => String(process.env.AEMET_API_KEY || '').trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function fetchNomenclator() {
    if (nomenclatorMem && Date.now() - nomenclatorMem.at < NOMENCLATOR_TTL_MS) return nomenclatorMem.beaches;
    if (!nomenclatorInflight) {
      nomenclatorInflight = fetch(AEMET_BEACHES_NOMENCLATOR_URL, { signal: AbortSignal.timeout(20_000) })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const beaches = normalizeAemetBeachesNomenclator(await res.json());
          if (!beaches.length) throw new Error('empty nomenclator');
          nomenclatorMem = { at: Date.now(), beaches };
          return beaches;
        })
        .finally(() => {
          nomenclatorInflight = null;
        });
    }
    const fresh = await nomenclatorInflight.catch(() => null);
    if (fresh) return fresh;
    if (nomenclatorMem) return nomenclatorMem.beaches; // upstream down — stale beats empty
    throw new Error('beach nomenclator unavailable');
  }

  /**
   * @returns {Promise<{record: object, rateLimited: boolean}>} `rateLimited`
   *   distinguishes "AEMET said slow down" from every other failure so the
   *   sweep can cool down specifically for that case.
   */
  async function fetchOneBeachForecast(key, beachId) {
    const envelopeRes = await fetch(aemetBeachForecastEnvelopeUrl(key, beachId), { signal: AbortSignal.timeout(20_000) });
    const remainingHeader = envelopeRes.headers.get('remaining-request-endpoint');
    const remaining = remainingHeader === null ? null : Number(remainingHeader);
    if (envelopeRes.status === 429) return { record: null, rateLimited: true, remaining };
    if (!envelopeRes.ok) throw new Error(`HTTP ${envelopeRes.status}`);
    const envelope = await envelopeRes.json();
    if (envelope?.estado !== 200 || typeof envelope?.datos !== 'string') {
      throw new Error(`AEMET estado ${envelope?.estado ?? 'unknown'}: ${envelope?.descripcion || 'no datos url'}`);
    }
    const dataRes = await fetch(envelope.datos, { signal: AbortSignal.timeout(20_000) });
    if (!dataRes.ok) throw new Error(`HTTP ${dataRes.status} fetching datos`);
    // Same ISO-8859-15-despite-being-JSON gotcha as every other AEMET datos response.
    const buffer = Buffer.from(await dataRes.arrayBuffer());
    const raw = JSON.parse(buffer.toString('latin1'));
    const record = normalizeAemetBeachForecastRecord(raw);
    if (!record) throw new Error('malformed beach forecast response');
    return { record, rateLimited: false, remaining };
  }

  async function runSweep(key) {
    let anySuccess = false;
    try {
      const nomenclator = await fetchNomenclator();
      for (const beach of nomenclator) {
        try {
          const { record, rateLimited, remaining } = await fetchOneBeachForecast(key, beach.id);
          if (rateLimited) {
            console.warn(`[aemet-beaches-proxy] rate limited on beach ${beach.id} — cooling down ${throttleCooldownMs}ms`);
            await sleep(throttleCooldownMs);
            continue; // revisited on the next full sweep rather than retried immediately
          }
          beachById.set(beach.id, { name: beach.name, lat: beach.lat, lon: beach.lon, forecast: record, updatedAt: Date.now() });
          anySuccess = true;
          await sleep(Number.isFinite(remaining) && remaining <= THROTTLE_FLOOR ? throttleCooldownMs : paceMs);
        } catch (err) {
          console.warn(`[aemet-beaches-proxy] beach ${beach.id} refresh failed (${err?.message || err}) — keeping last-known reading if any`);
          await sleep(paceMs);
        }
      }
    } catch (err) {
      console.warn(`[aemet-beaches-proxy] sweep failed (${err?.message || err}) — serving cache if any`);
    } finally {
      // Advances even when the nomenclator itself is unreachable, so a
      // sustained outage is throttled to one attempt per TTL window rather
      // than a new sweep starting on every incoming request.
      lastAttemptAt = Date.now();
      if (anySuccess) lastSuccessAt = Date.now();
      sweeping = false;
    }
  }

  /** @type {?Promise<void>} the currently-running sweep, if any — exposed read-only for tests. */
  let sweepPromise = null;

  /** Fire-and-forget: never awaited by a request. */
  function ensureSweepRunning(key) {
    if (sweeping) return;
    if (lastAttemptAt && Date.now() - lastAttemptAt < FORECAST_TTL_MS) return;
    sweeping = true;
    sweepPromise = runSweep(key);
  }

  function snapshot() {
    return [...beachById.entries()].map(([id, entry]) => ({ id, ...entry }));
  }

  return {
    name: 'aemet-beaches-proxy',
    // Test-only hook: await the in-flight background sweep directly instead
    // of polling — mirrors the `_xForTest()` convention the frontend layers
    // use, applied here because this proxy's sweep is fire-and-forget and a
    // request never awaits it.
    _sweepPromiseForTest: () => sweepPromise,
    configureServer(server) {
      server.middlewares.use('/api/aemet/beaches', async (req, res) => {
        const sendJson = (status, obj) => {
          if (res.headersSent) return;
          res.writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(obj));
        };
        try {
          const subPath = String(req.url || '').split('?')[0];
          const key = apiKey();
          const stale = !lastSuccessAt || Date.now() - lastSuccessAt >= FORECAST_TTL_MS;

          if (subPath === '/status') {
            sendJson(200, {
              hasKey: Boolean(key),
              lastFetch: lastSuccessAt,
              count: beachById.size,
              stale,
              ttlMs: FORECAST_TTL_MS,
              sweeping,
            });
            return;
          }

          if (!key) {
            sendJson(503, { error: 'no_key' });
            return;
          }

          ensureSweepRunning(key);
          // Always responds with whatever is cached right now — a cold
          // start legitimately means an empty array, filled in by later
          // polls as the background sweep progresses, never a blocked
          // request or a fabricated reading. `sweeping` lets the frontend
          // tell "still building the first sweep" apart from "genuinely
          // stuck on stale data" — both report `stale: true`, but only the
          // second is actually a problem worth surfacing to the user.
          sendJson(200, {
            fetchedAt: lastSuccessAt,
            stale,
            sweeping,
            ttlMs: FORECAST_TTL_MS,
            count: beachById.size,
            beaches: snapshot(),
          });
        } catch (err) {
          console.warn('[aemet-beaches-proxy] error:', err?.message || err);
          sendJson(500, { error: 'aemet beaches proxy error' });
        }
      });
    },
  };
}
