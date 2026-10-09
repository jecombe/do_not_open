# @dno/contracts-evm

Hardhat project built on the official Zama template. Its contracts, and a reusable base:

- **`DoNotOpenConfig`** — the game's numbers, read from `packages/game-spec/spec.json`
  at deploy (`lib/specParams.ts`), plus the plaintext rule that turns a revealed seed
  into state, traits and score. Stores the keccak256 of the spec it was built from, and the
  sale's milestones (`milestones()`: the last one is the sale's cap; `giftBoxes()`, what it
  leaves under `maxSupply`, the whitelist's gift boxes). `DoNotOpen` reads its supply, batch
  size and milestones here (`config()`).
- **`ConfidentialERC721`** (`contracts/confidential/`) — the base of a Confidential ERC-721:
  encrypted owners, transfers that never revert on ownership, discovery through the
  holder's own receipts. Any collection can inherit it. See
  [`docs/HIDDEN_OWNERS.md`](../../docs/HIDDEN_OWNERS.md).
- **`DoNotOpen`** — a Confidential ERC-721 and all FHE logic of the boxes. 10,000 boxes: 9,000
  for sale (the last milestone), 1,000 for the whitelist's gifts; who holds them and how many
  were sold are encrypted. Paid in cUSDC. Nobody may read the revenue, the owner included;
  `withdraw` pays it out at most once a week. Every shake passes its encrypted pick and roll
  through the `guard` the owner sets (`setGuard`, an `IShakeGuard`: `RatTricks`), allowed to it
  for the transaction only. `gift(to)` mints one box free for `to`, for the `giver` only
  (`setGiver`: `WhitelistGifts`), out of the boxes the sale leaves (`giftsMinted`,
  `BoxGifted`); no payment, no milestone. `tokenURI` asks the `metadata` contract the owner
  sets (`setMetadata`, an `ITokenURIs`).
- **`BoxMetadata`** — the boxes' token URIs, out of `DoNotOpen` for size: `baseURI` plus the
  token id, the base set by its owner (`setBaseURI`).
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
- **`Rats`** — the depot's rats, an ERC-721 ("DO NOT OPEN Rats", `DNORAT`): owners are
  public, unlike the boxes. Each rat draws an encrypted power at its mint, paid or gifted (one
  `randEuint16` folded into 1, 2 or 3 with the bounds `powerBelow`, from the spec's odds 55/30/15),
  allowed to the minter; `allowPower(id)` lets a later holder read it, `powerReadableBy` says
  who may, `powerOf` returns the handle, and `powerFor` hands it to `tricks` (`setTricks`,
  owner) for one transaction. The constructor takes the caps as `uint256[4]` (seed, model, per
  wallet, gifts) and `powerBelow` as `uint16[2]`. `mintSeed(seed, maxPrice)` adopts the studio's free rat of a 64-bit
  seed, each seed once (1 USDC); `mintModel(job, uri, deadline, signature, maxPrice)` adopts an
  AI rat, each studio job once (3 USDC), on an EIP-712 signature of the `attester` (the API's
  key) naming the caller, once the API has put its picture on Arweave and kept its 3D model (`uri`, an Arweave record of both).
  Plain USDC straight to the treasury; `_mint`, never `_safeMint`. Prices from `studio.json`
  (`lib/ratParams.ts`), changeable by the owner up to 100 USDC, never 0. The supply is capped
  for good at deployment, from `studio.json`: `maxSeedRats` (700) and `maxModelRats` (300),
  `SoldOut` past either, and `maxPerWallet` (5) mints an address, both kinds together
  (`WalletLimit`; `mintedBy` counts mints, not holdings). `seedMinted`, `modelMinted` and
  `mintedBy` are public for the app's counters. `gift(to, seed)` is open to the `giver` only
  (`setGiver`, owner): a free seed rat for `to`, outside both caps and the wallet limit, counted
  in `giftMinted` against `maxGiftRats` (1,000, a constructor argument from `studio.json`).
- **`RatPantry`** — pays each rat `perDay` (3) plain CROQ a day from its mint, to its current
  owner, at most `maxDays` (7) kept between two claims; while it is empty a claim reverts
  (`PantryEmpty`), so no earned day is lost; when it runs low a claim pays what is left. No
  owner, immutable numbers. Funded with `fund` (500,000) CROQ by a plain transfer from the
  treasury.
- **`RatTricks`** — what a rat does with its power. `sniff(ratId, tokenId)`: a paid shake for
  the rat's holder (the fee pulled from them first; `RatTricks` holds nothing at rest), the
  result kept for them in `lastSniff`; a power-1 rat gets `sniffRebate` (30%) back from the
  `rebater`'s cUSDC, selected under encryption. `trick(ratId, tokenId, trait, inputProof)`:
  the rat sits on a sealed box for `trickDuration` (3 days) and then rests `recharge` (7 days,
  `readyAt`, `Recharging`); under encryption, on a box the caller holds it shields it
  (strangers' paid shakes read a fake roll for the blocked traits), on another's it jams it (the
  holder's shakes read `SCRAMBLED`); power 2 blocks the picked trait, 3 all five, 1 nothing, and
  a full shield resists jams. `filter` is `DoNotOpen`'s guard hook and answers `DoNotOpen` only
  (`OnlyBoxes`). A trusted reader of `DoNotOpen`.
- **`FleaMarket`** — the flea market: players sell each other sealed boxes, cats (opened
  boxes) and rats, in cUSDC. The market escrows what it sells: a rat with `transferFrom`,
  listed at once; a box with `confidentialTransferFrom` (a "maybe" transfer), whose "arrived"
  bit is made publicly decryptable and proven by `finalizeListing`, so only a seller who held
  the box gets an active listing. `buy` pulls the public asking price (all-or-nothing) and
  `finalizePurchase` settles on the decrypted "paid" bit: `Done` (fee to the treasury, the rest
  to the seller, item delivered), `Unpaid` (nothing was taken) or `Missed` (sold, cancelled,
  repriced or changed first: refunded in full). `makeOffer` escrows an encrypted amount, capped
  at `MAX_PRICE` under encryption, readable by the buyer and the seller only; `acceptOffer`
  sells at once and the price is never public. A box's public state (status, partner, vet
  check) is snapshotted by `DoNotOpenHooks` at listing; buying and accepting revert
  `StateChanged` if it moved. Fee from the spec's `market` section (`lib/marketParams.ts`,
  250 bps), at most `MAX_FEE_BPS` (1,000) hardcoded; `MAX_PRICE` is 1,000,000 USDC. The owner
  (`Ownable`) can only `setFee` and `setTreasury`, never move an escrowed item. Never writes to
  `DoNotOpen` beyond the transfers its sellers allowed.

- **`WhitelistGifts`** — the whitelist's gifts, collected once per wallet on the frozen list.
  The owner sets a Merkle `root` of (wallet, tier) and `closesAt` with `setRoot` (correctable
  until the first claim); `claim(tier, proof, ratSeed)` sends the wallet an encrypted draw of
  cCROQ in its tier's range (`rem(randEuint16, span) + croqMin`, readable by the wallet only),
  has `DoNotOpen.gift` mint it a box free, and adopts its rat through `Rats.gift` (the app draws
  an unadopted seed at random). `giftOf(account)` returns what it got, the croquettes as a
  handle. `sweep` returns the cCROQ left once `closesAt` passed. Tiers from the spec's
  `whitelist` section (`whitelistParamsFromSpec`, which checks they cover ranks 1 to `places`;
  `milestonesFromSpec` checks the boxes the sale leaves match the box tiers' seats). Never
  writes to `DoNotOpen` beyond `gift`.
- **`SealedVault`** — the sealed vault, a product next to the game: any NFT of a collection the
  owner allows (`setCollection`) goes into a box, a `ConfidentialERC721` of its own ("DO NOT OPEN
  Vault", `SEALED`) whose holder is encrypted. `deposit(collection, tokenId, key, to, really,
  proof)` pulls the NFT (public), stores the box's key, a `euint256` nobody may decrypt, and
  sends the new box on to each of `to` (at most `MAX_DEPOSIT_SENDS`, 5), for real only where the
  encrypted `really` is: decoys, so the depositor is no longer its obvious holder. Taking the NFT out,
  listing it on Seaport, taking the listing down, collecting a sale's ETH, accepting a buyer's
  offer and naming a delegate go through
  `request(boxId, action, to, price, endTime, ref, boundKey, proof)` (`Withdraw`, `List`,
  `Unlist`, `Claim`, `AcceptOffer`, `Delegate`; `ref` an offer's order hash, zero otherwise),
  where `boundKey` is the key XOR `requestHash(...)` of those terms and the box's nonce, so any wallet (the API's relayer) can
  send it; only "the key matched" is made publicly decryptable, and `finalize` (anyone) runs it,
  or settles it `Refused` or `Stale`; the nonce moves on only when the key matched. Requests do
  not lock each other out: a stranger's wrong keys never hold back an exit. A box with a waiting
  request cannot move (`pending`), and `expire` (anyone, a day after `placedAt`) settles a
  request whose proof never came (`Expired`). A
  listing is a Seaport 1.5 order with the vault as offerer, validated on-chain (no signature, no
  ERC-1271), Seaport approved for that token only; `sync` (anyone, and every request) marks it
  sold or expired. `AcceptOffer` (`to` the payout address, `price` the least WETH the offer must
  net) runs only through `finalizeOffer(requestId, cleartexts, proof, offer)` with the order
  (`abi.encode(AdvancedOrder, bytes32[] criteriaProof)`): the vault checks it is the one bound
  (`WrongOrder`), settles a dead one `Stale`, hands `VaultOffers` the box's NFT for one `fill`,
  takes the fee and pays the rest straight to `to`; a fill that only fails now reverts and the
  request waits (plain `finalize` reverts `NeedsOrder`). `Delegate` names one wallet for the NFT
  in delegate.xyz's Registry v2 (`delegateERC721`, every right; zero clears it), cleared when the
  NFT leaves, kept on a transfer. A transfer gives the box a random key; `setKey` sets the holder's (a "maybe").
  `offerSale` / `acceptSale` / `cancelSale` sell a box privately for an encrypted cUSDC price,
  settled under encryption. Fee `feeBps` (250 by default, at most `MAX_FEE_BPS`, 1,000) on both:
  ETH kept in `feesOwed` and sent by `sendFees` (anyone), cUSDC at the sale. `receive` takes ETH
  from Seaport and `VaultOffers` only. The owner (`Ownable`) can only `setCollection`, `setFee` and `setTreasury`.
  `vault/ISeaport.sol` and `vault/IDelegateRegistry.sol` are the slices of Seaport 1.5 and
  delegate.xyz's registry it uses, `vault/IWETH.sol` wrapped ether's. See
  [`docs/VAULT.md`](../../docs/VAULT.md).
- **`VaultOffers`** (`contracts/vault/`) — the vault's helper for buyers' offers, stateless and
  open to anyone, linked to nothing but Seaport and WETH (constructor `(seaport, weth)`). `post`
  validates a buyer's signed Seaport 1.5 offer (WETH for one ERC-721 token, or any token of a
  collection, criteria root 0) on Seaport and logs it, `OfferPosted(collection, tokenId or
  ANY_TOKEN, orderHash, order)`: the on-chain offer board the page reads. `inspect` says whether
  an offer can still fill one token for at least a price; `fill` (`nonReentrant`) fills one
  token's share with the NFT its caller handed it (`fulfillAdvancedOrder`, criteria resolved to
  that token), unwraps the WETH and sends the ETH back. Only WETH offer and fee items, fixed
  amounts, no tips (`NotAnOffer`).
- **`VaultTestNFT`** (`contracts/mocks/`) — test networks only: an ERC-721 anyone mints for free,
  its picture an SVG drawn on-chain, to try the vault with. **`TestWETH`** (`contracts/mocks/`):
  local networks only, WETH as WETH9 does it.

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
| A secret offer on the flea market | `euint64` escrowed in `FleaMarket` | Its buyer and the listing's seller |
| A rat's power | `euint8` in `Rats` | Its minter and whoever held it and asked (`allowPower`) |
| A rat's shield or jam on a box | `euint64` masks, fake rolls and end times in `RatTricks` | Nobody; only selected under encryption |
| A vault box's owner | `eaddress` in `SealedVault` | Nobody; the holder finds their boxes in their own receipts |
| A vault box's key | `euint256` in `SealedVault` | Nobody, the holder included; only compared under encryption |
| A vault request's "key matched" | `ebool` | Everyone, once requested |
| A vault private sale's price, and whether it moved the box | `euint64`, `ebool` in `SealedVault` | Its seller and its buyer |

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
| `shake` / `paidShake` | ~424k / ~899k | ~0.9M / ~2.17M |
| `shake` / `paidShake` through `RatTricks`, on a tricked box | ~554k / ~1.01M | ~1.42M / ~2.84M |
| `feed` | ~502k | ~1.07M |
| `observe` + `finalize` | ~625k + ~291k | ~1.12M |
| `postDuel` (first score) + `finalizeDuel` | ~585k + ~139k | ~1.47M |
| `acceptDuel` (first score) + `finalizeDuel` | ~1.12M + ~177k | ~2.77M |
| `Pantry.feed` | ~1.20M | ~3.68M |
| `Pantry.claim`, 10 boxes | | ~14.8M |
| `FleaMarket.list` (box) + `finalizeListing` | ~341k + ~94k | ~200k |
| `FleaMarket.list` (rat) | ~139k | 0 |
| `FleaMarket.buy` + `finalizePurchase` (box) | ~546k + ~855k | ~0.71M + ~1.37M |
| `FleaMarket.makeOffer` | ~543k | ~0.74M |
| `FleaMarket.acceptOffer` (rat) | ~677k | ~2.41M |
| `WhitelistGifts.claim`, first class (croquettes, a free box, rat and its power) | ~1.01M | ~1.68M |
| `WhitelistGifts.claim`, economy (croquettes, rat and its power) | ~740k | ~1.57M |
| `RatTricks.trick` (first on a box / box already tricked) | ~1.06M / ~881k | ~2.27M / ~2.25M |
| `RatTricks.sniff` (tricked box, power-1 rebate) | ~1.79M | ~4.27M |
| `SealedVault.deposit` (no decoy / each decoy more / 5 decoys) | ~450k to ~470k / ~230k / ~1.54M | ~83k / ~363k / ~1.90M (depth ~1.23M) |
| `SealedVault.request` + `finalize` (withdraw / list / unlist / claim) | ~323k + ~152k / ~349k + ~317k / ~321k + ~153k / ~309k + ~122k | ~191k |
| `SealedVault.request` + `finalize`, a wrong key (`Refused`) | ~326k + ~101k | ~191k |
| `SealedVault.request` (any action) | ~289k to ~375k | ~191k |
| `SealedVault.finalizeOffer` (one WETH offer filled, a fee paid, ETH sent) | ~399k | 0 |
| `SealedVault.finalize`, delegate (first / replacing one) | ~294k / ~269k | 0 |
| `SealedVault.finalize`, withdraw with a delegate to clear | ~168k | 0 |
| `VaultOffers.post` (a buyer's offer validated and logged) | ~102k | 0 |
| `SealedVault.sync` (sold / expired) | ~92k / ~51k | 0 |
| `SealedVault.expire` | ~56k | 0 |
| `SealedVault.confidentialTransfer` (with a new random key) | ~209k to ~266k | ~338k |
| `SealedVault.setKey` | ~185k | ~225k |
| `SealedVault.offerSale` | ~304k to ~324k | ~150k |
| `SealedVault.acceptSale` | ~1.66M | ~4.34M |

`LiquidityLocker` has no FHE; it took 558,565 gas to deploy on Sepolia.
`Rats` and `RatPantry` have no FHE: `mintSeed` ~248k gas (~163k after the first), `mintModel`
~190k, `RatPantry.claim` ~90k for one rat (~103k for two); ~2.30M and ~554k to deploy (Hardhat).
`StudioPacks` has no FHE either: `buy` takes ~115k gas the first time (~63k after), and the
contract ~641k to deploy (Hardhat).
The `SealedVault` rows are not in `test/Costs.ts` yet: gas from `REPORT_GAS=1 pnpm test
test/SealedVault.ts`, HCU from `fhevm.computeTransactionHCU` on the same calls, against Seaport
1.5's and delegate.xyz's bytecode. A buyer's Seaport `fulfillOrder` of a vault listing takes
~97k gas; the vault ~5.5M to deploy, `VaultOffers` ~1.9M.

Deployed size: `DoNotOpen` 24,442 bytes (limit 24,576; the token URIs live in `BoxMetadata`, 1,861, and the rules' views in `DoNotOpenConfig`, 2,968), `WhitelistGifts` 4,876, `Rats` 12,191 (with the encrypted powers), `RatTricks` 8,265, `Pantry` about 14,000, `FleaMarket`
12,377, `SealedVault` 24,322 (254 under the limit, at the default optimizer: the next feature
moves logic out first, as accepting offers did into `VaultOffers`, 6,517). To stay under
the limit, `DoNotOpen` alone is compiled with the optimizer at 1 run, for size (a per-file
override in `hardhat.config.ts`; every other contract runs at 200), and `onlySealed` calls
`_requireSealed` rather than inlining its check.

## Commands

```bash
pnpm compile
pnpm test                 # 285 tests on the local FHEVM mock: the standard, the boxes, the Pantry, the ramp, the credits, the studio packs, the rats, the locker, the flea market, the sealed vault (against Seaport 1.5's and delegate.xyz's bytecode)

# Local walkthrough
pnpm chain                # terminal 1
pnpm deploy:localhost     # terminal 2
pnpm demo:localhost       # buy a hidden box, shake twice, prove alive, observe
pnpm demo2:localhost      # mint 3, feed, duel, entangle, observe one and see both open
npx hardhat --network localhost dno:vault-demo   # the sealed vault: seal, list on Seaport, buy, collect, take out, delegate, accept an offer

# Sepolia (fill MNEMONIC or PRIVATE_KEY in the repo-root .env first)
pnpm deploy:sepolia
pnpm demo:sepolia
pnpm demo2:sepolia
pnpm test:sepolia         # optional integration test, spends a little Sepolia ETH
pnpm verify:sepolia
```

When Sepolia's fees are far below a wallet's default tip (about 0.001 gwei in October 2026,
against a default of 1 to 1.5 gwei), a deploy can ask for more ETH than the deployer holds.
`SEPOLIA_GAS_PRICE` (wei, in `.env`) pins the gas price of every transaction the scripts send
through Hardhat's provider, and `hardhat deploy --maxfee` / `--priorityfee` the deploy's own:
`SEPOLIA_GAS_PRICE=20000000 pnpm exec hardhat deploy --network sepolia --maxfee 300000000
--priorityfee 2000000`, then `pnpm export:sepolia`. A public RPC's nonce lag can stop a run
midway; running it again resumes it, since every step checks what is already done (but a
`Pantry` deployed in an interrupted run is not funded again: `Pantry.fund` it by hand).

`pnpm deploy:<net>` runs three scripts. `deploy/deploy.ts` deploys the config (with the spec's
milestones), `DoNotOpen` and `BoxMetadata` (base URI `BOXES_BASE_URI`, by default
`https://api.do-not-open.app/metadata/`, set on the collection with `setMetadata`, or the call
printed when the collection owner is another key), paid in Zama's USDCMock / cUSDCMock on Sepolia and
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
`deploy/market.ts` deploys `FleaMarket` with the spec's fee, paying the treasury
(`STUDIO_TREASURY`, or the collection's owner), owned by `COLLECTION_OWNER` (or the deployer).
It only looks up `DoNotOpen`, `DoNotOpenHooks` and `Rats`, never redeploys them, and runs after
every other script (`runAtTheEnd`), so `npx hardhat deploy --network sepolia --tags Market` (or
`pnpm --filter @dno/contracts-evm exec hardhat deploy --network sepolia --tags Market` from the
root) adds the market next to a live collection; `pnpm export:sepolia` then writes it under
`market` in `sepolia.json`. On Sepolia since 2026-10-07: `0x4E9fC2Cb042d7Bd49B559Ad3e1110c200d7081C1` (the first one, 2026-10-05: `0xb5c799bF626e70DcE6804BDef06199661cDc8665`). To sell, a player makes the
market their operator on the boxes (`setOperator(market, until)`) or approves it on the rats
(`setApprovalForAll`); to buy or offer, their cUSDC operator. The adapter does both when
needed (a year for the boxes).

`deploy/whitelist.ts` deploys `WhitelistGifts` with the spec's tiers, owned by
`COLLECTION_OWNER` (or the deployer), makes it the `giver` of `DoNotOpen` and of `Rats` (or prints
the calls), and funds it with the most the tiers can draw (425,000 cCROQ, wrapped from the
deployer's CROQ when it holds them). The boxes and the rats cost nothing: both are minted free.
It runs after `rats.ts`. When the list closes, save
the API's `GET /v1/allowlist/gifts?token=` answer and run
`npx hardhat --network <net> dno:whitelist-root --tree <file>`: it checks the tree, sets the root
with `closesAt` `claimDays` (30) from now, and the same file goes to the API
(`WHITELIST_GIFTS_TREE`). `dno:export` writes the contract under `whitelistGifts`.

`deploy/vault.ts` (tag `Vault`) deploys `VaultOffers` (Seaport and the network's WETH: `WETH` in
the script, OpenSea's, `0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9` on Sepolia; a `TestWETH`
locally), then `SealedVault` against Seaport 1.5
(`0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC`, OpenSea's deployment on Sepolia and mainnet; 1.6
is not on Sepolia), `VaultOffers`, delegate.xyz's Registry v2
(`0x00000000000000447e69651d841bD8D104Bed493`) and the network's cUSDC, with `VAULT_FEE_BPS` (250) paid to
`STUDIO_TREASURY` (or the owner), owned by `COLLECTION_OWNER` (or the deployer). On a test network
it also deploys `VaultTestNFT` and allows it. On a local node (`pnpm chain`) it first puts
Seaport's Sepolia runtime code at its address (`test/fixtures/seaport-1.5.json`, with storage
slot 0, the reentrancy guard, set to 1), and the registry's
(`test/fixtures/delegate-registry-v2.json`); elsewhere it stops if either is missing. It runs at the
end and redeploys nothing else (locally it reuses the test cUSDC of `deploy.ts`), so `npx hardhat deploy --network sepolia --tags Vault` adds it next to
a live collection; `dno:export` writes it under `vault` (address, ABI, deploy block, Seaport,
`offers` with its ABI and deploy block, WETH, the registry, the allowed collections). `npx hardhat --network <localhost|sepolia> dno:vault-demo` runs it end
to end; its fresh addresses are the kept test wallets `vault-proceeds`, `vault-withdrawals` and
`vault-delegate`. On Sepolia it stops at the first `finalize` while Zama's gateway answers
"ciphertext not ready"; the whole run (offer and delegation included) passes on a local node.

`deploy/tricks.ts` (tag `Tricks`) deploys `RatTricks` with the paid shake's fee, the spec's
rebate (30%), trick and rest days (`studio.json` `rats.powers`, `lib/ratParams.ts`), then makes it
`DoNotOpen`'s guard (`setGuard`) and trusted reader, and the rats' `tricks` (`setTricks`), or
prints each call for an owner who is not the deployer. Rebates come from `TRICKS_REBATER` (or the
collection's owner), once it made `RatTricks` its cUSDC operator: on a test network the deployer
does so and wraps 1,000 test USDC for them. `dno:export` writes it under `ratTricks`.

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
milestone has `announceMilestone`. `FleaMarket` follows the same shape with
`finalizeListing` ("the box arrived") and `finalizePurchase` ("the buyer paid"), and
`SealedVault` with `request` and `finalize` ("the key matched"; `finalizeOffer`, with the order, for an accepted offer). The CLI tasks and the app do both steps in one go. A
request whose second step was never sent stays pending; anyone can finish it.
