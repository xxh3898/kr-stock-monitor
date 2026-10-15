import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatQuote, parseQuote, validateStocks } from '../src/quote';
import { quoteResponse } from './fixtures';

test('REST quotes use the requested symbol and signed rates without inventing trade times', () => {
  for (const [sign, rate] of [['1', 1.25], ['2', 1.25], ['3', 0], ['4', -1.25], ['5', -1.25]] as const) {
    const quote = parseQuote(quoteResponse('204320', sign, String(Math.abs(rate))), '204320', 123);
    assert.deepEqual(quote, { code: '204320', price: 45000, changeRate: rate, receivedAt: 123 });
  }
  assert.equal(formatQuote(parseQuote(quoteResponse(), '204320')), '45,000원 (+1.25%)');
});

test('rejects business errors, wrong symbols, missing and invalid REST fields', () => {
  for (const data of [null, [], {}, { ...quoteResponse(), rt_cd: '1' }, quoteResponse('000990'),
    { rt_cd: '0', output: {} }, ...[
      { stck_prpr: '0' }, { stck_prpr: '-1' }, { stck_prpr: '9007199254740992' }, { stck_prpr: 'NaN' },
      { stck_prpr: 45000 }, { prdy_vrss_sign: '9' }, { prdy_ctrt: 'Infinity' }, { prdy_ctrt: '' },
      { prdy_vrss_sign: '3', prdy_ctrt: '1' }
    ].map(fields => ({ rt_cd: '0', output: { ...quoteResponse().output, ...fields } }))]) {
    assert.throws(() => parseQuote(data, '204320'));
  }
});

test('validates settings at the boundary and rejects duplicate codes', () => {
  assert.deepEqual(validateStocks([{ code: '204320', name: ' HL만도 ' }]), [{ code: '204320', name: 'HL만도' }]);
  for (const input of [null, {}, [null], [{ code: '123', name: 'name' }], [{ code: '204320', name: '' }],
    [{ code: '204320', name: 'line\nbreak' }], [{ code: '204320', name: 'a' }, { code: '204320', name: 'b' }]]) {
    assert.throws(() => validateStocks(input));
  }
});
