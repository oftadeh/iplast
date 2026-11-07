import { useEffect, useState } from 'react';
import { useAdmin } from '../App';
import { ApiError, api, dateFa, getToken, personName, useApi } from '../lib';

interface Msg { id: string; direction: 'IN' | 'OUT'; kind: 'TEXT' | 'VOICE' | 'PHOTO' | 'DOCUMENT'; text: string | null; telegramFileId: string | null; createdAt: string; by: string | null }
interface Person { firstName: string | null; lastName: string | null; username: string | null }
interface Row { id: string; isOpen: boolean; updatedAt: string; userTelegramId: string; customer: { id: string; name: string } | null; user: Person | null; assignee: { firstName: string | null; lastName: string | null } | null; last: Msg | null }
interface Detail { id: string; isOpen: boolean; userTelegramId: string; customer: { id: string; name: string } | null; user: Person | null; messages: Msg[] }

const KIND_FA = { TEXT: 'متن', VOICE: 'پیام صوتی', PHOTO: 'عکس', DOCUMENT: 'فایل' };

export function ConversationsPage({ focus, onFocus }: { focus?: string; onFocus: (id?: string) => void }) {
  const [mine, setMine] = useState(false);
  const [open, setOpen] = useState('1');
  const list = useApi<Row[]>(`/admin/conversations?mine=${mine ? 1 : 0}&open=${open}`);
  useEffect(() => { const t = setInterval(list.reload, 20_000); return () => clearInterval(t); }, [mine, open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="head"><h1>گفتگوهای ربات</h1>
        <div className="chips">
          <button type="button" className="chip" aria-pressed={open === '1'} onClick={() => setOpen('1')}>باز</button>
          <button type="button" className="chip" aria-pressed={open === '0'} onClick={() => setOpen('0')}>بسته</button>
          <button type="button" className="chip" aria-pressed={open === ''} onClick={() => setOpen('')}>همه</button>
          <button type="button" className="chip" aria-pressed={mine} onClick={() => setMine(!mine)}>فقط گفتگوهای من</button>
        </div>
      </div>
      <div className="note">پیام‌های مشتری در ربات به کارشناس مربوط فرستاده می‌شود و کارشناس می‌تواند در خود تلگرام با Reply جواب دهد. همه‌ی پیام‌ها این‌جا هم ثبت می‌شوند و از همین‌جا هم می‌شود پاسخ متنی داد.</div>
      <div className="grid2">
        <div className="card tablewrap">
          {list.error ? <div className="pad err">{list.error}</div> : !list.data ? <div className="pad muted">در حال بارگذاری…</div> : !list.data.length ? <div className="empty" style={{ border: 0 }}>گفتگویی نیست.</div> : (
            <table><tbody>{list.data.map(c => (
              <tr key={c.id} className="click" aria-selected={c.id === focus} onClick={() => onFocus(c.id)}>
                <td><b>{personName(c.user)}</b>{c.customer && <span className="muted small"> · {c.customer.name}</span>}
                  <div className="small muted" style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.last ? `${c.last.direction === 'OUT' ? 'پاسخ: ' : ''}${c.last.text ?? KIND_FA[c.last.kind]}` : ''}</div></td>
                <td className="small">{c.assignee ? personName(c.assignee) : <span className="muted">بدون کارشناس</span>}</td>
                <td className="small muted num nowrap">{dateFa(c.updatedAt)}</td>
              </tr>
            ))}</tbody></table>
          )}
        </div>
        {focus ? <Thread key={focus} id={focus} onChanged={list.reload} /> : <div className="empty">یک گفتگو را انتخاب کنید.</div>}
      </div>
    </>
  );
}

function Media({ m }: { m: Msg }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const load = async () => {
    try {
      const r = await fetch(`/api/admin/conversations/files/${m.id}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.message ?? 'دریافت نشد');
      setUrl(URL.createObjectURL(await r.blob()));
    } catch (e) { setErr((e as Error).message); }
  };
  useEffect(() => { if (m.kind === 'PHOTO') load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <span className="small" style={{ color: 'var(--bad)' }}>{err}</span>;
  if (!url) return <button type="button" className="btn sm" onClick={load}>{m.kind === 'VOICE' ? 'پخش پیام صوتی' : m.kind === 'DOCUMENT' ? 'باز کردن فایل' : 'نمایش'}</button>;
  if (m.kind === 'PHOTO') return <a href={url} target="_blank" rel="noreferrer"><img src={url} alt="" style={{ maxWidth: 260, borderRadius: 12, display: 'block' }} /></a>;
  if (m.kind === 'VOICE') return <audio src={url} controls autoPlay />;
  return <a className="btn sm" href={url} target="_blank" rel="noreferrer">باز کردن فایل</a>;
}

function Thread({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { toast, open } = useAdmin();
  const d = useApi<Detail>(`/admin/conversations/${id}`);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  if (d.error) return <div className="card pad err">{d.error}</div>;
  if (!d.data) return <div className="card pad muted">در حال بارگذاری…</div>;
  const c = d.data;
  const send = async () => {
    setBusy(true);
    try { await api(`/admin/conversations/${id}/reply`, { method: 'POST', body: { text } }); setText(''); d.reload(); onChanged(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'ارسال نشد'); } finally { setBusy(false); }
  };
  const toggle = async () => { await api(`/admin/conversations/${id}`, { method: 'PATCH', body: { isOpen: !c.isOpen } }); d.reload(); onChanged(); };
  return (
    <div className="card pad stack">
      <div className="between">
        <div><h2>{personName(c.user)}</h2><span className="small muted num" dir="ltr">{c.userTelegramId}{c.user?.username ? ` · @${c.user.username}` : ''}</span></div>
        <div className="row">{c.customer && <button type="button" className="btn sm" onClick={() => open('customers', c.customer!.id)}>{c.customer.name}</button>}
          <button type="button" className="btn sm" onClick={toggle}>{c.isOpen ? 'بستن گفتگو' : 'باز کردن'}</button></div>
      </div>
      <div className="stack" style={{ maxHeight: 520, overflowY: 'auto', gap: 8 }}>
        {c.messages.map(m => (
          <div key={m.id} style={{ alignSelf: m.direction === 'IN' ? 'start' : 'end', maxWidth: '85%', background: m.direction === 'IN' ? 'var(--surface-2)' : 'color-mix(in srgb,var(--brand-2) 12%,var(--surface))', borderRadius: 14, padding: '8px 12px', display: 'grid', gap: 4 }}>
            {m.kind !== 'TEXT' && <span className="small muted">{KIND_FA[m.kind]}</span>}
            {m.telegramFileId && <Media m={m} />}
            {m.text && <span style={{ whiteSpace: 'pre-wrap' }}>{m.text}</span>}
            <span className="small muted num">{m.direction === 'OUT' ? `${m.by ?? 'کارشناس'} · ` : ''}{dateFa(m.createdAt)}</span>
          </div>
        ))}
      </div>
      <textarea className="in" placeholder="پاسخ متنی؛ از طریق ربات برای مشتری فرستاده می‌شود" value={text} onChange={e => setText(e.target.value)} maxLength={3500} />
      <button type="button" className="btn primary" disabled={busy || !text.trim()} onClick={send}>{busy ? 'در حال ارسال…' : 'ارسال پاسخ'}</button>
    </div>
  );
}
