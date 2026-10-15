import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Credentials, Dependencies, KisClient, requestApproval, Socket, State } from '../src/kisClient';
import { Quote } from '../src/quote';
import { ack, quoteRow, settle } from './fixtures';

class FakeSocket extends EventEmitter implements Socket {
  readyState = 0;
  sent: string[] = [];
  pongs: string[] = [];
  open(): void { this.readyState = 1; this.emit('open'); }
  send(data: string, callback?: (error?: Error) => void): void { this.sent.push(data); callback?.(); }
  pong(data: string): void { this.pongs.push(data); }
  close(): void { this.readyState = 3; this.emit('close'); }
  terminate(): void { this.close(); }
}

function harness(overrides: Partial<Dependencies> = {}) {
  const sockets: FakeSocket[] = [];
  const tasks = new Map<number, { callback: () => void; delay: number }>();
  const states: State[] = [];
  const quotes: Quote[] = [];
  let counter = 0;
  let approvals = 0;
  const deps: Dependencies = {
    credentials: async () => ({ appKey: 'synthetic-app-key', appSecret: 'synthetic-app-secret' }),
    approval: async () => { approvals++; return 'synthetic-approval-key'; },
    socket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    schedule: (callback, delay) => { tasks.set(++counter, { callback, delay }); return counter; },
    cancel: handle => { tasks.delete(handle as number); }, ...overrides
  };
  const client = new KisClient(state => states.push(state), quote => quotes.push(quote), deps);
  return { client, sockets, tasks, states, quotes, approvals: () => approvals,
    run(delay: number) { const task = [...tasks.entries()].find(([, value]) => value.delay === delay); assert.ok(task, `timer ${delay}`); tasks.delete(task[0]); task[1].callback(); } };
}
const stocks = [{ code: '204320', name: 'HL만도' }, { code: '000990', name: 'DB하이텍' }];

test('requires keys before opening a socket', async () => {
  const h = harness({ credentials: async () => undefined });
  h.client.start(stocks); await settle();
  assert.equal(h.states.at(-1)?.kind, 'keys');
  assert.equal(h.sockets.length, 0); assert.equal(h.approvals(), 0); h.client.stop();
});

test('waits for per-symbol ACK, parses batched ticks, pongs and unsubscribes on stop', async () => {
  const h = harness(); h.client.start(stocks); await settle();
  const socket = h.sockets[0]; socket.open();
  assert.equal(h.states.at(-1)?.kind, 'subscribing');
  const sent = JSON.parse(socket.sent[0]);
  assert.equal(sent.body.input.tr_id, 'H0STCNT0'); assert.equal(sent.header.approval_key, 'synthetic-approval-key');
  assert.ok(!socket.sent[0].includes('synthetic-app-secret')); assert.ok(!socket.sent[0].includes('synthetic-app-key'));
  socket.emit('message', ack()); h.run(100);
  socket.emit('message', ack('000990')); h.run(100);
  assert.equal(h.states.at(-1)?.kind, 'waiting');
  socket.emit('message', `0|H0STCNT0|2|${quoteRow()}^${quoteRow('000990', '5', '2')}`);
  assert.equal(h.quotes.length, 2); assert.equal(h.states.at(-1)?.kind, 'live');
  const ping = '{"header":{"tr_id":"PINGPONG"}}'; socket.emit('message', ping);
  assert.deepEqual(socket.pongs, [ping]);
  h.client.stop();
  assert.equal(socket.sent.filter(raw => JSON.parse(raw).header.tr_type === '2').length, 2);
  assert.equal(h.tasks.size, 0);
  socket.emit('message', `0|H0STCNT0|1|${quoteRow()}`);
  assert.equal(h.quotes.length, 2);
});

test('repeated transport failures reach the 30 second cap without duplicate retries', async () => {
  const h = harness(); h.client.start(stocks); await settle();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const socket = h.sockets.at(-1)!; socket.open();
    socket.emit('error', new Error('synthetic-app-secret')); socket.emit('close');
    assert.equal(h.tasks.size, 1); h.run(delay); await settle();
  }
  assert.equal(h.approvals(), 1); // Reuse approval only in this running session.
  assert.ok(h.states.every(state => !state.message.includes('synthetic-app-secret')));
  h.client.stop(); assert.equal(h.tasks.size, 0);
});

test('subscription rejection and malformed protocol stop retries and hide server text', async () => {
  for (const message of [JSON.stringify({ header: { tr_id: 'H0STCNT0' }, body: { rt_cd: '1', msg_cd: 'ERR_1', msg1: 'synthetic-app-secret' } }),
    '0|H0STCNT0|1|bad']) {
    const h = harness(); h.client.start(stocks); await settle(); h.sockets[0].open();
    h.sockets[0].emit('message', message);
    assert.equal(h.states.at(-1)?.kind, 'error'); assert.equal(h.tasks.size, 0);
    assert.ok(!JSON.stringify(h.states).includes('synthetic-app-secret')); h.client.stop();
  }
});

test('a received quote resets backoff and early trades do not become waiting after the last ACK', async () => {
  const h = harness(); h.client.start([stocks[0]]); await settle();
  h.sockets[0].open(); h.sockets[0].emit('close'); h.run(1000); await settle();
  const socket = h.sockets[1]; socket.open(); socket.emit('message', ack());
  socket.emit('message', `0|H0STCNT0|1|${quoteRow()}`); h.run(100);
  assert.equal(h.states.at(-1)?.kind, 'live');
  socket.emit('close'); h.run(1000); await settle(); h.client.stop();
});

test('ACK timeout and silent transport timeout trigger reconnection independently of prices', async () => {
  const h = harness(); h.client.start([stocks[0]]); await settle(); h.sockets[0].open();
  h.run(10000); assert.equal(h.states.at(-1)?.kind, 'retry'); h.run(1000); await settle();
  h.sockets[1].open(); h.sockets[1].emit('message', ack()); h.run(100);
  h.run(90000); assert.equal(h.states.at(-1)?.kind, 'retry'); h.client.stop();
});

test('stopping an in-flight authentication prevents old results from opening sockets', async () => {
  let resolve!: (key: string) => void;
  let signal: AbortSignal | undefined;
  const h = harness({ approval: async (_keys, input) => { signal = input; return new Promise<string>(done => { resolve = done; }); } });
  h.client.start(stocks); await settle(); h.client.stop();
  assert.equal(signal?.aborted, true); resolve('synthetic-old-key'); await settle();
  assert.equal(h.sockets.length, 0); assert.equal(h.tasks.size, 0);
});

test('HTTPS approval uses the correct contract and never echoes raw error bodies', async t => {
  const credentials: Credentials = { appKey: 'synthetic-app-key', appSecret: 'synthetic-app-secret' };
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(url, 'https://openapi.koreainvestment.com:9443/oauth2/Approval');
    assert.equal(options?.redirect, 'error');
    assert.deepEqual(JSON.parse(options?.body as string), { grant_type: 'client_credentials', appkey: credentials.appKey, secretkey: credentials.appSecret });
    return new Response('{"approval_key":"synthetic-approval-key"}', { status: 200 });
  });
  assert.equal(await requestApproval(credentials, new AbortController().signal), 'synthetic-approval-key');
  fetchMock.mock.mockImplementation(async () => new Response('synthetic-app-secret', { status: 403 }));
  await assert.rejects(requestApproval(credentials, new AbortController().signal), error => error instanceof Error && error.message.includes('403') && !error.message.includes(credentials.appSecret));
  const h = harness({ approval: requestApproval }); h.client.start(stocks); await settle();
  assert.equal(h.states.at(-1)?.kind, 'error'); assert.equal(h.tasks.size, 0); h.client.stop();
});

test('approval network failures retry but stored key failures stop', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('synthetic-app-secret'); });
  const h = harness({ approval: requestApproval }); h.client.start(stocks); await settle();
  assert.equal(h.states.at(-1)?.kind, 'retry'); assert.ok(!JSON.stringify(h.states).includes('synthetic-app-secret')); h.client.stop();
  const bad = harness({ credentials: async () => { throw new Error('synthetic-app-secret'); } });
  bad.client.start(stocks); await settle(); assert.equal(bad.states.at(-1)?.kind, 'error'); assert.equal(bad.tasks.size, 0); bad.client.stop();
});
