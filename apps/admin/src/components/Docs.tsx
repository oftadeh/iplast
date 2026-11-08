import { useRef, useState } from 'react';
import { useAdmin } from '../App';
import { ApiError, apiForm, dayFa, fa, openPrivate, useApi } from '../lib';

export interface Doc { id: string; kind: string; kindFa?: string; title: string | null; mime: string; size: number; byCustomer: boolean; createdAt: string; order?: { number: number } | null; invoice?: { number: number } | null }
export const KIND_FA: Record<string, string> = { RECEIPT: 'فیش واریز', CHEQUE: 'چک', INVOICE: 'فاکتور', WAYBILL: 'بارنامه', CONTRACT: 'قرارداد', OTHER: 'سایر' };

/** Financial documents on a customer's file (photos and PDFs): list, open, upload. */
export function DocsPanel({ customerId, orderId, docs: given, onChanged }: { customerId?: string; orderId?: string; docs?: Doc[]; onChanged?: () => void }) {
  const { toast } = useAdmin();
  const list = useApi<Doc[]>(!given && customerId ? `/admin/customers/${customerId}/documents` : null);
  const docs = given ?? list.data ?? [];
  const [kind, setKind] = useState(orderId ? 'INVOICE' : 'RECEIPT');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const upload = async () => {
    const f = file.current?.files?.[0];
    if (!f) { toast('فایل را انتخاب کنید'); return; }
    const fd = new FormData();
    fd.append('file', f); fd.append('kind', kind); if (title.trim()) fd.append('title', title.trim());
    setBusy(true);
    try {
      await apiForm(orderId ? `/admin/orders/${orderId}/documents` : `/admin/customers/${customerId}/documents`, fd);
      toast('سند ذخیره شد'); setTitle(''); if (file.current) file.current.value = '';
      list.reload(); onChanged?.();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'ثبت نشد'); } finally { setBusy(false); }
  };
  const open = (id: string) => openPrivate(`/admin/documents/${id}/file`).catch(e => toast(e.message));
  return (
    <div className="stack" style={{ gap: 8 }}>
      {!docs.length ? <div className="muted small">سندی پیوست نشده است.</div> : (
        <div className="card plist">
          {docs.map(d => (
            <div key={d.id} className="prow static">
              <button type="button" className="pinfo linkish" onClick={() => open(d.id)}>
                <b>{d.mime === 'application/pdf' ? '📄' : '🖼'} {d.kindFa ?? KIND_FA[d.kind]}{d.title ? ` · ${d.title}` : ''}</b>
                <span className="muted small num">{dayFa(d.createdAt)}{d.order ? ` · سفارش #${fa(d.order.number)}` : ''}{d.invoice ? ` · فاکتور ${fa(d.invoice.number)}` : ''}{d.byCustomer ? ' · از طرف مشتری' : ''} · {fa(Math.max(1, Math.round(d.size / 1024)))} KB</span>
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="docup">
        <select className="in" value={kind} onChange={e => setKind(e.target.value)} aria-label="نوع سند">{Object.entries(KIND_FA).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select>
        <input className="in" value={title} onChange={e => setTitle(e.target.value)} placeholder="عنوان (اختیاری)" maxLength={120} />
        <input ref={file} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="in" aria-label="فایل" />
        <button type="button" className="btn ok-fill" disabled={busy} onClick={upload}>{busy ? 'در حال ارسال…' : 'پیوست سند'}</button>
      </div>
    </div>
  );
}
