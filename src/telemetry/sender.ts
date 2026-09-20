// Sends telemetry to the dashboard without ever making the pipeline wait.
//
// How it stays out of the way:
//   - `emit` only puts the message on a list (about 0.3 millionths of a second). Turning it into
//     text and sending it happens in `setImmediate`, which Node runs after it has handled any
//     market data that is already waiting.
//   - Messages go out as UDP datagrams: no connection, no acknowledgement, no queue that can
//     fill up. If the dashboard is slow, stopped, or was never started, they simply disappear.
//   - Nothing is written to disk.
//   - Any error is swallowed. Telemetry failing must never be the pipeline's problem.

import dgram from 'node:dgram';
import { nowMs } from '../feed/types.ts';
import type { Emit, Program, TelemetryBody, TelemetryEvent } from './events.ts';

export type TelemetryTarget = { host: string; port: number };

export const DEFAULT_TELEMETRY_PORT = 4100;
/** Keeps a datagram well under what loopback and a home network carry in one piece. */
const MAX_DATAGRAM_BYTES = 8192;

/**
 * TELEMETRY unset or "1": this machine, port 4100. "0" or "off": nothing is sent.
 * "host" or "host:port": somewhere else, e.g. a Raspberry Pi reporting to your laptop.
 */
export function parseTarget(spec: string | undefined): TelemetryTarget | undefined {
  const s = (spec ?? '').trim();
  if (s === '0' || s.toLowerCase() === 'off') return undefined;
  if (s === '' || s === '1') return { host: '127.0.0.1', port: DEFAULT_TELEMETRY_PORT };
  const [host, port] = s.split(':');
  const n = port === undefined ? DEFAULT_TELEMETRY_PORT : Number(port);
  if (!host || !Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`TELEMETRY must be 0, 1, host, or host:port, got "${spec}"`);
  return { host, port: n };
}

export type TelemetrySender = { emit: Emit; close(): void };

export function telemetrySender(program: Program, target: TelemetryTarget | undefined): TelemetrySender {
  if (!target) return { emit: () => {}, close: () => {} };

  const socket = dgram.createSocket('udp4');
  socket.on('error', () => {}); // e.g. nobody listening, network down: not our problem
  socket.unref(); // never keeps the program alive
  const run = Math.round(nowMs());
  let queue: TelemetryEvent[] = [];
  let scheduled = false;
  let closed = false;

  const send = (lines: string[]) => socket.send(lines.join('\n'), target.port, target.host, () => {});

  const flush = () => {
    scheduled = false;
    if (closed) return;
    const events = queue;
    queue = [];
    try {
      let lines: string[] = [];
      let bytes = 0;
      for (const e of events) {
        const line = JSON.stringify(e);
        if (lines.length > 0 && bytes + line.length > MAX_DATAGRAM_BYTES) {
          send(lines);
          lines = [];
          bytes = 0;
        }
        lines.push(line);
        bytes += line.length + 1;
      }
      if (lines.length > 0) send(lines);
    } catch {
      // A message that cannot be serialized or sent is dropped.
    }
  };

  return {
    emit(body: TelemetryBody) {
      if (closed) return;
      queue.push({ ...body, v: 1, t: nowMs(), run } as TelemetryEvent);
      if (!scheduled) {
        scheduled = true;
        setImmediate(flush);
      }
    },
    close() {
      closed = true;
      try {
        socket.close();
      } catch {
        // already closed
      }
    },
  };
}
