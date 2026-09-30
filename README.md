# DO NOT OPEN

A confidential NFT collection on the Zama Protocol (FHEVM). 5,000 sealed boxes. Each
holds a cat whose state and traits are drawn and stored encrypted on-chain, so nobody,
the deployer included, knows what is inside until a box is observed.

Target: Ethereum Sepolia, then mainnet, then Solana once Zama ships SVM support.

## Status

| Phase | Scope                                                                 | State       |
| ----- | --------------------------------------------------------------------- | ----------- |
| 1     | Game spec, generator, art direction, sealed box + shake, five cats    | **Done**    |
| 2     | Contract: mint, shake, observe, proveAlive, ACL, mock tests, CLI demo | **Done**, live on Sepolia |
| 3     | duel, entangle, feed, paidShake and their 3D effects                  | **Done**, live on Sepolia |
| 4     | EVM chain adapter, full frontend on Sepolia, offscreen metadata render| **Done**    |
| 5     | Full docs, Solana porting map, audit checklist                        | **Done**    |

## Layout

```mermaid
flowchart LR
  spec["packages/game-spec<br/>rules, tables, JSON"]
  gen["packages/generator<br/>seed -> CatSpec / BoxSpec"]
  scene["packages/scene<br/>three.js builders"]
  web["apps/web<br/>React Three Fiber app"]
  evm["packages/contracts-evm<br/>Hardhat + FHEVM"]
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
pnpm test        # generator 24, chain adapter 12, contracts 53 on the FHEVM mock
pnpm typecheck
pnpm dev         # http://localhost:5173, mock mode, no chain
```

The same app on Sepolia, against the live contract and Zama's relayer:

```bash
VITE_CHAIN_MODE=sepolia pnpm dev     # or open http://localhost:5173/?chain=sepolia
```

You need a browser wallet with a little Sepolia ETH. `?chain=mock` and `?chain=sepolia`
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

## Live on Sepolia

`DoNotOpen` is at
[`0x6C6210E9CB6CC5218F479806258E86B176aA5BD0`](https://sepolia.etherscan.io/address/0x6C6210E9CB6CC5218F479806258E86B176aA5BD0).
It has not been audited. See [`docs/AUDIT_CHECKLIST.md`](docs/AUDIT_CHECKLIST.md) for
what is open before a mainnet deployment.

## Read next

The app carries its own illustrated manual at `/docs.html` (the "Manual" tag in the
navigation): the seed, the flows and the package layout as interactive three.js diagrams.
Its source is `apps/web/src/docs`.

For the reference documents, start at [`docs/README.md`](docs/README.md). In short:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): packages, data flow, 3D pipeline
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md): what is encrypted, who can read what, ACL on transfer
- [`docs/FLOWS.md`](docs/FLOWS.md): sequence diagrams for every mechanic
- [`docs/SOLANA_PORTING.md`](docs/SOLANA_PORTING.md): the porting map
- [`docs/AUDIT_CHECKLIST.md`](docs/AUDIT_CHECKLIST.md): checks done and findings open
- [`docs/DESIGN.md`](docs/DESIGN.md): art direction, effect catalogue, performance budget
- [`docs/ZAMA_NOTES.md`](docs/ZAMA_NOTES.md): verified FHEVM versions and deviations from the brief
- [`assets/BLENDER_TODO.md`](assets/BLENDER_TODO.md): asset backlog and specs
