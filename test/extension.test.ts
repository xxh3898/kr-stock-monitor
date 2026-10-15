import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionContext } from 'vscode';
import { State } from '../src/kisClient';
import { Quote } from '../src/quote';

const threeStocks = [{ code: '000990', name: 'DB하이텍' }, { code: '204320', name: 'HL만도' }, { code: '108860', name: '셀바스AI' }];

function environment(initial: Record<string, unknown> = {}) {
  const commands = new Map<string, () => Promise<void>>();
  const secrets = new Map<string, string>();
  const inputs: (string | undefined)[] = [];
  const picks: (string | undefined)[] = [];
  const notices: string[] = [];
  const logs: string[] = [];
  let configListener: (event: { affectsConfiguration: (section: string) => boolean }) => void = () => {};
  let secretListener: (event: { key: string }) => void = () => {};
  let starts = 0;
  let stops = 0;
  let passwords = true;
  let failStore = false;
  let confirmDelete = false;
  const intervals: number[] = [];
  let quoteListener: (quote: Quote) => void = () => {};
  const configuration: Record<string, unknown> = { stocks: [{ code: '204320', name: 'HL만도' }], rotationInterval: 5, ...initial };
  const change = (key = 'stocks') => configListener({ affectsConfiguration: (section: string) => section === 'krStockMonitor' || section === `krStockMonitor.${key}` });
  const disposable = { dispose() {} };
  const bar = { text: '', tooltip: '', name: '', command: '', show() {}, dispose() {} };
  const context = {
    subscriptions: [] as { dispose(): void }[],
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => { if (failStore) throw new Error('synthetic-secret'); secrets.set(key, value); secretListener({ key }); },
      delete: async (key: string) => { secrets.delete(key); },
      onDidChange: (listener: typeof secretListener) => { secretListener = listener; return disposable; }
    }
  } as unknown as ExtensionContext;
  const vscode = {
    StatusBarAlignment: { Right: 2 }, ConfigurationTarget: { Global: 1 },
    window: {
      createStatusBarItem: () => bar,
      createOutputChannel: () => ({ appendLine: (text: string) => logs.push(text), show() {}, dispose() {} }),
      showInputBox: async (options: { password?: boolean; title: string }) => { if (options.title.includes('APP')) passwords &&= options.password === true; return inputs.shift(); },
      showInformationMessage: (text: string) => { notices.push(text); },
      showErrorMessage: (text: string) => { notices.push(text); },
      showWarningMessage: async () => confirmDelete ? '삭제' : undefined,
      showQuickPick: async (options: { label: string }[]) => { const label = picks.shift(); return options.find(option => option.label === label); }
    },
    commands: {
      registerCommand: (id: string, handler: () => Promise<void>) => { commands.set(id, handler); return disposable; },
      executeCommand: async (id: string) => commands.get(id)?.()
    },
    workspace: {
      getConfiguration: () => ({ get: (key: string, fallback: unknown) => configuration[key] ?? fallback, update: async (key: string, value: unknown) => { configuration[key] = value; change(key); } }),
      onDidChangeConfiguration: (listener: typeof configListener) => { configListener = listener; return disposable; }
    }
  };
  const kis = { createClient: (state: (value: State) => void, quote: (value: Quote) => void) => {
    quoteListener = quote;
    return {
      start(_stocks: unknown, seconds: number) {
        starts++; intervals.push(seconds);
        void Promise.resolve().then(() => state({ kind: secrets.has('kis.real.credentials.v1') ? 'live' : 'keys', message: secrets.has('kis.real.credentials.v1') ? 'HTTPS 주기 조회' : '실전 API 키 등록 필요' }));
      },
      updateInterval(seconds: number) { intervals.push(seconds); },
      stop() { stops++; state({ kind: 'idle', message: '연결 안 됨' }); }
    };
  } };
  const Module = require('node:module') as { _load: (id: string, ...args: any[]) => any };
  const load = Module._load;
  const path = require.resolve('../src/extension');
  delete require.cache[path];
  Module._load = function(id: string, ...args: any[]) {
    if (id === 'vscode') return vscode;
    if (id === './kisClient') return kis;
    return load.call(this, id, ...args);
  };
  let extension: typeof import('../src/extension');
  try { extension = require('../src/extension'); } finally { Module._load = load; }
  extension.activate(context);
  return { bar, inputs, picks, notices, logs, secrets, configuration,
    run: async (id: string) => { await commands.get(`krStockMonitor.${id}`)!(); await new Promise<void>(resolve => setImmediate(resolve)); },
    dispose: () => { extension.deactivate(); for (const item of context.subscriptions) item.dispose(); },
    starts: () => starts, stops: () => stops, passwords: () => passwords, failStore: () => { failStore = true; },
    secretChanged: (key: string) => secretListener({ key }), intervals, confirmDeletion: () => { confirmDelete = true; }, change, quote: (value: Quote) => quoteListener(value) };
}

test('activation is offline and demo is explicit; switching to real clears simulated prices', async () => {
  const h = environment();
  try {
    assert.equal(h.starts(), 0);
    await h.run('demo'); assert.ok(h.bar.text.startsWith('[데모]')); assert.ok(h.bar.text.includes('10,000원'));
    await h.run('connect'); assert.equal(h.starts(), 1); assert.ok(!h.bar.text.includes('10,000원')); assert.ok(!h.bar.text.includes('[데모]'));
    assert.ok(h.bar.text.includes('키 등록 필요'));
  } finally { h.dispose(); }
});

test('key registration cancellation preserves original credentials and storage is atomic', async () => {
  const h = environment();
  try {
    h.secrets.set('kis.real.credentials.v1', 'old-value');
    h.inputs.push('synthetic-app-key', undefined); await h.run('registerKeys');
    assert.equal(h.secrets.get('kis.real.credentials.v1'), 'old-value');
    h.inputs.push('synthetic-app-key', 'synthetic-app-secret'); await h.run('registerKeys');
    assert.deepEqual(JSON.parse(h.secrets.get('kis.real.credentials.v1')!), { appKey: 'synthetic-app-key', appSecret: 'synthetic-app-secret' });
    assert.ok(h.passwords()); assert.ok(!JSON.stringify(h.logs).includes('synthetic-app-secret'));
    assert.equal(h.starts(), 0);
  } finally { h.dispose(); }
});

test('storage failure shows a safe message and deletion cancellation keeps keys', async () => {
  const h = environment();
  try {
    h.secrets.set('kis.real.credentials.v1', 'old-value'); h.failStore();
    h.inputs.push('synthetic-app-key', 'synthetic-app-secret'); await h.run('registerKeys');
    assert.equal(h.secrets.get('kis.real.credentials.v1'), 'old-value');
    assert.ok(!JSON.stringify(h.notices).includes('synthetic-secret'));
    await h.run('removeKeys'); assert.equal(h.secrets.size, 1);
  } finally { h.dispose(); }
});

test('invalid configuration stops live connections instead of continuing with old symbols', async () => {
  const h = environment();
  try {
    await h.run('connect'); const stops = h.stops();
    h.configuration.stocks = [{ code: 'bad', name: 'invalid' }]; h.change();
    assert.ok(h.stops() > stops); assert.equal(h.starts(), 1); assert.ok(h.bar.text.includes('6자리'));
  } finally { h.dispose(); }
});

test('all mode displays every stock, keeps pending symbols and updates each quote in place', async () => {
  const h = environment({ stocks: threeStocks });
  try {
    assert.ok(h.bar.text.includes('DB하이텍 시세 대기 | HL만도 시세 대기 | 셀바스AI 시세 대기'));
    await h.run('connect');
    h.quote({ code: '204320', price: 45000, changeRate: 1.25, receivedAt: 123 });
    assert.ok(h.bar.text.includes('DB하이텍 시세 대기 | HL만도 45,000원 (+1.25%) | 셀바스AI 시세 대기'));
    assert.ok(h.bar.tooltip.includes('마지막 조회')); assert.ok(h.bar.tooltip.includes('실제 체결 시각이 아닙니다'));
    const text = h.bar.text;
    h.picks.push('표시 방식 선택', undefined); await h.run('menu');
    assert.equal(h.bar.text, text); assert.equal(h.starts(), 1);
  } finally { h.dispose(); }
});

test('both modes are reachable; rotation uses its interval and switching keeps live quotes without reconnecting', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = environment({ stocks: threeStocks });
  try {
    await h.run('connect');
    h.quote({ code: '204320', price: 45000, changeRate: 1.25, receivedAt: 123 });
    h.picks.push('표시 방식 선택', '순환 표시'); await h.run('menu');
    assert.equal(h.configuration.displayMode, 'rotate');
    assert.ok(h.bar.text.includes('DB하이텍')); assert.ok(!h.bar.text.includes('HL만도'));
    t.mock.timers.tick(4999); assert.ok(h.bar.text.includes('DB하이텍'));
    t.mock.timers.tick(1); assert.ok(h.bar.text.includes('HL만도 45,000원')); assert.ok(!h.bar.text.includes('DB하이텍'));
    h.picks.push('셀바스AI'); await h.run('menu'); assert.ok(h.bar.text.includes('셀바스AI'));
    t.mock.timers.tick(5000); assert.ok(h.bar.text.includes('DB하이텍'));
    h.configuration.rotationInterval = 2; h.change('rotationInterval');
    t.mock.timers.tick(2000); assert.ok(h.bar.text.includes('HL만도'));
    h.picks.push('모두 표시'); await h.run('displayMode');
    assert.ok(h.bar.text.includes('DB하이텍')); assert.ok(h.bar.text.includes('HL만도 45,000원')); assert.ok(h.bar.text.includes('셀바스AI'));
    const text = h.bar.text; t.mock.timers.tick(10000); assert.equal(h.bar.text, text);
    assert.equal(h.starts(), 1);
    h.dispose(); t.mock.timers.tick(10000); assert.equal(h.bar.text, text);
  } finally { h.dispose(); }
});

test('all mode creates no rotation timer and ignores an unused interval; invalid rotate settings stop the client', async t => {
  const interval = t.mock.method(globalThis, 'setInterval');
  const h = environment({ stocks: threeStocks, rotationInterval: 0 });
  try {
    assert.equal(interval.mock.callCount(), 0); assert.ok(h.bar.text.includes('셀바스AI'));
    await h.run('connect'); const before = h.stops();
    h.configuration.displayMode = 'rotate'; h.change('displayMode');
    assert.ok(h.stops() > before); assert.ok(h.bar.text.includes('1~60초'));
    h.configuration.displayMode = 'unknown'; h.change('displayMode'); assert.ok(h.bar.text.includes('all 또는 rotate'));
  } finally { h.dispose(); }
});

test('zero and one stock work in both modes without an unnecessary rotation timer', async t => {
  const interval = t.mock.method(globalThis, 'setInterval');
  for (const displayMode of ['all', 'rotate']) {
    for (const stocks of [[], [threeStocks[0]]]) {
      const h = environment({ stocks, displayMode });
      try { assert.ok(h.bar.text.includes(stocks.length ? 'DB하이텍' : '관심 종목 추가')); }
      finally { h.dispose(); }
    }
  }
  assert.equal(interval.mock.callCount(), 0);
});

test('existing credentials and all/rotate settings survive activation and HTTPS uses the selected polling interval', async () => {
  for (const displayMode of ['all', 'rotate']) {
    const h = environment({ stocks: threeStocks, displayMode, rotationInterval: 7, pollingInterval: 10 });
    const old = JSON.stringify({ appKey: 'synthetic-existing-key', appSecret: 'synthetic-existing-secret' });
    h.secrets.set('kis.real.credentials.v1', old);
    try {
      await h.run('connect'); assert.deepEqual(h.intervals, [10]);
      assert.equal(h.secrets.get('kis.real.credentials.v1'), old);
      assert.deepEqual(h.configuration.stocks, threeStocks); assert.equal(h.configuration.displayMode, displayMode);
      assert.equal(h.configuration.rotationInterval, 7); assert.ok(h.bar.text.startsWith('[KRX · HTTPS]'));
      h.configuration.pollingInterval = 15; h.change('pollingInterval');
      assert.deepEqual(h.intervals, [10, 15]); assert.equal(h.starts(), 1);
      h.configuration.pollingInterval = 4; h.change('pollingInterval'); assert.match(h.bar.text, /5~300초/);
    } finally { h.dispose(); }
  }
});

test('deleting keys also removes derived token cache without changing watchlist or display settings', async () => {
  const h = environment({ stocks: threeStocks, displayMode: 'rotate', rotationInterval: 7 });
  try {
    h.secrets.set('kis.real.credentials.v1', 'synthetic-credentials'); h.secrets.set('kis.real.restToken.v1', 'synthetic-token-cache');
    await h.run('removeKeys'); assert.equal(h.secrets.size, 2);
    h.confirmDeletion(); await h.run('removeKeys'); assert.equal(h.secrets.size, 0);
    assert.deepEqual(h.configuration.stocks, threeStocks); assert.equal(h.configuration.displayMode, 'rotate'); assert.equal(h.configuration.rotationInterval, 7);
  } finally { h.dispose(); }
});

test('derived token cache changes do not disconnect but original credential changes clear the derived cache', async () => {
  const h = environment();
  try {
    await h.run('connect'); const stops = h.stops();
    h.secrets.set('kis.real.restToken.v1', 'synthetic-cache');
    h.secretChanged('kis.real.restToken.v1'); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.stops(), stops);
    // Exercise the original credential event path through key registration.
    h.inputs.push('synthetic-key', 'synthetic-secret'); await h.run('registerKeys');
    assert.ok(h.stops() > stops); assert.equal(h.secrets.has('kis.real.restToken.v1'), false);
  } finally { h.dispose(); }
});
