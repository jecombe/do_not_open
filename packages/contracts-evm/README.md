# @dno/contracts-evm

Hardhat project built on the official Zama template. Ten contracts, and a reusable base:

- **`DoNotOpenConfig`** — the game's numbers, read from `packages/game-spec/spec.json`
  at deploy (`lib/specParams.ts`), plus the plaintext rule that turns a revealed seed
  into state, traits and score. Stores the keccak256 of the spec it was built from.
- **`ConfidentialERC721`** (`contracts/confidential/`) — the base of a Confidential ERC-721:
  encrypted owners, transfers that never revert on ownership, discovery through the
  holder's own receipts. Any collection can inherit it. See
  [`docs/HIDDEN_OWNERS.md`](../../docs/HIDDEN_OWNERS.md).
- **`DoNotOpen`** — a Confidential ERC-721 and all FHE logic of the boxes. 10,000 boxes; who
  holds them and how many were sold are encrypted. Paid in cUSDC. Nobody may read the
  revenue, the owner included; `withdraw` pays it out at most once a week.
- **`UsdcRamp`** — ETH in, USDC or cUSDC out, through a public pool, for a small fee.
- **`Croq`** — CROQ, a plain ERC-20 with 0 decimals. 20,000,000 minted once in the
  constructor; no mint function, no owner.
- **`ConfidentialCroq`** — cCROQ, OpenZeppelin's `ERC7984ERC20Wrapper` around CROQ,
  unmodified. Encrypted balances and transfer amounts, 1:1 with CROQ.
- **`Pantry`** — the croquette economy: welcome bags, the daily purr, meals into
  encrypted weights, the weigh-in. Reads `DoNotOpen` (as a trusted reader of who holds a box,
  and of which ids nobody holds: those get no bag or purr), never writes to it. The
  treasury's share of each meal is readable by nobody and `collect` runs at most once a week. Parameters from the spec's `economy` section (`pantryParamsFromSpec()`).
- **`LiquidityLocker`** — holds the CROQ market's Uniswap V3 position for good. No function
  removes liquidity or moves a position out; anyone can `collect(positionId)`, which sends
  the trading fees to the beneficiary (the treasury); the owner (`Ownable2Step`) can only
  change the beneficiary. It takes NFTs from the position manager only. Tests in
  `test/LiquidityLocker.ts` run against Uniswap's own V3 bytecode
  (`@uniswap/v3-core`, `@uniswap/v3-periphery`, dev dependencies) deployed in Hardhat.
- **`StudioPacks`** — the studio's packs, sold in plain USDC before any AI generation: so many
  sketches (cartoon pictures of rats) and 3D models for a fixed price, paid straight to the treasury.
  No FHE, and unrelated to the collection: it never reads or writes `DoNotOpen`. The backend
  reads `PackBought` and spends the units off-chain. Packs from
  `packages/game-spec/studio.json` (`lib/studioPacks.ts`, which refuses a pack priced under
  `minMargin` times its estimated cost); the owner can change one with `setPack`, up to 100 USDC.
- **`Rats`** — the depot's rats, a plain ERC-721 ("DO NOT OPEN Rats", `DNORAT`): owners are
  public, unlike the boxes. `mintSeed(seed, maxPrice)` adopts the studio's free rat of a 64-bit
  seed, each seed once (1 USDC); `mintModel(job, uri, deadline, signature, maxPrice)` adopts an
  AI rat, each studio job once (3 USDC), on an EIP-712 signature of the `attester` (the API's
  key) naming the caller, once the API has put its picture on Arweave and kept its 3D model (`uri`, an Arweave record of both).
  Plain USDC straight to the treasury; `_mint`, never `_safeMint`. Prices from `studio.json`
  (`lib/ratParams.ts`), changeable by the owner up to 100 USDC, never 0. The supply is capped
  for good at deployment, from `studio.json`: `maxSeedRats` (700) and `maxModelRats` (300),
  `SoldOut` past either, and `maxPerWallet` (5) mints an address, both kinds together
  (`WalletLimit`; `mintedBy` counts mints, not holdings). `seedMinted`, `modelMinted` and
  `mintedBy` are public for the app's counters.
- **`RatPantry`** — pays each rat `perDay` (3) plain CROQ a day from its mint, to its current
  owner, at most `maxDays` (7) kept between two claims; while it is empty a claim reverts
  (`PantryEmpty`), so no earned day is lost; when it runs low a claim pays what is left. No
  owner, immutable numbers. Funded with `fund` (500,000) CROQ by a plain transfer from the
  treasury.

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
| `confidentialTransferIf` (a decoy, or the real one sent among decoys) | ~278k | ~225k |
| `shake` / `paidShake` | ~421k / ~896k | ~0.9M / ~2.17M |
| `feed` | ~502k | ~1.07M |
| `observe` + `finalize` | ~625k + ~291k | ~1.12M |
| `postDuel` (first score) + `finalizeDuel` | ~585k + ~139k | ~1.47M |
| `acceptDuel` (first score) + `finalizeDuel` | ~1.12M + ~177k | ~2.77M |
| `Pantry.feed` | ~1.20M | ~3.68M |
| `Pantry.claim`, 10 boxes | | ~14.8M |

`LiquidityLocker` has no FHE; it took 558,565 gas to deploy on Sepolia.
`Rats` and `RatPantry` have no FHE: `mintSeed` ~248k gas (~163k after the first), `mintModel`
~190k, `RatPantry.claim` ~90k for one rat (~103k for two); ~2.30M and ~554k to deploy (Hardhat).
`StudioPacks` has no FHE either: `buy` takes ~115k gas the first time (~63k after), and the
contract ~641k to deploy (Hardhat).

Deployed size: `DoNotOpen` 24,512 bytes (limit 24,576), `Pantry` about 14,000. To stay under
the limit, `DoNotOpen` alone is compiled with the optimizer at 1 run, for size (a per-file
override in `hardhat.config.ts`; every other contract runs at 200), and `onlySealed` calls
`_requireSealed` rather than inlining its check.

## Commands

```bash
pnpm compile
pnpm test                 # 162 tests on the local FHEVM mock: the standard, the boxes, the Pantry, the ramp, the credits, the studio packs, the rats, the locker

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
plus the welcome bags (11M), and, on a network listed in `UNISWAP_V3` (Sepolia), opens the
CROQ/USDC market with **CROQ only**: it deploys `LiquidityLocker`, then
`lib/uniswapV3.ts` lays out a single-sided position (`planSingleSided`) from
`LIQUIDITY_START_PRICE` USDC per CROQ (default 0.001, rounded up to a usable tick) up to
`LIQUIDITY_RANGE` times that (default 1000), at the `LIQUIDITY_FEE` tier (default 10000,
1%), opens the pool at the range's edge, mints the 4M liquidity share with 0 USDC and
hands the position to the locker (`seedSingleSided`). It stops if someone opened the pool
first at another price. The script checks that the position manager, `SwapRouter02` and
`QuoterV2` belong to the expected factory. The rest of the supply (the treasury) stays
with the deployer, or goes to `COLLECTION_OWNER` if it is set. `COLLECTION_OWNER` also
sets the collection's and the locker's owner: leave it unset and a redeploy uses the
deployer, which is a constructor change, so hardhat-deploy redeploys `DoNotOpen` too.
`deploy/ramp.ts` deploys the `UsdcRamp`. `deploy/credits.ts` deploys `DecryptionCredits`,
priced at `CREDIT_PRICE_USDC`, or Zama's dollar price for one decryption (`ZAMA_DECRYPT_USD`)
times `CREDIT_MARGIN` (2), rounded up (`lib/creditPrice.ts`): a credit follows Zama's dollar
price, never $ZAMA's market price. Change it later without redeploying:
`npx hardhat --network <net> dno:credit-price --zama 0.001 --margin 2` (or `--usdc 0.002`;
no argument prints the current price).
`deploy/studio.ts` deploys `StudioPacks` with the packs of `studio.json`, paying the treasury
(`STUDIO_TREASURY`, or the collection's owner). `dno:export` writes it under `studio` in the
network's deployment file.
`deploy/rats.ts` deploys `Rats` and `RatPantry` (attester `RATS_ATTESTER`, metadata at
`RATS_BASE_URI`, default `https://api.do-not-open.app/rats/`) and funds the pantry up to the
spec's `fund` from whichever key holds the CROQ: the deployer, or the treasury's key in
`TREASURY_PRIVATE_KEY`; when neither does, it deploys the pantry empty and prints the amount to
send (claims revert until then, so no earned day is lost). In a full deploy it always can:
`economy.ts` hands the treasury to `COLLECTION_OWNER` less the pantry's `fund`, which it keeps
with the deployer for `rats.ts`, so one `pnpm deploy:<net>` funds the pantry whoever the owner is. It lists
no dependency, so `npx hardhat deploy --network sepolia --tags Rats` deploys the rats alone.
`CROQ_CONTRACT_URI` sets cCROQ's contract URI (default empty).

`Pantry.fund` calls FHE, so the economy script fails on the bare in-process `hardhat`
network. Use `pnpm chain` + `pnpm deploy:localhost`, which runs the FHEVM mock.

`pnpm export:sepolia` (run by `deploy:sepolia`) writes
`packages/chain-adapter/src/evm/deployments/sepolia.json` (the box contract) and
`sepolia-economy.json` (CROQ, cCROQ, Pantry addresses and ABIs, and the market: the V3
pool, its fee, the locked position's id and ticks, the locker, the position manager,
`SwapRouter02`, `QuoterV2` and USDC).

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
