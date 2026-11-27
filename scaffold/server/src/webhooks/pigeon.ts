import type { Request, Response } from 'express';
import { verifySignature } from './signature.js';
import type { OutboundStatus, PigeonStore } from '../domain/store.js';
import { record, timed } from '../timing.js';

export interface PigeonDeps {
  secret: string;
  workspaces: ReadonlySet<string>;
  store: PigeonStore;
  now?: () => number; // ms; injectable for tests
}

const STATUSES = new Set<string>(['sent', 'delivered', 'failed']);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

// POST /webhooks/pigeon. Mounted with express.raw(), so req.body is the exact
// bytes Pigeon signed. The answers follow the table in PIGEON.md.
export function createPigeonHandler(deps: PigeonDeps) {
  const now = deps.now ?? Date.now;
  return async (req: Request, res: Response): Promise<void> => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    // 1. Authenticity first, before we look at what the body says. A forged
    //    request gets 401 whatever it contains, even if it is not JSON.
    const tVerify = performance.now();
    const sig = verifySignature(req.header('x-pigeon-signature'), raw, deps.secret, Math.floor(now() / 1000));
    record('verify', performance.now() - tVerify);
    if (sig !== 'ok') {
      res.status(401).json({ error: sig === 'stale' ? 'timestamp too old' : 'invalid signature' });
      return;
    }

    // 2. Genuine but unreadable: 400.
    let event: unknown;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      res.status(400).json({ error: 'body is not JSON' });
      return;
    }
    if (!isObject(event)) {
      res.status(400).json({ error: 'body is not a JSON object' });
      return;
    }

    // 3. Anything we do not handle is acknowledged, or Pigeon retries it for 22 s.
    const ignore = () => void res.status(200).json({ ok: true, ignored: true });
    if (event.type !== 'message.inbound' && event.type !== 'message.status') return ignore(); // unknown type
    if (!str(event.workspace) || !deps.workspaces.has(event.workspace)) return ignore(); // unknown workspace
    const workspace = event.workspace;
    const data = isObject(event.data) ? event.data : null;

    if (event.type === 'message.inbound') {
      const occurredAt = new Date(String(event.occurred_at));
      if (!data || !str(event.id) || !str(data.message_id) || !str(data.from) || Number.isNaN(occurredAt.getTime())) {
        res.status(400).json({ error: 'malformed message.inbound' });
        return;
      }
      const message = {
        workspace,
        contact: data.from,
        messageId: data.message_id,
        text: typeof data.text === 'string' ? data.text : '',
        occurredAt,
        eventId: event.id,
      };
      await timed('store', () => deps.store.storeInbound(message));
      res.status(200).json({ ok: true });
      return;
    }

    // message.status: only meaningful for a message we sent.
    if (!data || !str(data.client_ref) || typeof data.status !== 'string' || !STATUSES.has(data.status)) return ignore();
    const known = await deps.store.applyStatus(workspace, data.client_ref, data.status as OutboundStatus, str(data.message_id) ? data.message_id : null);
    if (!known) return ignore(); // never sent by us
    res.status(200).json({ ok: true });
  };
}
