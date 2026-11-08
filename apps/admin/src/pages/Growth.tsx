import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useAdmin } from '../App';
import { ApiError, api, fa, toEnDigits, useApi } from '../lib';

export interface Growth {
  bot: string; botLink: string; appBonusPct: number; intro: 'custom' | 'default' | 'off';
  staff: { id: string; name: string; role: string; link: string; joined: number; customers: number; me: boolean }[];
}
const err = (e: unknown) => (e instanceof ApiError ? e.message : 'ذخیره نشد');

/** A QR code of a link, drawn in the page; «دانلود» saves it as a PNG for print (invoices, cartons, business cards). */
export function Qr({ link, name, size = 168 }: { link: string; name: string; size?: number }) {
  const [src, setSrc] = useState('');
  useEffect(() => { QRCode.toDataURL(link, { width: 640, margin: 1, color: { dark: '#0F1420', light: '#FFFFFF' } }).then(setSrc, () => setSrc('')); }, [link]);
  if (!src) return <div className="qr" style={{ width: size, height: size }} />;
  return (
    <div className="qrbox">
      <img className="qr" src={src} width={size} height={size} alt={`QR کد ${name}`} />
      <a className="btn sm" href={src} download={`${name}.png`}>دانلود برای چاپ</a>
    </div>
  );
}

/** The staff member's own invite link: copy it, send it, or print its QR code. */
export function InviteCard({ g, compact }: { g: Growth; compact?: boolean }) {
  const { toast } = useAdmin();
  const mine = g.staff.find(s => s.me);
  if (!mine) return null;
  const copy = async () => { try { await navigator.clipboard.writeText(mine.link); toast('لینک کپی شد'); } catch { toast(mine.link); } };
  const text = encodeURIComponent('برای دیدن قیمت‌ها و ثبت سفارش اصفهان پلاست، از این لینک وارد شوید:');
  return (
    <section className={`card invite ${compact ? 'compact' : ''}`}>
      <div className="cardhead"><h2>لینک دعوت شما</h2><span className="muted small num">{fa(mine.joined)} نفر با این لینک آمده‌اند</span></div>
      <div className="invite-body">
        <div className="stack">
          <p className="small muted" style={{ margin: 0 }}>هر مشتری که با این لینک وارد ربات شود، خودکار مشتری شما ثبت می‌شود و پیش‌فاکتورهایش برای شما می‌آید.</p>
          <code className="linkbox" dir="ltr">{mine.link}</code>
          <div className="row">
            <button type="button" className="btn primary sm" onClick={copy}>کپی لینک</button>
            <a className="btn sm" href={`https://t.me/share/url?url=${encodeURIComponent(mine.link)}&text=${text}`} target="_blank" rel="noreferrer">ارسال در تلگرام</a>
          </div>
        </div>
        <Qr link={mine.link} name={`iplast-${mine.name}`} size={compact ? 116 : 150} />
      </div>
    </section>
  );
}

/** «جذب مشتری»: invite links and QR codes, the app-order discount, the intro video and the price-change notice. */
export function GrowthPage() {
  const { me, toast } = useAdmin();
  const g = useApi<Growth>('/admin/growth');
  const admin = me.staffRole === 'ADMIN';
  const [bonus, setBonus] = useState<string | null>(null);
  if (g.error) return <div className="err">{g.error}</div>;
  if (!g.data) return <div className="empty">در حال بارگذاری…</div>;
  const d = g.data;
  const save = async (body: object, ok: string) => { try { await api('/admin/growth', { method: 'PUT', body }); toast(ok); setBonus(null); g.reload(); } catch (e) { toast(err(e)); } };

  return (
    <>
      <div className="head"><h1>جذب مشتری</h1><span className="muted small">آوردن مشتری و کارشناس‌ها به ربات و پنل کاربری</span></div>
      <div className="grid2">
        <InviteCard g={d} />
        <section className="card">
          <div className="cardhead"><h2>QR کد ربات</h2><span className="muted small" dir="ltr">@{d.bot}</span></div>
          <div className="invite-body">
            <p className="small muted" style={{ margin: 0 }}>برای چاپ روی فاکتور کاغذی، کارتن‌ها، بنر فروشگاه و کارت ویزیت. هر کس اسکن کند، ربات و پنل کاربری برایش باز می‌شود.</p>
            <Qr link={d.botLink} name="iplast-bot" />
          </div>
        </section>
      </div>

      {admin && (
        <div className="grid2">
          <section className="card pad stack">
            <h2>تخفیف سفارش از اپ</h2>
            <p className="small muted" style={{ margin: 0 }}>سفارشی که مشتری خودش در پنل کاربری ثبت کند، این درصد تخفیف بیشتر می‌گیرد (روی جمع اقلام قیمت‌دار). در سبد و صفحه‌ی اول پنل کاربری هم اعلام می‌شود. کارشناس در پیش‌فاکتور می‌تواند تغییرش دهد.</p>
            <div className="row">
              <input className="in num" style={{ width: 110 }} inputMode="decimal" value={bonus ?? (d.appBonusPct ? fa(d.appBonusPct) : '')} onChange={e => setBonus(e.target.value)} placeholder="۰" />
              <span className="small">درصد</span>
              <button type="button" className="btn primary" disabled={bonus === null} onClick={() => save({ appBonusPct: toEnDigits(bonus ?? '0') || '0' }, 'تخفیف سفارش از اپ ذخیره شد')}>ذخیره</button>
            </div>
            <span className="small">{d.appBonusPct ? <>الان: <b className="num">{fa(d.appBonusPct)}٪</b> تخفیف برای سفارش از اپ</> : <span className="muted">الان خاموش است.</span>}</span>
          </section>
          <section className="card pad stack">
            <h2>ویدیوی آموزشی</h2>
            <p className="small muted" style={{ margin: 0 }}>هر مشتری بار اول که /start بزند، بعد از پیام خوش‌آمد این ویدیو را می‌گیرد؛ با /video هم هر وقت بخواهد. در صفحه‌ی اول پنل کاربری هم کارت «آموزش» دارد. برای ویدیوی دیگر، آن را در ربات برای خودتان بفرستید با کپشن <b>#آموزش</b>.</p>
            <span className="small">{d.intro === 'custom' ? <><span className="st ok">فعال</span> ویدیویی که خودتان فرستادید</> : d.intro === 'default' ? <><span className="st ok">فعال</span> ویدیوی معرفی اصفهان پلاست (پیش‌فرض)</> : <span className="st gray">خاموش</span>}</span>
            <div className="row">
              {d.intro !== 'off' && <button type="button" className="btn sm danger" onClick={() => confirm('ارسال ویدیو به مشتری‌های جدید خاموش شود؟') && save({ clearIntro: true }, 'ویدیو خاموش شد')}>خاموش کردن</button>}
              {d.intro !== 'default' && <button type="button" className="btn sm" onClick={() => save({ introDefault: true }, 'ویدیوی پیش‌فرض فعال شد')}>استفاده از ویدیوی پیش‌فرض</button>}
              <a className="btn sm" href="/intro.mp4" target="_blank" rel="noreferrer">دیدن ویدیوی پیش‌فرض</a>
            </div>
          </section>
        </div>
      )}

      {admin && <PriceNotice />}

      {admin && (
        <section className="card">
          <div className="cardhead"><h2>لینک دعوت کارکنان</h2><span className="muted small">برای هر کارشناس، لینک و QR جدا</span></div>
          <div className="tablewrap"><table>
            <thead><tr><th>نام</th><th>آمده با لینک</th><th>مشتریان</th><th>لینک</th><th /></tr></thead>
            <tbody>{d.staff.map(s => (
              <tr key={s.id}>
                <td><b>{s.name}</b> <span className="muted small">{s.role === 'ADMIN' ? 'مدیر' : 'کارشناس فروش'}</span></td>
                <td className="num">{fa(s.joined)}</td>
                <td className="num">{fa(s.customers)}</td>
                <td><code className="small" dir="ltr">{s.link.replace('https://', '')}</code></td>
                <td><button type="button" className="btn sm" onClick={() => navigator.clipboard?.writeText(s.link).then(() => toast('لینک کپی شد'), () => toast(s.link))}>کپی</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        </section>
      )}
    </>
  );
}

/** Tell every customer that prices change on a day (so they order before), or that a new list is out. */
export function PriceNotice() {
  const { toast } = useAdmin();
  const [kind, setKind] = useState<'upcoming' | 'new'>('upcoming');
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const count = useApi<{ count: number }>('/admin/broadcasts/count?audience=customers');
  const preview = kind === 'upcoming'
    ? `⏰ قیمت‌ها از ${when || '…'} تغییر می‌کند.\n\nتا آن روز می‌توانید با قیمت فعلی سفارش دهید؛ سفارش‌هایی که پیش از تغییر ثبت شوند با قیمت امروز پیش‌فاکتور می‌شوند.`
    : '🏷 لیست قیمت جدید منتشر شد.\n\nقیمت‌های روز با درصد و شرایط خودتان در پنل کاربری است.';
  const send = async () => {
    if (!confirm(`این خبر برای ${fa(count.data?.count ?? 0)} نفر فرستاده شود؟`)) return;
    setBusy(true);
    try { const r = await api<{ recipients: number }>('/admin/broadcasts/price-notice', { method: 'POST', body: { kind, when, note } }); toast(`در حال ارسال برای ${fa(r.recipients)} نفر`); setWhen(''); setNote(''); }
    catch (e) { toast(err(e)); } finally { setBusy(false); }
  };
  return (
    <section className="card pad stack">
      <div className="between"><h2>خبر تغییر قیمت به مشتری‌ها</h2><span className="muted small num">{count.data ? `${fa(count.data.count)} گیرنده` : ''}</span></div>
      <div className="seg" role="group">
        <button type="button" aria-pressed={kind === 'upcoming'} onClick={() => setKind('upcoming')}>قیمت‌ها تغییر می‌کند</button>
        <button type="button" aria-pressed={kind === 'new'} onClick={() => setKind('new')}>لیست جدید منتشر شد</button>
      </div>
      <div className="row2">
        {kind === 'upcoming' && <label className="stack small">از چه روزی؟<input className="in" value={when} onChange={e => setWhen(e.target.value)} placeholder="مثلاً شنبه ۲۰ آبان" maxLength={60} /></label>}
        <label className="stack small">توضیح اضافه (اختیاری)<input className="in" value={note} onChange={e => setNote(e.target.value)} placeholder="مثلاً: افزایش حدود ۸٪ برای اتصالات" maxLength={600} /></label>
      </div>
      <div className="preview">
        <span className="muted small">پیش‌نمایش در ربات</span>
        <div className="bubble"><b>📢 پیام اصفهان پلاست</b>{'\n\n'}{preview}{note ? `\n\n${note}` : ''}</div>
        <div className="bubble-btn">📱 ورود به پنل کاربری</div>
      </div>
      <button type="button" className="btn primary" style={{ justifySelf: 'start' }} disabled={busy || (kind === 'upcoming' && !when.trim()) || !count.data?.count} onClick={send}>{busy ? 'در حال ارسال…' : 'ارسال برای همه‌ی مشتری‌ها'}</button>
    </section>
  );
}
