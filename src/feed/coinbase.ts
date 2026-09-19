// Coinbase Advanced Trade public market data: full L2 book + trades, no API key.
// https://docs.cdp.coinbase.com/advanced-trade/docs/ws-overview
//
// Note: `side` on market_trades is the maker side (BUY prints at the bid), so the
// aggressor is the opposite side. Verified against the live book.

import { nowMs, type Feed, type LevelUpdate, type MarketEvent } from './types.ts';

const URL = 'wss://advanced-trade-ws.coinbase.com';

/**
 * The heartbeats channel sends a message every second, so this much silence means the
 * connection is dead even if the operating system has not noticed yet.
 */
const STALL_MS = 10_000;

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
  let lastMessageTs = nowMs();
  let backoffMs = 500;
  let reconnectTimer: NodeJS.Timeout | undefined;

  /** Drop the current connection (whatever state it is in) and open a new one after a pause. */
  const reconnect = (why: string) => {
    const old = ws;
    ws = undefined; // late events from the old socket are ignored
    old?.close();
    if (closed) return;
    onEvent({ type: 'reset', recvTs: nowMs() });
    log(`[coinbase] ${why}, reconnecting in ${backoffMs}ms`);
    reconnectTimer = setTimeout(connect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 10_000);
  };

  const connect = () => {
    lastSeq = -1;
    lastMessageTs = nowMs();
    const socket = new WebSocket(URL);
    ws = socket;
    socket.onopen = () => {
      for (const channel of ['level2', 'market_trades', 'heartbeats']) {
        socket.send(JSON.stringify({ type: 'subscribe', product_ids: [product], channel }));
      }
    };
    socket.onmessage = ev => {
      if (socket !== ws) return;
      const recvTs = nowMs();
      lastMessageTs = recvTs;
      const msg = JSON.parse(String(ev.data));

      if (msg.type === 'error') {
        log(`[coinbase] error: ${String(msg.message ?? ev.data).slice(0, 200)}`);
        return;
      }
      if (typeof msg.sequence_num === 'number') {
        if (lastSeq >= 0 && msg.sequence_num !== lastSeq + 1) {
          return reconnect(`sequence gap ${lastSeq} -> ${msg.sequence_num}`); // a fresh snapshot rebuilds the book
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
          if (e.type === 'snapshot') backoffMs = 500; // data is flowing again
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
    socket.onerror = () => {}; // onclose follows and handles reconnect
    socket.onclose = () => {
      if (socket === ws) reconnect('disconnected');
    };
  };

  const watchdog = setInterval(() => {
    if (ws && nowMs() - lastMessageTs > STALL_MS) reconnect(`no messages for ${STALL_MS / 1000}s`);
  }, STALL_MS / 2);

  connect();
  return {
    close() {
      closed = true;
      clearInterval(watchdog);
      clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}
