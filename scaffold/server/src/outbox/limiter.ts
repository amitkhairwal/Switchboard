import type { Redis } from 'ioredis';

// Per-workspace send budget shared by every copy of the server, kept in Redis.
//
//   sb:rl:<ws>    token bucket (hash: tokens, ts)
//   sb:cool:<ws>  exists while Pigeon told us to wait (Retry-After); its TTL is the wait
//
// One Lua script does the whole step, so two copies can never both spend the
// last token. It reads the time from Redis (TIME), not from the callers, so the
// copies cannot disagree about it.
//
// Both calls return the milliseconds to wait before trying again; 0 means "go".
//   peek  looks without spending.
//   take  spends one token when there is one.
// If Redis is unreachable these throw and the worker sends NOTHING: failing
// open would mean ignoring Pigeon's rate limit exactly when we cannot see it.

const SCRIPT = `
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local cool = redis.call('PTTL', KEYS[2])
if cool > 0 then return cool end
local cap = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1])
local ts = tonumber(b[2])
if tokens == nil or ts == nil then tokens = cap; ts = nowMs end
tokens = math.min(cap, tokens + math.max(0, nowMs - ts) / 1000 * rate)
local wait = 0
if tokens < 1 then
  wait = math.ceil((1 - tokens) / rate * 1000)
elseif ARGV[3] == '1' then
  tokens = tokens - 1
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(nowMs))
redis.call('PEXPIRE', KEYS[1], 60000)
return wait
`;

export interface Limiter {
  peek(workspace: string): Promise<number>;
  take(workspace: string): Promise<number>;
  // Pigeon answered 429: nobody may send for this workspace for `ms`.
  coolOff(workspace: string, ms: number): Promise<void>;
}

export function createLimiter(redis: Redis, opts: { capacity: number; refillPerSec: number }): Limiter {
  const keys = (ws: string) => [`sb:rl:${ws}`, `sb:cool:${ws}`];
  const run = async (ws: string, consume: '0' | '1') =>
    Number(await redis.eval(SCRIPT, 2, ...keys(ws), String(opts.capacity), String(opts.refillPerSec), consume));
  return {
    peek: (ws) => run(ws, '0'),
    take: (ws) => run(ws, '1'),
    async coolOff(ws, ms) {
      // Keep the longest wait if two copies get a 429 at once.
      const key = keys(ws)[1];
      const current = await redis.pttl(key);
      if (current < ms) await redis.set(key, '1', 'PX', Math.max(1, Math.ceil(ms)));
    },
  };
}
