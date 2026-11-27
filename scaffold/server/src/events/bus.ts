import { Redis } from 'ioredis';
import { config } from '../config.js';
import { getRedis } from '../redis.js';

// The real-time event bus: one Redis Stream per workspace, shared by every copy.
//
//   sb:seq:<ws>   counter. The `seq` in every frame. Survives /__grader/reset so it only goes up.
//   sb:ev:<ws>    the stream. Entry id is "<seq>-0", so stream order IS seq order.
//   sb:pub:<key>  one-shot markers that make publishing idempotent (see publish).
//
// publish() is ONE Lua script: INCR and XADD run atomically, so two copies can never
// interleave "take seq 6, take seq 5, append 5, append 6". The stream is therefore always
// in increasing seq order, and every reader (live fan-out and replay) sees that order.

export type Frame = { seq: number; type: string; [field: string]: unknown };

const PUBLISH = `
if KEYS[3] ~= '' then
  if not redis.call('SET', KEYS[3], '1', 'NX', 'EX', ARGV[3]) then return 0 end
end
local seq = redis.call('INCR', KEYS[1])
redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[2], seq .. '-0', 'p', ARGV[1])
return seq
`;

const seqKey = (ws: string) => `sb:seq:${ws}`;
const streamKey = (ws: string) => `sb:ev:${ws}`;
const MAX_STREAM_LENGTH = 50_000; // about as far back as a reconnecting browser can replay
const DEDUPE_TTL_SECONDS = 24 * 3600;

// Publishes one event to a workspace and returns its seq (0 = it was a duplicate, nothing published).
// `dedupeKey` makes the call idempotent: the marker and the frame are written by the same script, so
// a crash before it leaves no marker (the retry publishes) and a crash after it leaves both (the retry
// does nothing). That is what lets the webhook publish on every retry without ever doubling a frame.
export async function publish(workspace: string, payload: { type: string; [field: string]: unknown }, dedupeKey: string | null = null): Promise<number> {
  const seq = await getRedis().eval(
    PUBLISH,
    3,
    seqKey(workspace),
    streamKey(workspace),
    dedupeKey ? `sb:pub:${workspace}:${dedupeKey}` : '',
    JSON.stringify(payload),
    String(MAX_STREAM_LENGTH),
    String(DEDUPE_TTL_SECONDS),
  );
  return Number(seq);
}

type Entry = [id: string, fields: string[]];
const toFrame = ([id, fields]: Entry): Frame => ({ ...(JSON.parse(fields[1]) as { type: string }), seq: Number(id.split('-')[0]) });

export async function currentSeq(workspace: string): Promise<number> {
  return Number((await getRedis().get(seqKey(workspace))) ?? 0);
}

// Frames with seq > after, oldest first, in chunks so a long absence does not load everything at once.
export async function readSince(workspace: string, after: number, onChunk: (frames: Frame[]) => void | Promise<void>): Promise<void> {
  let from = `${after + 1}-0`;
  for (;;) {
    const entries = (await getRedis().xrange(streamKey(workspace), from, '+', 'COUNT', 500)) as Entry[];
    if (entries.length === 0) return;
    await onChunk(entries.map(toFrame));
    if (entries.length < 500) return;
    from = `${Number(entries[entries.length - 1][0].split('-')[0]) + 1}-0`;
  }
}

// ---- live fan-out: one reader per workspace per copy ---------------------------------------
type Listener = (frame: Frame) => void;
const listeners = new Map<string, Set<Listener>>();

export function subscribe(workspace: string, listener: Listener): () => void {
  let set = listeners.get(workspace);
  if (!set) listeners.set(workspace, (set = new Set()));
  set.add(listener);
  return () => void set.delete(listener);
}

const readers = new Map<string, { stop: () => void }>();

// Starts (once) a blocking reader for each workspace. Every copy runs its own, so a browser
// connected to this copy receives what any other copy published.
export function startEventReaders(workspaces: string[], log: (...a: unknown[]) => void = console.error): void {
  for (const workspace of workspaces) {
    if (readers.has(workspace)) continue;
    let running = true;
    // Blocking commands hold their connection, so each reader has its own.
    const conn = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    conn.on('error', () => undefined); // reconnects by itself; the loop below logs the failures
    readers.set(workspace, { stop: () => ((running = false), conn.disconnect()) });
    void (async () => {
      let lastId = '0-0';
      try {
        const newest = (await getRedis().xrevrange(streamKey(workspace), '+', '-', 'COUNT', 1)) as Entry[];
        if (newest.length) lastId = newest[0][0];
      } catch (err) {
        log('event reader could not find the stream end:', (err as Error).message);
      }
      while (running) {
        try {
          const res = (await conn.xread('COUNT', 100, 'BLOCK', 5000, 'STREAMS', streamKey(workspace), lastId)) as [string, Entry[]][] | null;
          if (!res) continue;
          for (const entry of res[0][1]) {
            lastId = entry[0];
            const frame = toFrame(entry);
            for (const listener of listeners.get(workspace) ?? []) {
              try {
                listener(frame);
              } catch (err) {
                log('event listener failed:', (err as Error).message);
              }
            }
          }
        } catch (err) {
          if (running) log(`event reader ${workspace}:`, (err as Error).message);
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    })();
  }
}

export function stopEventReaders(): void {
  for (const r of readers.values()) r.stop();
  readers.clear();
}
