import { useEffect, useState } from 'react';
import { useAdmin } from '../App';
import { ApiError, api, dateFa, useApi } from '../lib';

interface Status { enabled: boolean; pending: boolean; state?: 'ok' | 'error' | 'working'; server?: string; count?: number; message?: string; updatedAt?: string; checkedAt?: string; sourceKind?: string }

/**
 * Outbound proxy (only on servers inside Iran): the bot and the order assistant reach Telegram and OpenAI
 * through a V2Ray subscription. Subscriptions expire, so the manager pastes a new link here.
 */
export function ProxyPage() {
  const { toast } = useAdmin();
  const st = useApi<Status>('/admin/proxy');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const s = st.data;
  const waiting = !!s && (s.pending || s.state === 'working');
  useEffect(() => { if (!waiting) return; const t = setInterval(st.reload, 3000); return () => clearInterval(t); }, [waiting]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true);
    try {
      await api('/admin/proxy', { method: 'POST', body: { source } });
      toast('ثبت شد؛ کانفیگ‌ها در حال آزمایش است'); setSource(''); st.reload();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'ثبت نشد'); } finally { setBusy(false); }
  };

  const tone = !s?.state ? '' : s.state === 'ok' ? 'ok' : s.state === 'error' ? 'no' : 'ask';
  return (
    <>
      <div className="head"><h1>پراکسی سرور</h1></div>
      {s && !s.enabled ? (
        <section className="card pad"><p className="muted" style={{ margin: 0 }}>این سرور مستقیم به تلگرام وصل است و پراکسی لازم ندارد.</p></section>
      ) : (
        <>
          <section className="card pad stack">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <b>وضعیت</b>
              <span className={`st ${tone}`}>{waiting ? 'در حال آزمایش…' : s?.state === 'ok' ? 'فعال' : s?.state === 'error' ? 'قطع' : 'ثبت نشده'}</span>
            </div>
            {s?.server && <div className="small">سرور فعال: <b>{s.server}</b>{s.count ? <span className="muted"> · از {s.count.toLocaleString('fa-IR')} کانفیگ</span> : null}</div>}
            {s?.message && <div className="small muted">{s.message}</div>}
            {s?.checkedAt && <div className="small muted">آخرین بررسی: {dateFa(s.checkedAt)}</div>}
            <p className="small muted" style={{ margin: 0 }}>هر ۵ دقیقه اتصال بررسی می‌شود. اگر سرور فعال قطع شود، سرور دیگری از همان اشتراک خودکار جایگزین می‌شود. وقتی اشتراک تمام شد، لینک جدید را این‌جا بگذارید.</p>
          </section>
          <section className="card pad stack">
            <label className="f"><span>لینک اشتراک جدید یا کانفیگ‌ها</span>
              <textarea className="in" dir="ltr" rows={5} value={source} onChange={e => setSource(e.target.value)} placeholder="https://…/sub/…   یا   vless://…" />
            </label>
            <p className="small muted" style={{ margin: 0 }}>لینک اشتراک V2Ray (https) یا یک یا چند کانفیگ vless / vmess / trojan، هر کدام در یک خط. قبل از فعال شدن، اتصال هر کانفیگ به تلگرام آزمایش می‌شود.</p>
            <div className="row"><button type="button" className="btn" disabled={busy || !source.trim() || waiting} onClick={save}>بارگذاری و فعال‌سازی</button></div>
          </section>
        </>
      )}
    </>
  );
}
