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
    evm["contracts-evm<br/>DoNotOpen.sol, DoNotOpenConfig.sol<br/>Croq.sol, ConfidentialCroq.sol, Pantry.sol"]
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
  json -- "pantryParamsFromSpec()<br/>economyFromSpec()" --> pantry["Pantry + Croq (Solidity)<br/>bag, purr, burn, payouts, supply split"]
  json --> mock["MockAdapter"]
  ts <-- "test: same state, rolls and score<br/>for random seeds" --> cfg
  ts <-- "smoke test: every reveal on Sepolia<br/>matches the generator" --> cfg
```

The config contract stores the hash of the spec file it was built from
(`specHash`), so anyone can check which rules a deployment runs. The Pantry keeps its
numbers as public immutables (`welcomeBag`, `purrMaxPerDay`, `mealBurnBps`,
`payoutBps(state)`...).

## Contracts

```mermaid
flowchart LR
  cfg["DoNotOpenConfig<br/>rules, decode(seed)"] --> dno["DoNotOpen<br/>ERC-721, seeds, shake, observe, duel"]
  croq["Croq<br/>ERC-20, 20M fixed"] -- "underlying" --> ccroq["ConfidentialCroq<br/>ERC-7984 wrapper, cCROQ"]
  pantry["Pantry<br/>reserve, stashes, burnt pile"] -- "reads ownerOf, status,<br/>vetCertified, contentsOf" --> dno
  pantry -- "confidentialTransferFrom,<br/>confidentialTransfer, wrap" --> ccroq
  croq -- "4M + ETH" --> pair["Uniswap V2 pair<br/>CROQ/WETH"]
```

`DoNotOpen` does not know the Pantry exists. The economy was added next to it, and
could be replaced without touching a box. The Pantry holds all its croquettes as one
cCROQ balance and splits it into encrypted buckets: the reserve, one stash per box, and
the burnt pile. See [CROQ.md](CROQ.md).

## Data flow at run time

```mermaid
flowchart LR
  user((User)) --> web["apps/web"]
  web -- "ChainAdapter calls" --> adapter["EvmFhevmAdapter"]
  adapter -- "transactions" --> wallet["Browser wallet"] --> chain["DoNotOpen, Pantry, cCROQ<br/>on the host chain"]
  wallet --> uni["Uniswap V2 router<br/>CROQ market"]
  adapter -- "encrypted inputs<br/>(meal, transfer, unwrap)" --> sdk["Relayer SDK<br/>in the page"]
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
- Croquette amounts are the only secrets that come from users. The page encrypts them
  with the Relayer SDK and sends a ciphertext with an input proof; the contract never
  sees the number.
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
  main["main.tsx"] --> provider["ChainProvider<br/>adapter, account, collection, my boxes"]
  provider --> app["App<br/>view switch, wallet tag, sound"]
  app --> shelf["ShelfView<br/>mint, boxes held, claim"]
  app --> box["BoxView<br/>shake, feed, alive check, open, take the cat out"]
  app --> pair["PairView<br/>duel, entangle, open"]
  app --> board["LeaderboardView<br/>opened boxes by score, sealed ones by duel wins"]
  app --> spec["SpecimensView<br/>fixture cats, no chain"]
  shelf & box & pair --> action["useAction()<br/>one action at a time, step, error copy"]
  shelf --> s1["ShelfScene"]
  box --> s2["BoxScene"]
  pair --> s3["PairScene"]
  spec --> s4["SpecimenScene"]
  board --> s4
  board --> s1
```

`VITE_CHAIN_MODE` (or `?chain=` in the URL) picks the adapter. In mock mode the EVM
adapter, ethers and the Relayer SDK are never downloaded: they sit behind a dynamic import.

The leaderboard ranks only what is public: opened boxes by rarity score, sealed boxes
by duels won (a sealed box has no public score). It reads the 250 most recent boxes
one by one through `box()`; past that size it needs an indexer, like `boxesOf`.

### Gaps against the original brief

- **No event subscription.** The brief's interface lists `subscribeEvents`. The adapter
  re-reads state after each action instead. Another holder's action (a challenge, a
  paid shake) shows up on the next read, not live.
- **Room props.** Rooms are a coloured floor and wall. See `assets/BLENDER_TODO.md`.
