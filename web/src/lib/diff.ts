// Line diff (longest common subsequence) for comparing wiki page versions.
export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string; a?: number; b?: number };

export function diffLines(before: string, after: string): DiffLine[] | null {
  const a = before.split('\n');
  const b = after.split('\n');
  // Trim the shared start and end so the table only covers what changed.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start;
  const m = endB - start;
  if (n * m > 4_000_000) return null; // too big to compare line by line here
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[start + i] === b[start + j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  for (let k = 0; k < start; k++) out.push({ kind: 'same', text: a[k], a: k + 1, b: k + 1 });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) { out.push({ kind: 'same', text: a[start + i], a: start + i + 1, b: start + j + 1 }); i++; j++; }
    else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) { out.push({ kind: 'add', text: b[start + j], b: start + j + 1 }); j++; }
    else { out.push({ kind: 'del', text: a[start + i], a: start + i + 1 }); i++; }
  }
  for (let k = 0; k < a.length - endA; k++) out.push({ kind: 'same', text: a[endA + k], a: endA + k + 1, b: endB + k + 1 });
  return out;
}

/** Keeps changed lines plus `context` lines around them; long unchanged runs become a gap marker (null). */
export function withContext(lines: DiffLine[], context = 3): (DiffLine | null)[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind !== 'same') for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffLine | null)[] = [];
  lines.forEach((l, i) => {
    if (keep[i]) out.push(l);
    else if (out.length === 0 || out[out.length - 1] !== null) out.push(null);
  });
  return out;
}
