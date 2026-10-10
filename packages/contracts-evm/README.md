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
  listing is a Seaport order with the vault as offerer, written by `VaultListings` (`prepare`:
  the way OpenSea shows a contract's listing, the vault's share `net` first, then the
  collection's fees), validated on-chain by the vault itself (no signature, no ERC-1271;
  `SeaportRefused` if Seaport reverts), the listings' operator (OpenSea's conduit, or Seaport)
  approved for that token only; `Listing {boxId, price, net, endTime, orderHash}`; `sync`
  (anyone, and every request) marks it sold (the fee on `net`) or expired. `AcceptOffer` (`to` the payout address, `price` the least WETH the offer must
  net) runs only through `finalizeOffer(requestId, cleartexts, proof, offer)` with the order
  (`abi.encode(AdvancedOrder, bytes32[] criteriaProof)`): the vault checks it is the one bound
  (`WrongOrder`), settles a dead one `Stale`, sends Seaport the fill `VaultOffers.fillCall`
  writes (Seaport approved for that token and the order's WETH fee alone; the vault is the
  caller, as OpenSea signs a fill for the NFT's holder), unwraps the WETH,
  takes the fee and pays the rest straight to `to`; a fill that only fails now reverts and the
  request waits (plain `finalize` reverts `NeedsOrder`). `Delegate` names one wallet for the NFT
  in delegate.xyz's Registry v2 (`delegateERC721`, every right; zero clears it), cleared when the
  NFT leaves, kept on a transfer. A transfer gives the box a random key; `setKey` sets the holder's (a "maybe").
  `offerSale` / `acceptSale` / `cancelSale` sell a box privately for an encrypted cUSDC price,
  settled under encryption. Fee `feeBps` (250 by default, at most `MAX_FEE_BPS`, 1,000) on both:
  ETH kept in `feesOwed` and sent by `sendFees` (anyone), cUSDC at the sale. `receive` takes ETH
  from Seaport and `VaultOffers` only. The owner (`Ownable`) can only `setCollection`, `setFee` and `setTreasury`.
  Constructor `(listings, cUsdc, offers, registry, treasury, owner, feeBps)`; its Seaport is
  `listings.seaport()`. `vault/ISeaport.sol` and `vault/IDelegateRegistry.sol` are the slices
  of Seaport (1.5 and 1.6, the same calls, `information` included) and delegate.xyz's registry
  it uses, `vault/IWETH.sol` wrapped ether's. See [`docs/VAULT.md`](../../docs/VAULT.md).
- **`VaultListings`** (`contracts/vault/`) — writes the vault's Seaport listings the way OpenSea
  shows a contract's listing, and keeps them (constructor `(seaport, zone, conduitKey, conduit,
  owner)`: OpenSea's signed zone and conduit on mainnet, the conduit alone on Sepolia, neither
  locally; `operator` is the conduit, or Seaport without one). `prepare(collection, tokenId,
  price, endTime)` writes an order whose offerer is its caller (the NFT on offer; the caller's
  share first, then one ETH item per fee of the collection; `FULL_RESTRICTED` with a zone,
  `FULL_OPEN` without; salt `keccak256(this, listingCount++)`), keeps it by order hash and
  returns the `validate` calldata, the order hash and `net`; `cancelCall(orderHash)` returns the
  `cancel` calldata; `orderOf(orderHash)` the order as a buyer passes it to `fulfillOrder`;
  `listingOf`, `feesOf`. Only the offerer can put the order on Seaport, so a stranger's
  `prepare` lists nothing. `setFees(collection, Fee[]{recipient, bps})` (`onlyOwner`, no zero
  recipient, at most `MAX_FEES_BPS`, 15%, together): what OpenSea asks for the collection (its
  1%, the creator's enforced fee); a listing keeps the fees it was made with. `lib/opensea.ts`
  (`listingVenue(network)`) holds the addresses per network. 6,336 bytes; ~1.45M gas to deploy.
- **`VaultOffers`** (`contracts/vault/`) — the vault's helper for buyers' offers, stateless and
  open to anyone, linked to nothing but Seaport and WETH (constructor `(seaport, weth)`; the
  same Seaport as the listings, 1.6 on Sepolia and mainnet). `post` validates a buyer's signed
  offer for the Seaport it is on (WETH for one ERC-721 token, or any token of a collection,
  criteria root 0) and logs it, `OfferPosted(collection, tokenId or
  ANY_TOKEN, orderHash, order)`: the on-chain offer board the page reads. `inspect` says whether
  an offer can still fill one token for at least a price; `fill` (`nonReentrant`) fills one
  token's share with the NFT its caller handed it (`fulfillAdvancedOrder`, criteria resolved to
  that token), unwraps the WETH and sends the ETH back; `fillCall(offer, collection, tokenId,
  recipient)` writes that `fulfillAdvancedOrder` call and the WETH fee for the NFT's holder to
  send itself, which is what the vault does (OpenSea's signed zone signs a fill for the address
  that holds the NFT, and Seaport's caller must be that address). Only WETH offer and fee items,
  fixed amounts, no tips (`NotAnOffer`). OpenSea's own offers (its zone, its conduit, its 1%
  WETH fee) fill this way unchanged: `dno:opensea-replay` replays a real mainnet fill the
  vault's way (below). 8,909 bytes.
- **`SealedPockets`** — the vault's pockets: cUSDC held under encrypted 256-bit keys rather than
  addresses (constructor `(cUsdc, owner)`). `open(key, proof, viewer)`; `deposit(pockets[],
  target, amount, proof)` pulls the caller's cUSDC into the pocket of the set whose number is the
  encrypted target (the rest refunded); `send(from[], to[], input)` and `withdraw(from[], to,
  input)` take a `SpendInput` (amount and target under one proof, the key XOR `spendHash(...)`
  under another) and move `select(key matches and balance covers, amount, 0)`, with no
  decryption. Sets of 1 to 5 pockets, increasing; a bound key's handle is `spent` once. `desk`
  (set once by the owner) may `deskCheck`, `deskTake` and `deskGive`. The same contract also
  holds Zama's other confidential tokens, one instance each and no desk (`SealedPockets_cUSDT`,
  `_cWETH`, `_cZAMA` on Sepolia, from `lib/pocketTokens.ts`). See
  [`docs/VAULT.md`](../../docs/VAULT.md#pockets).
- **`PocketDesk`** (`contracts/vault/`) — buys the vault's private sales out of pockets
  (constructor `(pockets, vault)`; it makes the vault its cUSDC operator). The seller offers a
  box to the desk and `reserve(saleId, pocket)`s it; the buyer `ask`s (the key and the balance
  checked under encryption, one bit made public), then `buy(askId, cleartexts, proof, boxKey,
  boxKeyProof)`: the price taken from the pocket, `acceptSale` on the vault, any refund handed
  back. Holds the boxes it bought (`ownerOf(box)`, encrypted pocket + 1), never sells.
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
| A pocket's key | `euint256` in `SealedPockets` | Nobody; only compared under encryption |
| A pocket's balance, and what a spend moved | `euint64` in `SealedPockets` | The pocket's viewer |
| A desk purchase's "ok" | `ebool` in `PocketDesk` | Everyone, once asked |
| Which pocket holds a box the desk bought | `euint32` in `PocketDesk` | The viewers of the pockets that bought it |

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
| `SealedVault.request` (any action) | ~291k to ~379k | ~191k |
| `SealedVault.finalize` (a wrong key the least, a listing the most: since `VaultListings` one more contract call and the conduit's approval, one order item more per fee) | ~101k to ~606k | 0 |
| `SealedVault.finalizeOffer` (one WETH offer filled by the vault itself, a fee paid, ETH sent; the most through OpenSea's zone and conduit) | ~145k to ~400k | 0 |
| `VaultListings.setFees` (the owner, per collection) | ~40k to ~98k | 0 |
| `VaultOffers.post` (a buyer's offer validated and logged) | ~101k | 0 |
| `SealedVault.sync` (expired / sold) | ~51k to ~113k | 0 |
| `SealedVault.expire` | ~56k | 0 |
| `SealedPockets.open` | ~280k to ~317k | 32 |
| `SealedPockets.deposit` (set of 1 / 3 / 5) | ~835k / ~1.03M / ~1.24M | ~1.63M / ~2.56M / ~3.48M |
| `SealedPockets.send` (1 / 3 / 5 pockets a side) | ~541k / ~1.08M / ~1.61M | ~1.32M / ~3.92M / ~6.52M (depth ~1.97M) |
| `SealedPockets.withdraw` (set of 1 / 3 / 5) | ~696k / ~970k / ~1.27M | ~1.36M / ~2.82M / ~4.29M |
| `PocketDesk.ask` / `buy` | ~432k / ~2.68M | ~0.37M / ~6.28M (depth ~3.28M) |
| `SealedVault.confidentialTransfer` (with a new random key) | ~209k to ~266k | ~338k |
| `SealedVault.setKey` | ~185k | ~225k |
| `SealedVault.offerSale` | ~304k | ~150k |
| `SealedVault.acceptSale` | ~1.66M | ~4.34M |

`LiquidityLocker` has no FHE; it took 558,565 gas to deploy on Sepolia.
`Rats` and `RatPantry` have no FHE: `mintSeed` ~248k gas (~163k after the first), `mintModel`
~190k, `RatPantry.claim` ~90k for one rat (~103k for two); ~2.30M and ~554k to deploy (Hardhat).
`StudioPacks` has no FHE either: `buy` takes ~115k gas the first time (~63k after), and the
contract ~641k to deploy (Hardhat).
The `SealedVault` rows are not in `test/Costs.ts` yet: gas from `REPORT_GAS=1 pnpm test
test/SealedVault.ts`, HCU from `fhevm.computeTransactionHCU` on the same calls, against Seaport
1.5's, Seaport 1.6's (with OpenSea's conduit) and delegate.xyz's bytecode; the HCU did not
change with `VaultListings`. A buyer's Seaport `fulfillOrder` of an open vault listing on 1.5
takes ~97k gas; the vault ~5.18M to deploy (~5.5M before `VaultListings`), `VaultListings`
~1.45M, `VaultOffers` ~1.9M.

Deployed size: `DoNotOpen` 24,442 bytes (limit 24,576; the token URIs live in `BoxMetadata`, 1,861, and the rules' views in `DoNotOpenConfig`, 2,968), `WhitelistGifts` 4,876, `Rats` 12,191 (with the encrypted powers), `RatTricks` 8,265, `Pantry` about 14,000, `FleaMarket`
12,377, `SealedVault` 23,650 (926 under the limit, at the default optimizer; 22,712 before it
sent the offers' fills itself, 24,322 and 254 under before the listings' orders moved out: the
next feature moves logic out first, as accepting offers did into `VaultOffers`, 8,909, and the
listings into `VaultListings`, 6,336). To stay under
the limit, `DoNotOpen` alone is compiled with the optimizer at 1 run, for size (a per-file
override in `hardhat.config.ts`; every other contract runs at 200), and `onlySealed` calls
`_requireSealed` rather than inlining its check.

## Commands

```bash
pnpm compile
pnpm test                 # 344 tests on the local FHEVM mock: the standard, the boxes, the Pantry, the ramp, the credits, the studio packs, the rats, the locker, the flea market, the sealed vault (against Seaport 1.5's, Seaport 1.6's with OpenSea's conduit, and delegate.xyz's bytecode) and its pockets

# Local walkthrough
pnpm chain                # terminal 1
pnpm deploy:localhost     # terminal 2
pnpm demo:localhost       # buy a hidden box, shake twice, prove alive, observe
pnpm demo2:localhost      # mint 3, feed, duel, entangle, observe one and see both open
npx hardhat --network localhost dno:vault-demo   # the sealed vault: seal, list on Seaport, buy, collect, take out, delegate, accept an offer
npx hardhat dno:opensea-replay --tx <mainnet tx> # replays a real OpenSea offer a contract filled on mainnet, with VaultOffers in its place, on an anvil fork (needs anvil and MAINNET_RPC_URL with archive state and debug_traceTransaction; eth.drpc.org by default)

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

`deploy/vault.ts` (tag `Vault`) reads where the listings go from `lib/opensea.ts`
(`listingVenue(network)`: mainnet, Seaport 1.6 `0x0000000000000068F116a894984e2DB1123eB395`
with OpenSea's conduit `0x1E0049783F008A0085193E00003D00cd54003c71` (key
`0x0000007b02…0000`) and its signed zone `0x000056F7000000EcE9003ca63978907a00FFD100`; Sepolia,
the same Seaport 1.6 and conduit, both there with the conduit's channel open to 1.6 (checked
on-chain 2026-10-10), but no zone, since OpenSea closed its testnets and nothing signs for it;
elsewhere Seaport 1.5 `0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC` with no zone and no
conduit). It deploys `VaultOffers` (that Seaport and the network's WETH: `WETH` in the script,
OpenSea's, `0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9` on Sepolia; a `TestWETH` locally),
then `VaultListings(seaport, zone, conduitKey, conduit, owner)`, then `SealedVault(listings,
cUSDC, offers, registry, treasury, owner, feeBps)` against delegate.xyz's Registry v2
(`0x00000000000000447e69651d841bD8D104Bed493`) and the network's cUSDC, with `VAULT_FEE_BPS`
(250) paid to `STUDIO_TREASURY` (or the owner), owned by `COLLECTION_OWNER` (or the deployer).
On a test network it also deploys `VaultTestNFT` and allows it. On mainnet the owner then sets
each allowed collection's fees with `VaultListings.setFees` (OpenSea's 1% to
`0x0000a26b00c1F0DF003000390027140000fAa719`, `OPENSEA.feeRecipient`, plus the creator's fee
where OpenSea enforces one, read from its collection page or API). On a local node (`pnpm
chain`) it first puts Seaport 1.5's Sepolia runtime code at its address
(`test/fixtures/seaport-1.5.json`, with storage slot 0, the reentrancy guard, set to 1), and
the registry's (`test/fixtures/delegate-registry-v2.json`); elsewhere it stops if either is
missing (the tests' `test/fixtures/seaport-1.6.json`, Seaport 1.6 and OpenSea's conduit from
mainnet, is for the tests only). It runs at the end and redeploys nothing else (locally it
reuses the test cUSDC of `deploy.ts`), so `npx hardhat deploy --network sepolia --tags Vault`
adds it next to a live collection; `dno:export` writes it under `vault` (address, ABI, deploy
block, Seaport, `listings` with its ABI (null for a vault from before it), `offers` with its
ABI and deploy block, WETH, the registry, the allowed collections). `npx hardhat --network
<localhost|sepolia> dno:vault-demo` runs it end to end, the buyer's offer signed for the
version Seaport's `information()` reports; its fresh addresses are the kept test wallets
`vault-proceeds`, `vault-withdrawals` and `vault-delegate`. On Sepolia it stops at the first `finalize` while Zama's gateway answers
"ciphertext not ready"; the whole run (offer and delegation included) passes on a local node.

`deploy/pockets.ts` (tag `Pockets`, after `Vault`) deploys `SealedPockets` on the vault's cUSDC
and `PocketDesk`, sets the desk and hands the pockets to `COLLECTION_OWNER`; then one more
`SealedPockets` per token of `lib/pocketTokens.ts` on that network (cUSDT, cWETH, cZAMA on
Sepolia: Zama's ERC-7984 wrappers from its Confidential Token Wrappers Registry), deployed as
`SealedPockets_<symbol>`, without a desk. It runs the vault's script first: check its constructor
arguments (`STUDIO_TREASURY`, `COLLECTION_OWNER`) match the live ones, or `SealedVault` is
redeployed. `dno:export` writes the cUSDC pockets under `vault.pockets` (with `token`: the
confidential token, its ERC-20, decimals and rate, read from the chain) and the others under
`vault.otherPockets` (address, deploy block, token; they share the cUSDC pockets' ABI).

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

## Published to GitLab

The contracts are also published, with their tests and their Sepolia addresses, as two standalone
Hardhat projects: [`do-not-open-vault`](https://gitlab.com/do-not-open/do-not-open-vault) and
[`do-not-open-game`](https://gitlab.com/do-not-open/do-not-open-game). `publish/publish.mjs`
rebuilds each from the committed tree, from a whitelist (`publish/vault.json`, `publish/game.json`)
plus `publish/templates/`, with the addresses only from `deployments/sepolia` (no bytecode, no
compiler input, which holds the other contracts' sources). The game's also carries `game-spec` and
`generator` under `vendor/`, which its tests and deploy read. Before a push it refuses any secret
or reference to the rest of the monorepo, and installs, compiles and runs the tests on its own;
it pushes one commit per repository whose files changed, with the subject of the last commit that
touched them. `.github/workflows/publish-contracts.yml` runs it on pushes to `main` that touch
these packages, with one GitLab deploy key per repository (`GITLAB_VAULT_SSH_KEY`,
`GITLAB_GAME_SSH_KEY`).

```bash
node publish/publish.mjs --dry-run              # builds both, checks them, pushes nothing
node publish/publish.mjs --dry-run --only vault
```

A new contract, test or deploy script reaches GitLab only once its manifest lists it (the game's
takes `contracts/*.sol`, `test/*.ts` and `deploy/*.ts` but the vault's files).

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
