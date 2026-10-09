# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

DO NOT OPEN is a confidential NFT collection on Zama's FHEVM: 10,000 sealed boxes whose cats, owners, balances and sale count are encrypted on-chain. pnpm 9 monorepo, Node 20+ (CI uses 24). Target is Ethereum Sepolia today.

## Commands

```bash
pnpm install
pnpm --filter @dno/contracts-evm compile   # needed before typecheck: generates the gitignored typechain types
pnpm typecheck                             # every package
pnpm test                                  # every package (generator, chain-adapter, api, contracts on the FHEVM mock)
pnpm dev                                   # web app, http://localhost:5173 (home at /, game at /app, its manual at /docs, the project's docs at /project, boarding at /apply, the sealed vault at /vault and its docs at /vault-docs; on the live domains the game (with its studio and flea market) and the vault are on game. and vault., see deploy/README.md#domains; /fr/, /es/, /it/ for the other languages)
VITE_CHAIN_MODE=sepolia pnpm dev           # or ?chain=sepolia / ?chain=mock in the URL at run time
pnpm build                                 # web build (what Vercel runs; output apps/web/dist)
pnpm --filter @dno/admin dev               # the team's admin site, http://localhost:5174 (proxies /api to the API's /admin/api; set ADMIN_PASSWORD)
```

Single tests:

```bash
pnpm --filter @dno/generator exec vitest run test/<file>.test.ts -t "<name>"
pnpm --filter @dno/api exec vitest run test/sync.test.ts
pnpm --filter @dno/contracts-evm test test/Pantry.ts           # hardhat test, one file
pnpm --filter @dno/contracts-evm test test/DoNotOpen.ts --grep "<name>"
REPORT_COSTS=1 pnpm --filter @dno/contracts-evm test test/Costs.ts   # gas/HCU table
k6 run -e BASE_URL=http://localhost:8080 loadtest/api.js              # load test (stack: loadtest/README.md)
```

API store tests also run against Postgres when `TEST_DATABASE_URL` is set (CI sets `postgres://dno:dno@localhost:5432/dno_test`). API locally: `pnpm --filter @dno/api dev` (bundles with esbuild, serves :8080, in-memory index unless `DATABASE_URL` is set; config in `apps/api/src/config.ts`).

Contracts (run inside `packages/contracts-evm` or via `--filter`): `pnpm chain` + `pnpm deploy:localhost` + `pnpm demo:localhost` / `demo2:localhost` for a local walkthrough (`npx hardhat --network localhost dno:vault-demo` for the sealed vault). `Pantry.fund` uses FHE, so the economy deploy fails on the bare in-process `hardhat` network — use `pnpm chain`. `pnpm deploy:sepolia` also runs `dno:export`, which rewrites `packages/chain-adapter/src/evm/deployments/sepolia*.json` (addresses + ABIs the adapter uses). Sepolia smoke tests: `pnpm --filter @dno/chain-adapter smoke:sepolia` / `smoke:croq` / `smoke:rats` (its second wallet is a kept test wallet; `test-wallets` lists them). Sepolia's fees can sit far below the default tip: `SEPOLIA_GAS_PRICE=<wei>` pins the gas price, and `hardhat deploy --maxfee <wei> --priorityfee <wei>` the deploy's own transactions.

Secrets go in the repo-root `.env` (see `.env.example`); `VITE_*` values ship to the browser.

## Architecture

```
game-spec ─> generator ─> scene ─> apps/web
    │                                 ▲
    ├─> contracts-evm ──(ABI)──> chain-adapter
    └─────────────────────────────────┘
contracts-evm ──(logs)──> apps/api (indexer + Postgres) ──(VITE_API_URL)──> chain-adapter
```

**Dependency rules (enforced by package.json, not lint):**
- `apps/web` must never depend on ethers, viem or the Relayer SDK. It only talks to the `ChainAdapter` interface (`packages/chain-adapter/src/types.ts`). In mock mode the EVM adapter sits behind a dynamic import and is never downloaded.
- `generator` has no three.js or chain library; `scene` has no React or chain library; `chain-adapter` has no three.js or React.

**One source of truth:** `packages/game-spec/spec.json` holds every game number (traits, odds, score, economy). The generator (TS), `DoNotOpenConfig` / `Pantry` (Solidity, via `lib/specParams.ts` at deploy) and `MockAdapter` all read it, and tests check that the TS and Solidity decoders agree for random seeds. The config contract stores the spec file's keccak256 (`specHash`). Change a rule in `spec.json`, not in one consumer.

**Contracts** (`packages/contracts-evm/contracts`): `ConfidentialERC721` (reusable base, encrypted owners, transfers never revert on ownership) ← `DoNotOpen` (boxes, hidden mint quantity, sale milestones, shake, requests, the duel shelf, and a `guard` every shake passes through; 24,553 bytes deployed, 23 under the 24,576-byte limit, compiled alone with the optimizer at 1 run: a new feature has to move logic out first, which is why the whitelist's gifts live in their own `WhitelistGifts` and the rats' tricks in `RatTricks`) + `DoNotOpenConfig` (rules, `decode(seed)`). Economy: `Croq` (ERC-20, fixed 20M) → `ConfidentialCroq` (ERC-7984 wrapper) → `Pantry` (reads `DoNotOpen` as a trusted reader via `isOwner`, never writes to it). Payments are in cUSDC. `WhitelistGifts` hands each seated wallet its tier's gift once (encrypted cCROQ draw, a box bought from `DoNotOpen` like any buyer, a free rat through `Rats.gift`), against a Merkle root of (wallet, tier). Rats: `Rats` (ERC-721, public owners, one encrypted power 1/2/3 per rat drawn at mint) + `RatPantry` (plain CROQ a day) + `RatTricks` (a rat's sniff, a paid shake with a hidden rebate for power 1, and its tricks: a shield or a jam on a box, decided under encryption; it is `DoNotOpen`'s shake guard and a trusted reader). Next to the game, `SealedVault` (`docs/VAULT.md`): a second `ConfidentialERC721` holding any NFT of an allowed collection, each box with an encrypted key; withdrawals and Seaport 1.5 listings (the vault as offerer, `validate` only, no ERC-1271) are asked with the key XOR a hash of the request's terms, so the API's relayer (`VAULT_RELAYER_KEY`, `POST /v1/vault/relay`) sends them; private sales settle under encryption in cUSDC. Its own contract, default optimizer, linked to none of the game's.

**Reveal pattern (no decryption callback exists in current FHEVM):** every reveal (observe, proveAlive, entangle, duel, milestones) is request on-chain → `publicDecrypt` via the Zama relayer/KMS off-chain → permissionless `finalize(requestId, cleartexts, proof)` that checks KMS signatures. Ownership checks are encrypted, so a non-holder's request doesn't revert; it settles `Refused` and decrypts to zeros. The adapter surfaces those as `ChainError` codes `not-yours` / `unpaid`. ACL grants can't be revoked, so holders never get blanket ACL. Details in `docs/ZAMA_NOTES.md`, `docs/HIDDEN_OWNERS.md`, `docs/FLOWS.md`.

**Hidden owners:** nothing exposes an owner. `boxesOf(account)` replays the account's own `ConfidentialTransfer` receipts and user-decrypts their "moved" bits (one signature per visit). The only public holder is a cat's opener (`Observed` event).

**Chain adapter:** `MockAdapter` implements the whole game in memory with the contract's rules and refusals; `EvmFhevmAdapter` uses ethers + `@zama-fhe/relayer-sdk`. Entry points: `createAdapter` (browser), `@dno/chain-adapter/node` (scripts). Every action takes `onStep` (`encrypting`, `wallet`, `confirming`, `decrypting`, `proving`). When `VITE_API_URL` is set, reads go to the API first and fall back on the RPC when it is down or behind the account's last transaction (every API response carries `block`).

**3D pipeline:** `buildBoxSpec(tokenId)` / `buildCatSpec(seed, affection)` produce plain JSON specs; `scene` builders return `{ group, update(time), dispose() }` (no React), mounted in R3F via `<primitive>` and reused headlessly by `render.html` for metadata (`pnpm --filter @dno/web render:metadata`). Privacy rule: a sealed box is drawn from its token id only — `buildBoxSpec` must never see a seed. All randomness goes through `mulberry32` seeded from the spec. Cat and studio rat meshes are generated by Blender scripts (`pnpm assets:cats`, `--only rat` for the rats; see `assets/BLENDER_TODO.md`).

**API (`apps/api`):** clean architecture — `domain` (pure) ← `application` (use cases `SyncChain`, `Queries`, `SignIn`, `Metadata`, plus ports `ChainSource`/`ChainState`/`Store`) ← `infrastructure` (ethers `RpcPool` over free RPCs, Postgres, Fastify); `main.ts` is the only composition point. The `events` table is the source of truth; every other table is a fold of it and can be rebuilt with `replayAll`. Each batch + projections + cursor is one transaction. Only public facts are indexed; the backend never learns who holds a box. `ROLE` splits it: one `indexer` (chain, index, periodic tasks; only `/health` and `/metrics`) and N `api` replicas that only read. State a request may need on another replica (Sign in with X, `/board` codes, the chat's daily total, nudges via `NOTIFY`) goes through Postgres; per-IP counters stay in memory because Caddy keeps each client IP on one replica. Index-wide metrics come from the indexer only. With `ADMIN_PASSWORD`, replicas also serve the team's admin site (`apps/admin`, built into the image) under `/admin`, reached only through `ADMIN_DOMAIN`. Migrations must keep the previous release working (old replicas overlap the new schema during a deploy).

**Deployment:** the web app is on Vercel (`vercel.json`), one build for every name: the bare domain shows the home page (`apps/web/src/secure`: the vault first in a dark, security-minded theme the vault's page and the boarding page share, the game as a small corner at the end) and the project's docs, `game.` the game and its studio, `vault.` the vault, each with its docs at `/docs`, decided at the edge by `middleware.ts` from `apps/web/src/hosts.ts` (old paths redirect); `apps/web/src/site.ts` builds every link from the host, so a link to another part goes through it, never a hard-coded path. The API is a Docker image built by `.github/workflows/deploy-api.yml` on pushes to `main` (the live stack, `/opt/dno`, whose boarding passes and allow list last until mainnet) and `dev` (the testnet site's API replicas, `/opt/dno-testnet`: no indexer, the same database, its boarding passes, allow list claims and ideas in the `testnet` schema via `LISTS_SCHEMA`; it never migrates), started by the CI run's green end on that push (`workflow_run`) and only when the push touches the API image or its stack, then deployed over SSH with docker-compose + Caddy (`deploy/`): `API_REPLICAS` API replicas (alias `dno-api`, Caddy `dynamic a` + `client_ip_hash`) and one indexer, replaced replica by replica by `deploy/deploy.sh`. `.github/workflows/loadtest.yml` runs k6 (`loadtest/`) against a seeded ephemeral stack with 1 and 3 replicas on API pull requests into `main` (not into `dev`). The site picks its API by host (`apps/web/src/apiUrl.ts`): `testnet.do-not-open.app` (the same production build from `main`: a branch domain would be a preview behind Vercel's login) talks to `api.testnet.do-not-open.app`, whose API follows `dev`. Monitoring (`deploy/monitoring`: Prometheus, Grafana, Alertmanager to Discord) is one stack for testnet and mainnet: every series has a `network` label and a `role` (api or indexer); Prometheus finds each replica by DNS, one job per network.

## Conventions

- **Actions minutes are billed (private repo, 2,000 free a month):** CI runs once per pull request and on pushes to `dev` and `main`, never on a working branch alone or on docs alone; k6 only on pull requests into `main`. Don't add triggers or polling jobs that spend minutes without need.
- **Branch order, always:** open a branch, open a pull request, merge it into `dev` first (a push to `dev` deploys the testnet site's API), check the testnet, then merge `dev` into `main` (a push to `main` deploys the live stack). Never push or merge straight to `main`. A change the testnet stack depends on (a migration, say) still reaches the database only through `main`: the testnet API never migrates and refuses to start without its `testnet` tables.
- **Throwaway test wallets are the team's.** A script or session that tests with a fresh wallet takes it from `testWallet(name, purpose)` (`packages/chain-adapter/scripts/testWallets.ts`), which keeps its key in the gitignored `.test-wallets.json` at the repo root so the next run and the next session reuse it; never `Wallet.createRandom()` alone. Every such address goes into `TEAM_WALLETS` in `/opt/dno/.env` on the server (the deployer is in it too), so it never takes a place on the mainnet list; `pnpm --filter @dno/chain-adapter test-wallets` lists them. They are Sepolia-only and are never funded on mainnet. The testnet stack sets `TEAM_WALLETS=` (empty): there the team tests the list like anyone.

- Commit messages are a single plain-English sentence in the imperative, no prefix (e.g. "Keep the shelf in view on phones").
- Docs (`README.md`, `docs/*.md`, package READMEs) are kept in sync with code changes, including the Sepolia address tables and the in-app manual at `apps/web/src/docs`.
- **Every change, addition or removal is checked against the root `README.md` before it is pushed**: its intro (domains, where each part lives), the status table (each feature's row says what it does and whether it is done, live on Sepolia or not deployed, matching the address table), the layout diagram, the commands and test counts, the feature sections and the Sepolia address table. A feature added gets its row and its section; one removed or renamed loses or changes them; a deployment moves its row to live. Re-read the rows next to the one edited: a note pasted on the wrong row went unseen once.
- **Every new feature, and every change to a contract or to a game rule, updates the docs in the same branch, before it is pushed.** Check at least: `docs/FLOWS.md` (sequence and state diagrams), `docs/DATA_MODEL.md`, `docs/HIDDEN_OWNERS.md` and `docs/ZAMA_NOTES.md` (what leaks, ACL, decisions, contract size), `docs/AUDIT_CHECKLIST.md`, `docs/SOLANA_PORTING.md`, `docs/VAULT.md` (the sealed vault), the package READMEs (`contracts-evm` gas/HCU table from `REPORT_COSTS=1 ... test/Costs.ts`, `chain-adapter` API, `apps/api` routes and migrations), `packages/game-spec/spec.json` (rules and events), the in-app manual in all four languages (`apps/web/src/docs/i18n/*.ts`, `flows.ts`, `Manual.tsx`), the project's docs (`apps/web/src/project`) and the vault's (`apps/web/src/vault/docs`), and the home page copy (`apps/web/src/secure/i18n`, plus the sections it shares with the boarding page in `apps/web/src/home/i18n`). A redeployment also updates the address tables in `README.md`, `docs/ZAMA_NOTES.md`, `docs/CROQ.md` and `docs/AUDIT_CHECKLIST.md`, keeping the replaced addresses as history.
- User-facing copy goes through `apps/web/src/i18n`.
