import {
  DEFAULT_LOCAL_ADSB_BASE_URL,
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
  function installMiddleware(server) {
    server.middlewares.use('/api/local-adsb', async (req, res) => {
      if (process.env.LOCAL_ADSB_MOCK === '1') {
        const body = {
          ...normalizeLocalAdsbSnapshot(mockLocalAdsbSnapshot()),
          stale: false,
          baseUrl: 'mock',
        };
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(body));
        return;
      }
      const baseUrl =
        process.env.LOCAL_ADSB_BASE_URL || DEFAULT_LOCAL_ADSB_BASE_URL;
      const { status, body } = await resolveLocalAdsbRequest({
        cache,
        baseUrl,
      });
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(body));
    });
  }
  return {
    name: 'local-adsb-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
