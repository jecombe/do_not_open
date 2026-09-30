# Encrypted data model

## Per token

```mermaid
flowchart TB
  subgraph enc["Encrypted: only the contract is on the ACL"]
    seed["seed : euint64<br/>drawn at mint by FHE.randEuint64"]
    aff["affection : euint32<br/>exists once the box is fed"]
    score["score : euint16<br/>computed at the first duel, cached"]
  end
  subgraph fresh["Encrypted, handed out"]
    shake["shake result : 2 x euint8<br/>ACL: contract + the one viewer"]
    alive["alive bit : ebool<br/>publicly decryptable once requested"]
    duel["duel outcome : ebool + 2 x euint8<br/>publicly decryptable once accepted"]
  end
  subgraph pub["Plain storage: everyone"]
    owner["owner, status"]
    counts["feedCount, wins"]
    badge["aliveCheck (none / pending / alive / not alive)"]
    partner["entangled partner"]
    ptraits["traits shown after lost duels"]
    rev["revealed contents<br/>(all zero until opened)"]
  end
  seed -- "shr + cast, fresh ciphertext" --> shake
  seed -- "low 16 bits < threshold" --> alive
  seed -- "weighted sum under encryption" --> score
  score -- "gt, select" --> duel
  seed -- "observe: makePubliclyDecryptable" --> rev
  aff -- "observe" --> rev
```

The seed layout (from `game-spec`):

| Bits | Field | Used for |
| --- | --- | --- |
| 0 to 15 | state roll | alive / asleep / ghost / quantum, by threshold |
| 16 to 23, 24 to 31, 32 to 39, 40 to 47, 48 to 55 | breed, mood, accessory, broken thing, room | one byte each; a higher roll is a rarer variant |
| 56 to 63 | cosmetic | look only, never rarity |

State, traits and score are **not stored encrypted**. They are functions of the seed,
computed under encryption when a mechanic needs them and in plain Solidity once the seed
is public.

## Who can learn what

| Fact | Holder | Anyone else | How |
| --- | --- | --- | --- |
| The seed, the state, the score | No | No | Only by opening the box, for everyone at once |
| One trait per shake | Yes, free, unlimited | Yes, by paying (`paidShake`) | User decryption of a fresh ciphertext |
| Which trait a shake picked | The viewer only | No | The pick is encrypted too, and absent from the event |
| Whether it is alive | Everyone, if the holder asks | same | `proveAlive` publishes one bit, once per box |
| Who wins a duel, one trait of the loser | Everyone | same | Public decryption of three values |
| The winner's trait in a duel | No | No | Selected away under encryption, never decryptable |
| How many times it was fed | Everyone | same | Plain counter |
| How much affection that earned | No | No | Each feed adds an encrypted draw in 0..3 |

Two deliberate consequences:

- **A holder who shakes enough learns all five traits.** A shake shows one of five at
  random, so about eleven shakes cover them. What stays hidden from the holder is the
  state (worth up to 1,000 of the 3,040 score points) and the affection.
- **Duels leak order.** Each duel publishes which of two boxes has the higher base score.
  Enough duels rank a set of boxes. That is the point of the mechanic, and the price of
  playing it.

## ACL lifecycle

`FHE.allow` grants are permanent on this protocol: there is no revoke. The design
therefore never grants anything durable that would need revoking.

```mermaid
sequenceDiagram
  autonumber
  participant A as Alice (holder)
  participant C as DoNotOpen
  participant ACL as ACL contract
  participant B as Bob (buyer)

  Note over C,ACL: mint
  C->>ACL: allowThis(seed)
  Note over ACL: seed: [contract]

  Note over A,ACL: Alice shakes
  A->>C: shake(tokenId)
  C->>ACL: allowThis(pick1, roll1), allow(pick1, roll1, Alice)
  Note over ACL: seed: [contract]<br/>pick1, roll1: [contract, Alice]

  Note over A,B: transfer
  A->>C: transferFrom(Alice, Bob, tokenId)
  Note over ACL: nothing changes.<br/>There was nothing on the seed to move or revoke.

  Note over B,ACL: Bob shakes
  B->>C: shake(tokenId)
  C->>ACL: allow(pick2, roll2, Bob)
  Note over ACL: pick2, roll2: [contract, Bob]

  A-xC: shake(tokenId) reverts NotHolder
  Note over A: Alice can still decrypt pick1 and roll1:<br/>what she already saw. She cannot get anything new.
```

| Event | ACL change | Why |
| --- | --- | --- |
| mint | contract allowed on the seed | The contract must compute on it later |
| shake, paidShake | contract and viewer allowed on two fresh ciphertexts | The relayer requires the contract on anything a user decrypts |
| feed | contract allowed on the new affection | |
| first duel | contract allowed on the cached score | |
| transfer | **none** | No holder is ever on the seed, the score or the affection |
| proveAlive | the alive bit becomes publicly decryptable | One bit, nothing else |
| acceptDuel | three duel values become publicly decryptable | |
| observe | seed and affection become publicly decryptable | Irreversible, like the grant |

What a previous holder keeps after a sale: the traits they shook out, which no system
could make them forget. What they lose: the right to shake, open, duel or entangle.

A buyer should assume the seller knows all five traits. The buyer can level that for the
price of a few paid shakes before buying.
