// Full-depth L2 book. Prices live in sorted arrays with the best price LAST, so the
// updates that dominate (near the touch) splice the tail instead of shifting ~20k
// entries. Sizes live in maps. Coinbase BTC-USD snapshots are ~40k levels.

export class OrderBook {
  private bidPx: number[] = []; // ascending: best bid last
  private askPx: number[] = []; // descending: best ask last
  private bidSz = new Map<number, number>();
  private askSz = new Map<number, number>();

  clear() {
    this.bidPx = [];
    this.askPx = [];
    this.bidSz.clear();
    this.askSz.clear();
  }

  /** Replace the whole book (snapshot): bulk sort instead of ~40k sorted inserts. */
  load(levels: Iterable<{ side: 'bid' | 'ask'; price: number; size: number }>) {
    this.clear();
    for (const { side, price, size } of levels) if (size > 0) (side === 'bid' ? this.bidSz : this.askSz).set(price, size);
    this.bidPx = [...this.bidSz.keys()].sort((a, b) => a - b);
    this.askPx = [...this.askSz.keys()].sort((a, b) => b - a);
  }

  apply(side: 'bid' | 'ask', price: number, size: number) {
    const bid = side === 'bid';
    const px = bid ? this.bidPx : this.askPx;
    const sz = bid ? this.bidSz : this.askSz;
    const exists = sz.has(price);
    if (size === 0) {
      if (!exists) return;
      sz.delete(price);
      px.splice(search(px, price, bid), 1);
    } else {
      if (!exists) px.splice(search(px, price, bid), 0, price);
      sz.set(price, size);
    }
  }

  get bestBid() {
    return this.bidPx[this.bidPx.length - 1] ?? NaN;
  }
  get bestAsk() {
    return this.askPx[this.askPx.length - 1] ?? NaN;
  }
  get mid() {
    return (this.bestBid + this.bestAsk) / 2;
  }
  get ready() {
    return this.bidPx.length > 0 && this.askPx.length > 0;
  }

  /** Level `i` counting from the touch (0 = best). */
  level(side: 'bid' | 'ask', i: number): [price: number, size: number] | undefined {
    const px = side === 'bid' ? this.bidPx : this.askPx;
    const p = px[px.length - 1 - i];
    return p === undefined ? undefined : [p, (side === 'bid' ? this.bidSz : this.askSz).get(p)!];
  }

  /** Summed size over the best `n` levels. */
  topSize(side: 'bid' | 'ask', n: number) {
    const px = side === 'bid' ? this.bidPx : this.askPx;
    const sz = side === 'bid' ? this.bidSz : this.askSz;
    let total = 0;
    for (let i = px.length - 1; i >= 0 && i >= px.length - n; i--) total += sz.get(px[i]!)!;
    return total;
  }

  /** Summed size of levels within `bps` of the mid. */
  depthWithin(side: 'bid' | 'ask', bps: number) {
    const bid = side === 'bid';
    const limit = bid ? this.mid * (1 - bps / 1e4) : this.mid * (1 + bps / 1e4);
    const px = bid ? this.bidPx : this.askPx;
    const sz = bid ? this.bidSz : this.askSz;
    let total = 0;
    for (let i = px.length - 1; i >= 0; i--) {
      const p = px[i]!;
      if (bid ? p < limit : p > limit) break;
      total += sz.get(p)!;
    }
    return total;
  }
}

// Insertion point (or exact index) keeping `px` ascending for bids, descending for asks.
function search(px: number[], price: number, ascending: boolean) {
  let lo = 0;
  let hi = px.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ascending ? px[mid]! < price : px[mid]! > price) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
