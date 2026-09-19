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
