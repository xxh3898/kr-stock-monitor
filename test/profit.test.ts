import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatProfit, parseAccount, parseBalancePage } from '../src/profit';

const balance = () => ({ rt_cd: '0', output1: [], output2: [{ pchs_amt_smtl_amt: '1000000', evlu_amt_smtl_amt: '1123456', evlu_pfls_smtl_amt: '123456' }], ctx_area_fk100: '', ctx_area_nk100: '' });

test('balance summary uses aggregate profit and purchase amounts; rates round without floating point loss', () => {
  const value = parseBalancePage(balance(), 'D', 123).profit;
  assert.equal(value.receivedAt, 123); assert.equal(formatProfit(value), '평가손익 +123,456원 (+12.35%)');
  assert.equal(formatProfit({ ...value, amount: -123456n }), '평가손익 -123,456원 (-12.35%)');
  assert.equal(formatProfit({ ...value, amount: 0n }), '평가손익 0원 (0.00%)');
  assert.equal(formatProfit({ ...value, purchase: 0n, amount: 0n }), '평가손익 0원 (—)');
  assert.equal(formatProfit({ ...value, amount: -1n }), '평가손익 -1원 (0.00%)');
  const large = balance(); large.output2[0] = { pchs_amt_smtl_amt: '9999999999999999999', evlu_amt_smtl_amt: '9999999999999999999', evlu_pfls_smtl_amt: '-9007199254740993' };
  assert.equal(parseBalancePage(large, 'E').profit.amount, -9007199254740993n);
  assert.match(formatProfit(parseBalancePage(large, 'E').profit), /-9,007,199,254,740,993원/);
});

test('continuation accepts F and M with cursors, D and E end the account snapshot', () => {
  for (const flag of ['F', 'M']) {
    assert.deepEqual(parseBalancePage({ ...balance(), ctx_area_fk100: ' fk ', ctx_area_nk100: ' nk ' }, flag).next, { fk: 'fk', nk: 'nk' });
    assert.throws(() => parseBalancePage(balance(), flag));
  }
  for (const flag of ['D', 'E']) assert.equal(parseBalancePage(balance(), flag).next, undefined);
});

test('rejects malformed summaries, business failures, unbounded amounts and missing pagination metadata', () => {
  for (const data of [null, {}, { ...balance(), rt_cd: '1' }, { ...balance(), output1: {} }, { ...balance(), output2: [] },
    { ...balance(), output2: [...balance().output2, ...balance().output2] }, { ...balance(), ctx_area_fk100: undefined }]) {
    assert.throws(() => parseBalancePage(data, 'D'));
  }
  for (const field of ['pchs_amt_smtl_amt', 'evlu_amt_smtl_amt', 'evlu_pfls_smtl_amt']) {
    for (const invalid of ['', 'NaN', '1.2', '1e3', '10000000000000000000', 12, null]) {
      const data: any = balance(); data.output2[0][field] = invalid; assert.throws(() => parseBalancePage(data, 'D'));
    }
  }
  const data = balance(); data.output2[0].pchs_amt_smtl_amt = '-1'; assert.throws(() => parseBalancePage(data, 'D'));
  for (const flag of ['', 'N', 'unknown']) assert.throws(() => parseBalancePage(balance(), flag));
});

test('account registration accepts only the eight and two digit identifiers', () => {
  assert.deepEqual(parseAccount({ cano: '12345678', productCode: '01' }), { cano: '12345678', productCode: '01' });
  for (const value of [null, {}, { cano: '12345678', productCode: '1' }, { cano: '12345678-01', productCode: '01' }]) assert.throws(() => parseAccount(value));
});
