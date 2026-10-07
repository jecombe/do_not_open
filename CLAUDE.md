# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

DO NOT OPEN is a confidential NFT collection on Zama's FHEVM: 10,000 sealed boxes whose cats, owners, balances and sale count are encrypted on-chain. pnpm 9 monorepo, Node 20+ (CI uses 24). Target is Ethereum Sepolia today.

## Commands

```bash
pnpm install
pnpm --filter @dno/contracts-evm compile   # needed before typecheck: generates the gitignored typechain types
pnpm typecheck                             # every package
pnpm test                                  # every package (generator, chain-adapter, api, contracts on the FHEVM mock)
pnpm dev                                   # web app, http://localhost:5173 (home at /, game at /app, manual at /docs, boarding at /apply; /fr/, /es/, /it/ for the other languages)
VITE_CHAIN_MODE=sepolia pnpm dev           # or ?chain=sepolia / ?chain=mock in the URL at run time
pnpm build                                 # web build (what Vercel runs; output apps/web/dist)
```

Single tests:

```bash
pnpm --filter @dno/generator exec vitest run test/<file>.test.ts -t "<name>"
pnpm --filter @dno/api exec vitest run test/sync.test.ts
pnpm --filter @dno/contracts-evm test test/Pantry.ts           # hardhat test, one file
pnpm --filter @dno/contracts-evm test test/DoNotOpen.ts --grep "<name>"
REPORT_COSTS=1 pnpm --filter @dno/contracts-evm test test/Costs.ts   # gas/HCU table
```

API store tests also run against Postgres when `TEST_DATABASE_URL` is set (CI sets `postgres://dno:dno@localhost:5432/dno_test`). API locally: `pnpm --filter @dno/api dev` (bundles with esbuild, serves :8080, in-memory index unless `DATABASE_URL` is set; config in `apps/api/src/config.ts`).

Contracts (run inside `packages/contracts-evm` or via `--filter`): `pnpm chain` + `pnpm deploy:localhost` + `pnpm demo:localhost` / `demo2:localhost` for a local walkthrough. `Pantry.fund` uses FHE, so the economy deploy fails on the bare in-process `hardhat` network — use `pnpm chain`. `pnpm deploy:sepolia` also runs `dno:export`, which rewrites `packages/chain-adapter/src/evm/deployments/sepolia*.json` (addresses + ABIs the adapter uses). Sepolia smoke tests: `pnpm --filter @dno/chain-adapter smoke:sepolia` / `smoke:croq`.

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

**Contracts** (`packages/contracts-evm/contracts`): `ConfidentialERC721` (reusable base, encrypted owners, transfers never revert on ownership) ← `DoNotOpen` (boxes, hidden mint quantity, sale milestones, shake, requests, the duel shelf; 24,512 bytes deployed, 64 under the 24,576-byte limit, compiled alone with the optimizer at 1 run: a new feature has to move logic out first, which is why the whitelist's gifts live in their own `WhitelistGifts`) + `DoNotOpenConfig` (rules, `decode(seed)`). Economy: `Croq` (ERC-20, fixed 20M) → `ConfidentialCroq` (ERC-7984 wrapper) → `Pantry` (reads `DoNotOpen` as a trusted reader via `isOwner`, never writes to it). Payments are in cUSDC. `WhitelistGifts` hands each seated wallet its tier's gift once (encrypted cCROQ draw, a box bought from `DoNotOpen` like any buyer, a free rat through `Rats.gift`), against a Merkle root of (wallet, tier).

**Reveal pattern (no decryption callback exists in current FHEVM):** every reveal (observe, proveAlive, entangle, duel, milestones) is request on-chain → `publicDecrypt` via the Zama relayer/KMS off-chain → permissionless `finalize(requestId, cleartexts, proof)` that checks KMS signatures. Ownership checks are encrypted, so a non-holder's request doesn't revert; it settles `Refused` and decrypts to zeros. The adapter surfaces those as `ChainError` codes `not-yours` / `unpaid`. ACL grants can't be revoked, so holders never get blanket ACL. Details in `docs/ZAMA_NOTES.md`, `docs/HIDDEN_OWNERS.md`, `docs/FLOWS.md`.

**Hidden owners:** nothing exposes an owner. `boxesOf(account)` replays the account's own `ConfidentialTransfer` receipts and user-decrypts their "moved" bits (one signature per visit). The only public holder is a cat's opener (`Observed` event).

**Chain adapter:** `MockAdapter` implements the whole game in memory with the contract's rules and refusals; `EvmFhevmAdapter` uses ethers + `@zama-fhe/relayer-sdk`. Entry points: `createAdapter` (browser), `@dno/chain-adapter/node` (scripts). Every action takes `onStep` (`encrypting`, `wallet`, `confirming`, `decrypting`, `proving`). When `VITE_API_URL` is set, reads go to the API first and fall back on the RPC when it is down or behind the account's last transaction (every API response carries `block`).

**3D pipeline:** `buildBoxSpec(tokenId)` / `buildCatSpec(seed, affection)` produce plain JSON specs; `scene` builders return `{ group, update(time), dispose() }` (no React), mounted in R3F via `<primitive>` and reused headlessly by `render.html` for metadata (`pnpm --filter @dno/web render:metadata`). Privacy rule: a sealed box is drawn from its token id only — `buildBoxSpec` must never see a seed. All randomness goes through `mulberry32` seeded from the spec. Cat and studio rat meshes are generated by Blender scripts (`pnpm assets:cats`, `--only rat` for the rats; see `assets/BLENDER_TODO.md`).

**API (`apps/api`):** clean architecture — `domain` (pure) ← `application` (use cases `SyncChain`, `Queries`, `SignIn`, `Metadata`, plus ports `ChainSource`/`ChainState`/`Store`) ← `infrastructure` (ethers `RpcPool` over free RPCs, Postgres, Fastify); `main.ts` is the only composition point. The `events` table is the source of truth; every other table is a fold of it and can be rebuilt with `replayAll`. Each batch + projections + cursor is one transaction. Only public facts are indexed; the backend never learns who holds a box.

**Deployment:** the web app is on Vercel (`vercel.json`). The API is a Docker image built by `.github/workflows/deploy-api.yml` on pushes to `main` only, after CI is green, then deployed over SSH with docker-compose + Caddy (`deploy/`). Monitoring (`deploy/monitoring`: Prometheus, Grafana, Alertmanager to Discord) is one stack for testnet and mainnet: every series has a `network` label, one Prometheus target file per network.

## Conventions

- Commit messages are a single plain-English sentence in the imperative, no prefix (e.g. "Keep the shelf in view on phones").
- Docs (`README.md`, `docs/*.md`, package READMEs) are kept in sync with code changes, including the Sepolia address tables and the in-app manual at `apps/web/src/docs`.
- **Every new feature, and every change to a contract or to a game rule, updates the docs in the same branch, before it is pushed.** Check at least: `docs/FLOWS.md` (sequence and state diagrams), `docs/DATA_MODEL.md`, `docs/HIDDEN_OWNERS.md` and `docs/ZAMA_NOTES.md` (what leaks, ACL, decisions, contract size), `docs/AUDIT_CHECKLIST.md`, `docs/SOLANA_PORTING.md`, the package READMEs (`contracts-evm` gas/HCU table from `REPORT_COSTS=1 ... test/Costs.ts`, `chain-adapter` API, `apps/api` routes and migrations), `packages/game-spec/spec.json` (rules and events), the in-app manual in all four languages (`apps/web/src/docs/i18n/*.ts`, `flows.ts`, `Manual.tsx`) and the home page copy (`apps/web/src/home/i18n`). A redeployment also updates the address tables in `README.md`, `docs/ZAMA_NOTES.md`, `docs/CROQ.md` and `docs/AUDIT_CHECKLIST.md`, keeping the replaced addresses as history.
- User-facing copy goes through `apps/web/src/i18n`.
