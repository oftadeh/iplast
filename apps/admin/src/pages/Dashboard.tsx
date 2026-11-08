import { useApi, fa, dateFa, STATUS_CLASS } from '../lib';
import { useAdmin } from '../App';
import { Icon } from '../icons';
import { InviteCard, type Growth } from './Growth';

interface Dash {
  fresh?: Partial<Record<string, number>>;
  queue: { unansweredChats: number; salesReview: number; awaitingCustomer: number; finalApproval: number; needsFix: number; warehouse: number; newCustomers: number; joinRequests?: number; reportedPayments: number };
  orders: { today: number; last30: number; open: number; delivered: number; byStatus: Record<string, number> };
  money: { receivable: string; invoiced: string; chequesDue7: string; chequesDue7Count: number };
  sales: { last30: string; count30: number; prev30: string };
  top: { id: string; name: string; total: string }[];
  catalog: { variants: number; inquiry: number; activeList: { title: string; publishedAt: string | null } | null };
  customers: number;
  daily: { d: string; n: number }[];
  perf: { id: string; name: string; sales: string; orders: number; fromApp: number; active: number; customers: number; invited: number }[];
  quiet: { id: string; name: string; city: string | null; last: string | null; orders: number; agent: string | null }[];
  quietCount: number;
  overLimit: { id: string; name: string; limit: string; balance: string }[];
  cheques: { id: string; amount: string; dueDate: string; chequeNumber: string | null; customer: { id: string; name: string } }[];
  appShare: number | null;
  recent: { id: string; number: number; status: string; createdAt: string; payMode: 'CASH' | 'TERM'; value: string | null; customer: { name: string }; _count: { items: number } }[];
}
export const STATUS_FA: Record<string, string> = {
  SUBMITTED: 'پیش‌فاکتور ثبت شد', SALES_REVIEW: 'در بررسی کارشناس فروش', SALES_APPROVED: 'منتظر تأیید نهایی مدیر', NEEDS_FIX: 'نیاز به اصلاح', PROFORMA_SENT: 'پیش‌فاکتور صادر شد',
  PROFORMA_EXPIRED: 'پیش‌فاکتور منقضی شد', CONFIRMED: 'تأیید نهایی؛ ارسال به انبار', PREPARING: 'در حال آماده‌سازی', SHIPPED: 'ارسال شد', DELIVERED: 'تحویل شد', REJECTED: 'رد شد', CANCELLED: 'لغو شد',
};
const ROLE_FA = { ADMIN: 'مدیر ارشد', SALES: 'کارشناس فروش', WAREHOUSE: 'انبار' } as const;

/** Short money: «۱۲٫۵ میلیارد», «۳۴۰ میلیون». The exact figure stays in the tooltip. */
function short(v: string | bigint) {
  const n = Number(BigInt(v));
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toLocaleString('fa-IR', { maximumFractionDigits: 1 })} میلیارد`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toLocaleString('fa-IR', { maximumFractionDigits: 1 })} میلیون`;
  return fa(n);
}
const hello = () => { const h = new Date().getHours(); return h < 11 ? 'صبح بخیر' : h < 17 ? 'روز بخیر' : 'عصر بخیر'; };

/** Home of the admin panel: what needs you now, where the orders are, then sales and money. */
export function DashboardPage() {
  const { me, open } = useAdmin();
  const { data, error } = useApi<Dash>('/admin/dashboard');
  const ai = useApi<{ enabled: boolean; ok: boolean; model: string | null; error?: string; ms?: number }>('/admin/dashboard/ai');
  const growth = useApi<Growth>(me.staffRole === 'WAREHOUSE' ? null : '/admin/growth');
  if (error) return <div className="err">{error}</div>;
  if (!data) return <div className="dash"><div className="d-skel" /><div className="d-skel" style={{ height: 120 }} /><div className="d-skel" style={{ height: 260 }} /></div>;
  const role = me.staffRole!;
  const q = data.queue, c = data.orders.byStatus ?? {};
  const n = (...k: string[]) => k.reduce((a, x) => a + (c[x] ?? 0), 0);
  const money = role !== 'WAREHOUSE';

  const tasks = [
    { k: 'finalApproval', n: q.finalApproval, t: 'منتظر تأیید نهایی شما', s: 'orders/final', icon: 'check', tone: 'hot', show: role === 'ADMIN' },
    { k: 'salesReview', n: q.salesReview, t: 'پیش‌فاکتور برای قیمت‌گذاری', s: 'orders/agent', icon: 'receipt', tone: 'hot', show: role !== 'WAREHOUSE' },
    { k: 'unansweredChats', n: q.unansweredChats, t: 'مشتری منتظر جواب', s: 'chats/human', icon: 'chat', tone: 'hot', show: role !== 'WAREHOUSE' },
    { k: 'reportedPayments', n: q.reportedPayments, t: 'رسید پرداخت برای بررسی', s: 'customers/receipts', icon: 'wallet', tone: 'warn', show: role !== 'WAREHOUSE' },
    { k: 'newCustomers', n: q.newCustomers, t: 'مشتری جدید منتظر تأیید', s: 'customers/new', icon: 'users', tone: 'warn', show: role !== 'WAREHOUSE' },
    { k: 'joinRequests', n: q.joinRequests ?? 0, t: 'درخواست عضویت در مجموعه', s: 'customers/joins', icon: 'users', tone: 'warn', show: role !== 'WAREHOUSE' },
    { k: 'warehouse', n: q.warehouse, t: 'سفارش برای آماده‌سازی و ارسال', s: 'warehouse/queue', icon: 'truck', tone: 'warn', show: role !== 'SALES' },
  ].filter(x => x.show && x.n > 0);
  const waiting = tasks.reduce((a, x) => a + x.n, 0);

  const stages = [
    { t: 'نزد کارشناس', v: n('SUBMITTED', 'SALES_REVIEW', 'NEEDS_FIX', 'PROFORMA_EXPIRED'), s: 'orders/agent' },
    { t: 'منتظر تأیید مشتری', v: n('PROFORMA_SENT'), s: 'orders/history' },
    { t: 'منتظر تأیید نهایی', v: n('SALES_APPROVED'), s: role === 'ADMIN' ? 'orders/final' : 'orders/history' },
    { t: 'در انبار', v: n('CONFIRMED', 'PREPARING'), s: role === 'SALES' ? 'orders/history' : 'warehouse/queue' },
    { t: 'در راه', v: n('SHIPPED'), s: role === 'WAREHOUSE' ? 'warehouse/queue' : 'orders/history' },
    { t: 'تحویل‌شده', v: n('DELIVERED'), s: role === 'WAREHOUSE' ? 'warehouse/queue' : 'orders/history', done: true },
  ];

  // the last 14 days, empty days included
  const byDay = new Map(data.daily.map(d => [new Date(d.d).toDateString(), d.n]));
  const days = Array.from({ length: 14 }, (_, i) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 13 + i); return { d, n: byDay.get(d.toDateString()) ?? 0 }; });
  const max = Math.max(1, ...days.map(d => d.n));
  const total14 = days.reduce((a, d) => a + d.n, 0);

  const s30 = BigInt(data.sales.last30), p30 = BigInt(data.sales.prev30);
  const change = p30 > 0n ? Number(((s30 - p30) * 1000n) / p30) / 10 : null;
  const topMax = data.top.reduce((a, t) => (BigInt(t.total) > a ? BigInt(t.total) : a), 1n);

  return (
    <div className="dash">
      <section className="d-hero">
        <div>
          <span className="d-date">{new Date().toLocaleDateString('fa-IR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
          <h1>{hello()}، {me.firstName ?? ROLE_FA[role]}</h1>
          <p>{waiting ? <><b className="num">{fa(waiting)}</b> کار منتظر شماست.</> : 'کار منتظری ندارید. همه‌چیز مرتب است.'}</p>
        </div>
        <div className="d-quick">
          {money && <button type="button" className="main" onClick={() => open('orders/new')}><Icon n="receipt" s={16} />ثبت سفارش تلفنی</button>}
          {money && <button type="button" onClick={() => open('growth/invite')}><Icon n="spark" s={16} />{role === 'ADMIN' ? 'جذب مشتری و خبر قیمت' : 'لینک دعوت من'}</button>}
          {role === 'ADMIN' && <button type="button" onClick={() => open('catalog/prices')}><Icon n="tag" s={16} />به‌روزرسانی قیمت</button>}
          {!money && <button type="button" onClick={() => open('warehouse/queue')}><Icon n="truck" s={16} />صف انبار</button>}
        </div>
      </section>

      {tasks.length > 0 ? (
        <section className="d-tasks">
          {tasks.map(x => (
            <button key={x.t} type="button" className={`d-task ${x.tone}`} onClick={() => open(x.s)}>
              <span className="ic"><Icon n={x.icon} s={18} /></span>
              <b className="num">{fa(x.n)}</b>
              <span className="t">{x.t}{(data.fresh?.[x.k] ?? 0) > 0 && <span className="newchip num">{fa(data.fresh![x.k]!)} جدید</span>}</span>
              <span className="go">بررسی <Icon n="arrow" s={14} /></span>
            </button>
          ))}
        </section>
      ) : (
        <section className="d-calm"><Icon n="check" s={18} /> صف کارها خالی است. سفارش یا پیام تازه که برسد، همین‌جا و در ربات خبر می‌دهیم.</section>
      )}

      <section className="card d-pipe">
        <div className="cardhead"><h2>سفارش‌ها کجا هستند؟</h2><span className="muted small num">{fa(data.orders.open)} سفارش باز</span></div>
        <ol>
          {stages.map((s, i) => (
            <li key={s.t}>
              <button type="button" className={s.v ? (s.done ? 'on done' : 'on') : ''} onClick={() => open(s.s)}>
                <b className="num">{fa(s.v)}</b><span>{s.t}</span>
              </button>
              {i < stages.length - 1 && <i aria-hidden="true" />}
            </li>
          ))}
        </ol>
      </section>

      <section className="d-kpis">
        {money && (
          <div className="d-kpi" title={`${fa(s30)} ریال`}>
            <span>فروش ۳۰ روز اخیر</span>
            <b className="num">{short(s30)}<small> ریال</small></b>
            <small className="num">{fa(data.sales.count30)} فاکتور{change !== null && <em className={change >= 0 ? 'up' : 'down'}>{change >= 0 ? '▲' : '▼'} {fa(Math.abs(change))}٪ نسبت به ماه قبل</em>}</small>
          </div>
        )}
        <div className="d-kpi">
          <span>سفارش‌ها</span>
          <b className="num">{fa(data.orders.last30)}<small> در ۳۰ روز</small></b>
          <small className="num">امروز {fa(data.orders.today)} · تحویل‌شده تاکنون {fa(data.orders.delivered)}</small>
        </div>
        {money && (
          <button type="button" className="d-kpi link" title={`${fa(data.money.receivable)} ریال`} onClick={() => open('customers/accounts')}>
            <span>طلب از مشتریان</span>
            <b className="num">{short(data.money.receivable)}<small> ریال</small></b>
            <small className="num">از {short(data.money.invoiced)} ریال فاکتورشده</small>
          </button>
        )}
        {money && (
          <button type="button" className={`d-kpi link ${data.money.chequesDue7Count ? 'warn' : ''}`} onClick={() => open('customers/accounts')}>
            <span>چک‌های سررسید ۷ روز آینده</span>
            <b className="num">{fa(data.money.chequesDue7Count)}<small> چک</small></b>
            <small className="num">{data.money.chequesDue7Count ? `${short(data.money.chequesDue7)} ریال` : 'چکی سررسید نمی‌شود'}</small>
          </button>
        )}
        {money && (
          <div className="d-kpi">
            <span>سفارش از خود اپ</span>
            <b className="num">{data.appShare === null ? '—' : `${fa(data.appShare)}٪`}</b>
            <small>{data.appShare === null ? 'در ۳۰ روز اخیر سفارشی نبوده' : 'از سفارش‌های ۳۰ روز؛ بقیه تلفنی ثبت شده'}</small>
          </div>
        )}
        {!money && <div className="d-kpi"><span>مشتریان فعال</span><b className="num">{fa(data.customers)}</b><small>تأییدشده</small></div>}
      </section>

      {money && (
        <div className="d-grid">
          <section className="card">
            <div className="cardhead"><h2>{role === 'ADMIN' ? 'عملکرد کارشناس‌ها' : 'عملکرد من'}</h2><span className="muted small">۳۰ روز اخیر</span></div>
            {data.perf.length === 0 ? <div className="d-empty">هنوز کارشناس فروشی تعریف نشده است.</div> : role === 'ADMIN' ? (
              <div className="tablewrap"><table className="d-perf">
                <thead><tr><th>کارشناس</th><th>فروش (ریال)</th><th>سفارش</th><th>از اپ</th><th>مشتری فعال</th><th>دعوت</th></tr></thead>
                <tbody>{data.perf.map((a, i) => (
                  <tr key={a.id}>
                    <td><span className={`rk ${i === 0 && BigInt(a.sales) > 0n ? 'gold' : ''}`}>{fa(i + 1)}</span><b>{a.name}</b></td>
                    <td className="num" title={`${fa(a.sales)} ریال`}>{short(a.sales)}</td>
                    <td className="num">{fa(a.orders)}</td>
                    <td className="num">{a.orders ? `${fa(Math.round((a.fromApp / a.orders) * 100))}٪` : '—'}</td>
                    <td className="num">{fa(a.active)}<span className="muted"> / {fa(a.customers)}</span></td>
                    <td className="num">{fa(a.invited)}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            ) : (
              <div className="d-mine">{data.perf.filter(a => a.id === me.id).map(a => (
                <div key={a.id} className="grid4">
                  <div><span>فروش مشتری‌های من</span><b className="num">{short(a.sales)}</b><small>ریال</small></div>
                  <div><span>سفارش</span><b className="num">{fa(a.orders)}</b><small>{a.orders ? `${fa(Math.round((a.fromApp / a.orders) * 100))}٪ از اپ` : ''}</small></div>
                  <div><span>مشتری فعال</span><b className="num">{fa(a.active)}</b><small>از {fa(a.customers)} مشتری</small></div>
                  <div><span>با لینک من آمده‌اند</span><b className="num">{fa(a.invited)}</b><small>نفر</small></div>
                </div>
              ))}</div>
            )}
          </section>
          {growth.data ? <InviteCard g={growth.data} compact /> : <section className="card"><div className="d-empty">…</div></section>}
        </div>
      )}

      {money && (
        <div className="d-grid3">
          <section className="card">
            <div className="cardhead"><h2>مشتری‌های خاموش</h2><span className="muted small num">{fa(data.quietCount)} مشتری بیش از ۳۰ روز سفارش نداده</span></div>
            {data.quiet.length === 0 ? <div className="d-empty">همه‌ی مشتری‌ها در ۳۰ روز اخیر سفارش داده‌اند 👏</div> : (
              <ul className="d-list">{data.quiet.map(c => (
                <li key={c.id}>
                  <span><b>{c.name}</b><small className="num">{c.last ? `آخرین سفارش ${new Date(c.last).toLocaleDateString('fa-IR', { day: 'numeric', month: 'long' })}` : 'هنوز سفارشی نداده'}{c.city ? ` · ${c.city}` : ''}{role === 'ADMIN' && c.agent ? ` · ${c.agent}` : ''}</small></span>
                  <button type="button" className="btn sm" onClick={() => open('customers/settings', c.id)}>پرونده</button>
                </li>
              ))}</ul>
            )}
            {data.quiet.length > 0 && <p className="d-tip">یک تماس یا پیام کوتاه، یا ارسال «خبر تغییر قیمت»، مشتری خاموش را برمی‌گرداند.</p>}
          </section>
          <section className="card">
            <div className="cardhead"><h2>چک‌های ۷ روز آینده</h2><button type="button" className="btn sm" onClick={() => open('customers/accounts')}>حساب‌ها</button></div>
            {data.cheques.length === 0 ? <div className="d-empty">چکی در ۷ روز آینده سررسید نمی‌شود.</div> : (
              <ul className="d-list">{data.cheques.map(c => {
                const late = new Date(c.dueDate) < new Date(new Date().toDateString());
                return (
                  <li key={c.id} className={late ? 'late' : ''}>
                    <span><b>{c.customer.name}</b><small className="num">{late ? 'سررسید گذشته · ' : ''}{new Date(c.dueDate).toLocaleDateString('fa-IR', { weekday: 'short', day: 'numeric', month: 'long' })}{c.chequeNumber ? ` · ${fa(c.chequeNumber)}` : ''}</small></span>
                    <b className="num">{short(c.amount)}</b>
                  </li>
                );
              })}</ul>
            )}
          </section>
          <section className="card">
            <div className="cardhead"><h2>بالاتر از سقف اعتبار</h2></div>
            {data.overLimit.length === 0 ? <div className="d-empty">{role === 'ADMIN' ? 'بدهی هیچ مشتری‌ای از سقفش نگذشته است. سقف را در پرونده‌ی مشتری ← مشخصات تعیین کنید.' : 'بدهی هیچ‌کدام از مشتری‌های شما از سقف نگذشته است.'}</div> : (
              <ul className="d-list">{data.overLimit.map(c => (
                <li key={c.id} className="late">
                  <span><b>{c.name}</b><small className="num">سقف {short(c.limit)} · بدهی {short(c.balance)}</small></span>
                  <button type="button" className="btn sm" onClick={() => open('customers/accounts', c.id)}>حساب</button>
                </li>
              ))}</ul>
            )}
          </section>
        </div>
      )}

      <div className="d-grid">
        <section className="card">
          <div className="cardhead"><h2>سفارش روزانه</h2><span className="muted small num">{fa(total14)} سفارش در ۱۴ روز</span></div>
          <div className="d-chart" role="img" aria-label={`تعداد سفارش روزانه در ۱۴ روز اخیر، جمعاً ${fa(total14)}`}>
            {days.map((d, i) => (
              <div key={i} className={i === 13 ? 'today' : ''} title={`${d.d.toLocaleDateString('fa-IR', { weekday: 'long', day: 'numeric', month: 'long' })}: ${fa(d.n)} سفارش`}>
                <em className="num">{d.n ? fa(d.n) : ''}</em>
                <i style={{ height: `${Math.max(d.n ? 8 : 2, (d.n / max) * 100)}%` }} />
                <span className="num">{d.d.toLocaleDateString('fa-IR', { day: 'numeric' })}</span>
              </div>
            ))}
          </div>
        </section>

        {money ? (
          <section className="card">
            <div className="cardhead"><h2>بیشترین خرید ۳۰ روز</h2><button type="button" className="btn sm" onClick={() => open('customers/accounts')}>حساب‌ها</button></div>
            {data.top.length === 0 ? <div className="d-empty">در ۳۰ روز اخیر فاکتوری صادر نشده است.</div> : (
              <ol className="d-top">
                {data.top.map((t, i) => (
                  <li key={t.id} title={`${fa(t.total)} ریال`}>
                    <span className="r num">{fa(i + 1)}</span>
                    <span className="nm">{t.name}<i style={{ width: `${Number((BigInt(t.total) * 100n) / topMax)}%` }} /></span>
                    <b className="num">{short(t.total)}</b>
                  </li>
                ))}
              </ol>
            )}
          </section>
        ) : (
          <section className="card"><div className="cardhead"><h2>انبار</h2></div><div className="d-empty">سفارش‌های تأییدشده برای آماده‌سازی در «انبار و ارسال» است.</div></section>
        )}
      </div>

      <section className="card">
        <div className="cardhead"><h2>آخرین سفارش‌ها</h2>{role !== 'WAREHOUSE' && <button type="button" className="btn sm" onClick={() => open('orders/history')}>همه</button>}</div>
        {data.recent.length === 0 ? <div className="d-empty">هنوز سفارشی ثبت نشده است.</div> : (
          <div className="tablewrap"><table className="d-table">
            <thead><tr><th>شماره</th><th>مشتری</th><th>نوع</th><th>مبلغ (ریال)</th><th>وضعیت</th><th>زمان</th></tr></thead>
            <tbody>{data.recent.map(o => (
              <tr key={o.id} onClick={() => role !== 'WAREHOUSE' && open('orders/history')}>
                <td className="num">#{fa(o.number)}</td>
                <td><b>{o.customer.name}</b><small className="muted num"> · {fa(o._count.items)} قلم</small></td>
                <td className="small">{o.payMode === 'TERM' ? 'مدت‌دار' : 'نقدی'}</td>
                <td className="num">{o.value === null ? <span className="muted small">استعلامی</span> : fa(o.value)}</td>
                <td><span className={`st ${STATUS_CLASS(o.status)}`}>{STATUS_FA[o.status] ?? o.status}</span></td>
                <td className="muted small nowrap">{dateFa(o.createdAt)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      <section className="d-sys">
        <span><Icon n="tag" s={14} />لیست قیمت: {data.catalog.activeList ? <b>{data.catalog.activeList.title}</b> : <b className="bad">ندارد</b>}</span>
        <span className="num"><Icon n="box" s={14} />{fa(data.catalog.variants)} سایز کالا · {fa(data.catalog.inquiry)} استعلامی</span>
        <span className="num"><Icon n="users" s={14} />{fa(data.customers)} مشتری فعال</span>
        <span><Icon n="spark" s={14} />دستیار هوشمند: {!ai.data ? '…' : ai.data.ok ? <b className="ok">وصل</b> : <b className="bad" title={ai.data.error}>قطع</b>}</span>
      </section>
    </div>
  );
}
