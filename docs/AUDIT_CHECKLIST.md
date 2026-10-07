# Audit checklist

This is a self-review, written by the people who wrote the code. It is a starting point
for an external audit, not a substitute for one. **No third party has audited this
contract, and it must not go to mainnet before one has.**

Scope: `ConfidentialERC721.sol`, `DoNotOpen.sol` and `DoNotOpenConfig.sol` in this
repository, the hidden-owner version (10,000 boxes, owners and sold count encrypted; see
[HIDDEN_OWNERS.md](HIDDEN_OWNERS.md)), deployed on Sepolia at
`0x7b246695614Cc49A500bC8057345181689c82d52` (with the shake guard, redeployed on 2026-10-07
at block 11862305; the version before it, with the security fixes and decoy transfers, at
`0x816a39b04e0672B4746A5B696E14145F4F852d37`, 2026-10-03, block 11836238); the croquette
contracts `Croq.sol`, `ConfidentialCroq.sol` and `Pantry.sol` (section 9, a fresh economy on
2026-10-07: `Pantry` at `0x4e62259E4FFb05224b8Ef64dD4E45826651EB72F`) and `LiquidityLocker.sol`,
which holds the CROQ market's Uniswap V3 position (section 10); `Rats.sol` and `RatPantry.sol`,
the studio's adopted rats and their croquettes (at `0x441F9fe3B8333515Bc7B295E06C14948057b2cF6`
and `0xC13432AF43dDC738fa0a591CE3499BaF0DA5E450` since 2026-10-07, with the encrypted powers;
before them `0x138f8F6aae87f3762C9d03Cbad3048Bb3EF31264` and
`0x1334d72fC60cBedcF409d6583F0Ec009c285E75B` on 2026-10-05, block 11845258, with the caps, and
the first pair, without them, at `0xd4f8Df0F14Ced442077762cb81e843656BAc3856` and
`0x9c83C67e690CF8fb6CFaFE8f1DA5221D20520a0A` on 2026-10-04); `RatTricks.sol` and
`IShakeGuard.sol`, the rats' sniffs, shields and jams (section 14, at
`0x44B2006E63Af469e5470eD5Fc2A6307117d22d0D`); `WhitelistGifts.sol` (section 13, at
`0xD244389bF81C38803c94957a1e6B5694eEeA678b`); `StudioPacks.sol` (at
`0x41596e7311A7408BC1871B9b93be82ef6DDfB5f6`; before it `0x672cf76a68d4f181387B59caA1813eC425c1354C`
on 2026-10-04, block 11842636); `FleaMarket.sol`, the players' marketplace for boxes, cats and
rats (section 12; at `0x4E9fC2Cb042d7Bd49B559Ad3e1110c200d7081C1` since 2026-10-07, before it
`0xb5c799bF626e70DcE6804BDef06199661cDc8665` on 2026-10-05, block 11849253); plus the parts of
the adapter and the metadata pipeline that could leak or mislead. Since 2026-10-07 the deployer
`0x590891F269720001435004A1089cAB5b2c20029A` owns every contract (before, the collection's owner
was `0x6a18cFC3fAeef453B295B12246d40a82593b3208`). The Sepolia deployment at
`0xe8f699eEBc22767413A9edBb48826B10D3117f61` is the previous version, an ERC-721 with
public owners, and is not what this list reviews.

Status values: **Pass** (checked, with the evidence named), **Accepted** (a known
property of the design, documented), **Open** (should be fixed or decided before
mainnet), **Not done** (a check nobody has run).

## Summary of what is open

| # | Finding | Severity | Where |
| --- | --- | --- | --- |
| O1 | A request whose proof never comes stays `Pending`: an opening keeps its fee | Low | `observe`, `finalize` |
| O2 | No per-wallet mint cap or allowlist: one bot can mint the supply, and a cap would now have to be encrypted | Medium (fairness) | `mint` |
| O3 | `DoNotOpenConfig` does not check that the maximum score fits 16 bits | Low (deploy-time) | constructor |
| O4 | `DoNotOpenConfig` does not check that trait offsets are distinct and byte-aligned | Low (deploy-time) | constructor |
| O5 | Single-step `Ownable`; the owner is an externally owned account on Sepolia | Low on testnet, High on mainnet | admin |
| O6 | `setBaseURI` can repoint every token's metadata, with no freeze (the images are on Arweave for good) | Medium (trust) | admin |
| O7 | No ERC-4906 `MetadataUpdate` on reveal: marketplaces keep the sealed image | Low | `finalize` |
| O8 | Anyone can take up an open duel with a box they do not hold: it is held up until the proof sends it back to the shelf | Low (griefing) | `acceptDuel`, `finalizeDuel` |
| O9 | Mainnet relayer needs an API key behind a proxy: built (`apps/api`), the key and Zama's plan are not set yet | Blocker for mainnet | `apps/api` relayer proxy |
| O10 | Static analysis, fuzzing, Sepolia test suite and Etherscan verification not run | Process | see the end |
| O11 | The reserve is unreadable: nobody can tell when it runs dry, and claims then pay nothing, silently | Low (UX) | `Pantry.claim` |
| O12 | Welcome bags and purrs share one reserve: an active purr can leave late boxes without a bag | Low (fairness) | `Pantry.claim` |
| O13 | The 5M treasury, the locker's fees and its ownership sit with the deployer's hot key (the market's position is locked in `LiquidityLocker` for good) | Low on testnet, High on mainnet | deploy |
| O14 | Selling CROQ or seeding its market on mainnet is regulated (MiCA in the EU) | Blocker for a mainnet market | economy |
| O15 | The owner can make any contract a trusted reader, and a malicious one could publish who holds a box | Medium (trust) | `setTrustedReader` |
| O16 | `IConfidentialERC721` is a draft standard written here; no third party has reviewed it | Medium | `ConfidentialERC721` |
| O17 | Anyone can send decoy transfers naming an address: its holder's discovery must decrypt every one | Low (UX) | `confidentialTransfer`, adapter `boxesOf` |
| O18 | `DoNotOpen` is 24,553 bytes, 23 under the limit, compiled for size: the next feature does not fit | Low (maintenance) | build |
| O19 | One public proof of holding lets anyone follow a box to its next holders, unless its holder sends decoys (optional) | Low (privacy, opt-in fix) | `ConfidentialERC721` transfers |
| O20 | The app feeds only boxes the caller holds: the calldata and `MealServed` name them (claims are fixed: they name whole windows of ten ids) | Medium (privacy) | app, `Pantry.feed` |
| O21 | Anyone can overwrite an entanglement proposal and keep a pair from being linked | Low (griefing) | `proposeEntangle` |
| O22 | Free empty mints can replace the milestone bit before its proof lands | Low (griefing) | `_checkMilestone` |
| O23 | Near sell-out, a free mint past the cap tells the buyer the exact remaining supply | Low (privacy) | `mint` |
| O24 | Between `observe` and `finalize` the seed is public but the box is still `Sealed`: a holder can aim for the Pantry tolerance, or sell a box whose contents are known | Low | `observe`, `Pantry.feed` |
| O25 | Anyone can send dust Uniswap positions to `LiquidityLocker` and grow `positions()` | Low (tooling) | `LiquidityLocker` |
| O27 | AI rats are minted on the API's signature (the attester): a stolen attester key could mint AI rats for any job, paid at the normal price; the owner can rotate it with `setAttester` | Low (trust) | `Rats.mintModel` |
| O28 | The `RatPantry` has no owner and no refill but a transfer: once its 500,000 CROQ are paid out (about 167 days with all 1,000 rats claiming 3 a day), rats earn nothing (`claim` reverts `PantryEmpty` while it is empty, so earned days wait; it pays what is left when low) | Low (UX) | `RatPantry.claim` |
| O29 | A box with a pending opening can be listed and sold on the flea market as sealed, its seed already public (extends O24) | Low | `FleaMarket.list`, `DoNotOpenHooks` |
| O30 | X boarding passes: the follow, like, reply and repost are declared, not checked, and anyone can make many X accounts (Discord accounts too, past 30 days; a member can leave after boarding); the pass token is a bearer kept in the browser (lost with it, moved by a new post) | Low (fairness) | `apps/api` `XPasses` |
| O31 | A whitelist gift box's first holder is public (the claim names the tier, the box id goes to the wallet) | Low (privacy) | `WhitelistGifts.claim` |
| O32 | The whitelist is frozen off-chain: the operator builds the Merkle tree from the API's ranking, and players trust it to match the published rules (the root can be corrected until the first claim) | Medium (trust) | `WhitelistGifts.setRoot`, `GET /v1/allowlist/gifts` |
| O33 | `Rats.giver` adopts free rats outside the paid caps, up to `maxGiftRats` (1,000): with the 1,000 paid rats, the `RatPantry`'s 500,000 CROQ last about half as long | Low (economy) | `Rats.gift`, `RatPantry` |
| O34 | The owner sets `DoNotOpen.guard`: a malicious guard could rewrite every shake's result, or be made a trusted reader and publish holders | Medium (trust) | `setGuard`, `RatTricks.filter` |
| O35 | Rat tricks leak a little: `TrickPlayed` and `Sniffed` name the rat, the box and the player; a jammed holder learns it; a sniffer who compares a shielded trait before and after the shield ends sees it changed | Low (privacy) | `RatTricks` |
| O36 | A rat's seller keeps reading its power after the sale (an ACL grant is never taken back) | Low (game) | `Rats.allowPower` |
| O26 | Studio units are spent off-chain by the API: a buyer trusts it to honour the pack, and nothing on-chain refunds a pack the services never deliver | Medium (trust) | `StudioPacks`, `apps/api` |

Fixed after the review of 2026-10-03 (section 11): free empty ids draining the Pantry
reserve, the owner reading every mint's quantity through the revenue, the treasury reading
every meal, a challenger escaping an accepted duel, a refund wrapping the revenue around,
paid-shake shares stranded in empty ids, and a zero credit price.

Details and the rest of the checks follow.

## 1. Re-entrancy and payments (cUSDC)

| Check | Status | Evidence |
| --- | --- | --- |
| No external call in the middle of game logic | Pass | Each paid action pulls cUSDC first (`_pull`, a `confidentialTransferFrom`) and acts on what arrived. cUSDC is sent only by `claimEarnings`, the refund of an opening made redundant by its partner (paid from the held fee, never from `_revenue`), and `withdraw`. The token addresses are immutables set at deploy |
| A short cUSDC balance buys nothing, without a revert | Pass | The transfer moves 0 and the action is masked by `paid == price`: a mint creates only empty ids, a feed adds 0, a paid shake reads `NOT_YOURS` and earns the holder nothing, an opening is refused. Tests: "gives nothing and charges nothing to a buyer who cannot pay", "adds nothing when the feeder cannot pay", "shows nothing to a payer who could not pay, and earns the holder nothing" |
| A mint charges only the boxes it gives | Pass | `price = quantity × mintPrice` after the cap and batch cuts; all or nothing. Tests: "charges only the boxes it gives, in cUSDC", "never sells past the cap, and charges nothing for a mint that would" |
| Only a holder is charged for an opening | Pass | `observe` pulls `select(holds, fee, 0)`. Test: "refuses someone who does not hold the box: nothing opens, nothing is charged, nothing leaks" |
| cUSDC payouts cannot re-enter | Pass | `confidentialTransfer` (no `AndCall`) calls nothing on the receiver; earnings are zeroed before the transfer |
| A reverting or re-entering holder cannot block `paidShake` | Pass | The holder's share stays in the box (`_earnings`); nobody is called during `paidShake` |
| Earnings go to whoever holds the box when claimed | Pass | `claimEarnings` pays `select(isOwner, earnings, 0)` per box and keeps the rest. Tests: "pays the share to whoever holds the box when it is claimed", "books the rest as revenue and caps a claim at ten boxes" |
| `withdraw` cannot take holders' earnings | Pass | Paid-shake fees are split at once: the holder's share into the box (none for an empty id), the rest into `_revenue`. An opening's fee joins `_revenue` only when the box opens. `withdraw` sends `_revenue` only. Tests: "books the rest as revenue and caps a claim at ten boxes", "holds an opening's fee until it settles, and pays a refund without touching the revenue" |
| `withdraw` re-entrancy | Pass | Owner-only, to an address the owner chose, at most once per 7 days; `_revenue` is reset before the transfer |
| No receiver callback | Pass | The Confidential ERC-721 has no safe transfer and no hook: a mint or transfer calls nothing on the receiver |
| Fees cannot be changed after deploy | Accepted | They are immutables. A price change means a new deployment |
| No `receive` or `fallback` | Pass | Plain ETH transfers to the contract revert, and no function is payable |
| Paying from plain USDC shows the quantity | Accepted | The contract takes cUSDC only; the app's `pay: "usdc"` shields the exact price first, a public wrap. The app says so |
| `UsdcRamp` fee is bounded and pulled | Pass | `feeBps` is an immutable checked against `MAX_FEE_BPS` (1%) in the constructor; fees accrue in the contract and only the owner withdraws them, after zeroing `fees`. Tests in `test/UsdcRamp.ts` |
| `UsdcRamp` swaps are slippage-bounded | Pass | The caller passes `minUsdcOut` and a deadline to the router; the app asks for at most the player's slippage tolerance under the quote, 1% by default. A sandwich can still take up to that much |
| User-set slippage stays bounded | Pass | The bureau de change lets the player pick 0.01% to 50% (kept in `localStorage` `dno.slippage`); the adapter rejects a `SwapOptions.slippageBps` outside 1–5000 (an integer) before any transaction, for `buyUsdc` and `trade`. The bureau flags a price impact above 2% and warns in words above 5%. A wide setting is the player's choice, and the app says a bot may take it. A share kept as plain USDC (`dno.keepUsdc`, 0 to 20%) is a second `buyUsdc` with the same slippage bound, sent before the sealed one |
| Unshielding cUSDC reveals the amount and fails silently | Accepted | `unshieldUsdc` is the wrapper's own `unwrap` + `finalizeUnwrap`, like a cCROQ unwrap: the amount is decrypted in public. A short balance burns 0 and pays out 0; the adapter returns 0 and the bureau stops a multi-leg route there, saying where the funds are. No contract of ours is involved |
| `UsdcRamp` holds no buyer funds between calls | Pass | Unshielded USDC goes straight to the buyer; shielded USDC is wrapped to the buyer in the same call. With a wrapper `rate()` above 1, the remainder of the division would stay in the ramp: cUSDC's rate is 1 |
| `Rats` holds no funds and cannot be re-entered | Pass | `mintSeed` / `mintModel` write the rat, pull the price to the treasury with `safeTransferFrom`, then `_mint` (no receiver callback). Test: "adopts a free rat by its seed, once, paid to the treasury" |
| A rat is minted once per seed and per AI job | Pass | `tokenOfSeed` / `tokenOfJob` checked before minting. Tests: "adopts a free rat…", "adopts an AI rat only on the attester's signature, for the caller, once" |
| The rats' supply is capped for good, and each address's mints | Pass | `maxSeedRats` (700), `maxModelRats` (300) and `maxPerWallet` (5) are immutable, none of them 0 (`ZeroCap`); `seedMinted` / `modelMinted` past their cap revert `SoldOut`, `mintedBy[msg.sender]` past its cap `WalletLimit`. It counts mints, not holdings: several addresses get around the per-wallet cap, which only slows a hoarder, while the supply caps hold whatever. Test: "caps each kind for good, and each wallet's mints, but not what a wallet holds" |
| An AI rat's adoption cannot be replayed, redirected or altered | Pass | EIP-712 `Adopt(minter, job, uri, deadline)` bound to the chain and the contract; the minter is `msg.sender`, the files' `uri` is signed, `deadline` expires. Test: "adopts an AI rat only on the attester's signature…" |
| Rats cannot be minted free to farm croquettes | Pass | Prices are never 0 (`ZeroPrice`) and at most 100 USDC; `maxPrice` guards a raise. Tests: "refuses a price raised…", "lets only the owner set prices…" |
| The `RatPantry` pays only a rat's current owner, once per day earned | Pass | `ownerOf` checked per id, `paidUntil` keeps the remainder of a day, at most `maxDays` per claim, pays at most the reserve. An empty pantry reverts rather than marking days paid. Tests: "pays each rat its CROQ a day…", "pays what is left when the pantry runs dry…", "refuses a claim while it is empty…" |
| `StudioPacks` holds no funds | Pass | `buy` sends the whole price to the treasury with `safeTransferFrom` in the same call, or reverts. Test: "sells a pack for plain USDC, paid straight to the treasury" |
| A studio pack's price cannot be raised under a buyer | Pass | `buy` takes `maxPrice` and reverts with `PriceChanged`; a price is at most 100 USDC (`MAX_PRICE`) and a pack on sale cannot be empty. Tests: "refuses an unknown pack, a zero account, and a price raised after the buyer looked", "lets only the owner set, change and withdraw packs, within bounds" |
| The studio spends no more than was bought | Pass | The API spends a unit before calling a service, atomically, and gives it back when the service fails or a job is still running after ten minutes; a daily dollar budget pauses the studio. Tests in `apps/api/test` |
| One studio unit cannot bill the services without end | Pass (fixed in review, 2026-10-04) | A failure gave the unit back and left the day's budget untouched, though fal had billed it: a picture the safety checker flags, repeated, cost the collection on one unit. Now failed jobs count in the budget, a flagged picture keeps its unit (`rejected`), and refunds stop after `STUDIO_REFUNDS_PER_DAY` (3) per account and day. Tests: "gives units back for a few failures a day, then keeps them", "keeps the unit of a picture the safety checker refused", "counts failed jobs in the day's budget" |
| The studio's file proxy cannot be turned against the API | Pass (fixed in review, 2026-10-04) | It fetched any URL stored for a job, whole, into memory, and served the upstream content type from the API's origin. Now: https on fal's hosts only, 10 MB a picture and 40 MB a mesh, 60 requests a minute per address, the type forced to an image or a GLB, `nosniff` and a sandboxing CSP. Test: "serves only the service's own files, capped in size, never as a page" |
| A studio buyer gets the pack they saw | Accepted | `buy` bounds the price (`maxPrice`) but not the contents: the owner could shrink a pack between a buyer's look and their transaction. The owner is the collection; a front-run would show in `PackSet` |
| Nothing drawn in the studio passes for a cat out of a box | Pass | The studio draws rats, never cats: the free generator is a separate rat generator (`buildRatSpec`, `createRat`) and the AI prompt sits inside a rat house style, so a studio picture cannot be shown off as a rare cat. Box cats stay provable on-chain (token, `Observed`, seed) |

## 2. ACL and confidentiality

| Check | Status | Evidence |
| --- | --- | --- |
| Nobody but the contract is ever allowed on the seed | Pass | Only `allowThis(seed)` in `mint`. Test: "gives nobody the right to decrypt the seed, not even the holder or the deployer" |
| Same for the affection and the cached score | Pass | Only `allowThis` in `feed` and `_ensureScore` |
| A shake result is readable by its viewer only | Pass | Fresh ciphertexts, `allow(viewer)`. Test: "keeps the result unreadable for everybody else" |
| A shake can never return the state | Pass | The five picks are the five trait offsets (16 to 48); the state roll is bits 0 to 15. `InvalidTraitOffset` rejects offsets below 16 at deploy |
| The shake event does not leak the pick | Pass | `Shaken(tokenId, viewer, paid)`. Test: "emits no information about the pick" |
| The pick cannot be predicted or ground | Pass | It is an encrypted draw. Resubmitting gives another hidden draw, not a chosen one |
| Owners are unreadable, the owner included | Pass | `_owners` is allowed to the contract only. Test: "keeps the owner itself unreadable, even to the owner" |
| The revenue is unreadable, the owner included | Pass | `_revenue` is allowed to the contract only, and `withdraw` runs at most once per 7 days: a readable revenue would give each mint's quantity, one difference at a time. Tests: "lets nobody read the revenue, the owner included: it would give away each mint's quantity", "pays the revenue out at most once a week, so the owner only learns weekly sums" |
| A real token and an empty one look the same | Pass | Same event, same seed draw, same storage; only the buyer reads `moved`. Test: "makes a real token and an empty one look the same from outside" |
| A transfer by a non-holder does nothing and does not revert | Pass | `moved = owner == from`, `owner = select(moved, to, owner)`. Tests: "does nothing, without reverting, when the sender does not hold it", "follows a token through several hands, decoys included" |
| A holder can send a decoy, and a decoy looks like any transfer | Pass | `confidentialTransferIf` ands `moved` with an encrypted `really` from the caller; same event, same receipt rules. Tests: "sends a decoy when the holder says so, and nobody else can tell it from the real one", "takes every bit of one encryption, one transaction each, as the app sends decoys", "moves nothing for a stranger, even with really set to true" |
| A transfer receipt is readable by its two sides only | Pass | `allow(moved, from)`, `allow(moved, to)`, transient for the calling contract. Test: "moves the token when the sender holds it, and tells only the two sides" |
| `isOwner` answers only the account, its operators and trusted readers | Pass | Reverts `ConfidentialERC721UnauthorizedReader` otherwise. Tests: "answers the account itself, its operators and trusted contracts only", "refuses to read ownership unless the collection trusts the Pantry" |
| **O15. Trusted readers** | Open | A trusted reader gets `isOwner` about anyone, with a transient grant. A malicious one could make the answer publicly decryptable and so publish who holds a box. Only the owner adds readers. Make the set immutable after deploy, or put it behind a timelock and a multisig |
| A request by a non-holder reveals nothing about the box | Pass | Every published value is masked by `holds` (or `ok`, `valid`); a refused request decrypts to "no" and zeros. Tests: "refuses someone who does not hold the box…", "refuses a stranger, and is asked once per box", "goes back on the shelf when the accepter brought a box they do not hold, showing nothing" |
| A void duel says nothing about the accepter | Pass | `valid = aHolds AND accepter holds B`: "B is held" only shows when A was. Test: "is void, and says nothing of the accepter, when the challenger gave the box away" |
| What a successful request reveals | Accepted | That the caller held the box then: an opening, an alive check, an entanglement, a proven duel posting, a valid duel. `Observed` names the opener. A reopened duel shows that the accepter did not hold B. Documented in HIDDEN_OWNERS.md. What follows from it is O19, which decoys answer |
| A buyer's holdings can be bounded from above | Accepted | Ids minted (`MintPlaced.count`) plus transfers naming the address. Never known exactly |
| A milestone shows which mint crossed it | Accepted | Its bit decrypts to true. Nothing between two milestones |
| **O16. Draft standard** | Open | `IConfidentialERC721` and its ERC-165 id `0x87ffe7a2` (`0x5f6463b8` before `confidentialTransferIf`) are this project's. Have the standard reviewed, or align it with one Zama or OpenZeppelin publishes |
| **O17. Decoy receipts** | Open | `confidentialTransfer(victim, id)` costs the sender gas and emits a receipt naming the victim, which their `boxesOf` must decrypt. Spam slows discovery; it cannot add a box. Batch decryption and a cap per visit in the adapter |
| Transfer moves no ACL on game data and leaves nothing to revoke | Pass | Test: "hands the box over: the new holder can shake, the previous one cannot" |
| A previous holder keeps what they already decrypted | Accepted | Unavoidable. Documented in `DATA_MODEL.md` |
| A holder can learn all five traits by shaking repeatedly | Accepted | By design ("unlimited"). The state and the affection stay hidden. A buyer should assume the seller knows the traits |
| Duels leak the order of base scores, and so a hint about the state | Accepted | The state bonus is up to 1,000 of 3,040 points: a box that beats many others is more likely quantum or ghost. This is the mechanic |
| The duel winner's trait is never decryptable | Pass | `select(aWins, roll(B), roll(A))` under encryption; only the selected value is made public. Test: "resolves to the higher score and reveals one trait of the loser only" |
| `proveAlive` publishes exactly one bit about the box | Pass | Two `ebool`s are made public: "holds" and "alive AND holds". Test: "publishes exactly one bit and grants the badge when it is true" |
| Feeds do not give the affection away | Pass | Each paid feed adds an encrypted draw in 0..3, an unpaid one 0, and the count is not kept. Tests: "lets anyone feed for the fee and adds a hidden amount each time", "adds nothing when the feeder cannot pay" |
| Public handles (`seedHandle`, `lastShake`, `requestInfo`, `duelHandles`, `milestoneHandle`, `confidentialOwnerOf`) leak nothing | Pass | A handle is an identifier. Decryption is gated by the ACL |
| The one encrypted input of `DoNotOpen` is bound to the buyer | Pass | `mint` takes `externalEuint8` with `FHE.fromExternal`, bound to (DoNotOpen, `msg.sender`), then cut to `ids`. Test: "cuts a quantity above the batch size down to it" |
| Gas or HCU side channels | Accepted | Whether a box has a cached score, or was ever fed, is visible from cost and handle count (an opening of a fed box publishes one more handle). Whether a caller holds a box is not: holder and non-holder paths run the same operations |
| Sealed metadata cannot leak the seed | Pass | `buildBoxSpec(tokenId)` and `sealedMetadata` take the token id and public facts only. Test: "builds sealed metadata from the token id and public facts only" |

## 3. Decryption "callbacks"

The protocol has no on-chain callback. Each reveal ends with a permissionless
`finalize`, `finalizeDuel`, `announceMilestone` or `finalizeWeigh` transaction carrying
clear values and a KMS proof.

| Check | Status | Evidence |
| --- | --- | --- |
| The handle list is taken from storage, never from the caller | Pass | Stored per request (`_requestHandles`), `duelHandles`, `_milestoneBit` |
| A forged value is rejected | Pass | Tests: "rejects a forged seed, a proof made for another request, and a second settlement", "rejects a forged answer" (alive, milestones), "rejects a forged outcome and double finalisation" |
| A valid proof for another request cannot be replayed | Pass | Same tests: the proof is bound to the handles stored at the request |
| Finalisation happens once | Pass | Request status `Pending`, duel status `Posted` or `Pending` (each proof moves it on; a reopened duel needs a new acceptance and new handles), `milestonesReached` moves on and clears the bit |
| A request cannot be finalised before it exists | Pass | `RequestNotPending` on an unknown id |
| Repeated requests are harmless | Pass | Several openings of one box may be pending; the first finalised opens it, a later one by a holder refunds its fee, which was held apart from the revenue. `proveAlive` reverts once the box has an answer. A stranger's requests are refused |
| Handles cannot change between request and finalisation | Pass | A request publishes fresh masked copies (`select(ok, …)`), stored with the request; later feeds or transfers do not touch them |
| Feeds after an opening request do not count | Accepted | The affection published is the one at the request. A feed paid in between is lost to the reveal |
| Duplicate handles in one decryption | Pass | A public decryption refuses one handle twice: an unfed box publishes no affection (`Request.fed`). Test: "links two boxes with both holders' consent and opens them together" (one of the two unfed) |
| The order of decoded values matches the order of handles | Pass | Covered by every finalisation test |
| Anyone can finalise, including after a transfer | Pass | Test: "still opens for the holder at the time of the request, even if the box moved since" |
| A duel still resolves if a box is opened meanwhile | Pass | `finalizeDuel` checks only the duel's status. `acceptDuel` refuses an opened box on either side |
| Front-running a finalisation | Accepted | Whoever sends it, the result is the same. The slower sender's transaction reverts (`RequestNotPending`) and costs them gas. The adapter checks that a request is still `Pending` before sending its proof |
| **O1. Liveness** | Open | If the KMS or relayer never answers, a request stays `Pending`. The box stays `Sealed` and usable, but an opening's fee is kept, and the masked seed stays marked public: if the KMS answers later, anyone can still finalise it. Options: a refund after a timeout, or accept and document. A pending alive check or duel is harmless; a posted duel never reaches the shelf |

## 4. Mint

| Check | Status | Evidence |
| --- | --- | --- |
| The seed cannot be seen or influenced by the minter, a block producer or the deployer | Pass | `FHE.randEuint64()`, encrypted at birth |
| Mint cannot be reverted selectively on a bad roll | Pass | Nothing about the roll is known during or after the transaction |
| Token ids carry no information | Pass | Sequential, empty ones included. The look of a sealed box depends on the id only |
| The quantity is hidden among the ids | Pass | `ids` (1 to 10) ids per mint, the first `quantity` owned. Tests: "creates ten boxes per mint and gives the buyer the first ones, privately", "hides the quantity among as many ids as the buyer picks, and never gives more" |
| The cap holds under encryption | Pass | `sold + quantity <= maxSupply` or the mint is empty and free. Test: "never sells past the cap, and charges nothing for a mint that would" |
| Milestones are announced once each, with a proof | Pass | Tests: "announces each milestone once it is reached, and nothing in between", "rejects a forged answer and milestones that do not end at the cap" |
| HCU and gas | Pass | 10 ids: ~3.3M HCU, ~2.6M gas. Test: "stays within the HCU budget" |
| **O2. Supply sniping** | Open | Front-running cannot pick good boxes, but nothing stops one account from minting the supply in 1,000 transactions. With CROQ, each box also carries a 100-croquette welcome bag, which raises the incentive. A per-wallet cap would have to be encrypted, as the quantity is. Decide before mainnet |
| Information asymmetry after mint | Accepted | The holder can learn the traits; a buyer cannot without paying for shakes |

## 5. Game logic

| Check | Status | Evidence |
| --- | --- | --- |
| The Solidity decoder equals the TypeScript generator | Pass | Tests: "decodes seeds exactly like the TypeScript generator", "maps rolls to variants like the generator". Smoke run: both Sepolia reveals matched |
| The encrypted score equals the plain one | Pass | Test: "resolves to the higher score..." compares against the mock's cleartext. Same weights and thresholds are read from the config |
| **O3. Score overflow** | Open | The score is a `uint16` / `euint16`. With the shipped spec the maximum is 3,040. With other weights the plain `decode` would revert (bricking `finalize` of that box's opening) while the encrypted sum would wrap silently. Add a constructor check that `max(bonus) + 255 * sum(weights) + goldenBonus <= 65535` |
| **O4. Offsets** | Open | The constructor checks each offset is in 16..56 but not that the five are distinct and multiples of 8. `configParamsFromSpec` produces valid values; the contract should not rely on that |
| Ties in a duel go to B | Pass | `FHE.gt(scoreA, scoreB)`. Test: "resolves to the higher score and reveals one trait of the loser only" expects A to win only on a strictly higher score |
| Duel and entanglement need both holders | Pass | Checked under encryption at acceptance. Tests: "links nothing unless the proposer holds A and the accepter holds B", "is void, and says nothing of the accepter, when the challenger gave the box away", "goes back on the shelf when the accepter brought a box they do not hold, showing nothing" |
| Only boxes their challenger holds go on the duel shelf | Pass | `postDuel` publishes "the caller holds A"; `finalizeDuel` opens the duel only on a proven true, and voids it otherwise. Test: "only goes on the shelf once the challenger is proven to hold the box" |
| A reserved duel takes only its box; a box has one listing; a duel ends after 7 days | Pass | `NotThisBox`, `SameBox`, `DuelExpired`; a newer proven posting cancels an older one nobody accepted. Tests: "lets only the named box accept a reserved duel", "keeps one listing per box, and refuses its own box, opened boxes and late takers" |
| An accepted duel runs to its end | Pass | A new proven posting of a box whose listed duel is `Pending` is cancelled itself: the challenger cannot read the public outcome and escape a loss. Test: "lets an accepted duel run to its end: posting the box again cannot cancel it" |
| A proposal or duel dies if the proposer's box is sold | Pass | The proposer's or challenger's holding is checked again at acceptance. Tests: "lets one holder entangle two of their own boxes, and follows a transfer", "is void, and says nothing of the accepter, when the challenger gave the box away" |
| Entanglement is permanent and follows the token | Accepted | A buyer of an entangled box can have it opened by the partner's holder, at no cost to them and with no consent asked. Marketplaces and the app must show `partnerOf`. The app does |
| Opening a partner costs its holder nothing and asks nothing | Accepted | That is what the two holders agreed to |
| **O8. Shelf griefing** | Open | Posting spam is bounded: only a proven holding goes on the shelf, and a box has one listing. But anyone can take up an open duel with a box they do not hold. Nothing shows about the duel's boxes and the duel goes back on the shelf (`DuelReopened`), yet it is out of reach until someone sends the proof, and that time counts against its 7 days. Each attempt costs the griefer gas. Options: extend `openUntil` on reopen, or accept. Without the API, the adapter only scans the latest duels (40 for `pair()`, 200 for the shelf) |
| Unbounded loops | Pass | Mint loops at most `maxPerTx` (10) ids; `claimEarnings` at most `MAX_CLAIM` (10) boxes; score loops are fixed at 3 and 5 |
| Casts | Pass | Token ids run past 10,000 (empty ids) and are stored as `uint32` in requests and duels: 4 billion ids, 400 million mints. `buildBoxSpec` accepts any 32-bit id |
| HCU stays under the limit | Pass | Largest in `DoNotOpen`: a 10-id mint ~3.3M and `acceptDuel` ~2.8M of 20M. Tests pin the budgets |
| **O18. Contract size** | Open | 24,553 bytes deployed, limit 24,576 (2026-10-07: the shake guard fit by dropping the `revealed` and `vetCertified` shortcuts, making `NOT_YOURS`, `MAX_CLAIM` and `DUEL_LIFETIME` private and folding the four `_publish` overloads into one on `bytes32`), after moving the `onlySealed` check into `_requireSealed`, dropping `revenueHandle` and the public withdrawal clock for the 2026-10-03 fixes, and compiling `DoNotOpen` alone with the optimizer at 1 run (size over gas) to fit `confidentialTransferIf`. The other contracts stay at 200 runs. Move logic to a library or a trusted-reader contract before the next feature |

## 6. Administration and trust

| Check | Status | Evidence |
| --- | --- | --- |
| Owner powers are limited to `withdraw`, `setTrustedReader` and `setBaseURI` | Pass | Test: "lets only the owner withdraw the revenue, trust readers and set the base URI". The owner cannot mint for free, change rules, pause, or read a seed, an owner or the revenue; it learns the revenue only as what `withdraw` pays, at most once a week. `setTrustedReader` is a confidentiality power: see O15 |
| **O5. Ownership** | Open | `Ownable` is single-step, and on Sepolia the owner is the deployer's hot key. For mainnet: `Ownable2Step` and a multisig |
| **O6. Metadata control** | Partly mitigated | `setBaseURI` can be called at any time. The images are content-addressed: the API stores each sealed box and each opened cat on Arweave (`ArchiveImages`, free through Turbo, signed by the collection's `ARWEAVE_KEY`) and the metadata links them there, so a repointed JSON cannot change a stored picture, and anyone can redraw it from public facts with `@dno/generator`. The JSON stays live on the API because it changes (opening, duels, vet, entanglement). Left: a one-way freeze of the base URI |
| **O7. Metadata refresh** | Open | Emit ERC-4906 `MetadataUpdate(tokenId)` when an opening is finalised so marketplaces re-fetch the image |
| The contract is not upgradeable | Accepted | A bug cannot be patched, and seeds in a broken deployment stay sealed forever. The config is immutable too |
| Rules are verifiable | Pass | `specHash` on-chain equals `keccak256(spec.json)`. Test: "records the hash of the spec it was built from" |
| Trust in Zama | Accepted | Confidentiality rests on the KMS threshold assumption; correctness of reveals rests on KMS signatures; liveness rests on the coprocessor, relayer and KMS |
| No royalties (ERC-2981) | Accepted | Not in the brief |

## 7. Front end, adapter and keys

| Check | Status | Evidence |
| --- | --- | --- |
| No private key in the repository | Pass | `.env` is git-ignored; `.env.example` has empty values. History checked before each commit |
| The web app holds no secret | Pass | Only `VITE_*` values reach the bundle: a mode, a public RPC URL, an address |
| The decryption permit is narrow | Pass | The game's contracts (DoNotOpen, cCROQ, cUSDC, Pantry, the flea market), one day, kept in memory only, dropped on account change |
| Nobody but the account can find its boxes | Pass | `boxesOf` returns `[]` for any address but the connected one; it needs that account's permit to decrypt its receipts |
| The session private key never leaves the page | Pass | Generated by the SDK in the page; only the public key and the signature go to the relayer |
| The app cross-checks what the chain reveals | Pass | `catFromRevealed` rebuilds the cat from the seed and warns if score or golden flag differ |
| Reads come from a public RPC the user did not choose | Accepted | A lying RPC can misreport state; it cannot make the wallet sign something else, and the wallet shows each transaction |
| Wrong network | Pass | The adapter asks the wallet to switch, and refuses to sign otherwise. Not exercised with a real wallet extension |
| **O9. Mainnet relayer key** | Open | The hosted mainnet relayer needs an API key that must stay server-side. The proxy in `apps/api` holds it; `RELAYER_API_KEY` and the credit price (`dno:credit-price` from Zama's plan) remain to be set |
| Nobody spends another wallet's relayer units | Pass | A user decryption carries the wallet's EIP-712 permit; an encrypted input names a wallet but proves nothing, so the proxy requires that wallet's permit as a bearer token before charging it `RELAYER_INPUT_UNITS`. Test: "refuses an input without a permit, or with someone else's: it would spend their units" |
| Free public decryptions cannot be farmed | Pass | Public decryptions are free to players and paid by the collection. The proxy sends each exact request to Zama once and replays its job and answer after (`public_decryptions`); a handle may be named in at most `RELAYER_PUBLIC_PER_HANDLE` (4) requests sent there, so reshuffling handles is bounded too. Tests: "sends each public decryption to Zama once…", "refuses a handle already sent to Zama in too many different requests" |
| Fresh wallets cannot farm the free allowance | Accepted | A wallet the index has never seen act on-chain or be sent a box gets `RELAYER_NEWCOMER_PER_DAY` (16, one mint) instead of 25. Set it to 0 on Zama's pay-as-you-go plan. Test: "gives a wallet the index has never seen act the smaller newcomer allowance" |
| A filed release form binds who signed what | Pass | `AcceptTerms` requires the message to name the address (fixed line format), a version and a 64-hex SHA-256 of the English text, and recovers the EIP-191 signer, which must be that address. Messages over 4,000 characters are refused. Test: "refuses a form signed by someone else, naming someone else, or not a form at all" |
| Replaying or re-sending a release form is harmless | Pass | One row per address and version; the first signature is kept and later ones change nothing. Re-posting someone's signed form only files what they already signed. `POST /v1/terms` is limited to 10 a minute per IP. Tests: "files a release form signed by the address it names, once", "files one release form per address and version, and keeps the first" |
| The API does not check the hash against a known text | Accepted | The signed message names the version and the hash; the record is evidence of what the wallet saw, not a check that it was the current text. A new version is shown and signed again |
| The terms shown are the terms signed | Pass | The hash is of `CLAUSES` in `apps/web/src/terms/terms.ts`; the English dictionary shows them, and in development the app warns in the console when a clause there differs. Translations are marked as such, with the English original one click away |
| A filed allow list claim binds the address that signed it | Pass | `AllowList.claim` requires the message to name the address (`allowListAddress`, fixed line format) and recovers the EIP-191 signer, which must be that address; messages over 1,000 characters are refused; `POST /v1/allowlist` is limited to 10 a minute per IP. Re-posting someone's signed claim only refreshes their own points. Tests: "refuses a claim signed by someone else or naming someone else", "files a claim signed by the address it names, and ranks it" |
| The allow list cannot be farmed cheaply | Accepted | Off-chain, from public facts only (`playerPoints`): each opponent counts once, beaten or faced; a duel between one address and itself counts nothing; openings are capped at 10. Several wallets of one player can still duel each other: on a test network that costs little, so the operator reviews the exported list before mainnet. Tests: "counts each opponent once and ignores duels against yourself" |
| The full allow list is not public | Pass | `GET /v1/allowlist` names every claimant: only with `ALLOW_LIST_ADMIN_TOKEN` (16 characters at least), refused when it is unset. One address's status is public, as its points come from public facts. Test: "lists every claimant only for whoever holds the token" |
| An X boarding pass proves the account that posted | Pass | The post must carry the pass's code, read through X's oEmbed; its author is the handle kept, whatever handle the link shows; a post verifies one pass; the token is stored hashed. Tests in `apps/api/test/xPass.test.ts` |
| A Discord boarding proves membership | Pass | `/board` counts only from the collection's server (`DISCORD_GUILD_ID`, the server id Discord signs into the interaction), with a code the pass's token asked for (15 minutes, used once), from an account at least 30 days old; one Discord account per pass. Tests: "ties the account that runs /board in the server to the pass, once per code", "lets a code expire, and keeps only the newest code of a pass" |
| **O30. X pass fairness** | Open | Follows are declared (X's follows cannot be read without a paid API) and X accounts are cheap to make. Discord accounts too, though one younger than 30 days cannot board, and a member can leave once the points are in. The operator reviews `GET /v1/xpass/all` before mainnet (and checks each `discordUserId` is still in the server); a captcha (Turnstile) on `POST /v1/xpass` would slow bots |
| Test network claims survive a redeploy | Pass | `allow_list_claims` is not a read model: a replay keeps it, a redeploy migration must not truncate it, and each claim keeps the best points it had. Test: "keeps the best points a claimant had, when the duels are gone" |
| Dependency pinning | Pass | `pnpm-lock.yaml` committed; the Relayer SDK is pinned to an exact version |
| Real wallet extension tested | Not done | The browser run used a local signing proxy behind an injected provider |
| Two-holder flows and `paidShake` / `claimEarnings` on Sepolia | Not done | Covered on the mock and in contract tests only |
| The hidden-owner contracts on Sepolia | Pass | Deployed 2026-10-01; both smoke tests ran through the real coprocessor, relayer and KMS |
| The chatbot's model key stays server-side | Pass | `GEMINI_API_KEY` is read by the API only and sent in a header, never in a URL or to a browser; the app calls `POST /v1/chat`. Test: "sends the rules, the manual and the conversation, with the key in a header" |
| The chatbot cannot burn the free quota or cost money | Pass | Per IP per day (`CHAT_PER_IP_PER_DAY`), per day in all (`CHAT_PER_DAY`) and per minute (`CHAT_RATE_PER_MINUTE`); a repeated first question comes from a cache; past a limit or when Gemini fails, the manual is quoted instead. The Google project has no billing. Tests in `apps/api/test/chat.test.ts` |
| The chatbot answers from the manual only | Accepted | The model gets only the manual and is told to ignore instructions in questions, give no financial advice and never ask for a key; a model can still be talked into nonsense. It sees no wallet, box or private data, and the chat says answers can be wrong |
| Players' questions go to Google | Accepted | On Gemini's free tier Google may use prompts to improve its products. The chat says so and warns never to paste a private key; only questions about a public game are sent, with no address or IP |

## 8. Process

| Check | Status |
| --- | --- |
| Unit tests on the FHEVM mock | Pass: 162 tests (the standard, the boxes, the croquettes, the ramp, the credits, the studio packs, the rats, the market hooks, the liquidity locker and the V3 seeding against Uniswap's own bytecode) |
| Every mechanic run on Sepolia through the real KMS | Pass for the previous version: `packages/chain-adapter/scripts/smoke.ts`; croquettes: `scripts/smoke-croq.ts`. Not done for the hidden-owner contracts |
| Optional Hardhat suite on Sepolia (`pnpm test:sepolia`) | Not done |
| Static analysis (Slither, Aderyn) | Not done |
| Fuzz or invariant tests (revenue plus earnings equal the cUSDC balance, status transitions, owner replay) | Not done |
| Coverage report | Not done |
| Source verified on Etherscan | Not done: needs `ETHERSCAN_API_KEY` |
| External audit | Not done |
| Compiler pinned | Pass: 0.8.27 in `hardhat.config.ts`. The sources say `^0.8.24`; pin them too before an audit |

## 9. Croquettes: Croq, ConfidentialCroq, Pantry

| Check | Status | Evidence |
| --- | --- | --- |
| The supply is fixed | Pass | `Croq` mints once in its constructor; no mint function, no owner. Test: "mints the whole fixed supply once, with no decimals and no way to mint more" |
| cCROQ is the unmodified OpenZeppelin wrapper | Pass | `ConfidentialCroq` only passes a name, symbol and URI to `ERC7984ERC20Wrapper` 0.5.3. Rate 1, 0 decimals. Test: "wraps 1:1 into a balance only its holder can read" |
| Nobody is allowed on a sealed weight, the reserve, the stashes or the burnt pile | Pass | `allowThis` on all of them, `allowTransient(…, cCROQ)` for transfers. The only extra grant: the feeder on their masked copy of today's totals (`_seen`). Nobody, the treasury included, is allowed on `_treasuryShare`. Tests: "lets nobody read a weight: not the holder, not the public", "keeps each claim private: only the claimer reads what arrived" |
| The books balance | Pass | A meal is split whole: treasury and fire round down, the reserve gets the rest. Every croquette the Pantry holds is in exactly one bucket. Tests: "eats it all: a fifth to the treasury, a fifth burnt, the rest back to the reserve", "keeps the books: the Pantry's balance is always reserve + treasury share + burnt" |
| The burnt pile never moves | Pass | `_burnt` is only ever added to. No function transfers it |
| Only the treasury is paid its share, in weekly sums | Pass | `collect` always pays the immutable `treasury`, whoever calls it, at most once per 7 days, then resets the bucket to an encrypted 0. A share readable after each meal would tell the treasury who fed which cat and how much. Test: "pays the treasury its share once a week, and lets nobody read it in between" |
| Only the holder's meals are served, only a sealed cat | Pass | `served = isOwner AND meals < mealsPerDay`, encrypted; a stranger's meal moves 0 and uses none of the day's meals. `status == Sealed` reverts in the clear. Test: "serves nothing, silently, to someone who does not hold the cat" |
| The Pantry may read ownership | Pass | It must be a trusted reader of `DoNotOpen`, set at deploy. Test: "refuses to read ownership unless the collection trusts the Pantry" |
| Two meals per cat per UTC day | Pass | `_mealsToday[tokenId]` counts the day's served meals, encrypted; a third moves 0, silently. Kept on the token, not the wallet. Test: "serves two meals a day, then nothing until the next UTC day" |
| At most 1,000 croquettes per cat per UTC day | Pass | `min(offered, maxEatenPerDay − eatenToday)` in FHE before the transfer; the rest stays in the wallet, without a revert. Test: "caps what a cat eats at 1,000 a day, in one meal or spread, and cuts the rest silently" |
| A feeder short of funds moves 0, without a revert | Accepted | That is the ERC-7984 transfer semantics, and it hides balances. Side effect: the holder's meal of 0 still uses one of the day's two meals. Test: "moves nothing, silently, when the feeder holds too little" |
| Operator grant and input binding | Pass | `setOperator(pantry, until)` lets the Pantry pull only in `feed`, from `msg.sender`; `FHE.fromExternal` binds the proof to (Pantry, `msg.sender`). The app should pick a finite `until`. Test: "requires the Pantry as operator and an amount made for the caller" |
| The weight is frozen before it is made public | Pass | `feed` requires `Sealed` and `weigh` requires `Revealed`: once an opening is finalised the cat takes no meal, so the weight cannot change between the weigh-in request and its proof |
| Weigh-in once, after the reveal, with a valid proof | Pass | `weigh` requires `Revealed` and `NOT_WEIGHED`; `finalizeWeigh` requires `WEIGH_PENDING` and `FHE.checkSignatures`. Tests: "weighs once, only after the reveal is final", "rejects a forged weight", "weighs a cat that never ate on the spot, as thin" |
| Nobody can aim for the tolerance | Pass | `tolerance = sickMinWeight + keccak256(seed) % sickWeightSpread`; the seed is encrypted until the reveal, after which the cat cannot eat. Shakes and duels reveal trait bytes only, not the whole seed. Test: "makes a cat sick past a tolerance of its own, drawn from its seed" |
| Builds and diseases follow the spec | Pass | `buildFloors` and disease bounds are checked increasing in the constructor. Tests: "publishes the weight, and the build it reaches", "rejects parameters that would break the accounting" |
| Welcome bag once per box, not per wallet | Pass | `lastPurr != 0` after the first claim, kept across transfers. Test: "pays the bag to the box, not the wallet: a box that changes hands gets no second bag" |
| An empty id gets no bag and no purr | Pass | `claim` masks each due with `isOwner(id, address(0))`: a 0-box mint costs only gas and creates ten ids nobody holds, whose stashes could never be claimed. Test: "pays nothing into an empty id, so free empty ids cannot drain the reserve" |
| Bags and purrs go to the box, then its holder | Pass | `claim` pays dues into `_stash`, then `select(isOwner, stash, 0)` to the caller. A stranger's claim moves the clocks and fills the stashes, and gets 0. Tests: "pays one welcome bag per box into the box, and the boxes' holder takes it", "keeps a box's bag in the box when a stranger asks for it" |
| Purr days and cap | Pass | Test: "pays for the days owed, up to the cap, and keeps a started day" |
| The reserve cannot be overdrawn | Pass | `le(totalDue, reserve)`: the reserve pays a whole claim or none of it. Test: "never pays more than the reserve holds" |
| The purr draw is unpredictable and cannot be retried | Pass | `FHE.randEuint8()`; the claimer learns the amount only after the transaction |
| Draw bias | Accepted | A byte modulo 5: 0 has probability 52/256, the others 51/256 |
| `block.timestamp` for days and halvings | Pass | A producer can shift it by seconds; days are counted whole |
| Overflow in `mul` before `div` | Pass | Amounts are bounded by the 20M supply; `amount × 10,000` stays far below 2^64. A weight is bounded by the supply too |
| HCU per transaction | Pass | Largest: a 10-box claim, ~14.8M of 20M; `feed` ~3.7M. Budgets pinned in tests: "stays within the HCU budget for a full claim", "stays within the HCU budget" |
| Bounded loops | Pass | `claim` loops over at most `maxBoxesPerClaim` (10) |
| Parameters cannot break the accounting | Pass | The constructor rejects shares above 100% and zero periods. Test: "rejects parameters that would break the accounting" |
| No admin on the Pantry | Accepted | No owner, no pause, no upgrade. Parameters are immutable; a change means a new Pantry |
| Unwrap reveals the amount | Accepted | By design of the wrapper: plain tokens move in the clear. Test: "moves hidden amounts between players and unwraps back to plain CROQ" |
| `fund` amounts are public | Accepted | They move as a plain ERC-20 first |
| **O11. Reserve unreadable** | Open | Decide whether to publish the reserve from time to time (a public decryption), or show a warning once claims start paying 0. A claim the reserve cannot pay still uses up the box's welcome bag and purr days: keep the due in the stash as an IOU, or accept |
| **O12. Shared reserve** | Open | Ring-fence the 1M welcome bags in their own bucket if every box must get one |
| **O13. Treasury custody** | Open | The market's liquidity is locked in `LiquidityLocker` at deploy (done). Move the treasury, and the locker's ownership and beneficiary, to a multisig before mainnet |
| **O14. Regulation** | Open | Testnet only. Legal advice before any mainnet market |
| Static analysis, fuzzing of the bucket invariant | Not done | |

## 10. The market's liquidity: LiquidityLocker

The CROQ/USDC market is one Uniswap V3 position holding only CROQ (no USDC from the
creator), from 0.001 USDC per CROQ up to 1,000 times that, at the 1% fee tier. The
position's NFT is held by `LiquidityLocker`. Tests in `test/LiquidityLocker.ts` run against
Uniswap's own V3 bytecode (factory, position manager, router, quoter) deployed in Hardhat,
with CROQ as token0 and as token1.

| Check | Status | Evidence |
| --- | --- | --- |
| No path takes liquidity out | Pass | The locker has no function that calls `decreaseLiquidity`, `burn` or a transfer of the NFT; its whole ABI is pinned. Tests: "has no way to take liquidity out", "lets nobody take the liquidity out, the deployer included" |
| Only the position manager's NFTs are accepted | Pass | `onERC721Received` reverts `NotPositionManager` for any other sender. Test: "takes no NFT but the position manager's" |
| Fees go to the beneficiary only, whoever calls | Pass | `collect(positionId)` passes `beneficiary` as the recipient; the liquidity does not change. Tests: "sends trading fees to the beneficiary, leaving the liquidity", "follows the beneficiary when the owner changes it" |
| The owner can only redirect fees | Accepted | `setBeneficiary` (never to address 0) under `Ownable2Step`. A compromised owner key redirects future fees, never the liquidity. See O13 |
| The position takes no USDC | Pass | `seedSingleSided` mints with `amount{quote}Desired = 0` and checks the `IncreaseLiquidity` event took 0 of it. Test: "takes CROQ only, and the locker holds the position" |
| CROQ never sells below the start price | Pass | The range starts at the pool's opening price; a sale only returns USDC buyers put in. Tests: "buys nothing back before anyone has bought", "never sells back below the start price" |
| A pool opened first at another price is not seeded | Pass | `seedSingleSided` compares the pool's `sqrtPriceX96` with the plan's and stops. Test: "refuses to seed a pool someone opened at another price" |
| Tick math matches Uniswap's | Pass | `sqrtRatioAtTick` is a bit-for-bit port of `TickMath`; tests put real pools exactly on a dozen ticks, and one unit lower on the tick below |
| Front-running the pool's creation | Accepted | Anyone can create the CROQ/USDC pool between the `Croq` deployment and the seed. The deploy then stops instead of seeding at the wrong price; a redeploy of `Croq` (new address) gets around it |
| A seller can push the pool's price below the range | Accepted | Nothing trades there: the next buyer crosses the empty ticks for free and still pays at least the start price. The adapter and the API hold the reported price at the range's edge |

## 11. Review of 2026-10-03

A security pass over every contract, by the same authors, with two independent read-throughs.
No path to steal funds was found. Each fix below comes with the test that fails without it.

| Finding | Severity | Status | Fix and test |
| --- | --- | --- | --- |
| Free empty ids drain the Pantry reserve: a 0-box mint costs only gas, and `claim` paid each of its ten empty ids a welcome bag, then purrs, into stashes nobody can claim | High | Fixed | `claim` masks dues with `isOwner(id, address(0))` (the Pantry is a trusted reader). Test: "pays nothing into an empty id, so free empty ids cannot drain the reserve" |
| The owner reads each mint's quantity: `_revenue` was re-allowed to the owner on every change, so two reads around a `MintPlaced` gave `quantity × price`, and so who bought which ids | High | Fixed | Nobody is allowed on `_revenue`; `withdraw` at most once per 7 days. Tests: "lets nobody read the revenue, the owner included…", "pays the revenue out at most once a week…" |
| A challenger escapes an accepted duel: the outcome is public at acceptance, and a second proven posting of the same box cancelled the `Pending` duel | Medium | Fixed | The new posting gives way (`Cancelled`; the adapter reports `DuelPending`). Test: "lets an accepted duel run to its end…" |
| The treasury reads every meal: `_treasuryShare` was re-allowed to it on each meal, giving who fed which cat and how much | Medium | Fixed | Nobody is allowed on it; `collect` at most once per 7 days. Test: "pays the treasury its share once a week, and lets nobody read it in between" |
| A refund after a withdrawal wraps the revenue around (`_revenue − fee` below 0), and the next withdrawal pays 0 and loses every sale in between | Medium | Fixed | An opening's fee is held apart until it settles: revenue when the box opens, refunded otherwise. Test: "holds an opening's fee until it settles, and pays a refund without touching the revenue" |
| A paid shake of an empty id leaves the holder's 70% in a box nobody can claim | Low | Fixed | The whole fee is revenue for an empty id. Test: "keeps no holder's share in an empty id, where nobody could ever claim it" |
| `DecryptionCredits` accepted a price of 0: free credits, and the relayer bill without limit | Low | Fixed | `ZeroPrice` at deploy and in `setPrice`. Test: "refuses a price of 0, at deploy and later…" |
| One public proof of holding lets anyone follow the box (O19) | Medium | Fixed, opt-in | Only the holder can send a transfer `from` themselves, so after an opening, an alive check, an entanglement or a duel names the holder, their next transfer of that box was certainly real. The standard now has `confidentialTransferIf(to, id, really, proof)`: with `really` false it moves nothing yet looks like any transfer. The app's "send decoys" box sends three to random addresses, in a random order with the real one, from one encryption. Optional, as each decoy costs a transaction (~278k gas, ~225k HCU); without it the old advice stands (receive at a fresh address). Test: "sends a decoy when the holder says so…" |
| The app names the caller's boxes (O20) | Medium | Claims fixed, meals open | The contract treats a stranger's claim or meal like a holder's, but the app claimed for and fed only the caller's own boxes. Claims (`Pantry.claim`, `claimEarnings`) now name whole windows of ten ids (0-9, 10-19…), always the same, so claims cannot be intersected down to the boxes held (`claimWindows` in the adapter). Meals still name the box: a decoy meal costs ~3.7M HCU, so at most 4 fit in a transaction. Accepted for now and documented |
| Entanglement proposals can be overwritten (O21) | Low | Open | Key proposals by proposer and pass the proposer to `acceptEntangle` (an ABI change and a few bytes `DoNotOpen` does not have) |
| The milestone bit can be replaced before its proof lands (O22) | Low | Open | Each free empty mint writes a new bit. Keep a bit once it is true, or accept a proof for any bit of the same milestone |
| Supply probing near sell-out (O23) | Low | Accepted | A mint past the cap is free and tells the buyer it failed. Inherent to "all or nothing" |
| A pending opening shows the seed while the box still reads `Sealed` (O24) | Low | Open | The holder can feed up to the tolerance, or sell a box whose contents are known, until someone finalises. Draw the tolerance from its own encrypted random, and flag boxes with a pending opening |
| `LiquidityLocker.positions()` can be spammed (O25) | Low | Open | Accept positions from the owner only, or index the `Locked` event instead of the array |
| The owner can freeze the Pantry with `setTrustedReader(pantry, false)` | Low | Accepted | Extends O15: same multisig and timelock |

These fixes are on the branch, not on Sepolia: the deployment listed above still runs the
code reviewed before them, until the next redeployment.

## 12. The flea market: FleaMarket

`FleaMarket.sol` sells boxes, cats and rats between players, in cUSDC, with escrow, public
asking prices and secret offers (see [FLOWS.md](FLOWS.md#the-flea-market)). Not deployed on
Sepolia yet. 31 tests in `test/FleaMarket.ts`, on the FHEVM mock, against the real
`DoNotOpen`, `DoNotOpenHooks` and `Rats`.

| Check | Status | Evidence |
| --- | --- | --- |
| Only a seller who held a box gets an active listing | Pass | `list` pulls the box with `confidentialTransferFrom` (as the seller's operator) and `finalizeListing` settles on the decrypted "arrived" bit: `Refused` when nothing moved. Tests: "lists a box in two steps…", "refuses a box the seller does not hold, and moves nothing", "needs the market to be the seller's operator on the boxes" |
| An item cannot be listed twice | Pass | The market holds it once active: a second box listing never arrives, a second rat listing reverts in `transferFrom`. Test: "cannot list a box twice: once escrowed, a second listing never arrives" |
| Escrowed items leave only to their buyer or back to their seller | Pass | `_deliver` is called from `finalizePurchase` (`Done`), `acceptOffer` and `cancelListing` (seller only), each after the status left `Active`. No admin path moves an item or cUSDC. Tests: "sells a rat at the asking price…", "gives the item back on cancel…", "sells a cat (an opened box), and the cancel of a box gives it back" |
| A buyer who cannot pay loses nothing | Pass | The cUSDC pull is all-or-nothing; `Unpaid` sends nothing back because nothing arrived, and the listing stays open. Test: "takes nothing from a buyer who cannot pay, and keeps the listing open" |
| A buyer beaten to the item, or by a reprice, cancel or state change, is refunded in full | Pass | `Missed` pays back `paid`, exactly what arrived. Tests: "gives the item to the first purchase settled and refunds the others in full", "reprices for the seller only, and refunds purchases placed at the old price", "refuses a box whose public state changed in escrow, and refunds a purchase placed before" |
| Offers are refunded in full, whatever became of the listing | Pass | `withdrawOffer` (the buyer, while `Open`) pays back the escrowed amount, after a sale, a cancel or a state change. Tests: "lets losing offers be withdrawn after the sale, in full", "an offer may also lose to a purchase at the asking price" |
| Re-entrancy | Pass | `ReentrancyGuard` on every function that moves tokens (`list`, `cancelListing`, `buy`, `finalizePurchase`, `makeOffer`, `withdrawOffer`, `acceptOffer`); statuses change before any transfer; `reprice` and `finalizeListing` move nothing. Rats are sent with `transferFrom`, never `safeTransferFrom`, so no receiver hook runs |
| A decryption proof cannot be replayed or borrowed | Pass | `finalizeListing` and `finalizePurchase` take their handle from storage (`arrived`, `ok`), check it with `FHE.checkSignatures`, and settle once (`ListingNotPending`, `PurchaseNotPending`). Tests: "refuses an arrival proof meant for another listing", "settles a purchase once, and only with its own proof" |
| The encrypted fee cannot overflow | Pass | An offer is capped with `FHE.min(amount, MAX_PRICE)` before the pull; `MAX_PRICE` (10^12) × `MAX_FEE_BPS` (1,000) < 2^64. Asking prices are checked in the clear (`BadPrice`). Test: "caps an offer at the maximum price, under encryption" (with the fee at 10%) |
| An offer's amount is readable by its buyer and the seller only | Pass | `allowThis`, `allow(buyer)`, `allow(seller)`; `OfferMade` has no amount and `Sold` reports 0 for a sale by offer. Tests: "escrows an encrypted amount only the buyer and the seller can read", "sells on acceptance at the secret price, and never makes the price public" |
| A box is sold in the public state it was listed in | Pass | `DoNotOpenHooks.beforeList` snapshots status, partner and vet check; `buy` and `acceptOffer` revert `StateChanged` when it moved. `finalizePurchase` asks through `try/catch`, so a failing hook settles `Missed` instead of blocking the refund. Test: "refuses a box whose public state changed in escrow, and refunds a purchase placed before" |
| Paid-shake earnings follow the box | Pass | They stay in the box while it is escrowed and go to whoever claims as its holder, the buyer. Test: "keeps a box's paid-shake earnings in it for whoever buys it" |
| The owner's powers | Accepted | `setFee` (at most `MAX_FEE_BPS`, 10%) and `setTreasury` (never zero), single-step `Ownable`: the same key questions as O5. A fee raised between a buyer's look and the settlement applies to the seller's share, never to the buyer's price. Test: "lets only the owner change the fee, up to 10%, and the treasury" |
| An active box listing shows the seller held the box; a sale names the buyer | Accepted | By design; documented in `HIDDEN_OWNERS.md` §5b. A buyer who wants doubt again sends the box on with decoys |
| A box with a pending opening can be listed as sealed (O29, extends O24) | Open | The snapshot reads `status`, which stays `Sealed` until `finalize`, while the seed is already public. Flag boxes with a pending opening in the snapshot, or in the app |
| Losing offers stay escrowed until their buyer withdraws them | Accepted | Nothing pushes refunds, so a sale cannot be blocked by a buyer's wallet. The app lists the account's offers to withdraw |
| A purchase whose proof never comes keeps the buyer's cUSDC | Accepted | Anyone may send `finalizePurchase`; the adapter's `pendingPurchases` and `finishPurchase` pick it up |
| Static analysis, fuzzing | Not done | |

## 13. The whitelist's gifts: WhitelistGifts and Rats.gift

`WhitelistGifts.sol` gives each wallet on the frozen whitelist its tier's gift once (see
[FLOWS.md](FLOWS.md#whitelist-gifts)). Not deployed yet: it opens on mainnet. 8 tests in
`test/WhitelistGifts.ts`, on the FHEVM mock, against the real `DoNotOpen`, `ConfidentialCroq`
and `Rats`; the giver role in `test/Rats.ts`.

| Check | Status | Evidence |
| --- | --- | --- |
| Only a wallet on the root, with its own tier, claims, and once | Pass | Leaf `keccak256(keccak256(abi.encode(msg.sender, tier)))` checked with `MerkleProof.verifyCalldata`; `claimed` set before any external call. Test: "refuses a second claim, another tier, a wallet off the list, and claims outside the window" |
| Claims only between the root and `closesAt` | Pass | `NotOpen` before the root and after `closesAt`. Same test |
| The root cannot change once someone claimed | Pass | `setRoot` reverts `RootAlreadySet` once `claimedCount` is not 0; owner only. Tests: "waits for the root, and lets the owner correct it until the first claim", and the refusals test |
| The croquettes stay in the tier's range and readable by the wallet only | Pass | `rem(randEuint16, span) + croqMin`; the constructor refuses a span over 16 bits. The amount is allowed by the cCROQ transfer to the wallet and the contract only. Tests: "gives first class an encrypted draw…", "gives business a box and no rat…", "refuses tiers whose range does not fit the draw" |
| The gift box is paid for, and lands with the wallet | Pass | `DoNotOpen.mint` pulls the price from the contract's cUSDC (operator set in the constructor), then `confidentialTransfer` to the wallet. Test: "gives first class…" checks the owner and the wallet's untouched cUSDC |
| Only the giver adopts free rats, outside the paid caps and the wallet limit, up to `maxGiftRats` | Pass | `NotGiver`, `SoldOut`, `AlreadyAdopted`; `setGiver` owner only. Test: "lets only the giver adopt free rats…" |
| Re-entrancy | Pass | `claimed` is set before the calls; the callees are the collection's own contracts (`ConfidentialCroq`, `DoNotOpen`, `Rats`, which mints with `_mint`, no receiver hook) |
| The owner takes back what is left only once claims are over | Pass | `sweep` reverts `StillOpen` before `closesAt`. Test: "gives back what is left to the owner once claims are over" |
| A short contract gives 0 croquettes or no box, silently | Accepted | ERC-7984 semantics. The deploy script funds the most the tiers can draw (425,000 cCROQ) and one mint price per box |
| HCU | Pass | First class (draw, cCROQ transfer, box mint and transfer, rat): ~3.4M of 20M. Test: "stays under the HCU limit for the biggest gift" |
| The gift box's first holder is public (O31) | Accepted | Documented in `HIDDEN_OWNERS.md` §5c |
| Static analysis, fuzzing | Not done | |

## 14. The rats' powers and tricks: Rats, RatTricks and the shake guard

`Rats` draws each rat an encrypted power (1, 2 or 3) at its mint; `RatTricks` uses it for
sniffs (a paid shake with a hidden rebate for power 1) and tricks (a shield or a jam on a box,
see [FLOWS.md](FLOWS.md#the-rats-tricks-sniff-shield-jam)). `DoNotOpen` passes every shake
through its `guard`. 17 tests in `test/RatTricks.ts` on the FHEVM mock, against the real
`DoNotOpen`, `DoNotOpenConfig`, cUSDC and `Rats`; costs in `test/Costs.ts`.

| Check | Status | Evidence |
| --- | --- | --- |
| The power is drawn under encryption, after the payment, readable by the holder only | Pass | `randEuint16` folded with the spec's bounds; allowed to `Rats` and the minter; `allowPower` reverts `NotYourRat` for anyone but the holder; `powerFor` reverts `NotTricks` for anyone but `RatTricks`, and allows transiently. Tests: "draws 1, 2 or 3 at every mint…", "gives the whitelist's gift rats a power too" |
| Only `DoNotOpen` gets a box's masks through `filter` | Pass | `OnlyBoxes` for any other caller: anyone else could pass handles of their own and learn a mask. Test: "refuses opened boxes, and answers DoNotOpen alone" |
| An unpaid sniff cannot spend anyone's money | Pass | `RatTricks` holds no cUSDC at rest: `DoNotOpen` pulls only what the sniffer just paid in, so an unpaid sniff reads `NOT_YOURS`; the rebate is selected on "paid and power 1". Test: "reads nothing, and costs the treasury nothing, when the sniffer cannot pay" |
| The rebate never reverts a sniff | Pass | Skipped while the rebater has not made `RatTricks` its operator; a short treasury moves 0 (ERC-7984). Test: "skips the rebate while the treasury has not made the tricks its operator" |
| A shield gives strangers a stable fake, and the holder the truth | Pass | Fake rolls cut from a `noise` drawn when the shield starts. Test: "power 3 on one's own box shields every trait…" |
| A jam scrambles the holder only, power 2 one trait, power 1 nothing | Pass | Tests: "on someone else's box, jams the holder's own shakes", "power 2 jams only the trait picked", "lets power 1 bluff…" |
| Nothing public tells a shield from a jam, nor the power or the trait | Pass | Both slots rewritten by `select` on every trick, end times encrypted, trait an encrypted input, the event is the same for all. Leaks listed in O35 |
| A rat plays one trick every ten days, only for its holder | Pass | `readyAt`, `Recharging`, `NotYourRat`. Test: "rests a rat ten days between tricks…" |
| Opened boxes take no trick | Pass | `NotSealed` |
| The guard is trusted (O34) | Accepted | Owner only; documented in `HIDDEN_OWNERS.md` |
| HCU | Pass | Trick ~2.27M, sniff with a rebate ~4.27M, a paid shake through the guard ~2.84M of 20M. Test: "stays far under the HCU limit" |
| Static analysis, fuzzing | Not done | |

## Before mainnet

1. Decide O1, O2, O5, O6, O11 to O16, O20 to O25, O29, O32, O33. Fix O3, O4, O7, O17 (small and
   mechanical), and make room for O18.
2. Set the relayer key and the credit price from Zama's plan (O9).
3. Run the "Not done" rows of section 8.
4. Get an external audit, by a firm that has reviewed FHEVM contracts before.
5. Test with real wallets and two accounts on Sepolia.
