import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionContext } from 'vscode';
import { State } from '../src/kisClient';
import { Quote } from '../src/quote';
import { ACCOUNT_KEY, ProfitMonitor } from '../src/profit';

const threeStocks = [{ code: '000990', name: 'DB하이텍' }, { code: '204320', name: 'HL만도' }, { code: '108860', name: '셀바스AI' }];

function environment(initial: Record<string, unknown> = {}, saved: Record<string, string> = {}) {
  const commands = new Map<string, () => Promise<void>>();
  const secrets = new Map<string, string>(Object.entries(saved));
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
  const profitMonitors: (ProfitMonitor | undefined)[] = [];
  let accountRead: Promise<string | undefined> | undefined;
  let stateListener: (state: State) => void = () => {};
  let quoteListener: (quote: Quote) => void = () => {};
  const configuration: Record<string, unknown> = { stocks: [{ code: '204320', name: 'HL만도' }], rotationInterval: 5, ...initial };
  const change = (key = 'stocks') => configListener({ affectsConfiguration: (section: string) => section === 'krStockMonitor' || section === `krStockMonitor.${key}` });
  const disposable = { dispose() {} };
  const bar = { text: '', tooltip: '', name: '', command: '', show() {}, dispose() {} };
  const context = {
    subscriptions: [] as { dispose(): void }[],
    secrets: {
      get: async (key: string) => key === ACCOUNT_KEY && accountRead ? accountRead : secrets.get(key),
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
    stateListener = state;
    quoteListener = quote;
    return {
      start(_stocks: unknown, seconds: number, profit?: ProfitMonitor) {
        profitMonitors.push(profit);
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
    secretChanged: (key: string) => secretListener({ key }), intervals, profitMonitors,
    deferAccountRead: () => { let resolve!: (value: string | undefined) => void; accountRead = new Promise(done => { resolve = done; }); return resolve; },
    confirmDeletion: () => { confirmDelete = true; }, change, state: (value: State) => stateListener(value), quote: (value: Quote) => quoteListener(value) };
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

test('polling keeps status bar text stable in both modes while tooltips and errors remain visible', async () => {
  for (const displayMode of ['all', 'rotate']) {
    const h = environment({ stocks: threeStocks, displayMode });
    try {
      h.secrets.set('kis.real.credentials.v1', 'synthetic-credentials');
      await h.run('connect');
      const pending = h.bar.text;
      h.state({ kind: 'connecting', message: 'HTTPS KRX 조회 중' });
      assert.equal(h.bar.text, pending);
      assert.ok(h.bar.tooltip.includes('HTTPS KRX 조회 중'));
      for (const stock of threeStocks) h.quote({ code: stock.code, price: 45000, changeRate: 1.25, receivedAt: 123 });
      h.state({ kind: 'live', message: 'HTTPS 5초 주기 조회' });
      const text = h.bar.text;
      for (let cycle = 0; cycle < 3; cycle++) {
        h.state({ kind: 'connecting', message: 'HTTPS KRX 조회 중' });
        assert.equal(h.bar.text, text);
        assert.ok(h.bar.tooltip.includes('HTTPS KRX 조회 중'));
        h.state({ kind: 'live', message: 'HTTPS 5초 주기 조회' });
        assert.equal(h.bar.text, text);
        assert.ok(h.bar.tooltip.includes('HTTPS 5초 주기 조회'));
      }
      h.state({ kind: 'error', message: 'HTTPS 조회 실패' });
      assert.equal(h.bar.text, `${text} · HTTPS 조회 실패`);
      assert.ok(h.bar.tooltip.includes('HTTPS 조회 실패'));
      await h.run('disconnect');
      assert.ok(h.bar.text.includes('연결 안 됨'));
    } finally { h.dispose(); }
  }
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

const savedAccount = JSON.stringify({ cano: '12345678', productCode: '01' });
const accountSecrets = { [ACCOUNT_KEY]: savedAccount, 'kis.real.credentials.v1': 'synthetic-credentials' };
const sampleProfit = { purchase: 1000000n, valuation: 1123456n, amount: 123456n, receivedAt: 123 };

test('account registration persists once, keeps existing keys and settings, and is reused after activation', async () => {
  const h = environment({ stocks: threeStocks, displayMode: 'rotate', rotationInterval: 7 });
  let stored = '';
  try {
    h.secrets.set('kis.real.credentials.v1', 'synthetic-credentials');
    h.inputs.push('12345678', '01'); await h.run('registerAccount');
    stored = h.secrets.get(ACCOUNT_KEY)!; assert.equal(stored, savedAccount);
    assert.equal(h.configuration.showProfit, true); assert.equal(h.starts(), 0);
    await h.run('connect'); assert.deepEqual(h.profitMonitors.at(-1)?.account, JSON.parse(savedAccount));
    assert.equal(h.secrets.get('kis.real.credentials.v1'), 'synthetic-credentials');
    assert.deepEqual(h.configuration.stocks, threeStocks); assert.equal(h.configuration.displayMode, 'rotate'); assert.equal(h.configuration.rotationInterval, 7);
    assert.ok(!JSON.stringify(h.configuration).includes('12345678')); assert.ok(!h.logs.join().includes('12345678'));
  } finally { h.dispose(); }
  const restarted = environment({ showProfit: true }, { ...accountSecrets, [ACCOUNT_KEY]: stored });
  try { await restarted.run('connect'); assert.ok(restarted.profitMonitors.at(-1)); assert.equal(restarted.inputs.length, 0); }
  finally { restarted.dispose(); }
});

test('account registration cancellation, validation and storage failures preserve original registration', async () => {
  const h = environment({}, accountSecrets);
  try {
    for (const pair of [['87654321', undefined], ['invalid', '01'], ['87654321', 'bad']]) {
      h.inputs.push(...pair); await h.run('registerAccount'); assert.equal(h.secrets.get(ACCOUNT_KEY), savedAccount);
    }
    h.failStore(); h.inputs.push('87654321', '01'); await h.run('registerAccount');
    assert.equal(h.secrets.get(ACCOUNT_KEY), savedAccount); assert.ok(!h.notices.join().includes('synthetic-secret'));
  } finally { h.dispose(); }
});

test('both display modes keep profit text stable through polling, expose stale state and ignore old account responses', async () => {
  for (const displayMode of ['all', 'rotate']) {
    const h = environment({ stocks: threeStocks, showProfit: true, displayMode }, accountSecrets);
    try {
      await h.run('connect'); const monitor = h.profitMonitors.at(-1)!;
      monitor.received(sampleProfit); const text = h.bar.text;
      assert.match(text, /\[KRX\+NXT\] 평가손익 \+123,456원 \(\+12.35%\)/);
      h.state({ kind: 'connecting', message: 'HTTPS KRX 조회 중' }); assert.equal(h.bar.text, text);
      h.state({ kind: 'live', message: 'HTTPS 주기 조회' }); assert.equal(h.bar.text, text);
      monitor.status('손익 갱신 지연'); assert.ok(h.bar.text.includes('⚠')); assert.match(h.bar.tooltip, /손익 마지막 조회/); assert.match(h.bar.tooltip, /손익 갱신 지연/);
      await h.run('disconnect'); monitor.received(sampleProfit); monitor.status('late'); assert.ok(!h.bar.text.includes('123,456'));
      await h.run('connect'); h.profitMonitors.at(-1)!.received(sampleProfit);
      h.configuration.showProfit = false; h.change('showProfit'); await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(h.profitMonitors.at(-1), undefined); assert.ok(!h.bar.text.includes('평가손익'));
    } finally { h.dispose(); }
  }
});

test('missing or malformed accounts keep quote polling available and never create a balance monitor', async () => {
  for (const raw of [undefined, 'invalid-json', JSON.stringify({ cano: 'bad', productCode: '01' })]) {
    const h = environment({ showProfit: true });
    try {
      if (raw) h.secrets.set(ACCOUNT_KEY, raw);
      await h.run('connect'); assert.equal(h.profitMonitors.at(-1), undefined); assert.equal(h.starts(), 1);
      assert.match(h.bar.tooltip, /손익 계좌 등록/);
    } finally { h.dispose(); }
  }
});

test('account deletion and credential replacement clear profits while keeping the watchlist and original key contract', async () => {
  const h = environment({ stocks: threeStocks, showProfit: true }, accountSecrets);
  try {
    await h.run('connect'); h.profitMonitors.at(-1)!.received(sampleProfit);
    await h.run('removeAccount'); assert.equal(h.secrets.get(ACCOUNT_KEY), savedAccount);
    h.secretChanged('kis.real.credentials.v1'); await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(!h.bar.text.includes('123,456')); assert.equal(h.secrets.get(ACCOUNT_KEY), savedAccount);
    await h.run('connect'); h.profitMonitors.at(-1)!.received(sampleProfit);
    await h.run('demo'); assert.ok(!h.bar.text.includes('123,456')); assert.ok(h.bar.text.startsWith('[데모]'));
    h.confirmDeletion(); await h.run('removeAccount'); assert.equal(h.secrets.has(ACCOUNT_KEY), false);
    assert.equal(h.secrets.get('kis.real.credentials.v1'), 'synthetic-credentials'); assert.deepEqual(h.configuration.stocks, threeStocks);
  } finally { h.dispose(); }
});

test('disconnect during account storage read cancels pending connect and cannot restore profit polling', async () => {
  const h = environment({ showProfit: true }, accountSecrets);
  try {
    const resolve = h.deferAccountRead(); const connecting = h.run('connect');
    await h.run('disconnect'); resolve(savedAccount); await connecting;
    assert.equal(h.starts(), 0); assert.ok(!h.bar.text.includes('평가손익'));
  } finally { h.dispose(); }
});
