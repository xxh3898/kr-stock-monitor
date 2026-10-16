export const ACCOUNT_KEY = 'kis.real.account.v1';
export interface Account { cano: string; productCode: string }
export interface Profit { purchase: bigint; valuation: bigint; amount: bigint; receivedAt: number }
export interface BalancePage { profit: Profit; next?: { fk: string; nk: string } }
export interface ProfitMonitor { account: Account; received(value: Profit): void; status(message: string): void }

export function parseAccount(value: unknown): Account {
  const account = value as Partial<Account> | null;
  if (typeof account?.cano !== 'string' || !/^\d{8}$/.test(account.cano)
    || typeof account.productCode !== 'string' || !/^\d{2}$/.test(account.productCode)) throw new Error('계좌 등록 정보를 확인하세요.');
  return { cano: account.cano, productCode: account.productCode };
}

function money(value: unknown, signed = false): bigint {
  if (typeof value !== 'string' || !(signed ? /^-?\d{1,19}$/ : /^\d{1,19}$/).test(value)) throw new Error('Invalid amount');
  return BigInt(value);
}

export function parseBalancePage(data: any, continuation: string, receivedAt = Date.now()): BalancePage {
  if (data?.rt_cd !== '0' || !Array.isArray(data.output1) || !Array.isArray(data.output2) || data.output2.length !== 1
    || !['F', 'M', 'D', 'E'].includes(continuation)) throw new Error('Invalid balance response');
  const row = data.output2[0];
  const profit: Profit = { purchase: money(row?.pchs_amt_smtl_amt), valuation: money(row?.evlu_amt_smtl_amt),
    amount: money(row?.evlu_pfls_smtl_amt, true), receivedAt };
  if (typeof data.ctx_area_fk100 !== 'string' || data.ctx_area_fk100.length > 100
    || typeof data.ctx_area_nk100 !== 'string' || data.ctx_area_nk100.length > 100) throw new Error('Invalid balance cursor');
  if (continuation === 'D' || continuation === 'E') return { profit };
  const next = { fk: data.ctx_area_fk100.trim(), nk: data.ctx_area_nk100.trim() };
  if (!next.fk && !next.nk) throw new Error('Missing balance cursor');
  return { profit, next };
}

export function formatProfit(value: Profit): string {
  let rate = '—';
  if (value.purchase > 0n) {
    const absolute = value.amount < 0n ? -value.amount : value.amount;
    const hundredths = (absolute * 10_000n + value.purchase / 2n) / value.purchase;
    rate = `${hundredths === 0n ? '' : value.amount < 0n ? '-' : '+'}${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}%`;
  }
  return `평가손익 ${value.amount > 0n ? '+' : ''}${value.amount.toLocaleString('en-US')}원 (${rate})`;
}
