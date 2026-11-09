import { useQuery } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api, type Card } from '../api';
import { ErrorBox, Spinner } from '../components/ui';

/**
 * A kanban card laid out for a 5×3 in index card (landscape), with a QR code that opens the card.
 * Opened in its own tab from the card drawer; prints itself once the QR code is ready.
 */
export default function PrintCard() {
  const { key = '' } = useParams();
  const [sp] = useSearchParams();
  const card = useQuery({ queryKey: ['card', key], queryFn: () => api.get<Card>(`/api/cards/${key}`) });
  const link = useQuery({ queryKey: ['card-link', key], queryFn: () => api.post<{ url: string }>(`/api/cards/${key}/link`, {}), staleTime: Infinity });
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    if (!link.data) return;
    QRCode.toString(link.data.url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }).then(setQr);
  }, [link.data]);

  const ready = !!card.data && !!qr;
  useEffect(() => {
    if (!ready || sp.get('autoprint') !== '1') return;
    document.title = `${card.data!.key} card`;
    // Let the logo image load before the print dialog snapshots the page.
    const t = setTimeout(() => window.print(), 300);
    return () => clearTimeout(t);
  }, [ready, sp, card.data]);

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
      </div>
    </div>
  );
}
