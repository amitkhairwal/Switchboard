import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sign, verifySignature } from './signature.js';

const SECRET = 'whsec_pigeon_dev';
const NOW = 1_800_000_000;
const body = Buffer.from('{"a":1}');
const header = (t: number, mac = sign(SECRET, t, body)) => `t=${t},v1=${mac}`;

test('valid signature is ok', () => {
  assert.equal(verifySignature(header(NOW), body, SECRET, NOW), 'ok');
});

test('missing or malformed headers are "bad", and never throw', () => {
  for (const h of [undefined, '', 'garbage', 't=abc,v1=zz', `t=${NOW}`, `v1=${'a'.repeat(64)}`, `t=${NOW},v1=abcd`, `t=${NOW},v1=${'a'.repeat(63)}`, `t=${NOW},t=${NOW},v1=${'a'.repeat(64)}`, 'x'.repeat(5000)]) {
    assert.equal(verifySignature(h, body, SECRET, NOW), 'bad', String(h).slice(0, 40));
  }
});

test('wrong secret, or a MAC over different bytes, is "bad"', () => {
  assert.equal(verifySignature(header(NOW, sign('not-the-secret', NOW, body)), body, SECRET, NOW), 'bad');
  assert.equal(verifySignature(header(NOW), Buffer.from('{ "a": 1 }'), SECRET, NOW), 'bad'); // re-serialised body
});

test('five-minute window: 300 s old is genuine, 301 s old is stale', () => {
  assert.equal(verifySignature(header(NOW - 299), body, SECRET, NOW), 'ok');
  assert.equal(verifySignature(header(NOW - 300), body, SECRET, NOW), 'ok');
  assert.equal(verifySignature(header(NOW - 301), body, SECRET, NOW), 'stale');
  assert.equal(verifySignature(header(NOW - 3600), body, SECRET, NOW), 'stale'); // the replayed events
});

test('a stale timestamp with a wrong MAC is "bad", not "stale" (no oracle for forgers)', () => {
  assert.equal(verifySignature(header(NOW - 3600, sign('x', NOW - 3600, body)), body, SECRET, NOW), 'bad');
});
