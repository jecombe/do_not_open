# Audit checklist

This is a self-review, written by the people who wrote the code. It is a starting point
for an external audit, not a substitute for one. **No third party has audited this
contract, and it must not go to mainnet before one has.**

Scope: `DoNotOpen.sol` and `DoNotOpenConfig.sol` as deployed on Sepolia at
`0x6C6210E9CB6CC5218F479806258E86B176aA5BD0` (20,468 bytes), plus the parts of the
adapter and the metadata pipeline that could leak or mislead.

Status values: **Pass** (checked, with the evidence named), **Accepted** (a known
property of the design, documented), **Open** (should be fixed or decided before
mainnet), **Not done** (a check nobody has run).

## Summary of what is open

| # | Finding | Severity | Where |
| --- | --- | --- | --- |
| O1 | A box stuck in `Observing` has no way out if the KMS never answers | Medium | `observe` |
| O2 | No per-wallet mint cap or allowlist: one bot can mint the supply | Medium (fairness) | `mint` |
| O3 | `DoNotOpenConfig` does not check that the maximum score fits 16 bits | Low (deploy-time) | constructor |
| O4 | `DoNotOpenConfig` does not check that trait offsets are distinct and byte-aligned | Low (deploy-time) | constructor |
| O5 | Single-step `Ownable`; the owner is an externally owned account on Sepolia | Low on testnet, High on mainnet | admin |
| O6 | `setBaseURI` can repoint every token's metadata, with no freeze | Medium (trust) | admin |
| O7 | No ERC-4906 `MetadataUpdate` on reveal: marketplaces keep the sealed image | Low | `finalizeObserve` |
| O8 | Unlimited open challenges: a box's pending duel can be buried by spam in the app | Low (front end) | `challengeDuel`, adapter `pair()` |
| O9 | Mainnet relayer needs an API key behind a proxy; none exists | Blocker for mainnet | adapter |
| O10 | Static analysis, fuzzing, Sepolia test suite and Etherscan verification not run | Process | see the end |

Details and the rest of the checks follow.

## 1. Re-entrancy and ETH handling

| Check | Status | Evidence |
| --- | --- | --- |
| No external call in the middle of game logic | Pass | The only value-sending calls are in `claim` and `withdraw`. `paidShake` credits the holder and sends nothing |
| `claim` follows checks-effects-interactions | Pass | `credits[msg.sender] = 0` and `totalCredits -= amount` happen before the call. Tests: "shows one real trait to the payer only and credits the holder 70%", "keeps unclaimed holder credits out of the owner's withdrawal" |
| A reverting or re-entering holder cannot block `paidShake` | Pass | Pull payment: the holder is never called during `paidShake` |
| Mint has no receiver callback | Pass | `_mint`, not `_safeMint`. Accepted consequence: a contract that cannot handle ERC-721 can mint to itself and lock the box |
| `safeTransferFrom` callback cannot corrupt state | Pass | The contract has no transfer hook and keeps no per-owner game state that a callback could race |
| `withdraw` cannot take holders' unclaimed credits | Pass | Sends `balance - totalCredits`. Invariant `balance >= totalCredits` holds because each credit is a fraction (at most 100%, validated in config) of ETH received in the same call; forced ETH only raises the balance |
| `withdraw` re-entrancy | Pass | Owner-only, to an address the owner chose, and no state is read after the call |
| Exact-fee checks | Pass | `costs()` and `mint` require `msg.value ==` the fee. Tests: "enforces price, batch size and supply", "requires the holder and the exact fee" |
| Fees cannot be changed after deploy | Accepted | They are immutables. A price change means a new deployment |
| No `receive` or `fallback` | Pass | Plain ETH transfers to the contract revert |

## 2. ACL and confidentiality

| Check | Status | Evidence |
| --- | --- | --- |
| Nobody but the contract is ever allowed on the seed | Pass | Only `allowThis(seed)` in `mint`. Test: "gives nobody the right to decrypt the seed, not even the holder or the deployer" |
| Same for the affection and the cached score | Pass | Only `allowThis` in `feed` and `_ensureScore` |
| A shake result is readable by its viewer only | Pass | Fresh ciphertexts, `allow(viewer)`. Test: "keeps the result unreadable for everybody else" |
| A shake can never return the state | Pass | The five picks are the five trait offsets (16 to 48); the state roll is bits 0 to 15. `InvalidTraitOffset` rejects offsets below 16 at deploy |
| The shake event does not leak the pick | Pass | `Shaken(tokenId, viewer, paid)`. Test: "emits no information about the pick" |
| The pick cannot be predicted or ground | Pass | It is an encrypted draw. Resubmitting gives another hidden draw, not a chosen one |
| Transfer moves no ACL and leaves nothing to revoke | Pass | Tests: "transferFrom / safeTransferFrom: the new holder can shake, the previous one cannot" |
| A previous holder keeps what they already decrypted | Accepted | Unavoidable. Documented in `DATA_MODEL.md` |
| A holder can learn all five traits by shaking repeatedly | Accepted | By design ("unlimited"). The state and the affection stay hidden. A buyer should assume the seller knows the traits |
| Duels leak the order of base scores, and so a hint about the state | Accepted | The state bonus is up to 1,000 of 3,040 points: a box that beats many others is more likely quantum or ghost. This is the mechanic |
| The duel winner's trait is never decryptable | Pass | `select(aWins, roll(B), roll(A))` under encryption; only the selected value is made public. Test: "resolves to the higher score and reveals one trait of the loser only" |
| `proveAlive` publishes exactly one bit | Pass | One `ebool` is made public. Test: "publishes exactly one bit and grants the badge when it is true" |
| Feed count does not give the affection away | Pass | Each feed adds an encrypted draw in 0..3. Test: "lets anyone feed a box and adds a hidden amount each time" |
| Public handles (`seedHandle`, `lastShake`, `aliveHandle`, `duelHandles`) leak nothing | Pass | A handle is an identifier. Decryption is gated by the ACL |
| No encrypted input from users | Pass | Every secret is drawn on-chain. There is no input proof to forge and no `fromExternal` call |
| Gas or HCU side channels | Accepted | Whether a box has a cached score, or was ever fed, is visible from cost and handle count. Both facts are public anyway |
| Sealed metadata cannot leak the seed | Pass | `buildBoxSpec(tokenId)` and `sealedMetadata` take the token id and public facts only. Test: "builds sealed metadata from the token id and public facts only" |

## 3. Decryption "callbacks"

The protocol has no on-chain callback. Each reveal ends with a permissionless
`finalize*` transaction carrying clear values and a KMS proof.

| Check | Status | Evidence |
| --- | --- | --- |
| The handle list is rebuilt from storage, never taken from the caller | Pass | `observeHandles`, `duelHandles`, `_aliveBit` |
| A forged value is rejected | Pass | Tests: "rejects a forged seed and a proof made for another box", "rejects a forged answer", "rejects a forged outcome and double finalisation" |
| A valid proof for another box cannot be replayed | Pass | Same tests: the proof is bound to the handles |
| Finalisation happens once | Pass | Status guards: `Observing`, `Pending` (alive), `Pending` (duel) |
| Finalisation before the request is rejected | Pass | Test: "rejects duplicate requests and out-of-order finalisation" |
| Duplicate requests are rejected | Pass | `onlySealed` on `observe`; `AliveCheckAlreadyRequested`; duel status |
| Handles cannot change between request and finalisation | Pass | `feed` is `onlySealed`, so the affection handle is frozen once `Observing`. The alive bit and duel handles are written once |
| The order of decoded values matches the order of handles | Pass | Covered by every finalisation test, and by the Sepolia smoke run against the real KMS |
| Anyone can finalise, including after a transfer | Pass | Test: "can still be finalised after the box changes hands" |
| A duel still resolves if a box is opened meanwhile | Pass | Test: "still resolves if a box is opened while the outcome is pending" |
| Front-running a finalisation | Accepted | Whoever sends it, the result is the same. The slower sender's transaction reverts and costs them gas. The app should treat that revert as success (it currently shows a message and the box appears open on reload) |
| **O1. Liveness** | Open | If the KMS or relayer never answers, a box stays `Observing` forever: it cannot be shaken, fed, duelled or re-sealed, and there is no timeout. The fee is not refunded. Options: a timeout after which the holder can cancel (but the seed was already marked public, so it cannot be un-revealed: the honest fix is only a refund), or accept and document. The same applies to a pending alive check (harmless) and a pending duel (harmless) |

## 4. Mint

| Check | Status | Evidence |
| --- | --- | --- |
| The seed cannot be seen or influenced by the minter, a block producer or the deployer | Pass | `FHE.randEuint64()`, encrypted at birth |
| Mint cannot be reverted selectively on a bad roll | Pass | Nothing about the roll is known during or after the transaction |
| Token ids carry no information | Pass | Sequential. The look of a sealed box depends on the id only |
| Supply and batch limits | Pass | Test: "enforces price, batch size and supply" |
| One FHE operation per box | Pass | Test: "costs one FHE operation per box" (24,000 HCU) |
| **O2. Supply sniping** | Open | Front-running cannot pick good boxes, but nothing stops one account from minting all 5,000 in 500 transactions. If distribution matters: a per-wallet cap, an allowlist phase, or a signature gate. Decide before mainnet |
| Information asymmetry after mint | Accepted | The holder can learn the traits; a buyer cannot without paying for shakes |

## 5. Game logic

| Check | Status | Evidence |
| --- | --- | --- |
| The Solidity decoder equals the TypeScript generator | Pass | Tests: "decodes seeds exactly like the TypeScript generator", "maps rolls to variants like the generator". Smoke run: both Sepolia reveals matched |
| The encrypted score equals the plain one | Pass | Test: "resolves to the higher score..." compares against the mock's cleartext. Same weights and thresholds are read from the config |
| **O3. Score overflow** | Open | The score is a `uint16` / `euint16`. With the shipped spec the maximum is 3,040. With other weights the plain `decode` would revert (bricking `finalizeObserve` for that box) while the encrypted sum would wrap silently. Add a constructor check that `max(bonus) + 255 * sum(weights) + goldenBonus <= 65535` |
| **O4. Offsets** | Open | The constructor checks each offset is in 16..56 but not that the five are distinct and multiples of 8. `configParamsFromSpec` produces valid values; the contract should not rely on that |
| Ties in a duel go to B | Pass | Test: "lets the challenger win only on a strictly higher score" |
| Duel and entanglement need both holders | Pass | Tests: "needs both holders' consent", "needs the second holder's consent" |
| A proposal or challenge dies if the proposer's box is sold | Pass | Tests: "voids a proposal when the proposer's box changes hands", "is void if the challenger's box was transferred..." |
| Entanglement is permanent and follows the token | Accepted | A buyer of an entangled box can have it opened by the partner's holder, at no cost to them and with no consent asked. Marketplaces and the app must show `partnerOf`. The app does |
| Opening a partner costs its holder nothing and asks nothing | Accepted | That is what the two holders agreed to |
| **O8. Challenge spam** | Open | Any holder can file unlimited challenges against any sealed box. On-chain this costs only the spammer. In the app, `pair()` looks at the last 40 duels, so a real pending challenge can be pushed out of view. Fix in the adapter (index by event) or on-chain (one open challenge per pair) |
| Unbounded loops | Pass | Mint loops at most `maxPerTx` (10); score loops are fixed at 3 and 5 |
| Casts | Pass | Token ids fit `uint32` (supply 5,000, itself a `uint16`) |
| HCU stays under the limit | Pass | Largest measured: `acceptDuel` 2.37M of 20M. Tests pin shake, feed and proveAlive budgets |

## 6. Administration and trust

| Check | Status | Evidence |
| --- | --- | --- |
| Owner powers are limited to `withdraw` and `setBaseURI` | Pass | Test: "lets only the owner withdraw proceeds and set the base URI". The owner cannot mint for free, change rules, pause, or read a seed |
| **O5. Ownership** | Open | `Ownable` is single-step, and on Sepolia the owner is the deployer's hot key. For mainnet: `Ownable2Step` and a multisig |
| **O6. Metadata control** | Open | `setBaseURI` can be called at any time. Add a one-way freeze, or point at content-addressed storage and say so |
| **O7. Metadata refresh** | Open | Emit ERC-4906 `MetadataUpdate(tokenId)` in `finalizeObserve` so marketplaces re-fetch the image |
| The contract is not upgradeable | Accepted | A bug cannot be patched, and seeds in a broken deployment stay sealed forever. The config is immutable too |
| Rules are verifiable | Pass | `specHash` on-chain equals `keccak256(spec.json)`. Test: "records the hash of the spec it was built from" |
| Trust in Zama | Accepted | Confidentiality rests on the KMS threshold assumption; correctness of reveals rests on KMS signatures; liveness rests on the coprocessor, relayer and KMS |
| No royalties (ERC-2981) | Accepted | Not in the brief |

## 7. Front end, adapter and keys

| Check | Status | Evidence |
| --- | --- | --- |
| No private key in the repository | Pass | `.env` is git-ignored; `.env.example` has empty values. History checked before each commit |
| The web app holds no secret | Pass | Only `VITE_*` values reach the bundle: a mode, a public RPC URL, an address |
| The decryption permit is narrow | Pass | One contract, one day, kept in memory only, dropped on account change |
| The session private key never leaves the page | Pass | Generated by the SDK in the page; only the public key and the signature go to the relayer |
| The app cross-checks what the chain reveals | Pass | `catFromRevealed` rebuilds the cat from the seed and warns if score or golden flag differ |
| Reads come from a public RPC the user did not choose | Accepted | A lying RPC can misreport state; it cannot make the wallet sign something else, and the wallet shows each transaction |
| Wrong network | Pass | The adapter asks the wallet to switch, and refuses to sign otherwise. Not exercised with a real wallet extension |
| **O9. Mainnet relayer key** | Open | The hosted mainnet relayer needs an API key that must stay server-side. A proxy has to be built |
| Dependency pinning | Pass | `pnpm-lock.yaml` committed; the Relayer SDK is pinned to an exact version |
| Real wallet extension tested | Not done | The browser run used a local signing proxy behind an injected provider |
| Two-holder flows and `paidShake` / `claim` on Sepolia | Not done | Covered on the mock and in contract tests only |

## 8. Process

| Check | Status |
| --- | --- |
| Unit tests on the FHEVM mock | Pass: 53 tests |
| Every mechanic run on Sepolia through the real KMS | Pass: `packages/chain-adapter/scripts/smoke.ts` |
| Optional Hardhat suite on Sepolia (`pnpm test:sepolia`) | Not done |
| Static analysis (Slither, Aderyn) | Not done |
| Fuzz or invariant tests (`balance >= totalCredits`, status transitions) | Not done |
| Coverage report | Not done |
| Source verified on Etherscan | Not done: needs `ETHERSCAN_API_KEY` |
| External audit | Not done |
| Compiler pinned | Pass: 0.8.27 in `hardhat.config.ts`. The sources say `^0.8.24`; pin them too before an audit |

## Before mainnet

1. Decide O1, O2, O5, O6. Fix O3, O4, O7 (small and mechanical).
2. Build the relayer proxy (O9).
3. Run the "Not done" rows of section 8.
4. Get an external audit, by a firm that has reviewed FHEVM contracts before.
5. Test with real wallets and two accounts on Sepolia.
