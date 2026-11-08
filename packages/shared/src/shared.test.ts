import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyInitData, signInitData, formatRial, splitCashCheque, orderBreakdown, salePct, netPrice, allowedModes } from './index';

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

test('cash sale: 40% off the list, all in cash', () => {
  const t = { cashPct: '40', termPct: 30, termMonths: 3 };
  const unit = netPrice(1_000_000n, salePct(t, 'CASH'));
  assert.equal(unit, 600_000n);
  const b = orderBreakdown([{ quantity: 10, unitPrice: unit, listPrice: 1_000_000n }], 'CASH', 0, 0n, 50_000n);
  assert.equal(b.listTotal, 10_000_000n);
  assert.equal(b.saleDiscount, 4_000_000n);
  assert.equal(b.total, 6_050_000n);
  assert.equal(b.cash, b.total);
  assert.equal(b.cheques.length, 0);
});
test('term sale: 30% off, one cheque after 3 months, freight in cash', () => {
  const t = { cashPct: 40, termPct: 30, termMonths: 3 };
  const unit = netPrice(1_000_000n, salePct(t, 'TERM'));
  const b = orderBreakdown([{ quantity: 10, unitPrice: unit, listPrice: 1_000_000n }, { quantity: 1, unitPrice: null }], 'TERM', 3, 100_000n, 50_000n);
  assert.equal(b.subtotal, 7_000_000n);
  assert.equal(b.cheque, 6_900_000n);
  assert.equal(b.cash, 50_000n);
  assert.deepEqual(b.cheques.map(c => c.days), [90]);
  assert.equal(b.total, b.cash + b.cheque);
});
test('category overrides the customer default; empty means default', () => {
  const t = { cashPct: 40, termPct: 30, categories: { pipe: { cash: 35, term: null }, fit: { cash: '', term: '25' } } };
  assert.equal(salePct(t, 'CASH', 'pipe'), 35);
  assert.equal(salePct(t, 'TERM', 'pipe'), 30);
  assert.equal(salePct(t, 'CASH', 'fit'), 40);
  assert.equal(salePct(t, 'TERM', 'fit'), 25);
  assert.equal(salePct(null, 'CASH'), 0);
  assert.deepEqual(allowedModes({ allowCash: false, allowTerm: false }), ['CASH']);
  assert.deepEqual(allowedModes({ allowCash: false }), ['TERM']);
});
