# Zama FHEVM — verified versions and deviations from the brief

Checked on 2026-09-30 against docs.zama.org (Protocol, Solidity guides, Relayer SDK),
the official `zama-ai/fhevm-hardhat-template` (v0.4.1) and the community
`0xE1337/fhevm-skill` SKILL.md.

## Versions for `packages/contracts-evm` (Phase 2)

| Package                   | Version   | Why this one                                        |
| ------------------------- | --------- | --------------------------------------------------- |
| `@fhevm/solidity`         | `^0.11.1` | What the template and the Hardhat plugin peer on    |
| `@fhevm/hardhat-plugin`   | `^0.4.2`  | Template                                            |
| `@fhevm/mock-utils`       | `^0.4.2`  | Template                                            |
| `@zama-fhe/relayer-sdk`   | `0.4.1`   | Pinned exactly by the plugin's peer dependency      |
| `hardhat`                 | `^2.28.6` | The plugin peers on Hardhat 2, not Hardhat 3        |
| `ethers`                  | `^6.16.0` | Template                                            |
| Solidity                  | `0.8.27`, `evmVersion: cancun` | Template                       |

npm already carries `@fhevm/solidity` 0.13.3 and `@zama-fhe/relayer-sdk` 0.4.4, but the
current plugin does not declare support for them. Phase 2 starts on the template's set
and re-checks whether the plugin has moved before deploying.

APIs confirmed current: `ZamaEthereumConfig` (replaces the removed `SepoliaConfig`),
`FHE.randEuint64()`, `FHE.allow`, `FHE.allowThis`, `FHE.allowTransient`,
`FHE.makePubliclyDecryptable`, `FHE.checkSignatures`, `FHE.toBytes32`,
`instance.publicDecrypt(handles)`, `instance.userDecrypt(...)`.

## Where the brief and the protocol disagree

### 1. There is no on-chain decryption callback

The brief describes `observe` as "request public decryption, then a callback sets
revealed". `FHE.requestDecryption` and the oracle callback were removed in v0.9.

**What we do instead** (same pattern for observe, proveAlive and duel):

1. `observe(tokenId)`: checks, sets `observing = true`, calls
   `FHE.makePubliclyDecryptable` on the handles, emits `ObserveRequested`.
2. Off-chain, anyone calls `relayer.publicDecrypt(handles)` and gets cleartexts plus a
   KMS proof.
3. `finalizeObserve(tokenId, cleartexts, proof)`: permissionless. Rebuilds the handle
   list from storage, calls `FHE.checkSignatures`, stores plaintext, sets
   `revealed = true`.

The intermediate state and the duplicate-request guard from the brief still apply; the
"callback" is a normal transaction that anyone may send. The frontend sends it for the
user; a keeper can sweep stragglers.

### 2. ACL grants cannot be revoked

The brief asks to "stop allowing the previous owner" on transfer. `FHE.allow` is
permanent; there is no revoke.

This turns out not to matter, because of point 3.

### 3. The holder must not get blanket ACL at mint

The brief says "ACL granted to the holder" at mint and also "shake never reveals state
or rarityScore". Both cannot hold: an address allowed on a handle can user-decrypt it
directly through the relayer, without calling `shake`. A holder allowed on `state`
would simply read it.

**What we do instead**: at mint only the contract is allowed (`allowThis`) on seed,
state, traits, score and affection. `shake` creates a *fresh* handle holding the picked
trait and allows the caller on that handle only.

Consequences for transfers: there is nothing to move and nothing to revoke. The new
owner starts with no knowledge and shakes to learn. The previous owner keeps what they
already learned from their own shakes, which no system could take back.

### 4. Which trait a shake reveals

"Pseudo-randomly picked by the contract" has two possible meanings:

- a public index from block data: cheap, but the holder can see and grind it;
- an encrypted index from `FHE.randEuint8(8)`: the pick itself is hidden and cannot be
  ground. Costs five encrypted equality checks and four selects.

Phase 2 implements the encrypted pick. The viewer is allowed on two fresh `euint8`
handles: the picked trait's bit offset inside the seed, and its roll.

### 5. Randomness bounds are powers of two

`FHE.randEuintXX(bound)` needs a power-of-two bound and encrypted `rem` is expensive.
The game spec therefore slices a 64-bit seed into bit fields and compares against
thresholds. State odds are exact to 1/65536 (see `packages/game-spec/README.md`).

### 6. HCU limit per transaction

A transaction is capped at 20M HCU (5M sequential depth). Measured costs are in
`packages/contracts-evm/README.md`. Mint is 24,000 HCU per box, so the batch limit
(10 per transaction) is set by EVM gas, not by HCU.

### 7. Solana

Zama's SVM support is announced, not shipped; nothing can be verified yet.
`packages/chain-adapter/solana` stays a documented stub until the SDK exists.

## Decisions taken in Phase 2

### One ciphertext per box instead of eight

The brief lists `state` (euint8), five traits (euint8), `rarityScore` (euint32) as
stored encrypted fields. The contract stores **only the seed** and derives the rest
when a function needs it:

- `mint` is a single FHE operation per box instead of roughly twenty;
- `shake` cuts the picked byte out of the seed with one encrypted shift;
- `proveAlive` compares the low 16 bits of the seed with one threshold;
- `observe` decrypts one handle, and state, traits and score are then computed in plain
  Solidity by `DoNotOpenConfig.decode`, which a test pins to the TypeScript generator.

Phase 3's `duel` needs an encrypted score: it will be computed on first use and cached.
The score fits 16 bits (maximum 3040), so it will be a `euint16`, not the `euint32` of
the brief: smaller types are cheaper to compare.

### `revealed` is a view

Box state is one enum (`Sealed`, `Observing`, `Revealed`); `revealed(tokenId)` reads it.

### `_mint`, not `_safeMint`

No receiver callback during mint, so no re-entrancy surface there. A contract that
cannot handle ERC-721 tokens can still mint to itself; that is the minter's risk.

## Decisions taken in Phase 3

### Feeding adds a hidden amount, not 1

The brief says feed "increments affection in encrypted form". If each feed added
exactly 1, anyone could count `Fed` events and know the affection: the encryption would
hide nothing. Each feed therefore adds an encrypted uniform draw in 0..3
(`FHE.randEuint8(4)`). The number of feeds is public; what they earned is not. The
golden threshold stays at "affection > 10", about seven feeds on average.

A cat with no accessory that crosses the threshold gets a golden bell collar.

### Duel: three values become public, in one round

Accepting a duel computes, under encryption, `scoreA > scoreB`, a uniform trait pick, and
`select(aWins, rollOfB, rollOfA)`: the loser's roll for the picked trait. Only those three
ciphertexts are made publicly decryptable, so one `finalizeDuel` settles everything and
the winner's trait is never decryptable by anyone.

Each box's encrypted score is computed once (about 1.35M HCU) and cached. The challenger
pays for their box at `challengeDuel`, the accepter for theirs at `acceptDuel`.

### Consent is two transactions

`proposeEntangle` / `acceptEntangle` and `challengeDuel` / `acceptDuel`. A proposal or a
challenge is void if the proposer's box changes hands before it is accepted. One holder
may entangle or duel two of their own boxes.

### Entanglement is permanent and follows the token

There is no way to untangle. Whoever buys an entangled box can have it opened by the
partner's holder; marketplaces should show `partnerOf`.

### Paid shake earnings are pulled, not pushed

The holder's 70% is credited and withdrawn with `claim()`. Nothing is sent to a holder
in the middle of `paidShake`, so a holder contract that reverts cannot block shakes, and
there is no re-entrancy path. `withdraw` excludes unclaimed credits.

### Contract size

`DoNotOpen` is 20.3 KB of deployed bytecode against the 24.6 KB limit. The next sizeable
feature should move logic to a library.

### Sepolia deployment (2026-09-30)

| Contract          | Address                                      |
| ----------------- | -------------------------------------------- |
| `DoNotOpen`       | `0x2abE00CF08422Aa221680423F5A8C5D9cb53c2FD` |
| `DoNotOpenConfig` | `0x2763aFa89982882E9D367B37Bd61F30FE6d3E27C` |

Spec hash `0x9bcb0e62d37833de4112a1a4c03c988c1ed1911bcc0a7081a8f460ef1ef7af9a`, mint
price 0.002 ETH, observe fee 0.0005 ETH. `pnpm demo:sepolia` was run end to end against
the real coprocessor and KMS: mint, two shakes with private decryption, `proveAlive` and
`observe` with public decryption and on-chain proof verification. Token 0 is revealed.

This is the Phase 2 contract. It does NOT include feed, paidShake, entangle or duel;
the Phase 3 contract has to be redeployed to replace it.
Artifacts are in `packages/contracts-evm/deployments/sepolia`. Not yet verified on
Etherscan (needs `ETHERSCAN_API_KEY`).
