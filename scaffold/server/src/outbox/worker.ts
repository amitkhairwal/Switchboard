import { randomUUID } from 'node:crypto';
import type { WithId } from 'mongodb';
import { collections, type OutboundDoc } from '../domain/store.js';
import type { Limiter } from './limiter.js';
import { idempotencyKeyFor, type SendFn, type SendResult } from './pigeonClient.js';

// The outbox worker: moves replies from "stored in MongoDB" to "accepted by Pigeon".
//
// Everything durable is in MongoDB (the row, its lease, its attempt count), so a
// copy that dies loses nothing but its in-flight HTTP call, and any copy can pick
// the row up again once the lease has passed. Redis only holds the shared rate limit.
//
// Why a message can neither be lost nor sent twice:
//   * The reply endpoint returns 202 only after the row is in MongoDB. If the process
//     dies right after that, the row is still `pending` with an expired lease, and
//     the next poll of any copy sends it.
//   * Every attempt, from any copy, uses the same Idempotency-Key. If we time out,
//     crash or lose the lease while Pigeon was in fact accepting the message, the next
//     attempt gets Pigeon's original answer back and nothing is sent a second time.
//   * Writes that give up a row (retry, release) are fenced by `lease_token`, so a copy
//     that lost its lease cannot clobber the copy that now holds it. A success is
//     recorded whoever reports it, because Pigeon's answer is the same for both.

export interface OutboxOptions {
  send: SendFn;
  limiter: Limiter;
  workspaces: string[];
  leaseMs: number;
  pollMs: number;
  maxInflightPerWorkspace: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  now?: () => number; // injectable so tests can move time
  random?: () => number;
  log?: (...args: unknown[]) => void;
}

// 500 ms, 1 s, 2 s, 4 s, then 5 s for as long as it takes, +/-20 % so copies do not retry in step.
export function backoffMs(failures: number, base: number, cap: number, random: () => number = Math.random): number {
  const raw = base * 2 ** Math.max(0, failures - 1);
  return Math.min(cap, Math.round(raw * (0.8 + 0.4 * random())));
}

type Job = WithId<OutboundDoc>;

export function createOutboxWorker(o: OutboxOptions) {
  const now = o.now ?? Date.now;
  const random = o.random ?? Math.random;
  const log = o.log ?? ((...a: unknown[]) => console.error('[outbox]', ...a));
  const inflight = new Map<string, number>();
  let running = false;

  // Takes the oldest due row of one workspace. One atomic update: of several copies
  // asking at once, exactly one gets each row.
  async function claim(workspace: string): Promise<Job | null> {
    const { outbound } = await collections();
    const t = new Date(now());
    return outbound.findOneAndUpdate(
      { workspace, state: 'pending', next_attempt_at: { $lte: t }, lease_until: { $lte: t } },
      { $set: { lease_until: new Date(t.getTime() + o.leaseMs), lease_token: randomUUID() } },
      { sort: { created_at: 1 }, returnDocument: 'after' },
    );
  }

  async function release(job: Job): Promise<void> {
    const { outbound } = await collections();
    await outbound.updateOne({ _id: job._id, lease_token: job.lease_token }, { $set: { lease_until: new Date(0), lease_token: null } });
  }

  async function attempt(job: Job): Promise<void> {
    const { outbound } = await collections();
    let result: SendResult;
    try {
      result = await o.send({ workspace: job.workspace, to: job.contact, text: job.text, clientRef: job.client_ref }, idempotencyKeyFor(job.client_ref));
    } catch (err) {
      result = { kind: 'retry', reason: `send threw: ${(err as Error).message}` };
    }
    const t = now();
    const mine = { _id: job._id, state: 'pending' as const, lease_token: job.lease_token }; // still ours?

    switch (result.kind) {
      case 'accepted':
        // Deliberately not fenced on the lease: see the header comment.
        await outbound.updateOne(
          { _id: job._id, state: 'pending' },
          { $set: { state: 'accepted', accepted_at: new Date(t), lease_token: null, last_error: null, ...(result.pigeonId ? { pigeon_id: result.pigeonId } : {}) } },
        );
        return;

      case 'rate_limited': {
        // Pigeon's 429 says "stop for N seconds" and counts early requests against us. Tell
        // every copy (Redis), and do not count it as a failure of this reply.
        const waitMs = result.retryAfterMs + 250;
        await o.limiter.coolOff(job.workspace, waitMs).catch((e: Error) => log('cool-off not recorded:', e.message));
        await outbound.updateOne(mine, { $set: { next_attempt_at: new Date(t + waitMs), lease_until: new Date(0), lease_token: null, last_error: 'rate limited' } });
        return;
      }

      case 'retry': {
        const failures = job.attempts + 1;
        const wait = backoffMs(failures, o.backoffBaseMs, o.backoffCapMs, random);
        await outbound.updateOne(mine, { $set: { attempts: failures, next_attempt_at: new Date(t + wait), lease_until: new Date(0), lease_token: null, last_error: result.reason } });
        return;
      }

      case 'permanent':
        // The request itself can never succeed. Stop, and tell the agent it failed.
        await outbound.updateOne(mine, { $set: { state: 'dead', lease_token: null, last_error: result.reason } });
        await outbound.updateOne({ _id: job._id, status: { $in: ['queued', 'sent'] } }, { $set: { status: 'failed', updated_at: new Date(t) } });
        return;
    }
  }

  // One pass over the workspaces. Returns the attempts it started, so a test can await
  // them; the production loop does not (a 3 s timeout must not stall the next workspace).
  async function poll(): Promise<Promise<void>[]> {
    const started: Promise<void>[] = [];
    for (const workspace of o.workspaces) {
      try {
        while ((inflight.get(workspace) ?? 0) < o.maxInflightPerWorkspace) {
          if ((await o.limiter.peek(workspace)) > 0) break; // cooling off or out of budget: do not even claim
          const job = await claim(workspace);
          if (!job) break;
          let wait: number;
          try {
            wait = await o.limiter.take(workspace); // another copy may have spent the token since the peek
          } catch (err) {
            await release(job).catch(() => undefined);
            throw err;
          }
          if (wait > 0) {
            await release(job);
            break;
          }
          inflight.set(workspace, (inflight.get(workspace) ?? 0) + 1);
          started.push(
            attempt(job)
              .catch((err: Error) => log(`attempt for ${job.client_ref} failed to record its outcome (the lease will expire and it will be retried):`, err.message))
              .finally(() => inflight.set(workspace, (inflight.get(workspace) ?? 1) - 1)),
          );
        }
      } catch (err) {
        // MongoDB or Redis unreachable: send nothing from this workspace this tick, try again next one.
        log(`poll ${workspace}:`, (err as Error).message);
      }
    }
    return started;
  }

  async function loop(): Promise<void> {
    while (running) {
      await poll();
      await new Promise((resolve) => setTimeout(resolve, o.pollMs));
    }
  }

  return {
    poll,
    start() {
      if (running) return;
      running = true;
      void loop();
    },
    stop() {
      running = false;
    },
  };
}
