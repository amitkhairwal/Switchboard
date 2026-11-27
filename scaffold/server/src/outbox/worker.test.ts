import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';

// Integration tests against the real MongoDB and Redis, in their own database. A fake
// Pigeon (an HTTP server that honours Idempotency-Key, like the real one) stands in
// for the provider. Skipped when MongoDB is unreachable.
process.env.MONGO_URL = (process.env.MONGO_URL ?? 'mongodb://localhost:27017/switchboard').replace(/\/[^/]*$/, '') + '/switchboard_test_outbox';
process.env.OUTBOX_ATTEMPT_TIMEOUT_MS = '200'; // the real client, with a short timeout, for the HTTP test

// ---- a fake Pigeon over HTTP --------------------------------------------------------
const pigeon = { byKey: new Map<string, string>(), requests: 0, firstResponseDelayMs: 0 };
const fake = createServer(async (req, res) => {
  pigeon.requests++;
  const key = String(req.headers['idempotency-key'] ?? '');
  const replay = pigeon.byKey.get(key);
  const id = replay ?? `pm_${pigeon.byKey.size + 1}`;
  if (!replay) pigeon.byKey.set(key, id); // accepted (and delivered) the moment it is first seen
  if (!replay && pigeon.firstResponseDelayMs) await new Promise((r) => setTimeout(r, pigeon.firstResponseDelayMs)); // "accepted, but answers late"
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id, status: 'accepted' }));
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
process.env.PIGEON_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

const { collections, initStore } = await import('../domain/store.js');
const { enqueueReply } = await import('../domain/conversations.js');
const { createOutboxWorker, backoffMs } = await import('./worker.js');
const { createLimiter } = await import('./limiter.js');
const { sendViaPigeon, idempotencyKeyFor } = await import('./pigeonClient.js');
const { getRedis } = await import('../redis.js');
const { Redis } = await import('ioredis');
const { config } = await import('../config.js');

let available = true;
try {
  await Promise.race([initStore(), new Promise((_, rej) => setTimeout(() => rej(new Error('no mongo')), 4000))]);
} catch {
  available = false;
}

const noLimit = { peek: async () => 0, take: async () => 0, coolOff: async () => undefined };
const base = {
  limiter: noLimit,
  workspaces: ['ws_acme'],
  leaseMs: 10_000,
  pollMs: 10,
  maxInflightPerWorkspace: 4,
  backoffBaseMs: 500,
  backoffCapMs: 5000,
  log: () => undefined,
};
const row = async (ref: string) => (await collections()).outbound.findOne({ workspace: 'ws_acme', client_ref: ref });
const reply = (ref: string) => enqueueReply({ workspace: 'ws_acme', contact: '+14155550101', text: 'hello', clientRef: ref });

before(async () => {
  if (available) await (await collections()).outbound.deleteMany({});
});
beforeEach(() => {
  pigeon.byKey.clear();
  pigeon.requests = 0;
  pigeon.firstResponseDelayMs = 0;
});
after(async () => {
  fake.close();
  if (available) {
    (await collections()).db.client.close();
    getRedis().disconnect();
  }
});

// ---- pure ----------------------------------------------------------------------------
test('backoff doubles from 500 ms and never exceeds the cap, whatever the jitter', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => backoffMs(n, 500, 5000, () => 0.5)), [500, 1000, 2000, 4000, 5000, 5000]);
  for (let n = 1; n < 30; n++) assert.ok(backoffMs(n, 500, 5000, () => 1) <= 5000);
});

test('the Idempotency-Key depends on the reply only: same for every attempt, copy and restart', () => {
  assert.equal(idempotencyKeyFor('g1a2_0'), 'sb-g1a2_0');
  assert.equal(idempotencyKeyFor('g1a2_0'), idempotencyKeyFor('g1a2_0'));
  assert.notEqual(idempotencyKeyFor('g1a2_0'), idempotencyKeyFor('g1a2_1'));
});

// ---- the shared rate limit (real Redis) ----------------------------------------------------
test('limiter: two copies share one bucket and one Retry-After cool-off', { skip: !available }, async () => {
  const ws = `t_${Math.random().toString(36).slice(2)}`; // own keys: other test files reset sb:* in Redis
  const a = createLimiter(getRedis(), { capacity: 7, refillPerSec: 3.5 });
  const other = new Redis(config.redisUrl);
  const b = createLimiter(other, { capacity: 7, refillPerSec: 3.5 });
  try {
    const taken = [];
    for (let i = 0; i < 7; i++) taken.push(await (i % 2 ? a : b).take(ws)); // alternate "copies"
    assert.deepEqual(taken, [0, 0, 0, 0, 0, 0, 0]);
    const wait = await a.take(ws);
    assert.ok(wait > 0 && wait <= 300, `eighth token from either copy must wait ~286 ms, got ${wait}`);
    assert.ok((await b.peek(ws)) > 0);
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(await b.take(ws), 0); // refilled

    await a.coolOff(ws, 400); // copy a got a 429...
    assert.ok((await b.take(ws)) > 0, 'copy b must respect it'); // ...and copy b obeys it
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(await b.peek(ws), 0);
  } finally {
    other.disconnect();
  }
});

// ---- case 1: the process dies right after the 202, before Pigeon is called ----------------------
test('case 1a: killed after 202, before any send: another copy sends it, once, with the same key', { skip: !available }, async () => {
  await reply('c1a'); // the endpoint returned 202 here; the copy that took the request is now dead and never polled
  const calls: string[] = [];
  const copy2 = createOutboxWorker({ ...base, now: () => Date.now() + 1000, send: async (_r, key) => (calls.push(key), { kind: 'accepted', pigeonId: 'pm_1' }) });
  await Promise.all(await copy2.poll());
  assert.deepEqual(calls, ['sb-c1a']);
  assert.equal((await row('c1a'))?.state, 'accepted');
  await Promise.all(await copy2.poll());
  assert.equal(calls.length, 1, 'an accepted reply is never sent again');
});

test('case 1b: killed after claiming the row, before sending: it is taken over only once the lease has expired', { skip: !available }, async () => {
  await reply('c1b');
  let clock = Date.now() + 1000;
  const now = () => clock;
  const dying = createOutboxWorker({ ...base, now, send: () => new Promise(() => undefined) }); // claims, then "dies" mid-send
  await dying.poll();
  const calls: string[] = [];
  const copy2 = createOutboxWorker({ ...base, now, send: async (_r, key) => (calls.push(key), { kind: 'accepted', pigeonId: 'pm_1' }) });
  await Promise.all(await copy2.poll());
  assert.equal(calls.length, 0, 'lease still held: do not touch it');
  clock += base.leaseMs + 1;
  await Promise.all(await copy2.poll());
  assert.deepEqual(calls, ['sb-c1b']);
  assert.equal((await row('c1b'))?.state, 'accepted');
});

// ---- case 2: Pigeon accepts but answers after our timeout, and after our lease ---------------------
test('case 2a (real HTTP, real client): Pigeon accepts, answers after our timeout; the retry gets the original answer', { skip: !available }, async () => {
  pigeon.firstResponseDelayMs = 1500; // our client gives up after 200 ms
  await reply('c2a');
  const copyA = createOutboxWorker({ ...base, send: sendViaPigeon, backoffBaseMs: 30, backoffCapMs: 60 });
  await Promise.all(await copyA.poll());
  assert.equal(pigeon.byKey.size, 1, 'Pigeon has accepted it already');
  assert.equal((await row('c2a'))?.state, 'pending', 'but we do not know that yet');
  const copyB = createOutboxWorker({ ...base, send: sendViaPigeon, backoffBaseMs: 30, backoffCapMs: 60 });
  for (let i = 0; i < 100 && (await row('c2a'))?.state !== 'accepted'; i++) {
    await Promise.all(await copyB.poll());
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal((await row('c2a'))?.state, 'accepted');
  assert.equal(pigeon.byKey.size, 1, 'still one message at Pigeon: the retry reused the key');
  assert.ok(pigeon.requests >= 2);
});

test('case 2b: the late answer arrives after the lease expired and another copy finished: nothing doubles or reverts', { skip: !available }, async () => {
  await reply('c2b');
  let clock = Date.now() + 1000;
  const now = () => clock;
  const accepts = new Map<string, string>(); // an in-memory Pigeon: one id per key
  const accept = (key: string) => accepts.get(key) ?? (accepts.set(key, `pm_${accepts.size + 1}`), accepts.get(key)!);
  let lateAnswer!: () => void;
  const gate = new Promise<void>((r) => (lateAnswer = r));
  const slow = createOutboxWorker({ ...base, now, send: async (_r, key) => (accept(key), await gate, { kind: 'accepted', pigeonId: accept(key) }) });
  const slowAttempts = await slow.poll(); // copy A: Pigeon takes it, the answer is stuck on the wire
  clock += base.leaseMs + 1; // A's lease expires
  const fast = createOutboxWorker({ ...base, now, send: async (_r, key) => ({ kind: 'accepted', pigeonId: accept(key) }) });
  await Promise.all(await fast.poll()); // copy B takes over, re-sends with the same key, gets the original answer
  assert.equal((await row('c2b'))?.state, 'accepted');
  lateAnswer(); // now A's answer finally arrives
  await Promise.all(slowAttempts);
  assert.equal(accepts.size, 1, 'one message at Pigeon');
  assert.equal((await row('c2b'))?.state, 'accepted');
  assert.equal((await row('c2b'))?.pigeon_id, 'pm_1');
});

test('case 2c: a copy that lost its lease cannot overwrite the copy that now holds the row', { skip: !available }, async () => {
  await reply('c2c');
  let clock = Date.now() + 1000;
  const now = () => clock;
  let lateFailure!: () => void;
  const gate = new Promise<void>((r) => (lateFailure = r));
  const slow = createOutboxWorker({ ...base, now, send: async () => (await gate, { kind: 'retry' as const, reason: 'timeout' }) });
  const slowAttempts = await slow.poll();
  clock += base.leaseMs + 1;
  const holder = createOutboxWorker({ ...base, now, send: () => new Promise(() => undefined) }); // B holds the row and is mid-send
  await holder.poll();
  const held = await row('c2c');
  lateFailure(); // A reports its failure late
  await Promise.all(slowAttempts);
  const after = await row('c2c');
  assert.equal(after?.lease_token, held?.lease_token, "B's lease is untouched");
  assert.equal(after?.attempts, 0, "A's stale failure is not counted");
});

// ---- behaviour of the outcomes ---------------------------------------------------------------------
test('outcomes: 429 pauses without counting a failure; 503 backs off and counts; 400 kills the reply and marks it failed', { skip: !available }, async () => {
  await reply('o429');
  await reply('o503');
  await reply('o400');
  const cool: number[] = [];
  const answers: Record<string, unknown> = {
    'sb-o429': { kind: 'rate_limited', retryAfterMs: 2000 },
    'sb-o503': { kind: 'retry', reason: 'HTTP 503' },
    'sb-o400': { kind: 'permanent', reason: '400' },
  };
  const w = createOutboxWorker({ ...base, now: () => Date.now() + 1000, limiter: { ...noLimit, coolOff: async (_w: string, ms: number) => void cool.push(ms) }, send: async (_r, key) => answers[key] as never });
  await Promise.all(await w.poll());
  const [r429, r503, r400] = await Promise.all([row('o429'), row('o503'), row('o400')]);
  assert.equal(r429?.attempts, 0);
  assert.equal(r429?.state, 'pending');
  assert.ok(r429!.next_attempt_at.getTime() >= Date.now() + 1000 + 2000, 'not before Retry-After');
  assert.deepEqual(cool, [2250], 'Redis cool-off set for every copy');
  assert.equal(r503?.attempts, 1);
  assert.equal(r503?.state, 'pending');
  assert.equal(r400?.state, 'dead');
  assert.equal(r400?.status, 'failed');
});
