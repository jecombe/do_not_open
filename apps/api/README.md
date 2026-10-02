# @dno/api

The backend of DO NOT OPEN: an indexer that follows the protocol on-chain into Postgres, and
the HTTP API the app reads instead of a public RPC. Only public facts go in. Who holds which
box is encrypted on-chain, and the backend never learns it.

```mermaid
flowchart LR
  rpc["Free RPCs<br/>publicnode, tenderly,<br/>thirdweb, 1rpc"] -- "1 getLogs per range<br/>1 multicall per batch" --> idx["Indexer<br/>SyncChain"]
  idx -- "events + read models,<br/>one transaction per batch" --> pg[(Postgres)]
  pg --> api["HTTP API<br/>Fastify"]
  api -- "cached JSON" --> web["apps/web<br/>(Vercel)"]
  web -. "behind or down:<br/>falls back on the RPC" .-> rpc
```

## Layout (clean architecture)

| Layer | Folder | Knows about |
| --- | --- | --- |
| Domain | `src/domain` | Boxes, duels, requests, users, protocol events. Pure functions, no I/O. |
| Application | `src/application` | Use cases (`SyncChain`, `Queries`, `SignIn`, `Metadata`), the projector, and the **ports** they need (`ChainSource`, `ChainState`, `Store`). |
| Infrastructure | `src/infrastructure` | Ethers + the RPC pool, Postgres, the in-memory store, Fastify, HMAC sessions. |
| Composition | `src/main.ts` | The only file that picks concrete classes. |

Dependencies point inwards only: the domain imports nothing, the application imports the
domain and its own ports.

## Staying under the free RPCs' limits

- **The backend is the only reader.** The app reads the API; a thousand visitors cost the RPC
  what one indexer costs: about three requests per new block.
- **One `eth_getLogs` per range** for all three contracts at once, filtered on the event topics
  that matter (decryption proofs, which are large, are left out).
- **One Multicall3 call per batch** for what logs do not say (challenger of a duel, other box of
  a request, contents of an opened box, tolerance of a weighed cat). Block timestamps come in
  one JSON-RPC batch.
- **A pool of endpoints** (`RpcPool`): a token bucket per endpoint (`RPC_RPS`); a 429 or an
  outage benches the endpoint, honouring `Retry-After` and growing on repeat; the fastest
  endpoint with a token to spend is picked first.
- **Each endpoint's log range is learned** from its own refusals ("limited to 50 blocks",
  "more than 10000 results"...) and kept.
- **Contract state no event carries** (economy, next claim time) is cached and batched:
  fifty boxes asking for their claim time within 20 ms cost one multicall.
- **Every endpoint proves it has the block** before its logs are believed, so a lagging free
  node cannot make an event disappear.
- **Nudges, not polling faster:** after a transaction, the app calls `POST /v1/sync/nudge`; the
  indexer looks sooner, never more than once every 3 s.

## Correctness and reconciliation

The `events` table is the source of truth. Each event is stored with its block hash and with
what the contract's views added to it when indexed (its *enrichment*: a duel's challenger, an
opening's contents...). Every other table is a fold of it, and `replayAll` can rebuild them
all from it, in chain order, without a single RPC call.

Four layers keep it complete and right:

1. **Each pass is atomic.** A batch, its projections and the new cursor are one transaction:
   a crash or an RPC error leaves the index as it was, and the pass runs again.
2. **No blind trust in an endpoint.** Before its `eth_getLogs` for `from..to` is believed, the
   endpoint must return the header of block `to`. A lagging node answers "no logs" for blocks it
   has not seen, without an error; this catches it and another endpoint answers. Logs outside
   the range, or from another fork than that header, are refused too. Indexing stays
   `CONFIRMATIONS` blocks behind the head and re-reads the last `RESCAN_BLOCKS` each pass.
3. **Finality sweep** (every `SWEEP_EVERY_MS`, 5 min). Once blocks are finalized, they are read
   again, from other endpoints than those that served them the first time (`indexed_ranges`
   records who did). An event the first read missed is added; one recorded from a block a
   reorg dropped is removed. If anything changed, the read models are replayed.
4. **Reconciliation** (every `RECONCILE_EVERY_MS`, 10 min). The contract's views, read as of
   the last indexed block, are compared with the index: counters (tokens, duels, requests,
   milestones), every open duel, every pending request, and `RECONCILE_BOXES` boxes in turn
   (status, alive check, partner, wins, public traits). For what differs, that entity's events
   are fetched from the deployment on, by indexed topic, added if missing, and the read models
   replayed. What still differs is logged as an error.

Both show their last result in `GET /health` (`indexer.tasks`). Their cost is a few RPC
requests an hour. Read models only move forward, so a late or replayed event does no harm
in between. A duel can go back on the shelf (pending, then open again), so its events are
ordered by block and log index, not by status; nothing moves it out of resolved, cancelled
or void.

Every answer of the API carries `block`, the last block indexed. The app trusts it only when
it covers the account's own last transaction, and reads the chain otherwise.

## API

Every `GET` returns `{ "block": <last indexed block>, "data": ... }`.

| Route | What |
| --- | --- |
| `GET /health` | Indexer status, lag, RPC endpoints and their learned ranges |
| `GET /v1/collection` | Fees, supply, token count, sale milestones |
| `GET /v1/boxes?from=&to=` | Status and partner of up to 1,000 boxes |
| `GET /v1/boxes/:id` | Everything public about a box |
| `GET /v1/boxes/:id/pantry` | Welcome bag, next claim, weigh-in |
| `GET /v1/boxes/:id/activity` | The box's events, newest first (`before`, `limit`) |
| `GET /v1/pairs/:a/:b` | The duels the two boxes can settle (`duels`, a list: both can be up at once) and the entanglement proposal between them |
| `GET /v1/duels/shelf` | The duel shelf: every box up for a duel that can still be taken up, newest first |
| `GET /v1/duels?account=&tokens=&open=` | Duels an account posted or took up, or about these boxes. `open` keeps posted, open and pending ones. The token list is not stored or cached. |
| `GET /v1/duels/:id` | One duel |
| `GET /v1/leaderboard` | Opened cats and their openers |
| `GET /v1/accounts/:address` | Profile: user, duels, pending requests, opened cats, activity |
| `GET /v1/accounts/:address/requests` | Pending openings, alive checks, entanglements |
| `GET /v1/accounts/:address/transfers?after=` | Transfer receipts naming the account, for it to decrypt |
| `GET /v1/economy` | Croquette economy and its Uniswap V3 market: `croqReserve` / `quoteReserve` (the active range's virtual reserves, whose ratio is the price), `croqHeld` / `quoteHeld` (what the pool holds), `range` (USDC units per 1,000 CROQ where the locked position starts and stops selling) |
| `GET /v1/activity` | Everything, newest first (`before`, `limit`, `account`) |
| `GET /v1/stats` | Users, registered, minted, opened, duels |
| `POST /v1/auth/nonce` · `POST /v1/auth/verify` · `GET /v1/me` | Sign-in with a wallet signature (no gas), then a bearer session |
| `POST /v1/sync/nudge` | Asks the indexer to look now |
| `GET /metadata/:id` · `/metadata/:id/image.svg` | ERC-721 metadata, live. Point the contract's base URI at `https://<api>/metadata/`. |
| `POST /relayer/v2/{input-proof,user-decrypt,public-decrypt}` · `GET /relayer/v2/:op/:jobId` · `GET /relayer/v2/keyurl` | The relayer proxy (below): the Relayer SDK's `relayerUrl` is `https://<api>/relayer/v2` |
| `GET /v1/relayer/allowance/:address` | Free decryptions left today, credits left, when the free ones come back |

A duel carries `reserved`, `openUntil` (null until the holding is proven) and `tokenB`, null
while a duel open to any box waits for a taker.

Users are recorded from their first public act on-chain (mint, shake, opening, duel...) and
when they sign in.

Migration 3 (`src/infrastructure/db/migrations.ts`) is for the duel-shelf contract: it
empties the index (sign-ins are kept) and the indexer rebuilds it from the new deployment
block. Point the API at the new addresses before it runs.

Migration 5 is for the redeploy of 2026-10-02 (`DoNotOpen` `0x5eBa…2C6F`, block 11830294,
and the Uniswap V3 economy): it empties the index the same way, keeping sign-ins and the
relayer proxy's counts. The indexer starts at `indexFrom`, the earliest block of the
protocol's live contracts: the decryption credits (block 11829380) were not redeployed, so
purchases made before the new collection still count.

Migration 6 adds the public decryption cache (`public_decryptions`, `public_decrypt_uses`):
like the relayer meter, not a read model, and kept by a replay.

## Relayer proxy

On mainnet Zama bills the collection for every value its relayer decrypts and every encrypted
input it verifies (litepaper: $0.001 to $0.10 a decryption, $0.005 to $0.50 an input,
depending on the plan), and its hosted relayer needs an API key that must not reach a
browser. With `VITE_RELAYER_PROXY=true` the app sends every encryption and decryption here
instead; `RelayerGate` (`src/application/relayerGate.ts`) decides, `HttpRelayerUpstream`
adds `RELAYER_API_KEY` and forwards.

| Request | Let through when | Counted |
| --- | --- | --- |
| user decryption | every contract named is the protocol's (collection, its cUSDC, Pantry, cCROQ), and the EIP-712 permit was signed by the `userAddress` it is for | one unit per value: the day's free units first (`RELAYER_FREE_PER_DAY`, 25, or `RELAYER_NEWCOMER_PER_DAY`, 16, for a wallet the index has never seen act on-chain or be sent a box; reset at midnight UTC), then the wallet's credits. Given back when Zama refuses |
| public decryption | every handle was made public by the collection, the Pantry or cCROQ: the index follows Zama's ACL (`AllowedForDecryption` with one of them as caller), and the last `RELAYER_RECENT_BLOCKS` are read directly for what it has not caught up with | free: it settles something already on-chain. Sent to Zama once per exact request (handles in order + extra data, `public_decryptions`): asking the same again replays the same job, answered from the cache once done, so a loop over an old duel costs nothing. Reordering or recombining handles makes a new request, so a handle may only be named in `RELAYER_PUBLIC_PER_HANDLE` (4) requests sent to Zama (`public_decrypt_uses`), past which it is refused (`bad-request`). A job Zama fails or loses, or still running after 5 minutes, is sent again |
| encrypted input | for one of the protocol's contracts, on this chain, sent with `Authorization: Bearer <base64url of the JSON permit>`: the user-decryption permit of the `userAddress` the input is for (else `bad-permit`), so nobody spends another wallet's units | `RELAYER_INPUT_UNITS` (5) units, the same way: Zama charges an input five times a decryption. Given back when Zama refuses |

Polling a queued job is passed through and not counted. A refusal answers in the relayer's
own error shape (`400`, label `request_error`, message `dno:<code>: ...`), so the SDK reports
it; the adapter turns `dno:no-credits` into a `no-credits` error, and checks the allowance
before a shake, a mint or a meal so no gas is spent on a result it could not read.
`GET /v1/relayer/allowance/:address` answers `freePerDay` (that wallet's: player or
newcomer), `freeLeft`, `credits`, `resetsAt` and `inputUnits`.

Credits are bought on-chain from `DecryptionCredits`, in plain USDC (a short balance
reverts; cUSDC would move 0 silently), and indexed from its `CreditsBought` events. What was
used is kept in `relayer_free_used` and `relayer_credits_spent`, which a replay of the
chain does not touch. Migration 4 empties the index once so it is rebuilt with the ACL and
credit events.

## Run it

```bash
pnpm --filter @dno/api test        # unit tests; with TEST_DATABASE_URL, the Postgres store too
pnpm --filter @dno/api dev         # bundles and starts on :8080, index in memory
DATABASE_URL=postgres://... pnpm --filter @dno/api dev
```

Configuration is environment variables, all optional in development: see `src/config.ts`
(`RPC_URLS`, `RPC_RPS`, `CONFIRMATIONS`, `CORS_ORIGINS`, `SESSION_SECRET`, `RELAYER_API_KEY`,
`RELAYER_FREE_PER_DAY`, `RELAYER_NEWCOMER_PER_DAY`, `RELAYER_INPUT_UNITS`, `RELAYER_PUBLIC_PER_HANDLE`...). Deployment is in
[`deploy/README.md`](../../deploy/README.md).
