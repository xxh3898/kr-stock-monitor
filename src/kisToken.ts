import { createHash } from 'node:crypto';

export interface Credentials { appKey: string; appSecret: string }
export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}
export interface Session { credentials: Credentials; token: string }
export const TOKEN_KEY = 'kis.real.restToken.v1';
export const BASE_URL = 'https://openapi.koreainvestment.com:9443';
const ISSUE_INTERVAL = 300_000;
const EXPIRY_MARGIN = 60_000;
const MAX_TIMER_DELAY = 2_147_483_647;

export class KisError extends Error {
  constructor(readonly kind: 'transient' | 'auth' | 'cooldown' | 'fatal', message: string, readonly retryAfter = 0) { super(message); }
}

// Call only fixed KIS endpoints; never log request/response bodies or headers.
export async function requestJson(url: string, options: RequestInit, signal: AbortSignal, metadata?: { continuation?: string }): Promise<any> {
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
  } catch (error) {
    const code = (error as { cause?: { code?: string }; code?: string })?.cause?.code ?? (error as { code?: string })?.code;
    const tls = typeof code === 'string' && /CERT|TLS|SSL|ISSUER/.test(code);
    throw new KisError(tls ? 'fatal' : 'transient', tls ? 'HTTPS 인증서 검증 실패. 연결을 중단했습니다.' : 'HTTPS 서버 연결 실패');
  }
  let text = '';
  try {
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 1024 * 1024) { await reader.cancel(); throw new KisError('fatal', 'HTTPS 응답 크기 초과'); }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally { reader.releaseLock(); }
    }
  } catch (error) {
    if (error instanceof KisError) throw error;
    throw new KisError('transient', 'HTTPS 응답 수신 실패');
  }
  let data: any;
  try { data = JSON.parse(text); } catch { /* Classify non-JSON HTTP errors by status below. */ }
  const code = typeof data?.msg_cd === 'string' && /^EGW\d{5}$/.test(data.msg_cd) ? data.msg_cd : 'UNKNOWN';
  const retryHeader = response.headers.get('retry-after');
  const retrySeconds = retryHeader && /^\d+$/.test(retryHeader) ? Number(retryHeader) : undefined;
  const retryAfter = retrySeconds !== undefined ? retrySeconds * 1000 : retryHeader ? Math.max(0, Date.parse(retryHeader) - Date.now()) : 0;
  if (!Number.isFinite(retryAfter) || retryAfter > MAX_TIMER_DELAY) throw new KisError('fatal', '서버 재시도 대기시간 형식 오류');
  if (code === 'EGW00133') throw new KisError('transient', '접근토큰 발급 제한 (EGW00133)', Math.max(ISSUE_INTERVAL, retryAfter));
  if (response.status === 401 || code === 'EGW00123') throw new KisError('auth', '접근토큰 인증 오류');
  if (response.status === 429 || response.status >= 500 || code === 'EGW00201' || code === 'EGW00215') {
    throw new KisError('transient', `HTTPS 일시 오류 (HTTP ${response.status}, ${code})`,
      response.status === 429 || code === 'EGW00201' || code === 'EGW00215' ? Math.max(5000, retryAfter) : retryAfter);
  }
  if (!response.ok) throw new KisError('fatal', `HTTPS 요청 거절 (HTTP ${response.status}, ${code})`);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new KisError('fatal', 'HTTPS 응답 형식 오류');
  if (data.rt_cd !== undefined && data.rt_cd !== '0') throw new KisError('fatal', `시세 요청 거절 (${code})`);
  if (metadata) metadata.continuation = response.headers.get('tr_cont')?.trim() ?? '';
  return data;
}

interface Cache { fingerprint: string; nextAttemptAt: number; token?: string; expiresAt?: number }
function fingerprint(keys: Credentials): string {
  return createHash('sha256').update(JSON.stringify([keys.appKey, keys.appSecret])).digest('hex');
}

function parseExpiry(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return NaN;
  const expiry = Date.parse(`${value.replace(' ', 'T')}+09:00`);
  if (!Number.isFinite(expiry) || new Date(expiry + 9 * 3600_000).toISOString().slice(0, 19).replace('T', ' ') !== value) return NaN;
  return expiry;
}

export class KisTokenProvider {
  private generation = 0;
  private writes: Promise<void> = Promise.resolve();
  private pending?: { fingerprint: string; signal: AbortSignal; promise: Promise<Session> };

  constructor(private readonly credentials: () => Promise<Credentials | undefined>, private readonly secrets: SecretStore,
    private readonly request = requestJson, private readonly now = Date.now) {}

  private async read(key: string): Promise<Cache | undefined> {
    const raw = await this.secrets.get(TOKEN_KEY);
    if (!raw) return undefined;
    try {
      const cache = JSON.parse(raw) as Cache;
      if (cache?.fingerprint === key && Number.isSafeInteger(cache.nextAttemptAt) && cache.nextAttemptAt >= 0
        && cache.nextAttemptAt - this.now() <= MAX_TIMER_DELAY) return cache;
    } catch { /* Derived cache may be replaced; original credentials stay untouched. */ }
    return undefined;
  }

  private write(operation: () => Promise<void>): Promise<void> {
    const result = this.writes.then(operation);
    this.writes = result.catch(() => {});
    return result;
  }

  clear(): Promise<void> {
    this.generation++;
    this.pending = undefined;
    return this.write(async () => { await this.secrets.delete(TOKEN_KEY); });
  }

  async invalidate(token: string): Promise<void> {
    await this.write(async () => {
      const keys = await this.credentials();
      if (!keys) return;
      const cache = await this.read(fingerprint(keys));
      if (cache?.token === token) {
        delete cache.token; delete cache.expiresAt;
        await this.secrets.store(TOKEN_KEY, JSON.stringify(cache));
      }
    });
  }

  async get(signal: AbortSignal): Promise<Session | undefined> {
    await this.writes;
    signal.throwIfAborted();
    const keys = await this.credentials();
    signal.throwIfAborted();
    if (!keys) return undefined;
    const key = fingerprint(keys);
    if (this.pending?.fingerprint === key && !this.pending.signal.aborted) return this.pending.promise;
    const generation = this.generation;
    const current = async (): Promise<void> => {
      signal.throwIfAborted();
      const latest = await this.credentials();
      if (generation !== this.generation || !latest || fingerprint(latest) !== key) throw new Error('Credential generation changed');
      signal.throwIfAborted();
    };
    const issue = async (): Promise<Session> => {
      const cache = await this.read(key);
      await current();
      if (typeof cache?.token === 'string' && cache.token.length > 0 && cache.token.length <= 16_384
        && Number.isSafeInteger(cache.expiresAt) && cache.expiresAt! > this.now() + EXPIRY_MARGIN) {
        return { credentials: keys, token: cache.token };
      }
      if (cache && cache.nextAttemptAt > this.now()) throw new KisError('cooldown', '접근토큰 발급 대기', cache.nextAttemptAt - this.now());
      const started = this.now();
      const marker: Cache = { fingerprint: key, nextAttemptAt: started + ISSUE_INTERVAL };
      await this.write(async () => { await current(); await this.secrets.store(TOKEN_KEY, JSON.stringify(marker)); });
      await current();
      let data: any;
      try {
        data = await this.request(`${BASE_URL}/oauth2/tokenP`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ grant_type: 'client_credentials', appkey: keys.appKey, appsecret: keys.appSecret })
        }, signal);
      } catch (error) {
        if (error instanceof KisError && error.retryAfter > ISSUE_INTERVAL) {
          marker.nextAttemptAt = this.now() + error.retryAfter;
          await this.write(async () => { await current(); await this.secrets.store(TOKEN_KEY, JSON.stringify(marker)); });
        }
        throw error;
      }
      await current();
      const expiresAt = Math.min(parseExpiry(data.access_token_token_expired), started + Number(data.expires_in) * 1000);
      if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 16_384
        || data.token_type !== 'Bearer' || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0
        || !Number.isSafeInteger(expiresAt) || expiresAt <= this.now() + EXPIRY_MARGIN) {
        throw new KisError('fatal', '접근토큰 발급 응답 형식 또는 만료시간 오류');
      }
      await this.write(async () => {
        await current();
        await this.secrets.store(TOKEN_KEY, JSON.stringify({ ...marker, token: data.access_token, expiresAt }));
      });
      return { credentials: keys, token: data.access_token };
    };
    const promise = issue();
    this.pending = { fingerprint: key, signal, promise };
    try { return await promise; }
    finally { if (this.pending?.promise === promise) this.pending = undefined; }
  }
}
