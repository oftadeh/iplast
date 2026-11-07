import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyInitData, signInitData, formatRial, splitCashCheque } from './index';

const TOKEN = '123456:TEST-TOKEN';
const now = Date.UTC(2026, 10, 7, 9, 0, 0);
const fields = { auth_date: String(now / 1000 - 60), query_id: 'AAH', user: JSON.stringify({ id: 42, first_name: 'Ali' }) };

test('accepts correctly signed initData', () => {
  const v = verifyInitData(signInitData(fields, TOKEN), TOKEN, 3600, now);
  assert.equal(v?.user.id, 42);
});
test('rejects a tampered user', () => {
  const s = signInitData(fields, TOKEN).replace('42', '43');
  assert.equal(verifyInitData(s, TOKEN, 3600, now), null);
});
test('rejects another bot token', () => {
  assert.equal(verifyInitData(signInitData(fields, TOKEN), '999:OTHER', 3600, now), null);
});
test('rejects stale data', () => {
  assert.equal(verifyInitData(signInitData(fields, TOKEN), TOKEN, 30, now), null);
});
test('missing price is never a number', () => {
  assert.equal(formatRial(null), 'استعلامی');
  assert.equal(formatRial(790000n), '۷۹۰,۰۰۰ ریال');
});
test('cash/cheque split keeps the total', () => {
  const s = splitCashCheque(604200000n, 30);
  assert.equal(s.cash + s.cheque, 604200000n);
  assert.equal(s.cash, 181260000n);
});
