// Alpaca market-data access shared by the stock-quote feed and the news source.
// Both websockets speak the same protocol: server sends "connected", client sends auth,
// server sends "authenticated", client (re)sends its subscriptions.

import { nowMs } from './types.ts';

export type AlpacaCreds = { key: string; secret: string };

const REST = 'https://data.alpaca.markets';

export async function alpacaGet<T>(creds: AlpacaCreds, path: string): Promise<T> {
  const res = await fetch(`${REST}${path}`, {
    headers: { 'APCA-API-KEY-ID': creds.key, 'APCA-API-SECRET-KEY': creds.secret },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Alpaca ${path.split('?')[0]}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  return (await res.json()) as T;
}

type Message = { T: string; [key: string]: unknown };

export type AlpacaStreamOptions = {
  url: string;
  creds: AlpacaCreds;
  onMessage: (m: Message, recvTs: number) => void;
  /** What to subscribe to after every (re)authentication, and what the heartbeat re-sends. */
  subscription: () => object | undefined;
  /** Subscribed and receiving again, as of `t`. */
  onUp?: (t: number) => void;
  /** The connection is gone; `lastMessageTs` is the last moment it was known to work. */
  onDown?: (lastMessageTs: number) => void;
  log: (s: string) => void;
};

/** How often to check a quiet connection, and how long an answer may take. */
const HEARTBEAT_MS = 30_000;
const REPLY_TIMEOUT_MS = 10_000;

/**
 * One Alpaca websocket with auth, reconnect (1 s doubling to 30 s), and resubscription.
 *
 * These streams can be silent for hours (nights, weekends), so silence does not show that a
 * connection has died. Instead, every 30 s the stream re-sends its current subscription, which
 * Alpaca confirms within about 0.1 s. Whenever we send something and hear nothing at all for
 * 10 s, the connection is treated as dead and replaced.
 */
export class AlpacaStream {
  private ws: WebSocket | undefined;
  private authed = false;
  private closed = false;
  private backoffMs = 1000;
  private lastMessageTs = NaN;
  private heartbeat: NodeJS.Timeout | undefined;
  private replyTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly opts: AlpacaStreamOptions;
  private readonly name: string;

  constructor(opts: AlpacaStreamOptions) {
    this.opts = opts;
    this.name = opts.url.split('/').slice(-2).join('/');
    this.connect();
  }

  /** Send once authenticated; before that, the subscription callback covers it on connect. */
  send(msg: object) {
    if (!this.authed) return;
    this.ws!.send(JSON.stringify(msg));
    this.expectReply();
  }

  close() {
    this.closed = true;
    this.stopTimers();
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private connect() {
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.onmessage = ev => {
      if (ws !== this.ws) return; // a connection we already gave up on
      const recvTs = nowMs();
      this.lastMessageTs = recvTs;
      clearTimeout(this.replyTimer);
      this.replyTimer = undefined;
      for (const m of JSON.parse(String(ev.data)) as Message[]) {
        if (m.T === 'success' && m.msg === 'connected') {
          ws.send(JSON.stringify({ action: 'auth', key: this.opts.creds.key, secret: this.opts.creds.secret }));
          this.expectReply();
        } else if (m.T === 'success' && m.msg === 'authenticated') {
          this.authed = true;
          this.backoffMs = 1000;
          const sub = this.opts.subscription();
          if (sub) this.send({ action: 'subscribe', ...sub });
          this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS);
          this.opts.onUp?.(recvTs);
        } else if (m.T === 'error') {
          // e.g. 402 auth failed, 405 symbol limit exceeded, 406 connection limit exceeded
          this.opts.log(`[alpaca ${this.name}] error ${m.code}: ${m.msg}`);
        } else if (m.T !== 'subscription') {
          this.opts.onMessage(m, recvTs);
        }
      }
    };
    ws.onerror = () => {}; // onclose follows
    ws.onclose = () => {
      if (ws === this.ws) this.lost('disconnected');
    };
    this.expectReply(); // the server greets a new connection with "connected"
  }

  private beat() {
    const sub = this.opts.subscription();
    if (sub) this.send({ action: 'subscribe', ...sub });
  }

  private expectReply() {
    this.replyTimer ??= setTimeout(() => this.lost(`no reply in ${REPLY_TIMEOUT_MS / 1000}s`), REPLY_TIMEOUT_MS);
  }

  /** Give up on the current connection and open a new one after a pause. */
  private lost(why: string) {
    const ws = this.ws;
    this.ws = undefined; // late events from the old socket are ignored
    const wasUp = this.authed;
    this.authed = false;
    this.stopTimers();
    ws?.close();
    if (this.closed) return;
    if (wasUp) this.opts.onDown?.(this.lastMessageTs);
    this.opts.log(`[alpaca ${this.name}] ${why}, reconnecting in ${this.backoffMs / 1000}s`);
    this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
  }

  private stopTimers() {
    clearInterval(this.heartbeat);
    clearTimeout(this.replyTimer);
    this.heartbeat = undefined;
    this.replyTimer = undefined;
  }
}
