import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dependencies, KisClient, requestQuote, State } from '../src/kisClient';
import { KisError, KisTokenProvider, Session } from '../src/kisToken';
import { parseQuote, Quote } from '../src/quote';
import { quoteResponse, tokenResponse, settle } from './fixtures';

const stocks = [{ code: '000990', name: 'DB하이텍' }, { code: '204320', name: 'HL만도' }, { code: '108860', name: '셀바스AI' }];
const session: Session = { credentials: { appKey: 'synthetic-key', appSecret: 'synthetic-secret' }, token: 'synthetic-access-token' };

function harness(overrides: Partial<Dependencies> = {}) {
  const tasks = new Map<number, { callback(): void; at: number; delay: number }>();
  const states: State[] = [], quotes: Quote[] = [], requests: { code: string; at: number }[] = [];
  let now = 0, id = 0, invalidations = 0;
  const deps: Dependencies = {
    session: async () => session,
    invalidate: async () => { invalidations++; },
    request: async stock => { requests.push({ code: stock.code, at: now }); return parseQuote(quoteResponse(stock.code), stock.code, now); },
    schedule: (callback, delay) => { tasks.set(++id, { callback, at: now + delay, delay }); return id; },
    cancel: handle => { tasks.delete(handle as number); }, now: () => now, ...overrides
  };
  const client = new KisClient(state => states.push(state), quote => quotes.push(quote), deps);
  return { client, states, quotes, requests, tasks, deps, now: () => now, invalidations: () => invalidations,
    async next(delay?: number) {
      const entry = [...tasks.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      assert.ok(entry, 'scheduled task');
      if (delay !== undefined) assert.equal(entry[1].delay, delay);
      tasks.delete(entry[0]); now = entry[1].at; entry[1].callback(); await settle();
    }, advance: (ms: number) => { now += ms; }
  };
}

test('missing keys and empty stocks do not request a quote', async () => {
  const h = harness({ session: async () => undefined });
  h.client.start(stocks); await settle(); assert.equal(h.states.at(-1)?.kind, 'keys');
  assert.equal(h.requests.length, 0); assert.equal(h.tasks.size, 0);
  h.client.start([]); await settle(); assert.equal(h.states.at(-1)?.kind, 'idle'); h.client.stop();
});

test('three symbols are requested immediately then serially at least one second apart and every five seconds', async () => {
  const h = harness(); h.client.start(stocks); await settle();
  assert.equal(h.quotes.length, 1); await h.next(1000); await h.next(1000);
  assert.deepEqual(h.requests, stocks.map((s, i) => ({ code: s.code, at: i * 1000 })));
  assert.equal(h.states.at(-1)?.kind, 'live');
  await h.next(3000); assert.equal(h.requests[3].at, 5000);
  h.client.stop(); await settle(); assert.equal(h.tasks.size, 0);
});

test('slow responses do not overlap, catch up in bursts, or schedule while requests remain in flight', async () => {
  let resolve!: (quote: Quote) => void;
  const h = harness({ request: async stock => new Promise(done => { resolve = done; assert.equal(stock.code, stocks[0].code); }) });
  h.client.start([stocks[0]]); await settle(); assert.equal(h.tasks.size, 0);
  h.advance(12000); resolve(parseQuote(quoteResponse(stocks[0].code), stocks[0].code)); await settle();
  assert.equal(h.tasks.size, 1); await h.next(0); assert.equal(h.tasks.size, 0);
  h.client.stop(); resolve(parseQuote(quoteResponse(stocks[0].code), stocks[0].code)); await settle();
  assert.equal(h.quotes.length, 1); assert.equal(h.tasks.size, 0);
});

test('interval changes reschedule normal polling without reauthentication or clearing prices', async () => {
  let sessions = 0;
  const h = harness({ session: async () => { sessions++; return session; } });
  h.client.start([stocks[0]]); await settle(); h.client.updateInterval(10);
  assert.equal(h.quotes.length, 1); assert.equal(sessions, 1);
  await h.next(10000); assert.equal(h.requests[1].at, 10000);
  h.client.stop();
});

test('backoff reaches 5/10/20/40/60 seconds, survives interval changes and stops on sixth failure', async () => {
  const h = harness({ request: async () => { throw new KisError('transient', '일시 오류'); } });
  h.client.start([stocks[0]]); await settle();
  for (const delay of [5000, 10000, 20000, 40000, 60000]) {
    h.client.updateInterval(5); await h.next(delay);
  }
  assert.equal(h.states.at(-1)?.kind, 'error'); assert.equal(h.tasks.size, 0); h.client.stop();
});

test('partial failures keep successful symbols and full success resets backoff', async () => {
  let fail = true;
  const h = harness({ request: async stock => {
    if (stock.code === stocks[1].code && fail) throw new KisError('transient', '제한');
    return parseQuote(quoteResponse(stock.code), stock.code);
  } });
  h.client.start(stocks); await settle(); await h.next(1000); await h.next(1000);
  assert.equal(h.quotes.length, 2); assert.match(h.states.at(-1)!.message, /부분 조회 실패 204320/);
  fail = false; await h.next(5000); await h.next(1000); await h.next(1000);
  assert.equal(h.states.at(-1)?.kind, 'live');
  fail = true; await h.next(3000); await h.next(1000); await h.next(1000);
  assert.equal([...h.tasks.values()][0].delay, 5000); h.client.stop();
});

test('full success resets failure counter back to the initial delay', async () => {
  let fail = true;
  const h = harness({ request: async stock => { if (fail) throw new KisError('transient', '일시 오류'); return parseQuote(quoteResponse(stock.code), stock.code); } });
  h.client.start([stocks[0]]); await settle(); await h.next(5000);
  fail = false; await h.next(10000); assert.equal(h.states.at(-1)?.kind, 'live');
  fail = true; await h.next(5000); assert.equal([...h.tasks.values()][0].delay, 5000); h.client.stop();
});

test('one authentication recovery invalidates the cache; repeated authentication failure stops', async () => {
  const h = harness({ request: async () => { throw new KisError('auth', '인증 오류'); } });
  h.client.start([stocks[0]]); await settle(); assert.equal(h.invalidations(), 1);
  await h.next(1000); assert.equal(h.invalidations(), 1); assert.equal(h.states.at(-1)?.kind, 'error');
  assert.equal(h.tasks.size, 0); h.client.stop();
});

test('token cooldown rechecks shared cache without consuming network retry budget', async () => {
  let cooling = true;
  const h = harness({ session: async () => { if (cooling) throw new KisError('cooldown', '발급 대기', 300000); return session; } });
  h.client.start([stocks[0]]); await settle(); assert.equal(h.states.at(-1)?.kind, 'waiting');
  cooling = false; await h.next(300000); assert.equal(h.quotes.length, 1); h.client.stop();
});

test('stop cancels pacing and authentication; stale request completions cannot update quotes', async () => {
  const h = harness(); h.client.start(stocks); await settle(); h.client.stop(); await settle();
  assert.equal(h.quotes.length, 1); assert.equal(h.tasks.size, 0);
  let done!: (value: Session) => void, signal!: AbortSignal;
  const pending = harness({ session: async s => { signal = s; return new Promise(resolve => { done = resolve; }); } });
  pending.client.start(stocks); await settle(); pending.client.stop(); assert.equal(signal.aborted, true);
  done(session); await settle(); assert.equal(pending.quotes.length, 0); assert.equal(pending.tasks.size, 0);
});

test('unknown storage/request exceptions stop without echoing secrets', async () => {
  for (const overrides of [{ session: async () => { throw new Error('synthetic-secret'); } },
    { request: async () => { throw new Error('synthetic-secret'); } }]) {
    const h = harness(overrides); h.client.start([stocks[0]]); await settle();
    assert.equal(h.states.at(-1)?.kind, 'error'); assert.ok(!JSON.stringify(h.states).includes('synthetic-secret'));
    assert.equal(h.tasks.size, 0); h.client.stop();
  }
});

test('HTTPS quote contract uses only KRX GET, secure headers and no credentials in URL', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    const u = new URL(String(url));
    assert.equal(u.origin, 'https://openapi.koreainvestment.com:9443');
    assert.equal(u.pathname, '/uapi/domestic-stock/v1/quotations/inquire-price');
    assert.equal(u.searchParams.get('FID_COND_MRKT_DIV_CODE'), 'J');
    assert.equal(u.searchParams.get('FID_INPUT_ISCD'), '204320'); assert.ok(!String(url).includes('synthetic'));
    assert.equal(options?.method, 'GET'); assert.equal(options?.redirect, 'error');
    assert.equal(new Headers(options?.headers).get('authorization'), `Bearer ${session.token}`);
    assert.equal(new Headers(options?.headers).get('appsecret'), session.credentials.appSecret);
    assert.equal(new Headers(options?.headers).get('tr_id'), 'FHKST01010100');
    return Response.json(quoteResponse());
  });
  assert.equal((await requestQuote(stocks[1], session, new AbortController().signal)).price, 45000);
});

test('real token provider and HTTPS quote adapter integrate with polling and encrypted-cache interface', async t => {
  const store = new Map<string, string>(); const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    calls.push(String(url));
    return Response.json(String(url).endsWith('/tokenP') ? tokenResponse(Date.now()) : quoteResponse(stocks[0].code));
  });
  const tokens = new KisTokenProvider(async () => session.credentials, {
    get: async k => store.get(k), store: async (k,v) => { store.set(k,v); }, delete: async k => { store.delete(k); }
  });
  const h = harness({ session: signal => tokens.get(signal), request: requestQuote });
  h.client.start([stocks[0]]); await settle(); await h.next(5000);
  assert.equal(h.quotes.length, 2); assert.equal(calls.filter(url => url.endsWith('/tokenP')).length, 1);
  assert.equal(calls.length, 3); assert.ok(calls.every(url => url.startsWith('https://'))); h.client.stop();
});

test('Retry-After stops the current batch immediately and no other symbol is queried during the wait', async () => {
  let requests = 0;
  const h = harness({ request: async () => { requests++; throw new KisError('transient', '제한', 90000); } });
  h.client.start(stocks); await settle(); assert.equal(requests, 1); assert.equal(h.quotes.length, 0);
  await h.next(90000); assert.equal(requests, 2); h.client.stop();
});

test('a late response from a previous start cannot overwrite the new generation', async () => {
  let finish!: (quote: Quote) => void; let request = 0;
  const h = harness({ request: async stock => {
    request++;
    if (request === 1) return new Promise(resolve => { finish = resolve; });
    return parseQuote(quoteResponse(stock.code), stock.code);
  } });
  h.client.start([stocks[0]]); await settle();
  h.client.start([stocks[1]]); await settle(); await h.next(1000);
  assert.equal(h.quotes[0].code, stocks[1].code);
  finish(parseQuote(quoteResponse(stocks[0].code), stocks[0].code)); await settle();
  assert.equal(h.quotes.length, 1); h.client.stop();
});
