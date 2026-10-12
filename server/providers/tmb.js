import { sameSiteGated } from './common/same-site.js';

/**
 * TMB (Transports Metropolitans de Barcelona) developer API — key handling.
 *
 * The API needs an `app_id` + `app_key` pair (developer.tmb.cat), and its
 * licence binds reuse to the application named at registration, so this
 * provider is fork-local and server-side only: the pair lives in `.env`
 * (`TMB_APP_ID`, `TMB_APP_KEY`, set from the POWER UP panel) and never
 * reaches the browser, a response body, or a log line.
 *
 * Routes:
 *   GET /api/tmb/status → {hasKey, state, checkedAt}
 *     state: 'ok' | 'rejected' (TMB refused the pair) | 'unavailable'
 *     (TMB unreachable or answering something else) | null (no key).
 *
 * The check is one small request (metro line codes only), cached for ten
 * minutes per key pair and single-flight, so a page polling the status
 * cannot turn into traffic against the user's TMB application.
 */

/** Base of every TMB API request. Fixed: callers never supply a URL. */
export const TMB_API_BASE = 'https://api.tmb.cat/v1';

/** How long one credential check answers for the same key pair. */
export const TMB_STATUS_TTL_MS = 10 * 60_000;

/** Upstream timeout for the credential check. */
export const TMB_STATUS_TIMEOUT_MS = 15_000;

/**
 * The configured credential pair, or null when either half is missing.
 * @param {Record<string, string|undefined>} env
 * @returns {{appId: string, appKey: string}|null}
 */
export function tmbCredentials(env) {
  const appId = String(env?.TMB_APP_ID || '').trim();
  const appKey = String(env?.TMB_APP_KEY || '').trim();
  return appId && appKey ? { appId, appKey } : null;
}

/**
 * The URL of the credential check: the metro line list, trimmed to its
 * codes so the answer stays small.
 * @param {{appId: string, appKey: string}} credentials
 * @returns {string}
 */
export function tmbStatusUrl({ appId, appKey }) {
  const params = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    propertyName: 'CODI_LINIA',
  });
  return `${TMB_API_BASE}/transit/linies/metro?${params}`;
}

/**
 * Classify TMB's answer to the credential check without echoing it.
 * @param {number} status HTTP status.
 * @param {unknown} body Parsed JSON body, or null.
 * @returns {'ok'|'rejected'|'unavailable'}
 */
export function classifyTmbStatus(status, body) {
  if (status === 401 || status === 403) return 'rejected';
  if (status === 200 && body && body.type === 'FeatureCollection') return 'ok';
  return 'unavailable';
}

/**
 * Credential-check service. `env` and `fetchImpl` are injectable for tests.
 * @param {{env?: Record<string, string|undefined>, fetchImpl?: typeof fetch,
 *   now?: () => number}} [options]
 * @returns {{status: () => Promise<{hasKey: boolean, state: string|null,
 *   checkedAt: number|null}>}}
 */
export function createTmbStatusService({
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  /** @type {{pair: string, state: string, checkedAt: number}|null} */
  let last = null;
  /** @type {{pair: string, promise: Promise<object>}|null} */
  let inflight = null;

  async function check(credentials, pair) {
    let state = 'unavailable';
    try {
      const response = await fetchImpl(tmbStatusUrl(credentials), {
        headers: { Accept: 'application/json' },
        // Never follow a redirect: the URL carries the key pair.
        redirect: 'error',
        signal: AbortSignal.timeout(TMB_STATUS_TIMEOUT_MS),
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      state = classifyTmbStatus(response.status, body);
    } catch {
      state = 'unavailable';
    }
    last = { pair, state, checkedAt: now() };
    return last;
  }

  async function status() {
    const credentials = tmbCredentials(env);
    if (!credentials) return { hasKey: false, state: null, checkedAt: null };
    const pair = `${credentials.appId}\u0000${credentials.appKey}`;
    if (last?.pair === pair && now() - last.checkedAt < TMB_STATUS_TTL_MS) {
      return { hasKey: true, state: last.state, checkedAt: last.checkedAt };
    }
    if (inflight?.pair !== pair) {
      const promise = check(credentials, pair).finally(() => {
        if (inflight?.promise === promise) inflight = null;
      });
      inflight = { pair, promise };
    }
    const result = await inflight.promise;
    return { hasKey: true, state: result.state, checkedAt: result.checkedAt };
  }

  return { status };
}

/**
 * Vite plugin: `/api/tmb/status` for development and preview.
 * @param {Parameters<typeof createTmbStatusService>[0]} [options]
 * @returns {import('vite').Plugin}
 */
export function tmbProxy(options = {}) {
  const service = createTmbStatusService(options);
  function install(server) {
    server.middlewares.use(
      '/api/tmb/status',
      sameSiteGated(async (req, res) => {
        const send = (code, payload) => {
          res.writeHead(code, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(payload));
        };
        const rest = String(req.url || '/').split('?')[0];
        if (rest !== '/' && rest !== '')
          return send(404, { error: 'Not found' });
        if (req.method !== 'GET')
          return send(405, { error: 'Method not allowed' });
        return send(200, await service.status());
      }),
    );
  }
  return {
    name: 'tmb-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
