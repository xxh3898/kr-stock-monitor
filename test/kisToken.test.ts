import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Credentials, KisError, KisTokenProvider, requestJson, TOKEN_KEY } from '../src/kisToken';
import { settle, tokenResponse } from './fixtures';

const credentials: Credentials = { appKey: 'synthetic-key', appSecret: 'synthetic-secret' };
function harness() {
  const data = new Map<string, string>();
  let now = Date.parse('2026-10-15T00:00:00Z'), calls = 0;
  let keys: Credentials | undefined = credentials;
  let response: () => Promise<any> = async () => tokenResponse(now);
  const store = { get: async (key: string) => data.get(key), store: async (key: string, value: string) => { data.set(key, value); }, delete: async (key: string) => { data.delete(key); } };
  const provider = () => new KisTokenProvider(async () => keys, store, async () => { calls++; return response(); }, () => now);
  const tokens = provider();
  return { tokens, data, provider, calls: () => calls, now: () => now, advance: (ms: number) => { now += ms; },
    keys: (value: Credentials | undefined) => { keys = value; }, response: (value: typeof response) => { response = value; },
    get: (signal = new AbortController().signal) => tokens.get(signal) };
}

test('token reuse survives new providers and stores no original credentials in the derived cache', async () => {
  const h = harness(); const result = await h.get(); assert.equal(result?.token, 'synthetic-access-token');
  await h.get(); await h.provider().get(new AbortController().signal); assert.equal(h.calls(), 1);
  assert.deepEqual([...h.data.keys()], [TOKEN_KEY]);
  assert.ok(!h.data.get(TOKEN_KEY)!.includes(credentials.appKey));
  assert.ok(!h.data.get(TOKEN_KEY)!.includes(credentials.appSecret));
});

test('simultaneous token requests in one provider share a single issuance', async () => {
  const h = harness(); await Promise.all([h.get(), h.get(), h.get()]); assert.equal(h.calls(), 1);
});

test('server expiry is not extended on reads and renewal uses the 60 second margin', async () => {
  const h = harness();
  h.response(async () => ({ ...tokenResponse(h.now()), access_token_token_expired: tokenResponse(h.now(), 600).access_token_token_expired }));
  await h.get(); const expiresAt = JSON.parse(h.data.get(TOKEN_KEY)!).expiresAt;
  assert.equal(expiresAt, h.now() + 600000);
  h.advance(539000); await h.get(); assert.equal(h.calls(), 1);
  assert.equal(JSON.parse(h.data.get(TOKEN_KEY)!).expiresAt, expiresAt);
  h.advance(1000); await h.get(); assert.equal(h.calls(), 2);
});

test('relative lifetime can shorten absolute expiry and reads never invent a fresh lifetime', async () => {
  const h = harness(); h.response(async () => ({ ...tokenResponse(h.now()), expires_in: 180 }));
  await h.get(); assert.equal(JSON.parse(h.data.get(TOKEN_KEY)!).expiresAt, h.now() + 180000);
  h.advance(120000); await assert.rejects(h.get(), error => error instanceof KisError && error.kind === 'cooldown' && error.retryAfter === 180000);
  assert.equal(h.calls(), 1);
});

test('failed issuance leaves a five minute cooldown shared with other providers', async () => {
  const h = harness(); h.response(async () => { throw new KisError('transient', 'network'); });
  await assert.rejects(h.get());
  await assert.rejects(h.provider().get(new AbortController().signal), error => error instanceof KisError && error.kind === 'cooldown');
  assert.equal(h.calls(), 1); h.advance(300000); h.response(async () => tokenResponse(h.now())); await h.get(); assert.equal(h.calls(), 2);
});

test('longer server issuance waits are persisted and invalidation cannot bypass cooldown', async () => {
  const h = harness(); h.response(async () => { throw new KisError('transient', 'limited', 600000); });
  await assert.rejects(h.get()); assert.equal(JSON.parse(h.data.get(TOKEN_KEY)!).nextAttemptAt, h.now() + 600000);
  h.advance(600000); h.response(async () => tokenResponse(h.now())); const session = await h.get();
  await h.tokens.invalidate(session!.token); await assert.rejects(h.get(), error => error instanceof KisError && error.kind === 'cooldown');
  assert.equal(h.calls(), 2);
});

test('malformed expiry, token type and lifetime never produce a usable cached token', async () => {
  for (const bad of [{ access_token_token_expired: '2026-02-30 12:00:00' }, { access_token_token_expired: 'bad' },
    { token_type: 'wrong' }, { expires_in: '86400' }, { expires_in: -1 }, { expires_in: 60 }, { access_token: '' }]) {
    const h = harness(); h.response(async () => ({ ...tokenResponse(h.now()), ...bad }));
    await assert.rejects(h.get(), error => error instanceof KisError && error.kind === 'fatal');
    assert.equal(JSON.parse(h.data.get(TOKEN_KEY)!).token, undefined);
  }
});

test('missing credentials and corrupt derived cache preserve the original store contract', async () => {
  const h = harness(); h.keys(undefined); assert.equal(await h.get(), undefined); assert.equal(h.calls(), 0);
  h.keys(credentials); h.data.set(TOKEN_KEY, '{bad'); await h.get(); assert.equal(h.calls(), 1);
  h.keys({ ...credentials, appSecret: 'synthetic-replacement' }); await h.get(); assert.equal(h.calls(), 2);
});

test('clear and credential replacement prevent old issuance results from repopulating cache', async () => {
  const h = harness(); let finish!: (data: any) => void;
  h.response(async () => new Promise(resolve => { finish = resolve; }));
  const pending = h.get(); const rejected = assert.rejects(pending); await settle();
  h.keys({ ...credentials, appSecret: 'synthetic-new' }); await h.tokens.clear();
  finish(tokenResponse(h.now())); await rejected; assert.equal(h.data.has(TOKEN_KEY), false);
});

test('aborting in-flight issuance and an already aborted caller cannot persist a token', async () => {
  const h = harness(); const abort = new AbortController(); let finish!: (data: any) => void;
  h.response(async () => new Promise(resolve => { finish = resolve; }));
  const pending = h.get(abort.signal); const rejected = assert.rejects(pending); await settle();
  abort.abort(); finish(tokenResponse(h.now())); await rejected;
  assert.equal(JSON.parse(h.data.get(TOKEN_KEY)!).token, undefined);
  await assert.rejects(h.get(abort.signal)); assert.equal(h.calls(), 1);
});

test('stale token invalidation preserves a newer shared token', async () => {
  const h = harness(); await h.get(); await h.tokens.invalidate('synthetic-old');
  assert.equal((await h.get())?.token, 'synthetic-access-token'); assert.equal(h.calls(), 1);
});

test('HTTPS token issuance sends the tokenP contract without exposing raw errors', async t => {
  const data = new Map<string, string>();
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(url, 'https://openapi.koreainvestment.com:9443/oauth2/tokenP');
    assert.equal(options?.method, 'POST'); assert.equal(options?.redirect, 'error'); assert.ok(options?.signal);
    assert.deepEqual(JSON.parse(options?.body as string), { grant_type: 'client_credentials', appkey: credentials.appKey, appsecret: credentials.appSecret });
    return Response.json(tokenResponse(Date.now()));
  });
  const tokens = new KisTokenProvider(async () => credentials, { get: async k => data.get(k), store: async (k,v) => { data.set(k,v); }, delete: async k => { data.delete(k); } });
  assert.equal((await tokens.get(new AbortController().signal))?.token, 'synthetic-access-token');
});

test('HTTP/business errors classify auth, quota, token issuance limits and schema failures safely', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch');
  const cases: [number, unknown, string, number][] = [
    [200, { rt_cd: '1', msg_cd: 'EGW00123' }, 'auth', 0], [401, null, 'auth', 0],
    [200, { rt_cd: '1', msg_cd: 'EGW00201' }, 'transient', 5000], [429, null, 'transient', 5000], [500, null, 'transient', 0],
    [403, { msg_cd: 'EGW00133' }, 'transient', 300000], [200, { rt_cd: '1', msg_cd: 'synthetic-secret' }, 'fatal', 0],
    [403, null, 'fatal', 0], [200, null, 'fatal', 0], [200, [], 'fatal', 0]
  ];
  for (const [status, body, kind, retry] of cases) {
    fetchMock.mock.mockImplementation(async () => new Response(body === null ? 'synthetic-secret' : JSON.stringify({ ...body as object, msg1: 'synthetic-secret' }), { status }));
    // Arrays are tested separately because object spread above intentionally constructs an object.
    if (Array.isArray(body)) fetchMock.mock.mockImplementation(async () => Response.json(body));
    await assert.rejects(requestJson('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {}, new AbortController().signal), error => {
      assert.ok(error instanceof KisError); assert.equal(error.kind, kind); assert.equal(error.retryAfter, retry);
      assert.ok(!error.message.includes('synthetic-secret')); return true;
    });
  }
});

test('Retry-After seconds and dates are honored; oversized and malformed bodies are rejected', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 429, headers: { 'retry-after': '90' } }));
  const get = () => requestJson('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {}, new AbortController().signal);
  await assert.rejects(get(), e => e instanceof KisError && e.retryAfter === 90000);
  fetchMock.mock.mockImplementation(async () => new Response('', { status: 503, headers: { 'retry-after': new Date(Date.now() + 120000).toUTCString() } }));
  await assert.rejects(get(), e => e instanceof KisError && e.retryAfter >= 118000);
  fetchMock.mock.mockImplementation(async () => new Response('x'.repeat(1024 * 1024 + 1)));
  await assert.rejects(get(), e => e instanceof KisError && e.kind === 'fatal');
  fetchMock.mock.mockImplementation(async () => new Response('', { status: 429, headers: { 'retry-after': 'bad' } }));
  await assert.rejects(get(), e => e instanceof KisError && e.kind === 'fatal');
});

test('network errors retry, certificate errors stop and caller cancellation reaches fetch', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('synthetic-secret'); });
  const call = (signal = new AbortController().signal) => requestJson('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {}, signal);
  await assert.rejects(call(), e => e instanceof KisError && e.kind === 'transient' && !e.message.includes('synthetic-secret'));
  fetchMock.mock.mockImplementation(async () => { throw new Error('synthetic-secret', { cause: { code: 'CERT_HAS_EXPIRED' } }); });
  await assert.rejects(call(), e => e instanceof KisError && e.kind === 'fatal');
  let received!: AbortSignal;
  fetchMock.mock.mockImplementation(async (_url: any, options?: RequestInit) => {
    received = options!.signal!;
    return new Promise<Response>((_resolve, reject) => received.addEventListener('abort', () => reject(new Error('synthetic-secret')), { once: true }));
  });
  const abort = new AbortController(); const pending = call(abort.signal); const rejected = assert.rejects(pending);
  await settle(); abort.abort(); await rejected; assert.equal(received.aborted, true);
});

test('HTTPS requests enforce the ten second timeout without an insecure fallback', async t => {
  const timeout = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => { assert.equal(milliseconds, 10000); return timeout.signal; });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: any, options?: RequestInit) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('synthetic-secret')), { once: true }));
  });
  const request = requestJson('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {}, new AbortController().signal);
  const rejected = assert.rejects(request, e => e instanceof KisError && e.kind === 'transient');
  timeout.abort(); await rejected; assert.equal(calls, 1);
});

test('corrupt far-future cooldown cannot overflow Node timers into a hot retry loop', async () => {
  const h = harness(); await h.get();
  const cache = JSON.parse(h.data.get(TOKEN_KEY)!); cache.nextAttemptAt = h.now() + 2147483648;
  delete cache.token; delete cache.expiresAt; h.data.set(TOKEN_KEY, JSON.stringify(cache));
  await h.get(); assert.equal(h.calls(), 2);
});

test('invalid or excessive Retry-After never reaches a timer', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 429, headers: { 'retry-after': '2147484' } }));
  await assert.rejects(requestJson('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {}, new AbortController().signal), e => e instanceof KisError && e.kind === 'fatal');
});
