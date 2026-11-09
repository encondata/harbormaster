import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api, type Card } from '../api';
import { IndexCard, PageSize, useQrDataUrl } from '../components/IndexCard';
import { ErrorBox, Spinner } from '../components/ui';

/**
 * One kanban card laid out for a 5×3 in index card (landscape), with a QR code that opens the card.
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
  const qr = useQrDataUrl(link.data?.url);

  const ready = !!card.data && !!qr;
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
      <PageSize size="5in 3in" />
      <div className="print-toolbar">
        <div>
          <strong>Print {c.key}</strong>
          <div className="faint small">Paper size 3×5 in (index card), landscape, scale 100%, margins none.</div>
        </div>
        <button className="btn primary" onClick={() => window.print()}>Print</button>
      </div>
      <IndexCard card={c} qr={qr!} />
    </div>
  );
}
