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

**What we do instead** (same pattern for observe, proveAlive, acceptEntangle, duel and
milestones):

1. `observe(tokenId)`: computes the encrypted answers ("the caller holds the box and
   paid", the seed and affection masked by it), calls `FHE.makePubliclyDecryptable` on
   them, stores their handles under a new request id, emits `RequestPlaced`.
2. Off-chain, anyone calls `relayer.publicDecrypt(handles)` and gets cleartexts plus a
   KMS proof.
3. `finalize(requestId, cleartexts, proof)`: permissionless. Takes the handle list
   stored at the request, calls `FHE.checkSignatures`, then stores plaintext and sets
   `Revealed`, or settles the request `Refused` if the caller did not hold the box.

The "callback" is a normal transaction that anyone may send. The frontend sends it for
the user; a keeper can sweep stragglers. Since 2026-10-01 there is no intermediate box
state: a box stays `Sealed` until an opening is finalized (see the last section).

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
`packages/contracts-evm/README.md` and [HIDDEN_OWNERS.md](HIDDEN_OWNERS.md#7-cost). A mint
of 10 ids is about 3.3M HCU and 2.6M gas, so the batch limit (10 ids per transaction) is
set by EVM gas, not by HCU.

### 7. Solana

Zama's SVM support is announced, not shipped; nothing can be verified yet.
`packages/chain-adapter/solana` stays a documented stub until the SDK exists.

## Decisions taken in Phase 2

### One ciphertext per box instead of eight

The brief lists `state` (euint8), five traits (euint8), `rarityScore` (euint32) as
stored encrypted fields. The contract stores **only the seed** and derives the rest
when a function needs it:

- `mint` is a single FHE operation per box instead of roughly twenty (the hidden-owner
  mint adds an encrypted owner and the quantity checks, still one seed);
- `shake` cuts the picked byte out of the seed with one encrypted shift;
- `proveAlive` compares the low 16 bits of the seed with one threshold;
- `observe` decrypts one handle, and state, traits and score are then computed in plain
  Solidity by `DoNotOpenConfig.decode`, which a test pins to the TypeScript generator.

Phase 3's `duel` needs an encrypted score: it will be computed on first use and cached.
The score fits 16 bits (maximum 3040), so it will be a `euint16`, not the `euint32` of
the brief: smaller types are cheaper to compare.

### `revealed` is a view

Box state is one enum; `revealed(tokenId)` reads it. It was `Sealed`, `Observing`,
`Revealed` until 2026-10-01, and is now `Sealed`, `Revealed`: a pending opening is a
request, not a state.

### `_mint`, not `_safeMint`

No receiver callback during mint, so no re-entrancy surface there. A contract that
cannot handle ERC-721 tokens can still mint to itself; that is the minter's risk. The
Confidential ERC-721 has no safe transfer at all: a receiver hook would be called on
transfers that did not move anything.

## Decisions taken in Phase 3

### Feeding adds a hidden amount, not 1

The brief says feed "increments affection in encrypted form". If each feed added
exactly 1, anyone could count `Fed` events and know the affection: the encryption would
hide nothing. Each feed therefore adds an encrypted uniform draw in 0..3
(`FHE.randEuint8(4)`). What they earned is not public. Since 2026-10-01 the number of
feeds is not kept either: an unpaid feed emits the same `Fed` event and adds 0. The
golden threshold stays at "affection > 10", about seven paid feeds on average.

A cat with no accessory that crosses the threshold gets a golden bell collar.

### Duel: few values become public, in one round

Accepting a duel computes, under encryption, `scoreA > scoreB`, a uniform trait pick, and
`select(aWins, rollOfB, rollOfA)`: the loser's roll for the picked trait. Only those three
ciphertexts are made publicly decryptable, so one `finalizeDuel` settles everything and
the winner's trait is never decryptable by anyone. Since 2026-10-01 a fourth value comes
first, `valid` ("both sides held their boxes"), and the other three are masked by it.
Since 2026-10-02 a fifth comes before it, `aHolds` ("the challenger still holds A"), and
`valid` is `aHolds AND accepter holds B`. A duel where A was no longer held ends `Void`
and says nothing about the accepter; one where only B was not held goes back on the shelf.

### Duel: posting is public, and proven

Since 2026-10-02 a duel is not aimed at a box whose holder may never look. `postDuel` puts
box A on a duel shelf, open to any sealed box or reserved for one, and makes "the caller
holds A" publicly decryptable. One `finalizeDuel` with that bit's proof puts it on the
shelf for 7 days (`DUEL_LIFETIME`), or voids it. Without the proof, anyone could fill the
shelf with boxes they do not hold. A duel is a public act, so this reveals what a resolved
duel would have revealed anyway, only earlier. A box has one listing at a time: a newer
proven posting cancels the older one, unless that one was accepted and waits for its
outcome. Then the new posting gives way: the outcome is public from the acceptance on, and
a challenger able to cancel it could read it and escape every loss (fixed on 2026-10-03).

Each box's encrypted score is computed once (about 1.35M HCU) and cached. The challenger
pays for their box at `postDuel`, the accepter for theirs at `acceptDuel`.

### Consent is two transactions

`proposeEntangle` / `acceptEntangle` and `postDuel` / `acceptDuel`. A proposal or a
duel is void if the proposer's or challenger's box changes hands before it is accepted:
since 2026-10-01 this is checked under encryption at acceptance (a refused entanglement, a
void duel). One holder may entangle or duel two of their own boxes.

### Entanglement is permanent and follows the token

There is no way to untangle. Whoever buys an entangled box can have it opened by the
partner's holder; marketplaces should show `partnerOf`.

### Prices in USDC, paid in cUSDC

Since 2026-10-01 every price is in USDC (6 decimals): mint 5, open 1, feed 0.5, paid shake
2.5. On Sepolia the collection uses Zama's `USDCMock` (`0x9b5C…dFfF`, anyone can mint it)
and its wrapper `cUSDCMock` (`0x7c5B…3639`); locally, `TestUSDC` and `TestConfidentialUSDC`
stand in. The contract reads nothing else from them: they are immutables.

The hidden-owner contracts take cUSDC only. An ERC-7984 transfer never reverts for a
short balance, it moves 0; instead of deciding in the clear whether it was paid, the
contract masks what the payment buys with `paid == price` under encryption (see the last
section). The previous version, deployed below, also took plain USDC, and settled cUSDC
payments through a two-step order; both are gone.

### Paid shake earnings are pulled, not pushed

The holder's 70% of a paid shake waits in the box, encrypted (`_earnings`), and is paid
to whoever holds the box when they call `claimEarnings(tokenIds)`. Nothing is sent to a
holder in the middle of `paidShake`, so there is no re-entrancy path, and nobody learns
who holds the box.

### Contract size

`DoNotOpen` is 24,512 bytes of deployed bytecode against the 24,576 limit, since the
duel shelf, the 2026-10-03 security fixes and decoy transfers (see the hidden owners' "Contract size" below for how it was brought back
under). The next feature must move logic to a library or a second contract that is a
trusted reader.

### Sepolia deployment (2026-10-01): prices in USDC and cUSDC

Superseded by the hidden-owner contracts (below); kept for the
record. This `DoNotOpen` is an ERC-721 with public owners and takes USDC or cUSDC instead
of ETH, so it was redeployed, and with it the whole croquette economy (a Pantry is tied
to one collection).

| Contract          | Address                                      |
| ----------------- | -------------------------------------------- |
| `DoNotOpen`       | `0xe8f699eEBc22767413A9edBb48826B10D3117f61` |
| `DoNotOpenConfig` | `0xa5D7870f643537b85A575Ab716446fdb6F022780` |
| `Croq`            | `0x183B74906673283f7Fe3272103989A357Cf88522` |
| `ConfidentialCroq`| `0x7598484e5DDdada766ab19Cd7d0dD42d17Dd4F06` |
| `Pantry`          | `0x20755493eF05C954BdC2e970b0437B12AE19d01e` |
| CROQ/USDC pair    | `0xDc7Ed9F6ffd2993350BDc2c563E42036C5a53B43` |
| `UsdcRamp`        | `0x20FB2d7f2d3fb249924ce3871255bb417670ba50` |
| ETH/USDC pair     | `0x58151722a43de9a7A850dF12f6D9924B19E50F8D` |
| USDC (`USDCMock`) | `0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF` |
| cUSDC (`cUSDCMock`)| `0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639` |

Spec hash `0x73a897cddadf28e8a6e49da208906c5931fa901243a89035a1507dc854eea22f`.
`DoNotOpen` took 5,391,855 gas. CROQ now trades against USDC: the pool was seeded with
4,000,000 CROQ and 4,000 USDC, LP tokens sent to `0x…dEaD`. No ETH/USDCMock pool existed
for the ramp, so one was opened with 0.1 ETH and 250 USDC; its LP tokens stay with the
deployer. An earlier run of the same code an hour before, with a CROQ/WETH pool
(`DoNotOpen` `0x33Cf…4dC1`), passed `smoke:sepolia` end to end, cUSDC mint and feed
included, and was replaced only to move the market to USDC.

### Superseded: 10,000 boxes and croquettes, priced in ETH (2026-10-01)

The spec's `maxSupply` went from 5,000 to 10,000 and the `economy` section was
added, so the spec hash changed and `DoNotOpen` was redeployed with the same code.

| Contract          | Address                                      |
| ----------------- | -------------------------------------------- |
| `DoNotOpen`       | `0x880D284333F4001Bfd199899f8243D78b486e077` |
| `DoNotOpenConfig` | `0xe2Ce2fC413aE3cf9d0CAF663eb7B357689bF9D1A` |
| `Croq`            | `0x72Fc0E0654f268A0785f92D63450c813cAFDfD10` |
| `ConfidentialCroq`| `0xa89c19228261EAc5Fa48f544238d04fBC115393c` |
| `Pantry`          | `0x8a58e2Cc6E11A3CC108612cfc6677A425Ff49882` |
| CROQ/WETH pair    | `0x645D0d391F088895272b200aa6E187aCd00F270d` |

Spec hash `0x61ccbbdacc6cd383532495d66c7edf9df99434d7e36e51d7cc4458e6af27270f`.
`Pantry.fund` wrapped 11,000,000 CROQ into the reserve; the pair was seeded through the
Uniswap V2 router `0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3` with 4,000,000 CROQ and
0.02 ETH (WETH `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14`). On-chain reads after the
deploy: `maxSupply` 10,000, CROQ total supply 20,000,000, 11,000,000 held by the
wrapper, pair reserves 4,000,000 CROQ and 0.02 WETH.

Superseded 5,000-box deployment (Phase 3 mechanics plus the two Phase 4 views):

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
- Every secret of a box is drawn on-chain. The encrypted inputs are the quantity of a
  mint (`add8`, since 2026-10-01) and croquette amounts: a meal, a confidential transfer
  and an unwrap (cCROQ, or cUSDC back to USDC: `unshieldUsdc`) each carry an amount encrypted
  in the page with `createEncryptedInput`; an unwrap then decrypts it in public to pay it out. Input proofs
  run single-threaded; the cross-origin isolation headers that would enable threads are
  not set.
- `createInstance` is given the read RPC URL, not `window.ethereum`, so decryption of
  public values works before any wallet is connected.

### Decisions

- **One permit per session.** A shake needs a user decryption, which needs an EIP-712
  signature over a fresh keypair. The adapter signs once (valid one day, for DoNotOpen
  and cCROQ, so the same permit reads shakes and croquette balances) and keeps the keypair in memory, so the wallet prompts once, not at every shake.
  Nothing is written to storage: a reload asks again.
- **Retries on decryption.** The coprocessor computes a ciphertext a few seconds after
  the transaction that requested it. Asking the relayer too early fails, so decryptions
  are retried up to five times with a growing pause.
- **Two-step actions can be resumed.** observe, proveAlive and acceptEntangle each end
  with a proof transaction, a duel with two (the posting, then the outcome). If the user
  closes the tab in between, the request (or duel) stays pending; the app lists the
  account's pending requests and anyone can send
  the proof. The adapter exposes `pendingRequests`, `finishRequest`, `finishObserve`,
  `finishProveAlive` and `finishDuel`.
- **Reads do not need a wallet.** They go to a public RPC endpoint. After each
  transaction the adapter waits until that endpoint has seen the block, because public
  endpoints are load-balanced and can answer from a node that is one block late.
- **No enumeration on-chain.** Since 2026-10-01 owners are encrypted: there is no
  `ownerOf` or `balanceOf`. `boxesOf` reads the connected account's own
  `ConfidentialTransfer` events, decrypts their "moved" bits and replays them; it returns
  nothing for another account. An indexer can serve the events, never the answer.
- **Two views added to the contract** for the front end: `feedCount(tokenId)` and
  `entangleProposer(a, b)`. Deployed bytecode was then 20,468 bytes. `feedCount` was
  removed with the hidden owners.

### Mainnet

The Sepolia relayer is open. The Zama-hosted **mainnet relayer needs an API key**, which
must not reach the browser, and Zama bills the key's holder monthly for every decryption
and every encrypted input verified (checked on docs.zama.org on 2026-10-02: fees are priced
in USD, paid in $ZAMA, $0.001 to $0.10 a decryption and $0.005 to $0.50 an input, the low
end with a monthly plan; FHE computation itself is free). The game would pay for its
players, so three things keep that bill bounded:

- **Nothing is decrypted twice.** A handle names one ciphertext forever: the adapter keeps
  every value it decrypted, by handle, in the browser (`LocalStorageDecryptCache`). A
  returning player's old receipts and an unchanged cUSDC balance cost nothing.
- **The relayer proxy** in `apps/api` holds the key and lets through only the protocol's
  own decryptions and inputs (see its README).
- **A public decryption is paid once.** Free for players, so nothing else would stop someone
  from asking for an old duel's result in a loop at the collection's expense: the proxy
  keeps each request's job and answer, and a handle may be named in at most four requests
  sent to Zama (`RELAYER_PUBLIC_PER_HANDLE`).
- **Units and credits.** Everything a wallet asks Zama for is counted in units: a decrypted
  value is one, an encrypted input five (`RELAYER_INPUT_UNITS`: Zama charges an input five
  times a decryption, at every plan). Each player gets free units every day
  (`RELAYER_FREE_PER_DAY`, 25); a wallet the index has never seen act on-chain or be sent a
  box gets fewer (`RELAYER_NEWCOMER_PER_DAY`, 16: one 10-id mint), so a farm of fresh
  wallets is worth little. Past them, the proxy spends credits bought from
  `DecryptionCredits` in plain USDC, one credit a unit. Since play is in cUSDC, the bureau
  de change can keep a share of a cUSDC purchase plain (5 to 20%) for those credits.
- **An input is charged to the wallet it is for**, which proves it is itself with the
  user-decryption permit it already signed (sent as a bearer token): nobody can spend
  another wallet's units by making inputs in its name.

How much a game action costs, before the cache: a shake 2 units, a mint 5 for its input plus
1 per id it hides among (10 by default) and 1 for the balance, a meal or a croquette send 5,
a cUSDC payment 1 to read the balance first. An opening (2 to 5), a duel (6), a weigh-in, an
alive check, a milestone or an unwrap are public decryptions: free for players, paid by the treasury.
Checked on Sepolia through a local proxy: a newcomer's 1-box mint among 1 id took 7 units
(5 + receipt + balance), and the wallet had a player's allowance once the mint was indexed.
Open question for Zama: is a decryption billed per value or per request?

**Does it pay for itself?** The paid actions do at any plan: a mint (5 USDC) costs Zama
$0.016 to $1.60, an opening (1 USDC) up to $0.50, a pet (0.5) up to $0.10, a paid shake (0.75
to the treasury) up to $0.30. What is free to players (their daily units, public
decryptions) is paid from those fees. With a monthly plan ($0.001 a decryption) the margin is
large; pay-as-you-go ($0.10) is not sustainable with a generous allowance.

**Credit price.** Zama prices in dollars and takes $ZAMA at its oracle's rate, and credits
are sold in USDC, so a credit's price follows Zama's dollar price for one decryption times a
margin, never the token's market price (`packages/contracts-evm/lib/creditPrice.ts`, rounded
up). It is set at deploy from `CREDIT_PRICE_USDC`, or `ZAMA_DECRYPT_USD` x `CREDIT_MARGIN`
(2), and changed later with `dno:credit-price` without redeploying.

Before mainnet: once the Zama plan is known, `dno:credit-price --zama <price> --margin 2`.
On pay-as-you-go, set `RELAYER_NEWCOMER_PER_DAY=0`, lower `RELAYER_FREE_PER_DAY` and raise
the credit price to at least $0.10 x margin.

### Not verified

- A real browser wallet extension. The browser run used a local signing proxy behind an
  injected EIP-1193 object, which exercises the same adapter code (`eth_requestAccounts`,
  `eth_sendTransaction`, `eth_signTypedData_v4`) but not MetaMask's own prompts, its
  network switching, or account change events.
- The two-holder flows in the browser (accepting someone else's duel or entanglement).
  They are covered by the mock adapter's tests and by the contract tests, and the smoke
  script ran them on Sepolia with one account holding both boxes.
- `paidShake` and `claimEarnings` on Sepolia: they need a second funded account. None of
  the hidden-owner contracts has run on Sepolia yet.

## Croquettes: decisions

### Two tokens, because AMMs need cleartext

An ERC-7984 balance is an `euint64`: no AMM can price against it. CROQ is therefore a
plain ERC-20 with a fixed supply, and the game uses cCROQ, OpenZeppelin's
`ERC7984ERC20Wrapper` from `@openzeppelin/confidential-contracts` **0.5.3**, the release
that pins `@fhevm/solidity` 0.11.1 like the rest of this repo. It is used unmodified.

### `fromExternal` in the Pantry, then hand the handle to cCROQ

An input proof is bound to a (contract, user) pair: the contract that calls
`FHE.fromExternal` and the `msg.sender` it sees. If the Pantry forwarded the external
handle to `cCroq.confidentialTransferFrom(from, to, externalEuint64, proof)`, cCROQ
would check it against (cCROQ, Pantry), which no user can produce. So the user encrypts
for the Pantry, and the Pantry does:

```solidity
euint64 offered = FHE.fromExternal(amount, inputProof); // proof for (Pantry, msg.sender)
euint64 capped = FHE.min(offered, maxEatenPerDay);      // the daily cap, never a revert
FHE.allowTransient(capped, address(cCroq));             // let cCROQ compute on it
euint64 moved = cCroq.confidentialTransferFrom(msg.sender, address(this), capped);
```

The `euint64` overload of `confidentialTransferFrom` requires the caller (the Pantry)
to be allowed on the handle, which `fromExternal` gives transiently, and returns the
amount actually moved with a transient grant back to the Pantry. Purrs and the
treasury's `collect` use the same pattern: `allowTransient(amount, cCroq)`, then
`confidentialTransfer(to, amount)`.

### A cap on an encrypted amount

The Pantry cannot revert on an amount it cannot read. The daily cap of 1,000 per cat is
applied with `FHE.min(offered, maxEatenPerDay - eatenToday)` before the transfer: an offer
past the day's allowance is cut down silently, and only what was eaten leaves the
wallet. Since 2026-10-01 the meal count and the holder check are encrypted too: a third
meal of the day, or a meal from someone who does not hold the cat, moves 0 instead of
reverting.

### ERC-7984 operators, not allowances

A player lets the Pantry pull cCROQ with `setOperator(pantry, until)`: an expiry
instead of an amount. The Pantry only pulls in `feed`, from `msg.sender`.

### Bounded draws that are not powers of two

`FHE.randEuint8(bound)` needs a power-of-two bound, and the purr is 0..4. The Pantry
draws a full byte and takes `FHE.rem(roll, 5)`. 256 is not a multiple of 5, so 0 is
1/256 more likely than the other values; that bias is accepted. `rem` on 8 bits keeps
the cost down: the whole draw, scaling and sum come to about 680,000 HCU per box.

### Skip the FHE work once the result is known to be zero

The purr is shifted right once per halving. The Pantry computes in the clear whether
the best possible purr, `purrMaxPerDay × days × multiplier`, survives the shift. If it
does not, it skips the draw, and the box adds nothing to the reserve check. A claim
still asks `isOwner` and pays out for every box with a stash, so it is no longer free
once a box has something waiting.

### The weigh-in reads the box contract, it does not change it

The Pantry reads `status`, `vetCertified`, `isOwner` (an encrypted answer, as a trusted
reader set with `setTrustedReader`) and, after the reveal, `contentsOf(tokenId).seed`
through a small interface. It never writes to `DoNotOpen`. A cat's weight is
made public with `makePubliclyDecryptable` and proved back with `checkSignatures`, like
an opening. Its tolerance needs no FHE at all: it is `keccak256(seed)`, computed in the
clear once the seed is public, and secret until then because the seed is.

### Burning is locking

A real burn on the wrapper would only destroy the confidential side: the plain CROQ
behind it stays in the wrapper either way. The Pantry keeps burnt croquettes in its own
balance under an encrypted total and has no code path that moves them.

### HCU

| Function | HCU |
| --- | --- |
| `feed` | ~3,680,000 (with the encrypted holder check and meal count) |
| `claim`, 3 boxes | ~2,600,000 to ~4,500,000 |
| `claim`, 10 boxes | ~13,000,000 |
| `weigh` + `finalizeWeigh` | ~0: one public decryption request |
| `collect` | ~590,000 |

`maxBoxesPerClaim` is 10. Before the hidden owners a 10-box claim was ~6.8M HCU and 20
boxes measured 13.6M with a depth of 4.4M; the stash and the holder check per box now
bring 10 boxes to about 13M, still under the limits.

## Hidden owners: decisions (2026-10-01)

Who holds which box, how many boxes an account holds and how many were sold are now
encrypted. The design, its leaks and its costs are in [HIDDEN_OWNERS.md](HIDDEN_OWNERS.md);
this section records why, from the protocol's side.

### A Confidential ERC-721, written here

Neither Zama nor OpenZeppelin ships a confidential NFT standard (ERC-7984 is fungible).
`IConfidentialERC721` (ERC-165 `0x87ffe7a2`) stores each owner as an `eaddress` and borrows
ERC-7984's shape: operators with an expiry, transfers that return an encrypted bool. As a
zero amount does in ERC-7984, `confidentialTransferIf` lets a holder send a decoy: an
encrypted `really` set to false moves nothing. Once a holder is public, decoys sent with the
real transfer keep the doubt about where the box went. A decoy needs an input proof; one
encryption holds the bits for every transfer of a send, each used in its own transaction.
`ownerOf` and `balanceOf` cannot exist: their answer would be the secret.

### Nothing reverts on ownership, so everything is a request

A revert on "not the holder" would publish the comparison. Every action compares
`owner == caller` under encryption and masks its effect with the result. Where something
must become public (an opening, an alive check, an entanglement), the masked answers are
made publicly decryptable and a second, permissionless transaction proves them with
`finalize(requestId, cleartexts, proof)`. The handles are stored with the request, so a
proof for another request cannot be replayed.

### Masked outputs

Every published value is `select(holds, value, 0)`, with `holds` published first. A
refused request decrypts to "no" and zeros: it says nothing about the box, and a stranger
can request as often as they like without learning anything. A duel publishes one value
at posting ("the challenger holds A"), then five at acceptance (`aHolds`, `valid`,
`aWins`, `pick`, `loserRoll`), the last three masked by `valid`, and `valid` itself false
whenever `aHolds` is.

### Empty token ids hide the quantity

An encrypted quantity is useless if the mint creates exactly that many ids. So a mint
creates `ids` ids (1 to 10, public) and owns the first `quantity` of them; the others get
owner `address(0)`, the same seed draw and the same events. Token ids therefore run past
10,000, and `buildBoxSpec` accepts any 32-bit id. More ids cost about 174,000 gas each.

### Milestones instead of a counter

A public supply counter would give every mint's quantity away. The sold count is an
`euint16`, capped at 10,000 under encryption (a mint past the cap gets nothing and pays
nothing). After each mint one bit, "the next milestone is reached", is publicly
decryptable, and `announceMilestone` proves it. The milestones are in `spec.json`
(`collection.milestones`): 100, 500, 1,000, 2,500, 5,000, 7,500, 9,000, 10,000.

### A public decryption refuses the same handle twice

Found while testing entangled openings: `publicDecrypt` rejects a request whose handle
list contains one handle twice. Two entangled boxes that were never fed would both
publish `select(ok, 0, 0)` on the same operands, and a handle is derived from the
operation and its operands: the same handle twice. So an unfed
box publishes no affection at all; `Request.fed` records which boxes carry one, and
`finalize` reads the cleartexts accordingly.

### The Pantry is a trusted reader

`isOwner(tokenId, account)` answers only the account, its operators, and contracts the
collection trusts. The Pantry is set as one at deploy (`setTrustedReader`), and promises
never to make what it learns public: its holder checks only mask amounts.

### Contract size

`DoNotOpen` is 24,512 bytes deployed, 64 under the limit. The duel shelf took it past the
limit; two changes brought it back: the `onlySealed` modifier calls `_requireSealed`
instead of carrying the check, so its body is not copied into every function using it,
and the optimizer runs at 200 instead of 800 (`hardhat.config.ts`), which favours size
over the gas of each call. The 2026-10-03 security fixes then fit by dropping
`revenueHandle` (nobody may read the revenue any more) and keeping the withdrawal clock
private. Decoy transfers (`confidentialTransferIf`, 217 bytes) fit by compiling
`DoNotOpen` alone with the optimizer at 1 run (a per-file override in `hardhat.config.ts`;
the other contracts stay at 200): gas per call barely moves, as FHE operations dominate.
The next feature has to move logic out.

### The studio's packs stay off FHE (2026-10-04)

The studio sells AI generations in packs (`StudioPacks`), paid in plain USDC like the
decryption credits and for the same reason (it draws rats, not cats, and says nothing about
the boxes): `transferFrom` moves the whole price or
reverts, where a cUSDC payment that falls short moves 0 without a revert, and the backend
must know for certain what was paid before it pays a service. A pack says nothing about the
boxes, so nothing in it needs encrypting. It is its own contract: `DoNotOpen` has no room
left, and the studio is sold beside the collection, not by it. For the same reason its
numbers live in `packages/game-spec/studio.json`, not `spec.json`, whose hash the deployed
`DoNotOpenConfig` stores. Deployed on Sepolia on 2026-10-04 at block 11842636, at
`0x672cf76a68d4f181387B59caA1813eC425c1354C`, by `0x590891F269720001435004A1089cAB5b2c20029A`; owner and
treasury `0x6a18cFC3fAeef453B295B12246d40a82593b3208`, the collection's. 641k gas.

### The rats are a plain ERC-721 (2026-10-04)

Adopted rats (`Rats`) and their croquettes (`RatPantry`) use no FHE. A rat is a cosmetic
companion with nothing to hide, and a public owner is what lets marketplaces and wallets show
it; the hidden-owner machinery (encrypted owners, receipts, decoys) stays where it matters,
on the boxes. Deployed on Sepolia on 2026-10-04: `Rats` at `0xd4f8Df0F14Ced442077762cb81e843656BAc3856`
and `RatPantry` at `0x9c83C67e690CF8fb6CFaFE8f1DA5221D20520a0A`, by `0x5908…029A`; owner and treasury
`0x6a18…3208`, attester the API's `0x829CEf2139fEc8664ab0886e2AEd1A07fE497911`. The pantry pays plain CROQ for the same reason, and because an encrypted
amount would need cCROQ, the coprocessor and an ACL grant per claim for nothing to hide.
Like the studio's packs, both live outside `DoNotOpen` (no room left) and read nothing from
it; their numbers are in `studio.json`, not `spec.json`.

### Sepolia deployment (2026-10-03): decoys and the security review

Current. Deployed at block 11836238 by `0x6a18cFC3fAeef453B295B12246d40a82593b3208`, which
owns every contract and is the treasury. Everything was deployed again: the security
review changed `DoNotOpen`, `Pantry` and `DecryptionCredits`, decoy transfers changed the
token, and the spec's rule texts changed its hash, so `DoNotOpenConfig` too. A new `Pantry`
needs a funded reserve, so the croquette economy (CROQ, cCROQ, the locker and its pool)
started fresh. `UsdcRamp` was redeployed because its owner argument still named
`0x5908…029A`; every contract is now owned by the deployer. Credits bought from the old
`DecryptionCredits` stay there.

| Contract | Address |
| --- | --- |
| `DoNotOpen` (Confidential ERC-721, 10,000 boxes) | [`0x816a39b04e0672B4746A5B696E14145F4F852d37`](https://sepolia.etherscan.io/address/0x816a39b04e0672B4746A5B696E14145F4F852d37) |
| `DoNotOpenConfig` | [`0xf4589d1d91Df3a0A98E7C6E79f6CaFCdbdc8203D`](https://sepolia.etherscan.io/address/0xf4589d1d91Df3a0A98E7C6E79f6CaFCdbdc8203D) |
| `DoNotOpenHooks` (rules for the confidential marketplace) | [`0x2861240671f6a46522297427FE2BF59F2f9C1074`](https://sepolia.etherscan.io/address/0x2861240671f6a46522297427FE2BF59F2f9C1074) |
| `Croq` (CROQ) | [`0x142ADF07aEcdd0D1c915bBCa574B1A9EBDd91308`](https://sepolia.etherscan.io/address/0x142ADF07aEcdd0D1c915bBCa574B1A9EBDd91308) |
| `ConfidentialCroq` (cCROQ) | [`0x358E932457A2F19B20BF49264875E94432941D81`](https://sepolia.etherscan.io/address/0x358E932457A2F19B20BF49264875E94432941D81) |
| `Pantry` | [`0x7Df443562BD787A56b1026aD91cFa0A8E91E7d9d`](https://sepolia.etherscan.io/address/0x7Df443562BD787A56b1026aD91cFa0A8E91E7d9d) |
| `LiquidityLocker` (holds position #233138) | [`0x85b827d5F40C15F0842F48C830B956cf8C5Da108`](https://sepolia.etherscan.io/address/0x85b827d5F40C15F0842F48C830B956cf8C5Da108) |
| CROQ/USDC pool, Uniswap V3, 1% fee | [`0xc1eFDaC0c240F9BbCE8788E18427666310E267ce`](https://sepolia.etherscan.io/address/0xc1eFDaC0c240F9BbCE8788E18427666310E267ce) |
| USDC (Zama's `USDCMock`, anyone can mint) | [`0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF`](https://sepolia.etherscan.io/address/0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF) |
| cUSDC (Zama's `cUSDCMock`) | [`0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639`](https://sepolia.etherscan.io/address/0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639) |
| `UsdcRamp` (ETH in, USDC or cUSDC out, 0.3% fee) | [`0xaa3B58D5B4Eb66d455b4099588D3aC76dF329AA1`](https://sepolia.etherscan.io/address/0xaa3B58D5B4Eb66d455b4099588D3aC76dF329AA1) |
| `DecryptionCredits` (0.01 USDC a credit) | [`0x300cc9CE50003750fC052bfEf3ee87fFE9B1534e`](https://sepolia.etherscan.io/address/0x300cc9CE50003750fC052bfEf3ee87fFE9B1534e) |
| `StudioPacks` (Starter 2 USDC, Litter 8 USDC) | [`0x672cf76a68d4f181387B59caA1813eC425c1354C`](https://sepolia.etherscan.io/address/0x672cf76a68d4f181387B59caA1813eC425c1354C) |
| `Rats` (ERC-721: 1 USDC a free rat, 3 an AI rat) | [`0xd4f8Df0F14Ced442077762cb81e843656BAc3856`](https://sepolia.etherscan.io/address/0xd4f8Df0F14Ced442077762cb81e843656BAc3856) |
| `RatPantry` (10 CROQ a rat a day) | [`0x9c83C67e690CF8fb6CFaFE8f1DA5221D20520a0A`](https://sepolia.etherscan.io/address/0x9c83C67e690CF8fb6CFaFE8f1DA5221D20520a0A) |

Gas: `DoNotOpenConfig` 914,027, `DoNotOpen` 5,792,149, `DoNotOpenHooks` 357,103,
`DecryptionCredits` 478,835, `Croq` 532,843, `ConfidentialCroq` 2,455,772, `Pantry` 3,253,237,
`Pantry.fund` 441,798, `LiquidityLocker` 558,565, `UsdcRamp` 759,846. The position took
4,000,000 CROQ and 0 USDC, ticks 69200 to 138200 (CROQ is token0 this time), 0.001012 to
1.004 USDC per CROQ. `smoke:sepolia` and `smoke:croq` passed in full against it (mints,
shakes, a refused shake, a feed, an alive check, a duel, an entanglement, an opening that
matches the generator; welcome bag, meal, weighing, buy, wrap, unwrap, transfer, sell), and
a box sent with three decoys left the sender's holdings after four transactions.

### Sepolia deployment (2026-10-02): CROQ-only Uniswap V3 market

Replaced by the one above. Deployed at block 11830294 by `0x6a18cFC3fAeef453B295B12246d40a82593b3208`, which
owns the collection, the locker, and is the treasury. The aim was only a new croquette
economy, whose market is now a single-sided Uniswap V3 position (only CROQ, no USDC from
the creator) held for good by `LiquidityLocker` (see [CROQ.md](CROQ.md#the-public-market)).
`DoNotOpen` and its hooks were redeployed too, by accident: `COLLECTION_OWNER` was unset
in the deploying `.env`, so the owner argument of the `DoNotOpen` constructor changed
from `0x5908…029A` to the deployer and hardhat-deploy saw a different deployment. The
previous collection and its index were left behind. For the next deploy: set
`COLLECTION_OWNER` to the intended owner, and compare the constructor arguments of the
saved deployments (not only the bytecode, which also depends on the network compiled
for) before sending anything. `DoNotOpenConfig`, `UsdcRamp` and `DecryptionCredits` were
kept: their arguments did not change, and none of them reads the collection.

| Contract | Address |
| --- | --- |
| `DoNotOpen` (Confidential ERC-721, 10,000 boxes) | [`0x5eBaA496783146f712B9c075f8a6fd56cb612C6F`](https://sepolia.etherscan.io/address/0x5eBaA496783146f712B9c075f8a6fd56cb612C6F) |
| `DoNotOpenConfig` (kept) | [`0x6909f7C5ebE00592F28Ab3597914d30D8b746976`](https://sepolia.etherscan.io/address/0x6909f7C5ebE00592F28Ab3597914d30D8b746976) |
| `DoNotOpenHooks` (rules for the confidential marketplace) | [`0xb891e9A343ccC18C070aB0b73341FF38f6D2E66B`](https://sepolia.etherscan.io/address/0xb891e9A343ccC18C070aB0b73341FF38f6D2E66B) |
| `Croq` (CROQ) | [`0xbedb039CB104bD8e60A5eD7844fCE7961d0451F7`](https://sepolia.etherscan.io/address/0xbedb039CB104bD8e60A5eD7844fCE7961d0451F7) |
| `ConfidentialCroq` (cCROQ) | [`0x5b4af5b2Eb99ec3615721a4fBfb7baF5BC8b7952`](https://sepolia.etherscan.io/address/0x5b4af5b2Eb99ec3615721a4fBfb7baF5BC8b7952) |
| `Pantry` | [`0xf506832ab27DF17ece72924502537ecCf7586CDB`](https://sepolia.etherscan.io/address/0xf506832ab27DF17ece72924502537ecCf7586CDB) |
| `LiquidityLocker` (holds position #233099) | [`0xCA7Eee59de903F9b6bfab466667131Fb58403BF3`](https://sepolia.etherscan.io/address/0xCA7Eee59de903F9b6bfab466667131Fb58403BF3) |
| CROQ/USDC pool, Uniswap V3, 1% fee | [`0x399Dc7af546154998D302d0b3B312750DA962100`](https://sepolia.etherscan.io/address/0x399Dc7af546154998D302d0b3B312750DA962100) |
| USDC (Zama's `USDCMock`, anyone can mint) | [`0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF`](https://sepolia.etherscan.io/address/0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF) |
| cUSDC (Zama's `cUSDCMock`) | [`0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639`](https://sepolia.etherscan.io/address/0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639) |
| `UsdcRamp` (kept) | [`0x2754B8568a3402f828DDAa1715F8290CDa498aAb`](https://sepolia.etherscan.io/address/0x2754B8568a3402f828DDAa1715F8290CDa498aAb) |
| `DecryptionCredits` (kept) | [`0xfBF4E4bC2558Be1227d6feBbE80299064291d3B1`](https://sepolia.etherscan.io/address/0xfBF4E4bC2558Be1227d6feBbE80299064291d3B1) |

Uniswap V3 on Sepolia: factory `0x0227628f3F023bb0B980b67D528571c95c6DaC1c`,
`NonfungiblePositionManager` `0x1238536071E1c677A632429e3655c799b22cDA52`, `SwapRouter02`
`0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E`, `QuoterV2`
`0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3`; the deploy script checks that all three
point at the factory. Gas: `DoNotOpen` 5,785,044, `DoNotOpenHooks` 357,103, `Croq` 532,843,
`ConfidentialCroq` 2,455,772, `Pantry` 3,158,436, `Pantry.fund` 441,798,
`LiquidityLocker` 558,565. The position took 4,000,000 CROQ and 0 USDC, ticks -138200 to
-69200 (CROQ is token1: it sorts after USDC), 0.001012 to 1.004 USDC per CROQ. Through
the adapter: a sale quoted 0 before any buy, then 2 USDC bought 1,955 CROQ and 977 of them
sold back for 0.979 USDC, as quoted.

### Sepolia deployment (2026-10-02): duel shelf

Replaced by the V3 market above. Deployed at block 11828557, again with a fresh croquette economy. A different
deployer account (`0x590891F269720001435004A1089cAB5b2c20029A`) deployed it, so it owns
the collection and receives the treasury's share. The optimizer change also changed every
contract's bytecode, so all of them were deployed again:

| Contract | Address |
| --- | --- |
| `DoNotOpen` (Confidential ERC-721, 10,000 boxes) | [`0xB8e3b2238eF5D5782A661c406acc928895938fBa`](https://sepolia.etherscan.io/address/0xB8e3b2238eF5D5782A661c406acc928895938fBa) |
| `DoNotOpenConfig` | [`0x6909f7C5ebE00592F28Ab3597914d30D8b746976`](https://sepolia.etherscan.io/address/0x6909f7C5ebE00592F28Ab3597914d30D8b746976) |
| `DoNotOpenHooks` (rules for the confidential marketplace) | [`0x684974FE67084A8cF94e6096fDcbc774892f560a`](https://sepolia.etherscan.io/address/0x684974FE67084A8cF94e6096fDcbc774892f560a) |
| `Croq` (CROQ) | [`0xF4d9CE55b52417e503617186e923E1c0713c53b5`](https://sepolia.etherscan.io/address/0xF4d9CE55b52417e503617186e923E1c0713c53b5) |
| `ConfidentialCroq` (cCROQ) | [`0x4f7415781ceef5C6A0C036A7B8813B7F49634bF9`](https://sepolia.etherscan.io/address/0x4f7415781ceef5C6A0C036A7B8813B7F49634bF9) |
| `Pantry` | [`0x28aC2bc964AfAAa10f51bf485C59D2C9CF6bC8Ed`](https://sepolia.etherscan.io/address/0x28aC2bc964AfAAa10f51bf485C59D2C9CF6bC8Ed) |
| CROQ/USDC pair, Uniswap V2 (LP tokens sent to `0x…dEaD`) | [`0x7C117CA5f1f0d57Bcc9810E216aa6238799E43d2`](https://sepolia.etherscan.io/address/0x7C117CA5f1f0d57Bcc9810E216aa6238799E43d2) |
| USDC (Zama's `USDCMock`, anyone can mint) | [`0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF`](https://sepolia.etherscan.io/address/0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF) |
| cUSDC (Zama's `cUSDCMock`) | [`0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639`](https://sepolia.etherscan.io/address/0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639) |
| `UsdcRamp` (ETH in, USDC or cUSDC out, 0.3% fee) | [`0x2754B8568a3402f828DDAa1715F8290CDa498aAb`](https://sepolia.etherscan.io/address/0x2754B8568a3402f828DDAa1715F8290CDa498aAb) |

`smoke:sepolia` ran against it: two mints, shakes, a feed, an alive check, then a box put
up for a duel, its holding proven through the KMS, the duel taken up by another box and
settled, all through the real coprocessor, relayer and KMS. The opening at the end ran
out of cUSDC in the script's account, which has nothing to do with the contract. The
index picked the duel up as posted, opened, taken up and resolved.

### Sepolia deployment (2026-10-01): hidden owners

Replaced by the duel shelf above. Deployed at block 11822985 with a fresh croquette economy (a Pantry is tied to
one collection, and the previous reserve is locked in the previous Pantry):

| Contract | Address |
| --- | --- |
| `DoNotOpen` (Confidential ERC-721, 10,000 boxes) | [`0xDdC71FeBA832c961770F59d0be4B0b3ae536707B`](https://sepolia.etherscan.io/address/0xDdC71FeBA832c961770F59d0be4B0b3ae536707B) |
| `DoNotOpenConfig` | [`0x2456fE3d2B27f044593C895fae553bA146084bFB`](https://sepolia.etherscan.io/address/0x2456fE3d2B27f044593C895fae553bA146084bFB) |
| `DoNotOpenHooks` (rules for the confidential marketplace) | [`0xEE2219018b765891eDB72954197E097e8E6A4FFc`](https://sepolia.etherscan.io/address/0xEE2219018b765891eDB72954197E097e8E6A4FFc) |
| `Croq` (CROQ) | [`0x5ebF858ff01d40D8cbC707B8d1F873099F5a11E2`](https://sepolia.etherscan.io/address/0x5ebF858ff01d40D8cbC707B8d1F873099F5a11E2) |
| `ConfidentialCroq` (cCROQ) | [`0x58B4e70B877afF540796c3ec38b54C2C7834B804`](https://sepolia.etherscan.io/address/0x58B4e70B877afF540796c3ec38b54C2C7834B804) |
| `Pantry` | [`0x084C50597D83ab89D62F5FA4245A4a4e9909A77D`](https://sepolia.etherscan.io/address/0x084C50597D83ab89D62F5FA4245A4a4e9909A77D) |
| CROQ/USDC pair, Uniswap V2 | [`0x9E8C1e4D763F8Fc9CE3eD342a6C2103A5c51eF60`](https://sepolia.etherscan.io/address/0x9E8C1e4D763F8Fc9CE3eD342a6C2103A5c51eF60) |
| USDC (Zama's `USDCMock`, anyone can mint) | [`0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF`](https://sepolia.etherscan.io/address/0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF) |
| cUSDC (Zama's `cUSDCMock`) | [`0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639`](https://sepolia.etherscan.io/address/0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639) |
| `UsdcRamp` (ETH in, USDC or cUSDC out, 0.3% fee) | [`0x20FB2d7f2d3fb249924ce3871255bb417670ba50`](https://sepolia.etherscan.io/address/0x20FB2d7f2d3fb249924ce3871255bb417670ba50) |

`pnpm --filter @dno/chain-adapter smoke:sepolia` ran every mechanic against it through the
real coprocessor, relayer and KMS: a mint of 2 boxes hidden among 10 ids paid in cUSDC, a
mint of 1 among 3 ids shielded from USDC just before, the boxes found back in the
account's receipts, two shakes on one permit, a feed, a shake of an empty id that showed
nothing, an alive check, a duel, an entanglement, and an opening that opened both
entangled boxes; both reveals matched the generator.

Found on the way: the adapter must start reading events at the deploy block. Reading from
block 0 in 40,000-block slices made the public endpoint refuse after a few hundred calls.
The browser and Node factories pass `deployBlock` from the export.
