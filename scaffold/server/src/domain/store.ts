import type { Collection, Db } from 'mongodb';
import { getDb } from '../db.js';
import { publish } from '../events/bus.js';
import { getRedis } from '../redis.js';
import { timed } from '../timing.js';

// ---- documents -----------------------------------------------------------
export type OutboundStatus = 'queued' | 'sent' | 'delivered' | 'failed';

export interface MessageDoc {
  workspace: string;
  contact: string;
  message_id: string; // Pigeon's pmsg_… id; unique per workspace
  text: string;
  occurred_at: Date; // provider time: this, not arrival time, orders the thread
  event_id: string;
  received_at: Date;
}

export interface ConversationDoc {
  workspace: string;
  contact: string;
  assignee: string | null;
  status: 'open' | 'closed';
  last_activity: Date;
  created_at: Date;
}

export interface OutboundDoc {
  workspace: string;
  contact: string;
  client_ref: string; // unique per workspace: the idempotency identity of a reply
  text: string;
  status: OutboundStatus;
  pigeon_id: string | null;
  created_at: Date;
  updated_at: Date;
  // Outbox bookkeeping, used only by the sender worker (outbox/worker.ts).
  // `status` is what the customer-facing lifecycle says (from Pigeon's webhooks);
  // `state` is whether Pigeon has taken the message yet, and is what the worker acts on.
  state: 'pending' | 'accepted' | 'dead';
  accepted_at: Date | null;
  attempts: number; // failed attempts so far; drives the backoff
  next_attempt_at: Date; // not before this time
  lease_until: Date; // another copy may take the row once this has passed
  lease_token: string | null; // identifies the current holder; fences stale completions
  last_error: string | null;
}

export const cols = {
  messages: (db: Db): Collection<MessageDoc> => db.collection('messages'),
  conversations: (db: Db): Collection<ConversationDoc> => db.collection('conversations'),
  outbound: (db: Db): Collection<OutboundDoc> => db.collection('outbound'),
};

export async function collections() {
  const db = await getDb();
  return { db, messages: cols.messages(db), conversations: cols.conversations(db), outbound: cols.outbound(db) };
}

// Idempotent, so every copy of the server can run it at start-up.
export async function initStore(): Promise<void> {
  const c = await collections();
  await Promise.all([
    c.messages.createIndex({ workspace: 1, message_id: 1 }, { unique: true }),
    c.messages.createIndex({ workspace: 1, contact: 1, occurred_at: 1, message_id: 1 }),
    c.conversations.createIndex({ workspace: 1, contact: 1 }, { unique: true }),
    c.conversations.createIndex({ workspace: 1, last_activity: -1 }),
    c.outbound.createIndex({ workspace: 1, client_ref: 1 }, { unique: true }),
    c.outbound.createIndex({ workspace: 1, state: 1, next_attempt_at: 1, lease_until: 1 }),
  ]);
  await getRedis().ping();
}

export function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

// Creates the conversation if it does not exist yet. Safe to call concurrently:
// the loser of the race hits the unique index and simply carries on.
export async function ensureConversation(workspace: string, contact: string, activity: Date): Promise<void> {
  const { conversations } = await collections();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await conversations.updateOne(
        { workspace, contact },
        {
          $setOnInsert: { workspace, contact, assignee: null, status: 'open', created_at: new Date() },
          $max: { last_activity: activity },
        },
        { upsert: true },
      );
      return;
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
  }
}

// ---- the store the webhook handler talks to -----------------------------------
export interface PigeonStore {
  // Stores a customer's message once. Returns false when it was already there.
  storeInbound(m: { workspace: string; contact: string; messageId: string; text: string; occurredAt: Date; eventId: string }): Promise<boolean>;
  // Moves one of OUR messages forward in its lifecycle, never backwards.
  // Returns false when no such message exists (a status for something never sent).
  applyStatus(workspace: string, clientRef: string, status: OutboundStatus, pigeonId: string | null): Promise<boolean>;
}

const RANK: Record<OutboundStatus, number> = { queued: 0, sent: 1, delivered: 2, failed: 2 };
const LOWER: Record<OutboundStatus, OutboundStatus[]> = {
  queued: [],
  sent: ['queued'],
  delivered: ['queued', 'sent'],
  failed: ['queued', 'sent'],
};
export const statusRank = (s: OutboundStatus) => RANK[s];

export const mongoStore: PigeonStore = {
  async storeInbound(m) {
    const { messages } = await collections();
    let inserted = false;
    try {
      const r = await timed('mongo.message', () => messages.updateOne(
        { workspace: m.workspace, message_id: m.messageId },
        {
          $setOnInsert: {
            workspace: m.workspace,
            contact: m.contact,
            message_id: m.messageId,
            text: m.text,
            occurred_at: m.occurredAt,
            event_id: m.eventId,
            received_at: new Date(),
          },
        },
        { upsert: true },
      ));
      inserted = r.upsertedCount === 1;
    } catch (err) {
      if (!isDuplicateKey(err)) throw err; // two copies upserting the same id: one lost the race
    }
    // Runs even for a duplicate: if a crash hit between the two writes the first
    // time, Pigeon's retry repairs the conversation row.
    await timed('mongo.conversation', () => ensureConversation(m.workspace, m.contact, m.occurredAt));
    // Published on every delivery, not only the first: the marker (key "in:<id>") makes it once-only, and
    // it means a crash after the write but before this line is repaired by Pigeon's retry. If Redis is
    // down this throws, the webhook answers 503, and Pigeon retries.
    await publish(m.workspace, { type: 'message.inbound', contact: m.contact, message_id: m.messageId, text: m.text, occurred_at: m.occurredAt.toISOString() }, `in:${m.messageId}`);
    return inserted;
  },

  async applyStatus(workspace, clientRef, status, pigeonId) {
    const { outbound } = await collections();
    const now = new Date();
    const moved = await outbound.findOneAndUpdate(
      { workspace, client_ref: clientRef, status: { $in: LOWER[status] } },
      { $set: { status, updated_at: now, ...(pigeonId ? { pigeon_id: pigeonId } : {}) } },
      { returnDocument: 'after' },
    );
    // Any status webhook proves Pigeon already has the message (it can arrive
    // before the slow HTTP response does), so the worker must stop retrying it.
    await outbound.updateOne({ workspace, client_ref: clientRef, state: 'pending' }, { $set: { state: 'accepted', accepted_at: now, lease_token: null } });
    // Not moved: either it is already at or past this status (fine), or it does not exist.
    const row = moved ?? (await outbound.findOne({ workspace, client_ref: clientRef }));
    if (!row) return false;
    // Same repair-by-retry rule as above: announce the status the row has reached, once.
    if (row.status === status) await publish(workspace, { type: 'message.status', contact: row.contact, client_ref: clientRef, status }, `st:${clientRef}:${status}`);
    return true;
  },
};

// ---- reset (grader) ----------------------------------------------------------
// Deletes every document but keeps collections and their indexes, so a reset in
// the middle of a run never leaves a window with no unique indexes.
export async function resetAll(): Promise<void> {
  const c = await collections();
  await Promise.all([c.messages.deleteMany({}), c.conversations.deleteMany({}), c.outbound.deleteMany({})]);
  const redis = getRedis();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'sb:*', 'COUNT', 200);
    cursor = next;
    // Sessions and login attempts may stay. The seq counters must stay too: frames carry a number that only
    // goes up, and connected browsers would otherwise see it jump back. (The frames themselves, sb:ev:*, go.)
    const doomed = keys.filter((k) => !k.startsWith('sb:sess:') && !k.startsWith('sb:oidc:') && !k.startsWith('sb:seq:'));
    if (doomed.length) await redis.del(...doomed);
  } while (cursor !== '0');
}
