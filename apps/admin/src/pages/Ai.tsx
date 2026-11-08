import { useApi, fa, dateFa, STATUS_CLASS } from '../lib';
import { Icon } from '../icons';
import { STATUS_FA } from './Dashboard';

interface AiInfo {
  enabled: boolean; ok: boolean; model: string | null; error?: string; ms?: number; agentOn: boolean;
  stats: { orders: number; chats: number; handoffs: number };
  recent: { id: string; number: number; status: string; createdAt: string; customer: { name: string } }[];
}

/** The AI sales agent: is it connected, what it did, and how the work is split between it and people. */
export function AiPage() {
  const { data, error, reload } = useApi<AiInfo>('/admin/dashboard/ai');
  if (error) return <div className="err">{error}</div>;
  if (!data) return <div className="empty">در حال بررسی اتصال…</div>;
  const live = data.ok && data.agentOn;
  return (
    <>
      <section className="card">
        <div className="cardhead"><h2><Icon n="spark" s={16} /> ایجنت فروش هوش مصنوعی</h2><button type="button" className="btn sm" onClick={reload}>بررسی دوباره</button></div>
        <div className="pad stack">
          <div className="row">{live ? <span className="st ok">فعال و وصل</span> : <span className="st no">{!data.agentOn ? 'خاموش (SALES_AGENT=0)' : 'قطع'}</span>}
            {data.ok && <span className="muted small num">{data.model ?? 'مدل پیش‌فرض'} · {fa(data.ms ?? 0)} میلی‌ثانیه</span>}
            {!data.ok && <span className="small">{data.error}</span>}</div>
          <ol className="flow">
            <li><b>مشتری</b> در ربات یا مینی‌اپ متن یا ویس می‌فرستد.</li>
            <li><b>ایجنت</b> جواب می‌دهد، کالاها را از کاتالوگ و لیست قیمت پیدا می‌کند، پیش‌نویس می‌سازد و بعد از «ثبت کن» مشتری، پیش‌فاکتور را ثبت می‌کند.</li>
            <li><b>کارشناس فروش</b> فقط پیش‌فاکتور را تأیید، اصلاح یا رد می‌کند (سفارش‌ها ← تأیید کارشناس).</li>
            <li><b>مدیر ارشد</b> تأیید نهایی می‌دهد و سفارش به انبار می‌رود.</li>
          </ol>
          <p className="muted small" style={{ margin: 0 }}>اگر مشتری کارشناس بخواهد، عکس یا فایل بفرستد، تخفیف یا شکایت داشته باشد، یا ایجنت جواب را نداند، گفتگو به کارشناس سپرده می‌شود (گفتگوها ← نیاز به کارشناس) و کارشناس در تلگرام هم خبردار می‌شود.</p>
        </div>
      </section>
      <section className="kpis">
        <div className="kpi"><span>پیش‌فاکتور ثبت‌شده توسط ایجنت</span><b className="num">{fa(data.stats.orders)}</b><small>۳۰ روز اخیر</small></div>
        <div className="kpi"><span>گفتگوها</span><b className="num">{fa(data.stats.chats)}</b><small>۳۰ روز اخیر</small></div>
        <div className="kpi"><span>سپرده به کارشناس</span><b className="num">{fa(data.stats.handoffs)}</b><small>{data.stats.chats ? `${fa(Math.round((data.stats.handoffs / data.stats.chats) * 100))}٪ گفتگوها` : '—'}</small></div>
      </section>
      <section className="card">
        <div className="cardhead"><h2>آخرین پیش‌فاکتورهای ایجنت</h2></div>
        {!data.recent.length ? <div className="empty small" style={{ margin: 12 }}>هنوز پیش‌فاکتوری ثبت نکرده است.</div> : (
          <div className="tablewrap"><table>
            <thead><tr><th>شماره</th><th>مشتری</th><th>وضعیت</th><th>زمان</th></tr></thead>
            <tbody>{data.recent.map(o => <tr key={o.id}><td className="num">{fa(o.number)}</td><td>{o.customer.name}</td><td><span className={`st ${STATUS_CLASS(o.status)}`}>{STATUS_FA[o.status] ?? o.status}</span></td><td className="muted small">{dateFa(o.createdAt)}</td></tr>)}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
