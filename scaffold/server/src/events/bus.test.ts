import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.MONGO_URL = (process.env.MONGO_URL ?? 'mongodb://localhost:27017/switchboard').replace(/\/[^/]*$/, '') + '/switchboard_test_bus';
const { publish, readSince, currentSeq } = await import('./bus.js');
const { resetAll, collections } = await import('../domain/store.js');
const { getRedis } = await import('../redis.js');

let available = true;
try {
  await Promise.race([getRedis().ping(), new Promise((_, rej) => setTimeout(() => rej(new Error('no redis')), 3000))]);
} catch {
  available = false;
}
const ws = `t_bus_${Math.random().toString(36).slice(2, 8)}`;
after(async () => {
  if (available) await getRedis().del(`sb:seq:${ws}`, `sb:ev:${ws}`);
  getRedis().disconnect();
  (await collections()).db.client.close(); // resetAll() opened a MongoDB pool; an open pool keeps this process alive forever
});

const all = async (afterSeq = 0) => {
  const out: { seq: number; type: string; [k: string]: unknown }[] = [];
  await readSince(ws, afterSeq, (frames) => void out.push(...frames));
  return out;
};

test('200 concurrent publishes: seq is 1..200 with no gaps, and the stream is in exactly that order', { skip: !available }, async () => {
  const seqs = await Promise.all(Array.from({ length: 200 }, (_, i) => publish(ws, { type: 'x', n: i })));
  assert.deepEqual([...seqs].sort((a, b) => a - b), Array.from({ length: 200 }, (_, i) => i + 1));
  const frames = await all();
  assert.equal(frames.length, 200);
  frames.forEach((f, i) => assert.equal(f.seq, i + 1)); // stream order == seq order
  assert.equal(await currentSeq(ws), 200);
});

test('a dedupe key publishes once, however many times (and in whatever order) it is asked', { skip: !available }, async () => {
  const before = await currentSeq(ws);
  const results = await Promise.all(Array.from({ length: 10 }, () => publish(ws, { type: 'message.inbound', message_id: 'pmsg_1' }, 'in:pmsg_1')));
  assert.equal(results.filter((s) => s > 0).length, 1);
  assert.equal(await currentSeq(ws), before + 1);
});

test('readSince returns only frames after the given seq, oldest first, across chunk boundaries', { skip: !available }, async () => {
  const last = await currentSeq(ws);
  for (let i = 0; i < 3; i++) await publish(ws, { type: 'y', i });
  const frames = await all(last);
  assert.deepEqual(frames.map((f) => f.seq), [last + 1, last + 2, last + 3]);
  assert.deepEqual(await all(last + 3), []);
});

test('a reset keeps the seq counter, so seq only ever goes up', { skip: !available }, async () => {
  const before = await currentSeq(ws);
  await resetAll();
  assert.equal(await currentSeq(ws), before);
  assert.equal(await publish(ws, { type: 'z' }), before + 1);
});
