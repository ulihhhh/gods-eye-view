import {
  buildLocalAdsbTrace,
  DEFAULT_LOCAL_ADSB_BASE_URL,
  fetchLocalAdsbHistory,
  mockLocalAdsbSnapshot,
  normalizeLocalAdsbSnapshot,
  resolveLocalAdsbRequest,
} from '../../../src/data/localAdsbProxy.js';

/**
 * Vite plugin: local ADS-B receiver tap proxy (issue #57 — Phase 0 of
 * docs/plans/local-usb-sdr.md).
 *
 * Proxies GET /api/local-adsb to a same-machine (or LAN) dump1090/readsb
 * instance's aircraft.json. The target is fixed server-side via the
 * LOCAL_ADSB_BASE_URL env var (default http://localhost:8080) — never taken
 * from the request — so a LAN-shared GEV instance (see README "Sharing an
 * instance") can't be turned into a relay against the operator's internal
 * network by a client naming an arbitrary host. See src/data/localAdsbProxy.js
 * for the pure fetch/cache mechanics, unit-tested there without a real
 * receiver.
 *
 * GET /api/local-adsb/trace?hex=<icao24> serves that aircraft's recent path
 * from the receiver's own rotating history_N.json snapshots (readsb /trace
 * shape), so tracking a local contact shows where it came from.
 *
 * LOCAL_ADSB_MOCK=1 bypasses the real fetch entirely and serves a static
 * demo snapshot (src/data/localAdsbProxy.js#mockLocalAdsbSnapshot) instead —
 * for trying the layer out before a receiver is on hand. It's a separate,
 * explicit code path: a real upstream failure still reports as a failure
 * rather than silently falling back to demo data.
 *
 * @returns {import('vite').Plugin}
 */
export function localAdsbProxy() {
  const cache = new Map();
  /** One shared history fetch (up to 120 small files) per window, not per click. */
  const HISTORY_TTL_MS = 15000;
  let history = null;
  const send = (res, status, body) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
  };
  async function serveTrace(req, res, baseUrl) {
    const hex = new URL(req.url, 'http://local').searchParams.get('hex');
    if (!/^[0-9a-f]{6}$/i.test(hex || '')) {
      send(res, 400, { error: 'bad_hex' });
      return;
    }
    if (process.env.LOCAL_ADSB_MOCK === '1') {
      send(res, 200, { timestamp: 0, trace: [] });
      return;
    }
    if (!history || Date.now() - history.at > HISTORY_TTL_MS) {
      history = {
        at: Date.now(),
        pending: fetchLocalAdsbHistory({ baseUrl }),
      };
    }
    const { bodies } = await history.pending;
    send(res, 200, buildLocalAdsbTrace(bodies, hex));
  }
  function installMiddleware(server) {
    server.middlewares.use('/api/local-adsb', async (req, res) => {
      const baseUrl =
        process.env.LOCAL_ADSB_BASE_URL || DEFAULT_LOCAL_ADSB_BASE_URL;
      if (req.url?.startsWith('/trace')) {
        await serveTrace(req, res, baseUrl);
        return;
      }
      if (process.env.LOCAL_ADSB_MOCK === '1') {
        const body = {
          ...normalizeLocalAdsbSnapshot(mockLocalAdsbSnapshot()),
          stale: false,
          baseUrl: 'mock',
        };
        send(res, 200, body);
        return;
      }
      const { status, body } = await resolveLocalAdsbRequest({
        cache,
        baseUrl,
      });
      send(res, status, body);
    });
  }
  return {
    name: 'local-adsb-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
