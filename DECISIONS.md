# Decisions

Work in progress; kept up to date as the build goes on.

## Built so far

- **Webhook** `POST /webhooks/pigeon`: raw-body HMAC check, five-minute window, the answer table
  of PIGEON.md, idempotent storage of inbound messages (unique `(workspace, message_id)`).
- **Grader endpoints** (`/__grader/*`): token guard, reset, snapshot, reply, claim.
- **Outbox** (replies to customers), described below.
- **Not built:** login (OIDC), `/api/*`, the WebSocket and the React app. Level 5 of the check
  (15 points) therefore scores 0, and nobody can use this as an inbox yet: there is no way to sign in,
  list conversations, read messages, claim or reply except through the `/__grader/*` endpoints.
  I started level 5 (OIDC login with state and PKCE in Redis, sessions in Redis, `/api/me`,
  `/api/conversations`, `/ws` with an event stream and `after=` replay), but it was never run, so it is
  **not in this repository**: I would not ship code I had not run, and it changes the webhook path that
  the passing checks rely on.

## What was run

- **`CHECK_REPORT.json` is from `npm run check` only** (level 1, profile "quick"): 24 of 24. The full check
  (`npm run check:full`, levels 1, 2, 3 and 5) was **not** run for this final commit, for lack of time.
- Before that, `check:full` was run once on an earlier commit (`3f372f6`, the same server code apart from
  documentation): level 1 24/24, level 2 14/14, level 3 22/22 (two copies), level 5 0/15 (not built); 60 of 75.
  That report was overwritten by this one, but the numbers are in the git history of `CHECK_REPORT.json`.
- Server tests (`npm --prefix scaffold/server test`): 29 passing at the last run.

## Cut on purpose

- **Encrypted private notes (and `PROTOCOL.md`): cut.** A half-finished end-to-end
  scheme is worse than none: it would look like a guarantee the server does not
  actually give. Agents therefore have no private notes in this version.
- **Search (Elasticsearch) and billing (Paybox): cut.** Not started.

## The outbox (how a reply gets to the customer)

A reply is written to MongoDB first (`outbound`, unique on `(workspace, client_ref)`), and only then
does the endpoint answer `202`. A worker in every copy of the server sends it afterwards.

- **Idempotency-Key = `sb-<client_ref>`.** It depends on the reply only, never on the attempt, the
  copy or the time, so every retry (after a timeout, a crash, or by another copy) carries the same
  key and Pigeon returns its original answer instead of sending again.
- **Attempt timeout: 3 s.** Pigeon's slow path answers after 12 s, so on those we always time out,
  retry with the same key, and get an instant replay.
- **Lease: 10 s.** A worker claims a row with one atomic `findOneAndUpdate` (state `pending`, due,
  lease expired) and holds it for 10 s: longer than one attempt, shorter than the 60 s a dead copy
  has to be covered in. Cost: after a `kill -9`, an in-flight row waits up to 10 s. Any copy takes a
  row whose lease has expired. Writes that give a row up (retry, release) are fenced by a per-claim
  `lease_token`, so a copy that lost its lease cannot overwrite the copy that now holds it. A success is
  recorded by whoever reports it, since Pigeon gives both the same answer.
- **Backoff:** 0.5 s, 1 s, 2 s, 4 s, then 5 s, +/-20 % jitter, capped. During the 8 s provider outage
  the check saw about 25 requests (the penalty starts at 48).
- **Rate limit:** a token bucket per workspace in Redis (7 tokens, refill 3.5/s: just under Pigeon's
  8 and 4/s), one Lua script so two copies cannot both take the last token. A `429` sets a shared
  cool-off key for the `Retry-After` plus 250 ms. The worker peeks before it claims and takes the token
  after claiming, so a token is never wasted on a row another copy won.
- **Status webhooks** update the row by `client_ref` and only move forward
  (`queued < sent < delivered = failed`). Any status also marks the row accepted, because it can arrive
  before the slow HTTP response, and the worker must then stop retrying.
- **Permanent failure:** Pigeon `400` marks the reply `dead` and `failed`. A `401` keeps retrying at the
  5 s cap in case somebody fixes the key.

## Assumptions where the brief is silent

- **Workspaces are fixed:** `ws_acme` and `ws_globex` (`config.workspaces`), the two
  that have a Pigeon key. An event for any other workspace is acknowledged and ignored.
- **A known event type with missing fields is a `400`.** PIGEON.md only says
  "a body you cannot parse" is `400`; I read "cannot make sense of" the same way for
  `message.inbound` with no `message_id`/`from`/valid `occurred_at`. Unknown types,
  unknown workspaces and statuses for messages we never sent are `2xx` and ignored.
  This is a judgement call on a case the documents do not spell out.
- **Signature window:** `|now - t| <= 300 s` is genuine (future timestamps within the
  same window too). The MAC is checked before the timestamp, so a forger learns nothing
  from the difference between "bad" and "stale"; both are `401`.
- **A storage failure on the webhook is a `503`,** on purpose: we did not store the
  event, so Pigeon must retry it. Bad input never produces a `5xx`.
- **Order of a conversation** is `occurred_at` then `message_id` (Pigeon's own truth
  order), never arrival order.
- **Claim lives in MongoDB, not Redis:** one conditional update on the conversation
  document (`assignee` is null or me). It is the same durable record the snapshot and
  API read, so it survives a Redis restart and needs no second system to agree with.
- **`/__grader/reset` keeps collections and indexes** (it only deletes documents) and
  keeps login sessions in Redis.

## Development environment

The check needs Linux (`sh`, process-group kill). On this Windows machine everything,
including the check, runs in a Linux Node 22 container: see `docker-compose.dev.yml`.
Mongo, Redis, Pigeon and the IdP share the dev container's network, so every
default `localhost` URL is unchanged.

## What I know is still wrong

- **Level 5 and the product around it are missing:** no login, no `/api/*`, no WebSocket, no UI.
  A reviewer cannot use this as an inbox yet. Also not built: close/reopen, the inbox list and
  message-reading endpoints for agents, tests of the web side (there is none).
- **Clocks:** leases are compared with each server's own clock. Fine on one machine; across machines,
  clock skew would let a lease look expired early or late.
- **Redis down:** the worker sends nothing (it cannot see the rate limit, and sending blind would break
  Pigeon's limit). Replies stay safe in MongoDB and go out when Redis is back. Rate-limit and cool-off
  state is lost on a Redis restart (the bucket starts full), at worst costing one `429` and a fresh
  cool-off. Sessions would be lost too.
- **After a `kill -9`** a row that was mid-send waits up to the 10 s lease before another try.
- **Untested, or only tested in one shape:**
  - Level 4 (the private rules) cannot be run. I wrote tests for ten cases I read out of PIGEON.md and the
    brief; the real ones may include cases the documents do not spell out.
  - Only two copies of the server were ever run together; the grading check uses three.
  - Redis going down or restarting mid-run, and MongoDB going down, were reasoned about, not tested.
  - The permanent-failure path (Pigeon `400`) and the `401` retry are covered by one unit test each, never
    against a real misbehaving Pigeon.
  - Nothing was tested on a real clock skew, a large backlog (hundreds of queued replies), or a long run.
  - The 400-versus-2xx choice for a known event type with missing fields (above) is a guess.
- **One slow-start observation:** in one early run `ack_speed` failed (p95 4.7 s) and passed on every
  run since; I could not reproduce it in two attempts and did not find the cause. Stage timing code
  stays in behind `SB_TIMING=1`.
