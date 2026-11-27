import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { createApp } from '../app.js';
import type { PigeonStore } from '../domain/store.js';
import { sign } from './signature.js';

// The "how your endpoint must answer" table of PIGEON.md, one test per row.
const SECRET = 'whsec_pigeon_dev';
let calls: { inbound: unknown[]; status: unknown[] };
let known = true; // does the fake store know the message a status refers to?
let failing = false;

const store: PigeonStore = {
  async storeInbound(m) {
    if (failing) throw new Error('mongo down');
    calls.inbound.push(m);
    return true;
  },
  async applyStatus(...args) {
    if (failing) throw new Error('mongo down');
    calls.status.push(args);
    return known;
  },
};

let server: Server;
let base: string;
before(async () => {
  server = createServer(createApp({ store, isReady: () => true }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(() => {
  calls = { inbound: [], status: [] };
  known = true;
  failing = false;
});

const inbound = (over: Record<string, unknown> = {}) => ({
  id: 'evt_1', type: 'message.inbound', workspace: 'ws_acme', occurred_at: new Date().toISOString(),
  data: { message_id: 'pmsg_1', from: '+14155550101', text: 'Hi' }, ...over,
});

async function post(raw: string, opts: { t?: number; mac?: string; header?: string | null } = {}) {
  const t = opts.t ?? Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.header !== null) headers['x-pigeon-signature'] = opts.header ?? `t=${t},v1=${opts.mac ?? sign(SECRET, t, raw)}`;
  const res = await fetch(`${base}/webhooks/pigeon`, { method: 'POST', headers, body: raw });
  return res.status;
}

test('forged: missing / malformed / wrong signature -> 401', async () => {
  const raw = JSON.stringify(inbound());
  assert.equal(await post(raw, { header: null }), 401);
  for (const header of ['garbage', 't=1', 't=abc,v1=zz', `t=${Math.floor(Date.now() / 1000)},v1=beef`]) assert.equal(await post(raw, { header }), 401, header);
  assert.equal(await post(raw, { mac: sign('not-the-secret', Math.floor(Date.now() / 1000), raw) }), 401);
  assert.equal(await post('not json at all', { header: 'garbage' }), 401); // unreadable AND forged -> 401, not 400
  assert.equal(calls.inbound.length, 0);
});

test('raw body: the MAC covers the raw bytes, not a re-serialisation', async () => {
  const pretty = JSON.stringify(inbound(), null, 4); // odd whitespace must still verify
  assert.equal(await post(pretty), 200);
  const t = Math.floor(Date.now() / 1000);
  assert.equal(await post(pretty, { mac: sign(SECRET, t, JSON.stringify(JSON.parse(pretty))), t }), 401);
});

test('replay: valid signature but older than five minutes -> 401', async () => {
  const raw = JSON.stringify(inbound());
  assert.equal(await post(raw, { t: Math.floor(Date.now() / 1000) - 3600 }), 401);
  assert.equal(await post(raw, { t: Math.floor(Date.now() / 1000) - 310 }), 401);
  assert.equal(calls.inbound.length, 0);
});

test('slow network: valid signature up to five minutes old is genuine', async () => {
  assert.equal(await post(JSON.stringify(inbound()), { t: Math.floor(Date.now() / 1000) - 290 }), 200);
  assert.equal(calls.inbound.length, 1);
});

test('stored: valid event that is stored -> 2xx; if storing fails -> 5xx so Pigeon retries', async () => {
  assert.equal(await post(JSON.stringify(inbound())), 200);
  assert.equal(calls.inbound.length, 1);
  failing = true;
  assert.equal(await post(JSON.stringify(inbound({ id: 'evt_2' }))), 503);
});

test('unknown type: valid signature, unknown event type -> 2xx', async () => {
  assert.equal(await post(JSON.stringify(inbound({ type: 'message.reaction' }))), 200);
  assert.equal(await post(JSON.stringify({ type: 'brand.new', anything: [1, 2] })), 200);
  assert.equal(calls.inbound.length + calls.status.length, 0);
});

test('unknown status: status for a message we never sent -> 2xx and ignored', async () => {
  known = false;
  const ev = { id: 'evt_s', type: 'message.status', workspace: 'ws_acme', occurred_at: new Date().toISOString(), data: { message_id: 'pm_x', client_ref: 'nope', status: 'sent' } };
  assert.equal(await post(JSON.stringify(ev)), 200);
  const noRef = { ...ev, data: { message_id: 'pm_x', status: 'delivered' } }; // no client_ref at all
  assert.equal(await post(JSON.stringify(noRef)), 200);
});

test('unparseable: valid signature, body that cannot be parsed -> 400, never 5xx', async () => {
  for (const raw of ['', '{"truncated":', 'plain text', '[]', '"a string"', '42', 'null']) assert.equal(await post(raw), 400, JSON.stringify(raw));
  assert.equal(await post(JSON.stringify(inbound({ data: { from: '+1' } }))), 400); // known type, missing message_id
  assert.equal(await post(JSON.stringify(inbound({ occurred_at: 'yesterday-ish' }))), 400);
  assert.equal(calls.inbound.length, 0);
});

test('unknown workspace: valid signature, workspace we do not know -> 2xx and ignored', async () => {
  assert.equal(await post(JSON.stringify(inbound({ workspace: 'ws_unknown' }))), 200);
  assert.equal(await post(JSON.stringify(inbound({ workspace: undefined }))), 200);
  assert.equal(calls.inbound.length, 0);
});
