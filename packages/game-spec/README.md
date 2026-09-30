# @dno/game-spec

The chain-agnostic rules of DO NOT OPEN. `spec.json` is the single source of truth for
the EVM contract, the future Solana program, the generator and the UI. Nothing in here
knows what a blockchain is.

## Seed layout

Every box holds one 64-bit seed. Everything about the cat is a pure function of it.

| Bits  | Field         | Use                                              |
| ----- | ------------- | ------------------------------------------------ |
| 0–15  | `stateRoll`   | Compared against the state thresholds            |
| 16–23 | `breed`       | Trait roll 0–255                                 |
| 24–31 | `mood`        | Trait roll 0–255                                 |
| 32–39 | `accessory`   | Trait roll 0–255                                 |
| 40–47 | `brokenThing` | Trait roll 0–255                                 |
| 48–55 | `room`        | Trait roll 0–255                                 |
| 56–63 | `cosmetic`    | Render-only variation. Never affects rarity.     |

Why slices and not `seed % n`: encrypted remainder is one of the most expensive FHE
operations, and bounded encrypted randomness only supports power-of-two bounds. Shifts
and masks by plaintext constants are cheap on any FHE backend.

## State

`stateRoll` is a uniform 16-bit number. A state owns the rolls below its `rollBelow`
and at or above the previous one.

| State   | Rolls         | Probability | Score bonus |
| ------- | ------------- | ----------- | ----------- |
| Alive   | 0 – 45874     | 69.9997 %   | 0           |
| Asleep  | 45875 – 58981 | 19.9997 %   | 100         |
| Ghost   | 58982 – 64224 | 8.0002 %    | 400         |
| Quantum | 64225 – 65535 | 2.0004 %    | 1000        |

On-chain this is three encrypted comparisons against plaintext thresholds.

## Traits

A trait **is** its roll: the encrypted value stored per trait is the raw byte. The
variant is looked up off-chain through the public cumulative `width` table (widths sum
to 256). Variants are ordered common to rare, so **a higher roll is always rarer** and
the program never needs an encrypted table lookup.

## Rarity

```
rarityScore = 3*breed + 1*mood + 2*accessory + 1*brokenThing + 1*room + stateBonus
```

Five scalar multiplications and five additions on-chain. Maximum 3040.

Tier thresholds are fixed in advance from the exact distribution of that formula over a
uniform seed (`scoreDistribution()` in the generator). A test fails if `spec.json` and
the distribution ever disagree.

| Tier      | Min score | Share of boxes |
| --------- | --------- | -------------- |
| Common    | 0         | bottom 50 %    |
| Uncommon  | 1078      | top 50 %       |
| Rare      | 1367      | top 20 %       |
| Epic      | 1657      | top 5 %        |
| Legendary | 2057      | top 1 %        |

## Affection

`feed` adds 1 to an encrypted counter. At reveal, `affection > 10` turns the accessory
golden and adds 250 to the revealed score. Tiers are computed before that bonus.

## Mechanics and events

See `mechanics` and `events` in `spec.json`. Each rule is written so that it can be
implemented by any program that can compute on encrypted integers and publish a
verified decryption.
