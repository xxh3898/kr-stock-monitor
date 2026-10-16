import { parseQuote, Quote, Stock } from './quote';
import { BASE_URL, KisError, KisTokenProvider, requestJson, Session } from './kisToken';
import { Account, BalancePage, parseAccount, parseBalancePage, ProfitMonitor } from './profit';
export type { Credentials } from './kisToken';

export type State = { kind: 'idle' | 'keys' | 'connecting' | 'waiting' | 'live' | 'retry' | 'error'; message: string };
export interface Dependencies {
  session(signal: AbortSignal): Promise<Session | undefined>;
  invalidate(token: string): Promise<void>;
  request(stock: Stock, session: Session, signal: AbortSignal): Promise<Quote>;
  balance?(account: Account, session: Session, signal: AbortSignal, next?: { fk: string; nk: string }): Promise<BalancePage>;
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

export async function requestBalance(account: Account, session: Session, signal: AbortSignal, next?: { fk: string; nk: string }): Promise<BalancePage> {
  const valid = parseAccount(account);
  const url = new URL(`${BASE_URL}/uapi/domestic-stock/v1/trading/inquire-balance`);
  const params = { CANO: valid.cano, ACNT_PRDT_CD: valid.productCode, AFHR_FLPR_YN: 'Y', OFL_YN: '',
    INQR_DVSN: '01', UNPR_DVSN: '01', FUND_STTL_ICLD_YN: 'N', FNCG_AMT_AUTO_RDPT_YN: 'N', PRCS_DVSN: '00',
    CTX_AREA_FK100: next?.fk ?? '', CTX_AREA_NK100: next?.nk ?? '' };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const metadata: { continuation?: string } = {};
  const data = await requestJson(url.toString(), { method: 'GET', headers: {
    'content-type': 'application/json', authorization: `Bearer ${session.token}`, appkey: session.credentials.appKey,
    appsecret: session.credentials.appSecret, tr_id: 'TTTC8434R', custtype: 'P', tr_cont: next ? 'N' : ''
  } }, signal, metadata);
  try { return parseBalancePage(data, metadata.continuation ?? ''); }
  catch { throw new KisError('fatal', '잔고 응답 형식 또는 연속조회 정보 오류'); }
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
  private profit?: ProfitMonitor;
  private profitFailures = 0;
  private profitRetryAt = 0;
  private profitDisabled = false;

  constructor(private readonly state: (state: State) => void, private readonly quote: (quote: Quote) => void,
    private readonly deps: Dependencies) {}

  start(stocks: Stock[], interval = 5, profit?: ProfitMonitor): void {
    this.stop();
    if (!stocks.length && !profit) { this.state({ kind: 'idle', message: '관심 종목을 추가하세요' }); return; }
    this.stocks = stocks;
    this.profit = profit;
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
    this.profit = undefined; this.profitFailures = 0; this.profitRetryAt = 0; this.profitDisabled = false;
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
        if (!await this.pace(generation)) return;
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
      if (!await this.pollProfit(generation, session, signal) || !this.active(generation)) return;
      this.failures = 0; this.recoveringAuth = false;
      this.state({ kind: 'live', message: `HTTPS ${this.interval / 1000}초 주기 조회` });
      this.schedule(generation, Math.max(0, this.cycleStarted + this.interval - this.deps.now()), 'poll');
    } catch (error) { this.fail(generation, error); }
  }

  private async pace(generation: number): Promise<boolean> {
    if (!await this.pause(generation, this.lastRequestAt + 1000 - this.deps.now()) || !this.active(generation)) return false;
    this.lastRequestAt = this.deps.now();
    return true;
  }

  private async pollProfit(generation: number, session: Session, signal: AbortSignal): Promise<boolean> {
    const monitor = this.profit;
    if (!monitor || this.profitDisabled || this.deps.now() < this.profitRetryAt) return true;
    try {
      let next: { fk: string; nk: string } | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 20; page++) {
        if (!await this.pace(generation)) return false;
        if (!this.deps.balance) throw new KisError('fatal', '잔고 조회 처리 오류');
        const result = await this.deps.balance(monitor.account, session, signal, next);
        if (!this.active(generation)) return false;
        if (!result.next) {
          this.profitFailures = 0; this.profitRetryAt = 0;
          monitor.received(result.profit); monitor.status(''); return true;
        }
        const cursor = JSON.stringify(result.next);
        if (seen.has(cursor)) throw new KisError('fatal', '잔고 연속조회 커서 반복');
        seen.add(cursor); next = result.next;
      }
      throw new KisError('fatal', '잔고 연속조회 상한 초과 · 전체 결과 미확인');
    } catch (error) {
      if (!this.active(generation)) return false;
      const failure = error instanceof KisError ? error : new KisError('fatal', '잔고 조회 처리 오류');
      if (failure.kind === 'auth' && !this.recoveringAuth) {
        this.recoveringAuth = true;
        monitor.status('손익 인증 재확인 중');
        await this.deps.invalidate(session.token);
        if (!this.active(generation)) return false;
        this.schedule(generation, 1000, 'retry'); return false;
      }
      if (failure.kind === 'transient' && this.profitFailures++ < 5) {
        const delay = Math.max(Math.min(60, 5 * 2 ** (this.profitFailures - 1)) * 1000, failure.retryAfter);
        this.profitRetryAt = this.deps.now() + delay;
        monitor.status(`손익 갱신 지연 · ${failure.message}`);
        if (failure.retryAfter > 0) { this.fail(generation, failure, '손익 · '); return false; }
      } else {
        this.profitDisabled = true;
        monitor.status(`손익 조회 중단 · ${failure.message}`);
        if (!this.stocks.length) {
          this.running = false;
          this.state({ kind: 'error', message: `손익 조회 중단 · ${failure.message}` });
        }
      }
      return true;
    }
  }
}

export function createClient(state: (state: State) => void, quote: (quote: Quote) => void, tokens: KisTokenProvider): KisClient {
  return new KisClient(state, quote, {
    session: signal => tokens.get(signal), invalidate: token => tokens.invalidate(token), request: requestQuote, balance: requestBalance,
    schedule: (callback, delay) => setTimeout(callback, delay),
    cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), now: Date.now
  });
}
