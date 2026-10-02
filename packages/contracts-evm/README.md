# @dno/contracts-evm

Hardhat project built on the official Zama template. Six contracts, and a reusable base:

- **`DoNotOpenConfig`** — the game's numbers, read from `packages/game-spec/spec.json`
  at deploy (`lib/specParams.ts`), plus the plaintext rule that turns a revealed seed
  into state, traits and score. Stores the keccak256 of the spec it was built from.
- **`ConfidentialERC721`** (`contracts/confidential/`) — the base of a Confidential ERC-721:
  encrypted owners, transfers that never revert on ownership, discovery through the
  holder's own receipts. Any collection can inherit it. See
  [`docs/HIDDEN_OWNERS.md`](../../docs/HIDDEN_OWNERS.md).
- **`DoNotOpen`** — a Confidential ERC-721 and all FHE logic of the boxes. 10,000 boxes; who
  holds them and how many were sold are encrypted. Paid in cUSDC.
- **`UsdcRamp`** — ETH in, USDC or cUSDC out, through a public pool, for a small fee.
- **`Croq`** — CROQ, a plain ERC-20 with 0 decimals. 20,000,000 minted once in the
  constructor; no mint function, no owner.
- **`ConfidentialCroq`** — cCROQ, OpenZeppelin's `ERC7984ERC20Wrapper` around CROQ,
  unmodified. Encrypted balances and transfer amounts, 1:1 with CROQ.
- **`Pantry`** — the croquette economy: welcome bags, the daily purr, meals into
  encrypted weights, the weigh-in. Reads `DoNotOpen` (as a trusted reader of who holds a box),
  never writes to it. Parameters from the spec's `economy` section (`pantryParamsFromSpec()`).

The economy is specified in [`docs/CROQ.md`](../../docs/CROQ.md).

## What is encrypted

| Per box            | Storage                          | Who can read it                            |
| ------------------ | -------------------------------- | ------------------------------------------ |
| Owner              | `eaddress`                       | Nobody; the holder finds their boxes in their own receipts |
| Seed               | `euint64`                        | Nobody until an opening is finalized       |
| Affection          | `euint32`, exists once fed       | Nobody until an opening is finalized       |
| Rarity score       | `euint16`, cached at its first duel | Nobody; only compared under encryption     |
| Paid-shake earnings | `euint64`                       | Nobody; paid to whoever holds the box when claimed |
| A shake result     | two fresh `euint8` per viewer    | The viewer who shook, nobody else          |
| A transfer receipt | `ebool` "moved"                  | Its sender and recipient                   |
| A request, a duel posting or outcome | `ebool`s and values masked by "the caller holds it" | Everyone, once requested |
| Boxes sold         | `euint16`                        | Nobody; milestones only                    |
| Status, badge, revealed contents, opener | plain storage, events | Everyone                       |
| Weight, today's meals, stash | `euint64`/`euint8` in the Pantry | Nobody (the holder reads today's meals) |

## Cost per function

Measured on the FHEVM mock (`REPORT_COSTS=1 pnpm test test/Costs.ts`). The protocol allows
20,000,000 HCU per transaction (5,000,000 sequential depth). The full table, with what each
number means in dollars, is in [`docs/HIDDEN_OWNERS.md`](../../docs/HIDDEN_OWNERS.md#7-cost).

| Function | Gas | HCU |
| --- | --- | --- |
| `mint`, 1 box among 10 ids | ~2.6M | ~3.3M |
| `mint`, 1 box among 1 id | ~1.0M | ~1.9M |
| `confidentialTransfer` | ~184k | ~200k |
| `shake` / `paidShake` | ~421k / ~889k | ~0.9M / ~2.0M |
| `feed` | ~530k | ~1.07M |
| `observe` + `finalize` | ~698k + ~223k | ~1.12M |
| `postDuel` (first score) + `finalizeDuel` | ~585k + ~139k | ~1.47M |
| `acceptDuel` (first score) + `finalizeDuel` | ~1.12M + ~177k | ~2.77M |
| `Pantry.feed` | ~1.23M | ~3.68M |
| `Pantry.claim`, 10 boxes | | ~13M |

Deployed size: `DoNotOpen` 24,454 bytes (limit 24,576), `Pantry` about 14,000. To stay under
the limit, the optimizer runs at 200 (`hardhat.config.ts`), and `onlySealed` calls
`_requireSealed` rather than inlining its check.

## Commands

```bash
pnpm compile
pnpm test                 # 99 tests on the local FHEVM mock: the standard, the boxes, the Pantry, the ramp

# Local walkthrough
pnpm chain                # terminal 1
pnpm deploy:localhost     # terminal 2
pnpm demo:localhost       # buy a hidden box, shake twice, prove alive, observe
pnpm demo2:localhost      # mint 3, feed, duel, entangle, observe one and see both open

# Sepolia (fill MNEMONIC or PRIVATE_KEY in the repo-root .env first)
pnpm deploy:sepolia
pnpm demo:sepolia
pnpm demo2:sepolia
pnpm test:sepolia         # optional integration test, spends a little Sepolia ETH
pnpm verify:sepolia
```

`pnpm deploy:<net>` runs three scripts. `deploy/deploy.ts` deploys the config and
`DoNotOpen` (with the spec's milestones), paid in Zama's USDCMock / cUSDCMock on Sepolia and
in local test tokens elsewhere. `deploy/economy.ts` then deploys `Croq`, `ConfidentialCroq`
and `Pantry`, makes the Pantry a trusted reader of `DoNotOpen` (or prints the call when the
collection owner is another key), approves and calls `Pantry.fund` with the game reserve
plus the welcome bags (11M), and, on a network listed in `UNISWAP_V2` (Sepolia), opens a
CROQ/USDC pool with the 4M liquidity share and `LIQUIDITY_USDC` USDC (default 4,000). The
LP tokens are sent to `0x…dEaD`, so that liquidity is locked for good. The rest of the
supply (the treasury) stays with the deployer, or goes to `COLLECTION_OWNER` if it is set.
`deploy/ramp.ts` deploys the `UsdcRamp`. `deploy/credits.ts` deploys `DecryptionCredits`,
priced at `CREDIT_PRICE_USDC`, or Zama's dollar price for one decryption (`ZAMA_DECRYPT_USD`)
times `CREDIT_MARGIN` (2), rounded up (`lib/creditPrice.ts`): a credit follows Zama's dollar
price, never $ZAMA's market price. Change it later without redeploying:
`npx hardhat --network <net> dno:credit-price --zama 0.001 --margin 2` (or `--usdc 0.002`;
no argument prints the current price).
`CROQ_CONTRACT_URI` sets cCROQ's contract URI (default empty).

`Pantry.fund` calls FHE, so the economy script fails on the bare in-process `hardhat`
network. Use `pnpm chain` + `pnpm deploy:localhost`, which runs the FHEVM mock.

`pnpm export:sepolia` (run by `deploy:sepolia`) writes
`packages/chain-adapter/src/evm/deployments/sepolia.json` (the box contract) and
`sepolia-economy.json` (CROQ, cCROQ, Pantry addresses and ABIs, and the market: pair,
router, factory, USDC).

Single steps: `npx hardhat --network <net> dno:mint --quantity <n> --ids <n>`,
`dno:shake|dno:feed|dno:paid-shake|dno:prove-alive|dno:observe|dno:status --token <id>`,
`dno:entangle --a <id> --b <id>`, `dno:duel --a <id> --b <id>`.

## Two-step public decryption

What must become public goes through a request. The first transaction computes the
encrypted answers (for an opening: "the caller holds the box and paid", the seed and the
affection masked by it) and marks them publicly decryptable. The cleartexts come back in a
second transaction that anyone can send:

```
holder   -> observe(tokenId)                         RequestPlaced(requestId, tokenId, holder, Open)
anyone   -> relayer.publicDecrypt(requestInfo(requestId).handles)  => cleartexts + KMS proof   (off-chain)
anyone   -> finalize(requestId, cleartexts, proof)
            the handles are the ones stored at the request,
            FHE.checkSignatures(...) reverts on any mismatch,
            "holds" true: Revealed and Observed(tokenId, holder, ...); false: Refused, nothing happens
```

Alive checks and entanglements work the same way. Duels have their own `finalizeDuel`, run
twice: once on "the challenger holds A" after `postDuel`, which puts the box on the duel
shelf for 7 days or voids the duel, and once on the outcome after `acceptDuel`, which
resolves it, voids it (A no longer held) or puts it back on the shelf (B not held). A
milestone has `announceMilestone`. The CLI tasks and the app do both steps in one go. A
request whose second step was never sent stays pending; anyone can finish it.
