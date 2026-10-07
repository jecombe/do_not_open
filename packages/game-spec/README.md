# @dno/game-spec

The chain-agnostic rules of DO NOT OPEN. `spec.json` is the single source of truth for
the EVM contract, the future Solana program, the generator and the UI. Nothing in here
knows what a blockchain is.

## Collection

`collection.maxSupply` is 10,000 boxes. Who holds them and how many were sold are
encrypted on-chain, so `collection.milestones` lists the only sold counts ever announced:
100, 500, 1,000, 2,500, 5,000, 7,500, 9,000 and 10,000, the last one the cap. Token ids
run past `maxSupply`, because a mint hides its quantity among empty ids; any 32-bit id is
valid. See [`docs/HIDDEN_OWNERS.md`](../../docs/HIDDEN_OWNERS.md).

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

On-chain the state is never computed while the box is sealed. `proveAlive` needs a
single encrypted comparison (`stateRoll < 45875`); after `observe` the state is derived
in the clear.

## Traits

A trait **is** its roll: the encrypted value stored per trait is the raw byte. The
variant is looked up off-chain through the public cumulative `width` table (widths sum
to 256). Variants are ordered common to rare, so **a higher roll is always rarer** and
the program never needs an encrypted table lookup.

## Rarity

```
rarityScore = 3*breed + 1*mood + 2*accessory + 1*brokenThing + 1*room + stateBonus
```

Maximum 3040, so it fits 16 bits.

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

A paid `feed` adds a hidden uniform amount between 0 and 3 to an encrypted counter; an
unpaid one adds 0. Feeds are public events, but neither their number (not kept) nor what
they earned tells the affection. At reveal, `affection > 10` turns
the accessory golden (a cat with none gets a golden bell collar) and adds 250 to the
revealed score. Tiers and duels use the score before that bonus.

## Economy

The `economy` section holds the croquette rules. The deploy script and the Pantry read
them; [`docs/CROQ.md`](../../docs/CROQ.md) explains them.

| Key | Value | Meaning |
| --- | --- | --- |
| `token.totalSupply` | 20,000,000 | CROQ minted once, 0 decimals |
| `allocation` | 10M / 1M / 4M / 5M | Game reserve, welcome bags, market liquidity, treasury. Must add up to the supply |
| `welcomeBag.amount` | 100 | Paid once per box. `allocation.welcomeBags` must equal `maxSupply` × this |
| `purr.maxPerDay` | 4 | Encrypted draw in 0..4 per box and per day |
| `purr.vetMultiplier` | 2 | For Vet Certified boxes |
| `purr.maxDays` | 7 | Days one claim can collect |
| `purr.halvingDays` | 365 | The purr halves this often |
| `meal.mealsPerDay`, `meal.maxEatenPerDay` | 2, 1,000 | Per cat and per UTC day; past either, a meal moves 0, silently |
| `meal.treasuryBps`, `meal.burnBps` | 2000, 2000 | 20% of each meal to the treasury, 20% burnt, the rest back to the game reserve |
| `weight` | builds, sick, diseases | Build floors, the sickness tolerance range and the disease odds, applied at the weigh-in |

## Flea market

The `market` section holds the flea market's terms: `feeBps` (250, the treasury's share of
each sale), `maxFeeBps` (1,000) and `maxPriceUsdc` ("1000000", the most an item may be listed
or offered for), with the rules in plain words (`rule`, `stateRule`, `leaks`). The deploy
script reads `feeBps` through `marketParamsFromSpec()` (`packages/contracts-evm/lib/marketParams.ts`),
which refuses a fee above `maxFeeBps`; `FleaMarket` hardcodes `MAX_FEE_BPS` and `MAX_PRICE`
and a test checks them against the spec. The mock adapter reads the same numbers.

## Whitelist

The `whitelist` section holds the mainnet whitelist and its gifts: `places` (1,500, the API's
default `ALLOW_LIST_PLACES`), `claimDays` (30) and three `tiers`, each with its ranks
(`fromRank`, `toRank`), the cCROQ range drawn under encryption (`croqMin`, `croqMax`) and
whether it gets a box and a rat: First class 1 to 500 (100 to 500, box and rat), Business 501
to 1,000 (50 to 250, box), Economy 1,001 to 1,500 (20 to 100, rat). `whitelistTierOf(rank)`
maps a rank to its tier. The deploy script reads it through `whitelistParamsFromSpec()`
(`packages/contracts-evm/lib/specParams.ts`), which checks the tiers cover ranks 1 to `places`
in order and that each range fits the contract's 16-bit draw; the API, the mock adapter and the
web pages read the same numbers. The gift rats' cap is `rats.mint.maxGiftRats` in `studio.json`.

## Rats (studio.json)

`studio.json` holds the studio and its rats, kept out of `spec.json` because the deployed
`DoNotOpenConfig` stores `spec.json`'s hash. `rats.mint` caps the supply and sets the prices,
`rats.croquettes` the `RatPantry`'s daily CROQ, and `rats.powers` the rats' secret powers:
`odds` (basis points for powers 1, 2 and 3: 5,500, 3,000, 1,500), `sniffRebateBps` (3,000: what
a power-1 rat gets back of a sniff's price), `trickDays` (3: how long a shield or a jam lasts)
and `rechargeDays` (7: how long the rat rests afterwards). `ratParamsFromSpec()`
(`packages/contracts-evm/lib/ratParams.ts`) turns the odds into the bounds on a 16-bit draw that
`Rats` takes (`powerBounds`, checking they are three positive numbers summing to 10,000); the
mock adapter and the web app read the same numbers. `rats.events` lists `RatMinted`,
`Transfer`, `Sniffed`, `TrickPlayed` and `RatsFed`.

## Mechanics and events

See `mechanics` and `events` in `spec.json` (the flea market's events, `Listed` to `Sold`,
are at the end of `events`). Each rule is written so that it can be
implemented by any program that can compute on encrypted integers and publish a
verified decryption.

`mechanics.duel.lifetimeDays` (7) is how long a proven duel stays on the duel shelf. The
contract's private `DUEL_LIFETIME` matches it (the tests check it from the spec), and the mock adapter reads it.
