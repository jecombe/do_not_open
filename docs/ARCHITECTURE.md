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
    evm["contracts-evm<br/>DoNotOpen.sol, DoNotOpenConfig.sol"]
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

`packages/game-spec/spec.json` holds every number of the game. Three consumers read it
and tests keep them in agreement:

```mermaid
flowchart LR
  json["spec.json"]
  json --> ts["generator (TypeScript)<br/>decodeSeed, resolveTraits, rarityScore"]
  json -- "configParamsFromSpec()<br/>+ keccak256 of the file" --> cfg["DoNotOpenConfig (Solidity)<br/>decode(seed)"]
  json --> mock["MockAdapter"]
  ts <-- "test: same state, rolls and score<br/>for random seeds" --> cfg
  ts <-- "smoke test: every reveal on Sepolia<br/>matches the generator" --> cfg
```

The config contract stores the hash of the spec file it was built from
(`specHash`), so anyone can check which rules a deployment runs.

## Data flow at run time

```mermaid
flowchart LR
  user((User)) --> web["apps/web"]
  web -- "ChainAdapter calls" --> adapter["EvmFhevmAdapter"]
  adapter -- "transactions" --> wallet["Browser wallet"] --> chain["DoNotOpen<br/>on the host chain"]
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
- The app never trusts the chain for the look of a cat. The chain reveals a seed; the
  generator turns it into a `CatSpec`. The chain also stores state, rolls and score, and
  the app compares them with what the generator derived (`catFromRevealed`).

## 3D pipeline

```mermaid
flowchart LR
  tid["token id (public)"] --> bs["buildBoxSpec()"] --> BoxSpec
  seed["seed + affection<br/>(public once opened)"] --> cs["buildCatSpec()"] --> CatSpec

  BoxSpec --> cb["createBox()<br/>canvas textures: cardboard, label, stamp"]
  CatSpec --> cc["createCat() / createDiorama()<br/>procedural meshes, toon ramp, outlines"]
  glb["glTF assets<br/>AssetLibrary + placeholders"] -.-> cc

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
  app --> spec["SpecimensView<br/>fixture cats, no chain"]
  shelf & box & pair --> action["useAction()<br/>one action at a time, step, error copy"]
  shelf --> s1["ShelfScene"]
  box --> s2["BoxScene"]
  pair --> s3["PairScene"]
  spec --> s4["SpecimenScene"]
```

`VITE_CHAIN_MODE` (or `?chain=` in the URL) picks the adapter. In mock mode the EVM
adapter, ethers and the Relayer SDK are never downloaded: they sit behind a dynamic import.

### Gaps against the original brief

- **No leaderboard view.** The brief lists one. Every input it needs is already public
  and readable through the adapter (`box().wins`, revealed scores); the view itself was
  not built.
- **No event subscription.** The brief's interface lists `subscribeEvents`. The adapter
  re-reads state after each action instead. Another holder's action (a challenge, a
  paid shake) shows up on the next read, not live.
- **Room props.** Rooms are a coloured floor and wall. See `assets/BLENDER_TODO.md`.
