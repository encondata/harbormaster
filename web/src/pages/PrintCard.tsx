import { useQuery } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api, type Card } from '../api';
import { ErrorBox, Spinner } from '../components/ui';

/** Card descriptions are markdown; on paper we want just the words. */
function plainText(md: string) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * A kanban card laid out for a 5×3 in index card (landscape), with a QR code that opens the card.
 * Opened in its own tab from the card drawer; prints itself once the QR code is ready.
 */
export default function PrintCard() {
  const { key = '' } = useParams();
  const [sp] = useSearchParams();
  // Only card keys like "SS-42" reach the API, and always encoded, so a crafted URL can't steer the request elsewhere.
  const valid = /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(key);
  const path = `/api/cards/${encodeURIComponent(key)}`;
  const card = useQuery({ queryKey: ['card', key], enabled: valid, queryFn: () => api.get<Card>(path) });
  const link = useQuery({ queryKey: ['card-link', key], enabled: valid, queryFn: () => api.post<{ url: string }>(`${path}/link`, {}), staleTime: Infinity });
  const [qr, setQr] = useState<string | null>(null);
  const notesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!link.data) return;
    QRCode.toString(link.data.url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }).then(setQr);
  }, [link.data]);

  const ready = !!card.data && !!qr;
  // Cut the description off with "…" at however many whole lines fit under the title.
  useLayoutEffect(() => {
    const el = notesRef.current;
    if (!el) return;
    const lines = Math.max(1, Math.floor(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight)));
    el.style.setProperty('-webkit-line-clamp', String(lines));
  }, [ready]);
  useEffect(() => {
    if (!ready || sp.get('autoprint') !== '1') return;
    document.title = `${card.data!.key} card`;
    // Let the logo image load before the print dialog snapshots the page.
    const t = setTimeout(() => window.print(), 300);
    return () => clearTimeout(t);
  }, [ready, sp, card.data]);

  if (!valid) return <div className="page"><div className="empty">Card not found</div></div>;
  if (card.error || link.error) return <div className="page"><ErrorBox error={card.error ?? link.error} /></div>;
  if (!ready) return <Spinner />;
  const c = card.data!;

  return (
    <div className="print-shell">
      <div className="print-toolbar">
        <div>
          <strong>Print {c.key}</strong>
          <div className="faint small">Paper size 3×5 in (index card), landscape, scale 100%, margins none.</div>
        </div>
        <button className="btn primary" onClick={() => window.print()}>Print</button>
      </div>
      <div className="index-card">
        <img className="ic-logo" src="/card-logo.png" alt="" />
        <div className="ic-qr">
          <img className="ic-qr-code" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr!)}`} alt={`QR code for ${c.key}`} />
          <div className="ic-key">{c.key}</div>
        </div>
        <div className="ic-line"><span className="ic-lbl">System:</span><span className="ic-val">{c.area_name ?? ''}</span></div>
        <div className="ic-line ic-sub"><span className="ic-lbl">Sub:</span><span className="ic-val">{c.title}</span></div>
        <div className="ic-rule" />
        <div className="ic-lbl">Notes:</div>
        <div className="ic-notes" ref={notesRef}>{plainText(c.description)}</div>
      </div>
    </div>
  );
}
