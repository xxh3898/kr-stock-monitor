import WebSocket from 'ws';
import { parseFrame, Quote, Stock } from './quote';

export interface Credentials { appKey: string; appSecret: string }
export type State = { kind: 'idle' | 'keys' | 'connecting' | 'subscribing' | 'waiting' | 'live' | 'retry' | 'error'; message: string };
export interface Socket {
  readyState: number;
  on(event: string, listener: (...args: any[]) => void): unknown;
  send(data: string, callback?: (error?: Error) => void): void;
  pong(data: string): void;
  close(): void;
  terminate(): void;
}
export interface Dependencies {
  credentials(): Promise<Credentials | undefined>;
  approval(credentials: Credentials, signal: AbortSignal): Promise<string>;
  socket(): Socket;
  schedule(callback: () => void, delay: number): unknown;
  cancel(handle: unknown): void;
}

class ApprovalError extends Error {
  constructor(readonly retryable: boolean, message: string) { super(message); }
}

export async function requestApproval(credentials: Credentials, signal: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetch('https://openapi.koreainvestment.com:9443/oauth2/Approval', {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', appkey: credentials.appKey, secretkey: credentials.appSecret }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    });
  } catch {
    throw new ApprovalError(true, '접속키 발급 서버 연결 실패');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ApprovalError(false, `접속키 발급 실패 (HTTP ${response.status}). 키·이용 권한을 확인한 뒤 다시 연결하세요.`);
  }
  let data: unknown;
  try { data = await response.json(); } catch { throw new ApprovalError(false, '접속키 발급 응답 형식 오류'); }
  const key = (data as { approval_key?: unknown } | null)?.approval_key;
  if (typeof key !== 'string' || !key || key.length > 4096) throw new ApprovalError(false, '접속키 발급 응답에 키가 없습니다.');
  return key;
}

export class KisClient {
  private generation = 0;
  private running = false;
  private transport?: Socket;
  private abort?: AbortController;
  private retryTimer?: unknown;
  private subscribeTimer?: unknown;
  private activityTimer?: unknown;
  private retryAttempt = 0;
  private approvalKey?: string;
  private stocks: Stock[] = [];
  private accepted = new Set<string>();
  private pending?: string;
  private nextIndex = 0;

  constructor(private readonly state: (state: State) => void, private readonly quote: (quote: Quote) => void,
    private readonly deps: Dependencies) {}

  start(stocks: Stock[]): void {
    this.stop();
    if (!stocks.length) { this.state({ kind: 'idle', message: '관심 종목을 추가하세요' }); return; }
    this.stocks = stocks;
    this.running = true;
    void this.connect(this.generation);
  }

  stop(): void {
    this.running = false;
    this.generation++;
    this.abort?.abort();
    this.clearTimers();
    const socket = this.transport;
    this.transport = undefined;
    if (socket?.readyState === WebSocket.OPEN) {
      for (const code of this.accepted) {
        try { socket.send(this.subscription(code, '2')); } catch { /* Closing releases the subscriptions. */ }
      }
      socket.close();
    } else { socket?.terminate(); }
    this.approvalKey = undefined;
    this.accepted.clear();
    this.pending = undefined;
    this.retryAttempt = 0;
    this.state({ kind: 'idle', message: '연결 안 됨' });
  }

  private active(generation: number): boolean { return this.running && this.generation === generation; }

  private clearTimers(): void {
    for (const timer of [this.retryTimer, this.subscribeTimer, this.activityTimer]) {
      if (timer !== undefined) this.deps.cancel(timer);
    }
    this.retryTimer = this.subscribeTimer = this.activityTimer = undefined;
  }

  private subscription(code: string, type: '1' | '2'): string {
    return JSON.stringify({ header: { approval_key: this.approvalKey, custtype: 'P', tr_type: type, 'content-type': 'utf-8' },
      body: { input: { tr_id: 'H0STCNT0', tr_key: code } } });
  }

  private async connect(generation: number): Promise<void> {
    this.state({ kind: 'connecting', message: '실전 KRX 연결 중' });
    this.abort = new AbortController();
    try {
      if (!this.approvalKey) {
        const credentials = await this.deps.credentials();
        if (!this.active(generation)) return;
        if (!credentials) {
          this.running = false;
          this.state({ kind: 'keys', message: '실전 API 키 등록 필요' });
          return;
        }
        const key = await this.deps.approval(credentials, this.abort.signal);
        if (!this.active(generation)) return;
        this.approvalKey = key;
      }
      const socket = this.deps.socket();
      this.transport = socket;
      let failed = false;
      let receivedQuote = false;
      const fail = (message: string, retryable: boolean): void => {
        if (failed || !this.active(generation) || this.transport !== socket) return;
        failed = true;
        this.failure(generation, message, retryable);
      };
      const touch = (): void => {
        if (this.activityTimer !== undefined) this.deps.cancel(this.activityTimer);
        // Detect silent disconnects from all transport activity, not from absent trades.
        this.activityTimer = this.deps.schedule(() => fail('연결 응답 없음', true), 90_000);
      };
      const sendNext = (): void => {
        if (!this.active(generation) || this.transport !== socket || failed) return;
        const stock = this.stocks[this.nextIndex++];
        if (!stock) {
          if (!receivedQuote) this.state({ kind: 'waiting', message: `KRX 구독 ${this.accepted.size}종목 · 체결 대기` });
          return;
        }
        this.pending = stock.code;
        this.state({ kind: 'subscribing', message: `KRX 구독 승인 대기 ${stock.code}` });
        this.subscribeTimer = this.deps.schedule(() => fail('종목 구독 승인 시간 초과', true), 10_000);
        try { socket.send(this.subscription(stock.code, '1'), error => { if (error) fail('구독 전송 실패', true); }); }
        catch { fail('구독 전송 실패', true); }
      };
      socket.on('open', () => {
        if (!this.active(generation) || this.transport !== socket) return;
        this.accepted.clear(); this.pending = undefined; this.nextIndex = 0;
        touch(); sendNext();
      });
      socket.on('message', (data: { toString(): string }) => {
        if (!this.active(generation) || this.transport !== socket || failed) return;
        try {
          touch();
          const raw = data.toString();
          const frame = parseFrame(raw);
          if (frame.type === 'ping') { socket.pong(raw); }
          else if (frame.type === 'rejected') { fail(`KRX 구독 거절 (${frame.errorCode}). 키·종목·동시 접속을 확인하세요.`, false); }
          else if (frame.type === 'ack' && frame.code === this.pending) {
            if (this.subscribeTimer !== undefined) this.deps.cancel(this.subscribeTimer);
            this.accepted.add(frame.code); this.pending = undefined;
            this.subscribeTimer = this.deps.schedule(sendNext, 100);
          } else if (frame.type === 'quotes') {
            for (const quote of frame.quotes) {
              if (this.accepted.has(quote.code)) {
                this.retryAttempt = 0;
                receivedQuote = true;
                this.quote(quote);
                this.state({ kind: 'live', message: 'KRX 체결 수신 중' });
              }
            }
          }
        } catch { fail('KRX 응답 형식 오류. 연결 로그를 확인하세요.', false); }
      });
      socket.on('pong', () => { if (this.active(generation) && this.transport === socket && !failed) touch(); });
      socket.on('error', () => fail('시세 서버 연결 오류', true));
      socket.on('close', () => fail('시세 서버 연결 종료', true));
    } catch (error) {
      if (!this.active(generation)) return;
      this.failure(generation, error instanceof ApprovalError ? error.message : '키 저장소 또는 연결 초기화 오류',
        error instanceof ApprovalError && error.retryable);
    }
  }

  private failure(generation: number, message: string, retryable: boolean): void {
    this.clearTimers();
    const socket = this.transport;
    this.transport = undefined;
    socket?.terminate();
    this.accepted.clear(); this.pending = undefined;
    if (!retryable) {
      this.running = false;
      this.approvalKey = undefined;
      this.state({ kind: 'error', message });
      return;
    }
    const delay = Math.min(30, 2 ** Math.min(this.retryAttempt++, 5)) * 1000;
    this.state({ kind: 'retry', message: `${message} · ${delay / 1000}초 후 재연결` });
    this.retryTimer = this.deps.schedule(() => {
      this.retryTimer = undefined;
      if (this.active(generation)) void this.connect(generation);
    }, delay);
  }
}

export function createClient(credentials: Dependencies['credentials'], state: (state: State) => void,
  quote: (quote: Quote) => void): KisClient {
  return new KisClient(state, quote, {
    credentials, approval: requestApproval,
    socket: () => new WebSocket('ws://ops.koreainvestment.com:21000/tryitout', { handshakeTimeout: 10_000, maxPayload: 1024 * 1024 }),
    schedule: (callback, delay) => setTimeout(callback, delay),
    cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
  });
}
