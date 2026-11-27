import { collections, ensureConversation, isDuplicateKey } from './store.js';

// Claim: ONE atomic conditional update in MongoDB, on the same document that
// stores the assignee. The filter only matches while nobody else holds it, so
// six simultaneous claims have exactly one winner, across any number of
// server copies, and the claim survives a Redis restart.
export async function claimConversation(workspace: string, contact: string, agent: string): Promise<boolean> {
  const { conversations } = await collections();
  await ensureConversation(workspace, contact, new Date()); // "the claim creates the conversation"
  const r = await conversations.updateOne(
    { workspace, contact, assignee: { $in: [null, agent] } }, // free, or already mine
    { $set: { assignee: agent, status: 'open' } },
  );
  return r.matchedCount === 1; // 0 matched = someone else holds it -> 409
}

// A reply: stored durably first, sent later by the outbox worker. The unique
// index on (workspace, client_ref) makes the same reply asked twice, even in
// the same instant, exactly one row; both callers are told "accepted".
export async function enqueueReply(p: { workspace: string; contact: string; text: string; clientRef: string }): Promise<'created' | 'existing'> {
  const { outbound } = await collections();
  const now = new Date();
  await ensureConversation(p.workspace, p.contact, now); // the contact may never have written
  try {
    await outbound.insertOne({
      workspace: p.workspace,
      contact: p.contact,
      client_ref: p.clientRef,
      text: p.text,
      status: 'queued',
      pigeon_id: null,
      created_at: now,
      updated_at: now,
      attempts: 0,
      next_attempt_at: now,
      lease_until: new Date(0),
    });
    return 'created';
  } catch (err) {
    if (isDuplicateKey(err)) return 'existing';
    throw err;
  }
}

// What this system currently believes, for GET /__grader/snapshot.
export async function buildSnapshot(workspaces: string[]) {
  const { messages, conversations, outbound } = await collections();
  const out: Record<string, { contacts: Record<string, { inbound: string[]; assignee: string | null }>; outbound: Record<string, string> }> = {};
  for (const ws of workspaces) out[ws] = { contacts: {}, outbound: {} };

  for await (const c of conversations.find({ workspace: { $in: workspaces } })) {
    out[c.workspace].contacts[c.contact] = { inbound: [], assignee: c.assignee ?? null };
  }
  // Oldest first by provider time, then id: the order the UI shows.
  const cursor = messages.find({ workspace: { $in: workspaces } }).sort({ occurred_at: 1, message_id: 1 });
  for await (const m of cursor) {
    const entry = (out[m.workspace].contacts[m.contact] ??= { inbound: [], assignee: null });
    entry.inbound.push(m.message_id);
  }
  for await (const o of outbound.find({ workspace: { $in: workspaces } })) out[o.workspace].outbound[o.client_ref] = o.status;
  return { workspaces: out };
}
