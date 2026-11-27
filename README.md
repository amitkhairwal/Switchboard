# Switchboard

A shared team inbox (see `BRIEF.md`). **Unfinished:** the inbound/outbound message pipeline is built and checked;
the web app is not (login, `/api/*` and the WebSocket are, and pass the check). `DECISIONS.md` has the full list of what is built, cut and known weak.

## Run it from a clean clone

Needs Node 22, Docker, and the ports 4000, 4010, 4020, 27017, 6379 free.

```
npm run up                  # MongoDB, Redis, Pigeon (messaging), the mock IdP, in Docker
npm run doctor              # confirms every service answers
npm run scaffold:install    # installs the server (and the empty web shell)
npm run scaffold:server     # the server on http://localhost:4000   (npm run start:server for a plain run)
npm run check               # level 1 of the check; stop the server above first, it starts its own
npm run check:full          # levels 1, 2, 3 and 5 (about 4 minutes)
```

Configuration is read from the environment (see `.env.example`; the defaults match the Docker services, so no `.env` is needed).
`switchboard.json` holds the install and start commands the check uses. Server tests: `npm --prefix scaffold/server test`
(they use their own MongoDB databases and need the services above running).

## Why `docker-compose.dev.yml` exists

The check harness needs Linux (`sh`, killing a whole process group), and this was built on Windows.
`docker-compose.dev.yml` runs a Node 22 container with the repo mounted and puts MongoDB, Redis, Pigeon and
the IdP in its network, so every default `localhost` URL works unchanged. It is development tooling only; grading uses `docker-compose.yml`.

```
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml exec dev sh     # then: npm run scaffold:install && npm run check
```

`scripts/dev/` holds two throwaway probes used while measuring webhook latency. Set `SB_TIMING=1` to make the server print per-stage timings.
