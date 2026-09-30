# @dno/contracts-evm

Hardhat project built on the official Zama template. Two contracts:

- **`DoNotOpenConfig`** — the game's numbers, read from `packages/game-spec/spec.json`
  at deploy (`lib/specParams.ts`), plus the plaintext rule that turns a revealed seed
  into state, traits and score. Stores the keccak256 of the spec it was built from.
- **`DoNotOpen`** — ERC-721 and all FHE logic.

## What is encrypted

| Per box            | Storage                          | Who can read it                            |
| ------------------ | -------------------------------- | ------------------------------------------ |
| Seed               | `euint64`, the only ciphertext   | Nobody until `observe`                     |
| State, traits, score | not stored; derived from the seed | Nobody until `observe`                   |
| A shake result     | two fresh `euint8` per viewer    | The viewer who shook, nobody else          |
| "Is alive" bit     | `ebool`, only after `proveAlive` | Everyone, once requested                   |
| Status, badge, revealed contents | plain storage      | Everyone                                   |

## Cost per function

Measured on the FHEVM mock with `fhevm.computeTransactionHCU`. The protocol allows
20,000,000 HCU per transaction (5,000,000 sequential depth).

| Function             | FHE operations                                       | HCU              | Gas      |
| -------------------- | ---------------------------------------------------- | ---------------- | -------- |
| `mint(n)`            | `randEuint64` per box                                | 24,000 per box   | ~186k for 1, ~881k for 10 |
| `shake`              | `randEuint16`, 4 scalar `ge`, 4 `select`, 1 encrypted `shr`, casts | 672,224 (depth 507,064) | ~366k |
| `proveAlive`         | cast, 1 scalar `lt` on 16 bits                       | 58,032           | ~164k    |
| `finalizeProveAlive` | none (KMS signature check)                           | 0                | ~94k     |
| `observe`            | none (ACL change)                                    | 0                | ~88k     |
| `finalizeObserve`    | none (KMS signature check, plaintext decode)         | 0                | ~192k    |
| transfer             | none                                                 | 0                | ~60k     |

## Commands

```bash
pnpm compile
pnpm test                 # 28 tests on the local FHEVM mock

# Local walkthrough
pnpm chain                # terminal 1
pnpm deploy:localhost     # terminal 2
pnpm demo:localhost       # mint, shake twice, prove alive, observe

# Sepolia (fill MNEMONIC or PRIVATE_KEY in the repo-root .env first)
pnpm deploy:sepolia
pnpm demo:sepolia
pnpm test:sepolia         # optional integration test, spends a little Sepolia ETH
pnpm verify:sepolia
```

Single steps: `npx hardhat --network <net> dno:mint|dno:shake|dno:prove-alive|dno:observe|dno:status --token <id>`.

## Two-step public decryption

`observe` and `proveAlive` only mark a ciphertext as publicly decryptable. The cleartext
comes back in a second transaction that anyone can send:

```
holder   -> observe(tokenId)                status = Observing
anyone   -> relayer.publicDecrypt([seedHandle])  => cleartext + KMS proof   (off-chain)
anyone   -> finalizeObserve(tokenId, cleartext, proof)
            contract rebuilds the handle list from its own storage,
            FHE.checkSignatures(...) reverts on any mismatch,
            status = Revealed
```

The CLI tasks and, later, the frontend do both steps in one go. If the second step is
never sent the box stays in `Observing`; nothing is lost and anyone can finish it.
