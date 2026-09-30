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

Current (Phase 3 mechanics plus the two Phase 4 views):

| Contract          | Address                                      |
| ----------------- | -------------------------------------------- |
| `DoNotOpen`       | `0x6C6210E9CB6CC5218F479806258E86B176aA5BD0` |
| `DoNotOpenConfig` | `0xEA573173eB2f781E89346f007717cFA803413957` |

Deployed at block 11815596, 4,666,157 gas. `packages/chain-adapter/scripts/smoke.ts`
ran every mechanic against it through the real coprocessor, relayer and KMS: mint,
two shakes on one permit, feed, proveAlive, a duel, an entanglement, and an observe
that opened both entangled boxes; both reveals matched the generator. The browser
app then minted, shook and opened a box against the same contract.

Superseded Phase 2 deployment, kept for the record:

| Contract          | Address                                      |
| ----------------- | -------------------------------------------- |
| `DoNotOpen`       | `0x2abE00CF08422Aa221680423F5A8C5D9cb53c2FD` |
| `DoNotOpenConfig` | `0x2763aFa89982882E9D367B37Bd61F30FE6d3E27C` |

Spec hash `0x9bcb0e62d37833de4112a1a4c03c988c1ed1911bcc0a7081a8f460ef1ef7af9a`, mint
price 0.002 ETH, observe fee 0.0005 ETH. `pnpm demo:sepolia` was run end to end against
the real coprocessor and KMS: mint, two shakes with private decryption, `proveAlive` and
`observe` with public decryption and on-chain proof verification. Token 0 is revealed.

That first deployment does not include feed, paidShake, entangle or duel.
Artifacts are in `packages/contracts-evm/deployments/sepolia`. Not yet verified on
Etherscan (needs `ETHERSCAN_API_KEY`).

## Phase 4: the frontend and the relayer

### Which SDK

The brief asks for the Relayer SDK. `EvmFhevmAdapter` uses `@zama-fhe/relayer-sdk`
**0.4.1**, the exact version the Hardhat plugin pins and the one the Phase 2 and 3 CLI
already ran against Sepolia. In the browser it is imported from
`@zama-fhe/relayer-sdk/web` (ES module, WASM resolved by Vite); in Node from `/node`.
The docs' web-app page still shows `/bundle` with a CDN script tag pinned to 0.2.0;
`/bundle` expects that global and is not what a bundled app wants.

Zama now also publishes a higher-level `@zama-fhe/sdk` (3.6.0 on npm, built on
`@fhevm/sdk` 0.13.2, with React hooks, signer abstractions and a v2 to v3 migration
guide). It was not adopted here: it tracks the 0.13 contract line while this project is
on `@fhevm/solidity` 0.11.1, and swapping SDK under a working deployment buys nothing.
Because the app only sees `ChainAdapter`, moving to it later is a change inside one file.

### What differs from the docs' examples

- `createEIP712` and `userDecrypt` take the start timestamp and duration as **numbers**
  in 0.4.1. The docs' snippets pass strings.
- This app never encrypts an input: every secret is drawn on-chain. So the adapter only
  uses `generateKeypair`, `createEIP712`, `userDecrypt` and `publicDecrypt`, and the
  multi-threading setup (cross-origin isolation headers) that input proofs benefit from
  is not needed.
- `createInstance` is given the read RPC URL, not `window.ethereum`, so decryption of
  public values works before any wallet is connected.

### Decisions

- **One permit per session.** A shake needs a user decryption, which needs an EIP-712
  signature over a fresh keypair. The adapter signs once (valid one day, this contract
  only) and keeps the keypair in memory, so the wallet prompts once, not at every shake.
  Nothing is written to storage: a reload asks again.
- **Retries on decryption.** The coprocessor computes a ciphertext a few seconds after
  the transaction that requested it. Asking the relayer too early fails, so decryptions
  are retried up to five times with a growing pause.
- **Two-step actions can be resumed.** observe, proveAlive and duel each end with a
  proof transaction. If the user closes the tab in between, the box stays "opening" (or
  the check or duel "pending"); the app then shows "Finish opening" and anyone can send
  the proof. The adapter exposes `finishObserve`, `finishProveAlive` and `finishDuel`.
- **Reads do not need a wallet.** They go to a public RPC endpoint. After each
  transaction the adapter waits until that endpoint has seen the block, because public
  endpoints are load-balanced and can answer from a node that is one block late.
- **No enumeration on-chain.** The contract is a plain ERC-721. `boxesOf` checks the
  balance, then walks `ownerOf` from the newest token down until it has found them all.
  Fine on a testnet; a mainnet front end should read an indexer instead.
- **Two views added to the contract** for the front end: `feedCount(tokenId)` (the
  number of feeds was already public through events) and `entangleProposer(a, b)`.
  Deployed bytecode is now 20,468 bytes.

### Mainnet

The Sepolia relayer is open. The Zama-hosted **mainnet relayer needs an API key**, which
must not reach the browser: the documented pattern is a small backend proxy that adds
the `x-api-key` header. That proxy does not exist in this repo yet; it is a mainnet task.

### Not verified

- A real browser wallet extension. The browser run used a local signing proxy behind an
  injected EIP-1193 object, which exercises the same adapter code (`eth_requestAccounts`,
  `eth_sendTransaction`, `eth_signTypedData_v4`) but not MetaMask's own prompts, its
  network switching, or account change events.
- The two-holder flows in the browser (accepting someone else's duel or entanglement).
  They are covered by the mock adapter's tests and by the contract tests, and the smoke
  script ran them on Sepolia with one account holding both boxes.
- `paidShake` and `claim` on Sepolia: they need a second funded account.
