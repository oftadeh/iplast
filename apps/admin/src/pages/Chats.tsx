import { useEffect, useRef, useState } from 'react';
import { ApiError, api, dateFa, personName, useApi, useBlobUrl } from '../lib';
import { useAdmin } from '../App';
import { Icon } from '../icons';

interface ConvRow {
  id: string; isOpen: boolean; updatedAt: string; customer: { id: string; name: string } | null;
  user: { firstName: string | null; lastName: string | null; username: string | null } | null;
  assignee: { firstName: string | null; lastName: string | null } | null;
  last: { direction: 'IN' | 'OUT'; kind: string; text: string | null; createdAt: string } | null;
}
interface Msg { id: string; direction: 'IN' | 'OUT'; kind: 'TEXT' | 'VOICE' | 'PHOTO' | 'DOCUMENT'; text: string | null; telegramFileId: string | null; createdAt: string; by: string | null }
interface Conv { id: string; isOpen: boolean; customer: { id: string; name: string } | null; user: ConvRow['user']; messages: Msg[] }
const KIND_FA: Record<string, string> = { VOICE: '🎙 پیام صوتی', PHOTO: '🖼 عکس', DOCUMENT: '📄 فایل', TEXT: '' };
const isAi = (t: string | null) => !!t?.startsWith('[دستیار]');
const waiting = (c: ConvRow) => c.isOpen && c.last?.direction === 'IN';

/** Customer chats from the bot and the mini app, answered from here (delivered through the bot). */
export function ChatsPage({ focus, onFocus }: { focus?: string; onFocus: (id?: string) => void }) {
  const { me } = useAdmin();
  const [filter, setFilter] = useState<'open' | 'mine' | 'all'>('open');
  const q = filter === 'open' ? '?open=1' : filter === 'mine' ? '?mine=1' : '';
  const list = useApi<ConvRow[]>(`/admin/conversations${q}`);
  useEffect(() => { const t = window.setInterval(list.reload, 8000); return () => window.clearInterval(t); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = list.data ?? [];

  return (
    <>
      <div className="head"><h1>گفتگوها</h1>
        <div className="chips">
          {([['open', 'باز'], ['mine', 'گفتگوهای من'], ['all', 'همه']] as const).map(([k, t]) => (
            <button key={k} type="button" className="chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>{t}</button>
          ))}
        </div>
      </div>
      <div className="chatgrid">
        <section className={`card convlist ${focus ? 'hide-sm' : ''}`}>
          {list.error && <div className="err" style={{ margin: 12 }}>{list.error}</div>}
          {!list.data && !list.error && <div className="empty small" style={{ margin: 12 }}>در حال بارگذاری…</div>}
          {list.data && rows.length === 0 && <div className="empty small" style={{ margin: 12 }}>گفتگویی نیست.</div>}
          {rows.map(c => (
            <button key={c.id} type="button" className="conv" aria-current={c.id === focus ? 'true' : undefined} onClick={() => onFocus(c.id)}>
              <span className="avatar sm">{(c.customer?.name ?? personName(c.user)).slice(0, 1)}</span>
              <span className="ci">
                <span className="between"><b>{c.customer?.name ?? personName(c.user)}</b><small className="muted num">{c.last ? dateFa(c.last.createdAt) : ''}</small></span>
                <span className="muted small clamp1">{c.last ? `${c.last.direction === 'OUT' ? (isAi(c.last.text) ? 'دستیار: ' : 'شما: ') : ''}${(c.last.text ?? KIND_FA[c.last.kind]).replace(/^\[دستیار\]\n?/, '')}` : '—'}</span>
              </span>
              {waiting(c) && <span className="dot" aria-label="منتظر پاسخ" />}
            </button>
          ))}
        </section>
        <section className={`card thread ${focus ? '' : 'hide-sm'}`}>
          {focus ? <Thread id={focus} onBack={() => onFocus(undefined)} onChange={list.reload} meId={me.id} /> : <div className="empty" style={{ margin: 16 }}>یک گفتگو را انتخاب کنید.</div>}
        </section>
      </div>
    </>
  );
}

function Thread({ id, onBack, onChange }: { id: string; onBack: () => void; onChange: () => void; meId: string }) {
  const { toast } = useAdmin();
  const c = useApi<Conv>(`/admin/conversations/${id}`);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { const t = window.setInterval(c.reload, 6000); return () => window.clearInterval(t); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [c.data?.messages.length]);

  const send = async () => {
    const t = text.trim(); if (!t) return;
    setBusy(true);
    try { await api(`/admin/conversations/${id}/reply`, { method: 'POST', body: { text: t } }); setText(''); c.reload(); onChange(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'ارسال نشد'); }
    finally { setBusy(false); }
  };
  const close = async (open: boolean) => { await api(`/admin/conversations/${id}`, { method: 'PATCH', body: { isOpen: open } }); c.reload(); onChange(); };

  if (c.error) return <div className="err" style={{ margin: 12 }}>{c.error}</div>;
  if (!c.data) return <div className="empty small" style={{ margin: 12 }}>در حال بارگذاری…</div>;
  const d = c.data;
  return (
    <>
      <div className="cardhead">
        <div className="row"><button type="button" className="btn sm show-sm" onClick={onBack}>→</button>
          <div><b>{d.customer?.name ?? personName(d.user)}</b><div className="muted small">{personName(d.user)}{d.user?.username ? ` · @${d.user.username}` : ''}</div></div></div>
        <button type="button" className="btn sm" onClick={() => close(!d.isOpen)}>{d.isOpen ? 'بستن گفتگو' : 'باز کردن دوباره'}</button>
      </div>
      <div className="msgs">
        {d.messages.map(m => (
          <div key={m.id} className={`msg ${m.direction === 'IN' ? 'in' : isAi(m.text) ? 'ai' : 'out'}`}>
            <div className="who small">{m.direction === 'IN' ? 'مشتری' : isAi(m.text) ? <><Icon n="spark" s={12} /> دستیار هوشمند</> : m.by ?? 'کارشناس'} · <span className="num">{dateFa(m.createdAt)}</span></div>
            {m.text && <div className="txt">{m.text.replace(/^\[دستیار\]\n?/, '')}</div>}
            {m.telegramFileId && <MsgFile id={m.id} kind={m.kind} />}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form className="reply" onSubmit={e => { e.preventDefault(); send(); }}>
        <textarea className="in" rows={2} placeholder="پاسخ به مشتری (از طریق ربات به تلگرام او می‌رسد)" value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }} />
        <button type="submit" className="btn primary" disabled={busy || !text.trim()}><Icon n="send" s={16} /> ارسال</button>
      </form>
    </>
  );
}

function MsgFile({ id, kind }: { id: string; kind: string }) {
  const url = useBlobUrl(`/admin/conversations/files/${id}`);
  if (!url) return <div className="muted small">{KIND_FA[kind] || 'فایل'}…</div>;
  if (kind === 'PHOTO') return <img src={url} alt="" className="msgimg" />;
  if (kind === 'VOICE') return <audio controls src={url} style={{ width: '100%' }} />;
  return <a href={url} target="_blank" rel="noreferrer" className="btn sm">باز کردن فایل</a>;
}
