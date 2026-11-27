# Decisions

Work in progress; kept up to date as the build goes on.

## Built so far

- **Webhook** `POST /webhooks/pigeon`: raw-body HMAC check, five-minute window, the answer table
  of PIGEON.md, idempotent storage of inbound messages (unique `(workspace, message_id)`).
- **Grader endpoints** (`/__grader/*`): token guard, reset, snapshot, reply, claim.
- **Outbox** (replies to customers), described below.
- **Login** (`/auth/login`, `/auth/callback`, `/auth/logout`): OIDC authorization code + PKCE (S256). The state,
  PKCE verifier and nonce are kept in Redis under the `state` value (single use, 10 min), so any copy of the
  server can finish a login another copy started. The id_token is verified (RS256 against the IdP's `/jwks`,
  issuer, audience, nonce, expiry). Sessions are random 256-bit ids in Redis (`sb:sess:<id>`); the cookie is
  HttpOnly and SameSite=Lax.
- **API:** `GET /api/me`, `GET /api/conversations?workspace=` (newest activity first, keyset-paginated).
  401 without a session, 403 for a signed-in non-member (also for a workspace that does not exist, so existence
  is not revealed). Every workspace id from a request goes through one membership check before any query.
- **WebSocket** `GET /ws?workspace=&after=`: refused before the upgrade (401 / 403 / cross-origin 403). Events go
  through one Redis Stream per workspace; a single Lua script does `INCR` and `XADD` together, so `seq` is
  assigned and appended atomically and the stream is always in `seq` order, whichever copy publishes. Each copy
  reads the stream and fans out to its own sockets. `after=N` replays everything missed, then continues live;
  frames that arrive during the replay are held back and filtered by `seq`, so there is no gap and no repeat.
  Publishing is idempotent (a marker written by the same script), so Pigeon's retries and duplicates never
  produce a second frame, and a crash between the database write and the publish is repaired by the retry.
  `/__grader/reset` deletes the frames but keeps the `seq` counters, so `seq` never goes backwards.
- **Agent API** (session + workspace-membership checked, state-changing calls also refuse a foreign `Origin`):
  `GET /api/conversation` (messages in both directions, oldest first, with each reply's status), `POST /api/reply`
  (stored first, `202`, same `client_ref` is one reply; announces `queued` to other agents), `POST /api/claim`
  (the agent is the signed-in user, never taken from the request; `409` if held), `POST /api/conversation/status`
  (close / reopen). They call the same functions as the `/__grader/*` endpoints.
- **Web app** (React, `scaffold/web`): sign in through the IdP, workspace picker for users in several, inbox list
  (newest activity first), conversation view, reply with live status (queued / sent / delivered / failed), claim,
  close / reopen, live updates over `/ws`. After a dropped connection it reconnects with `after=<last seq>`.
  Kept deliberately small: one file of components, no router, no state library.
- **Not built:** pagination in the web app (it loads the newest 100 conversations and 200 messages), unread
  markers, typing indicators, a way to release a claim, per-role permissions (admins and agents can do the same
  things; roles are only displayed).

## What was run

- **`npm run check:full` on the final code** (with the agent API and web app added): **75 of 75**: level 1 24/24,
  level 2 14/14, level 3 22/22 (two copies), level 5 15/15. `CHECK_REPORT.json` is that report. The same score was
  reached earlier on a fresh clone of commit `4a1bef5`, before the agent API and web app existed.
  Level 4 (10 points, the written rules) cannot be run locally and is not in that number.
- Server tests (`npm --prefix scaffold/server test`): 44 passing, about 50 s. Server and web both typecheck, and the
  web app builds (`npm --prefix scaffold/web run build`).
- **Honest history:** commit `4a1bef5` was pushed before it had been run (level 5 was written, typechecked, and
  shelved when time ran short). Running it afterwards on a fresh clone found one bug, in a test, not in the
  server: `bus.test.ts` left a MongoDB connection open, so `npm test` never finished. Fixed in the next commit.

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

- **The web app has no automated tests.** I clicked through it once in a real browser (sign in as Ben, the inbox
  filled live with only `ws_acme` contacts, claimed a conversation, sent a reply and watched it become `delivered`),
  but that is a manual smoke test, not a regression test. It was not tried on a phone-sized screen, with two
  browsers at once, or across a dropped connection.
- **Roles are not enforced beyond membership:** `admin` and `agent` can do the same things.
- **Redis restart loses the event `seq` counters and frames** (the counters live in Redis, not MongoDB). `seq` would
  then restart from 1, and a browser reconnecting with `after=<old seq>` would silently miss events until it
  caught up. Not handled. Only the frames of the last 50 000 events per workspace are kept for replay.
- **A claim is announced at most once:** if Redis is down at that moment the claim stands (it is in MongoDB) but
  no `conversation.assigned` frame is sent. Inbound messages and statuses do not have this gap.
- **Sessions are 8 h at most and there is no refresh;** logout only deletes the Redis key.
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
