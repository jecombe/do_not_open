# DO NOT OPEN

A confidential NFT collection on the Zama Protocol (FHEVM). 10,000 sealed boxes. Each
holds a cat whose state and traits are drawn and stored encrypted on-chain, so nobody,
the deployer included, knows what is inside until a box is observed.

Boxes, and every paid action, cost USDC; each price can also be paid in cUSDC, Zama's
confidential USDC, which keeps the buyer's balance private. Holders pet their cats (affection, which can turn the accessory golden) and feed
them croquettes (CROQ), a game currency with encrypted balances. The cat eats every
croquette and puts on a weight nobody can read; when the box is opened, the cat is
weighed in public. The heavier it is, the rarer its build, and past a tolerance of its
own the cat is sick: an ultra-rare trophy.

Target: Ethereum Sepolia, then mainnet, then Solana once Zama ships SVM support.

## Status

| Phase | Scope                                                                 | State       |
| ----- | --------------------------------------------------------------------- | ----------- |
| 1     | Game spec, generator, art direction, sealed box + shake, five cats    | **Done**    |
| 2     | Contract: mint, shake, observe, proveAlive, ACL, mock tests, CLI demo | **Done**, live on Sepolia |
| 3     | duel, entangle, feed, paidShake and their 3D effects                  | **Done**, live on Sepolia |
| 4     | EVM chain adapter, full frontend on Sepolia, offscreen metadata render| **Done**    |
| 5     | Full docs, Solana porting map, audit checklist                        | **Done**    |
| CROQ  | Croquette economy: CROQ + cCROQ, Pantry, Uniswap pool, 10,000 boxes   | **Done**, live on Sepolia |
| Weight | Meals eaten whole, 20/60/20 split, daily cap, weigh-in, builds, sickness | **Done** on the mock; needs a Pantry redeploy on Sepolia |

## Layout

```mermaid
flowchart LR
  spec["packages/game-spec<br/>rules, tables, JSON"]
  gen["packages/generator<br/>seed -> CatSpec / BoxSpec"]
  scene["packages/scene<br/>three.js builders"]
  web["apps/web<br/>React Three Fiber app"]
  evm["packages/contracts-evm<br/>Hardhat + FHEVM<br/>DoNotOpen, Croq, cCROQ, Pantry"]
  adapter["packages/chain-adapter<br/>ChainAdapter: mock, EVM, (Solana)"]

  spec --> gen --> scene --> web
  spec --> evm
  spec --> adapter
  evm -- address + ABI --> adapter --> web
```

Portable: `game-spec`, `generator`, `scene`, `apps/web`. Chain-specific:
`contracts-evm` and the adapter implementations. The frontend only ever talks to the
`ChainAdapter` interface: `apps/web` does not depend on ethers, viem or the Relayer SDK.

## Run it

```bash
pnpm install
pnpm test        # generator, chain adapter, and 80 contract tests on the FHEVM mock
pnpm typecheck
pnpm dev         # http://localhost:5173: home page; the game is at /app.html (mock mode, no chain)
```

The same app on Sepolia, against the live contract and Zama's relayer:

```bash
VITE_CHAIN_MODE=sepolia pnpm dev     # or open http://localhost:5173/app.html?chain=sepolia
```

You need a browser wallet with a little Sepolia ETH for gas. Prices are in Zama's test USDC
on Sepolia; the shelf has a button that mints some, and another that shields it as cUSDC. `?chain=mock` and `?chain=sepolia`
switch modes without restarting.

Token metadata (JSON, a 3D render and an SVG fallback per token):

```bash
pnpm --filter @dno/web render:metadata                    # fixtures
pnpm --filter @dno/web render:metadata --source sepolia   # every minted token
```

Requires Node 20+ and pnpm 9. Copy `.env.example` to `.env` when a phase needs secrets.
No private key is ever committed.

## How a box is opened

Every reveal follows this shape: a request on-chain, a decryption off-chain, a proof
back on-chain. There is no decryption callback on the current protocol.

```mermaid
sequenceDiagram
  actor Holder
  participant App
  participant Contract as DoNotOpen
  participant KMS as Zama relayer + KMS
  Holder->>App: Open the box
  App->>Contract: observe(tokenId)
  Contract->>Contract: status = Observing, seed marked publicly decryptable
  App->>KMS: publicDecrypt(handles)
  KMS-->>App: seed + proof
  App->>Contract: finalizeObserve(tokenId, seed, proof)
  Contract->>Contract: verify proof, decode seed, status = Revealed
  App->>App: seed to CatSpec to 3D cat
```

The other mechanics are in [`docs/FLOWS.md`](docs/FLOWS.md).

## Croquettes

Two tokens: **CROQ**, a plain ERC-20 that any market can list, and **cCROQ**, its
confidential ERC-7984 wrapper, which is what the game uses. 20,000,000 CROQ were minted
once at deployment; nothing can mint more.

```mermaid
flowchart LR
  pool["Uniswap V2<br/>CROQ/USDC"] <-- "buy, sell<br/>public amounts" --> player(("Player"))
  player -- "wrap / unwrap<br/>public amounts" --> ccroq["cCROQ<br/>encrypted balances"]
  pantry["Pantry"] -- "welcome bag 100 per box<br/>purr 0..4 per box per day" --> ccroq
  ccroq -- "holder feeds a sealed cat<br/>2 meals, 1,000 a day" --> meal{{"meal, eaten whole<br/>weight += amount"}}
  meal -- "60%" --> pantry
  meal -- "20%, collect()" --> treasury["collection treasury"]
  meal -. "20%" .-> burnt["burnt<br/>locked in the Pantry"]
  meal -. "opened: weigh-in" .-> build["public weight<br/>thin to huge, or sick"]
```

| Share | CROQ |
| --- | --- |
| Game reserve (Pantry, pays the purr, takes back 60% of every meal) | 10,000,000 |
| Welcome bags (Pantry, 100 per box) | 1,000,000 |
| Market liquidity (Uniswap V2) | 4,000,000 |
| Treasury | 5,000,000 |

The rules, what leaks and the costs are in [`docs/CROQ.md`](docs/CROQ.md).

## Live on Sepolia

| Contract | Address |
| --- | --- |
| `DoNotOpen` (10,000 boxes) | [`0xe8f699eEBc22767413A9edBb48826B10D3117f61`](https://sepolia.etherscan.io/address/0xe8f699eEBc22767413A9edBb48826B10D3117f61) |
| `DoNotOpenConfig` | [`0xa5D7870f643537b85A575Ab716446fdb6F022780`](https://sepolia.etherscan.io/address/0xa5D7870f643537b85A575Ab716446fdb6F022780) |
| `Croq` (CROQ) | [`0x183B74906673283f7Fe3272103989A357Cf88522`](https://sepolia.etherscan.io/address/0x183B74906673283f7Fe3272103989A357Cf88522) |
| `ConfidentialCroq` (cCROQ) | [`0x7598484e5DDdada766ab19Cd7d0dD42d17Dd4F06`](https://sepolia.etherscan.io/address/0x7598484e5DDdada766ab19Cd7d0dD42d17Dd4F06) |
| `Pantry` | [`0x20755493eF05C954BdC2e970b0437B12AE19d01e`](https://sepolia.etherscan.io/address/0x20755493eF05C954BdC2e970b0437B12AE19d01e) |
| CROQ/USDC pair, Uniswap V2 | [`0xDc7Ed9F6ffd2993350BDc2c563E42036C5a53B43`](https://sepolia.etherscan.io/address/0xDc7Ed9F6ffd2993350BDc2c563E42036C5a53B43) |
| USDC (Zama's `USDCMock`, anyone can mint) | [`0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF`](https://sepolia.etherscan.io/address/0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF) |
| cUSDC (Zama's `cUSDCMock`) | [`0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639`](https://sepolia.etherscan.io/address/0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639) |
| `UsdcRamp` (ETH in, USDC or cUSDC out, 0.3% fee) | [`0x20FB2d7f2d3fb249924ce3871255bb417670ba50`](https://sepolia.etherscan.io/address/0x20FB2d7f2d3fb249924ce3871255bb417670ba50) |
| ETH/USDC pair, Uniswap V2 (seeded for the ramp) | [`0x58151722a43de9a7A850dF12f6D9924B19E50F8D`](https://sepolia.etherscan.io/address/0x58151722a43de9a7A850dF12f6D9924B19E50F8D) |

The earlier ETH-priced and 5,000-box deployments are superseded. None of these contracts has been
audited. See [`docs/AUDIT_CHECKLIST.md`](docs/AUDIT_CHECKLIST.md) for what is open
before a mainnet deployment.

## Read next

The site opens on a cartoon home page at `/` (source `apps/web/src/home`): the pitch in four steps, a box to shake until a random cat jumps out, and every kind of cat on a three.js turntable. The app carries its own illustrated manual at `/docs.html` (the "Manual" tag in the
navigation): the seed, the flows and the package layout as interactive three.js diagrams.
Its source is `apps/web/src/docs`.

For the reference documents, start at [`docs/README.md`](docs/README.md). In short:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): packages, data flow, 3D pipeline
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md): what is encrypted, who can read what, ACL on transfer
- [`docs/FLOWS.md`](docs/FLOWS.md): sequence diagrams for every mechanic
- [`docs/CROQ.md`](docs/CROQ.md): the croquette economy, its two tokens and its market
- [`docs/SOLANA_PORTING.md`](docs/SOLANA_PORTING.md): the porting map
- [`docs/AUDIT_CHECKLIST.md`](docs/AUDIT_CHECKLIST.md): checks done and findings open
- [`docs/DESIGN.md`](docs/DESIGN.md): art direction, effect catalogue, performance budget
- [`docs/ZAMA_NOTES.md`](docs/ZAMA_NOTES.md): verified FHEVM versions and deviations from the brief
- [`assets/BLENDER_TODO.md`](assets/BLENDER_TODO.md): asset backlog and specs
