import markUrl from '../hsl-ui/mark.svg';

/** The HackSpaceLabs H, from the HSL Suite kit. Decorative: put the name next to it. */
export default function Mark({ size = 34 }: { size?: number }) {
  return <img className="hsl-mark" src={markUrl} width={size} height={Math.round((size * 585) / 630)} alt="" />;
}
