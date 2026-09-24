import {
  epoch,
  finite,
  httpError,
  LiveSourceError,
  readResponse,
} from './contract.js';
import {
  normalizeAircraftTrack,
  openSkySnapshot,
  readsbSnapshot,
  readsbIdentities,
} from './aircraft.js';
import { normalizeVesselTrack, vesselSnapshot } from './vessels.js';

const defaultFetch = (...args) => globalThis.fetch(...args);
const header = (response, name) => response.headers?.get?.(name);

function openSkyError(response) {
  const error = httpError(response, 'OpenSky');
  const mode = String(
    header(response, 'x-opensky-auth-mode-used') ||
      header(response, 'x-opensky-auth') ||
      '',
  ).toLowerCase();
  const reason = String(
    header(response, 'x-opensky-auth-reason') || '',
  ).toLowerCase();
  if (response.status === 429 && (!mode || mode === 'anon'))
    error.message = 'OpenSky rate limited (anonymous)';
  if (response.status === 401 || response.status === 403) {
    const reasons = {
      oauth_invalid_or_missing: 'OpenSky OAuth client missing/invalid',
      oauth_invalid_credentials: 'OpenSky OAuth rejected credentials',
      basic_invalid_credentials: 'OpenSky username/password rejected',
      missing_basic_creds: 'OpenSky auth missing',
      missing_oauth_and_basic_creds: 'OpenSky auth missing',
      auth_required: 'OpenSky auth required',
      forced_anonymous: 'OpenSky auth required',
    };
    error.message =
      reasons[reason] ||
      (/^(oauth_|basic_)/.test(reason)
        ? 'OpenSky auth invalid'
        : mode === 'anon'
          ? 'OpenSky auth required'
          : 'OpenSky auth failed');
  }
  return error;
}

/** Existing same-origin aircraft routes; no request starts during construction. */
export function createOpenSkySource({
  fetchImpl = defaultFetch,
  now = () => Date.now(),
} = {}) {
  return {
    label: 'OpenSky Network',
    async getSnapshot(query = {}, { signal } = {}) {
      const params = new URLSearchParams();
      if (Number.isFinite(query.latitude) && Number.isFinite(query.longitude)) {
        params.set('lat', query.latitude.toFixed(4));
        params.set('lon', query.longitude.toFixed(4));
      }
      const { response, payload } = await readResponse(
        fetchImpl,
        `/api/opensky${params.size ? '?' + params : ''}`,
        { signal },
        'OpenSky',
      );
      if (!response.ok) throw openSkyError(response);
      return {
        ...openSkySnapshot(payload, {
          source: header(response, 'x-flight-source') || 'OpenSky Network',
          coverage:
            header(response, 'x-flight-coverage') ||
            'worldwide upstream snapshot',
          now: now(),
        }),
        status: response.status,
      };
    },
    async getTrack(reference, { signal } = {}) {
      const { response, payload } = await readResponse(
        fetchImpl,
        '/api/opensky-track?icao24=' + encodeURIComponent(reference),
        { signal },
        'OpenSky',
      );
      if (!response.ok) throw httpError(response, 'OpenSky');
      return {
        records: normalizeAircraftTrack(payload?.path),
        complete: false,
      };
    },
    getEnrichment: adsbdbEnrichment(fetchImpl),
  };
}

/** Aircraft type/route lookup shared by every civil-flight source. */
function adsbdbEnrichment(fetchImpl) {
  return async function getEnrichment(query, { signal } = {}) {
    if (!['type', 'route'].includes(query.kind))
      throw new LiveSourceError('unsupported', 'Enrichment unavailable');
    const { response, payload } = await readResponse(
      fetchImpl,
      `/api/adsbdb/${query.kind}/${encodeURIComponent(query.id)}`,
      { signal },
      'adsbdb',
    );
    if (!response.ok) throw httpError(response, 'adsbdb');
    return payload;
  };
}

/**
 * The operator's own dump1090/readsb receiver via the same-origin
 * /api/local-adsb proxy (docs/plans/local-usb-sdr.md). The proxy serves
 * readsb-shaped rows, so this reuses the adsb.lol normalization; the receiver
 * clock (`now`) is the snapshot epoch, and per-aircraft `seen_pos` ages each
 * position individually.
 */
export function createLocalReceiverSource({
  fetchImpl = defaultFetch,
  now = () => Date.now(),
} = {}) {
  return {
    label: 'Local receiver',
    async getSnapshot(_query = {}, { signal } = {}) {
      const { response, payload } = await readResponse(
        fetchImpl,
        '/api/local-adsb',
        { signal, cache: 'no-store' },
        'Local receiver',
      );
      if (!response.ok) {
        const error = httpError(response, 'Local receiver');
        if (payload?.error === 'unreachable')
          error.message = 'Local receiver unreachable — is startadsb running?';
        throw error;
      }
      const receiverMs = epoch(payload?.now, 1000);
      return {
        ...readsbSnapshot(payload, {
          observedAtMs: receiverMs ?? now(),
          source: 'Local receiver',
          coverage: 'own antenna',
          now: now(),
          stale: payload?.stale === true,
        }),
        heard: finite(payload?.heard),
        status: response.status,
      };
    },
    async getTrack(reference, { signal } = {}) {
      const { response, payload } = await readResponse(
        fetchImpl,
        '/api/local-adsb/trace?hex=' + encodeURIComponent(reference),
        { signal },
        'Local receiver',
      );
      if (!response.ok) throw httpError(response, 'Local receiver');
      const baseTimeMs = epoch(payload?.timestamp, 1000);
      return {
        records:
          baseTimeMs == null
            ? []
            : normalizeAircraftTrack(payload?.trace, {
                baseTimeMs,
                readsb: true,
              }),
        complete: false,
      };
    },
    getEnrichment: adsbdbEnrichment(fetchImpl),
  };
}

export function createAdsbLolSource({
  fetchImpl = defaultFetch,
  now = () => Date.now(),
} = {}) {
  return {
    label: 'adsb.lol',
    async getIdentities(_query = {}, { signal } = {}) {
      const { response, payload } = await readResponse(
        fetchImpl,
        '/api/adsblol/mil',
        { signal },
        'adsb.lol',
      );
      if (!response.ok) throw httpError(response, 'adsb.lol');
      return readsbIdentities(payload);
    },
    async getSnapshot(_query = {}, { signal } = {}) {
      const { response, payload } = await readResponse(
        fetchImpl,
        '/api/adsblol/mil',
        { signal },
        'adsb.lol',
      );
      if (!response.ok) throw httpError(response, 'adsb.lol');
      const age = finite(header(response, 'x-ads-b-cache-age-ms'));
      return {
        ...readsbSnapshot(payload, {
          observedAtMs: now() - (age != null && age > 0 ? age : 0),
          now: now(),
          stale: header(response, 'x-ads-b-cache') === 'STALE',
        }),
        status: response.status,
      };
    },
    async getTrack(reference, { signal } = {}) {
      const { response, payload } = await readResponse(
        fetchImpl,
        '/api/adsblol/trace?hex=' + encodeURIComponent(reference),
        { signal },
        'adsb.lol',
      );
      if (!response.ok) throw httpError(response, 'adsb.lol');
      const baseTimeMs = epoch(payload?.timestamp, 1000);
      return {
        records:
          baseTimeMs == null
            ? []
            : normalizeAircraftTrack(payload?.trace, {
                baseTimeMs,
                readsb: true,
              }),
        complete: false,
      };
    },
  };
}

export function createAisStreamSource({
  fetchImpl = defaultFetch,
  apiUrl = '/api/ais-live',
  origin = () => globalThis.location?.origin || 'http://localhost',
} = {}) {
  return {
    label: 'AISStream',
    async getSnapshot({ maxRows = 12000 } = {}, { signal } = {}) {
      const url = new URL(apiUrl, origin());
      url.searchParams.set('maxRows', String(maxRows));
      const { response, payload } = await readResponse(
        fetchImpl,
        url.toString(),
        { signal, cache: 'no-store' },
        'AIS live',
      );
      if (!response.ok) {
        const error = httpError(response, 'AIS live');
        const reasons = {
          'missing-key': 'AISSTREAM_API_KEY not set',
          'auth-failed': 'API key rejected — check AISSTREAM_API_KEY',
          unsupported: 'live feed unsupported',
          error: 'feed down',
          closed: 'feed disconnected',
        };
        error.message = reasons[payload?.status] || error.message;
        throw error;
      }
      return { ...vesselSnapshot(payload), status: response.status };
    },
    async getTrack(reference, { signal } = {}) {
      const { response, payload } = await readResponse(
        fetchImpl,
        '/api/ais-live/track?mmsi=' + encodeURIComponent(reference),
        { signal },
        'AIS live',
      );
      if (!response.ok) throw httpError(response, 'AIS live');
      return {
        records: normalizeVesselTrack(payload?.samples),
        complete: false,
      };
    },
  };
}
