import { useApi, fa, dateFa, rial, STATUS_CLASS } from '../lib';
import { useAdmin } from '../App';
import { Icon } from '../icons';

interface Dash {
  queue: { salesReview: number; finalApproval: number; needsFix: number; warehouse: number; newCustomers: number; reportedPayments: number };
  orders: { today: number; last30: number; open: number; delivered: number };
  money: { receivable: string; invoiced: string; chequesDue7: string; chequesDue7Count: number };
  catalog: { variants: number; inquiry: number; activeList: { title: string; publishedAt: string | null } | null };
  customers: number;
  daily: { d: string; n: number }[];
  recent: { id: string; number: number; status: string; createdAt: string; customer: { name: string }; _count: { items: number } }[];
}
const STATUS_FA: Record<string, string> = {
  SUBMITTED: 'پیش‌فاکتور ثبت شد', SALES_REVIEW: 'در بررسی کارشناس فروش', SALES_APPROVED: 'منتظر تأیید نهایی مدیر', NEEDS_FIX: 'نیاز به اصلاح', PROFORMA_SENT: 'پیش‌فاکتور صادر شد',
  PROFORMA_EXPIRED: 'پیش‌فاکتور منقضی شد', CONFIRMED: 'تأیید نهایی؛ ارسال به انبار', PREPARING: 'در حال آماده‌سازی', SHIPPED: 'ارسال شد', DELIVERED: 'تحویل شد', REJECTED: 'رد شد', CANCELLED: 'لغو شد',
};

/** Home of the admin panel: what is waiting for staff, then sales and money figures. */
export function DashboardPage() {
  const { me, open } = useAdmin();
  const { data, error } = useApi<Dash>('/admin/dashboard');
  if (error) return <div className="err">{error}</div>;
  if (!data) return <div className="empty">در حال بارگذاری…</div>;
  const role = me.staffRole!;
  const q = data.queue;
  const tasks = [
    { n: q.salesReview, t: 'پیش‌فاکتور منتظر کارشناس', s: 'approvals', show: role !== 'WAREHOUSE' },
    { n: q.finalApproval, t: 'منتظر تأیید نهایی مدیر', s: 'approvals', show: role === 'ADMIN' },
    { n: q.newCustomers, t: 'مشتری جدید منتظر تأیید', s: 'approvals', show: role !== 'WAREHOUSE' },
    { n: q.reportedPayments, t: 'رسید پرداخت برای بررسی', s: 'approvals', show: role !== 'WAREHOUSE' },
    { n: q.warehouse, t: 'سفارش برای آماده‌سازی و ارسال', s: 'warehouse', show: role !== 'SALES' },
    { n: q.needsFix, t: 'برگشت‌خورده برای اصلاح', s: 'approvals', show: role !== 'WAREHOUSE' },
  ].filter(x => x.show);
  const max = Math.max(1, ...data.daily.map(d => d.n));
  const money = role !== 'WAREHOUSE';

  return (
    <>
      <div className="head"><h1>پیشخوان</h1><span className="muted small">{new Date().toLocaleDateString('fa-IR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span></div>
      <section className="kpis">
        <div className="kpi"><span>سفارش امروز</span><b className="num">{fa(data.orders.today)}</b><small>{fa(data.orders.last30)} سفارش در ۳۰ روز</small></div>
        <div className="kpi"><span>سفارش باز</span><b className="num">{fa(data.orders.open)}</b><small>{fa(data.orders.delivered)} تحویل‌شده تاکنون</small></div>
        {money && <div className="kpi"><span>مانده‌ی طلب از مشتریان</span><b className="num">{fa(data.money.receivable)}</b><small>ریال، از {fa(data.money.invoiced)} فاکتورشده</small></div>}
        {money && <div className="kpi"><span>چک‌های سررسید ۷ روز آینده</span><b className="num">{fa(data.money.chequesDue7Count)}</b><small>{rial(data.money.chequesDue7)}</small></div>}
        {!money && <div className="kpi"><span>مشتریان فعال</span><b className="num">{fa(data.customers)}</b><small>تأییدشده</small></div>}
      </section>

      <div className="grid2">
        <section className="card">
          <div className="cardhead"><h2>کارهای منتظر</h2><span className="muted small">{fa(tasks.reduce((a, x) => a + x.n, 0))} مورد</span></div>
          <div className="tasks">
            {tasks.map(x => (
              <button key={x.t} type="button" className={x.n ? 'task hot' : 'task'} onClick={() => open(x.s)}>
                <b className="num">{fa(x.n)}</b><span>{x.t}</span><Icon n="arrow" s={16} />
              </button>
            ))}
          </div>
        </section>
        <section className="card">
          <div className="cardhead"><h2>سفارش‌های ۱۴ روز اخیر</h2></div>
          <div className="bars" role="img" aria-label="تعداد سفارش روزانه">
            {data.daily.length === 0 ? <div className="muted small" style={{ padding: 16 }}>هنوز سفارشی ثبت نشده است.</div> :
              data.daily.map(d => <div key={d.d} title={`${new Date(d.d).toLocaleDateString('fa-IR')}: ${fa(d.n)}`}><i style={{ height: `${(d.n / max) * 100}%` }} /><span className="num">{new Date(d.d).toLocaleDateString('fa-IR', { day: 'numeric' })}</span></div>)}
          </div>
          <dl className="kv pad" style={{ borderTop: '1px solid var(--line)' }}>
            <dt>لیست قیمت فعال</dt><dd>{data.catalog.activeList ? `${data.catalog.activeList.title}${data.catalog.activeList.publishedAt ? ' · ' + dateFa(data.catalog.activeList.publishedAt) : ''}` : 'ندارد'}</dd>
            <dt>کالاها (سایز)</dt><dd className="num">{fa(data.catalog.variants)} · {fa(data.catalog.inquiry)} استعلامی</dd>
            <dt>مشتریان تأییدشده</dt><dd className="num">{fa(data.customers)}</dd>
          </dl>
        </section>
      </div>

      <section className="card">
        <div className="cardhead"><h2>آخرین سفارش‌ها</h2>{role !== 'WAREHOUSE' && <button type="button" className="btn sm" onClick={() => open('approvals')}>همه</button>}</div>
        {data.recent.length === 0 ? <div className="empty small" style={{ margin: 12 }}>سفارشی نیست.</div> : (
          <div className="tablewrap"><table>
            <thead><tr><th>شماره</th><th>مشتری</th><th>اقلام</th><th>وضعیت</th><th>زمان</th></tr></thead>
            <tbody>{data.recent.map(o => (
              <tr key={o.id}><td className="num">{fa(o.number)}</td><td>{o.customer.name}</td><td className="num">{fa(o._count.items)}</td><td><span className={`st ${STATUS_CLASS(o.status)}`}>{STATUS_FA[o.status] ?? o.status}</span></td><td className="muted small nowrap">{dateFa(o.createdAt)}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
