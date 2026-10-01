# @dno/contracts-evm

Hardhat project built on the official Zama template. Five contracts:

- **`DoNotOpenConfig`** — the game's numbers, read from `packages/game-spec/spec.json`
  at deploy (`lib/specParams.ts`), plus the plaintext rule that turns a revealed seed
  into state, traits and score. Stores the keccak256 of the spec it was built from.
- **`DoNotOpen`** — ERC-721 and all FHE logic of the boxes. 10,000 boxes.
- **`Croq`** — CROQ, a plain ERC-20 with 0 decimals. 20,000,000 minted once in the
  constructor; no mint function, no owner.
- **`ConfidentialCroq`** — cCROQ, OpenZeppelin's `ERC7984ERC20Wrapper` around CROQ,
  unmodified. Encrypted balances and transfer amounts, 1:1 with CROQ.
- **`Pantry`** — the croquette economy: welcome bags, the daily purr, meals into
  encrypted stashes, settlement by the cat's state. Reads `DoNotOpen`, never writes to
  it. Parameters from the spec's `economy` section (`pantryParamsFromSpec()`).

The economy is specified in [`docs/CROQ.md`](../../docs/CROQ.md).

## What is encrypted

| Per box            | Storage                          | Who can read it                            |
| ------------------ | -------------------------------- | ------------------------------------------ |
| Seed               | `euint64`                        | Nobody until `observe`                     |
| Affection          | `euint32`, exists once fed       | Nobody until `observe`                     |
| Rarity score       | `euint16`, cached at first duel  | Nobody; only compared under encryption     |
| Duel outcome       | `ebool` + two `euint8`           | Everyone, once the duel is accepted        |
| State, traits, score | not stored; derived from the seed | Nobody until `observe`                   |
| A shake result     | two fresh `euint8` per viewer    | The viewer who shook, nobody else          |
| "Is alive" bit     | `ebool`, only after `proveAlive` | Everyone, once requested                   |
| Status, badge, revealed contents | plain storage      | Everyone                                   |
| Croquette stash    | `euint64` in the Pantry          | Nobody; settled after `observe`            |
| Meals, last claim, settled flag | plain storage in the Pantry | Everyone                           |

## Cost per function

Measured on the FHEVM mock with `fhevm.computeTransactionHCU`. The protocol allows
20,000,000 HCU per transaction (5,000,000 sequential depth).

| Function             | FHE operations                                       | HCU              | Gas      |
| -------------------- | ---------------------------------------------------- | ---------------- | -------- |
| `mint(n)`            | `randEuint64` per box                                | 24,000 per box   | ~186k for 1, ~881k for 10 |
| `shake`, `paidShake` | `randEuint16`, 4 scalar `ge`, 4 `select`, 1 encrypted `shr`, casts | 672,224 (depth 507,064) | ~366k, ~411k |
| `feed`               | `randEuint8`, one 32-bit `add`                       | 148,032          | ~111k    |
| `proveAlive`         | cast, 1 scalar `lt` on 16 bits                       | 58,032           | ~164k    |
| `challengeDuel`      | score of box A on first use: 3 `ge`, 3 `select`, 5 `shr`, 2 `mul`, 5 `add` | 1,351,480, then 0 | ~499k |
| `acceptDuel`         | score of box B on first use, `gt`, pick, 2 encrypted `shr`, `select` | 2,371,768, ~1.0M once cached | ~919k |
| `finalizeDuel`       | none (KMS signature check)                           | 0                | ~169k    |
| `proposeEntangle`, `acceptEntangle` | none                                  | 0                | ~59k, ~78k |
| `observe`            | none (ACL change); twice the ACL work if entangled   | 0                | ~88k to ~149k |
| `finalizeObserve`    | none (KMS signature check, plaintext decode)         | 0                | ~192k    |
| `finalizeProveAlive` | none                                                 | 0                | ~94k     |
| `claim`, transfer    | none                                                 | 0                | ~31k, ~60k |

`Pantry`:

| Function | FHE operations | HCU |
| --- | --- | --- |
| `feed` | `fromExternal`, confidential `transferFrom`, `mul` + `div` for the 10% burn, 2 `add` | ~2,152,000 |
| `claim(ids)` | per purring box: `randEuint8`, `rem`, cast, `mul`, `shr`, `add`; then `min`, `sub`, one transfer | ~680,000 per box, ~6.8M for the 10-box maximum (depth ~2.8M) |
| `claim` once the purr has halved to 0 | none | 0 |
| `settle` | none if never fed; ghost one `add`; alive or asleep one transfer; quantum `mul` + `div`, `sub`, `add`, transfer | 0, ~162,000, ~586,000, ~1,990,000 |
| `fund` | `wrap`, one `add` | not pinned |

Deployment gas on Sepolia: `Croq` 536k, `ConfidentialCroq` 2.49M, `Pantry` 2.20M,
`fund` 442k.

## Commands

```bash
pnpm compile
pnpm test                 # 80 tests on the local FHEVM mock (27 in test/Pantry.ts)

# Local walkthrough
pnpm chain                # terminal 1
pnpm deploy:localhost     # terminal 2
pnpm demo:localhost       # mint, shake twice, prove alive, observe
pnpm demo2:localhost      # mint 3, feed, duel, entangle, observe one and see both open

# Sepolia (fill MNEMONIC or PRIVATE_KEY in the repo-root .env first)
pnpm deploy:sepolia
pnpm demo:sepolia
pnpm demo2:sepolia
pnpm test:sepolia         # optional integration test, spends a little Sepolia ETH
pnpm verify:sepolia
```

`pnpm deploy:<net>` runs two scripts. `deploy/deploy.ts` deploys the config and
`DoNotOpen`. `deploy/economy.ts` then deploys `Croq`, `ConfidentialCroq` and `Pantry`,
approves and calls `Pantry.fund` with the game reserve plus the welcome bags (11M), and,
on a network listed in `UNISWAP_V2` (Sepolia), opens a CROQ/WETH pool with the 4M
liquidity share and `LIQUIDITY_ETH` ETH (default `0.02`). The LP tokens are then sent to
`0x…dEaD`, so that liquidity is locked for good. The rest of the supply (the treasury) stays with the deployer too, or goes to
`COLLECTION_OWNER` if it is set.
`CROQ_CONTRACT_URI` sets cCROQ's contract URI (default empty).

`Pantry.fund` calls FHE, so the economy script fails on the bare in-process `hardhat`
network. Use `pnpm chain` + `pnpm deploy:localhost`, which runs the FHEVM mock.

`pnpm export:sepolia` (run by `deploy:sepolia`) writes
`packages/chain-adapter/src/evm/deployments/sepolia.json` (the box contract) and
`sepolia-economy.json` (CROQ, cCROQ, Pantry addresses and ABIs, and the market: pair,
router, factory, WETH).

Single steps: `npx hardhat --network <net> dno:mint|dno:shake|dno:feed|dno:paid-shake|dno:prove-alive|dno:observe|dno:status --token <id>`,
`dno:entangle --a <id> --b <id>`, `dno:duel --a <id> --b <id>`.

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
