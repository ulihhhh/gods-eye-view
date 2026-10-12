import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TMB_STATUS_TTL_MS,
  classifyTmbStatus,
  createTmbStatusService,
  tmbCredentials,
  tmbProxy,
  tmbStatusUrl,
} from '../../server/providers/tmb.js';
import { KEY_SETUP_KEYS, keySetupStatus } from '../keySetupCore.mjs';

const PAIR = { TMB_APP_ID: 'fixture-id', TMB_APP_KEY: 'fixture-secret' };

function fakeFetch(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const { status = 200, body = { type: 'FeatureCollection', features: [] } } =
      typeof answer === 'function' ? answer(calls.length) : answer;
    if (status === 'throw') throw new Error('network down');
    return new Response(JSON.stringify(body), { status });
  };
  return { fetchImpl, calls };
}

test('both halves of the TMB pair are required', () => {
  assert.equal(tmbCredentials({}), null);
  assert.equal(tmbCredentials({ TMB_APP_ID: 'a' }), null);
  assert.equal(tmbCredentials({ TMB_APP_KEY: 'b' }), null);
  assert.equal(tmbCredentials({ TMB_APP_ID: ' ', TMB_APP_KEY: 'b' }), null);
  assert.deepEqual(tmbCredentials({ TMB_APP_ID: ' a ', TMB_APP_KEY: 'b' }), {
    appId: 'a',
    appKey: 'b',
  });
});

test('the credential check asks one fixed, small TMB endpoint', () => {
  const url = new URL(tmbStatusUrl({ appId: 'id&x', appKey: 'k=y' }));
  assert.equal(url.origin, 'https://api.tmb.cat');
  assert.equal(url.pathname, '/v1/transit/linies/metro');
  assert.equal(url.searchParams.get('app_id'), 'id&x');
  assert.equal(url.searchParams.get('app_key'), 'k=y');
  assert.equal(url.searchParams.get('propertyName'), 'CODI_LINIA');
});

test("TMB's answer is classified without echoing it", () => {
  assert.equal(classifyTmbStatus(200, { type: 'FeatureCollection' }), 'ok');
  assert.equal(classifyTmbStatus(401, null), 'rejected');
  assert.equal(classifyTmbStatus(403, { error: 'x' }), 'rejected');
  assert.equal(classifyTmbStatus(200, { unexpected: true }), 'unavailable');
  assert.equal(classifyTmbStatus(500, null), 'unavailable');
});

test('no key means no request to TMB', async () => {
  const { fetchImpl, calls } = fakeFetch({});
  const service = createTmbStatusService({ env: {}, fetchImpl });
  assert.deepEqual(await service.status(), {
    hasKey: false,
    state: null,
    checkedAt: null,
  });
  assert.equal(calls.length, 0);
});

test('a working pair is checked once per ten minutes and never leaks', async () => {
  let clock = 1_000;
  const { fetchImpl, calls } = fakeFetch({});
  const service = createTmbStatusService({
    env: PAIR,
    fetchImpl,
    now: () => clock,
  });
  const [a, b] = await Promise.all([service.status(), service.status()]);
  assert.deepEqual(a, { hasKey: true, state: 'ok', checkedAt: 1_000 });
  assert.deepEqual(b, a);
  assert.equal(calls.length, 1, 'concurrent checks share one request');
  assert.equal(
    calls[0].init.redirect,
    'error',
    'the keyed URL is never redirected',
  );
  clock += TMB_STATUS_TTL_MS - 1;
  await service.status();
  assert.equal(calls.length, 1, 'cached within the window');
  clock += 2;
  await service.status();
  assert.equal(calls.length, 2, 'rechecked after the window');
  const text = JSON.stringify(await service.status());
  assert.doesNotMatch(text, /fixture-id|fixture-secret/);
});

test('a refused pair, a TMB outage and a key change are told apart', async () => {
  const env = { ...PAIR };
  const answers = [{ status: 401, body: {} }, { status: 'throw' }, {}];
  const { fetchImpl } = fakeFetch((n) => answers[n - 1]);
  const service = createTmbStatusService({ env, fetchImpl });
  assert.equal((await service.status()).state, 'rejected');
  env.TMB_APP_KEY = 'another-secret';
  assert.equal((await service.status()).state, 'unavailable');
  env.TMB_APP_KEY = 'third-secret';
  assert.equal((await service.status()).state, 'ok');
});

test('the status route answers only GET on its exact path', async () => {
  let handler = null;
  const plugin = tmbProxy({ env: {}, fetchImpl: fakeFetch({}).fetchImpl });
  plugin.configureServer({
    middlewares: {
      use(path, fn) {
        assert.equal(path, '/api/tmb/status');
        handler = fn;
      },
    },
  });
  const call = async (method, url) => {
    const res = {
      code: 0,
      body: '',
      writeHead(code) {
        this.code = code;
      },
      setHeader() {},
      end(text) {
        this.body = text;
      },
    };
    await handler(
      {
        method,
        url,
        headers: { host: 'localhost:4173' },
        socket: {},
      },
      res,
    );
    return res;
  };
  const ok = await call('GET', '/');
  assert.equal(ok.code, 200);
  assert.deepEqual(JSON.parse(ok.body), {
    hasKey: false,
    state: null,
    checkedAt: null,
  });
  assert.equal((await call('POST', '/')).code, 405);
  assert.equal((await call('GET', '/elsewhere')).code, 404);
});

test('POWER UP offers the TMB pair as one free, server-side credential', () => {
  const tmb = KEY_SETUP_KEYS.find((key) => key.id === 'tmb');
  assert.ok(tmb);
  assert.deepEqual([...tmb.envVars], ['TMB_APP_ID', 'TMB_APP_KEY']);
  assert.equal(tmb.tier, 'free');
  assert.notEqual(tmb.clientExposed, true);
  assert.match(tmb.getUrl, /^https:\/\/developer\.tmb\.cat\//);
  const half = keySetupStatus({ TMB_APP_ID: 'fixture-id' });
  assert.equal(half.keys.find((key) => key.id === 'tmb').set, false);
  const whole = keySetupStatus(PAIR);
  assert.equal(whole.keys.find((key) => key.id === 'tmb').set, true);
  assert.doesNotMatch(JSON.stringify(whole), /fixture-secret/);
});
