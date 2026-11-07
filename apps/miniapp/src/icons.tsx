const P: Record<string, string> = {
  home: '<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
  cart: '<path d="M4 5h2l2 10h10l2-7H7"/><circle cx="9" cy="19" r="1.4"/><circle cx="17" cy="19" r="1.4"/>',
  box: '<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
  check: '<path d="M5 12l5 5 9-10"/>', arrow: '<path d="M15 6l-6 6 6 6"/>', back: '<path d="M9 6l6 6-6 6"/>',
  truck: '<path d="M3 6h11v9H3zM14 9h4l3 3v3h-7"/><circle cx="7" cy="17" r="1.6"/><circle cx="17" cy="17" r="1.6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  file: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/>',
  send: '<path d="M20 4L3 11l7 2 2 7z"/>',
  pipe: '<path d="M3 9h12a3 3 0 0 1 3 3v0a3 3 0 0 1-3 3H3z"/><ellipse cx="18" cy="12" rx="3" ry="3"/><path d="M7 9v6M11 9v6"/>',
};

export function Icon({ n, s = 20, className }: { n: keyof typeof P | string; s?: number; className?: string }) {
  return (
    <svg className={className} width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: P[n] ?? '' }} />
  );
}

/** Product photo, or a neutral placeholder when the family has no real photo yet (never a fake one). */
export function Photo({ src, cls = 'photo' }: { src: string | null; cls?: string }) {
  if (!src) return <Icon n="pipe" className="noimg" />;
  return <img className={cls} src={src} alt="" loading="lazy" decoding="async" />;
}
