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

/** One Alpaca websocket with auth, reconnect (1 s doubling to 30 s), and resubscription. */
export class AlpacaStream {
  private ws: WebSocket | undefined;
  private authed = false;
  private closed = false;
  private backoffMs = 1000;
  private readonly url: string;
  private readonly creds: AlpacaCreds;
  private readonly onMessage: (m: Message, recvTs: number) => void;
  /** What to subscribe to after every (re)authentication. */
  private readonly subscription: () => object | undefined;
  private readonly log: (s: string) => void;

  constructor(
    url: string,
    creds: AlpacaCreds,
    onMessage: (m: Message, recvTs: number) => void,
    subscription: () => object | undefined,
    log: (s: string) => void,
  ) {
    this.url = url;
    this.creds = creds;
    this.onMessage = onMessage;
    this.subscription = subscription;
    this.log = log;
    this.connect();
  }

  /** Send once authenticated; before that, the subscription callback covers it on connect. */
  send(msg: object) {
    if (this.authed) this.ws!.send(JSON.stringify(msg));
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }

  private connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    const name = this.url.split('/').slice(-2).join('/');
    ws.onmessage = ev => {
      const recvTs = nowMs();
      for (const m of JSON.parse(String(ev.data)) as Message[]) {
        if (m.T === 'success' && m.msg === 'connected') {
          ws.send(JSON.stringify({ action: 'auth', key: this.creds.key, secret: this.creds.secret }));
        } else if (m.T === 'success' && m.msg === 'authenticated') {
          this.authed = true;
          this.backoffMs = 1000;
          const sub = this.subscription();
          if (sub) ws.send(JSON.stringify({ action: 'subscribe', ...sub }));
        } else if (m.T === 'error') {
          // e.g. 402 auth failed, 405 symbol limit exceeded, 406 connection limit exceeded
          this.log(`[alpaca ${name}] error ${m.code}: ${m.msg}`);
        } else if (m.T !== 'subscription') {
          this.onMessage(m, recvTs);
        }
      }
    };
    ws.onerror = () => {}; // onclose follows
    ws.onclose = () => {
      this.authed = false;
      if (this.closed) return;
      this.log(`[alpaca ${name}] disconnected, reconnecting in ${this.backoffMs / 1000}s`);
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    };
  }
}
