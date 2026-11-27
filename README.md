# Switchboard

A shared team inbox (see `BRIEF.md`). Work in progress; `DECISIONS.md` says what is built, cut and known wrong.

## Why `docker-compose.dev.yml` exists

The check harness needs Linux (`sh`, killing a whole process group), and this was built on Windows.
`docker-compose.dev.yml` runs a Node 22 container with the repo mounted and puts MongoDB, Redis, Pigeon and
the IdP in its network, so every default `localhost` URL works unchanged. It is development tooling only; grading uses `docker-compose.yml`.

```
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml exec dev sh     # then: npm run scaffold:install && npm run check
```

`scripts/dev/` holds two throwaway probes used while measuring webhook latency. Set `SB_TIMING=1` to make the server print per-stage timings.
