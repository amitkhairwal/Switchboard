# Decisions

Work in progress; kept up to date as the build goes on.

## Cut on purpose

- **Encrypted private notes (and `PROTOCOL.md`): cut.** A half-finished end-to-end
  scheme is worse than none: it would look like a guarantee the server does not
  actually give. Agents therefore have no private notes in this version.
- **Search (Elasticsearch) and billing (Paybox): cut.** Not started.

## Assumptions where the brief is silent

- **Workspaces are fixed:** `ws_acme` and `ws_globex` (`config.workspaces`), the two
  that have a Pigeon key. An event for any other workspace is acknowledged and ignored.
- **A known event type with missing fields is a `400`.** PIGEON.md only says
  "a body you cannot parse" is `400`; I read "cannot make sense of" the same way for
  `message.inbound` with no `message_id`/`from`/valid `occurred_at`. Unknown types,
  unknown workspaces and statuses for messages we never sent are `2xx` and ignored.
- **Signature window:** `|now - t| <= 300 s` is genuine (future timestamps within the
  same window too). The MAC is checked before the timestamp, so a forger learns nothing
  from the difference between "bad" and "stale"; both are `401`.
- **A storage failure on the webhook is a `503`,** on purpose: we did not store the
  event, so Pigeon must retry it. Bad input never produces a `5xx`.
- **Order of a conversation** is `occurred_at` then `message_id` (Pigeon's own truth
  order), never arrival order.
- **Message status only moves forward:** `queued < sent < delivered = failed`. A
  late `sent` cannot undo `delivered`.
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

## What I know is still wrong / not done yet

- Step 1 only: webhooks, claim, reply *enqueue*, snapshot. Replies are stored as
  `queued` but nothing sends them yet (outbox worker, rate limit, outage handling
  come next), so the three send checks in level 1 fail for now.
- Login, `/api/*`, WebSocket and the React app are not built yet.
