# Architecture

## Packages

```mermaid
flowchart TB
  subgraph portable["Portable: no chain, runs anywhere"]
    spec["game-spec<br/>spec.json: traits, odds, score, rules"]
    gen["generator<br/>seed -> CatSpec, token id -> BoxSpec<br/>SVG fallback, metadata JSON"]
    scene["scene<br/>three.js builders, effects, sound"]
  end
  subgraph chain["Chain-specific"]
    evm["contracts-evm<br/>ConfidentialERC721.sol, DoNotOpen.sol, DoNotOpenConfig.sol<br/>Croq.sol, ConfidentialCroq.sol, Pantry.sol"]
    impl["chain-adapter / evm<br/>ethers + Relayer SDK"]
    sol["chain-adapter / solana<br/>not started"]
  end
  iface["chain-adapter<br/>ChainAdapter interface + MockAdapter"]
  web["apps/web<br/>React Three Fiber app, metadata renderer"]

  spec --> gen --> scene --> web
  gen --> web
  spec -- "numbers, at deploy" --> evm
  evm -- "address + ABI" --> impl
  impl --> iface
  sol -.-> iface
  spec --> iface
  iface --> web
```

| Package | Depends on | Must never depend on |
| --- | --- | --- |
| `game-spec` | nothing | anything |
| `generator` | `game-spec` | three.js, any chain library |
| `scene` | `generator`, three.js | React, any chain library |
| `contracts-evm` | `game-spec` (deploy and tests), `generator` (tests) | the web app |
| `chain-adapter` | `game-spec`, `generator` (mock only), ethers, Relayer SDK | three.js, React |
| `apps/web` | `chain-adapter`, `generator`, `scene`, React | ethers, viem, the Relayer SDK |

The last row is the portability rule of the project. It is checked the blunt way:
`apps/web/package.json` lists none of those libraries, so an import would not resolve.

## One source of truth

`packages/game-spec/spec.json` holds every number of the game, the croquette economy
included (the `economy` section). Three consumers read it and tests keep them in
agreement:

```mermaid
flowchart LR
  json["spec.json"]
  json --> ts["generator (TypeScript)<br/>decodeSeed, resolveTraits, rarityScore"]
  json -- "configParamsFromSpec()<br/>+ keccak256 of the file" --> cfg["DoNotOpenConfig (Solidity)<br/>decode(seed)"]
  json -- "pantryParamsFromSpec()<br/>economyFromSpec()" --> pantry["Pantry + Croq (Solidity)<br/>bag, purr, meal split, daily cap,<br/>builds, tolerance, supply split"]
  json --> mock["MockAdapter"]
  ts <-- "test: same state, rolls and score<br/>for random seeds" --> cfg
  ts <-- "smoke test: every reveal on Sepolia<br/>matches the generator" --> cfg
```

The config contract stores the hash of the spec file it was built from
(`specHash`), so anyone can check which rules a deployment runs. The Pantry keeps its
numbers as public immutables (`welcomeBag`, `purrMaxPerDay`, `mealsPerDay`,
`maxEatenPerDay`, `mealTreasuryBps`, `mealBurnBps`, `buildFloors()`, `sickMinWeight`...).

## Contracts

```mermaid
flowchart LR
  base["ConfidentialERC721<br/>encrypted owners, isOwner,<br/>transfers that never revert on ownership"] -- "inherited by" --> dno
  cfg["DoNotOpenConfig<br/>rules, decode(seed)"] --> dno["DoNotOpen<br/>seeds, hidden mint, milestones,<br/>shake, requests, duel shelf"]
  dno -- "pulls and pays" --> cusdc["cUSDC<br/>ERC-7984"]
  croq["Croq<br/>ERC-20, 20M fixed"] -- "underlying" --> ccroq["ConfidentialCroq<br/>ERC-7984 wrapper, cCROQ"]
  pantry["Pantry<br/>reserve, stashes, weights,<br/>treasury share, burnt pile, weigh-ins"] -- "isOwner (trusted reader), status,<br/>vetCertified, contentsOf" --> dno
  pantry -- "confidentialTransferFrom,<br/>confidentialTransfer, wrap" --> ccroq
  croq -- "4M, no USDC" --> pool["Uniswap V3 pool<br/>CROQ/USDC, 1%"]
  locker["LiquidityLocker<br/>holds the position for good,<br/>fees to the treasury"] -- "owns the position" --> pool
```

`DoNotOpen` knows the Pantry only as a trusted reader: the owner's `setTrustedReader`
lets it ask `isOwner(tokenId, account)`, an encrypted answer, about anyone. Nothing else
links them; the Pantry never writes to a box, and the economy could be replaced without
touching one. `ConfidentialERC721` is a reusable base, ERC-165 id `0x5f6463b8`, described in
[HIDDEN_OWNERS.md](HIDDEN_OWNERS.md). The Pantry holds all its croquettes as one
cCROQ balance and splits it into encrypted buckets: the reserve, the treasury's
uncollected share, and the burnt pile. A cat's weight is a counter, not a bucket: the
croquettes it ate have already been split. See [CROQ.md](CROQ.md).

## Data flow at run time

```mermaid
flowchart LR
  user((User)) --> web["apps/web"]
  web -- "ChainAdapter calls" --> adapter["EvmFhevmAdapter"]
  adapter -- "transactions" --> wallet["Browser wallet"] --> chain["DoNotOpen, Pantry, cCROQ<br/>on the host chain"]
  wallet --> uni["Uniswap V3 SwapRouter02<br/>CROQ market"]
  adapter -- "quotes" --> quoter["Uniswap V3 QuoterV2"]
  adapter -- "encrypted inputs<br/>(mint quantity, meal, transfer, unwrap)" --> sdk["Relayer SDK<br/>in the page"]
  adapter -- "reads" --> rpc["Public RPC"] --> chain
  chain -- "symbolic FHE ops, ACL" --> copro["Zama coprocessor"]
  adapter -- "userDecrypt / publicDecrypt" --> relayer["Zama relayer"] --> kms["KMS (threshold)"]
  kms -- "checks ACL" --> chain
  adapter -- "revealed seed, public facts" --> web
  web -- "seed -> CatSpec" --> gen["generator"] --> scene["scene"] --> canvas["WebGL canvas"]
```

Two things are worth noticing:

- The contract never sees a plaintext secret until a box is opened. It manipulates
  handles; the coprocessor does the arithmetic on ciphertexts.
- The secrets that come from users are the quantity of a mint and croquette amounts.
  The page encrypts them with the Relayer SDK and sends a ciphertext with an input
  proof; the contract never sees the number.
- Who holds a box is never read from the chain in the clear. The adapter replays the
  connected account's own `ConfidentialTransfer` receipts, decrypting their "moved" bits
  (one signature per visit), to find its boxes.
- The app never trusts the chain for the look of a cat. The chain reveals a seed; the
  generator turns it into a `CatSpec`. The chain also stores state, rolls and score, and
  the app compares them with what the generator derived (`catFromRevealed`).

## 3D pipeline

```mermaid
flowchart LR
  tid["token id (public)"] --> bs["buildBoxSpec()"] --> BoxSpec
  seed["seed + affection<br/>(public once opened)"] --> cs["buildCatSpec()"] --> CatSpec

  BoxSpec --> cb["createBox()<br/>canvas textures: cardboard, label, stamp"]
  CatSpec --> cc["createCat() / createDiorama()<br/>kit meshes, zone colours, toon ramp, outlines"]
  py["assets/blender/*.py<br/>blender -b, SDF to mesh"] --> glb["cat-BREED.glb, cat-kit.glb<br/>AssetLibrary + placeholders"] --> cc

  cb --> live["Live scene (apps/web)<br/>depot, shaker, opener, inspector, effects"]
  cc --> live
  cb --> off["Offscreen frame<br/>render.html in headless Chrome"]
  cc --> off
  off --> png["TOKEN.png"]
  BoxSpec --> svg["renderBoxSvg / renderCatSvg"] --> svgf["TOKEN.svg"]
  CatSpec --> svg
  CatSpec --> meta["sealedMetadata / revealedMetadata"] --> json["TOKEN.json"]
```

- **Specs are data.** `BoxSpec` and `CatSpec` are plain JSON-able objects. Anything that
  can read them can draw the token: three.js today, an SVG string, another engine later.
- **Builders return objects, not components.** Each returns `{ group, update(time),
  dispose() }`. The React app mounts them with `<primitive>`; the metadata page uses the
  same builders with no React at all.
- **Cats are assembled, not stored.** A cat is one head, two ears, one tail and one of
  five posed bodies from its breed's file, plus face parts and an accessory from a
  shared file, hung on named anchors. The files are generated by Blender scripts
  (`assets/BLENDER_TODO.md`) and hold shapes only: colours come from the `CatSpec`
  through zone masks stored in the vertex colours. `createCat` returns its group at
  once and fills it when the files have loaded; `ready` resolves then, and the metadata
  page waits for it.
- **Privacy rule.** A sealed box is drawn from its token id only. `buildBoxSpec` cannot
  see a seed, so no render, texture or metadata file of a sealed box can leak one.
- **Determinism.** Every random choice in a builder comes from `mulberry32` seeded by
  the spec. The metadata frame is taken at a fixed camera, size and time.
- **Degradation.** `detectQuality()` returns one of two tiers (shadows, post-processing,
  dust count, pixel ratio). `prefers-reduced-motion` shortens or removes every sequence.

See [DESIGN.md](DESIGN.md) for the art direction and the effect catalogue.

## The web app

```mermaid
flowchart TB
  main["main.tsx"] --> provider["ChainProvider<br/>adapter, account, collection,<br/>my boxes once found (Show my boxes)"]
  provider --> app["App<br/>view switch, wallet tag, sound"]
  app --> shelf["ShelfView<br/>mint, my boxes, pending requests,<br/>shake earnings, croquettes"]
  app --> box["BoxView<br/>shake, feed, alive check, open, send,<br/>take the cat out"]
  app --> pair["PairView<br/>duel, entangle, open"]
  app --> duels["DuelShelfView<br/>boxes up for a duel: put up,<br/>withdraw, take up"]
  app --> board["LeaderboardView<br/>opened cats by score, and their openers"]
  app --> spec["SpecimensView<br/>fixture cats, no chain"]
  shelf & box & pair & duels --> action["useAction()<br/>one action at a time, step, error copy"]
  shelf --> s1["ShelfScene"]
  box --> s2["BoxScene"]
  pair --> s3["PairScene"]
  spec --> s4["SpecimenScene"]
  board --> s4
  board --> s1
```

`VITE_CHAIN_MODE` (or `?chain=` in the URL) picks the adapter. In mock mode the EVM
adapter, ethers and the Relayer SDK are never downloaded: they sit behind a dynamic import.

The leaderboard ranks only what is public: opened cats by rarity score, and the players
who opened them (`Observed` names the opener, the only holder that is ever public). It
reads every `Observed` event through `openedCats()`, served by the backend's index
([`apps/api`](../apps/api/README.md)) when `VITE_API_URL` is set. `boxesOf` gets its receipts
from the index too, but only the account itself can decrypt them: the backend never knows
who holds what.

## The backend

`apps/api` follows the protocol's logs into Postgres and serves the app's reads (box lists,
leaderboard, the duel shelf and duels, pending requests, receipts, economy, token metadata),
so visitors do not each hit a public RPC. The EVM adapter reads it first and falls back on
the RPC when it is down, or behind the account's own last transaction. Duels are kept
there, so the shelf lists every box up for a duel, and an account finds its open duels
from any device. Deployment: [`deploy/README.md`](../deploy/README.md).

It is also the only way the app reaches Zama's relayer, which bills whoever holds the API
key. Its relayer proxy (`/relayer/v2`) keeps the key server-side, lets through only the
protocol's own decryptions and inputs, and counts each wallet's private decryptions against
a free daily allowance, then against the credits bought from `DecryptionCredits`. The
adapter keeps every value it decrypted, by handle, in the browser, so nothing is paid for
twice. Details: [`apps/api/README.md`](../apps/api/README.md#relayer-proxy).

It also runs the manual's chatbot, the depot clerk (`POST /v1/chat`): Google's Gemini, on
its free tier, answers from the whole manual of the player's language, with the key kept on
the server; without a model, or past the day's limits, the clerk quotes the manual's best
matching paragraphs instead. The manual reaches the API as a JSON export of the rendered
page (`apps/web/scripts/export-manual.mts`). In the web app the clerk is `src/chat/Clerk.tsx`:
a tab on the manual's edge and a link in the game's footer, shown only when `VITE_API_URL`
is set. Details: [`apps/api/README.md`](../apps/api/README.md#the-manuals-chatbot).

The backend also files the release form every player signs before playing (`POST /v1/terms`): the
wallet's EIP-191 signature on the terms, checked and kept as a record. That tells it an
address accepted the terms, nothing about what it holds. See
[FLOWS.md](FLOWS.md#release-form-before-the-first-box).

### Gaps against the original brief

- **No event subscription.** The brief's interface lists `subscribeEvents`. The adapter
  re-reads state after each action instead. Another holder's action (a duel taken
  up, a paid shake) shows up on the next read, not live.
- **Room props.** Rooms are a coloured floor and wall. See `assets/BLENDER_TODO.md`.
