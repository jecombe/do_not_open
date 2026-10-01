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

## Croquettes

Rules and numbers are in [CROQ.md](CROQ.md). Two more participants:

- **Pantry**: holds the croquette reserve, the treasury's share and the burnt pile, and
  counts each cat's encrypted weight.
- **cCROQ**: the confidential token, an ERC-7984 wrapper around the plain ERC-20 CROQ.

### Buy and wrap, unwrap and sell

```mermaid
sequenceDiagram
  autonumber
  actor P as Player
  participant U as Uniswap V2 router
  participant C as CROQ (ERC-20)
  participant W as cCROQ
  P->>U: swapExactETHForTokens(min, [WETH, CROQ]) + ETH
  U-->>P: CROQ (public)
  P->>C: approve(cCROQ, n)
  P->>W: wrap(player, n)
  W->>C: transferFrom(player, cCROQ, n)
  W->>W: mint n, encrypted, to the player
  Note over P,W: The player's balance is now readable by the player only
```

The way back is two steps, because the amount must be decrypted publicly before plain
tokens can move:

```mermaid
sequenceDiagram
  autonumber
  actor P as Player
  participant W as cCROQ
  participant R as Relayer / KMS
  participant C as CROQ (ERC-20)
  participant U as Uniswap V2 router
  P->>P: encrypt n for (cCROQ, player)
  P->>W: unwrap(player, player, handle, proof)
  W->>W: burn up to n; makePubliclyDecryptable(burnt)
  W-->>P: UnwrapRequested(player, requestId)
  P->>R: publicDecrypt([requestId])
  R-->>P: n + KMS proof
  P->>W: finalizeUnwrap(requestId, n, proof)
  W->>C: transfer(player, n)
  P->>U: swapExactTokensForETH(n, min, [CROQ, WETH])
```

If the balance was short, the burn moves 0 and the decrypted amount is 0. Anyone can
send `finalizeUnwrap`; the tokens go to the address set in the request.

### Claim the welcome bag and the purr

```mermaid
sequenceDiagram
  autonumber
  actor H as Holder
  participant Pa as Pantry
  participant B as DoNotOpen
  participant Co as Coprocessor
  participant W as cCROQ
  H->>Pa: claim(tokenIds), at most 10
  loop each box
    Pa->>B: ownerOf(tokenId) == holder
    alt never claimed
      Pa->>Pa: bags += 100, lastPurr = now
    else whole days owed (at most 7)
      Pa->>B: vetCertified(tokenId)
      Pa->>Co: randEuint8() mod 5, × days, × 2 if certified, >> halvings
    end
  end
  Pa->>Co: total = min(bags + draws, reserve); reserve -= total
  Pa->>W: confidentialTransfer(holder, total)
  Pa-->>H: WelcomeBag(tokenId, holder) per new box, Purred(holder, boxes)
```

### Feed croquettes

```mermaid
sequenceDiagram
  autonumber
  actor H as Holder
  participant App
  participant Pa as Pantry
  participant W as cCROQ
  participant Co as Coprocessor
  opt first meal
    H->>W: setOperator(Pantry, until)
  end
  App->>App: Relayer SDK: encrypt n for (Pantry, holder)
  H->>Pa: feed(tokenId, handle, proof)
  Pa->>Pa: caller holds the box, box is Sealed, fewer than 2 meals today
  Pa->>Co: offered = fromExternal(handle, proof)
  Pa->>Co: capped = min(offered, 1000 - eaten today)
  Pa->>W: confidentialTransferFrom(holder, Pantry, capped)
  W-->>Pa: moved: capped, or 0 if the holder holds less
  Pa->>Co: weight += moved; eaten today += moved
  Pa->>Co: treasury += 20%; burnt += 20%; reserve += the rest
  Pa-->>H: MealServed(tokenId, holder, meals)
```

The ETH-paid `DoNotOpen.feed` is the other gesture: it pets the cat (affection), and
anyone may do it.

### Weigh a cat

```mermaid
sequenceDiagram
  autonumber
  actor A as Anyone
  participant B as DoNotOpen
  participant Pa as Pantry
  participant R as Relayer / KMS
  Note over B: the box was observed and finalised: status Revealed
  A->>Pa: weigh(tokenId)
  alt never ate
    Pa->>Pa: record weight 0: thin
  else
    Pa->>Pa: makePubliclyDecryptable(weight)
    Pa-->>A: WeighInRequested(tokenId, weightHandle)
    A->>R: publicDecrypt([weightHandle])
    R-->>A: weight + proof
    A->>Pa: finalizeWeigh(tokenId, weight, proof)
    Pa->>Pa: checkSignatures
  end
  Pa->>B: contentsOf(tokenId).seed
  Pa->>Pa: tolerance = keccak256(seed) folded; build; sick and disease
  Pa-->>A: Weighed(tokenId, weight, build, sick, disease)
```

```mermaid
stateDiagram-v2
  [*] --> Growing: first meal
  Growing --> Growing: feed (holder, sealed, 2 meals and 1,000 a day)
  Growing --> Frozen: observe (no more meals)
  Frozen --> Weighing: finalizeObserve, then weigh (anyone, once)
  Weighing --> Weighed: finalizeWeigh (anyone)
  Frozen --> Weighed: weigh, if it never ate
  Weighed --> [*]
```

### Send croquettes to another player

`cCroq.confidentialTransfer(to, handle, proof)`, with the amount encrypted for
(cCROQ, sender). Both sides can decrypt the amount moved; nobody else can. A sender
who holds too little moves 0.

## What the app does when a step is interrupted

Every two-step action can be picked up later, by anyone:

| Left in | Shown in the app | Adapter call |
| --- | --- | --- |
| Box `Observing` | "Finish opening" | `finishObserve` |
| Alive check `Pending` | "Finish the check" | `finishProveAlive` |
| Duel `Pending` | "Reveal the result" | `finishDuel` |
| Box revealed, not weighed | "Weigh the cat" | `weigh` |
| Weigh-in pending | "Weigh the cat" | `weigh` (picks up the pending one: `finalizeWeigh`) |
