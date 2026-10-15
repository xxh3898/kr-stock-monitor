import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatQuote, parseFrame, validateStocks } from '../src/quote';
import { ack, quoteRow } from './fixtures';

test('parses batched KRX records and signed rates in both known schemas', () => {
  for (const width of [46, 47]) {
    const result = parseFrame(`0|H0STCNT0|002|${quoteRow('204320', '2', '1.25', width)}^${quoteRow('000990', '5', '2.50', width)}`, 123);
    assert.equal(result.type, 'quotes');
    if (result.type !== 'quotes') return;
    assert.equal(result.quotes.length, 2);
    assert.equal(result.quotes[1].changeRate, -2.5);
    assert.equal(result.quotes[0].tradeTime, '10:15:30');
    assert.equal(result.quotes[0].tradeDate, '20261015');
    assert.equal(result.quotes[0].receivedAt, 123);
    assert.equal(formatQuote(result.quotes[0]), '45,000원 (+1.25%)');
  }
});

test('rejects truncated, encrypted, invalid and unsupported KRX data', () => {
  for (const frame of [
    `0|H0STCNT0|2|${quoteRow()}`, `1|H0STCNT0|1|${quoteRow()}`,
    `0|H0STCNT0|0|${quoteRow()}`, `0|H0STCNT0|1|${quoteRow('204320', '9')}`,
    `0|H0STCNT0|1|${quoteRow('204320', '3', '1')}`, `0|H0STCNT0|1|${quoteRow().replace('45000', 'NaN')}`,
    `0|H0STCNT0|1|${quoteRow().replace('101530', '291530')}`, `0|H0STCNT0|1|${quoteRow('204320', '2', '1', 48)}`
  ]) assert.throws(() => parseFrame(frame));
});

test('distinguishes subscription confirmation, rejection, heartbeat and unrelated data', () => {
  assert.deepEqual(parseFrame(ack()), { type: 'ack', code: '204320' });
  assert.equal(parseFrame(ack('204320', '1')).type, 'rejected');
  assert.deepEqual(parseFrame('{"header":{"tr_id":"PINGPONG"}}'), { type: 'ping' });
  assert.deepEqual(parseFrame('0|H0NXCNT0|1|unrelated'), { type: 'ignored' });
  assert.throws(() => parseFrame(ack('invalid')));
  assert.throws(() => parseFrame('{'));
});

test('validates settings at the boundary and rejects duplicate codes', () => {
  assert.deepEqual(validateStocks([{ code: '204320', name: ' HL만도 ' }]), [{ code: '204320', name: 'HL만도' }]);
  for (const input of [null, {}, [null], [{ code: '123', name: 'name' }], [{ code: '204320', name: '' }],
    [{ code: '204320', name: 'line\nbreak' }], [{ code: '204320', name: 'a' }, { code: '204320', name: 'b' }]]) {
    assert.throws(() => validateStocks(input));
  }
});
