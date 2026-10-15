export interface Stock { code: string; name: string }
export interface Quote {
  code: string;
  price: number;
  changeRate: number;
  tradeTime: string;
  tradeDate: string;
  receivedAt: number;
}

export type Frame =
  | { type: 'quotes'; quotes: Quote[] }
  | { type: 'ping' }
  | { type: 'ack'; code: string }
  | { type: 'rejected'; errorCode: string }
  | { type: 'ignored' };

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

export function parseFrame(raw: string, receivedAt = Date.now()): Frame {
  if (raw.startsWith('{')) {
    const data = JSON.parse(raw);
    if (data.header?.tr_id === 'PINGPONG') return { type: 'ping' };
    if (data.header?.tr_id !== 'H0STCNT0') return { type: 'ignored' };
    if (data.body?.rt_cd !== '0') {
      const code = data.body?.msg_cd;
      return { type: 'rejected', errorCode: typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'UNKNOWN' };
    }
    if (!/^\d{6}$/.test(data.header?.tr_key ?? '')) throw new Error('Invalid acknowledgement');
    return { type: 'ack', code: data.header.tr_key };
  }
  const parts = raw.split('|');
  if (parts[1] !== 'H0STCNT0') return { type: 'ignored' };
  if (parts.length !== 4 || parts[0] !== '0' || !/^\d{1,4}$/.test(parts[2])) throw new Error('Invalid frame');
  const count = Number(parts[2]);
  const values = parts[3].split('^');
  const width = values.length / count;
  // Official KRX schemas have 46 fields, or 47 with MARKET_CLS_CODE appended.
  if (!count || (width !== 46 && width !== 47)) throw new Error('Unsupported KRX field count');
  const quotes: Quote[] = [];
  for (let row = 0; row < count; row++) {
    const fields = values.slice(row * width, (row + 1) * width);
    const [code, time, price, sign, , rate] = fields;
    const date = fields[33];
    if (!/^\d{6}$/.test(code) || !/^([01]\d|2[0-3])[0-5]\d[0-5]\d$/.test(time)
      || !/^\d{8}$/.test(date) || !/^\d+$/.test(price) || !/^[1-5]$/.test(sign)
      || !/^[+-]?\d+(\.\d+)?$/.test(rate)) throw new Error('Invalid quote');
    const amount = Number(price);
    const absoluteRate = Math.abs(Number(rate));
    if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isFinite(absoluteRate)
      || (sign === '3' && absoluteRate !== 0)) throw new Error('Invalid quote number');
    quotes.push({ code, price: amount, changeRate: sign === '4' || sign === '5' ? -absoluteRate : absoluteRate,
      tradeTime: `${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4)}`, tradeDate: date, receivedAt });
  }
  return { type: 'quotes', quotes };
}

export function formatQuote(quote: Quote): string {
  return `${quote.price.toLocaleString('ko-KR')}원 (${quote.changeRate > 0 ? '+' : ''}${quote.changeRate.toFixed(2)}%)`;
}
