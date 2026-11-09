import { useQuery } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api, type Card } from '../api';
import { IndexCard, PageSize } from '../components/IndexCard';
import { ErrorBox, Spinner } from '../components/ui';

const PER_PAGE = 6;
const KEY_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/**
 * Several kanban cards on US Letter, six per page (2 × 3, 4 × 3.5 in cells with cut lines), same design as the 3×5 card.
 * Opened from a board column's print button with ?keys=SS-1,SS-2,…; prints itself once every QR code is ready.
 */
export default function PrintSheet() {
  const { project = '' } = useParams();
  const [sp] = useSearchParams();
  const keys = useMemo(() => (sp.get('keys') ?? '').split(',').filter((k) => KEY_RE.test(k)).slice(0, 300), [sp]);
  const valid = /^[A-Za-z][A-Za-z0-9]*$/.test(project) && keys.length > 0;
  const heading = sp.get('title') ?? 'Cards';

  const cards = useQuery({
    queryKey: ['print-cards', project, keys],
    enabled: valid,
    staleTime: Infinity,
    queryFn: () => api.post<(Card & { link_url: string })[]>(`/api/projects/${encodeURIComponent(project)}/cards/print`, { keys }),
  });
  const [qrs, setQrs] = useState<string[] | null>(null);
  useEffect(() => {
    if (!cards.data) return;
    let live = true;
    Promise.all(cards.data.map((c) => QRCode.toString(c.link_url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' })))
      .then((svgs) => live && setQrs(svgs.map((s) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`)));
    return () => { live = false; };
  }, [cards.data]);

  const ready = !!cards.data && !!qrs;
  useEffect(() => {
    if (!ready || !cards.data!.length || sp.get('autoprint') !== '1') return;
    document.title = `${heading} cards`;
    // Let the logo image load before the print dialog snapshots the page.
    const t = setTimeout(() => window.print(), 400);
    return () => clearTimeout(t);
  }, [ready, sp, heading, cards.data]);

  if (!valid) return <div className="page"><div className="empty">No cards to print</div></div>;
  if (cards.error) return <div className="page"><ErrorBox error={cards.error} /></div>;
  if (!ready) return <Spinner />;
  const list = cards.data!;
  if (!list.length) return <div className="page"><div className="empty">No cards to print</div></div>;

  const pages: (typeof list)[] = [];
  for (let i = 0; i < list.length; i += PER_PAGE) pages.push(list.slice(i, i + PER_PAGE));
  const pageCount = pages.length === 1 ? '1 page' : `${pages.length} pages`;

  return (
    <div className="print-shell">
      <PageSize size="letter" />
      <div className="print-toolbar wide">
        <div>
          <strong>Print {heading}: {list.length} {list.length === 1 ? 'card' : 'cards'}, {pageCount}</strong>
          <div className="faint small">Paper size Letter, portrait, scale 100%, margins none. Choose “Save as PDF” as the printer to get a PDF.</div>
        </div>
        <button className="btn primary" onClick={() => window.print()}>Print</button>
      </div>
      {pages.map((page, p) => (
        <div className="print-sheet" key={p}>
          {page.map((c, i) => (
            <div className="sheet-cell" key={c.id}>
              <IndexCard card={c} qr={qrs![p * PER_PAGE + i]} width="4in" height="3.5in" scale={0.8} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
