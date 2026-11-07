import { useState } from 'react';

const SECTIONS = [
  { id: 'orders', title: 'سفارش‌ها', desc: 'بررسی، صدور پیش‌فاکتور ۴۸ ساعته، تغییر وضعیت.' },
  { id: 'customers', title: 'مشتریان', desc: 'تأیید مشتری، کاربران هر مشتری، پشتیبان ثابت، درصد نقد و چک.' },
  { id: 'prices', title: 'لیست قیمت', desc: 'بارگذاری PDF یا Excel، پیش‌نمایش تغییرات و انتشار با تأیید مدیر.' },
  { id: 'catalog', title: 'محصولات', desc: 'خانواده‌ها، سایزها، تعداد در کارتن، عکس‌ها و مترادف‌ها.' },
  { id: 'support', title: 'گفتگوها', desc: 'پیام‌های متن، ویس، عکس و PDF مشتریان از ربات.' },
  { id: 'staff', title: 'پشتیبان‌ها', desc: 'تعریف کارشناسان فروش با آیدی تلگرام و نقش.' },
] as const;

export function App() {
  const [active, setActive] = useState<string>('orders');
  const cur = SECTIONS.find(s => s.id === active)!;
  return (
    <div className="shell">
      <aside>
        <div className="logo">iPlast <small>پنل مدیریت</small></div>
        <nav>{SECTIONS.map(s => (
          <button key={s.id} aria-current={s.id === active ? 'page' : undefined} onClick={() => setActive(s.id)}>{s.title}</button>
        ))}</nav>
      </aside>
      <main>
        <h1>{cur.title}</h1>
        <p className="muted">{cur.desc}</p>
        <div className="empty">این بخش در فاز ۱ ساخته می‌شود.</div>
      </main>
    </div>
  );
}
