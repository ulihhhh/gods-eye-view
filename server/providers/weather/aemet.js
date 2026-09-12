import path from 'node:path';
import { promises as fsp } from 'node:fs';

import {
  aemetStationsEnvelopeUrl,
  filterFreshAemetStations,
  normalizeAemetStationsSnapshot,
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
