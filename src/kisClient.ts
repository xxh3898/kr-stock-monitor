import { parseQuote, Quote, Stock } from './quote';
import { BASE_URL, KisError, KisTokenProvider, requestJson, Session } from './kisToken';
export type { Credentials } from './kisToken';

export type State = { kind: 'idle' | 'keys' | 'connecting' | 'waiting' | 'live' | 'retry' | 'error'; message: string };
export interface Dependencies {
  session(signal: AbortSignal): Promise<Session | undefined>;
  invalidate(token: string): Promise<void>;
  request(stock: Stock, session: Session, signal: AbortSignal): Promise<Quote>;
  schedule(callback: () => void, delay: number): unknown;
  cancel(handle: unknown): void;
  now(): number;
}

export async function requestQuote(stock: Stock, session: Session, signal: AbortSignal): Promise<Quote> {
  if (!/^\d{6}$/.test(stock.code)) throw new KisError('fatal', '종목 코드 형식 오류');
  const url = new URL(`${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-price`);
  url.searchParams.set('FID_COND_MRKT_DIV_CODE', 'J');
  url.searchParams.set('FID_INPUT_ISCD', stock.code);
  const data = await requestJson(url.toString(), { method: 'GET', headers: {
    'content-type': 'application/json', authorization: `Bearer ${session.token}`,
    appkey: session.credentials.appKey, appsecret: session.credentials.appSecret, tr_id: 'FHKST01010100', custtype: 'P'
  } }, signal);
  try { return parseQuote(data, stock.code); }
  catch { throw new KisError('fatal', '현재가 응답 형식 오류'); }
}

export class KisClient {
  private generation = 0;
  private running = false;
  private abort?: AbortController;
  private timer?: unknown;
  private wait?: { handle: unknown; resolve(value: boolean): void };
  private nextKind?: 'poll' | 'retry';
  private interval = 5000;
  private cycleStarted = 0;
  private lastRequestAt = -Infinity;
  private failures = 0;
  private recoveringAuth = false;
  private stocks: Stock[] = [];

  constructor(private readonly state: (state: State) => void, private readonly quote: (quote: Quote) => void,
    private readonly deps: Dependencies) {}

  start(stocks: Stock[], interval = 5): void {
    this.stop();
    if (!stocks.length) { this.state({ kind: 'idle', message: '관심 종목을 추가하세요' }); return; }
    this.stocks = stocks;
    this.interval = interval * 1000;
    this.running = true;
    this.abort = new AbortController();
    void this.cycle(this.generation);
  }

  updateInterval(seconds: number): void {
    this.interval = seconds * 1000;
    if (this.running && this.nextKind === 'poll') {
      if (this.timer !== undefined) this.deps.cancel(this.timer);
      this.schedule(this.generation, Math.max(0, this.cycleStarted + this.interval - this.deps.now()), 'poll');
      this.state({ kind: 'live', message: `HTTPS ${seconds}초 주기 조회` });
    }
  }

  stop(): void {
    this.running = false;
    this.generation++;
    this.abort?.abort(); this.abort = undefined;
    if (this.timer !== undefined) this.deps.cancel(this.timer);
    this.timer = this.nextKind = undefined;
    if (this.wait) { this.deps.cancel(this.wait.handle); this.wait.resolve(false); this.wait = undefined; }
    this.failures = 0; this.recoveringAuth = false;
    this.state({ kind: 'idle', message: '연결 안 됨' });
  }

  private active(generation: number): boolean { return this.running && generation === this.generation; }

  private schedule(generation: number, delay: number, kind: 'poll' | 'retry'): void {
    this.nextKind = kind;
    this.timer = this.deps.schedule(() => {
      this.timer = this.nextKind = undefined;
      if (this.active(generation)) void this.cycle(generation);
    }, delay);
  }

  private pause(generation: number, delay: number): Promise<boolean> {
    if (delay <= 0) return Promise.resolve(this.active(generation));
    return new Promise(resolve => {
      const handle = this.deps.schedule(() => { this.wait = undefined; resolve(this.active(generation)); }, delay);
      this.wait = { handle, resolve };
    });
  }

  private fail(generation: number, error: unknown, prefix = ''): void {
    if (!this.active(generation)) return;
    const failure = error instanceof KisError ? error : new KisError('fatal', '보안 저장소 또는 조회 처리 오류');
    if (failure.kind === 'cooldown') {
      this.state({ kind: 'waiting', message: `인증 대기 · ${Math.ceil(failure.retryAfter / 1000)}초 후 확인` });
      this.schedule(generation, failure.retryAfter, 'retry');
    } else if (failure.kind === 'transient' && this.failures++ < 5) {
      const delay = Math.max(Math.min(60, 5 * 2 ** (this.failures - 1)) * 1000, failure.retryAfter);
      this.state({ kind: 'retry', message: `${prefix}${failure.message} · ${Math.ceil(delay / 1000)}초 후 재조회` });
      this.schedule(generation, delay, 'retry');
    } else {
      this.running = false;
      this.abort?.abort();
      this.state({ kind: 'error', message: `${prefix}${failure.message} · 조회 중단. 연결 명령으로 다시 시작하세요.` });
    }
  }

  private async cycle(generation: number): Promise<void> {
    if (!this.active(generation)) return;
    this.cycleStarted = this.deps.now();
    const signal = this.abort!.signal;
    this.state({ kind: 'connecting', message: 'HTTPS KRX 조회 중' });
    try {
      const session = await this.deps.session(signal);
      if (!this.active(generation)) return;
      if (!session) { this.running = false; this.state({ kind: 'keys', message: '실전 API 키 등록 필요' }); return; }
      let failure: { error: KisError; code: string } | undefined;
      for (const stock of this.stocks) {
        if (!await this.pause(generation, this.lastRequestAt + 1000 - this.deps.now()) || !this.active(generation)) return;
        this.lastRequestAt = this.deps.now();
        try {
          const quote = await this.deps.request(stock, session, signal);
          if (!this.active(generation)) return;
          this.quote(quote);
        } catch (error) {
          if (!this.active(generation)) return;
          if (error instanceof KisError && error.kind === 'auth' && !this.recoveringAuth) {
            this.recoveringAuth = true;
            await this.deps.invalidate(session.token);
            if (!this.active(generation)) return;
            this.state({ kind: 'waiting', message: '접근토큰 재인증 대기' });
            this.schedule(generation, 1000, 'retry'); return;
          }
          if (!(error instanceof KisError) || error.kind !== 'transient') { this.fail(generation, error, `${stock.code} · `); return; }
          failure = { error, code: stock.code };
          if (error.retryAfter > 0) break;
        }
      }
      if (failure) { this.fail(generation, failure.error, `부분 조회 실패 ${failure.code} · `); return; }
      this.failures = 0; this.recoveringAuth = false;
      this.state({ kind: 'live', message: `HTTPS ${this.interval / 1000}초 주기 조회` });
      this.schedule(generation, Math.max(0, this.cycleStarted + this.interval - this.deps.now()), 'poll');
    } catch (error) { this.fail(generation, error); }
  }
}

export function createClient(state: (state: State) => void, quote: (quote: Quote) => void, tokens: KisTokenProvider): KisClient {
  return new KisClient(state, quote, {
    session: signal => tokens.get(signal), invalidate: token => tokens.invalidate(token), request: requestQuote,
    schedule: (callback, delay) => setTimeout(callback, delay),
    cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), now: Date.now
  });
}
