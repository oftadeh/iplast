import { useEffect, useState } from 'react';
import { tg } from './telegram';

interface Family { id: string; slug: string; name: string; model: string | null }

export function App() {
  const [families, setFamilies] = useState<Family[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const app = tg();
    app?.ready(); app?.expand();
    document.documentElement.dataset.theme = app?.colorScheme ?? 'light';
    (async () => {
      try {
        if (app?.initData) {
          const r = await fetch('/api/auth/telegram', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: app.initData }) });
          if (r.ok) sessionStorage.setItem('token', (await r.json()).token);
        }
        const res = await fetch('/api/catalog/families');
        if (!res.ok) throw new Error(String(res.status));
        setFamilies(await res.json());
      } catch {
        setError('اتصال به سرور برقرار نشد.');
      }
    })();
  }, []);

  return (
    <main className="app">
      <h1>محصولات</h1>
      {error && <p className="muted">{error}</p>}
      {!families && !error && <p className="muted">در حال بارگذاری…</p>}
      <div className="grid">
        {families?.map(f => (
          <article key={f.id} className="card"><b>{f.name}</b>{f.model && <small>{f.model}</small>}</article>
        ))}
      </div>
    </main>
  );
}
