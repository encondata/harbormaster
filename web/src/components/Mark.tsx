import { useId } from 'react';

/**
 * The HackSpaceLabs H, drawn the same way as in Switchyard and Slipway: warm bands over cool ones,
 * split by a gap that steps up across the crossbar. Drawn on a 700 × 670 grid (the H spans
 * 35–665 × 45–630). Size it with CSS width/height; the aspect ratio is kept.
 */
const markH =
  'M95 45H215L255 85V240H445V85L485 45H605L665 105V570L605 630H485L445 590V465H255V590L215 630H95L35 570V105Z';
// The gap between warm and cool, as a centre line.
const markGap = 'M0 434H168C206 434 206 374 244 374H446C496 374 496 277 546 277H700';
// [colour, lower edge] from the top band down; navy fills the rest.
const markBands: [string, string][] = [
  ['#fbae2c', 'M0 112C150 92 260 138 410 118S610 96 700 100'],
  ['#ffc760', 'M0 176C150 160 260 196 420 170S620 142 700 142'],
  ['#fb7d24', 'M0 272C140 256 260 292 400 276S600 226 700 222'],
  ['#ec2d1d', 'M0 338C150 318 300 352 450 332S620 282 700 277'],
  ['#d81f27', markGap],
  ['#74d4ec', 'M0 470C150 456 280 470 420 440S600 352 700 346'],
  ['#0fb0d6', 'M0 522C160 506 300 520 450 496S620 432 700 422'],
  ['#0a8dba', 'M0 562C160 546 320 560 460 546S620 502 700 496'],
];

export default function Mark({ className = 'logo' }: { className?: string }) {
  const id = 'mark' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    <svg className={className} viewBox="35 45 630 585" aria-hidden="true" focusable="false">
      <mask id={id}>
        <path d={markH} fill="#fff" />
        <path d={markGap} fill="none" stroke="#000" strokeWidth="16" />
      </mask>
      <g mask={`url(#${id})`}>
        <rect x="0" y="0" width="700" height="670" fill="#003e65" />
        {markBands.map(([fill, edge]) => <path key={fill} d={`${edge}V0H0Z`} fill={fill} />).reverse()}
      </g>
    </svg>
  );
}
