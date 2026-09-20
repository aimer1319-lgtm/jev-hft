// Turning numbers into text, the same way everywhere on the page.

const DASH = '—';
const finite = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

const priceFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export const price = (x: number | null | undefined) => (finite(x) ? priceFmt.format(x) : DASH);
export const int = (x: number | null | undefined) => (finite(x) ? intFmt.format(x) : DASH);
export const fixed = (x: number | null | undefined, digits = 2) => (finite(x) ? x.toFixed(digits) : DASH);
export const signed = (x: number | null | undefined, digits = 2) => (finite(x) ? `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(digits)}` : DASH);
/** Basis points, with a sign. */
export const bp = (x: number | null | undefined, digits = 1) => (finite(x) ? `${signed(x, digits)} bp` : DASH);
export const ms = (x: number | null | undefined) => (finite(x) ? `${Math.round(x)} ms` : DASH);
export const pct = (x: number | null | undefined, digits = 0) => (finite(x) ? `${(x * 100).toFixed(digits)}%` : DASH);
export const usd = (x: number | null | undefined, digits = 4) => (finite(x) ? `$${x.toFixed(digits)}` : DASH);

export function clock(t: number) {
  return new Date(t).toLocaleTimeString('en-GB', { hour12: false });
}

/** "just now", "12 s ago", "4 min ago". */
export function ago(msAgo: number) {
  const s = Math.max(0, Math.round(msAgo / 1000));
  if (s < 2) return 'just now';
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/** "up 2h 14m" style durations. */
export function duration(msTotal: number) {
  const s = Math.max(0, Math.floor(msTotal / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

export function quantile(values: number[], q: number) {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}

export const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
