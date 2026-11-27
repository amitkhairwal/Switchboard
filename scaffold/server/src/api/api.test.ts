import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';

// Login (against the real mock IdP), /api isolation and the WebSocket, over real HTTP.
process.env.MONGO_URL = (process.env.MONGO_URL ?? 'mongodb://localhost:27017/switchboard').replace(/\/[^/]*$/, '') + '/switchboard_test_api';

const { createApp } = await import('../app.js');
const { attachWebSocket } = await import('../ws.js');
const { mongoStore, initStore, collections, ensureConversation } = await import('../domain/store.js');
const { startEventReaders, stopEventReaders, publish } = await import('../events/bus.js');
const { startLogin } = await import('../auth/oidc.js');
const { createSession } = await import('../auth/session.js');
const { getRedis } = await import('../redis.js');

let available = true;
try {
  await Promise.race([initStore(), new Promise((_, rej) => setTimeout(() => rej(new Error('no mongo')), 4000))]);
} catch {
  available = false;
}
let idp = true;
try {
  await startLogin();
} catch {
  idp = false;
}

const WS_A = `t_api_${Math.random().toString(36).slice(2, 8)}`;
const WS_B = `t_api_${Math.random().toString(36).slice(2, 8)}`;
let server: Server;
let base: string;
let cookieA: string; // a member of WS_A only
let cookieB: string; // a member of WS_B only

before(async () => {
  if (!available) return;
  server = createServer(createApp({ store: mongoStore, isReady: () => true }));
  attachWebSocket(server, () => undefined);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  startEventReaders([WS_A, WS_B], () => undefined);
  cookieA = `sb_session=${await createSession({ sub: 'u_a', workspaces: [{ id: WS_A, role: 'agent' }] }, 300)}`;
  cookieB = `sb_session=${await createSession({ sub: 'u_b', workspaces: [{ id: WS_B, role: 'admin' }] }, 300)}`;
});
after(async () => {
  stopEventReaders();
  server?.close();
  if (available) {
    const { db } = await collections();
    await db.collection('conversations').deleteMany({ workspace: { $in: [WS_A, WS_B] } });
    await db.collection('messages').deleteMany({ workspace: { $in: [WS_A, WS_B] } });
    await getRedis().del(`sb:seq:${WS_A}`, `sb:ev:${WS_A}`, `sb:seq:${WS_B}`, `sb:ev:${WS_B}`);
    await db.client.close();
    getRedis().disconnect();
  }
});

const get = (path: string, cookie?: string) => fetch(`http://${base}${path}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });

// ---- login ------------------------------------------------------------------------------
test('login: authorization code + PKCE through the real IdP; the callback needs only Redis, so any copy can finish it', { skip: !available || !idp }, async () => {
  const toIdp = new URL(await startLogin()); // "copy 1" starts the login
  assert.equal(toIdp.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(toIdp.searchParams.get('state') && toIdp.searchParams.get('nonce'));
  toIdp.searchParams.set('login', 'u_ben');
  const back = new URL((await fetch(toIdp, { redirect: 'manual' })).headers.get('location')!);
  // "copy 2" (this server, which never saw /auth/login) finishes it:
  const done = await get(`/auth/callback${back.search}`);
  assert.equal(done.status, 302);
  const cookie = done.headers.get('set-cookie')!;
  assert.match(cookie, /^sb_session=[\w-]{43};.*HttpOnly.*SameSite=Lax/);
  const me = await (await get('/api/me', cookie.split(';')[0])).json();
  assert.equal(me.sub, 'u_ben');
  assert.deepEqual(me.workspaces, [{ id: 'ws_acme', role: 'agent' }]);
  // a state works once; a forged one never
  assert.equal((await get(`/auth/callback${back.search}`)).status, 400);
  assert.equal((await get('/auth/callback?code=x&state=nope')).status, 400);
  assert.equal((await get('/auth/callback')).status, 400);
});

test('GET /auth/login redirects to the IdP with PKCE', { skip: !available || !idp }, async () => {
  const res = await get('/auth/login');
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location')!, /^http:\/\/localhost:4020\/authorize\?.*code_challenge=.*&code_challenge_method=S256/);
});

// ---- API isolation -------------------------------------------------------------------------
test('/api/me: 401 without a session (or with a forged one), 200 with', { skip: !available }, async () => {
  assert.equal((await get('/api/me')).status, 401);
  assert.equal((await get('/api/me', 'sb_session=' + 'A'.repeat(43))).status, 401);
  assert.equal((await get('/api/me', 'sb_session=not-an-id')).status, 401);
  assert.equal((await get('/api/me', cookieA)).status, 200);
});

test('/api/conversations: 401 / 403 / 200, and a member never sees another workspace', { skip: !available }, async () => {
  await mongoStore.storeInbound({ workspace: WS_A, contact: '+1000001', messageId: 'pmsg_a1', text: 'for A', occurredAt: new Date(1_800_000_001_000), eventId: 'e1' });
  await mongoStore.storeInbound({ workspace: WS_B, contact: '+1000002', messageId: 'pmsg_b1', text: 'for B', occurredAt: new Date(1_800_000_002_000), eventId: 'e2' });
  assert.equal((await get(`/api/conversations?workspace=${WS_A}`)).status, 401);
  assert.equal((await get(`/api/conversations?workspace=${WS_B}`, cookieA)).status, 403, 'signed in, not a member');
  assert.equal((await get('/api/conversations?workspace=ws_does_not_exist', cookieA)).status, 403, 'existence is not revealed');
  assert.equal((await get('/api/conversations', cookieA)).status, 400);
  const a = await (await get(`/api/conversations?workspace=${WS_A}`, cookieA)).json();
  assert.deepEqual(a.conversations.map((c: { contact: string }) => c.contact), ['+1000001']);
  assert.equal(a.conversations[0].last_message.text, 'for A');
  assert.ok(!JSON.stringify(a).includes('for B'));
});

test('/api/conversations: newest activity first, and pages join up without gaps or repeats', { skip: !available }, async () => {
  for (let i = 0; i < 5; i++) await ensureConversation(WS_B, `+2000${i}`, new Date(1_800_000_100_000 + i * 1000));
  await ensureConversation(WS_B, '+2000tie', new Date(1_800_000_100_000 + 4000)); // same time as +20004
  const seen: string[] = [];
  let before: string | null = null;
  for (let page = 0; page < 10; page++) {
    const r = await (await get(`/api/conversations?workspace=${WS_B}&limit=2${before ? `&before=${before}` : ''}`, cookieB)).json();
    seen.push(...r.conversations.map((c: { contact: string }) => c.contact));
    before = r.next;
    if (!before) break;
  }
  assert.equal(new Set(seen).size, seen.length, 'no repeats');
  assert.equal(seen.length, 7); // 5 + the tie + the one from the earlier test
  const times = (await (await get(`/api/conversations?workspace=${WS_B}&limit=100`, cookieB)).json()).conversations.map((c: { last_activity: string }) => Date.parse(c.last_activity));
  assert.deepEqual(times, [...times].sort((x, y) => y - x));
  assert.equal((await get(`/api/conversations?workspace=${WS_B}&before=garbage`, cookieB)).status, 400);
});

// ---- WebSocket ---------------------------------------------------------------------------------
function open(workspace: string, cookie?: string, after?: number) {
  const frames: { seq: number; type: string; [k: string]: unknown }[] = [];
  const url = `ws://${base}/ws?workspace=${workspace}${after === undefined ? '' : `&after=${after}`}`;
  return new Promise<{ opened: boolean; status?: number; frames: typeof frames; close: () => void }>((resolve) => {
    const ws = new WebSocket(url, { headers: cookie ? { cookie } : {} });
    let settled = false;
    const done = (opened: boolean, status?: number) => !settled && ((settled = true), resolve({ opened, status, frames, close: () => ws.close() }));
    ws.on('open', () => done(true));
    ws.on('unexpected-response', (_req, res) => done(false, res.statusCode));
    ws.on('error', () => done(false));
    ws.on('message', (m) => frames.push(JSON.parse(String(m))));
  });
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('ws: refused without a session (401) and for a workspace the user is not in (403); opens for a member', { skip: !available }, async () => {
  const anon = await open(WS_A);
  assert.deepEqual([anon.opened, anon.status], [false, 401]);
  const stranger = await open(WS_A, cookieB);
  assert.deepEqual([stranger.opened, stranger.status], [false, 403]);
  assert.equal((await open(WS_A, cookieA, -1 as number)).opened, false);
  const ok = await open(WS_A, cookieA);
  assert.equal(ok.opened, true);
  ok.close();
});

test('ws: live frames arrive with rising seq, only for that workspace; reconnecting with after= replays exactly what was missed', { skip: !available }, async () => {
  const live = await open(WS_A, cookieA);
  for (let i = 0; i < 3; i++) await publish(WS_A, { type: 'message.inbound', contact: '+1000001', message_id: `pmsg_live_${i}` });
  await publish(WS_B, { type: 'message.inbound', contact: '+x', message_id: 'pmsg_other_workspace' });
  await wait(400);
  assert.deepEqual(live.frames.map((f) => f.message_id), ['pmsg_live_0', 'pmsg_live_1', 'pmsg_live_2']);
  assert.ok(live.frames.every((f, i) => i === 0 || f.seq > live.frames[i - 1].seq));
  const last = live.frames[live.frames.length - 1].seq;
  live.close();
  await wait(100);

  for (let i = 0; i < 4; i++) await publish(WS_A, { type: 'message.inbound', contact: '+1000001', message_id: `pmsg_missed_${i}` });
  const again = await open(WS_A, cookieA, last);
  await wait(400);
  assert.deepEqual(again.frames.map((f) => f.message_id), ['pmsg_missed_0', 'pmsg_missed_1', 'pmsg_missed_2', 'pmsg_missed_3']);
  assert.ok(again.frames.every((f) => f.seq > last), 'nothing at or before after= is sent again');
  again.close();
});

test('ws: frames published while the replay is being sent are neither lost nor repeated', { skip: !available }, async () => {
  const probe = await open(WS_A, cookieA);
  await publish(WS_A, { type: 'marker', n: -1 });
  await wait(200);
  const from = probe.frames[probe.frames.length - 1].seq - 1;
  probe.close();
  for (let i = 0; i < 300; i++) await publish(WS_A, { type: 'bulk', n: i }); // history to replay
  const racing = open(WS_A, cookieA, from); // replay of ~300 frames starts...
  const sender = (async () => {
    for (let i = 300; i < 400; i++) await publish(WS_A, { type: 'bulk', n: i }); // ...while 100 more are published
  })();
  const sock = await racing;
  await sender;
  await wait(800);
  const bulk = sock.frames.filter((f) => f.type === 'bulk').map((f) => f.n as number);
  assert.deepEqual(bulk, Array.from({ length: 400 }, (_, i) => i));
  const seqs = sock.frames.map((f) => f.seq);
  assert.ok(seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1), 'contiguous seq, no gap, no repeat');
  sock.close();
});
