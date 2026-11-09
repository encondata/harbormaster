import QRCode from 'qrcode';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Card } from '../api';

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

/** QR code for a card link, as an SVG data URL (null until generated). */
export function useQrDataUrl(url: string | undefined) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }).then((svg) => {
      if (live) setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    });
    return () => { live = false; };
  }, [url]);
  return src;
}

/**
 * The printed card design (System / Sub / Notes, QR top right, the project logo faint and centred behind).
 * Laid out for a 5×3 in card; `scale` shrinks everything for smaller cells, `width`/`height` set the cell.
 */
export function IndexCard({ card, qr, logo, width = '5in', height = '3in', scale = 1 }: { card: Card; qr: string; logo: string; width?: string; height?: string; scale?: number }) {
  const notesRef = useRef<HTMLDivElement>(null);
  // Cut the description off with "…" at however many whole lines fit under the title.
  useLayoutEffect(() => {
    const el = notesRef.current;
    if (!el) return;
    const lines = Math.max(1, Math.floor(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight)));
    el.style.setProperty('-webkit-line-clamp', String(lines));
  }, [card.description, width, height, scale]);

  return (
    <div className="index-card" style={{ width, height, ['--s' as string]: scale }}>
      <img className="ic-logo" src={logo} alt="" onError={(e) => { if (!e.currentTarget.src.endsWith('/card-logo.png')) e.currentTarget.src = '/card-logo.png'; }} />
      <div className="ic-qr">
        <img className="ic-qr-code" src={qr} alt={`QR code for ${card.key}`} />
        <div className="ic-key">{card.key}</div>
      </div>
      <div className="ic-line"><span className="ic-lbl">System:</span><span className="ic-val">{card.area_name ?? ''}</span></div>
      <div className="ic-line ic-sub"><span className="ic-lbl">Sub:</span><span className="ic-val">{card.title}</span></div>
      <div className="ic-rule" />
      <div className="ic-lbl">Notes:</div>
      <div className="ic-notes" ref={notesRef}>{plainText(card.description)}</div>
    </div>
  );
}

/** Opens the print dialog once every image on the page (logos, QR codes) has loaded. */
export async function printWhenImagesLoaded() {
  await Promise.all([...document.images].map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => {}))));
  window.print();
}

/** Sets the printed page size while a print page is mounted. */
export function PageSize({ size }: { size: string }) {
  return <style>{`@media print { @page { size: ${size}; margin: 0; } }`}</style>;
}
