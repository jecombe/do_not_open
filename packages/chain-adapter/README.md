# @dno/chain-adapter

The only package that knows which chain the game runs on. The web app imports
`ChainAdapter` from here and nothing else chain-related: no ethers, no viem, no Relayer SDK.

```mermaid
flowchart LR
  web["apps/web"] --> iface["ChainAdapter<br/>src/types.ts"]
  iface --> mock["MockAdapter<br/>in memory"]
  iface --> evm["EvmFhevmAdapter<br/>ethers + Relayer SDK"]
  iface -.-> sol["solana/<br/>not started"]
  evm --> contract["DoNotOpen, Pantry, cCROQ, cUSDC on Sepolia"]
  evm --> market["Uniswap V3: CROQ/USDC<br/>QuoterV2, SwapRouter02"]
  evm --> relayer["Zama relayer + KMS"]
```

| File | What it is |
| --- | --- |
| `src/types.ts` | The interface, its data types, `ChainError`, and a few chain-neutral helpers |
| `src/mock/MockAdapter.ts` | The whole game in memory, with the contract's rules and refusals. The other holder (the night shift) keeps two of its boxes on the duel shelf, takes up at once any duel reserved for one of its boxes, and accepts every entanglement, so every flow can be played alone |
| `src/evm/EvmFhevmAdapter.ts` | Sepolia: transactions through ethers, decryptions through `@zama-fhe/relayer-sdk` |
| `src/evm/wallet.ts` | Where signatures come from: an injected browser wallet, or a fixed signer in Node |
| `src/evm/browser.ts`, `src/evm/node.ts` | The two ways to build the EVM adapter. They differ only in wallet and in which SDK build they load |
| `src/evm/deployments/sepolia.json` | Address and ABI of `DoNotOpen`, written by `pnpm --filter @dno/contracts-evm export:sepolia` |
| `src/evm/deployments/sepolia-economy.json` | Addresses and ABIs of CROQ, cCROQ and the Pantry, and the Uniswap V3 market (pool, fee, locked position and its ticks, locker, position manager, `SwapRouter02`, `QuoterV2`, USDC), written by the same command |
| `src/evm/uniswapV3.ts` | Reading the V3 pool like a constant-product one: `sqrtRatioAtTick` (a port of `TickMath`), `virtualReserves`, `rangePerThousand`. Exported as `@dno/chain-adapter/uniswap-v3`, also used by the API |
| `src/mock/pool.ts` | `MockPool`: the mock's market, the same CROQ-only V3 range |
| `src/solana/README.md` | What the Solana port needs |

## Using it

```ts
import { createAdapter } from "@dno/chain-adapter";

const chain = await createAdapter({ mode: "sepolia" }); // or "mock"
const me = await chain.connect();
const [tokenId] = await chain.mint(1, { ids: 10 }); // 1 box hidden among 10 ids, paid in cUSDC
const mine = await chain.boxesOf(me);              // found in my own receipts
const { traitIndex, roll } = await chain.shake(tokenId, { onStep: console.log });
```

Every action takes `onStep` and reports its steps, in order, from `encrypting`, `wallet`,
`confirming`, `decrypting`, `proving`. Failures are `ChainError` with a chain-neutral
`code`, and for contract refusals the contract's error name in `reason`. Two codes come
from encrypted checks rather than reverts: `unpaid` (the cUSDC did not cover the price,
or the mint would pass the cap; nothing was taken) and `not-yours` (the caller did not
hold the box; nothing happened, and nobody else learned it). The others are `rejected`,
`wallet-busy` (the wallet already shows a request), `wrong-network`, `insufficient-funds`
(the gas coin), `insufficient-usdc`, `nonce` (an earlier transaction in the way), `network`
(an endpoint or the decryption service did not answer), `decryption`, `reverted`,
`not-connected`, `no-wallet` and `unknown`.

`ChainError.detail` says what the app needs to word a way out: `held` and `needed` for a
missing balance, `txUrl` for the transaction that failed, `resumable` when the first
transaction went through and running the action again picks it up, and `landed` when it
did its work and only reading the result back failed (running it again would do it twice).
The EVM adapter dry-runs every transaction against the read endpoint first, so a contract
refusal or missing gas money is reported, with its reason, before the wallet opens.
`src/evm/errors.ts` sorts what wallets and endpoints throw into these codes.

In Node (scripts, metadata), import from `@dno/chain-adapter/node`.

## Hidden owners

Who holds a box is encrypted on-chain (see [`docs/HIDDEN_OWNERS.md`](../../docs/HIDDEN_OWNERS.md)),
so the interface has no owner field anywhere:

- `boxesOf(account)` finds the connected account's boxes by replaying its own
  `ConfidentialTransfer` receipts, whose "moved" bits only it can decrypt: one decryption
  signature the first time, then only new blocks are read. It returns `[]` for anyone else.
  `BoxInfo.mine` and `BoxSummary.mine` say whether a box was found that way.
- `mint(quantity, { ids, pay })`: the quantity is encrypted in the page and hidden among
  `ids` token ids (the rest are empty). Paid in cUSDC; `pay: "usdc"` shields the exact
  price first, publicly. Returns the ids the caller got, and announces a milestone the
  mint reached (`announceMilestone`, which anyone may also call).
- `collection()` reports `tokenCount` (ids created, empty ones included) and `sale`
  (`milestones`, `reached`, `soldOut`) instead of a minted count.
- Openings, alive checks and entanglements are requests: `pendingRequests(account)` lists
  the ones waiting for their proof, `finishRequest(requestId)` sends it (anyone may).
- Duels go on a shelf. `postDuel(tokenA, { reservedFor })` puts a box up, open to any
  sealed box or reserved for one, and proves the caller holds it (that much becomes
  public); it throws `not-yours` when they do not, and `reverted` with reason `DuelPending`
  when the box's listed duel was accepted and still waits for its outcome (the new posting
  gives way to it). `duelShelf()` lists every box up for a
  duel that can still be taken up (in time, its box and any reserved one still sealed;
  `shelfBoxes(duel)` names those boxes). `acceptDuel(duelId, tokenB)` takes one up and returns
  the outcome, or `null` when the duel was void or went back on the shelf. `finishDuel`
  sends whichever proof a duel waits for (the holding, or the outcome); `cancelDuel`
  withdraws a box until someone takes it up. `pair(a, b).duels` lists the duels the two
  boxes can settle: both can be up at once. `DuelStatus` is `"posted"`, `"open"`,
  `"pending"`, `"resolved"`, `"cancelled"` or `"void"` (`"none"` for an unknown id).
- `entangleProposals(tokenIds)` lists the entanglements proposed to or by these boxes that
  can still be accepted (both sealed, neither entangled), newest first: from the API, or
  from the `EntangleProposed` logs without it.
- `claimEarnings(tokenIds)` collects what paid shakes earned the boxes the caller holds;
  `sendBox(tokenId, to)` is a confidential transfer. `sendBox(tokenId, to, { decoys: n })`
  (up to `MAX_DECOYS`, 5) also sends `n` decoys to fresh random addresses through
  `confidentialTransferIf`, in a random order with the real one, from one encryption: one
  transaction each. `decoyPlan(to, n)` is the plan it follows.
- A claim lists its ids in the clear, so never list the held boxes alone:
  `claimWindows(tokenIds, tokenCount)` turns them into whole windows of `CLAIM_WINDOW` (10)
  ids, 0-9, 10-19…, the same every time. Claim each window with `claimEarnings` or
  `claimCroquettes`.
- `openedCats()` lists every opened cat and who opened it: the only holders that are public.

The croquette economy sits on the same interface: `economy()`, `boxPantry(tokenId)`,
`croqBalance(owner)`, `confidentialBalance()` (a user decryption), `confidentialCroqHandle(owner)`
(the public handle of that sealed balance, new after every move, so a decrypted figure can
be told stale like a cUSDC one with `confidentialUsdcHandle`), `claimCroquettes`
(paid into the boxes, collected from those the caller holds), `feedCroquettes` (the amount
is encrypted in the page), `pantryDay` (today's meals and croquettes eaten, decrypted:
zeros unless the caller holds the cat), `weigh`, `wrap`, `unwrap` (a public decryption of
the amount, then `finalizeUnwrap`), `sendCroquettes`, and `quote` / `trade` against the
public market. See [`docs/CROQ.md`](../../docs/CROQ.md).

The market is a Uniswap V3 pool where one locked position sells CROQ from a start price
up. `quote` asks Uniswap's `QuoterV2` and returns 0 when the swap would move nothing (a
sale before anyone has bought, a buy past the end of the range); `trade` then throws
`reverted` with reason `NoLiquidity` instead of sending, and otherwise swaps through
`SwapRouter02` (`exactInputSingle` in a `multicall` with a 20-minute deadline).
`economy().market` (`MarketInfo`) carries:

- `croqReserve` / `quoteReserve`: the reserves a constant-product pool would price with,
  that is the active range's virtual reserves L/√P and L·√P. Their ratio is the price, and
  price impact reads the same as on a V2 pool. When the pool's price has left the range,
  they are held at its edge, since nothing trades past it;
- `croqHeld` / `quoteHeld`: what the pool actually holds;
- `range`: `{ from, to }` in USDC units per 1,000 CROQ, where CROQ starts and stops selling.

USDC goes in and out the same way: `shieldUsdc(amount)` wraps plain USDC as cUSDC (the
amount is public, the site takes nothing), and `unshieldUsdc(amount)` goes back through the
cUSDC wrapper's `unwrap` (the amount encrypted in the page, a public decryption, then
`finalizeUnwrap`, like a cCROQ unwrap). It returns what was paid out: 0 when the cUSDC
balance did not cover `amount`, and then nothing moves. `quoteUsdc` / `buyUsdc(coinIn,
shield)` buy USDC with the chain's coin through `UsdcRamp`, plain or shielded in the same
transaction. `buyUsdc` and `trade` take `SwapOptions`: `slippageBps`, an integer from 1 to
5000, 100 (1%) when left out, is how far under the quote the swap may land before it
reverts; anything else throws before a transaction. The app's bureau de change
(`apps/web/src/chain/exchange.ts`) chains these calls, one transaction per leg, to reach
any pair.

Where the API's relayer proxy pays Zama (`metered`), `decryptionAllowance()` returns the
wallet's units: `freePerDay`, `freeLeft`, `credits`, `resetsAt`, the credit `price` in
plain USDC and `inputUnits`, what one encrypted input costs (a decrypted value costs one).
Every encryption sends the session's decryption permit as a bearer token, so the input is
charged to this wallet; a mint, a meal or a croquette send checks the allowance first and
fails with `no-credits` before any gas. `buyCredits(n)` buys more. Only the API counts units, so
`decryptionAllowance()` has no chain fallback and never waits: credits this adapter bought and
the API has not indexed yet (a purchase shows once its block is indexed, two confirmations
later) are added on top of the API's count, so the figure is right as soon as `buyCredits`
resolves.

`connect(walletId?, { chooseAccount })`: with `chooseAccount`, a browser extension shows its
account picker again (EIP-2255 `wallet_requestPermissions`) rather than handing back the
account it shared last time; the app's "Use another one" on the release form uses it.

`signTerms(message)` has the connected wallet sign the release form the app shows before
play (a readable EIP-191 message naming the address, the terms version and the SHA-256 of
the English text; free, no transaction), then files it with the API (`POST /v1/terms`) when
one is configured. It returns `SignedTerms`: `account`, `message`, `signature` and
`recorded`, false when only the browser keeps it (no API, or the API did not answer: that
never blocks play). The mock returns a stand-in signature, never recorded.

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

Opening a box, the alive check, an entanglement, a duel and a milestone use a public
decryption instead: the relayer returns the clear values with a KMS proof, and the
adapter sends both back to the contract (`finalize`, `finalizeDuel`,
`announceMilestone`), which verifies the proof before storing anything. Finding one's
boxes and reading a mint's result use the same user decryption as a shake.

## Tests

```bash
pnpm --filter @dno/chain-adapter test            # the mock and the V3 math, no network
pnpm --filter @dno/chain-adapter smoke:sepolia   # every mechanic on the deployed contracts
pnpm --filter @dno/chain-adapter smoke:croq      # welcome bag, meal, buy, wrap, unwrap, transfer, sell
```

The smoke scripts spend testnet ETH (mints, fees, a small market buy) and need
`PRIVATE_KEY` in the repo-root `.env`. `smoke:croq` passed against the Uniswap V2 economy
on 2026-10-01. Both passed in full against the contracts deployed on 2026-10-03 (block
11836238), and a box sent there with three decoys left the sender's holdings.
