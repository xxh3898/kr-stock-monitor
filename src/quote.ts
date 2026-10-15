export interface Stock { code: string; name: string }
export interface Quote {
  code: string;
  price: number;
  changeRate: number;
  receivedAt: number;
}

export function validateStocks(value: unknown): Stock[] {
  if (!Array.isArray(value)) throw new Error('관심 종목 설정은 배열이어야 합니다.');
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    const stock = item as Partial<Stock> | null;
    if (!stock || typeof stock.code !== 'string' || !/^\d{6}$/.test(stock.code)
      || typeof stock.name !== 'string' || !stock.name.trim() || stock.name.trim().length > 40
      || /[\r\n\t]/.test(stock.name)) {
      throw new Error('종목 코드 6자리와 1~40자 이름을 확인하세요.');
    }
    if (seen.has(stock.code)) throw new Error('관심 종목 코드가 중복됐습니다.');
    seen.add(stock.code);
    return { code: stock.code, name: stock.name.trim() };
  });
}

export function parseQuote(data: unknown, code: string, receivedAt = Date.now()): Quote {
  const result = data as { rt_cd?: unknown; output?: Record<string, unknown> } | null;
  const fields = result?.output;
  const price = fields?.stck_prpr;
  const sign = fields?.prdy_vrss_sign;
  const rate = fields?.prdy_ctrt;
  if (result?.rt_cd !== '0' || fields?.stck_shrn_iscd !== code || !/^\d{6}$/.test(code)
    || typeof price !== 'string' || !/^\d+$/.test(price) || typeof sign !== 'string' || !/^[1-5]$/.test(sign)
    || typeof rate !== 'string' || !/^[+-]?\d+(\.\d+)?$/.test(rate)) throw new Error('Invalid quote');
  const amount = Number(price);
  const absoluteRate = Math.abs(Number(rate));
  if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isFinite(absoluteRate)
    || (sign === '3' && absoluteRate !== 0)) throw new Error('Invalid quote number');
  return { code, price: amount, changeRate: sign === '4' || sign === '5' ? -absoluteRate : absoluteRate, receivedAt };
}

export function formatQuote(quote: Quote): string {
  return `${quote.price.toLocaleString('ko-KR')}원 (${quote.changeRate > 0 ? '+' : ''}${quote.changeRate.toFixed(2)}%)`;
}
