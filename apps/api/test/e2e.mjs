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
assert.equal(fams.length, 98); step("catalog lists 98 families");
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

const adm = await call('GET', '/api/admin/orders?status=SUBMITTED,SALES_REVIEW,NEEDS_FIX', null, admin);
assert.ok(adm.rows.length >= 2); step('admin lists proformas waiting for the sales agent');
const staff = await call('POST', '/api/admin/staff', { telegramId: '7100', firstName: 'پشتیبان', role: 'SALES' }, admin);
await call('POST', '/api/admin/staff', { telegramId: '7101', firstName: 'دیگری', role: 'SALES' }, admin);
const sales = await login(7100, 'Sales'); const sales2 = await login(7101, 'Other');
await call('PATCH', `/api/admin/customers/${cust.customerId}`, { supportId: staff.id }, admin); step('admin adds sales agents and assigns one to the customer');
await call('PATCH', `/api/admin/customers/${cust.customerId}`, { supportId: null }, sales, 403); step('sales agent cannot reassign the customer');
await call('PUT', `/api/admin/customers/${cust.customerId}/terms`, { cashPercent: 50 }, sales, 403); step('sales agent cannot change cash/cheque terms');

// two-step approval: the customer's sales agent first, then the manager
await call('POST', `/api/admin/orders/${o1.id}/decide`, { action: 'final_ok' }, admin, 400); step('manager cannot final-approve before the sales agent');
await call('POST', `/api/admin/orders/${o1.id}/decide`, { action: 'sales_ok' }, sales2, 403); step("another customer's agent cannot approve");
await call('POST', `/api/admin/orders/${o1.id}/decide`, { action: 'fix' }, sales, 400);
const fx = await call('POST', `/api/admin/orders/${o1.id}/decide`, { action: 'fix', comment: 'تعداد را به کارتن کامل برسانید' }, sales);
assert.equal(fx.status, 'NEEDS_FIX'); step('agent sends the proforma back for a fix (note required)');
await call('POST', `/api/admin/orders/${o1.id}/decide`, { action: 'sales_ok' }, sales, 400); step('agent cannot approve while an inquiry line has no price');
const inqLine = o1.items.find(i => i.variantId === inquiry.id);
const pricedLine = o1.items.find(i => i.variantId === priced.id);
const s1 = await call('POST', `/api/admin/orders/${o1.id}/decide`, { action: 'sales_ok', comment: 'ارسال پنجشنبه', edit: { items: [{ id: inqLine.id, unitPrice: '۱۲٬۵۰۰٬۰۰۰' }, { id: pricedLine.id, quantity: 340 }], discount: '1000000', shipping: '2000000' } }, sales);
assert.equal(s1.status, 'PROFORMA_SENT');
const wantSub = BigInt(priced.price) * 340n + 12_500_000n * 5n;
assert.equal(s1.breakdown.subtotal, String(wantSub)); assert.equal(s1.payable, String(wantSub - 1_000_000n + 2_000_000n));
assert.equal(s1.proformas[0].version, 1); assert.equal(s1.proformas[0].changed, true); step('agent prices the inquiry line, changes a quantity, adds discount and freight → final proforma to the customer');
await call('POST', `/api/admin/orders/${o1.id}/decide`, { action: 'final_ok' }, admin, 400); step('manager cannot final-approve before the customer accepts');
await call('POST', `/api/orders/${o1.id}/accept`, { ok: true }, buyer, [403, 404]);
await call('POST', `/api/orders/${o1.id}/accept`, { ok: true }, stranger, [403, 404]); step('only who placed it or the account owner can accept');
const acc = await call('POST', `/api/orders/${o1.id}/accept`, { ok: true }, owner);
assert.equal(acc.status, 'SALES_APPROVED'); step('customer accepts the proforma → waiting for the manager');
await call('POST', `/api/admin/orders/${o1.id}/decide`, { action: 'final_ok' }, sales, 403); step('agent cannot give the final approval');
const queue = await call('GET', '/api/admin/orders?status=SALES_APPROVED', null, admin);
assert.ok(queue.rows.some(r => r.id === o1.id) && queue.rows[0].customer.support); step('manager queue lists it with the agent name');
const fin = await call('POST', `/api/admin/orders/${o1.id}/decide`, { action: 'final_ok' }, admin);
assert.equal(fin.status, 'CONFIRMED'); assert.deepEqual(fin.events.map(e => e.status), ['SUBMITTED', 'NEEDS_FIX', 'PROFORMA_SENT', 'SALES_APPROVED', 'CONFIRMED']); step('manager final approval → confirmed, full history');
const accAfter = await call('GET', `/api/admin/accounts/customers/${cust.customerId}`, null, admin);
const inv1 = accAfter.invoices.find(i => i.order?.number === o1.number);
assert.ok(inv1); assert.equal(inv1.total, fin.payable); step('final approval issues the invoice with the proforma amount');

// customer terms: cash discount and cheque markup apply to the money
await call('PUT', `/api/admin/customers/${cust.customerId}/terms`, { cashPercent: 30, chequeDueDays: [60, 90], cashDiscountPct: 2, chequeMarkupPct: 3 }, admin);
const o3 = await call('POST', '/api/orders', { items: [{ variantId: priced.id, quantity: 100 }] }, buyer);
const sub3 = BigInt(priced.price) * 100n, cashB = sub3 * 30n / 100n, chqB = sub3 - cashB;
const want3 = cashB - cashB * 200n / 10000n + chqB + chqB * 300n / 10000n;
assert.equal(o3.payable, String(want3)); assert.equal(o3.breakdown.cheques.length, 2); step('cash discount and cheque markup applied; cheque share split into 60/90-day cheques');
const s3 = await call('POST', `/api/admin/orders/${o3.id}/decide`, { action: 'sales_ok' }, sales);
assert.equal(s3.status, 'SALES_APPROVED'); step('nothing changed by the agent → straight to the manager, no customer step');
await call('POST', `/api/admin/orders/${o3.id}/decide`, { action: 'reject', comment: 'آزمایشی' }, admin);
await call('POST', `/api/admin/orders/${o2.id}/decide`, { action: 'reject', comment: 'ناموجود' }, sales);
await call('POST', `/api/admin/orders/${o2.id}/decide`, { action: 'sales_ok' }, sales, 400); step('agent rejects; a closed proforma cannot be approved');
await call('PATCH', `/api/admin/orders/${o1.id}/status`, { status: 'PREPARING' }, sales, 403);
await call('PATCH', `/api/admin/orders/${o1.id}/status`, { status: 'CONFIRMED' }, admin, 400);
const prep = await call('PATCH', `/api/admin/orders/${o1.id}/status`, { status: 'PREPARING' }, admin);
assert.equal(prep.status, 'PREPARING'); step('only the manager moves it on (preparing); approvals cannot be skipped by status');
// warehouse: prepares and ships what the manager approved
await call('POST', '/api/admin/staff', { telegramId: '7200', firstName: 'انبار', role: 'WAREHOUSE' }, admin);
const wh = await login(7200, 'Warehouse');
await call('GET', '/api/admin/customers', null, wh, 403);
await call('GET', '/api/admin/accounts', null, wh, 403); step('warehouse cannot open customers or accounts');
const whq = await call('GET', '/api/admin/orders?status=CONFIRMED,PREPARING', null, wh);
assert.ok(whq.rows.some(r => r.id === o1.id)); step('warehouse sees approved orders');
await call('POST', `/api/admin/orders/${o1.id}/decide`, { action: 'ship' }, sales, 403); step('sales agent cannot mark shipping');
await call('POST', `/api/admin/orders/${o1.id}/decide`, { action: 'delivered' }, wh, 400);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const form = async (path, token, fields, file, expect = 200) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append('file', new Blob([file.buf], { type: file.type }), file.name);
  const r = await fetch(API + path, { method: 'POST', body: fd, headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json(); assert.ok(r.status === expect || (expect === 200 && r.status === 201), `${path} → ${r.status} ${JSON.stringify(j)}`); return j;
};
await form(`/api/admin/orders/${o1.id}/shipments`, sales, { waybillNo: '1' }, null, 403); step('sales agent cannot record a load');
await form(`/api/admin/orders/${o1.id}/shipments`, wh, { carrier: 'ایران‌پیما', waybillNo: '۱۲۳۴۵', driverName: 'رضایی', driverPhone: '09120000000', plate: '۱۲ع۳۴۵', freight: '۳٬۵۰۰٬۰۰۰', freightBy: 'customer' }, { buf: PDF, type: 'application/pdf', name: 'w.pdf' });
const sh = await call('GET', `/api/orders/${o1.id}`, null, owner);
assert.equal(sh.status, 'SHIPPED'); assert.equal(sh.shipments[0].waybillNo, '۱۲۳۴۵'); assert.equal(sh.shipments[0].freight, '3500000');
assert.equal(sh.documents[0].kind, 'WAYBILL'); step('warehouse records the load with a waybill PDF; customer sees it on the order');
const dl = await call('POST', `/api/admin/orders/${o1.id}/decide`, { action: 'delivered' }, wh);
assert.equal(dl.status, 'DELIVERED'); step('warehouse marks delivery');

// manager messages through the bot
await call('POST', '/api/admin/broadcasts', { audience: 'sales', text: 'جلسه‌ی فروش شنبه' }, sales, 403); step('only the manager sends announcements');
await call('POST', '/api/admin/broadcasts', { audience: 'sales', text: ' ' }, admin, 400);
await call('POST', '/api/admin/broadcasts', { audience: 'customer', text: 'سلام' }, admin, 400); step('empty text or missing customer refused');
assert.equal((await call('GET', '/api/admin/broadcasts/count?audience=sales', null, admin)).count, 2);
assert.equal((await call('GET', `/api/admin/broadcasts/count?audience=customer&customerId=${cust.customerId}`, null, admin)).count, 2);
assert.equal((await call('GET', '/api/admin/broadcasts/count?audience=staff', null, admin)).count, 4); step('recipient counts: 2 agents, 2 users of the company, 4 staff');
const bc = await call('POST', '/api/admin/broadcasts', { audience: 'customers', text: 'لیست قیمت جدید منتشر شد', withButton: true }, admin);
assert.ok(bc.recipients >= 3);
const hist = await call('GET', '/api/admin/broadcasts', null, admin);
assert.equal(hist[0].id, bc.id); assert.equal(hist[0].audienceFa, 'همه‌ی مشتریان'); step('announcement to all customers recorded');

const meO = await call('GET', '/api/me', null, owner);
assert.equal(meO.accounts[0].support.firstName, 'Sales'); step('customer sees their sales agent');

// receipts from the customer
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const report = async (token, fields, photo = true, expect = 200) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (photo) fd.append('file', new Blob([PNG], { type: 'image/png' }), 'r.png');
  const r = await fetch(API + '/api/me/account/payments', { method: 'POST', body: fd, headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json(); assert.ok(r.status === expect || (expect === 200 && r.status === 201), `report → ${r.status} ${JSON.stringify(j)}`); return j;
};
await report(owner, { method: 'TRANSFER', amount: '50000000' }, false, 400); step('receipt without a photo is refused');
await report(owner, { method: 'CHEQUE', amount: '80000000', chequeNumber: '123456' }, true, 400); step('cheque needs a due date');
const p1 = await report(owner, { method: 'TRANSFER', amount: '50000000', bank: 'ملت' });
const p2 = await report(buyer, { method: 'CHEQUE', amount: '80000000', chequeNumber: '123456', dueDate: '2027-01-20' });
assert.equal(p1.status, 'REPORTED'); step('owner sends a transfer receipt, buyer sends a cheque photo');
const acc0 = await call('GET', '/api/me/account', null, owner);
assert.equal(acc0.summary.reported, '130000000'); assert.equal(acc0.summary.paid, '0'); step('reported payments wait; balance unchanged');
const rep = await call('GET', '/api/admin/accounts/reported', null, sales);
assert.equal(rep.length, 2); assert.ok(rep.every(p => p.hasReceipt && !p.receiptKey)); step('agent sees both receipts (no file names leaked)');
const img = await fetch(`${API}/api/admin/accounts/payments/${p1.id}/receipt`, { headers: { Authorization: `Bearer ${sales}` } });
assert.equal(img.status, 200); assert.equal(Buffer.from(await img.arrayBuffer()).length, PNG.length); step('receipt photo opens for staff');
assert.equal((await fetch(`${API}/api/me/account/payments/${p1.id}/receipt`, { headers: { Authorization: `Bearer ${stranger}` } })).status === 200, false); step('stranger cannot open the receipt');
await call('POST', `/api/admin/accounts/payments/${p1.id}/review`, { ok: true }, sales2, 403); step("another agent cannot review this customer's receipt");
const r1 = await call('POST', `/api/admin/accounts/payments/${p1.id}/review`, { ok: true }, sales);
assert.equal(r1.status, 'CLEARED');
const r2 = await fetch(`${API}/api/internal/payments/review`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': process.env.INTERNAL_KEY ?? '' }, body: JSON.stringify({ telegramId: '7100', paymentId: p2.id, ok: true }) }).then(r => r.json());
assert.equal(r2.status, 'PENDING'); step('transfer accepted in the panel; cheque accepted from the bot button → in progress');
await call('POST', `/api/admin/accounts/payments/${p1.id}/review`, { ok: false }, admin, 400); step('a reviewed receipt cannot be reviewed again');
const acc1 = await call('GET', '/api/me/account', null, owner);
assert.equal(acc1.summary.paid, '50000000'); assert.equal(acc1.summary.pendingCheques, '80000000'); assert.equal(acc1.summary.reported, '0'); step('account: transfer counted, cheque pending until cleared');

// customer settings: discount per product category
const disc0 = await call('GET', `/api/admin/customers/${cust.customerId}/discounts`, null, sales);
const cat = disc0.categories.find(c => c.slug === male.category.slug);
assert.ok(cat && cat.pct === 0); step('every category listed with no discount yet');
await call('PUT', `/api/admin/customers/${cust.customerId}/discounts`, { items: [{ categoryId: cat.id, pct: 5 }] }, sales, 403); step('only the manager sets category discounts');
await call('PUT', `/api/admin/customers/${cust.customerId}/discounts`, { items: [{ categoryId: cat.id, pct: 120 }] }, admin, 400);
const disc1 = await call('PUT', `/api/admin/customers/${cust.customerId}/discounts`, { items: [{ categoryId: cat.id, pct: '۷٫۵' }] }, admin);
assert.equal(disc1.categories.find(c => c.id === cat.id).pct, 7.5); step('manager sets 7.5% on a category (Persian digits accepted); over 100 refused');
const meD = await call('GET', '/api/me', null, buyer);
assert.equal(meD.accounts[0].discounts[male.category.slug].pct, 7.5); step('customer sees their category discount in their panel');
const q = await call('POST', '/api/me/quote', { variantIds: [priced.id] }, buyer);
assert.equal(q[priced.id], String(BigInt(priced.price) * 9250n / 10000n)); step('their price is the list price minus 7.5%');
const o4 = await call('POST', '/api/orders', { items: [{ variantId: priced.id, quantity: 4 }] }, buyer);
assert.equal(o4.items[0].unitPrice, q[priced.id]); step('orders use the discounted price');
await call('PUT', `/api/admin/customers/${cust.customerId}/discounts`, { items: [{ categoryId: cat.id, pct: 0 }] }, admin);
assert.equal((await call('POST', '/api/me/quote', { variantIds: [priced.id] }, buyer))[priced.id], priced.price); step('0 removes the discount');
await call('POST', `/api/admin/orders/${o4.id}/decide`, { action: 'reject', comment: 'آزمایشی' }, admin);

// financial documents on the customer's file
await form(`/api/admin/customers/${cust.customerId}/documents`, admin, { kind: 'CONTRACT', title: 'قرارداد ۱۴۰۵' }, { buf: Buffer.from('x'), type: 'text/plain', name: 'a.txt' }, 400); step('only photos and PDFs are accepted');
const doc = await form(`/api/admin/customers/${cust.customerId}/documents`, admin, { kind: 'CONTRACT', title: 'قرارداد ۱۴۰۵' }, { buf: PDF, type: 'application/pdf', name: 'c.pdf' });
const mine = await form('/api/me/documents', owner, { kind: 'RECEIPT', title: 'فیش' }, { buf: PNG, type: 'image/png', name: 'f.png' });
assert.equal(mine.byCustomer, true);
const docs = await call('GET', `/api/admin/customers/${cust.customerId}/documents`, null, sales);
assert.ok(docs.some(d => d.id === doc.id) && docs.some(d => d.id === mine.id) && docs.some(d => d.kind === 'WAYBILL')); step('staff and customer attach documents; all on the customer file');
const df = await fetch(`${API}/api/admin/documents/${doc.id}/file`, { headers: { Authorization: `Bearer ${sales}` } });
assert.equal(df.status, 200); assert.equal(df.headers.get('content-type'), 'application/pdf');
assert.equal((await fetch(`${API}/api/me/documents/${doc.id}/file`, { headers: { Authorization: `Bearer ${stranger}` } })).status, 404);
assert.equal((await fetch(`${API}/api/me/documents/${doc.id}/file`, { headers: { Authorization: `Bearer ${owner}` } })).status, 200); step('documents open for staff and the customer, not for strangers');
const pdfPay = await form('/api/me/account/payments', owner, { method: 'TRANSFER', amount: '1000000' }, { buf: PDF, type: 'application/pdf', name: 'r.pdf' });
assert.equal(pdfPay.status, 'REPORTED'); step('customer can send a PDF receipt');
const bounced = await call('PATCH', `/api/admin/accounts/payments/${p2.id}`, { status: 'BOUNCED' }, admin);
assert.equal(bounced.status, 'BOUNCED'); step('a bounced cheque is recorded (customer, agent and managers are told)');

await call('POST', '/api/auth/code/request', { telegramId: '7001' }); await call('POST', '/api/auth/code/verify', { telegramId: '7001', code: '000000' }, null, 401); step('admin code login refuses non-staff');
console.log(`\nall ${n} checks passed`);
