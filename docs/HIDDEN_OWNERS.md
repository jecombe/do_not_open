# Hidden owners

Who holds which box, how many boxes an account holds, and how many boxes were sold are
encrypted. This file explains how, what still leaks, what it costs, and why each choice
was made. The contracts are the source of truth:
[`IConfidentialERC721.sol`](../packages/contracts-evm/contracts/confidential/IConfidentialERC721.sol),
[`ConfidentialERC721.sol`](../packages/contracts-evm/contracts/confidential/ConfidentialERC721.sol),
[`DoNotOpen.sol`](../packages/contracts-evm/contracts/DoNotOpen.sol),
[`Pantry.sol`](../packages/contracts-evm/contracts/Pantry.sol), and for the sealed vault
[`SealedVault.sol`](../packages/contracts-evm/contracts/SealedVault.sol).

## 1. The standard: Confidential ERC-721

`DoNotOpen` is no longer an ERC-721. It implements `IConfidentialERC721`, written for this
project as a reusable base (`ConfidentialERC721`), ERC-165 id `0x87ffe7a2`.

| ERC-721 | Confidential ERC-721 |
| --- | --- |
| `ownerOf(id)` public | `confidentialOwnerOf(id)`: an `eaddress` nobody but the contract may decrypt |
| `balanceOf(account)` | none: nobody can count an account's tokens |
| `transferFrom` reverts unless the sender owns the token | `confidentialTransfer(to, id)` moves it if the sender holds it and does nothing otherwise; returns an encrypted `moved` bit. `confidentialTransferIf(to, id, really, proof)` also needs the caller's encrypted `really`: false sends a decoy |
| `Transfer(from, to, id)` | `ConfidentialTransfer(id, from, to, moved)`: `moved` readable by `from` and `to` only |
| `approve`, `setApprovalForAll` | `setOperator(operator, until)`, as in ERC-7984; no per-token approval, it would name the owner |
| anyone calls `ownerOf` | `isOwner(id, account)` returns an `ebool`, only to the account, its operators, or contracts the collection trusts (the Pantry) |

The rule that makes it work: **nothing reverts on ownership**. A transfer, a shake or an
opening by someone who does not hold the box does nothing, and only that person learns it.
So every attempt is a "maybe" to everyone else, and a stranger can make as many decoy
attempts as they like.

### Finding your boxes

There is nothing to enumerate. An account reads the `ConfidentialTransfer` events that
name it as `from` or `to`, decrypts their `moved` bits (it is the only one, with the other
side, allowed to), and replays them in order: a moved `to` adds the box, a moved `from`
removes it. Decoys never move anything, so they change nothing. The chain adapter does this
in `boxesOf`; in the app it costs one decryption signature per visit ("Show my boxes"), and
later looks only read new blocks.

A backend cannot do this for someone else. There is no "boxes of address X" endpoint.

## 2. Minting with a hidden quantity

```solidity
function mint(externalEuint8 quantity, bytes proof, uint8 ids) returns (uint256 firstTokenId)
```

- The quantity is encrypted in the buyer's browser. `ids` (1 to 10, public) is how many token
  ids the mint creates; the buyer owns the first `quantity` of them, the rest are empty
  (owner `address(0)`). From outside, a real box and an empty one look the same: same events,
  same seed draw, same storage.
- The price is paid in cUSDC, encrypted: `quantity × mintPrice`. A cUSDC transfer moves all of
  it or nothing, so a buyer who holds too little gets 0 boxes and pays 0.
- The sold count is an encrypted `euint16`. The cap, the last milestone (9,000), is enforced
  under encryption: a mint that would pass it gets nothing and pays nothing (all or nothing,
  never a partial mint). The other 1,000 boxes of the 10,000 supply are the whitelist's gifts
  (section 5c), never sold.
- The buyer reads what they got from the `MintPlaced` event's encrypted `quantity` and from
  their `ConfidentialTransfer` receipts.

Token ids therefore run past 10,000. `buildBoxSpec` accepts any 32-bit id.

**Choosing `ids`.** More ids hide the quantity better and cost more gas (about 174,000 per
id). One id says "this buyer bought one". The app defaults to 10 and lets the buyer go lower.

**Paying from plain USDC.** The contract only takes cUSDC. With `pay: "usdc"` the app shields
the exact price first, publicly, which shows the quantity. The app says so and recommends
shielding a round amount ahead of time.

## 3. Milestones instead of a counter

`spec.json` lists the only sold counts ever announced: 100, 500, 1,000, 2,500, 5,000, 7,500,
9,000. `DoNotOpenConfig` holds them (`milestones()`); the last one is the sale's cap, and what it
leaves under `maxSupply` is the whitelist's gift boxes (`giftBoxes()`, 1,000), which count in no
milestone. After each mint the contract makes one bit publicly decryptable: "the sold
count reached the next milestone". Anyone proves it with `announceMilestone(cleartext, proof)`,
which bumps `milestonesReached` and emits `MilestoneReached(index, sold)`. The app announces
it right after the mint that crossed it. Reaching the last one means sold out.

What leaks: which mint crossed a milestone (its bit decrypts to true). Nothing between two
milestones.

## 4. Game actions without revealing the holder

| Action | Who | How ownership is checked | What becomes public |
| --- | --- | --- | --- |
| `shake` | anyone | the trait is masked by `isOwner`: a non-holder reads `NOT_YOURS` (255) | that someone shook |
| `paidShake` | anyone, 2.5 cUSDC | masked by "paid"; 70% of the fee goes into the box (`_earnings`, encrypted), unless nobody holds it (an empty id), when it is all revenue | that someone paid to shake |
| `claimEarnings(ids)` | anyone | each box pays `select(isOwner, earnings, 0)` | that someone claimed for these ids; the app names whole windows of ten ids |
| `feed` (petting) | anyone, 0.5 cUSDC | an unpaid feed adds nothing | that someone fed; the count is no longer kept |
| `observe` | holder, 1 cUSDC | request: `ok = holds AND paid`, seed and affection masked by `ok` | the cat, and that the opener held the box |
| `proveAlive` | holder | request: `holds`, and `alive AND holds` | one bit, and that the caller held the box |
| `proposeEntangle` | anyone | none yet | the proposal |
| `acceptEntangle` | holder of B | request: proposer holds A AND caller holds B | the link, and both holders |
| `postDuel` | holder of A | `posted = caller holds A`, publicly decryptable; only a proven posting goes on the duel shelf, and it gives way to an accepted duel of the same box still waiting for its outcome | that the caller holds A; a void duel otherwise, which shows nothing |
| `acceptDuel` | holder of B | `aHolds = challenger still holds A`, `valid = aHolds AND accepter holds B`; outcome masked by `valid` | five values: aHolds, valid, who won, which trait, the loser's roll. A void duel shows only that A left its challenger; a reopened one only that the accepter did not hold B |
| `confidentialTransfer` | anyone | the transfer itself | that a transfer was attempted |
| `confidentialTransferIf` | anyone | the transfer, and the caller's encrypted `really` | that a transfer was attempted, and that it may be a decoy |

**Requests.** What must become public is a request in two steps, like every decryption in
this project: the request computes the encrypted answers and makes them publicly decryptable;
anyone then calls `finalize(requestId, cleartexts, proof)`, which checks the KMS signatures
against the handles stored at the request. A request by someone who does not hold the box
settles `Refused` and decrypts to zeros, so it reveals nothing about the box. There is no
"Observing" state any more: a box is `Sealed` until an opening is finalized.

An opening publishes the opener: `Observed(tokenId, openedBy, …)`. The leaderboard ranks
opened cats and the players who opened them, the only holders that are ever public.

**Duplicate handles.** A public decryption refuses the same handle twice in one request. An
opening of two entangled boxes that were never fed would publish two identical "zero
affection" handles, so an unfed box publishes no affection; `Request.fed` says which.

## 5. The Pantry

The Pantry asks `DoNotOpen.isOwner` as a trusted reader (`setTrustedReader`, set at deploy).

- **Meals.** Only the holder feeds, but the check is encrypted, and so are the meals-per-day
  count and the amount. A meal past the limits, or from a non-holder, moves 0, silently. The
  feeder can read back today's meals and croquettes eaten (`todayHandles`): the real figures
  if they hold the cat, zeros otherwise. The public meal count is gone.
- **Welcome bags and purrs** go into the box (`_stash`, encrypted), whoever calls `claim`.
  The app claims whole windows of ten ids (0-9, 10-19…), always the same ones, never the
  held boxes alone (see §6).
  The caller then receives the stashes of the boxes they hold, and 0 for the others. So a
  stranger cannot spend a holder's day, and the contract treats a stranger's claim like a
  holder's. The reserve pays a whole claim or none of it (one `le` instead of a `min` per
  box). An id nobody holds (`isOwner(id, address(0))`, a mint's empty ids) gets no bag and
  no purr: free empty ids would otherwise drain the reserve into stashes nobody can claim.
- **The treasury's share** of each meal is readable by nobody, the treasury included, and
  `collect` sends it at most once a week. Readable after each meal, it would tell the
  treasury who fed which cat and how much.

The same rule holds in `DoNotOpen`: nobody may read the cUSDC revenue, the owner included,
and `withdraw` runs at most once a week. A revenue readable after each transaction would
give each mint's quantity, and so who bought which ids.

## 5b. The flea market

`FleaMarket` sells boxes between players without asking who holds them. A seller makes the
market their operator (`setOperator`) and lists; the market pulls the box with
`confidentialTransferFrom`, which never reverts, and the "arrived" bit is decrypted in public
(`finalizeListing`). So:

- **An active box listing proves the seller held the box** at that moment, like an opening
  or an alive check. A refused listing shows that the caller did not hold it, which a
  stranger's listing attempt can show about themselves only.
- **While it is for sale, the market holds the box**, through the same encrypted owner slot
  as anyone. The seller cannot send it, shake it as its holder or claim its earnings; paid-shake
  earnings keep piling up in the box and go to whoever holds it at `claimEarnings`, the buyer.
- **A sale names the buyer** (`Sold`), and the market's transfer to them certainly moved the
  box: the buyer is a proven holder, and their next transfer of it is certain too (see the
  public proof below). A buyer who wants doubt again sends it on with decoys.
- **A purchase at the asking price shows whether the buyer could pay** (one bit, decrypted in
  public), not their balance.
- **The price of a sale by secret offer is never public**: only the buyer and the seller can
  decrypt the escrowed amount. What is inside a sealed box stays sealed through a sale.

Rats have public owners anyway; selling one shows nothing new.

## 5c. The whitelist's gifts

`WhitelistGifts` has `DoNotOpen` mint a gift box for the wallet with `gift(wallet)`: free, out of
the 1,000 boxes the sale leaves, only for the collection's `giver`, never in a milestone or the
revenue. `BoxGifted(tokenId, wallet)` names the wallet, and its tier is in its claim
(`GiftClaimed`): **a gift box's first holder is public**, as if they had minted one box among
one id. The usual advice holds: send it on with decoys, or to a fresh address, to bring the
doubt back. The rat is public anyway. The croquettes drawn are an encrypted cCROQ transfer:
allowed to the wallet and the gifts contract only, never published.

## 5d. The rats' powers and tricks

A rat stays a public NFT, but its power (1, 2 or 3) is encrypted in `Rats`: its minter can read
it, a buyer asks once (`allowPower`), and a seller keeps reading it, since an ACL grant is never
taken back. `RatTricks` uses it without ever publishing it.

A **trick** puts a rat on a box. Whether it shields (the caller holds the box) or jams (they do
not) is decided with `isOwner`, under encryption: `RatTricks` is one of the collection's trusted
readers, and the answer is allowed to the caller alone. Both effect slots are rewritten on every
trick and their end times are encrypted, so `TrickPlayed` reads the same for a shield, a jam or
a power-1 bluff. **A trick says nothing about who holds the box**, as a stranger's shake says
nothing.

What a trick does leak: the jammed holder sees `SCRAMBLED` and learns their box is jammed (not
by whom: many rats may sit on it); and a sniffer who reads a shielded trait, then reads it again
once the shield is over, sees it changed. A **sniff** is a paid shake made by `RatTricks`: the
`Shaken` event names `RatTricks`, its own `Sniffed` names the rat and the sniffer, as a paid
shake names its caller. The power-1 rebate is an encrypted cUSDC transfer from the treasury,
made on every sniff (0 for the other rats), so the rebate does not show which rats are cheap.

The guard is trusted: the owner sets it (`setGuard`) and it sees every shake's handles,
transiently. A malicious guard could falsify shakes; it cannot read them (it has no decryption
right). See O34 in [AUDIT_CHECKLIST.md](AUDIT_CHECKLIST.md).

## 5e. The sealed vault

`SealedVault` uses the same base for any NFT: a box per NFT of an allowed collection, its owner
an `eaddress`, transfers that never revert on ownership, and holders who find their boxes in
their own receipts. What it adds is a way to act **without sending anything from the holder's
address**. Each box has an encrypted key (`euint256`) that nobody may decrypt; a request to take
the NFT out, list it on Seaport, take the listing down, collect a sale's ETH, accept a buyer's
offer or name the NFT's delegate in delegate.xyz carries the key,
XORed with a hash of the request's terms and a per-box nonce, and the vault publishes only "the
key matched". Any wallet can send it: the API's relayer, so the holder's address shows on none.
A box that moves gets a random key, and its new holder sets theirs with `setKey`, a "maybe".

What it leaks, on top of what any `ConfidentialERC721` leaks: the deposit names the depositor
(a plain NFT transfer); the address an NFT or a sale's ETH is sent to; a request's sender when
it is not the relayer; `setKey`'s caller (not whether it took effect); a private sale's seller
and buyer (not its price, not whether the box moved: that is decided under encryption, readable
by the two sides only). A Seaport listing shows the NFT and the price with the vault as the
seller; an accepted offer, as any Seaport fill, its buyer and amount and where the ETH went. A
box's delegate is public: a fresh wallet says nothing about the holder, their main wallet would
name them. See [VAULT.md](VAULT.md).

## 6. What still leaks

| Fact | Visible to everyone |
| --- | --- |
| A mint | the buyer's address and how many ids it created: an upper bound on what they bought |
| Shielding USDC | the amount (cUSDC wrapping is public) |
| Unshielding cUSDC | the amount (decrypted in public to be paid out as plain USDC) |
| A transfer attempt | sender and recipient addresses, not whether it moved |
| A paid shake, a feed, a meal | that the caller did it. The contract treats a non-holder's the same way, but the app only feeds the caller's own boxes, so in practice a meal (`MealServed`) names a box the caller holds |
| A claim (`Pantry.claim`, `claimEarnings`) | the ids it lists. The app lists whole windows of ten ids, the same windows every time: "maybe one of these ten", as a mint of ten ids shows. Random padding would not do: claims made over months would intersect down to the boxes held |
| An opening, an alive check, an accepted entanglement, a proven duel posting, a valid duel, an active flea market listing | that the caller held the box at that moment |
| A milestone | which mint crossed it |
| Operator approvals | that an account made an address its operator |
| Signing the terms of play (off-chain, filed by the API) | that an address signed the terms: address, version, signature, time. Nothing about holdings |
| A flea market listing or sale (`FleaMarket`) | the seller of an active listing (so it held the box), the asking price, the buyer of a sale (now a proven holder), and for each purchase at the asking price whether the buyer could pay. Not the amount of a secret offer, nor the price of a sale by offer |
| An adopted rat (`Rats`, ERC-721) | who owns it and every transfer, as for any NFT, and the CROQ its owner claims from the `RatPantry`. Not its power. A rat says nothing about boxes, but an owner who also sniffs boxes ties those sniffs to the address that owns the rat (`Sniffed` names the sniffer, as a paid shake names its caller) |
| A rat's trick (`RatTricks.trick`) | the rat, the box, the player, until when and when the rat is ready again. Not whether it shielded, jammed or bluffed, nor the power or the trait. The jammed holder learns of the jam |
| A studio pack (`StudioPacks.buy`, plain USDC) | the payer, the account and the pack. The studio never touches the boxes, so it says nothing about holdings; the API also sees the prompts and pictures of the account that signed in, and sends the prompts to the AI services |
| The duel ranking and its rosettes | nothing new: boxes ranked by the outcomes `DuelResolved` already publishes, never by holder |
| Claiming a place on the mainnet allow list (off-chain, filed by the API) | that an address asked, and when. Its points come only from facts already public about it: the duels it fought as challenger or accepter (both parties of a valid duel proved holding their box) and the boxes it opened. Anyone can read any address's points (`GET /v1/allowlist/:address`), derived from those same public facts; nobody is ranked who did not claim |
| A whitelist gift (`WhitelistGifts.claim`) | that the wallet is on the frozen list, its tier, the gift box's id (the wallet held it then: `BoxGifted` names it) and its rat. Not how many croquettes it drew |
| The sealed vault (`SealedVault`) | the depositor of each NFT, the NFT in each box, Seaport listings and their buyers, buyers' offers (`VaultOffers`) and an accepted one's buyer and amount, a box's delegate, a request's sender (the relayer, or the wallet without one), action and terms, whether its key matched, where an NFT or a sale's ETH went, `setKey`'s caller, a private sale's seller and buyer. Not who holds a box, its key, a private sale's price, nor whether a private sale or a transfer moved it |
| An X boarding pass (off-chain, filed by the API) | the boarding tweet itself, public on X: that this X account wants a place. The wallet a player chooses to link to it stays in the API, never shown; that link ties an X identity to the wallet's public facts (duels, openings), so the page says a game-only wallet keeps a player anonymous. The Discord account that ran `/board` is kept the same way, private: the server's members can see that someone ran a command, not the code nor the reply. The pass whose referral link a pass started from is kept by the API too, never public (the code itself is, in the boarding tweet), and no route ranks the referrers |

An observer who follows an address can bound its holdings from above (ids it minted plus
transfers naming it), never know them.

**A public proof follows the box.** Only a holder (or their operator) can send a transfer
`from` themselves. So once an opening, an alive check, an accepted entanglement, a proven
duel posting, a valid duel or a flea market sale shows that an address held a box, that address's next transfer
of the box certainly moved it: the recipient holds it now, and their next transfer of it is
certain too. A stranger's decoys add no doubt on that path, since they do not come `from`
the holder.

The holder's own decoys do. `confidentialTransferIf(to, id, really, proof)` moves the box
only if `really`, encrypted by the caller, is true; with false it moves nothing, yet its event
and receipt look like any transfer. When giving a box away the app can send three decoys to
fresh random addresses, in a random order with the real transfer, all through
`confidentialTransferIf` and from one encryption. Then even someone who knows the box was
yours cannot tell which of the four moved it, or whether any did. Each receiver decrypts only
their own receipt. It is optional: each decoy is one more transaction (~278,000 gas). Without
decoys, the older advice holds: receive a box at a fresh address, and prove from an address
you never use to send or receive boxes (AUDIT_CHECKLIST O19).

## 7. Cost

Measured on the local FHEVM, which runs the same host contracts as Sepolia and mainnet
(`REPORT_COSTS=1 pnpm test test/Costs.ts` in `packages/contracts-evm`):

| Action | Gas | HCU |
| --- | --- | --- |
| mint, 1 box among 1 id | 1,001,000 | 1,885,000 |
| mint, 1 box among 3 ids | 1,290,000 | 2,203,000 |
| mint, 3 boxes among 5 ids | 1,652,000 | 2,521,000 |
| mint, 10 boxes among 10 ids | 2,560,000 | 3,316,000 |
| `confidentialTransfer` | 184,000 | 200,000 |
| `confidentialTransferIf`, each decoy or the real one | 278,000 | 225,000 |
| `shake` (no guard set / through `RatTricks`, a tricked box) | 424,000 / 554,000 | 899,000 / 1,415,000 |
| `paidShake` (no guard set / through `RatTricks`, a tricked box) | 899,000 / 1,014,000 | 2,171,000 / 2,842,000 |
| `claimEarnings`, 1 box | 419,000 | 1,082,000 |
| `feed` | 502,000 | 1,071,000 |
| `proveAlive` + `finalize` | 314,000 + 126,000 | 200,000 |
| `postDuel` (first score) + `finalizeDuel` | 585,000 + 139,000 | 1,468,000 |
| `acceptDuel` (first score) + `finalizeDuel` | 1,118,000 + 177,000 | 2,766,000 |
| `acceptEntangle` + `finalize` | 220,000 + 148,000 | 259,000 |
| `observe` + `finalize`, one box | 625,000 + 291,000 | 1,120,000 |
| `observe` + `finalize`, entangled pair | 828,000 + 411,000 | 1,230,000 |
| `Pantry.feed` | 1,205,000 | 3,683,000 |
| `Pantry.claim`, 3 boxes | 1,151,000 to 1,335,000 | 3,125,000 to 5,000,000 |
| `FleaMarket.list` (box) + `finalizeListing` | 341,000 + 94,000 | 200,000 |
| `FleaMarket.buy` + `finalizePurchase` (box) | 546,000 + 855,000 | 2,078,000 |
| `FleaMarket.makeOffer` | 543,000 | 736,000 |
| `FleaMarket.acceptOffer` (rat) | 677,000 | 2,414,000 |
| `WhitelistGifts.claim`, first class (croquettes, a free box, rat and its power) | 1,010,000 | 1,678,000 |
| `WhitelistGifts.claim`, economy (croquettes, rat and its power) | 740,000 | 1,571,000 |
| `RatTricks.trick` | 881,000 to 1,063,000 | 2,245,000 to 2,270,000 |
| `RatTricks.sniff` (a tricked box, power-1 rebate) | 1,789,000 | 4,269,000 |
| `FleaMarket.list` (rat) | 139,000 | 0 |
| `SealedVault.deposit` | 392,000 to 469,000 | 83,000 |
| `SealedVault.request` + `finalize` (withdraw) | 323,000 + 152,000 | 191,000 |
| `SealedVault.request` + `finalize` (list on Seaport) | 349,000 + 317,000 to 334,000 | 191,000 |
| `SealedVault.request` + `finalizeOffer` (accept a WETH offer) | 289,000 to 375,000 + 399,000 | 191,000 |
| `SealedVault.request` + `finalize` (delegate: first / replacing one) | 289,000 to 375,000 + 294,000 / 269,000 | 191,000 |
| `SealedVault.confidentialTransfer` (a new random key) | 209,000 to 266,000 | 338,000 |
| `SealedVault.setKey` | 185,000 | 225,000 |
| `SealedVault.acceptSale` (private sale) | 1,660,000 | 4,342,000 |

The `SealedVault` rows are not in `test/Costs.ts` yet: they were measured on the same local
FHEVM, against Seaport 1.5's bytecode, with `fhevm.computeTransactionHCU` (the rest in
[VAULT.md](VAULT.md#cost)).

Every transaction stays well under the protocol limits (20M HCU, 5M depth); a full 10-box
`Pantry.claim` measures about 14.8M HCU. The price in dollars is gas × gas price × ETH price:
at 1 gwei and 3,000 USD per ETH, 1,000,000 gas is 3 USD. On Ethereum mainnet a hidden mint is
a few dollars; on the cheaper chains Zama supports it is cents. Zama's protocol fees
(input proofs, decryptions) come on top on mainnet.

`DoNotOpen` is 24,442 bytes deployed, 134 under the 24,576 limit, compiled alone with the
optimizer at 1 run (size over gas; the other contracts stay at 200). The free gift path fit
by moving the token URIs to `BoxMetadata` and the milestones, supply and batch size views to
`DoNotOpenConfig`. The next feature should move logic out too (a library, or a second contract
that is a trusted reader).
