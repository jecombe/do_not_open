# Flows

Participants used throughout:

- **App**: the web app and its `EvmFhevmAdapter`.
- **Contract**: `DoNotOpen` on the host chain.
- **Coprocessor**: executes the FHE operations the contract requests symbolically.
- **Relayer / KMS**: Zama's relayer in front of the threshold key management service.

One thing differs from the original brief in every flow that reveals something: **there
is no on-chain decryption callback** on the current protocol. A reveal is two
transactions with an off-chain decryption in between, and the second transaction can be
sent by anyone. See [ZAMA_NOTES.md](ZAMA_NOTES.md).

## Mint

```mermaid
sequenceDiagram
  autonumber
  actor U as Minter
  participant App
  participant C as Contract
  participant Co as Coprocessor
  U->>App: Mint n boxes
  App->>C: mint(n) + n x price
  loop each box
    C->>Co: randEuint64() returns the seed handle
    C->>C: allowThis(seed), _mint(minter, tokenId)
    C-->>App: Minted(tokenId, minter)
  end
  Note over C,Co: The seed exists only as a ciphertext. Nobody can read it:<br/>not the minter, not the deployer, not a block producer.
```

There is nothing to front-run: the value being drawn is not visible in the mempool, in
the transaction, or after it.

## Shake (user decryption)

```mermaid
sequenceDiagram
  autonumber
  actor U as Holder
  participant App
  participant C as Contract
  participant Co as Coprocessor
  participant R as Relayer / KMS
  U->>App: Shake
  App->>C: shake(tokenId)
  C->>Co: pick = one of five offsets, from an encrypted draw
  C->>Co: roll = uint8(seed >> pick)
  C->>C: allow the holder on pick and roll, store as lastShake
  C-->>App: Shaken(tokenId, holder, paid = false)
  App->>C: lastShake(tokenId, holder)
  C-->>App: two handles
  opt first shake of the session
    App->>U: sign EIP-712 permit (session public key, this contract, 1 day)
  end
  App->>R: userDecrypt(handles, permit)
  R->>C: is the holder allowed on these handles? (ACL)
  R-->>App: values re-encrypted for the session key
  App->>App: decrypt locally
  App-->>U: Mood, Judging
```

`paidShake` is the same flow for a non-holder, with a fee: 70% is credited to the
holder (pulled later with `claim`), and only the payer is allowed on the result.

The event says a shake happened. It does not say which trait: the pick is encrypted.

## Feed

```mermaid
sequenceDiagram
  autonumber
  actor U as Anyone
  participant C as Contract
  participant Co as Coprocessor
  U->>C: feed(tokenId) + fee
  C->>Co: gain = randEuint8(4)
  C->>Co: affection = affection + gain
  C->>C: allowThis(affection), feedCount += 1
  C-->>U: Fed(tokenId, feeder)
```

The count is public, the amount is not. If every feed added exactly 1, the counter would
give the affection away.

## Alive check (one public bit)

```mermaid
sequenceDiagram
  autonumber
  actor U as Holder
  participant App
  participant C as Contract
  participant Co as Coprocessor
  participant R as Relayer / KMS
  U->>App: Is it alive?
  App->>C: proveAlive(tokenId)
  C->>Co: alive = uint16(seed) < aliveBelow
  C->>C: makePubliclyDecryptable(alive), aliveCheck = Pending
  App->>R: publicDecrypt([alive handle])
  R-->>App: clear value + KMS proof
  App->>C: finalizeProveAlive(tokenId, value, proof)
  C->>C: checkSignatures(handle from storage, value, proof)
  C->>C: aliveCheck = Alive or NotAlive
  C-->>App: AliveProven(tokenId, alive)
```

One request per box. The answer is public whichever way it falls.

## Open a box (public decryption)

```mermaid
sequenceDiagram
  autonumber
  actor U as Holder
  participant App
  participant C as Contract
  participant R as Relayer / KMS
  participant Any as Anyone
  U->>App: Open the box
  App->>C: observe(tokenId) + fee
  C->>C: status = Observing
  C->>C: makePubliclyDecryptable(seed, affection)
  opt entangled and partner still sealed
    C->>C: same for the partner
  end
  C-->>App: ObserveRequested(tokenId)
  App->>C: observeHandles(tokenId)
  App->>R: publicDecrypt(handles)
  R-->>App: clear values + KMS proof
  alt the app is still open
    App->>C: finalizeObserve(tokenId, values, proof)
  else the user left
    Any->>C: finalizeObserve(tokenId, values, proof)
  end
  C->>C: status must be Observing
  C->>C: checkSignatures(handles rebuilt from storage, values, proof)
  C->>C: decode the seed into state, traits, score. Golden if affection > 10
  C->>C: store Revealed, status = Revealed
  C-->>App: Observed(tokenId, seed, state, score, golden)
  App->>App: buildCatSpec(seed, affection), then the opening sequence
```

```mermaid
stateDiagram-v2
  [*] --> Sealed: mint
  Sealed --> Observing: observe (holder, fee)
  Sealed --> Observing: observe of the entangled partner
  Observing --> Revealed: finalizeObserve (anyone, valid proof)
  Revealed --> [*]
  note right of Sealed: shake, paidShake, feed, proveAlive,\nentangle and duel only work here
  note right of Observing: no way back, no timeout
```

## Entangle

```mermaid
sequenceDiagram
  autonumber
  actor A as Holder of A
  actor B as Holder of B
  participant C as Contract
  A->>C: proposeEntangle(A, B)
  C->>C: both sealed, neither entangled
  C-->>B: EntangleProposed(A, B)
  B->>C: acceptEntangle(A, B)
  C->>C: proposer still holds A?
  C->>C: partner[A] = B, partner[B] = A
  C-->>A: Entangled(A, B)
  Note over A,C: Later, either holder opens their box
  A->>C: observe(A)
  C->>C: A and B both go to Observing
  Note over C: Each box then needs its own finalizeObserve
```

No FHE operation is involved. The link is permanent and follows the tokens when they are
sold: whoever buys an entangled box can have it opened by the partner's holder.

## Duel

```mermaid
sequenceDiagram
  autonumber
  actor A as Holder of A
  actor B as Holder of B
  participant C as Contract
  participant Co as Coprocessor
  participant R as Relayer / KMS
  A->>C: challengeDuel(A, B)
  C->>Co: score(A), computed once and cached
  C-->>B: DuelChallenged(duelId, A, B)
  B->>C: acceptDuel(duelId)
  C->>C: challenger still holds A? both sealed?
  C->>Co: score(B), computed once and cached
  C->>Co: aWins = score(A) > score(B)
  C->>Co: pick = random trait offset
  C->>Co: loserRoll = select(aWins, roll(B, pick), roll(A, pick))
  C->>C: makePubliclyDecryptable(aWins, pick, loserRoll)
  C-->>A: DuelAccepted(duelId)
  A->>R: publicDecrypt(duelHandles)
  R-->>A: clear values + KMS proof
  A->>C: finalizeDuel(duelId, values, proof)
  C->>C: checkSignatures, wins[winner] += 1
  C->>C: record the loser's trait as public
  C-->>B: DuelResolved(duelId, winner, loser, trait, roll)
```

```mermaid
stateDiagram-v2
  [*] --> Challenged: challengeDuel (holder of A)
  Challenged --> Cancelled: cancelDuel (challenger)
  Challenged --> Pending: acceptDuel (holder of B)
  Pending --> Resolved: finalizeDuel (anyone, valid proof)
```

The loser's roll is chosen with an encrypted `select`, so the winner's roll for that
trait is never in a decryptable ciphertext. Ties go to B. The score compared is the base
score; the golden bonus only exists once a box is opened.

## What the app does when a step is interrupted

Every two-step action can be picked up later, by anyone:

| Left in | Shown in the app | Adapter call |
| --- | --- | --- |
| Box `Observing` | "Finish opening" | `finishObserve` |
| Alive check `Pending` | "Finish the check" | `finishProveAlive` |
| Duel `Pending` | "Reveal the result" | `finishDuel` |
