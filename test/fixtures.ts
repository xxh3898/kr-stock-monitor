export function quoteRow(code = '204320', sign = '2', rate = '1.25', width = 47): string {
  const fields = Array<string>(width).fill('0');
  fields[0] = code; fields[1] = '101530'; fields[2] = '45000'; fields[3] = sign;
  fields[4] = '550'; fields[5] = rate; fields[33] = '20261015';
  return fields.join('^');
}

export function ack(code = '204320', result = '0'): string {
  return JSON.stringify({ header: { tr_id: 'H0STCNT0', tr_key: code }, body: { rt_cd: result, msg_cd: 'OK', msg1: 'synthetic message' } });
}

export async function settle(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }
