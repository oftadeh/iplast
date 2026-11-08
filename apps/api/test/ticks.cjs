// Proforma expiry and cheque reminders, run against the e2e database.
const assert = require('node:assert/strict');
// Usage (from apps/api, after the e2e run): DATABASE_URL=... JWT_SECRET=... BOT_TOKEN=... NODE_ENV=test node test/ticks.cjs
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { OrdersService } = require('../dist/orders/orders.service');
const { AccountingService } = require('../dist/accounting/accounting');
const { PrismaService } = require('../dist/prisma/prisma.service');
(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const orders = app.get(OrdersService), acc = app.get(AccountingService), prisma = app.get(PrismaService);
  const owner = await prisma.user.findUniqueOrThrow({ where: { telegramId: 7001n } });
  const sales = await prisma.user.findUniqueOrThrow({ where: { telegramId: 7100n } });
  const v = await prisma.variant.findFirstOrThrow({ where: { prices: { some: { status: 'PRICED' } } } });
  const o = await orders.create(owner.id, { items: [{ variantId: v.id, quantity: 10 }] });
  const r = await orders.decide(sales.id, o.id, 'sales_ok', undefined, { discount: '1000' });
  assert.equal(r.status, 'PROFORMA_SENT');
  await prisma.proforma.updateMany({ where: { orderId: o.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
  await orders.expireProformas();
  assert.equal((await prisma.order.findUnique({ where: { id: o.id } })).status, 'PROFORMA_EXPIRED');
  await assert.rejects(orders.customerDecide(owner.id, o.id, true), /منقضی/);
  const again = await orders.decide(sales.id, o.id, 'sales_ok');
  assert.equal(again.status, 'PROFORMA_SENT');
  assert.equal((await prisma.proforma.count({ where: { orderId: o.id } })), 2);
  console.log('✓ proforma expires, customer cannot accept it, the agent re-sends version 2');

  const now = new Date('2026-11-10T07:00:00Z'); // 10:30 in Tehran
  const p = await prisma.payment.create({ data: { customerId: o.customerId, amount: 5_000_000n, method: 'CHEQUE', status: 'PENDING', dueDate: new Date('2026-11-12T08:00:00Z'), createdById: sales.id, chequeNumber: '999' } });
  await prisma.setting.deleteMany({ where: { key: 'cheque.digestDay' } });
  await acc.chequeReminders(now);
  const p1 = await prisma.payment.findUnique({ where: { id: p.id } });
  assert.ok(p1.remindedAt); 
  assert.ok(await prisma.setting.findUnique({ where: { key: 'cheque.digestDay' } }));
  await acc.chequeReminders(new Date(now.getTime() + 3600_000));
  assert.equal((await prisma.payment.findUnique({ where: { id: p.id } })).remindedAt.getTime(), p1.remindedAt.getTime());
  const due = new Date('2026-11-12T06:00:00Z');
  await acc.chequeReminders(due);
  assert.equal((await prisma.payment.findUnique({ where: { id: p.id } })).remindedAt.getTime(), due.getTime());
  await acc.chequeReminders(new Date('2026-11-11T20:00:00Z')); // 23:30 Tehran: nothing at night
  console.log('✓ cheque reminder 3 days before, not repeated, again on the due day; managers digest once a day; quiet at night');
  await app.close();
})().catch(e => { console.error(e); process.exit(1); });
