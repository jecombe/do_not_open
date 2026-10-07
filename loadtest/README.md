# Load test

k6 against the API as production runs it: N replicas (`ROLE=api`) behind Caddy, which spreads
players with `lb_policy client_ip_hash`, on a Postgres index seeded with a collection a few weeks
into its sale. CI runs it on every pull request into `main` that touches the backend (the ones into `dev` skip it)
(`.github/workflows/loadtest.yml`), with 1 then 3 replicas, and by hand (Actions, "Load test",
Run workflow) with other replica counts, players or durations.

```
k6 ──X-Forwarded-For: one address per visit──> Caddy :8080 ──client_ip_hash──> api ×N ──> Postgres (seeded)
```

| File | What |
| --- | --- |
| `api.js` | Players reading the game: landing, boxes one by one, duels, an account, the rankings |
| `ratelimit.js` | One address hammering the API: exactly its allowance a minute across every replica, then 429 |
| `lib.js` | The seeded world (box ids, player addresses) and the summary files |
| `stack/` | The throwaway stack: Postgres, the API image scaled to N, Caddy with the production `reverse_proxy` block |
| `../apps/api/scripts/seedLoad.ts` | The seed: synthetic events through the real migrations, `SyncChain` and projector |

## The seed

`pnpm --filter @dno/api seed:load` with `DATABASE_URL` set writes, by default, 4,000 boxes
minted in batches of 1 to 10 by 600 players, about 30% of them opened (some proved alive first,
some weighed), 8% paired, 400 duels in every state (on the shelf, under way, resolved, cancelled,
voided), the pantry's bags and meals, proofs still pending or refused, and 150 rats: about 16,000
events in 5 seconds. It is deterministic and refuses a database that already holds events.
`SEED_BOXES`, `SEED_PLAYERS`, `SEED_OPENED_SHARE`, `SEED_DUELS`, `SEED_RATS` and `SEED_PRNG`
change it; tell k6 with `-e BOXES= -e PLAYERS= -e DUELS=` if you do. Players are
`0x00000000000000000000000000000000d0000000` + their index.

## What is loaded

Only public reads, in about the proportions the app asks for them: `/health`, `/v1/stats`,
`/v1/collection`, `/v1/boxes?from&to`, `/v1/boxes/:id` and its activity and pantry,
`/metadata/:id`, `/v1/duels/shelf`, `/v1/duels/:id`, `/v1/duels?tokens` and `?account`,
`/v1/leaderboard` and `/duels`, `/v1/accounts/:address` and its requests, `/v1/activity`,
`/v1/economy`. Nothing that costs money or reaches a third party: no relayer, chat, studio, X,
Discord or sign-in.

Each visit comes from an address of its own in `100.64.0.0/10`, sent as `X-Forwarded-For`: Caddy
trusts it from the Docker gateway (`trusted_proxies static private_ranges` in the test stack
only) and hashes it to a replica, the API counts its rate limit on it. A visit is a handful of
requests a second apart (`THINK`), so no player reaches the 300 a minute.

## Thresholds

| Tag | Routes | Threshold | Fails the run |
| --- | --- | --- | --- |
| `kind:index` | everything Postgres answers | p95 < 300 ms, p99 < 800 ms, errors < 1% | yes |
| `kind:chain` | `/v1/collection`, `/v1/economy`, `/v1/boxes/:id/pantry` | none: p95 reported | no |
| `checks` | every answer is a 200 | > 99% | yes |

The chain reads are cached in each replica (constants once, the economy 30 s, claims 30 s and
batched) but a cold cache reads a free Sepolia RPC, whose speed is not ours to test.

`ratelimit.js` waits for a fresh rate-limit window, then sends the allowance plus 50 requests from
one address. It passes only if exactly the allowance is served: spread over three replicas
without the hash, the same address would get up to three allowances (tried with two replicas and
`round_robin`: the check fails).

## Running it

On a machine with Docker, from the repository root:

```bash
docker build -f apps/api/Dockerfile -t dno-api:loadtest .
docker compose -f loadtest/stack/docker-compose.yml up -d --wait postgres
DATABASE_URL=postgres://dno:dno@localhost:5433/dno pnpm --filter @dno/api seed:load
docker compose -f loadtest/stack/docker-compose.yml up -d --wait --scale api=3 api caddy
k6 run -e VUS=100 -e DURATION=90s -e LABEL=replicas-3 loadtest/api.js
k6 run loadtest/ratelimit.js
docker compose -f loadtest/stack/docker-compose.yml down -v
```

Without Docker, against an API started by hand (`ROLE=api`, `DATABASE_URL`, `TRUST_PROXY=true`,
`SESSION_SECRET` of 32 characters or more): `k6 run -e BASE_URL=http://localhost:8080 loadtest/api.js`.

| k6 `-e` | Default | |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:8080` | the proxy, or one API |
| `VUS` | 50 (CI: 100) | players at once, reached in a 30 s ramp |
| `DURATION` | `2m` (CI: `90s`) | the plateau |
| `THINK` | 1 | seconds between screens; 0 for a stress test |
| `LABEL`, `SUMMARY_DIR` | `run`, none | what the summary files are called and where they go; without `SUMMARY_DIR` the table is only printed |

`PG_PORT` (5433), `LB_PORT` (8080), `API_IMAGE` (`dno-api:loadtest`) and `RATE_LIMIT_PER_MINUTE`
(300) change the stack.

## Reading the results

Each run writes `<label>.md` (also printed), `<label>.json` (requests, req/s, p95 and p99 of
the index reads, p95 of the chain reads, error rate, failed thresholds) and `<label>.k6.json`
(k6's whole summary, checks by route included). CI puts a table comparing the replica counts
and the rate-limit result in the job's summary, and every file in the `loadtest-results`
artifact.

The runner is one shared machine: k6, Postgres and every replica share its cores. Compare the
rows with each other (does throughput hold or grow with replicas, does p95 stay down), not with
production. A failed `checks` threshold names its route in `<label>.k6.json` (`root_group`, then
the visit's group).
