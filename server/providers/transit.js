import { createTransitService } from '../../src/sources/transitService.js';
export { fetchTransitFeed } from '../../src/sources/transitService.js';

/**
 * Whether estimated vehicles may be served at all: on unless the owner sets
 * `TRANSIT_ESTIMATED_POSITIONS=off`. Read on every check, like the keys.
 * @param {Record<string, string|undefined>} env
 */
export function transitEstimatesEnabled(env) {
  return (
    String(env?.TRANSIT_ESTIMATED_POSITIONS || '')
      .trim()
      .toLowerCase() !== 'off'
  );
}

/**
 * Connect the reusable transit request service to development and preview.
 * `estimators` (fork-only, estimated positions) are switched off as a whole
 * by `TRANSIT_ESTIMATED_POSITIONS=off`.
 */
export function transitProxy({
  estimators = {},
  env = process.env,
  ...options
} = {}) {
  const gated = Object.fromEntries(
    Object.entries(estimators).map(([name, estimator]) => [
      name,
      {
        ...estimator,
        available: () =>
          transitEstimatesEnabled(env) && estimator.available() === true,
        estimate: (request) => estimator.estimate(request),
      },
    ]),
  );
  const service = createTransitService({ ...options, estimators: gated });
  function install(server) {
    server.middlewares.use('/api/transit', async (req, res) => {
      const response = await service.handle({
        url: `http://localhost/api/transit${req.url || '/'}`,
        method: req.method,
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    });
    server.httpServer?.once('close', service.close);
  }
  return {
    name: 'transit-proxy',
    closeBundle: service.close,
    configureServer: install,
    configurePreviewServer: install,
  };
}
