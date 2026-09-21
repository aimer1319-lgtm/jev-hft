// The two drawings on the page, on <canvas>: the price chart with Jev's calls marked on it, and
// the small response-time chart. Hand-drawn so the page has nothing to download or build.

import { actedLean, type Decision, type Tick } from '../collector.ts';

type Theme = { text: string; muted: string; faint: string; line: string; up: string; down: string; flat: string; accent: string; accent2: string; panel: string; mono: string };

/**
 * A busy window holds more of Jev's calls than there are pixels to draw them in, so only the
 * first call in each slice of time gets a marker. This returns which slice a moment falls in,
 * for a chart showing `span` milliseconds.
 *
 * The rule that matters: a call's slice depends only on its own timestamp. The list being drawn
 * is a window that slides, so every second the oldest call drops off the front and every other
 * call's position in the list shifts by one. Deciding by position instead redrew a different two
 * thirds of the calls every second, which looked like the chart flickering (D53).
 */
export const sliceAt = (span: number) => {
  const sliceMs = Math.max(1000, Math.round(span / 260 / 1000) * 1000);
  return (t: number) => Math.floor(t / sliceMs);
};

function readTheme(): Theme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return { text: v('--text'), muted: v('--muted'), faint: v('--faint'), line: v('--line'), up: v('--up'), down: v('--down'), flat: v('--flat'), accent: v('--accent'), accent2: v('--accent-2'), panel: v('--panel'), mono: v('--mono') };
}

/** Sizes a canvas for sharp lines on high-resolution screens and keeps it that way as the page resizes. */
class Surface {
  readonly ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;
  theme = readTheme();
  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement, onChange: () => void) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => {
      this.fit();
      onChange();
    }).observe(canvas);
    // The page announces a theme change (the toggle, or the system setting) with this event.
    document.addEventListener('themechange', () => {
      this.theme = readTheme();
      onChange();
    });
    this.fit();
  }

  private fit() {
    const dpr = window.devicePixelRatio || 1;
    const box = this.canvas.getBoundingClientRect();
    this.width = box.width;
    this.height = box.height;
    this.canvas.width = Math.max(1, Math.round(box.width * dpr));
    this.canvas.height = Math.max(1, Math.round(box.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

/** A theme colour (written as #rrggbb in style.css) made see-through, as a plain rgba() that every canvas accepts. */
function alpha(color: string, a: number) {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return color;
  const n = parseInt(hex, 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

/** A round step size (1, 2, 2.5, 5 times a power of ten) giving about `count` grid lines. */
function niceStep(span: number, count: number) {
  const raw = span / Math.max(1, count);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / pow;
  return (unit < 1.5 ? 1 : unit < 2.25 ? 2 : unit < 3.5 ? 2.5 : unit < 7.5 ? 5 : 10) * pow;
}

// ---- price chart -------------------------------------------------------------------------

export type Hover = { decision: Decision; x: number; y: number } | null;

const PAD = { left: 10, right: 74, top: 14, bottom: 24 };
const RIBBON = { row: 7, gap: 3, top: 12 }; // three thin strips under the plot
const HORIZONS = [2, 10, 60];

export class PriceChart {
  windowMs = 15 * 60_000;
  horizonS = 10;
  onHover: (h: Hover) => void = () => {};

  private readonly surface: Surface;
  private ticks: Tick[] = [];
  private decisions: Decision[] = [];
  /** The pipeline's clock at the newest tick, and the browser's clock when it arrived, so the chart can glide between ticks. */
  private anchor: { t: number; at: number } | null = null;
  private pointerX: number | null = null;
  private dirty = true;

  constructor(canvas: HTMLCanvasElement) {
    this.surface = new Surface(canvas, () => (this.dirty = true));
    canvas.addEventListener('pointermove', e => {
      this.pointerX = e.offsetX;
      this.dirty = true;
    });
    canvas.addEventListener('pointerleave', () => {
      this.pointerX = null;
      this.dirty = true;
      this.onHover(null);
    });
    const frame = () => {
      // Redraw when something changed, and a few times a second anyway so time keeps moving.
      if (this.dirty || performance.now() - this.lastDraw > 250) this.draw();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  private lastDraw = 0;

  setData(ticks: Tick[], decisions: Decision[]) {
    const newest = ticks[ticks.length - 1];
    if (newest && newest.t !== this.anchor?.t) this.anchor = { t: newest.t, at: performance.now() };
    this.ticks = ticks;
    this.decisions = decisions;
    this.dirty = true;
  }

  invalidate() {
    this.dirty = true;
  }

  private draw() {
    this.dirty = false;
    this.lastDraw = performance.now();
    const { ctx, width: W, height: H, theme } = this.surface;
    ctx.clearRect(0, 0, W, H);
    if (!this.anchor || this.ticks.length === 0 || W < 40) return;

    const ribbonH = HORIZONS.length * RIBBON.row + (HORIZONS.length - 1) * RIBBON.gap;
    const plot = { x0: PAD.left, x1: W - PAD.right, y0: PAD.top, y1: H - PAD.bottom - ribbonH - RIBBON.top };
    // "Now" glides forward between ticks, but never runs more than 2 s ahead of the data.
    const tEnd = this.anchor.t + Math.min(performance.now() - this.anchor.at, 2000);
    // Until there is enough history to fill the chosen window, show what there is (at least 90 s)
    // rather than a sliver of line against the right-hand edge.
    const span = Math.min(this.windowMs, Math.max(90_000, (tEnd - this.ticks[0]!.t) * 1.12));
    const tStart = tEnd - span;
    const x = (t: number) => plot.x0 + ((t - tStart) / span) * (plot.x1 - plot.x0);

    const first = Math.max(0, this.ticks.findIndex(k => k.t >= tStart) - 1);
    const visible = this.ticks.slice(first);
    let lo = Infinity;
    let hi = -Infinity;
    for (const k of visible) {
      lo = Math.min(lo, k.mid);
      hi = Math.max(hi, k.mid);
    }
    const pad = Math.max((hi - lo) * 0.14, hi * 0.5e-4); // at least half a basis point of room
    lo -= pad;
    hi += pad;
    const y = (p: number) => plot.y1 - ((p - lo) / (hi - lo)) * (plot.y1 - plot.y0);

    // grid and price labels
    ctx.font = `11px ${theme.mono}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const step = niceStep(hi - lo, 4);
    const newestY = y(visible[visible.length - 1]!.mid);
    for (let p = Math.ceil(lo / step) * step; p < hi; p += step) {
      ctx.strokeStyle = theme.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plot.x0, Math.round(y(p)) + 0.5);
      ctx.lineTo(plot.x1, Math.round(y(p)) + 0.5);
      ctx.stroke();
      if (Math.abs(y(p) - newestY) < 14) continue; // the newest price's own label goes here
      ctx.fillStyle = theme.faint;
      ctx.fillText(p.toLocaleString('en-US', { minimumFractionDigits: step < 1 ? 2 : 0, maximumFractionDigits: 2 }), plot.x1 + 10, y(p));
    }

    // time labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const tStep = span <= 2 * 60_000 ? 30_000 : span <= 5 * 60_000 ? 60_000 : span <= 15 * 60_000 ? 180_000 : 300_000;
    for (let t = Math.ceil(tStart / tStep) * tStep; t < tEnd; t += tStep) {
      if (x(t) < plot.x0 + 24 || x(t) > plot.x1 - 24) continue;
      ctx.fillStyle = theme.faint;
      ctx.fillText(new Date(t).toLocaleTimeString('en-GB', tStep < 60_000 ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' }), x(t), H - 6);
    }

    // the price: a soft fill under a crisp line
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x0, 0, plot.x1 - plot.x0, H);
    ctx.clip();
    // Where nothing was heard for a while (the pipeline was stopped), the line breaks rather
    // than being drawn straight across prices nobody saw.
    const GAP_MS = 5000;
    const segments: { t: number; mid: number }[][] = [];
    for (const k of visible) {
      const current = segments[segments.length - 1];
      if (current && k.t - current[current.length - 1]!.t <= GAP_MS) current.push(k);
      else segments.push([k]);
    }
    const last = visible[visible.length - 1]!;
    const shade = ctx.createLinearGradient(0, plot.y0, 0, plot.y1);
    shade.addColorStop(0, alpha(theme.accent, 0.22));
    shade.addColorStop(1, alpha(theme.accent, 0));
    segments.forEach((segment, n) => {
      const path = new Path2D();
      segment.forEach((k, i) => (i === 0 ? path.moveTo(x(k.t), y(k.mid)) : path.lineTo(x(k.t), y(k.mid))));
      // The newest segment runs on to "now"; older ones stop where the data stopped.
      const end = n === segments.length - 1 ? x(tEnd) : x(segment[segment.length - 1]!.t);
      path.lineTo(end, y(segment[segment.length - 1]!.mid));
      const fill = new Path2D(path);
      fill.lineTo(end, plot.y1);
      fill.lineTo(x(segment[0]!.t), plot.y1);
      fill.closePath();
      ctx.fillStyle = shade;
      ctx.fill(fill);
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      ctx.stroke(path);
    });

    // Jev's calls for the chosen horizon, placed where and when the answer arrived. Only the
    // first call in each slice of time is marked, so a busy window stays readable (`sliceAt`).
    const shown = this.decisions.filter(d => d.answer && d.answer.tResp >= tStart && typeof d.answer.midResp === 'number');
    const sliceOf = sliceAt(span);
    let lastSlice = NaN;
    let nearest: Hover = null;
    shown.forEach(d => {
      const a = d.answer!;
      const px = x(a.tResp);
      const py = y(a.midResp!);
      const signal = actedLean(a.signals, this.horizonS) ?? 0;
      if (this.pointerX !== null && Math.abs(px - this.pointerX) < 9 && (!nearest || Math.abs(px - this.pointerX) < Math.abs(nearest.x - this.pointerX))) nearest = { decision: d, x: px, y: py };
      const slice = sliceOf(a.tResp);
      if (slice === lastSlice) return;
      lastSlice = slice;
      const move = d.outcome?.fromResp[String(this.horizonS)];
      const judged = typeof move === 'number' && move !== 0 && Math.abs(signal) >= 0.05;
      const right = judged && Math.sign(move) === Math.sign(signal);
      this.marker(px, py, signal, judged ? (right ? 'right' : 'wrong') : 'open');
    });
    ctx.restore();

    // the newest price: a glowing dot, a dashed line, and a label on the axis
    const ly = y(last.mid);
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = alpha(theme.accent, 0.5);
    ctx.beginPath();
    ctx.moveTo(plot.x0, Math.round(ly) + 0.5);
    ctx.lineTo(plot.x1, Math.round(ly) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = alpha(theme.accent, 0.25);
    ctx.beginPath();
    ctx.arc(x(tEnd), ly, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = theme.accent;
    ctx.beginPath();
    ctx.arc(x(tEnd), ly, 3, 0, Math.PI * 2);
    ctx.fill();
    const label = last.mid.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    ctx.font = `600 11px ${theme.mono}`;
    const lw = ctx.measureText(label).width + 12;
    ctx.fillStyle = theme.accent;
    ctx.beginPath();
    ctx.roundRect(plot.x1 + 5, ly - 9, lw, 18, 5);
    ctx.fill();
    ctx.fillStyle = theme.panel;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, plot.x1 + 11, ly + 0.5);

    // strips: Jev's lean over time at each horizon, usual lean taken out (green up, red down, stronger = surer)
    HORIZONS.forEach((h, row) => {
      const top = plot.y1 + RIBBON.top + row * (RIBBON.row + RIBBON.gap);
      ctx.fillStyle = alpha(theme.flat, 0.1);
      ctx.beginPath();
      ctx.roundRect(plot.x0, top, plot.x1 - plot.x0, RIBBON.row, 2);
      ctx.fill();
      shown.forEach((d, i) => {
        const s = actedLean(d.answer!.signals, h) ?? 0;
        if (Math.abs(s) < 0.02) return;
        const from = Math.max(plot.x0, x(d.answer!.tResp));
        const next = shown[i + 1]?.answer!.tResp;
        const to = Math.min(plot.x1, next === undefined ? from + 3 : Math.max(from + 1.5, x(next)));
        ctx.fillStyle = alpha(s > 0 ? theme.up : theme.down, 0.15 + 0.85 * Math.min(1, Math.abs(s)));
        ctx.fillRect(from, top, Math.min(to - from, 14), RIBBON.row);
      });
      ctx.fillStyle = h === this.horizonS ? theme.text : theme.faint;
      ctx.font = `${h === this.horizonS ? 600 : 400} 10px ${theme.mono}`;
      ctx.textAlign = 'left';
      ctx.fillText(`${h}s`, plot.x1 + 10, top + RIBBON.row / 2 + 0.5);
    });

    // what the pointer is over
    if (nearest) {
      const n = nearest as NonNullable<Hover>;
      ctx.strokeStyle = alpha(theme.text, 0.25);
      ctx.beginPath();
      ctx.moveTo(Math.round(n.x) + 0.5, plot.y0);
      ctx.lineTo(Math.round(n.x) + 0.5, plot.y1);
      ctx.stroke();
      ctx.strokeStyle = theme.text;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(n.x, n.y, 8, 0, Math.PI * 2);
      ctx.stroke();
    }
    this.onHover(nearest);
  }

  /** Up or down triangle sized by how strongly Jev leaned; a dot when it didn't. Solid = it went that way. */
  private marker(px: number, py: number, signal: number, kind: 'right' | 'wrong' | 'open') {
    const { ctx, theme } = this.surface;
    const strength = Math.min(1, Math.abs(signal));
    if (strength < 0.05) {
      ctx.fillStyle = alpha(theme.flat, 0.7);
      ctx.beginPath();
      ctx.arc(px, py, 1.8, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const up = signal > 0;
    const color = up ? theme.up : theme.down;
    const r = 3.4 + 3.2 * strength;
    const cy = py + (up ? -(r + 5) : r + 5); // above the line for up, below for down
    ctx.beginPath();
    ctx.moveTo(px, cy + (up ? -r : r));
    ctx.lineTo(px - r * 0.95, cy + (up ? r * 0.75 : -r * 0.75));
    ctx.lineTo(px + r * 0.95, cy + (up ? r * 0.75 : -r * 0.75));
    ctx.closePath();
    if (kind === 'wrong') {
      ctx.strokeStyle = alpha(color, 0.85);
      ctx.lineWidth = 1.3;
      ctx.stroke();
    } else {
      ctx.fillStyle = alpha(color, kind === 'right' ? 0.95 : 0.35 + 0.4 * strength);
      ctx.fill();
    }
  }
}

// ---- response-time chart -------------------------------------------------------------------

export class LatencyChart {
  private readonly surface: Surface;
  private total: number[] = [];
  private model: (number | null)[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.surface = new Surface(canvas, () => this.draw());
  }

  /** The whole round trip, and the part of it that was TypeSafe, for the most recent answers. */
  setData(total: number[], model: (number | null)[]) {
    this.total = total;
    this.model = model;
    this.draw();
  }

  private draw() {
    const { ctx, width: W, height: H, theme } = this.surface;
    ctx.clearRect(0, 0, W, H);
    const n = this.total.length;
    if (n < 2) return;
    const top = Math.max(...this.total) * 1.12;
    const x = (i: number) => 4 + (i / (n - 1)) * (W - 56);
    const y = (v: number) => H - 6 - (v / top) * (H - 16);

    ctx.font = `10.5px ${theme.mono}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const step = niceStep(top, 3);
    for (let v = step; v < top; v += step) {
      ctx.strokeStyle = theme.line;
      ctx.beginPath();
      ctx.moveTo(4, Math.round(y(v)) + 0.5);
      ctx.lineTo(W - 52, Math.round(y(v)) + 0.5);
      ctx.stroke();
      ctx.fillStyle = theme.faint;
      ctx.fillText(`${v} ms`, W - 46, y(v));
    }

    const area = (values: (number | null)[], color: string, strokeAlpha: number, fillAlpha: number, width: number) => {
      const path = new Path2D();
      let started = false;
      values.forEach((v, i) => {
        if (v === null) return;
        if (started) path.lineTo(x(i), y(v));
        else path.moveTo(x(i), y(v));
        started = true;
      });
      if (!started) return;
      const fill = new Path2D(path);
      fill.lineTo(x(n - 1), H - 6);
      fill.lineTo(x(values.findIndex(v => v !== null)), H - 6);
      fill.closePath();
      ctx.fillStyle = alpha(color, fillAlpha);
      ctx.fill(fill);
      ctx.strokeStyle = alpha(color, strokeAlpha);
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.stroke(path);
    };
    area(this.total, theme.accent, 0.6, 0.1, 1.2);
    area(this.model, theme.accent2, 1, 0.16, 1.5);

    ctx.fillStyle = theme.accent;
    ctx.beginPath();
    ctx.arc(x(n - 1), y(this.total[n - 1]!), 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** The running total of what Jev's answers would have made, in basis points, over time. */
export class EquityChart {
  private readonly surface: Surface;
  private points: { t: number; cumBps: number }[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.surface = new Surface(canvas, () => this.draw());
  }

  setData(points: { t: number; cumBps: number }[]) {
    this.points = points;
    this.draw();
  }

  private draw() {
    const { ctx, width: W, height: H, theme } = this.surface;
    ctx.clearRect(0, 0, W, H);
    const pts = this.points;
    if (pts.length < 2) return;

    const right = W - 52;
    const t0 = pts[0]!.t;
    const t1 = pts[pts.length - 1]!.t;
    const span = Math.max(1, t1 - t0);
    const values = pts.map(p => p.cumBps);
    // Zero is always on the chart: how far above or below the line you are is the whole point.
    let lo = Math.min(0, ...values);
    let hi = Math.max(0, ...values);
    if (hi - lo < 1e-9) {
      hi += 0.5;
      lo -= 0.5;
    }
    const room = (hi - lo) * 0.12;
    hi += room;
    lo -= room;

    const x = (t: number) => 4 + ((t - t0) / span) * (right - 4);
    const y = (v: number) => H - 6 - ((v - lo) / (hi - lo)) * (H - 16);
    const zero = y(0);
    const last = values[values.length - 1]!;
    const yLast = y(last);
    const label = (v: number, digits: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;

    ctx.font = `10.5px ${theme.mono}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const step = niceStep(hi - lo, 3);
    const digits = step < 1 ? 1 : 0;
    for (let v = Math.ceil(lo / step) * step; v < hi; v += step) {
      const gy = Math.round(y(v)) + 0.5;
      ctx.strokeStyle = theme.line;
      ctx.beginPath();
      ctx.moveTo(4, gy);
      ctx.lineTo(right, gy);
      ctx.stroke();
      if (Math.abs(y(v) - yLast) < 11) continue; // the running total's own label goes here
      ctx.fillStyle = theme.faint;
      ctx.fillText(label(v, digits), right + 6, y(v));
    }

    const path = new Path2D();
    pts.forEach((p, i) => (i === 0 ? path.moveTo(x(p.t), y(p.cumBps)) : path.lineTo(x(p.t), y(p.cumBps))));
    const fill = new Path2D(path);
    fill.lineTo(x(t1), zero);
    fill.lineTo(x(t0), zero);
    fill.closePath();

    // Shade the same shape twice, cut off at the break-even line, so gains and losses read apart.
    const band = (color: string, from: number, to: number) => {
      if (to - from < 0.5) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, from, W, to - from);
      ctx.clip();
      ctx.fillStyle = alpha(color, 0.16);
      ctx.fill(fill);
      ctx.restore();
    };
    band(theme.up, 0, zero);
    band(theme.down, zero, H);

    ctx.strokeStyle = alpha(theme.muted, 0.65);
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(4, Math.round(zero) + 0.5);
    ctx.lineTo(right, Math.round(zero) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    const color = last > 0 ? theme.up : last < 0 ? theme.down : theme.flat;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke(path);

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x(t1), yLast, 2.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(label(last, 1), right + 6, yLast);
  }
}
