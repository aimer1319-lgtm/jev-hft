export type Summary = { n: number; min: number; p50: number; p90: number; p99: number; max: number; mean: number };

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

export function summarize(values: number[]): Summary {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    min: s[0] ?? NaN,
    p50: quantile(s, 0.5),
    p90: quantile(s, 0.9),
    p99: quantile(s, 0.99),
    max: s[s.length - 1] ?? NaN,
    mean: s.reduce((a, b) => a + b, 0) / (s.length || 1),
  };
}

export const fmtMs = (ms: number) => (Number.isFinite(ms) ? `${ms.toFixed(0)}ms`.padStart(7) : '     - ');

/** Mean of the finite values (NaN when there are none). */
export function mean(xs: number[]) {
  const f = xs.filter(Number.isFinite);
  return f.reduce((a, b) => a + b, 0) / f.length;
}

/** Zero-based ranks with ties sharing their average rank. */
export function ranks(xs: number[]) {
  const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    for (let k = i; k <= j; k++) r[order[k]![1]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
}

/** Spearman rank correlation over pairs where both values are finite. */
export function spearman(a: number[], b: number[]) {
  const keep = a.map((x, i) => Number.isFinite(x) && Number.isFinite(b[i]!));
  const x = ranks(a.filter((_, i) => keep[i]));
  const y = ranks(b.filter((_, i) => keep[i]));
  const n = x.length;
  if (n < 3) return NaN;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my);
    sxx += (x[i]! - mx) ** 2;
    syy += (y[i]! - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}

/** JSON turns NaN into null; never let a missing value count as 0. */
export const num = (x: unknown) => (typeof x === 'number' ? x : NaN);

/** Return from `from` to `to` in basis points (NaN if either is missing). */
export const bps = (to: unknown, from: unknown) => ((num(to) - num(from)) / num(from)) * 1e4;

/**
 * How many of these times are far enough apart to count as separate pieces of evidence:
 * walking forward in time, a moment counts only if it is at least `gapMs` after the last one
 * counted. Decisions closer together than their look-ahead window share the same future, and
 * counting each of them would make a result look more certain than it is.
 */
export function independentCount(times: number[], gapMs: number): number {
  let n = 0;
  let last = -Infinity;
  for (const t of [...times].sort((a, b) => a - b)) {
    if (t - last >= gapMs) {
      n++;
      last = t;
    }
  }
  return n;
}

/** How unlikely a rank correlation `ic` is to be luck, given `n` independent observations (roughly: above 2 means something). */
export const tStat = (ic: number, n: number) => ic * Math.sqrt(Math.max(n - 2, 0) / Math.max(1 - ic * ic, 1e-9));

/** What is left of `y` after removing the part a straight-line fit on `xs` explains. */
function residuals(y: number[], xs: number[][]): number[] {
  const n = y.length;
  const cols = [new Array<number>(n).fill(1), ...xs]; // intercept first
  const k = cols.length;
  // Normal equations (X'X) b = X'y, solved by elimination; k is tiny (at most a handful of rules).
  const a = cols.map(ci => [...cols.map(cj => ci.reduce((s, v, r) => s + v * cj[r]!, 0)), ci.reduce((s, v, r) => s + v * y[r]!, 0)]);
  for (let i = 0; i < k; i++) {
    let pivot = i;
    for (let r = i + 1; r < k; r++) if (Math.abs(a[r]![i]!) > Math.abs(a[pivot]![i]!)) pivot = r;
    [a[i], a[pivot]] = [a[pivot]!, a[i]!];
    if (Math.abs(a[i]![i]!) < 1e-9) continue; // a rule that never varies explains nothing
    for (let r = 0; r < k; r++) {
      if (r === i) continue;
      const f = a[r]![i]! / a[i]![i]!;
      for (let c = i; c <= k; c++) a[r]![c]! -= f * a[i]![c]!;
    }
  }
  const beta = a.map((row, i) => (Math.abs(row[i]!) < 1e-9 ? 0 : row[k]! / row[i]!));
  return y.map((v, r) => v - cols.reduce((s, c, j) => s + beta[j]! * c[r]!, 0));
}

/**
 * Rank correlation between `a` and `b` after removing from both whatever the `controls` already
 * explain. It answers "does this signal know anything the simple rules don't?": a signal that
 * only repeats the rules scores about zero here however well it scores on its own.
 */
export function partialSpearman(a: number[], b: number[], controls: number[][]): number {
  const keep = a.map((x, i) => Number.isFinite(x) && Number.isFinite(b[i]!) && controls.every(c => Number.isFinite(c[i]!)));
  const pick = (xs: number[]) => ranks(xs.filter((_, i) => keep[i]));
  const ra = pick(a);
  if (ra.length < controls.length + 4) return NaN;
  const cs = controls.map(pick);
  const ea = residuals(ra, cs);
  const eb = residuals(pick(b), cs);
  const n = ea.length;
  const ma = ea.reduce((s, v) => s + v, 0) / n;
  const mb = eb.reduce((s, v) => s + v, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (ea[i]! - ma) * (eb[i]! - mb);
    saa += (ea[i]! - ma) ** 2;
    sbb += (eb[i]! - mb) ** 2;
  }
  return saa > 1e-9 && sbb > 1e-9 ? sab / Math.sqrt(saa * sbb) : NaN;
}
