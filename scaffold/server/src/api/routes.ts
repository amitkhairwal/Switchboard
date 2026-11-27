import { Router, type Request, type Response } from 'express';
import { ObjectId } from 'mongodb';
import { requireSession, isMember, type Session } from '../auth/session.js';
import { collections } from '../domain/store.js';
import { wrap } from '../grader/routes.js';

export const apiRouter = Router();
apiRouter.use(requireSession); // 401 for every /api route without a session

const sessionOf = (res: Response) => res.locals.session as Session;

apiRouter.get('/me', (_req, res) => {
  const { sub, name, email, workspaces } = sessionOf(res);
  res.json({ sub, name, email, workspaces });
});

// The ONLY place a workspace id from a request is turned into a query filter, and only
// after this check. 401 (no session) was answered above; here a signed-in user who is not
// a member gets 403, whether the workspace exists or not, so existence is not revealed.
function workspaceFor(req: Request, res: Response): string | null {
  const workspace = req.query.workspace;
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
