# Hidden owners

Who holds which box, how many boxes an account holds, and how many boxes were sold are
encrypted. This file explains how, what still leaks, what it costs, and why each choice
was made. The contracts are the source of truth:
[`IConfidentialERC721.sol`](../packages/contracts-evm/contracts/confidential/IConfidentialERC721.sol),
[`ConfidentialERC721.sol`](../packages/contracts-evm/contracts/confidential/ConfidentialERC721.sol),
[`DoNotOpen.sol`](../packages/contracts-evm/contracts/DoNotOpen.sol),
[`Pantry.sol`](../packages/contracts-evm/contracts/Pantry.sol).

## 1. The standard: Confidential ERC-721

`DoNotOpen` is no longer an ERC-721. It implements `IConfidentialERC721`, written for this
project as a reusable base (`ConfidentialERC721`), ERC-165 id `0x5f6463b8`.

| ERC-721 | Confidential ERC-721 |
| --- | --- |
| `ownerOf(id)` public | `confidentialOwnerOf(id)`: an `eaddress` nobody but the contract may decrypt |
| `balanceOf(account)` | none: nobody can count an account's tokens |
| `transferFrom` reverts unless the sender owns the token | `confidentialTransfer(to, id)` moves it if the sender holds it and does nothing otherwise; returns an encrypted `moved` bit |
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
- The sold count is an encrypted `euint16`. The cap is enforced under encryption: a mint that
  would pass 10,000 gets nothing and pays nothing (all or nothing, never a partial mint).
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
9,000, 10,000. After each mint the contract makes one bit publicly decryptable: "the sold
count reached the next milestone". Anyone proves it with `announceMilestone(cleartext, proof)`,
which bumps `milestonesReached` and emits `MilestoneReached(index, sold)`. The app announces
it right after the mint that crossed it. Reaching the last one means sold out.

What leaks: which mint crossed a milestone (its bit decrypts to true). Nothing between two
milestones.

## 4. Game actions without revealing the holder

| Action | Who | How ownership is checked | What becomes public |
| --- | --- | --- | --- |
| `shake` | anyone | the trait is masked by `isOwner`: a non-holder reads `NOT_YOURS` (255) | that someone shook |
| `paidShake` | anyone, 2.5 cUSDC | masked by "paid"; 70% of the fee goes into the box (`_earnings`, encrypted) | that someone paid to shake |
| `claimEarnings(ids)` | anyone | each box pays `select(isOwner, earnings, 0)` | that someone claimed |
| `feed` (petting) | anyone, 0.5 cUSDC | an unpaid feed adds nothing | that someone fed; the count is no longer kept |
| `observe` | holder, 1 cUSDC | request: `ok = holds AND paid`, seed and affection masked by `ok` | the cat, and that the opener held the box |
| `proveAlive` | holder | request: `holds`, and `alive AND holds` | one bit, and that the caller held the box |
| `proposeEntangle` | anyone | none yet | the proposal |
| `acceptEntangle` | holder of B | request: proposer holds A AND caller holds B | the link, and both holders |
| `challengeDuel` | anyone | none yet | the challenge |
| `acceptDuel` | holder of B | `valid = challenger holds A AND accepter holds B`; outcome masked by `valid` | four values: valid, who won, which trait, the loser's roll; or a void duel |
| `confidentialTransfer` | anyone | the transfer itself | that a transfer was attempted |

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
  The caller then receives the stashes of the boxes they hold, and 0 for the others. So a
  stranger cannot spend a holder's day, and a claim says nothing about what the caller holds.
  The reserve pays a whole claim or none of it (one `le` instead of a `min` per box).

## 6. What still leaks

| Fact | Visible to everyone |
| --- | --- |
| A mint | the buyer's address and how many ids it created: an upper bound on what they bought |
| Shielding USDC | the amount (cUSDC wrapping is public) |
| A transfer attempt | sender and recipient addresses, not whether it moved |
| A paid shake, a feed, a claim | that the caller did it, not whether they hold the box |
| An opening, an alive check, an accepted entanglement, a valid duel | that the caller held the box at that moment |
| A milestone | which mint crossed it |
| Operator approvals | that an account made an address its operator |

An observer who follows an address can bound its holdings from above (ids it minted plus
transfers naming it), never know them.

## 7. Cost

Measured on the local FHEVM, which runs the same host contracts as Sepolia and mainnet
(`REPORT_COSTS=1 pnpm test test/Costs.ts` in `packages/contracts-evm`):

| Action | Gas | HCU |
| --- | --- | --- |
| mint, 1 box among 1 id | 1,028,000 | 1,885,000 |
| mint, 1 box among 3 ids | 1,317,000 | 2,203,000 |
| mint, 3 boxes among 5 ids | 1,680,000 | 2,521,000 |
| mint, 10 boxes among 10 ids | 2,587,000 | 3,316,000 |
| `confidentialTransfer` | 184,000 | 200,000 |
| `shake` | 421,000 | 899,000 |
| `paidShake` | 889,000 | 2,029,000 |
| `claimEarnings`, 1 box | 419,000 | 1,082,000 |
| `feed` | 530,000 | 1,071,000 |
| `proveAlive` + `finalize` | 314,000 + 126,000 | 200,000 |
| `challengeDuel` (first score) | 497,000 | 1,351,000 |
| `acceptDuel` (first score) | 1,098,000 | 2,766,000 |
| `finalizeDuel` | 172,000 | 0 |
| `acceptEntangle` + `finalize` | 220,000 + 148,000 | 259,000 |
| `observe` + `finalize`, one box | 698,000 + 223,000 | 1,120,000 |
| `observe` + `finalize`, entangled pair | 901,000 + 343,000 | 1,230,000 |
| `Pantry.feed` | 1,230,000 | 3,683,000 |
| `Pantry.claim`, 3 boxes | 1,007,000 to 1,071,000 | 2,608,000 to 4,483,000 |

Every transaction stays well under the protocol limits (20M HCU, 5M depth); a full 10-box
`Pantry.claim` measures about 13M HCU. The price in dollars is gas × gas price × ETH price:
at 1 gwei and 3,000 USD per ETH, 1,000,000 gas is 3 USD. On Ethereum mainnet a hidden mint is
a few dollars; on the cheaper chains Zama supports it is cents. Zama's protocol fees
(input proofs, decryptions) come on top on mainnet.

`DoNotOpen` is 24,093 bytes deployed, close to the 24,576 limit. The next feature should move
logic out (a library, or a second contract that is a trusted reader).
