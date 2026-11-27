import { timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { config } from '../config.js';
import { buildSnapshot, claimConversation, enqueueReply } from '../domain/conversations.js';
import { resetAll } from '../domain/store.js';

export const wrap = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => {
  fn(req, res).catch(next); // Express 4 does not catch rejected promises itself
};

function tokenMatches(given: string | undefined): boolean {
  const want = Buffer.from(config.graderToken);
  if (want.length === 0 || given === undefined) return false; // an unset token never matches
  const got = Buffer.from(given);
  return got.length === want.length && timingSafeEqual(got, want);
}

// Every /__grader route sits behind this: no header or a wrong one -> 401.
export function requireGraderToken(req: Request, res: Response, next: NextFunction): void {
  if (!tokenMatches(req.header('x-grader-token'))) {
    res.status(401).json({ error: 'missing or wrong x-grader-token' });
    return;
  }
  next();
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 256;
const knownWorkspace = (v: unknown): v is string => typeof v === 'string' && config.workspaces.includes(v);

export const graderRouter = Router();
graderRouter.use(requireGraderToken);

graderRouter.post('/reset', wrap(async (_req, res) => {
  await resetAll();
  res.status(200).json({ ok: true });
}));

graderRouter.get('/snapshot', wrap(async (_req, res) => {
  res.json(await buildSnapshot(config.workspaces));
}));

// Same function the UI's reply endpoint will call; 202 means "safely stored".
graderRouter.post('/reply', wrap(async (req, res) => {
  const b = req.body ?? {};
  if (!nonEmpty(b.contact) || !nonEmpty(b.client_ref) || typeof b.text !== 'string' || b.text.length === 0 || b.text.length > 4096) {
    res.status(400).json({ error: 'workspace, contact, text and client_ref are required' });
    return;
  }
  if (!knownWorkspace(b.workspace)) {
    res.status(404).json({ error: 'unknown workspace' });
    return;
  }
  await enqueueReply({ workspace: b.workspace, contact: b.contact, text: b.text, clientRef: b.client_ref });
  res.status(202).json({ ok: true, client_ref: b.client_ref });
}));

graderRouter.post('/claim', wrap(async (req, res) => {
  const b = req.body ?? {};
  if (!nonEmpty(b.contact) || !nonEmpty(b.agent)) {
    res.status(400).json({ error: 'workspace, contact and agent are required' });
    return;
  }
  if (!knownWorkspace(b.workspace)) {
    res.status(404).json({ error: 'unknown workspace' });
    return;
  }
  const won = await claimConversation(b.workspace, b.contact, b.agent);
  res.status(won ? 200 : 409).json({ ok: won });
}));
