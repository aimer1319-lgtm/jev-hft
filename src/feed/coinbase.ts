// Coinbase Advanced Trade public market data: full L2 book + trades, no API key.
// https://docs.cdp.coinbase.com/advanced-trade/docs/ws-overview
//
// Note: `side` on market_trades is the maker side (BUY prints at the bid), so the
// aggressor is the opposite side. Verified against the live book.

import { nowMs, type Feed, type LevelUpdate, type MarketEvent } from './types.ts';

const URL = 'wss://advanced-trade-ws.coinbase.com';

// ISO timestamp with up to nanosecond digits -> epoch ms with fractional part.
function parseTs(iso: string): number {
  const ms = Date.parse(iso);
  const frac = /\.(\d+)/.exec(iso)?.[1];
  return frac && frac.length > 3 ? ms + Number(`0.${frac.slice(3)}`) : ms;
}

export function coinbaseFeed(product: string, onEvent: (e: MarketEvent) => void, log = console.error): Feed {
  let ws: WebSocket | undefined;
  let closed = false;
  let lastSeq = -1;
  let backoffMs = 500;

  const connect = () => {
    lastSeq = -1;
    ws = new WebSocket(URL);
    ws.onopen = () => {
      backoffMs = 500;
      for (const channel of ['level2', 'market_trades', 'heartbeats']) {
        ws!.send(JSON.stringify({ type: 'subscribe', product_ids: [product], channel }));
      }
    };
    ws.onmessage = ev => {
      const recvTs = nowMs();
      const msg = JSON.parse(String(ev.data));

      if (typeof msg.sequence_num === 'number') {
        if (lastSeq >= 0 && msg.sequence_num !== lastSeq + 1) {
          log(`[coinbase] sequence gap ${lastSeq} -> ${msg.sequence_num}, resubscribing`);
          onEvent({ type: 'reset', recvTs });
          ws!.close(); // onclose reconnects and a fresh snapshot rebuilds the book
          return;
        }
        lastSeq = msg.sequence_num;
      }

      if (msg.channel === 'l2_data') {
        for (const e of msg.events) {
          if (e.product_id !== product) continue;
          const updates: LevelUpdate[] = e.updates.map((u: any) => ({
            side: u.side === 'bid' ? 'bid' : 'ask',
            price: Number(u.price_level),
            size: Number(u.new_quantity),
          }));
          const last = e.updates[e.updates.length - 1];
          const exchTs = e.type === 'update' && last ? parseTs(last.event_time) : parseTs(msg.timestamp);
          onEvent({ type: 'book', snapshot: e.type === 'snapshot', updates, exchTs, recvTs });
        }
      } else if (msg.channel === 'market_trades') {
        for (const e of msg.events) {
          if (e.type !== 'update') continue; // snapshot = historical prints
          for (const t of e.trades) {
            if (t.product_id !== product) continue;
            onEvent({
              type: 'trade',
              price: Number(t.price),
              size: Number(t.size),
              aggressor: t.side === 'BUY' ? 'sell' : 'buy',
              exchTs: parseTs(t.time),
              recvTs,
            });
          }
        }
      }
    };
    ws.onerror = () => {}; // onclose follows and handles reconnect
    ws.onclose = () => {
      if (closed) return;
      onEvent({ type: 'reset', recvTs: nowMs() });
      log(`[coinbase] disconnected, reconnecting in ${backoffMs}ms`);
      setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 10_000);
    };
  };

  connect();
  return {
    close() {
      closed = true;
      ws?.close();
    },
  };
}
