import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { ObjectId } from 'mongodb';
import { allowedOrigin, requireSession, isMember, type Session } from '../auth/session.js';
import { claimConversation, enqueueReply } from '../domain/conversations.js';
import { collections } from '../domain/store.js';
import { publish } from '../events/bus.js';
import { wrap } from '../grader/routes.js';

export const apiRouter = Router();
apiRouter.use(requireSession); // 401 for every /api route without a session
// A page on another site must not be able to act with the user's cookie (SameSite=Lax already withholds it
// from most cross-site requests; this closes the rest). Only our own web origin may change anything.
apiRouter.use((req, res, next) => {
  if (req.method !== 'GET' && !allowedOrigin(req)) {
    res.status(403).json({ error: 'cross-site request refused' });
    return;
  }
  next();
});

const sessionOf = (res: Response) => res.locals.session as Session;

apiRouter.get('/me', (_req, res) => {
  const { sub, name, email, workspaces } = sessionOf(res);
  res.json({ sub, name, email, workspaces });
});

// The ONLY place a workspace id from a request is turned into a query filter, and only
// after this check. 401 (no session) was answered above; here a signed-in user who is not
// a member gets 403, whether the workspace exists or not, so existence is not revealed.
function workspaceFor(req: Request, res: Response): string | null {
  const workspace = req.method === 'GET' ? req.query.workspace : (req.body as { workspace?: unknown } | undefined)?.workspace;
  if (typeof workspace !== 'string' || !workspace) {
    res.status(400).json({ error: 'workspace is required' });
    return null;
  }
  if (!isMember(sessionOf(res), workspace)) {
    res.status(403).json({ error: 'you are not a member of this workspace' });
    return null;
  }
  return workspace;
}

// Newest activity first, keyset-paginated: `next` is the cursor to pass as ?before=.
apiRouter.get('/conversations', wrap(async (req, res) => {
  const workspace = workspaceFor(req, res);
  if (!workspace) return;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const filter: Record<string, unknown> = { workspace };
  if (typeof req.query.before === 'string') {
    const m = /^(\d{1,15})_([0-9a-f]{24})$/.exec(req.query.before);
    if (!m) {
      res.status(400).json({ error: 'before is not a cursor from this API' });
      return;
    }
    const at = new Date(Number(m[1]));
    const id = new ObjectId(m[2]);
    filter.$or = [{ last_activity: { $lt: at } }, { last_activity: at, _id: { $lt: id } }];
  }
  const { conversations, messages } = await collections();
  const rows = await conversations.find(filter).sort({ last_activity: -1, _id: -1 }).limit(limit + 1).toArray();
  const page = rows.slice(0, limit);
  const items = await Promise.all(
    page.map(async (c) => {
      const [last] = await messages.find({ workspace, contact: c.contact }).sort({ occurred_at: -1, message_id: -1 }).limit(1).toArray();
      return {
        contact: c.contact,
        assignee: c.assignee,
        status: c.status,
        last_activity: c.last_activity,
        last_message: last ? { message_id: last.message_id, text: last.text, occurred_at: last.occurred_at } : null,
      };
    }),
  );
  const tail = page[page.length - 1];
  res.json({ workspace, conversations: items, next: rows.length > limit && tail ? `${tail.last_activity.getTime()}_${tail._id}` : null });
}));

const nonEmpty = (v: unknown, max = 256): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

// One conversation: its messages in both directions, oldest first (the last 200).
apiRouter.get('/conversation', wrap(async (req, res) => {
  const workspace = workspaceFor(req, res);
  if (!workspace) return;
  const contact = req.query.contact;
  if (!nonEmpty(contact)) {
    res.status(400).json({ error: 'contact is required' });
    return;
  }
  const { conversations, messages, outbound } = await collections();
  const conversation = await conversations.findOne({ workspace, contact });
  if (!conversation) {
    res.status(404).json({ error: 'no such conversation' });
    return;
  }
  const [incoming, replies] = await Promise.all([
    messages.find({ workspace, contact }).sort({ occurred_at: -1, message_id: -1 }).limit(200).toArray(),
    outbound.find({ workspace, contact }).sort({ created_at: -1 }).limit(200).toArray(),
  ]);
  const thread = [
    ...incoming.map((m) => ({ direction: 'in' as const, id: m.message_id, text: m.text, at: m.occurred_at })),
    ...replies.map((o) => ({ direction: 'out' as const, id: o.client_ref, text: o.text, at: o.created_at, status: o.status })),
  ]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(-200);
  res.json({ contact, assignee: conversation.assignee, status: conversation.status, messages: thread });
}));

// An agent replies. Stored first (202 = safely stored), sent by the outbox worker. The browser may send its own
// client_ref and retry with it: the same reply is then never stored or sent twice.
apiRouter.post('/reply', wrap(async (req, res) => {
  const workspace = workspaceFor(req, res);
  if (!workspace) return;
  const b = req.body as { contact?: unknown; text?: unknown; client_ref?: unknown };
  if (!nonEmpty(b.contact) || typeof b.text !== 'string' || !b.text.trim() || b.text.length > 4096) {
    res.status(400).json({ error: 'contact and text are required' });
    return;
  }
  const clientRef = b.client_ref === undefined ? `ui_${randomUUID()}` : b.client_ref;
  if (!nonEmpty(clientRef, 128) || !/^[\w.:-]+$/.test(clientRef)) {
    res.status(400).json({ error: 'client_ref may only contain letters, digits and _ . : -' });
    return;
  }
  await enqueueReply({ workspace, contact: b.contact, text: b.text, clientRef });
  // Tell the other agents' screens. Idempotent (same marker the status webhooks use), so a retry is safe.
  await publish(workspace, { type: 'message.status', contact: b.contact, client_ref: clientRef, status: 'queued' }, `st:${clientRef}:queued`);
  res.status(202).json({ client_ref: clientRef });
}));

// The signed-in agent claims a conversation: 200 if they now hold it, 409 if somebody else does.
apiRouter.post('/claim', wrap(async (req, res) => {
  const workspace = workspaceFor(req, res);
  if (!workspace) return;
  const { contact } = req.body as { contact?: unknown };
  if (!nonEmpty(contact)) {
    res.status(400).json({ error: 'contact is required' });
    return;
  }
  const agent = sessionOf(res).sub; // taken from the session, never from the request
  if (await claimConversation(workspace, contact, agent)) {
    res.json({ assignee: agent });
    return;
  }
  const { conversations } = await collections();
  const holder = await conversations.findOne({ workspace, contact });
  res.status(409).json({ error: 'someone else holds this conversation', assignee: holder?.assignee ?? null });
}));

// Close or reopen.
apiRouter.post('/conversation/status', wrap(async (req, res) => {
  const workspace = workspaceFor(req, res);
  if (!workspace) return;
  const { contact, status } = req.body as { contact?: unknown; status?: unknown };
  if (!nonEmpty(contact) || (status !== 'open' && status !== 'closed')) {
    res.status(400).json({ error: "contact and status ('open' or 'closed') are required" });
    return;
  }
  const { conversations } = await collections();
  const r = await conversations.updateOne({ workspace, contact }, { $set: { status } });
  if (r.matchedCount === 0) {
    res.status(404).json({ error: 'no such conversation' });
    return;
  }
  if (r.modifiedCount === 1) await publish(workspace, { type: 'conversation.status', contact, status });
  res.json({ status });
}));
