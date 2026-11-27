import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

// Integration tests against the real MongoDB and Redis (the dev container has
// them). They use their own database and are skipped if MongoDB is unreachable.
process.env.MONGO_URL = (process.env.MONGO_URL ?? 'mongodb://localhost:27017/switchboard').replace(/\/[^/]*$/, '') + '/switchboard_test';
process.env.GRADER_TOKEN = 'test-token';

const { createApp } = await import('../app.js');
const { initStore, mongoStore, collections } = await import('../domain/store.js');

let available = true;
try {
  await Promise.race([initStore(), new Promise((_, rej) => setTimeout(() => rej(new Error('no mongo')), 4000))]);
} catch {
  available = false;
}

let server: Server;
let base: string;
before(async () => {
  if (!available) return;
  server = createServer(createApp({ store: mongoStore, isReady: () => true }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server?.close();
  if (available) {
    const { db } = await collections();
    await db.client.close();
    const { getRedis } = await import('../redis.js');
    getRedis().disconnect();
  }
});

const call = (method: string, path: string, body?: unknown, token: string | null = 'test-token') =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token === null ? {} : { 'x-grader-token': token }) },
    body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
  });

test('every /__grader route answers 401 without the token or with a wrong one', { skip: !available }, async () => {
  for (const [m, p] of [['POST', '/__grader/reset'], ['GET', '/__grader/snapshot'], ['POST', '/__grader/reply'], ['POST', '/__grader/claim']] as const) {
    assert.equal((await call(m, p, {}, null)).status, 401, `${m} ${p} without token`);
    assert.equal((await call(m, p, {}, 'wrong')).status, 401, `${m} ${p} wrong token`);
    assert.equal((await call(m, p, {}, '')).status, 401, `${m} ${p} empty token`);
  }
});

test('same client_ref asked many times at the same instant is one reply, and all get 202', { skip: !available }, async () => {
  await call('POST', '/__grader/reset');
  const body = { workspace: 'ws_acme', contact: '+14155550101', text: 'hello', client_ref: 'dup_1' };
  const statuses = await Promise.all(Array.from({ length: 12 }, () => call('POST', '/__grader/reply', body).then((r) => r.status)));
  assert.deepEqual([...new Set(statuses)], [202]);
  const { outbound } = await collections();
  assert.equal(await outbound.countDocuments({ client_ref: 'dup_1' }), 1);
});

test('a reply to a contact who never wrote is accepted and creates the conversation', { skip: !available }, async () => {
  await call('POST', '/__grader/reset');
  const res = await call('POST', '/__grader/reply', { workspace: 'ws_globex', contact: '+442079460203', text: 'hi first', client_ref: 'new_1' });
  assert.equal(res.status, 202);
  const snap = await (await call('GET', '/__grader/snapshot')).json();
  assert.deepEqual(snap.workspaces.ws_globex.contacts['+442079460203'], { inbound: [], assignee: null });
  assert.equal(snap.workspaces.ws_globex.outbound.new_1, 'queued');
});

test('a reply or claim for a workspace that does not exist is a 4xx', { skip: !available }, async () => {
  const r = await call('POST', '/__grader/reply', { workspace: 'ws_nope', contact: '+1', text: 'x', client_ref: 'c' });
  const c = await call('POST', '/__grader/claim', { workspace: 'ws_nope', contact: '+1', agent: 'a' });
  assert.ok(r.status >= 400 && r.status < 500, String(r.status));
  assert.ok(c.status >= 400 && c.status < 500, String(c.status));
  assert.equal((await call('POST', '/__grader/reply', { workspace: 'ws_acme' })).status, 400);
});

test('six agents claiming at once: exactly one wins; the holder claiming again gets 200', { skip: !available }, async () => {
  await call('POST', '/__grader/reset');
  const contact = '+442079460201'; // has never written: the claim creates the conversation
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => call('POST', '/__grader/claim', { workspace: 'ws_globex', contact, agent: `a${i}` }).then((r) => r.status)));
  assert.equal(results.filter((s) => s === 200).length, 1, JSON.stringify(results));
  assert.equal(results.filter((s) => s === 409).length, 5, JSON.stringify(results));
  const winner = `a${results.indexOf(200)}`;
  assert.equal((await call('POST', '/__grader/claim', { workspace: 'ws_globex', contact, agent: winner })).status, 200);
  const snap = await (await call('GET', '/__grader/snapshot')).json();
  assert.equal(snap.workspaces.ws_globex.contacts[contact].assignee, winner);
});

test('inbound: duplicates collapse, thread is ordered by occurred_at, status never goes backwards', { skip: !available }, async () => {
  await call('POST', '/__grader/reset');
  const at = (s: number) => new Date(1_800_000_000_000 + s * 1000);
  const m = (id: string, s: number) => ({ workspace: 'ws_acme', contact: '+14155550101', messageId: id, text: '', occurredAt: at(s), eventId: 'e_' + id });
  assert.equal(await mongoStore.storeInbound(m('pmsg_b', 2)), true); // arrives first, happened second
  assert.equal(await mongoStore.storeInbound(m('pmsg_a', 1)), true);
  assert.equal(await mongoStore.storeInbound(m('pmsg_b', 2)), false); // duplicate delivery
  const snap = await (await call('GET', '/__grader/snapshot')).json();
  assert.deepEqual(snap.workspaces.ws_acme.contacts['+14155550101'].inbound, ['pmsg_a', 'pmsg_b']);

  await call('POST', '/__grader/reply', { workspace: 'ws_acme', contact: '+14155550101', text: 'x', client_ref: 's1' });
  await mongoStore.applyStatus('ws_acme', 's1', 'delivered', 'pm_1'); // final status arrives first...
  await mongoStore.applyStatus('ws_acme', 's1', 'sent', 'pm_1'); // ...then "sent" must not undo it
  assert.equal((await (await call('GET', '/__grader/snapshot')).json()).workspaces.ws_acme.outbound.s1, 'delivered');
  assert.equal(await mongoStore.applyStatus('ws_acme', 'never_sent', 'sent', null), false);
});
