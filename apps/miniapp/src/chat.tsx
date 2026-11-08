import { useEffect, useRef, useState } from 'react';
import { ApiError, api, fa, getToken, personName } from './lib';
import { useApp } from './App';
import { Icon } from './icons';
import { haptic } from './telegram';
import type { DraftView } from './screens';

interface ChatMsg { id: string; direction: 'IN' | 'OUT'; kind: 'TEXT' | 'VOICE' | 'PHOTO' | 'DOCUMENT'; text: string | null; hasFile: boolean; createdAt: string }
interface ChatData { staff: boolean; ai: boolean; agent: { firstName: string | null; lastName: string | null } | null; messages: ChatMsg[] }
const KIND_FA = { VOICE: '🎙 پیام صوتی', PHOTO: '🖼 عکس', DOCUMENT: '📄 فایل', TEXT: '' };
const time = (d: string) => new Date(d).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });

/** Chat with the sales agent inside the mini app; the order assistant answers order-like messages with a draft cart. */
export function ChatScreen() {
  const { authed, cart, setCart, go, toast } = useApp();
  const [data, setData] = useState<ChatData | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DraftView>>({});
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  const load = () => api<ChatData>('/me/chat').then(setData, () => {});
  useEffect(() => {
    if (!authed) return;
    load();
    const t = window.setInterval(load, 6000); // agent answers arrive while the chat is open
    return () => window.clearInterval(t);
  }, [authed]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [data?.messages.length, busy]);

  const send = async () => {
    const t = text.trim(); if (!t || busy) return;
    setBusy(true); setText('');
    try {
      const r = await api<ChatData & { draft: DraftView | null }>('/me/chat', { method: 'POST', body: { text: t } });
      setData(r); haptic('success');
      if (r.draft) { const last = r.messages[r.messages.length - 1]; if (last) setDrafts(d => ({ ...d, [last.id]: r.draft! })); }
    } catch (e) { setText(t); toast(e instanceof ApiError ? e.message : 'ارسال نشد'); haptic('error'); }
    finally { setBusy(false); }
  };
  const addAll = (d: DraftView) => {
    let next = [...cart];
    for (const l of d.lines) {
      const line = { variantId: l.variantId, slug: l.slug, name: l.name, label: l.label, photo: l.photo, perPack: l.perPack, packName: l.packName, unitName: l.unitName, price: l.price, n: l.n, mode: l.mode };
      const ex = next.findIndex(c => c.variantId === line.variantId && c.mode === line.mode);
      next = ex >= 0 ? next.map((c, i) => (i === ex ? { ...c, n: c.n + line.n } : c)) : [...next, line];
    }
    setCart(next); haptic('success'); go({ name: 'cart' });
  };

  if (authed === false) return <div className="pad"><div className="notice">برای گفتگو، مینی‌اپ را از داخل ربات تلگرام باز کنید.</div></div>;
  if (data?.staff) return (
    <div className="pad" style={{ paddingTop: 24 }}>
      <div className="notice">شما جزو کارکنان هستید. پیام مشتری‌ها را در <b>پنل مدیریت ← گفتگوها</b> ببینید و پاسخ دهید.</div>
      <a className="cta" style={{ marginTop: 12 }} href="/admin/#chats">باز کردن گفتگوها در پنل مدیریت</a>
    </div>
  );
  const agentName = data?.agent ? personName(data.agent) : null;

  return (
    <>
      <div className="chat-top">
        <div className="ava"><Icon n="chat" s={20} /></div>
        <div><b>{agentName ?? 'کارشناس فروش'}</b><small>{data?.ai ? 'کارشناس فروش + دستیار هوشمند سفارش' : 'کارشناس فروش اصفهان پلاست'}</small></div>
      </div>
      <div className="chat">
        {!data && <div className="skel" style={{ height: 80 }} />}
        {data && data.messages.length === 0 && (
          <div className="bot"><div className="hd"><Icon n="chat" s={14} /> اصفهان پلاست</div>
            <div>سلام! سؤال یا سفارشتان را بنویسید. کارشناس فروش همین‌جا جواب می‌دهد{data.ai ? ' و اگر سفارش بنویسید، دستیار هوشمند فوراً پیش‌نویس سبد را آماده می‌کند' : ''}.</div>
          </div>
        )}
        {data?.messages.map(m => {
          const isAi = m.direction === 'OUT' && m.text?.startsWith('[دستیار]');
          const body = (isAi ? m.text!.replace(/^\[دستیار\]\n?/, '') : m.text) || KIND_FA[m.kind];
          if (m.direction === 'IN') return (
            <div key={m.id} style={{ display: 'contents' }}>
              <div className="me">{body}<span className="tm num">{time(m.createdAt)}</span></div>
              {drafts[m.id] && <DraftCard d={drafts[m.id]} onAdd={addAll} />}
            </div>
          );
          return (
            <div key={m.id} className="bot">
              <div className="hd"><Icon n="chat" s={14} /> {isAi ? 'دستیار هوشمند' : agentName ?? 'کارشناس فروش'}<span className="tm num">{time(m.createdAt)}</span></div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{body}</div>
              {m.hasFile && m.kind === 'PHOTO' && <FileImg id={m.id} />}
              {m.hasFile && m.kind === 'VOICE' && <FileAudio id={m.id} />}
            </div>
          );
        })}
        {busy && <div className="bot"><div className="skel" style={{ height: 18 }} /></div>}
        <div ref={end} />
      </div>
      <div className="composer chat-composer">
        <textarea rows={1} aria-label="پیام" placeholder={data?.ai ? 'پیام یا سفارشتان را بنویسید' : 'پیام به کارشناس فروش'} value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} disabled={!authed} />
        {data?.ai && <button type="button" className="icb" aria-label="سفارش صوتی با دستیار" onClick={() => go({ name: 'assistant' })}><Icon n="mic" s={18} /></button>}
        <button type="button" className="icb send" aria-label="ارسال" disabled={!authed || busy || !text.trim()} onClick={send}><Icon n="send" s={18} /></button>
      </div>
    </>
  );
}

function DraftCard({ d, onAdd }: { d: DraftView; onAdd: (d: DraftView) => void }) {
  return (
    <div className="bot">
      <div className="hd"><Icon n="chat" s={14} /> پیش‌نویس دستیار</div>
      {d.lines.map(l => (
        <div className="it" key={l.variantId + l.mode}>
          <div className="r1"><b>{l.name} <bdi>{l.label}</bdi></b><span className={`st ${l.price ? 'ok' : 'ask'}`}>{l.price ? 'قیمت‌دار' : 'استعلامی'}</span></div>
          <span className="from num">{l.mode === 'pack' ? `${fa(l.n)} ${l.packName ?? 'بسته'} = ${fa(l.quantity)} ${l.unitName}` : `${fa(l.quantity)} ${l.unitName}`}</span>
        </div>
      ))}
      <div className="tot"><span>جمع تقریبی</span><b className="num">{fa(d.total)} ریال</b></div>
      <button type="button" className="cta" style={{ marginTop: 8 }} onClick={() => onAdd(d)}><span>افزودن به سبد</span><small className="num">{fa(d.lines.length)} قلم</small></button>
    </div>
  );
}

function useFile(id: string) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let made: string | null = null;
    fetch(`/api/me/chat/files/${id}`, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
      .then(r => (r.ok ? r.blob() : null)).then(b => { if (b) { made = URL.createObjectURL(b); setUrl(made); } }).catch(() => {});
    return () => { if (made) URL.revokeObjectURL(made); };
  }, [id]);
  return url;
}
function FileImg({ id }: { id: string }) { const u = useFile(id); return u ? <img src={u} alt="" style={{ width: '100%', borderRadius: 12, marginTop: 6 }} /> : null; }
function FileAudio({ id }: { id: string }) { const u = useFile(id); return u ? <audio controls src={u} style={{ width: '100%', marginTop: 6 }} /> : null; }
