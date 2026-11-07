// End-to-end check against a running API with a seeded database.
// Usage: API=http://localhost:3999 BOT_TOKEN=... ADMIN_ID=42 node apps/api/test/e2e.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { signInitData } = require('../../../packages/shared/dist');

const API = process.env.API ?? 'http://localhost:3999';
const TOKEN = process.env.BOT_TOKEN;
const login = async (id, name) => {
  const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: name }) }, TOKEN);
  const r = await call('POST', '/api/auth/telegram', { initData });
  return r.token;
};
async function call(method, path, body, token, expect = 200) {
  const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  const ok = Array.isArray(expect) ? expect.includes(r.status) : r.status === expect || (expect === 200 && r.status === 201);
  assert.ok(ok, `${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j;
}
let n = 0; const step = (m) => console.log(`✓ ${++n}. ${m}`);

const fams = await call('GET', '/api/catalog/families');
assert.equal(fams.length, 19); step('catalog lists 19 families');
const male = await call('GET', '/api/catalog/families/male-adapter');
const priced = male.variants.find(v => v.price !== null);
const famWithInquiry = await Promise.all(fams.map(f => call('GET', `/api/catalog/families/${f.slug}`)));
const inquiry = famWithInquiry.flatMap(f => f.variants).find(v => v.price === null);
assert.ok(priced && inquiry); step('priced and inquiry sizes present; inquiry price is null');

await call('GET', '/api/me', null, null, 401); step('protected route rejects anonymous');
const admin = await login(Number(process.env.ADMIN_ID ?? 42), 'Admin');
const owner = await login(7001, 'Owner');
const buyer = await login(7002, 'Buyer');
const stranger = await login(7003, 'Stranger');

await call('GET', '/api/admin/orders', null, owner, 403); step('customer cannot open admin routes');

const o1 = await call('POST', '/api/orders', { newCustomer: { name: 'فروشگاه آزمایشی', city: 'اصفهان' }, items: [{ variantId: priced.id, quantity: 170, packs: 1 }, { variantId: inquiry.id, quantity: 5 }], idempotencyKey: 'e2e-1' }, owner);
assert.equal(o1.items.length, 2);
assert.equal(o1.items.find(i => i.variantId === inquiry.id).unitPrice, null);
assert.equal(BigInt(o1.total), BigInt(priced.price) * 170n); step('order created; inquiry line has no price; total counts priced lines only');
const again = await call('POST', '/api/orders', { items: [{ variantId: priced.id, quantity: 1 }], idempotencyKey: 'e2e-1' }, owner);
assert.equal(again.id, o1.id); step('idempotency key returns the same order');

const me = await call('GET', '/api/me', null, owner);
const cust = me.accounts[0]; assert.equal(cust.role, 'OWNER'); step('owner account created on first order');

await call('PUT', `/api/admin/customers/${cust.customerId}/terms`, { cashPercent: 30, chequeDueDays: [60, 90] }, admin);
await call('PUT', `/api/admin/customers/${cust.customerId}/terms`, { cashPercent: 130 }, admin, 400); step('admin sets 30% cash / 70% cheque; invalid percent rejected');
await call('POST', `/api/admin/customers/${cust.customerId}/members`, { telegramId: '7002', role: 'BUYER' }, admin); step('admin adds a second purchasing agent');

const meB = await call('GET', '/api/me', null, buyer);
assert.equal(meB.accounts[0].terms.cashPercent, 30); step('buyer sees the default terms');
const o2 = await call('POST', '/api/orders', { items: [{ variantId: priced.id, quantity: 10 }] }, buyer);
assert.equal(o2.placedBy.firstName, 'Buyer'); assert.equal(o2.split.cash, String(BigInt(o2.total) * 30n / 100n)); step('buyer order records who placed it and splits cash/cheque');

const buyerList = await call('GET', '/api/orders', null, buyer);
assert.deepEqual(buyerList.map(o => o.id), [o2.id]);
await call('GET', `/api/orders/${o1.id}`, null, buyer, 404); step('buyer sees only own orders');
const ownerList = await call('GET', '/api/orders', null, owner);
assert.equal(ownerList.length, 2); step('owner sees all company orders');
await call('GET', `/api/orders/${o1.id}`, null, stranger, 404); step('stranger cannot read the order');
await call('POST', '/api/orders', { customerId: cust.customerId, items: [{ variantId: priced.id, quantity: 1 }] }, stranger, 403); step('stranger cannot order for the company');

const adm = await call('GET', '/api/admin/orders', null, admin);
assert.ok(adm.rows.length >= 2); step('admin lists orders');
const st = await call('PATCH', `/api/admin/orders/${o1.id}/status`, { status: 'SALES_REVIEW', comment: 'در حال بررسی' }, admin);
assert.equal(st.status, 'SALES_REVIEW'); assert.equal(st.events.length, 2);
await call('PATCH', `/api/admin/orders/${o1.id}/status`, { status: 'NOPE' }, admin, 400); step('admin changes status with a history event');

const staff = await call('POST', '/api/admin/staff', { telegramId: '7100', firstName: 'پشتیبان', role: 'SALES' }, admin);
await call('PATCH', `/api/admin/customers/${cust.customerId}`, { supportId: staff.id }, admin); step('admin adds a sales agent and assigns it to the customer');
await call('PUT', `/api/admin/customers/${cust.customerId}/terms`, { cashPercent: 50 }, await login(7100, 'Sales'), 403); step('sales agent cannot change cash/cheque terms');

await call('POST', '/api/auth/code/request', { telegramId: '7001' }); await call('POST', '/api/auth/code/verify', { telegramId: '7001', code: '000000' }, null, 401); step('admin code login refuses non-staff');
console.log(`\nall ${n} checks passed`);
