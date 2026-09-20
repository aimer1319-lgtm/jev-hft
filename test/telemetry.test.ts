import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { test } from 'node:test';
import { parseTarget, telemetrySender } from '../src/telemetry/sender.ts';
import type { TelemetryBody, TelemetryEvent } from '../src/telemetry/events.ts';

const skip = (id: string): TelemetryBody => ({ type: 'news-skip', program: 'news', id, reason: 'repeat', detail: '' });

/** A UDP socket on a free port, and a promise for the next datagram it gets. */
async function listener() {
  const socket = dgram.createSocket('udp4');
  await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve));
  const next = () => new Promise<string>(resolve => socket.once('message', m => resolve(m.toString())));
  return { socket, port: socket.address().port, next };
}

test('where telemetry goes: this machine by default, elsewhere on request, nowhere when switched off', () => {
  assert.deepEqual(parseTarget(undefined), { host: '127.0.0.1', port: 4100 });
  assert.deepEqual(parseTarget(''), { host: '127.0.0.1', port: 4100 });
  assert.deepEqual(parseTarget('1'), { host: '127.0.0.1', port: 4100 });
  assert.equal(parseTarget('0'), undefined);
  assert.equal(parseTarget('off'), undefined);
  assert.deepEqual(parseTarget('192.168.1.20'), { host: '192.168.1.20', port: 4100 });
  assert.deepEqual(parseTarget('laptop.local:5000'), { host: 'laptop.local', port: 5000 });
  assert.throws(() => parseTarget('host:notaport'), /TELEMETRY/);
  assert.throws(() => parseTarget('host:99999'), /TELEMETRY/);
});

test('messages are stamped, and everything emitted in one go leaves together, later', async () => {
  const { socket, port, next } = await listener();
  const sender = telemetrySender('news', { host: '127.0.0.1', port });
  const arrived = next();
  sender.emit(skip('a'));
  sender.emit(skip('b'));
  sender.emit(skip('c'));
  const events = (await arrived).split('\n').map(l => JSON.parse(l) as TelemetryEvent);
  assert.equal(events.length, 3, 'one datagram for the three: nothing was sent while the caller was still running');
  assert.deepEqual(events.map(e => (e as { id: string }).id), ['a', 'b', 'c']);
  for (const e of events) {
    assert.equal(e.v, 1);
    assert.equal(e.program, 'news');
    assert.ok(Math.abs(e.t - Date.now()) < 5000);
    assert.equal(e.run, events[0]!.run, 'one run id for the life of the sender');
  }
  sender.close();
  socket.close();
});

test('a burst too big for one datagram is split, and nothing is lost', async () => {
  const { socket, port } = await listener();
  const got: string[] = [];
  socket.on('message', m => got.push(...m.toString().split('\n')));
  const sender = telemetrySender('news', { host: '127.0.0.1', port });
  for (let i = 0; i < 40; i++) sender.emit({ type: 'news-skip', program: 'news', id: String(i), reason: 'repeat', detail: 'x'.repeat(500) });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(got.length, 40);
  sender.close();
  socket.close();
});

test('telemetry can never be the pipeline\'s problem', async () => {
  const off = telemetrySender('live', undefined);
  off.emit(skip('x')); // switched off: does nothing
  off.close();

  const nobody = telemetrySender('live', { host: '127.0.0.1', port: 9 }); // nothing listens here
  nobody.emit(skip('x'));
  await new Promise(resolve => setTimeout(resolve, 30));

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  nobody.emit({ ...skip('y'), detail: circular } as unknown as TelemetryBody); // cannot be turned into text
  await new Promise(resolve => setTimeout(resolve, 30));
  nobody.close();
  nobody.emit(skip('z')); // after closing: ignored
});
