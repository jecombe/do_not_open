# Porting to Solana

## Where things stand

Checked against docs.zama.org on 2026-09-30: Zama's litepaper lists **"Solana support
(H2 2026)"** on its roadmap. There is no SVM program library, no SDK and no
documentation for confidential programs yet. The only Solana items in the docs today
are the ZAMA token's SPL mint, bridge and multisig addresses.

So this document is a map, not a recipe. The left column of each table is what exists
and runs today. The right column is what we expect to need, and every line of it has to
be re-checked against the real SDK when it ships. Where we are guessing, it says so.

## What does not change

```mermaid
flowchart LR
  subgraph keep["Unchanged"]
    spec["game-spec"]
    gen["generator"]
    scene["scene"]
    web["apps/web"]
    iface["ChainAdapter interface"]
    mock["MockAdapter"]
  end
  subgraph rewrite["Rewritten"]
    prog["Solana program<br/>replaces contracts-evm"]
    sa["SolanaAdapter<br/>next to EvmFhevmAdapter"]
  end
  spec --> prog
  prog --> sa --> iface --> web
```

About two thirds of the code base is on the left. That is what the package boundaries
were drawn for:

- `spec.json` is the rulebook for both programs. The Solana program loads the same
  numbers into a config account, and stores the same `specHash`.
- The generator decodes a revealed seed the same way whatever chain revealed it.
- The app only knows `ChainAdapter`. Its types were kept chain-neutral on purpose:
  accounts are opaque strings, amounts are `bigint` in the smallest unit with symbol and
  decimals reported by `collection()`, progress is four generic steps, errors carry a
  neutral code plus the program's own error name.

## The map

### Encrypted computation

| EVM / FHEVM today | Where | Expected on Solana | Confidence |
| --- | --- | --- | --- |
| `euint64`, `euint32`, `euint16`, `euint8`, `ebool`, `eaddress` handles in contract storage | `DoNotOpen.sol`, `ConfidentialERC721.sol` state | Ciphertext handles (32 bytes) stored in program accounts | High: handles are chain-agnostic identifiers |
| `eaddress` owner, `FHE.eq(owner, caller)` and `select` on it | every ownership check, transfers | An encrypted 32-byte public key and equality on it | Low: the whole hidden-owner design rests on it. Ask Zama |
| `externalEbool` input and `FHE.and` | `confidentialTransferIf` (a holder's decoys) | An encrypted bool input with its proof, and `and` on bools | Medium: needs encrypted inputs, as the hidden mint quantity does |
| `FHE.fromExternal` with an input proof bound to (contract, sender) | `mint` (the quantity), the Pantry | The same, bound to (program, signer) | Medium |
| `FHE.randEuint64()` and bounded `randEuintN(2^k)` | mint, shake, feed, duel | An encrypted-randomness instruction through CPI to Zama's program | Medium: must exist for the protocol to be useful; bounds may differ |
| `FHE.shr`, `select`, `ge`, `gt`, `lt`, `add`, `mul`, casts | shake, proveAlive, score, duel | The same operator set through CPI | Medium: check that encrypted-amount shifts exist; if not, the five trait bytes can be extracted with `and` + scalar shifts |
| Symbolic execution: the contract emits operations, the coprocessor computes | everywhere | Same model: the program records operations, a coprocessor computes off-chain | High: it is the protocol's architecture |
| HCU limit, 20M per transaction | batch size, duel split in two transactions | Solana compute units (1.4M max per transaction) **and** whatever FHE budget Zama defines | Low: re-measure everything. The first duel of two boxes already takes two transactions here |

### Access control and decryption

| EVM / FHEVM today | Where | Expected on Solana | Confidence |
| --- | --- | --- | --- |
| `FHE.allowThis(handle)` | after every computation | Allow the program, probably a PDA acting as its identity | Medium |
| `FHE.allow(handle, viewer)`, permanent | `_shakeFor` | Allow a wallet public key on a handle | Medium. If grants become revocable on Solana, nothing here needs it |
| No ACL on seed, score, affection or owner for any holder | design rule | Same rule. It is what makes transfers trivial | Ours to keep |
| `FHE.makePubliclyDecryptable` | observe, proveAlive, acceptEntangle, postDuel, acceptDuel, mint (the milestone bit) | A "mark public" instruction | Medium |
| `FHE.checkSignatures(handles, cleartexts, proof)` | `finalize`, `finalizeDuel`, `announceMilestone` | Verify KMS signatures inside the program | Low. See "transaction size" below |
| A public decryption refuses one handle twice | `observe` of two unfed entangled boxes | Unknown | Low: check, and keep publishing nothing for an unfed box |
| User decryption: EIP-712 permit signed with secp256k1, scoped to a contract and a duration | `EvmFhevmAdapter.permitFor` | A message signed with the wallet's ed25519 key (`signMessage`), scoped to a program id | Medium: the KMS must accept ed25519 |
| `publicDecrypt` / `userDecrypt` through the Relayer SDK | `EvmFhevmAdapter` | The same two calls in an SVM flavour of the SDK | Medium |

### Token and program model

| EVM today | Where | On Solana | Notes |
| --- | --- | --- | --- |
| Confidential ERC-721 inside the game contract | `DoNotOpen is ConfidentialERC721` | The encrypted owner stays in our own box account. A Metaplex or SPL asset has a public owner, which would undo the design: at most, every asset sits with a program PDA and the real owner is the encrypted handle | Ownership checks are encrypted comparisons, never a read of an asset account |
| `mapping(tokenId => ...)` | all state | One PDA per box: seeds `["box", collection, tokenId]` | Rent: the minter pays for the box account |
| `mapping(tokenId => mapping(viewer => Shake))` | `_shakes` | One PDA per (box, viewer): seeds `["shake", box, viewer]`, created on first shake, rent paid by the viewer | |
| `mapping(duelId => Duel)` | `_duels` | One PDA per duel: seeds `["duel", collection, duelId]`; can be closed after resolution to refund rent | |
| `_listing[tokenId]`, one duel on the shelf per box | `finalizeDuel` | A field in the box account | The older listing's duel account must be passed too, to cancel it, or to see that it was accepted and let the new posting give way |
| `_earnings[tokenId]` + `claimEarnings(ids)` | paid shake earnings | An encrypted handle in the box account, paid in the confidential token to whoever holds the box | Must stay per box: a per-holder account would name the holder |
| cUSDC `confidentialTransferFrom` that moves all or nothing | every paid action (`_pull`) | A CPI to the confidential token program, with the program as a delegate | The action stays masked by "paid == price"; no plain lamport fees, they would be public |
| `Ownable`, `withdraw`, `setBaseURI`, `setTrustedReader` | admin | An authority public key in the config account, ideally a multisig (Squads); trusted readers as a list of program ids | Nobody may read the revenue; `withdraw` at most once per 7 days, with the last time in the config account |
| `DoNotOpenConfig` contract, immutable | rules | A config account written once at initialisation, with `specHash` | |
| Events | `MintPlaced`, `ConfidentialTransfer`, `Shaken`, `RequestPlaced`, ... | Anchor events (program logs) | Same names and fields as `spec.events` |
| Custom errors | `NotSealed`, ... | Anchor error codes with the same names | The app's error copy is keyed on these names. Nothing reverts on ownership |
| `confidentialTransfer` needs no hook | ACL design | Same: no transfer hook needed | A hook would only be needed if a holder had ACL to move |
| Sequential token ids from `tokenCount`, empty ids included | mint | A counter in the collection account | Writes to one account serialise mints: fine at this scale |
| Encrypted sold count, milestone bit | mint, `announceMilestone` | Handles in the collection account | |
| Replay of the account's own `ConfidentialTransfer` receipts | `boxesOf` | The same replay over program events naming the account, decrypting each "moved" bit | DAS (`getAssetsByOwner`) cannot help: the owner is encrypted |
| `StudioPacks`: packs bought in plain USDC, `PackBought` | the studio | An SPL USDC transfer to the treasury in the same instruction that bumps the buyer's account (a PDA per buyer: `["studio", buyer]`) and emits the same event | No FHE: a straight port. The API's indexer reads the event the same way |
| `Rats` (ERC-721) and `RatPantry` (plain CROQ a day) | the studio's adopted rats | A Metaplex Core asset per rat (public owner), minted by the program after an SPL USDC transfer, with the attester's ed25519 signature checked for AI rats; the pantry a PDA token account paying plain CROQ, `paid_until` in a PDA per rat | No FHE: a straight port |

### Things that are structurally different

- **Accounts must be declared up front.** `observe` on an entangled box writes the
  partner's box account too, so the instruction must list it. The adapter reads
  `partner` first and passes both. Same for a duel: both box accounts and the duel account,
  plus, when a posting is proven, the duel account of the box's previous listing.
  A mint creates up to 10 box accounts, real and empty alike.
- **Transaction size.** A Solana transaction is limited to 1,232 bytes. A KMS proof is
  a set of signatures from the threshold parties; `finalize` carries the proof and
  the clear values (up to five, for an entangled opening or a duel's outcome). If that does not fit, the proof has to be written to a buffer account
  across several transactions and then consumed. This is the single largest unknown.
- **Signature verification cost.** Verifying secp256k1 or ed25519 signatures is done with
  the native precompile programs plus instruction introspection, not in program code.
  Zama's library will presumably wrap this.
- **Re-entrancy.** Solana forbids re-entering a program through CPI (except self-recursion)
  and caps CPI depth. The audit item changes shape: what matters is account validation
  (owner, seeds, signer), not call ordering.
- **No `view` functions.** Reads are account fetches and deserialisation in the adapter.
  `requestInfo` and `duelHandles` become a few lines of client code reading the request
  or duel account.
- **Two compute budgets.** Compute units for the program, plus the FHE budget.
- **Upgradeability.** Solana programs are upgradeable by default. The EVM contract is
  not. Decide explicitly, and say which in the collection's description.

## Program sketch

```mermaid
flowchart TB
  subgraph accounts["Accounts (PDAs)"]
    cfg["Config<br/>spec numbers, specHash, fees, milestones,<br/>authority, trusted readers"]
    col["Collection<br/>tokenCount, sold handle, milestone bit,<br/>milestonesReached, duelCount, requestCount"]
    box["Box<br/>owner handle, seed handle, affection handle,<br/>score handle, earnings handle, status, aliveCheck,<br/>partner, wins, public traits, duel listing,<br/>revealed, opener"]
    shake["Shake (box, viewer)<br/>pick handle, roll handle"]
    req["Request<br/>kind, status, requester, boxes, fed, handles"]
    duel["Duel<br/>boxes, reserved, openUntil, challenger, accepter,<br/>status, posting handle, five outcome handles"]
  end
  subgraph ix["Instructions"]
    i1["mint / announce_milestone"] --> box
    i2["shake / paid_shake / claim_earnings"] --> shake
    i3["feed / confidential_transfer"] --> box
    i4["observe / prove_alive / accept_entangle"] --> req
    i5["finalize"] --> box
    i6["propose_entangle"] --> box
    i7["post_duel / accept_duel / finalize_duel / cancel_duel"] --> duel
  end
  ix -. "CPI: FHE ops, ACL" .-> zama["Zama program (not published yet)"]
  ix -. "CPI: create and check the asset" .-> nft["NFT program"]
```

The instruction list is the contract's function list, one to one. The state machine of
a box and of a duel are the ones in [FLOWS.md](FLOWS.md).

## What to write in `packages/chain-adapter/src/solana`

`SolanaAdapter implements ChainAdapter`, with the same shape as `EvmFhevmAdapter`:

| Interface member | EVM implementation | Solana implementation |
| --- | --- | --- |
| `connect`, `account`, `onAccountChange` | EIP-1193 injected wallet | Wallet Standard |
| `collection`, `box`, `pair`, `openedCats`, `pendingRequests` | contract views and events | fetch and decode PDAs and program events |
| `boxesOf` | replay of the account's own decrypted receipts | the same replay over program events |
| `mint` ... `claimEarnings`, `sendBox` | one contract call each | one instruction each, with the accounts derived from token ids |
| `shake` decryption | EIP-712 permit + `userDecrypt` | ed25519-signed permit + the SVM SDK's user decryption |
| `finish*` | `publicDecrypt` then a `finalize*` call | same, possibly through a proof buffer account |
| `buyUsdc`, `trade` with `slippageBps`; `shieldUsdc`, `unshieldUsdc`, `wrap`, `unwrap` | `trade`: Uniswap V3 `QuoterV2` and `SwapRouter02` with a minimum out (`buyUsdc`: the ramp, over a V2 pool); ERC-7984 `wrap`, and `unwrap` + public decryption + `finalizeUnwrap` | a Solana AMM swap with a minimum out (a concentrated-liquidity pool such as Orca Whirlpools or Raydium CLMM takes the same CROQ-only range); the confidential token program's deposit and withdraw, the withdrawn amount made public the same way |
| `signTerms` (the release form) | EIP-191 `personal_sign` (secp256k1), then `POST /v1/terms` | the Wallet Standard's `signMessage` (ed25519) on the same text naming the base58 address; the API's `AcceptTerms` verifies EIP-191 only, so it needs an ed25519 path and an address format check for Solana keys |
| steps `wallet`, `confirming`, `decrypting`, `proving` | as is | as is |
| `ChainError.reason` | Solidity custom error name | Anchor error name, kept identical |
| `ChainError.detail` | `held`/`needed` from a dry run (`estimateGas`) and the balances; `resumable`/`landed` after the first transaction | `simulateTransaction` for the dry run and the fee; the same flags |

Then add `"solana"` to `ChainMode` in `src/index.ts` and a dynamic import next to the
Sepolia one. Nothing in `apps/web` changes except the wallet button's label.

## Order of work, once the SDK exists

1. Read the SDK and correct this document: ACL model, proof format and size, FHE budget.
2. Config and mint. Test that a seed and an owner are drawn and that nobody can decrypt
   them, and that a real id and an empty one look the same.
3. Shake with user decryption: this proves the ACL and permit story end to end.
4. Observe with public decryption: this settles the transaction size question.
5. `decode` in Rust, with the same cross-test against the generator that the Solidity
   one has (`decodes seeds exactly like the TypeScript generator`).
6. proveAlive, feed, entangle, duel. Re-measure costs and re-decide the batch size.
   The croquette economy comes after: a confidential SPL token (or Zama's equivalent of
   ERC-7984) next to a plain SPL mint for markets, and a Pantry program with one weight
   account per box (encrypted weight, today's meals and amount, the weigh-in).
   The market's liquidity locker has no FHE in it: a CROQ-only position in a
   concentrated-liquidity pool, whose position NFT (or position account) goes to a program
   with no withdraw instruction and a fee collect that pays the treasury.
7. `SolanaAdapter`, then run the app in a third mode.
8. Port the test suite: the 95 contract tests are written against behaviour, not against
   Solidity, and their names read as a specification.

## Open questions for Zama

1. Is the ACL on Solana per public key, per program, or per account?
2. What does a public decryption proof look like, how large is it, and how is it verified on-chain?
3. Does user decryption accept an ed25519 signature, and what does the signed message contain?
4. Is there an encrypted shift by an encrypted amount? (Used by `shake` and `duel`.)
5. What is the FHE budget per transaction, and does it interact with compute units?
6. Is there a local mock comparable to the Hardhat plugin's?
7. Is there an encrypted address type, with equality and `select`? (Used by every
   ownership check.)
8. Does a public decryption refuse a handle listed twice, as on the EVM?
