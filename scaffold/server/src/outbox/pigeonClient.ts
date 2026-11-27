import { config } from '../config.js';

export interface SendRequest {
  workspace: string;
  to: string;
  text: string;
  clientRef: string;
}

// What happened, in the only terms the worker cares about.
export type SendResult =
  | { kind: 'accepted'; pigeonId: string | null }
  | { kind: 'rate_limited'; retryAfterMs: number } // 429: do not send again for this long
  | { kind: 'retry'; reason: string } // 5xx, timeout, network: outcome unknown or temporary
  | { kind: 'permanent'; reason: string }; // this request can never succeed

export type SendFn = (req: SendRequest, idempotencyKey: string) => Promise<SendResult>;

// The Idempotency-Key for a reply. It is a pure function of the reply's identity,
// never of the attempt, the copy or the time, so every retry from any copy, before
// or after a crash, carries the same key and Pigeon sends the message once.
// (Pigeon scopes keys to the workspace, and client_ref is unique per workspace.)
export const idempotencyKeyFor = (clientRef: string): string => `sb-${clientRef}`;

export const sendViaPigeon: SendFn = async (req, idempotencyKey) => {
  const apiKey = config.pigeon.apiKeys[req.workspace];
  if (!apiKey) return { kind: 'permanent', reason: `no Pigeon API key for ${req.workspace}` };
  let res: Response;
  try {
    res = await fetch(`${config.pigeon.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ to: req.to, text: req.text, client_ref: req.clientRef }),
      signal: AbortSignal.timeout(config.outbox.attemptTimeoutMs),
    });
  } catch (err) {
    // Timeout or connection error: the message may or may not have been accepted.
    // The caller retries with the same Idempotency-Key, which makes that safe.
    return { kind: 'retry', reason: (err as Error).name === 'TimeoutError' ? 'timeout' : `network: ${(err as Error).message}` };
  }
  try {
    if (res.status === 200) {
      const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
      return { kind: 'accepted', pigeonId: typeof body?.id === 'string' ? body.id : null };
    }
    await res.arrayBuffer().catch(() => undefined); // drain the connection
    if (res.status === 429) {
      const seconds = Number(res.headers.get('retry-after'));
      return { kind: 'rate_limited', retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2000 };
    }
    if (res.status === 400) return { kind: 'permanent', reason: 'Pigeon rejected the request (400)' };
    return { kind: 'retry', reason: `HTTP ${res.status}` }; // 503, 401 (fixable by an operator), anything else
  } catch (err) {
    return { kind: 'retry', reason: `read: ${(err as Error).message}` };
  }
};
