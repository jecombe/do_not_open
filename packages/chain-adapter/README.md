# @dno/chain-adapter

The only package that knows which chain the game runs on. The web app imports
`ChainAdapter` from here and nothing else chain-related: no ethers, no viem, no Relayer SDK.

```mermaid
flowchart LR
  web["apps/web"] --> iface["ChainAdapter<br/>src/types.ts"]
  iface --> mock["MockAdapter<br/>in memory"]
  iface --> evm["EvmFhevmAdapter<br/>ethers + Relayer SDK"]
  iface -.-> sol["solana/<br/>not started"]
  evm --> contract["DoNotOpen, Pantry, cCROQ on Sepolia"]
  evm --> market["Uniswap V2: CROQ/WETH"]
  evm --> relayer["Zama relayer + KMS"]
```

| File | What it is |
| --- | --- |
| `src/types.ts` | The interface, its data types, `ChainError`, and a few chain-neutral helpers |
| `src/mock/MockAdapter.ts` | The whole game in memory, with the contract's rules and refusals. The other holder accepts everything at once, so every flow can be played alone |
| `src/evm/EvmFhevmAdapter.ts` | Sepolia: transactions through ethers, decryptions through `@zama-fhe/relayer-sdk` |
| `src/evm/wallet.ts` | Where signatures come from: an injected browser wallet, or a fixed signer in Node |
| `src/evm/browser.ts`, `src/evm/node.ts` | The two ways to build the EVM adapter. They differ only in wallet and in which SDK build they load |
| `src/evm/deployments/sepolia.json` | Address and ABI of `DoNotOpen`, written by `pnpm --filter @dno/contracts-evm export:sepolia` |
| `src/evm/deployments/sepolia-economy.json` | Addresses and ABIs of CROQ, cCROQ and the Pantry, and the Uniswap V2 market, written by the same command |
| `src/solana/README.md` | What the Solana port needs |

## Using it

```ts
import { createAdapter } from "@dno/chain-adapter";

const chain = await createAdapter({ mode: "sepolia" }); // or "mock"
await chain.connect();
const [tokenId] = await chain.mint(1);
const { traitIndex, roll } = await chain.shake(tokenId, { onStep: console.log });
```

Every action takes `onStep` and reports the same four steps, in order: `wallet`,
`confirming`, `decrypting`, `proving`. Failures are `ChainError` with a chain-neutral
`code`, and for contract refusals the contract's error name in `reason`.

In Node (scripts, metadata), import from `@dno/chain-adapter/node`.

The croquette economy sits on the same interface: `economy()`, `boxPantry(tokenId)`,
`croqBalance(owner)`, `confidentialBalance()` (a user decryption), `claimCroquettes`,
`feedCroquettes` (the amount is encrypted in the page), `settle`, `wrap`, `unwrap`
(a public decryption of the amount, then `finalizeUnwrap`), `sendCroquettes`, and
`quote` / `trade` against the public market. See [`docs/CROQ.md`](../../docs/CROQ.md).

## What happens in a shake

```mermaid
sequenceDiagram
  participant App
  participant Adapter
  participant Wallet
  participant Contract
  participant Relayer as Relayer + KMS
  App->>Adapter: shake(tokenId)
  Adapter->>Wallet: send shake()
  Wallet->>Contract: shake()
  Contract-->>Adapter: receipt
  Adapter->>Contract: lastShake(tokenId, me)
  Contract-->>Adapter: two handles
  Adapter->>Wallet: sign EIP-712 permit (once per session)
  Adapter->>Relayer: userDecrypt(handles, permit)
  Relayer-->>Adapter: values re-encrypted for the session key
  Adapter-->>App: { traitIndex, roll }
```

Opening a box, the alive check and a duel use a public decryption instead: the relayer
returns the clear values with a KMS proof, and the adapter sends both back to the
contract, which verifies the proof before storing anything.

## Tests

```bash
pnpm --filter @dno/chain-adapter test            # the mock, 18 tests, no network
pnpm --filter @dno/chain-adapter smoke:sepolia   # every mechanic on the live contract
pnpm --filter @dno/chain-adapter smoke:croq      # welcome bag, meal, buy, wrap, unwrap, transfer, sell
```

The smoke scripts spend testnet ETH (mints, fees, a small market buy) and need
`PRIVATE_KEY` in the repo-root `.env`. `smoke:croq` passed against the live Pantry,
cCROQ and Uniswap pool on 2026-10-01.
