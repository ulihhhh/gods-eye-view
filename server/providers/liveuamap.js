import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { normalizeSnapshot as normalizeLiveuamapSnapshot } from '../../src/data/liveuamapNormalize.js';

async function readRequestBodyCapped(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error('Request body too large');
      err.code = 'BODY_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Liveuamap prototype feed — LOCAL ONLY, dev-server only, no upstream.
 *
 * Liveuamap is Cloudflare-gated and its data is a paid, non-redistributable
 * product, so there is no server-side feed. Data arrives by PUSH: you open
 * liveuamap.com tabs in your own browser (logged in, Cloudflare passed) and
 * the unpacked bridge extension in `extension/liveuamap-bridge/` reads the
 * page's own decoded map state (`window.ovens`) and POSTs it here. This
 * middleware normalizes it to disk and serves it back. It never contacts
 * liveuamap.com. Local exploration only — see DATA_SOURCES.md.
 *
 *   POST /api/liveuamap/ingest   <- raw {region, resid, ovens, markers} from the extension
 *   GET  /api/liveuamap          -> { regions: [snapshot, ...] }  (all pushed regions)
 *   GET  /api/liveuamap?region=x -> one snapshot { region, resid, asOf, fetchedAt, events, fields }
 *
 * The ingest endpoint accepts a shared token (LIVEUAMAP_INGEST_TOKEN, default
 * below) so a stray page can't write to your cache while the dev server runs.
 */
export function liveuamapProxy() {
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache', 'liveuamap');
  const REGION_RE = /^[a-z0-9-]{1,40}$/;
  const INGEST_TOKEN = String(process.env.LIVEUAMAP_INGEST_TOKEN || 'gev-liveuamap-bridge');
  const MAX_INGEST_BYTES = 8 * 1024 * 1024;
  const EMPTY = (region) => ({
    region, resid: null, asOf: null, fetchedAt: null, events: [], fields: [], stale: true,
  });

  const readRegion = async (region) => {
    try {
      const parsed = JSON.parse(await fsp.readFile(path.join(CACHE_DIR, `${region}.json`), 'utf8'));
      if (Array.isArray(parsed?.events) && Array.isArray(parsed?.fields)) return parsed;
    } catch {
      /* no snapshot yet */
    }
    return EMPTY(region);
  };

  const send = (res, status, body) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      // The extension's service worker fetch is same-machine; keep CORS open so a
      // direct page-context fetch could also work during debugging.
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Liveuamap-Token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  function installMiddleware(server) {
    server.config.logger.info(
      `  \x1b[35m➜\x1b[0m  Liveuamap bridge: load extension/liveuamap-bridge, token "${INGEST_TOKEN}"`,
    );
    server.middlewares.use('/api/liveuamap', async (req, res) => {
      try {
          if (req.method === 'OPTIONS') return send(res, 204);

          if (req.method === 'POST' && (req.url || '').startsWith('/ingest')) {
            if ((req.headers['x-liveuamap-token'] || '') !== INGEST_TOKEN) {
              return send(res, 403, { error: 'bad or missing X-Liveuamap-Token' });
            }
            let raw;
            try {
              raw = (await readRequestBodyCapped(req, MAX_INGEST_BYTES)).toString();
            } catch (err) {
              if (err?.code === 'BODY_TOO_LARGE') return send(res, 413, { error: 'payload too large' });
              throw err;
            }
            const payload = JSON.parse(raw || '{}');
            const snapshot = normalizeLiveuamapSnapshot(payload);
            if (!REGION_RE.test(snapshot.region)) return send(res, 400, { error: 'bad region' });

            const file = path.join(CACHE_DIR, `${snapshot.region}.json`);
            if (!snapshot.events.length && !snapshot.fields.length) {
              // Don't let an empty tab (still loading / Cloudflare check) wipe a good snapshot.
              const prev = await readRegion(snapshot.region);
              if ((prev.events?.length || 0) + (prev.fields?.length || 0) > 0) {
                return send(res, 200, { region: snapshot.region, kept: true, events: prev.events.length, fields: prev.fields.length });
              }
            }
            await fsp.mkdir(CACHE_DIR, { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            await fsp.writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
            await fsp.rename(tmp, file);
            server.config.logger.info(
              `  \x1b[35m➜\x1b[0m  Liveuamap ${snapshot.region}: ${snapshot.events.length} events, ${snapshot.fields.length} fields`,
            );
            return send(res, 200, { region: snapshot.region, events: snapshot.events.length, fields: snapshot.fields.length });
          }

          const region = new URL(req.url, 'http://x').searchParams.get('region');
          if (region) {
            if (!REGION_RE.test(region)) return send(res, 400, { error: 'bad region' });
            return send(res, 200, await readRegion(region));
          }
          let names = [];
          try {
            names = (await fsp.readdir(CACHE_DIR))
              .filter((f) => f.endsWith('.json'))
              .map((f) => f.slice(0, -5))
              .filter((n) => REGION_RE.test(n));
          } catch {
            /* dir not created until the first ingest */
          }
          const regions = await Promise.all(names.map(readRegion));
          return send(res, 200, { regions });
        } catch (err) {
          return send(res, 500, { error: String(err?.message || err) });
        }
      });
  }
  return {
    name: 'liveuamap-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
