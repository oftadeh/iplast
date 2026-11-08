import { useEffect, useRef, useState } from 'react';
import { ApiError, api, apiForm, fa, getToken, personName } from './lib';
import { useApp } from './App';
import { Icon } from './icons';
import { haptic } from './telegram';
import type { DraftView } from './screens';

interface ChatMsg { id: string; direction: 'IN' | 'OUT'; kind: 'TEXT' | 'VOICE' | 'PHOTO' | 'DOCUMENT'; text: string | null; hasFile: boolean; createdAt: string }
interface ChatData { staff: boolean; ai: boolean; human: boolean; agent: { firstName: string | null; lastName: string | null } | null; messages: ChatMsg[] }
const KIND_FA = { VOICE: '🎙 پیام صوتی', PHOTO: '🖼 عکس', DOCUMENT: '📄 فایل', TEXT: '' };
const time = (d: string) => new Date(d).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });

/** Chat inside the mini app: the AI sales agent answers, builds the order and places the proforma; a person takes over when needed. */
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

  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const turn = async (call: () => Promise<ChatData & { draft: DraftView | null; orderNumber: number | null }>, restore?: string) => {
    setBusy(true);
    try {
      const r = await call();
      setData(r); haptic('success');
      const lastOut = [...r.messages].reverse().find(m => m.direction === 'OUT');
      if (r.draft && lastOut) setDrafts(d => ({ ...d, [lastOut.id]: r.draft! }));
      if (r.orderNumber) toast(`پیش‌فاکتور ${fa(r.orderNumber)} ثبت شد`);
    } catch (e) { if (restore) setText(restore); toast(e instanceof ApiError ? e.message : 'ارسال نشد'); haptic('error'); }
    finally { setBusy(false); }
  };
  const send = () => { const t = text.trim(); if (!t || busy) return; setText(''); turn(() => api('/me/chat', { method: 'POST', body: { text: t } }), t); };
  const record = async () => {
    if (rec) { rec.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream); const chunks: Blob[] = [];
      r.ondataavailable = e => chunks.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach(t => t.stop()); setRec(null);
        const blob = new Blob(chunks, { type: r.mimeType || 'audio/webm' });
        const ext = (r.mimeType || '').includes('mp4') ? 'm4a' : (r.mimeType || '').includes('ogg') ? 'ogg' : 'webm';
        const fd = new FormData(); fd.append('file', blob, `voice.${ext}`);
        turn(() => apiForm('/me/chat/voice', fd));
      };
      r.start(); setRec(r); haptic();
    } catch { toast('دسترسی به میکروفون ممکن نشد'); }
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

  if (authed === false) return <div className="pad"><div className="notice">برای گفتگو، پنل کاربری را از داخل ربات تلگرام باز کنید.</div></div>;
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
        <div><b>{data && data.ai && !data.human ? 'ایجنت فروش هوشمند' : agentName ?? 'کارشناس فروش'}</b>
          <small>{data && data.ai && !data.human ? 'سفارش را کامل و ثبت می‌کند؛ تأیید با کارشناس فروش است' : 'کارشناس فروش اصفهان پلاست'}</small></div>
      </div>
      <div className="chat">
        {!data && <div className="skel" style={{ height: 80 }} />}
        {data && data.messages.length === 0 && (
          <div className="bot"><div className="hd"><Icon n="chat" s={14} /> اصفهان پلاست</div>
            <div>{data.ai ? 'سلام! سفارش یا سؤالتان را بنویسید یا بگویید. سفارش را کامل می‌کنم و بعد از تأیید شما پیش‌فاکتور ثبت می‌شود تا کارشناس فروش تأیید کند. هر وقت خواستید با کارشناس حرف بزنید، بگویید.' : 'سلام! سؤال یا سفارشتان را بنویسید؛ کارشناس فروش همین‌جا جواب می‌دهد.'}</div>
          </div>
        )}
        {data?.messages.map(m => {
          const isAi = m.direction === 'OUT' && m.text?.startsWith('[دستیار]');
          const body = (isAi ? m.text!.replace(/^\[دستیار\]\n?/, '') : m.text) || KIND_FA[m.kind];
          if (m.direction === 'IN') return (
            <div key={m.id} style={{ display: 'contents' }}>
              <div className="me">{body}<span className="tm num">{time(m.createdAt)}</span></div>
            </div>
          );
          return (
            <div key={m.id} className="bot">
              <div className="hd"><Icon n="chat" s={14} /> {isAi ? 'ایجنت فروش' : agentName ?? 'کارشناس فروش'}<span className="tm num">{time(m.createdAt)}</span></div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{body}</div>
              {m.hasFile && m.kind === 'PHOTO' && <FileImg id={m.id} />}
              {m.hasFile && m.kind === 'VOICE' && <FileAudio id={m.id} />}
              {drafts[m.id] && <DraftCard d={drafts[m.id]} onAdd={addAll} inline />}
            </div>
          );
        })}
        {busy && <div className="bot"><div className="skel" style={{ height: 18 }} /></div>}
        <div ref={end} />
      </div>
      <div className="composer chat-composer">
        <textarea rows={1} aria-label="پیام" placeholder={data?.ai ? 'پیام یا سفارشتان را بنویسید' : 'پیام به کارشناس فروش'} value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} disabled={!authed} />
        {typeof MediaRecorder !== 'undefined' && <button type="button" className="icb" aria-label={rec ? 'پایان ضبط و ارسال' : 'پیام صوتی'} disabled={!authed || busy} onClick={record} style={rec ? { background: 'var(--bad)', color: '#fff' } : undefined}><Icon n="mic" s={18} /></button>}
        <button type="button" className="icb send" aria-label="ارسال" disabled={!authed || busy || !text.trim()} onClick={send}><Icon n="send" s={18} /></button>
      </div>
    </>
  );
}

function DraftCard({ d, onAdd, inline }: { d: DraftView; onAdd: (d: DraftView) => void; inline?: boolean }) {
  return (
    <div className={inline ? 'draftin' : 'bot'}>
      <div className="hd"><Icon n="cart" s={14} /> پیش‌نویس سفارش</div>
      {d.lines.map(l => (
        <div className="it" key={l.variantId + l.mode}>
          <div className="r1"><b>{l.name} <bdi>{l.label}</bdi></b><span className={`st ${l.price ? 'ok' : 'ask'}`}>{l.price ? 'قیمت‌دار' : 'استعلامی'}</span></div>
          <span className="from num">{l.mode === 'pack' ? `${fa(l.n)} ${l.packName ?? 'بسته'} = ${fa(l.quantity)} ${l.unitName}` : `${fa(l.quantity)} ${l.unitName}`}</span>
        </div>
      ))}
      <div className="tot"><span>جمع تقریبی</span><b className="num">{fa(d.total)} ریال</b></div>
      <small style={{ color: 'var(--muted)' }}>برای ثبت پیش‌فاکتور بنویسید «ثبت کن»، یا در سبد ویرایش و ثبت کنید.</small>
      <button type="button" className="cta" style={{ marginTop: 8 }} onClick={() => onAdd(d)}><span>ویرایش در سبد</span><small className="num">{fa(d.lines.length)} قلم</small></button>
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
