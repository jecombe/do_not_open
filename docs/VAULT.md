# The sealed vault

> [Open the vault](https://vault.do-not-open.app) · [Its docs](https://vault.do-not-open.app/docs) ·
> [Back to the README](../README.md#the-sealed-vault) · Next to it: [the game](GAME.md)

The sealed vault is a product next to the game, not a part of it. Any NFT of an allowed
collection goes into a box whose holder is encrypted: the box is a Confidential ERC-721 of its
own ("DO NOT OPEN Vault", `SEALED`), built on the same `ConfidentialERC721` base as the boxes of
the game. The NFT stays in the vault until the box's holder takes it out, sells it on Seaport
(OpenSea's protocol) with the vault as the seller, by a listing or by accepting a buyer's WETH
offer, or sells the box privately for an encrypted cUSDC price. Meanwhile the holder may lend
the NFT's rights (airdrops, holder-only access) to a wallet of theirs through delegate.xyz.
Tokens go in too: cUSDC in a [pocket](#pockets) locked by a key rather than an address, sent to
another pocket, used to buy a box, or taken out anywhere, without anything public saying who paid
whom or how much. The page (a switch at its top picks a side: NFTs, non-fungible, in boxes, or tokens, fungible, in "My pocket"; `#tokens` opens the second) is `vault.do-not-open.app` (`/vault` off the site's domains), and its
docs for holders, in four languages, are `vault.do-not-open.app/docs` (`apps/web/src/vault/docs`):
they follow this file, so a change here goes there too.

Every action on the page runs on a stage (`apps/web/src/vault/tx`): an animated scene for its kind
(the NFT sealed in a box among its decoys, the vault door opening, a ship sailing to Seaport, the
NFT and the ETH crossing, a badge flying to the delegate...), its steps as they come, and every
transaction it sent with its block, its gas and a link to the explorer. Addresses (the
connected wallet, a box's depositor and delegate, its collection, the vault's contract) and each
NFT link to the explorer too, and to a marketplace where one shows the chain. The header
carries the wallet's balances, read live like the game's (ETH, WETH, USDC, and cUSDC behind a
lock until its holder decrypts it), and a click on the address opens its profile: the full
address (copy, explorer), the same balances, its boxes, switch wallet and disconnect. Folded away, it sits at the
foot of the screen. It is also written to a cookie shared by the site's hosts, so the home page,
boarding and both docs show it at their foot when the visitor left the vault mid-way: the steps
that run in the browser (the decryption and the proof) stop with the page, and the next visit
settles the box's waiting requests.

The first visit plays a guided tour (`apps/web/src/vault/VaultTour.tsx`, on the spotlight the
game's depot tour uses, `apps/web/src/tour/Spotlight.tsx`): the two sides, the encrypted holders,
the wallet, then each tab in the order a newcomer uses them (the market, sealing with decoys,
one's boxes, private sales, the pocket, what leaks) and the Warden. Each tab's step opens that tab
first, so the spotlight lands on the real thing (without a wallet, on the tab itself). It shows
once per browser (`localStorage`), never over a box opened from a link, and the "?" in the
vault's bar plays it again.

The contracts are the source of truth, especially the design notes at the top of
[`SealedVault.sol`](../packages/contracts-evm/contracts/SealedVault.sol). This file explains
them, what leaks, what it costs, and why each choice was made.

**Status.** Done on the mock and in the tests (71 contract tests in `test/SealedVault.ts`,
against the real bytecode of Seaport 1.5, of Seaport 1.6 with OpenSea's conduit, and of
delegate.xyz's registry). On Sepolia since 2026-10-08, and since 2026-10-10 in its current
version, whose listings are written by `VaultListings` the way OpenSea shows them (Seaport 1.6,
OpenSea's conduit, its signed zone and fees on mainnet; open orders on Sepolia), which sends
an accepted offer's fill itself and takes any ERC-721: `SealedVault` at
`0xb70740218931B220a06CE1ba1bD58B33f4d45abC` (block 11885990), `VaultListings` at
`0x6b9C5204568fdf74a5DcEf7a1be85252358D8Fa6` (block 11885989, with default fees) and `VaultOffers` at
`0xADaE32F03d6C1678127a8BEDF024FeF38dd4FE59` (block 11885657; owner and treasury
`0x590891F269720001435004A1089cAB5b2c20029A`), its free test collection `VaultTestNFT` at
`0xf72Eb38f816B1B8Effa8B6036C0BA6A38D6d6f9b` (kept from the first deployment), on Seaport 1.6
(`0x0000000000000068F116a894984e2DB1123eB395`) with OpenSea's conduit, the WETH OpenSea uses on
Sepolia (`0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9`) and delegate.xyz's registry. Earlier
deployments are left as they were: `0xE0Da20977484Ba48c0902B3686b7A9F999f0e8C3` (earlier on 2026-10-10,
block 11885662, with `VaultListings` `0xF7742C1f4610C6629A7488E771Bb39dcC4408Ddb`, the first to
send an accepted offer's fill itself) allowed collections one by one;
`0x79E6a86b448311ec580402701d4cb5B68c56718c` (earlier still on 2026-10-10,
block 11885012, with `VaultOffers` `0x43B2e0d7a75100545556BAD1B9Fa6f926721898A`, the first on
`VaultListings`) handed `VaultOffers` the NFT to fill an accepted offer, which OpenSea's signed
zone would not sign for; `0xE22509e741233072aFF4e0c6B56d5e3De8018262` (2026-10-09,
block 11876575, with `VaultOffers` `0x750d5B8E8A0f55b8E1F74bA3387B59cc8080f9E2`) listed on
Seaport 1.5 with orders it wrote itself;
`0x27CA3698A34b53900047cD1D0856B954a695C79D` (2026-10-09, block 11876345) took no offers and no
delegation; the first, `0x8B07846CaB181E1D010D2a9E39d7FDF60087fb18` (2026-10-08, block
11872753), took one request per box and moved the nonce on with every request (see Decisions).

The pockets (`SealedPockets`, and `PocketDesk` that buys private sales out of them) are done on
the mock and in the tests (45 contract tests in `test/SealedPockets.ts`, 6 more running the
adapter against them), and on Sepolia since 2026-10-09, redeployed with the vault three times on 2026-10-10
(the desk is bound to its vault, and a pockets contract takes one desk for good): `SealedPockets`
at `0x3c925f9AB849ABbcb47EC12Be0D9BDB4d9EA4395` (block 11885991, owner
`0x590891F269720001435004A1089cAB5b2c20029A`) and `PocketDesk` at
`0x37e9D6b2180323D5a01a42e2FD911aE017F70430` (block 11885992), on the vault above and Zama's cUSDC; the
previous pockets, `0xd693433e9E2556bafC6A5B48E37f9994E99bE752` (block 11885664) with their desk
`0x5CB63624d9216E19C155771a3123b6aa9B716e4B` (block 11885665), `0x62E0A7C3f7B59F3BAc3a93210F62e3dD0A12A17f` (block 11885014) with their desk
`0x06c082C599eF4eDa4fd1a93dBB8f9B348Ef43D61` (block 11885017), and before them
`0xAfEc56C76B8682A5FcDCf061fD3e703fD75Be00C` (block 11877902) with
`0x0939D713429FCD1c5AF9589b121a8F77C49F759b` (block 11877903), keep their balances, which their keys
can still withdraw from those contracts. On the pockets of 2026-10-10, `pnpm --filter @dno/chain-adapter smoke:pockets`
(open, deposit, send, withdraw, both balances read by their viewers) passed on 2026-10-10. Pockets of cUSDT, cWETH and cZAMA, without a desk,
are on Sepolia since 2026-10-09 too (blocks 11878756 to 11878758; `POCKET_TOKEN=cZAMA` runs the
same smoke test on one of them; it passed there with cZAMA and with cWETH, 1 WETH of 18 decimals
wrapped to 1 cWETH of 6). See [Pockets](#pockets) and [Other tokens](#other-tokens).

## Contracts

| Contract | What it is |
| --- | --- |
| `SealedVault` | The vault. `ConfidentialERC721` (encrypted owners, transfers that never revert on ownership), `ZamaEthereumConfig`, `Ownable`, `ReentrancyGuard`. 23,795 bytes deployed, 781 under the 24,576-byte limit, compiled with the default optimizer (200 runs): a new feature has to move logic out first, as accepting offers did into `VaultOffers` and writing the listings' orders into `VaultListings` |
| `vault/VaultListings.sol` | Writes the vault's Seaport listings the way OpenSea shows a contract's listing, and keeps them. `prepare(collection, tokenId, price, endTime)` writes an order whose offerer is its caller (the NFT on offer; in ETH, the caller's share `net` first, then one item per fee of the collection) and returns the `validate` call for the caller to send to Seaport, the order hash and `net`; `cancelCall(orderHash)` the `cancel` call; `orderOf(orderHash)` the order as a buyer passes it to `fulfillOrder`; `listingOf`, `feesOf`. Immutable `seaport`, `zone` (OpenSea's signed zone, or zero: the order is then `FULL_OPEN` rather than `FULL_RESTRICTED`), `conduitKey` and `operator` (OpenSea's conduit, or Seaport where there is no conduit: what the offerer approves on the NFT). The owner sets each collection's fees (`setFees`, recipient and bps, together at most `MAX_FEES_BPS`, 15%); a listing keeps the fees it was made with, stored by order hash. Nothing happens on Seaport unless the offerer itself sends the call: the vault never signs anything. 6,388 bytes |
| `vault/VaultOffers.sol` | Writes the Seaport call that fills a buyer's offer the vault accepts, and is the board buyers post them to. Stateless and open to anyone. `fillCall(offer, collection, tokenId, recipient)` returns the `fulfillAdvancedOrder` call (one token's share, criteria resolved to the token) the NFT's holder sends to Seaport, and the WETH fee it lets Seaport take: the vault sends it itself, as OpenSea's signed zone signs a fill for the address that holds the NFT, which must be Seaport's caller. `inspect` says whether an offer can still fill one token for at least a price; `fill` does the whole fill for a holder that hands it the NFT for one call; `post` validates a buyer's signed offer on Seaport and logs it by NFT (`OfferPosted`). Deployed on the same Seaport as the listings. 8,909 bytes |
| `vault/ISeaport.sol` | The slice of Seaport 1.5 and 1.6 (the same calls) the vault, `VaultListings` and `VaultOffers` use (`validate`, `cancel`, `getOrderHash`, `getOrderStatus`, `getCounter`, `fulfillOrder`, `fulfillAdvancedOrder`, `information`) and its structs, as Seaport defines them. Seaport 1.6 is at `0x0000000000000068F116a894984e2DB1123eB395` on Sepolia and mainnet (OpenSea's conduit and signed zone are on both too, checked on-chain 2026-10-10), 1.5 at `0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC`; local networks run 1.5 from the Sepolia fixture |
| `mocks/TestZone.sol` | Tests only: a stand-in for OpenSea's signed zone, put at the zone's address, that says yes to every order (the real one wants a signature from OpenSea's server) |
| `vault/IDelegateRegistry.sol` | The slice of delegate.xyz's Delegate Registry v2 the vault uses (`delegateERC721`, `checkDelegateForERC721`). The registry is at `0x00000000000000447e69651d841bD8D104Bed493` on Ethereum, Sepolia and most other chains |
| `vault/IWETH.sol` | Wrapped ether (`deposit`, `withdraw`): what offers pay in |
| `mocks/TestWETH.sol` | Local networks only: WETH as WETH9 does it |
| `SealedPockets` | The pockets: one confidential token (cUSDC; cUSDT, cWETH and cZAMA in instances of their own, without a desk) held under encrypted 256-bit keys, not addresses. `open`, `deposit` (from a wallet, into one pocket of a set), `send` (from one pocket of a set to one pocket of another, the key bound to the terms), `withdraw` (to any address, as cUSDC), and `deskTake`, `deskCheck`, `deskGive` for the desk only. No decryption anywhere: every spend settles under encryption in one transaction. `ZamaEthereumConfig`, `Ownable` (only to set the desk, once), `ReentrancyGuard` |
| `vault/PocketDesk.sol` | Buys the vault's private sales out of pockets. A seller offers a box to the desk and `reserve`s the sale for a pocket; its holder `ask`s (the key and the balance checked under encryption, one bit made public), then `buy`s with the proof: the desk takes the price from the pocket, accepts the sale on the vault, and hands back any refund. The box stays with the desk, its vault key the buyer's. Holds tokens only during `buy`, never sells |
| `mocks/VaultTestNFT.sol` | Test networks only: "Sealed Vault Test NFT" (`VTEST`), free to mint for anyone, its picture an SVG drawn on-chain from its id, so a marketplace shows something |

```mermaid
flowchart LR
  holder(("Holder")) -- "deposit (public)" --> vault["SealedVault<br/>boxes, encrypted owners and keys,<br/>requests, listings, private sales"]
  relayer["API relayer<br/>(optional)"] -- "request, finalize, finalizeOffer<br/>from its own wallet" --> vault
  vault -- "transferFrom, approve one token<br/>(to OpenSea's conduit, or Seaport)" --> nft["Allowed ERC-721<br/>(VaultTestNFT on test networks)"]
  vault -- "prepare, cancelCall" --> listings["VaultListings<br/>writes and keeps the listings' orders<br/>(OpenSea's conduit, zone and fees)"]
  vault -- "validate, cancel, getOrderStatus" --> seaport["Seaport 1.6 (1.5 locally)"]
  buyer(("Any Seaport buyer,<br/>OpenSea's checkout on mainnet")) -- "fulfillOrder, ETH" --> seaport
  seaport -- "ETH (receive)" --> vault
  bidder(("A buyer making an offer")) -- "post (a signed WETH offer)" --> offers["VaultOffers<br/>offer board, fills offers"]
  offers -- "validate, fulfillAdvancedOrder" --> seaport
  vault -- "one NFT for one fill; ETH back" --> offers
  vault -- "delegateERC721" --> registry["delegate.xyz<br/>Delegate Registry v2"]
  vault -- "pulls and pays (private sales)" --> cusdc["cUSDC<br/>ERC-7984"]
  vault -- "sendFees (ETH)" --> treasury["Treasury"]
```

`SealedVault` has no link to `DoNotOpen`, the Pantry or any other contract of the game: it only
shares the base contract and the cUSDC. `VaultOffers` knows nothing of the vault either: it
sells whatever NFT its caller hands it; nor does `VaultListings`, which writes an order for
whoever calls it, and only the vault can put its own orders on Seaport.

## A box and its key

Each box stores, in public, the NFT it holds (`collection`, `tokenId`), its state, its listing,
how many requests wait on it, the ETH a Seaport sale left in it, a request nonce, and its
delegate in delegate.xyz. Two things are
encrypted: its owner (an `eaddress`, as in every `ConfidentialERC721`) and its **key**, a
256-bit secret (`euint256`) its holder picks. Only the vault is allowed on the key
(`allowThis`): nobody can decrypt it, the holder included. It is only ever compared.

```mermaid
stateDiagram-v2
  [*] --> Sealed: deposit
  Sealed --> Listed: request(List), finalized with the right key
  Listed --> Sealed: request(Unlist), or the listing ran out (sync)
  Listed --> Sold: the Seaport order filled (sync, or any request)
  Sealed --> Claimed: request(AcceptOffer): sold to a buyer's offer, the ETH paid out
  Listed --> Claimed: request(AcceptOffer): the listing is taken down first
  Sealed --> Sold: request(AcceptOffer), the payout address refused the ETH
  Sealed --> Withdrawn: request(Withdraw)
  Listed --> Withdrawn: request(Withdraw): the listing is taken down first
  Sold --> Claimed: request(Claim)
  Withdrawn --> [*]
  Claimed --> [*]
```

A box moves (transfer, private sale) only while `Sealed` and no request waits on it. `Withdrawn` and
`Claimed` are final: a box id is never reused, and an NFT taken out and put back gets a new box.

**What the app uses as the key.** `EvmVault` never stores a key. The wallet signs one fixed
message once a session, `vaultKeyMessage(vault, chainId)` (EIP-191, free); the secret is the
keccak256 of that signature, and the key of the box holding `tokenId` of `collection` is
`keccak256(abi.encode(secret, collection, tokenId))`. The same wallet makes the same keys on any
device. Anyone who gets that signature can take the wallet's NFTs out: the message says so, and
says to sign it only on DO NOT OPEN.

**Binding a key to a request.** The key is never sent as is. For a request, the holder encrypts
`key XOR requestHash(boxId, nonce, action, to, price, endTime, ref)`, where

```
requestHash = keccak256(abi.encode(block.chainid, vault, boxId, nonce, action, to, price, endTime, ref))
```

and `ref` is the Seaport order hash of the offer an `AcceptOffer` names (zero otherwise),

`nonce` is how many requests on the box matched its key: `finalize` moves it on when the key
matched (the request `Done` or `Stale`), and `expire` does too; a wrong key leaves it where it
was. The vault computes the same hash from the terms it was actually given and compares
`input XOR hash` with the stored key, under encryption. A relayer that changed a term (the
recipient, say) makes the vault compare against another hash: the key does not match and the
request settles `Refused`. One that sends a used input again, once its request settled, finds
the nonce moved on: `Refused` too. One that sends it twice while the first still waits places
the holder's own request twice; the second finds the box changed (withdrawn, listed, sealed
again or claimed) and settles `Stale`. And a stranger's wrong key never moves the nonce, so it spoils no input the holder
already prepared. An encrypted input is bound to the address that sends it, so the page encrypts it for
the relayer's address when the relayer sends (`inputUser` in `EvmVault`), and for the wallet's
otherwise.

**A box that changes hands gets a random key.** `_transfer` (every transfer, decoys included,
and a private sale) sets the key to `select(moved, randEuint256(), key)`: a box that moved has a
key nobody knows, so the previous holder can no longer act on it; a transfer that moved nothing
keeps the key. The new holder sets theirs with `setKey(boxId, key, proof)` ("Make the key mine"
in the page, `adopt` in the adapter), a "maybe" like a transfer: `select(isOwner(caller), new,
old)`, so a stranger's `setKey` changes nothing and looks the same. A private sale sets the
buyer's key in the same transaction.

## Flows

Participants: **Holder** (the box's holder, and their page), **Relayer** (the API's vault
relayer, when there is one; otherwise the holder's wallet sends), **Vault** (`SealedVault`),
**Relayer / KMS** (Zama's), **Seaport**, **cUSDC**.

### Deposit

```mermaid
sequenceDiagram
  autonumber
  actor H as Holder
  participant N as NFT collection
  participant V as Vault
  H->>H: key = keccak256(secret, collection, tokenId), encrypted for the vault
  H->>N: approve(vault, tokenId)
  H->>H: decoys: up to 5 wallets of the crowd (fresh random addresses past it), really = false for each, encrypted with the key
  H->>V: deposit(collection, tokenId, key, to[], really[], proof)
  V->>V: bannedCollection[collection]: CollectionBanned; to and really pair up, 5 at most, else BadSends
  V->>N: transferFrom(holder, vault, tokenId); ownerOf(tokenId) must be the vault, else NotReceived
  V->>V: mint box: owner = holder (moved = true), key stored, allowThis only
  V-->>H: Deposited(boxId, collection, tokenId, depositor), ConfidentialTransfer(boxId, 0x0, holder, moved)
  loop each of to[]
    V->>V: _transfer(holder, to[i], boxId, really[i]): moves only if really and the holder still holds it
    V-->>H: ConfidentialTransfer(boxId, holder, to[i], moved)
  end
```

The deposit is public: it is a plain NFT transfer, and `Deposited` names the depositor. What
happens to the box next is not, and it can start in the same transaction: `deposit` sends the
new box on to each of `to`, for real only where the encrypted `really` is true. The page lets
the holder pick how many decoys, 0 to 5, three by default (`decoys` in the adapter, `decoySends`): wallets of the vault's
crowd, `really` false for each, so the depositor keeps the box, but to anyone else each
transfer is a "maybe" and the depositor is no longer its obvious holder. One of them may be real
(a gift, or the holder's own fresh wallet): the box then moves and gets a random key, as on any
transfer, and its receiver sets theirs with `setKey`. Each send costs a transfer's gas and HCU
(Cost, below). The holder finds their boxes the way a player finds theirs:
by replaying their own `ConfidentialTransfer` receipts and user-decrypting the "moved" bits
(`myBoxes`, one signature), see [HIDDEN_OWNERS.md](HIDDEN_OWNERS.md#finding-your-boxes).

**The crowd.** A decoy is only as good as the doubt it leaves, and a transfer to a fresh random
address leaves little: that address never acts, never sets a key, never asks anything, so an
observer bets the box stayed with the depositor. The decoys go instead to wallets that use the
vault (`crowd()` in the adapter, from the public events: every `Deposited` depositor, `KeySet`
caller, `ConfidentialTransfer` sender, `SaleOffered` party, `Withdrawn` or `Claimed` recipient,
and every wallet that fed a pocket, less the vault's own contracts, the relayer and the connected
wallet), picked at random, none twice; past the crowd, to fresh addresses, and the page says so.
Each could be the box's holder: it acts on the vault. The page also tells a holder, on each of
their boxes, how many wallets may hold it as far as the chain tells (`crowd().holders`: its
depositor and the wallets of the crowd it was sent to; 1 means "you are its obvious holder"),
read on from the last look like the receipts. What a decoy costs its wallet: one more "moved"
bit to user-decrypt the next time it looks for its boxes, false. What it still does not hide: a
`KeySet` from one of the decoys names a real receiver, and the absence of any from all of them
is a hint the box stayed (below).

### A request: take out, list, take down, collect, accept an offer, delegate

Everything that leaves the vault is asked with the key, never with the caller's address, in
two steps like every reveal in this repository: `request`, a public decryption of one bit ("the
key matched"), then `finalize` with the KMS proof, which anyone may send.

```mermaid
sequenceDiagram
  autonumber
  actor H as Holder
  participant Rl as Relayer (API)
  participant V as Vault
  participant R as Relayer / KMS
  H->>V: boxInfo(boxId).nonce, requestHash(boxId, nonce, action, to, price, endTime, ref)
  H->>H: encrypt key XOR hash, for the vault and the relayer's address
  H->>Rl: POST /v1/vault/relay {call: "request", args}
  Rl->>V: request(boxId, action, to, price, endTime, ref, boundKey, proof) (gas estimated first)
  V->>V: sync, state allows the action, price and end time sane (else revert); other waiting requests do not matter
  V->>V: ok = (boundKey XOR requestHash(terms, nonce)) == key, publicly decryptable
  V->>V: pending += 1, placedAt = now
  V-->>H: RequestPlaced(requestId, boxId, action, relayer)
  H->>R: publicDecrypt(requestInfo(requestId).ok)
  R-->>H: ok + KMS proof
  H->>Rl: POST /v1/vault/relay {call: "finalize", args}
  Rl->>V: finalize(requestId, ok, proof) (anyone may; finalizeOffer for an offer, below)
  V->>V: checkSignatures on the stored handle, sync
  alt not ok
    V->>V: Refused: nothing happens
  else ok, but the box changed first (sold, expired, listed)
    V->>V: Stale: nothing happens
  else ok
    V->>V: run the action (below), Done
  end
  V->>V: pending -= 1 (only now: the box cannot move while the action runs), if ok: nonce += 1
  V-->>H: RequestSettled(requestId, status)
```

| Action | Allowed in | `to` | What runs on `Done` |
| --- | --- | --- | --- |
| `Withdraw` | `Sealed`, `Listed` | where the NFT goes, not zero | A listed box is taken down first; then `Withdrawn`, the NFT sent with `transferFrom`, `Withdrawn(boxId, to)` |
| `List` | `Sealed` | unused | A Seaport order is validated (below), `Listed` |
| `Unlist` | `Listed` | unused | `seaport.cancel`, the approval cleared, `Sealed`, `Unlisted` |
| `Claim` | `Sold` | where the ETH goes, not zero | `Claimed`, the proceeds sent, `Claimed(boxId, to, amount)`. If the send fails (a contract that refuses ETH), the request settles `Stale` and the ETH stays in the box |
| `AcceptOffer` | `Sealed`, `Listed` | where the ETH goes, not zero; `price` is the least WETH the offer must net, `ref` its order hash | Only through `finalizeOffer`, with the order: see [Accepting an offer](#accepting-an-offer) |
| `Delegate` | `Sealed`, `Listed` | the delegate, or zero to clear it | The old delegate revoked and the new one named in delegate.xyz's registry, `Delegated(boxId, delegate)`: see [Delegation](#delegation) |

`request` reverts only on what is public: `NotABox`, `WrongState`, `BadPrice` (a listing's price,
or an offer's least price or order hash, zero), `BadEndTime` (a listing ends after now and
within 180 days), `ZeroAddress`. A wrong key is never a revert, and
neither is another request waiting on the box: requests do not lock each other out, each is
decided on its own at `finalize`, and one that can no longer run settles `Stale` (two of the
holder's own withdrawals at once: the first runs, the second finds the box `Withdrawn`). Without a relayer the page sends both transactions from the wallet, whose address then
shows on the request. In the adapter a `Refused` request throws `not-yours` and a `Stale` one
`missed`.

**No box stays stuck.** While any request waits (`pending > 0`), the box cannot move: a request
decided for one holder must never run for the next. Anyone may `finalize` a request as soon as
the KMS answers, and the page does it for every waiting request of a box before it sends the
box or accepts a private sale for it (`settlePending` in `EvmVault`, through the relayer when
there is one). A request whose proof never comes (the gateway down, say) can be settled by
anyone with `expire(requestId)` once `REQUEST_TIMEOUT` (one day) has passed since it was placed:
it settles `Expired`, runs nothing, and moves the nonce on, so its input cannot be sent again
later.

```mermaid
stateDiagram-v2
  [*] --> Pending: request (pending += 1)
  Pending --> Done: finalize, key matched, action ran (nonce += 1)
  Pending --> Stale: finalize, key matched, the box changed first (nonce += 1)
  Pending --> Refused: finalize, wrong key (nonce unchanged)
  Pending --> Expired: expire, a day after with no proof (nonce += 1)
  Done --> [*]
  Stale --> [*]
  Refused --> [*]
  Expired --> [*]
```

### Seaport: list, fill, sync, collect

The listing is a real Seaport order whose offerer is the vault itself. An offerer's own orders
need no signature once it validates them on-chain (`Seaport.validate`), so the vault never
signs anything and implements no ERC-1271: the only orders Seaport can fill on its NFTs are the
ones it validated. `VaultListings` writes the order and keeps it, so the vault does not have
to: the vault asks it to `prepare` the listing, approves the operator it names (OpenSea's
conduit on Sepolia and mainnet, Seaport locally) for that one token, and sends the `validate`
call it got back to Seaport itself.

```mermaid
sequenceDiagram
  autonumber
  actor H as Holder
  participant V as Vault
  participant L as VaultListings
  participant N as NFT collection
  participant S as Seaport 1.6 (1.5 locally)
  actor B as Buyer (OpenSea's checkout on mainnet)
  H->>V: request(List, price, endTime) ... finalize (as above)
  V->>L: prepare(collection, tokenId, price, endTime)
  L->>S: getCounter(vault), getOrderHash(order)
  L-->>V: validate calldata, orderHash, net
  V->>N: approve(listings.operator(), tokenId) (OpenSea's conduit, or Seaport; this token only)
  V->>S: validate([order, signature ""]) (SeaportRefused if it fails)
  V-->>H: Listed(listingId, boxId, price, endTime, orderHash)
  B->>L: orderOf(orderHash)
  B->>S: fulfillOrder({parameters, signature: "0x"}, 0), value = price (on mainnet through OpenSea, with its zone's signature)
  S->>N: transferFrom(vault, buyer, tokenId) (through the conduit)
  S->>V: net in ETH (receive: from Seaport only), the fees to their recipients
  B->>V: sync(boxId) (anyone, and any request on the box does it too)
  V->>S: getOrderStatus(orderHash): filled
  V->>V: Sold, proceeds = net - fee, feesOwed += fee
  V-->>B: SoldOnSeaport(listingId, boxId, price)
  H->>V: request(Claim, to) ... finalize
  V->>V: send proceeds to `to`
  V-->>H: Claimed(boxId, to, amount)
```

The order is one ERC-721 offered against `price` wei (`NATIVE`), from the block of the listing
to `endTime`, salt `keccak256(listings, listingCount)`: the vault's share (`net`) first, then one
ETH item per fee of the collection (`VaultListings.setFees`: the default fees, under collection
0, for every collection, OpenSea's 1% set at deployment on mainnet; a collection's own where
OpenSea enforces a creator fee, set by the owner; nothing on Sepolia, where `net` is the price). On mainnet the order names OpenSea's signed zone (`FULL_RESTRICTED`) and conduit,
which is how OpenSea's own contracts-as-sellers list: OpenSea reads it from Seaport's
`OrderValidated` event and shows it, and sells it from its site, with its zone's signature on
each purchase. Without a zone (Sepolia, local networks) the order is `FULL_OPEN`: anyone fills
it, the page's "Buy now" included. `VaultListings.orderOf(orderHash)` returns the parameters
exactly as a buyer passes them to `fulfillOrder`; the vault's `Listing` keeps `boxId`, `price`
(what the buyer pays, fees included), `net` (what comes to the vault), `endTime` and the order
hash. Seaport does not call the vault back, so the vault learns of a sale when someone calls
`sync` or sends a request on the box; `buy` in the adapter calls `sync` right after filling. A
listing that ran out without a buyer goes back to `Sealed` at the next `sync`
(`ListingExpired`), and its approval is cleared. A listed box cannot move, cannot be sold
privately, and a withdrawal takes its listing down first (`cancel`, written by
`VaultListings.cancelCall`, sent by the vault). A withdrawal beaten by a Seaport buyer settles
`Stale`, and the ETH waits for the key.

The fee (`feeBps`, 2.5% by default, never more than `MAX_FEE_BPS`, 10%) is taken at `sync` on
`net`, at the rate of that moment, and kept in `feesOwed`; `sendFees` (anyone) sends it to the
treasury.

### Accepting an offer

A buyer offers WETH for a box's NFT the way they would on any marketplace: a Seaport order whose
offer is WETH and whose consideration is the NFT (to the buyer) and, if any, the order's own
fees in WETH. The holder accepts it with a request like any other; the vault fills it itself,
sending Seaport the call `VaultOffers` writes (the NFT's holder has to be Seaport's caller:
OpenSea's signed zone signs a fill for the address that holds the NFT), and the ETH goes
straight to the address the holder named.

```mermaid
sequenceDiagram
  autonumber
  actor B as Buyer
  participant W as WETH
  participant O as VaultOffers
  participant S as Seaport 1.6 (1.5 locally)
  actor H as Holder
  participant V as Vault
  participant N as NFT collection
  B->>W: deposit (wrap ETH), approve(Seaport, amount)
  B->>B: sign the Seaport order (EIP-712): offer WETH, consideration the NFT
  B->>O: post(order, signature) (anyone may send it)
  O->>S: validate([order, signature]): fills with no signature from now on
  O-->>H: OfferPosted(collection, tokenId or ANY_TOKEN, orderHash, order)
  H->>O: inspect(offer, collection, tokenId, 0): alive, and what it nets
  H->>V: request(AcceptOffer, to, least = net, ref = orderHash) ... publicDecrypt (as above)
  H->>V: finalizeOffer(requestId, ok, proof, abi.encode(order, criteriaProof))
  V->>O: inspect(offer, collection, tokenId, least): orderHash must be ref (else WrongOrder)
  alt not ok
    V->>V: Refused
  else the order is dead: cancelled, filled, ended, or worth less than least
    V->>V: Stale: the box stays
  else
    V->>V: a listed box is taken down first
    V->>O: fillCall(offer, collection, tokenId, recipient vault): the fulfillAdvancedOrder call (1/units, resolver to tokenId), the WETH fee
    V->>N: approve(Seaport, tokenId)
    V->>W: approve(Seaport, fee)
    V->>S: fulfillAdvancedOrder(order, resolvers, 0, vault) (the call VaultOffers wrote; on mainnet with OpenSea's zone signature for the vault)
    S->>W: WETH from the buyer to the vault
    S->>N: the NFT from the vault to the buyer
    S->>W: the order's fees from the vault
    V->>W: approve(Seaport, 0); withdraw (unwrap)
    W->>V: ETH (receive: from Seaport or WETH only)
    V->>V: the NFT must be gone; at least least, else revert; proceeds = amount - fee, feesOwed += fee, delegate cleared
    V-->>H: OfferAccepted(boxId, orderHash, buyer, amount)
    V->>V: send proceeds to `to`: Claimed; if it refuses ETH, the box stays Sold for a Claim
  end
```

- **Only the box's NFT can go.** `inspect` lets through only an order whose offer is WETH and
  whose consideration is WETH fees and that one NFT (the box's collection and token, or a
  criteria item resolved to it), with fixed amounts and no tips, so the order Seaport runs can
  move no other NFT; and the vault approves Seaport for that token alone (a listed box's conduit
  approval is cleared first), and for the order's WETH fee alone. An offer on any NFT of a
  collection (an item "with criteria", root 0) is resolved by `VaultOffers` to the box's own
  token. The vault sends the fill itself rather than handing `VaultOffers` the NFT (as it did
  until 2026-10-10) because OpenSea's signed zone signs a fill only for the address that holds
  the NFT, and Seaport's caller must be that address.
- **One token's share.** An offer for several NFTs (`units`) is filled for one: `VaultOffers`
  sets the fraction to 1/units. What the request's `price` must cover is one share, net of the
  order's own fees: `(paid - fees) / units`.
- **Dead or not yet.** An order that is cancelled, filled, ended or worth less than asked will
  never fill: `finalizeOffer` settles `Stale`. One that only cannot fill now (the buyer's WETH or
  allowance short, the order not yet validated) reverts and leaves the request waiting: someone
  who finalizes with bad data cannot spoil it. It fills on a later try, or anyone expires it
  after a day. Plain `finalize` settles a wrong key `Refused` without the order, and reverts with
  `NeedsOrder` when the key matched.
- **The offer board.** Buyers post their offers to `VaultOffers.post`, which validates them on
  Seaport with the buyer's signature and logs them by NFT, so the page finds the offers on a box
  without a marketplace's API. Any signed offer for an NFT, on the
  Seaport `VaultOffers` is deployed on (1.6 on Sepolia and mainnet, as the listings; the page
  signs for the version Seaport's `information()` reports), can be posted there, from any
  marketplace or script. An offer the vault accepts does not have to be on the board: the holder
  can name any Seaport order that fits.
- **OpenSea's own offers fill too.** An offer made on opensea.io (Seaport 1.6, behind OpenSea's
  signed zone, OpenSea's fee in WETH, through its conduit) is a Seaport order like the board's,
  and `VaultOffers`, unchanged, fills it: `npx hardhat dno:opensea-replay --tx <hash>`
  (`tasks/opensea.ts`) proved it on 2026-10-10 by forking mainnet with anvil just before a real
  fill a contract made, putting `VaultOffers`' code at that contract's address (the one OpenSea's
  zone signature names) and filling the same order through the real Seaport 1.6, zone and
  conduit (transaction `0xd49327e0f801e4c9ad58c63096f572b9edbbaafbdf9b471dfd097bd4ff97923f`, a
  collection offer of 0.0047 WETH, 1% to OpenSea, 0.004653 ETH came back, 222,000 gas). The API
  side is built too: on mainnet the API reads an NFT's offers from OpenSea with its key and, right
  before `finalizeOffer`, asks OpenSea the order signed by its zone for the vault's address (it
  signs only for the NFT's holder, which is why the vault sends the fill itself; see
  [The marketplace's offers](#the-marketplaces-offers)); `pnpm --filter @dno/chain-adapter
  opensea:fork` runs that path against a live offer on a fork of mainnet.

### Delegation

The vault owns every NFT it holds, so it is the vault that delegate.xyz's registry is asked
about. A `Delegate` request names one wallet per box (`delegateERC721(delegate, collection,
tokenId, rights 0, true)`, every right), revoking the one before; zero clears it. Airdrop claims,
token gates and claim sites that read the registry let that wallet act for the NFT without
holding it.

```mermaid
sequenceDiagram
  autonumber
  actor H as Holder
  participant V as Vault
  participant D as delegate.xyz registry
  actor C as Claim site
  H->>V: request(Delegate, to = a fresh wallet) ... finalize
  V->>D: delegateERC721(old, collection, tokenId, 0, false) (if any)
  V->>D: delegateERC721(fresh, collection, tokenId, 0, true)
  V-->>H: Delegated(boxId, fresh)
  C->>D: checkDelegateForERC721(fresh, vault, collection, tokenId, 0)
  D-->>C: true: the fresh wallet may claim for the NFT
```

The delegate is public (`boxInfo`, `Delegated`, the registry): a fresh wallet keeps the holder
unlinked, their main wallet would not. A box keeps its delegate when it changes hands, since
whether a transfer moved it is secret and anyone may send a transfer that moves nothing: its new
holder names their own (the page shows the box's delegate). Taking the NFT out, a Seaport sale
and an accepted offer clear it. The game's own collection is not concerned: only the vault's
boxes are.

### Private sale

The holder names a buyer and an encrypted cUSDC price only the two of them can read. Nothing is
decrypted in public: to everyone else, a sale that went through and one that did not look the
same.

```mermaid
sequenceDiagram
  autonumber
  actor S as Seller
  participant V as Vault
  participant U as cUSDC
  participant R as Relayer / KMS
  actor B as Buyer
  S->>S: encrypt the price for the vault, in the page
  S->>V: offerSale(boxId, buyer, price, proof)
  V->>V: box Sealed (else WrongState), p = min(price, MAX_SALE_PRICE)
  V->>V: allow p to the vault, the seller and the buyer
  V-->>B: SaleOffered(saleId, boxId, seller, buyer) (no price)
  B->>R: userDecrypt(saleInfo(saleId).price)
  R-->>B: the price, for the buyer's eyes
  B->>U: setOperator(vault, until)
  B->>V: acceptSale(saleId, key, proof)
  V->>U: confidentialTransferFrom(buyer, vault, p): all or nothing
  V->>V: paid = (pulled == p)
  V->>V: moved = transfer from seller to buyer if paid, only if the seller still holds the box
  V->>V: key = select(moved, buyer's key, old key)
  V->>V: fee = pulled * feeBps / 10000, encrypted
  V->>U: seller gets select(moved, pulled - fee, 0), treasury select(moved, fee, 0), buyer select(moved, 0, pulled)
  V->>V: allow moved to the seller and the buyer
  V-->>B: SaleSettled(saleId) (not whether it moved)
```

Anyone may offer any box: unless the caller holds it when the buyer accepts, nothing moves and
the buyer gets their cUSDC back, so an offer proves nothing about who holds the box. The seller
may `cancelSale` while it is open; only the named buyer may accept, once. A box offered to two
buyers moves to the first who accepts; the second's acceptance moves nothing and refunds them.
`acceptSale` reverts (and so takes nothing) when the box is listed or a request waits on it (the
page settles those first). The price is capped
at `MAX_SALE_PRICE` (1,000,000 USDC) under encryption, so `pulled * MAX_FEE_BPS` stays under
2^64 and the encrypted fee cannot wrap. In the adapter: `offerSale`, `sales`, `salePrices` (one
user decryption), `acceptSale` (returns whether it moved, decrypted for the buyer), `cancelSale`.

### Give a box, and make its key yours

```mermaid
sequenceDiagram
  autonumber
  actor A as Holder
  participant V as Vault
  actor C as Receiver
  A->>V: confidentialTransfer(receiver, boxId)
  V->>V: Sealed and no request waiting (else revert), moved = owner == holder
  V->>V: key = select(moved, randEuint256(), key)
  V-->>C: ConfidentialTransfer(boxId, holder, receiver, moved)
  C->>C: finds the box in their receipts (one signature)
  C->>V: setKey(boxId, key, proof) (from the receiver's wallet)
  V->>V: key = select(isOwner(boxId, caller), new key, old key)
  V-->>C: KeySet(boxId, caller)
```

Until the receiver sets their key, nobody can take the NFT out, list it or collect anything: the
key is random. `confidentialTransferIf` (the holder's own decoys) works on vault boxes as on the
game's boxes. In the adapter: `send`, `adopt`.

## Pockets

The vault holds tokens too. An ERC-7984 token like cUSDC hides balances and amounts, but every
transfer still names its sender and its receiver: the graph of who pays whom stays public. A
pocket hides that as well. It is a number with an encrypted 256-bit key, an encrypted `euint64`
balance and a `viewer`, an address the holder's page derives to read the balance; the holder's
wallet appears in none of it. The design notes at the top of
[`SealedPockets.sol`](../packages/contracts-evm/contracts/SealedPockets.sol) and
[`PocketDesk.sol`](../packages/contracts-evm/contracts/vault/PocketDesk.sol) are the reference.

**One signature.** The page asks the wallet to sign a fixed message (`pocketKeyMessage` in
`EvmPockets.ts`), free and off-chain. `keccak256(signature, "key")` is the pocket's key,
`keccak256(signature, "viewer")` the private key of its viewer, a wallet that only ever signs
decryption permits and never a transaction. Nothing is stored: `pocketOf(viewer)` finds the
pocket again on any device. A wallet has one pocket per token (see [Other tokens](#other-tokens)).

**Groups, not pockets.** Every action names a set of pockets (`MAX_SET`, 5 at most, in increasing
order, all opened): the real one's group, always the same. Pockets make groups of `MAX_SET` by
number (0 to 4, 5 to 9...; `pocketGroup`, `pocketSet`), and every action of a pocket names its
whole group, so a set says which group acted and never which pocket, however many of a pocket's
actions are compared. The page first picked decoys at random among every pocket: that hides one
action, not a series, since the real pocket is the one in every set and two or three sets
intersect down to it. The last group holds the pockets opened so far and fills as pockets open
(the page says how far). A deposit credits the pocket of its set whose number equals an encrypted target; a send
debits the pocket of its paying set whose key matches and credits the pocket of its receiving
set whose number matches; a withdrawal debits the matching pocket and pays the amount out. Every
pocket named gets a new balance handle, moved or not, so nobody can tell which one moved.

**The key bound to the terms.** A spend sends the amount and the target in one encrypted input,
then the key XOR `spendHash(action, from, to, destination, amount handle, target handle)` in a
second one (its terms hash the first one's handles, so it is encrypted after them). A relayer
that changed a set, the destination or an encrypted value would make the pockets compare against
another hash: the key would not match and nothing would move. Each bound key's handle can be used
once (`spent`), so a spend cannot be replayed. A wrong key, a short balance or a target outside
the receiving set move nothing, without a revert.

**No decryption.** Unlike the boxes' requests, a spend never needs a public decryption: what it
moves is decided and applied under encryption in the same transaction, and a withdrawal pays out
an encrypted amount (`confidentialTransfer`). Pockets do not wait for Zama's gateway.

### Flows

```mermaid
sequenceDiagram
  actor W as Holder's wallet
  participant P as Page
  participant R as Relayer
  participant S as SealedPockets
  participant C as cUSDC
  W->>P: sign the pocket message (once)
  P->>P: key, viewer from the signature
  P->>R: open(key encrypted, viewer)
  R->>S: open
  W->>S: deposit([my group], target, amount) (setOperator first)
  S->>C: confidentialTransferFrom(wallet, pockets, amount)
  S->>S: credit select(target == id) to each pocket of the set; refund what found no pocket
  P->>R: send(from set, to set, amount + target, key XOR spendHash)
  R->>S: send
  S->>S: debit select(key matches and balance covers and target in set); credit the target
  P->>R: withdraw(from set, to, amount, key XOR spendHash)
  R->>S: withdraw
  S->>C: confidentialTransfer(to, what was debited)
  P->>P: the viewer decrypts the balance (user decryption)
```

```mermaid
sequenceDiagram
  actor Seller
  participant V as SealedVault
  participant D as PocketDesk
  participant P as Buyer's page
  participant K as Zama relayer + KMS
  participant S as SealedPockets
  Seller->>V: offerSale(box, desk, price)
  Seller->>D: reserve(saleId, pocket) (the pocket's viewer may read the price)
  P->>D: ask(saleId, key XOR buyHash(sale, pocket, box key handle))
  D->>S: deskCheck: key matches and balance covers price (one bit, public)
  P->>K: publicDecrypt(ok)
  P->>D: buy(askId, proof, box key for the vault)
  D->>S: deskTake(pocket, key, price): price or 0 to the desk
  D->>V: acceptSale(saleId, box key): pulls the price from the desk, all or nothing
  V-->>D: the box, if paid and the seller still held it; or a refund
  D->>S: deskGive(pocket, what came back)
```

### With the vault's boxes

**Paying from a pocket.** A seller offers a box privately to the desk and reserves the sale for
the buyer's pocket (its code, `P-12` on the page); the desk lets that pocket's viewer read the
price. The buyer asks first: the desk checks the key and the balance under encryption and makes
only that bit public. Without that step a stranger could spend the seller's sale with a wrong
key, since the vault settles a sale on its first `acceptSale`, paid or not. With the proof, `buy`
takes the price from the pocket (or nothing, if the balance moved since), lets the vault pull it
from the desk (all or nothing, so a pocket that paid nothing buys nothing), and hands back
whatever the vault refunded. The desk never holds tokens outside `buy` and never sells, so the
vault can never pull anything but the price just taken. The box is then held by the desk, a
holder every pocket shares, with the buyer's vault key (the same key the page derives for any of
the wallet's boxes): taking the NFT out, listing it, accepting an offer, claiming a sale's ETH and
delegating work as for any box. Giving it away or selling it privately need its holder's address,
here the desk's, so they are not offered for those boxes. `ownerOf(box)` on the desk (encrypted,
readable by the buyers' viewers) tells the page which bought boxes are its pocket's.

**Cashing in.** After a private sale, the seller's page offers "Into my pocket": a deposit of the
price, less the fee, from the seller's cUSDC. The deposit names the seller's wallet, as any
deposit does.

### What is public

| Fact | Visible to everyone |
| --- | --- |
| A pocket | its number and its viewer (an address tied to no wallet), when it was opened, by which sender |
| A deposit | the wallet, and the group it named; not the amount when it comes from cUSDC, nor which pocket of the group got it |
| A send | the paying group and the receiving group, the sender (the relayer); not who paid whom, nor how much |
| A withdrawal | the paying group, the address paid; not the amount, nor which pocket paid |
| A purchase from a pocket | the sale, its seller, the pocket it is reserved for, the ask's yes or no; not the price, nor whether the box moved |

Never public: a pocket's balance, an amount, which pocket of a group moved, who holds a pocket.

In practice: a group is public, so a pocket hides among its group's five at most, and a deposit
ties its wallet to the group, not to a pocket: the wallets that fed a group are the ones anyone
can tie to one of its pockets (`group().feeders`, which the page shows, 1 meaning "yours
alone"), and a group still filling hides among fewer. The sets being fixed, following a pocket's
actions over time tells nothing more than one of them. A deposit from plain USDC shows the
amount when it is shielded; a withdrawal to a known address names its receiver. The reserved
pocket of a desk sale is public (the seller chose it): that pocket tried to buy that box.

### Other tokens

The pockets hold Zama's other confidential tokens too: cUSDT, cWETH and cZAMA, the ERC-7984
wrappers listed in Zama's Confidential Token Wrappers Registry
(`0x2f0750Bbb0A246059d80e94c454586a7F27a128e` on Sepolia), all with 6 decimals, their test
ERC-20s free for anyone to mint. Each has its own `SealedPockets`, the same contract unchanged,
deployed by `deploy/pockets.ts` from `lib/pocketTokens.ts` as `SealedPockets_<symbol>`, without a
desk: the vault's private sales settle in cUSDC, so only cUSDC pockets buy boxes.

| Token | Its pockets on Sepolia | The token | Its ERC-20 |
| --- | --- | --- | --- |
| cUSDC | `0x3c925f9AB849ABbcb47EC12Be0D9BDB4d9EA4395` (with `PocketDesk`) | `0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639` | USDC (6 decimals) |
| cUSDT | `0x56ea8016aE3a392E7E1bdf0c7C457a3786047aAe` | `0x4E7B06D78965594eB5EF5414c357ca21E1554491` | USDT `0xa7dA08FafDC9097Cc0E7D4f113A61e31d7e8e9b0` (6) |
| cWETH | `0x4e8A23DfD7a23677b023E069CB8D3A94993b1350` | `0x46208622DA27d91db4f0393733C8BA082ed83158` | Zama's WETHMock `0xff54739b16576FA5402F211D0b938469Ab9A5f3F` (18, rate 10^12), not OpenSea's WETH the offers pay in |
| cZAMA | `0x6D1585c58238DaADF748558051BF368DAA3eceE2` | `0xf2D628d2598aF4eAF94CB76a437Ff86CA78FfbFB` | ZAMA `0x75355a85c6FB9df5f0C80FF54e8747EEe9a0BF57` (18, rate 10^12) |

**Still one signature.** The same message (it names the cUSDC pockets) makes every token's
pocket. cUSDC keeps `keccak256(signature, "key")` and `"viewer"`; another token's pocket uses
`keccak256(signature, "key:" + its pockets' address, lowercase)` and `"viewer:" + address`. Each
pocket has its own viewer, so nothing on-chain ties a wallet's pockets of different tokens
together; switching tokens on the page asks nothing more.

**On the page.** A token picker, each with its logo, above "My pocket"; the pouch, the balance,
the amounts and every action's scene wear the picked token's logo. On a test network, "Get test
…" mints the ERC-20 and "Turn … into …" wraps it before the deposit.

**What it adds to what leaks.** Which token an action moves is public (each token's pockets are
their own contract), and decoys are picked only among the same token's pockets: a token few
people use hides its pockets among fewer.

### Pockets' decisions

- **A key, as for the boxes, and a viewer apart.** The balance must be readable by its holder,
  and ACL grants are public: allowing the wallet on its pocket's handles would name it. The
  viewer, derived from the same signature, is allowed instead; it holds no ETH and signs only
  decryption permits.
- **Sets and an encrypted target, not one pocket.** Naming one pocket per side would make every
  send a public edge between two pseudonyms. A set of five with the real one hidden costs a few
  more encrypted operations per pocket (6.5M HCU for five on each side, under the 20M limit).
- **Fixed groups, not random decoys.** Decoys drawn afresh for each action hide that action and
  betray the series: the real pocket is in every set, the decoys change, so the intersection of
  two or three of a pocket's sets is the pocket. A group fixed by number names the same five
  every time, so the sets of a pocket intersect to its group and nothing less; it guarantees
  one in five, for good, where random decoys promised more and delivered one. The contract did
  not change: the page picks the set, and `MAX_SET` sets the group's size. Overlapping groups
  (Monero's rings) would raise the ceiling at the cost of a far more complex pick; one in five,
  guaranteed, came first.
- **A spent-handle list, not a nonce.** A nonce would have to move only when the key matched,
  which is encrypted here (the boxes make that bit public; a spend does not decrypt anything).
  A bound key's handle can be used once instead: a fresh encryption gives a fresh handle, and
  only the key's holder can make one that matches.
- **The desk asks first.** The vault's `acceptSale` settles a sale on its first call, paid or
  not; letting anyone call `buy` straight away would let a stranger spend a seller's sale with a
  wrong key. The one public bit costs a decryption, as the boxes' requests do.
- **The desk, not the pockets, buys.** The vault pulls a sale's price from its buyer's whole
  balance; the pockets' contract holds everyone's tokens, so a short pocket would have been paid
  for by the others. The desk holds only what `buy` just took.
- **No change to `SealedVault`.** It was 254 bytes under the size limit when the pockets came
  (781 since the listings' orders moved out to `VaultListings` and the vault sends the offers'
  fills itself); the desk works with the vault as it is deployed.
- **One contract per token, not one for all.** One contract holding every token would share the
  decoys but would show which token moved anyway, unless every action touched every token (the
  HCU multiplied by the number of tokens). The same `SealedPockets`, deployed again, needed no
  new code and no new audit surface.
- **A viewer's permit names the vault's contracts only.** Zama's relayer takes 10 contracts per
  decryption permit; the wallet's permit already names nine. A pocket's viewer reads only its
  pocket, the desk and the vault's sale prices, so its permit names the vault, the pockets (every
  token's) and the desk.

### Pockets' limits

- One token per pockets contract (cUSDC, cUSDT, cWETH, cZAMA on Sepolia), one pocket per wallet
  and token, five pockets a side at most; only cUSDC pockets buy boxes.
- A pocket hides among its group's five at most, fewer while its group fills (the last group,
  until five pockets are open past the previous one), and a deposit names the wallet and the
  group: a group few wallets have fed hides those few. The page shows both counts.
- A box bought from a pocket cannot be given or sold privately again (its holder is the desk).
- A purchase needs a public decryption, so it waits for Zama's gateway like the boxes' requests;
  deposits, sends and withdrawals do not.
- The pocket key comes from one signature of a fixed message: a site that tricks a wallet into
  signing it can spend that wallet's pocket.
- Not audited. A purchase from a pocket has not run on Sepolia yet: it waits for the gateway like
  the boxes' requests.

## What is public, what is not

| Fact | Visible to everyone | How |
| --- | --- | --- |
| A deposit | the depositor, the collection and the token id, and the addresses its decoys went to, not whether any moved the box | `Deposited`, `ConfidentialTransfer`, and the NFT's own `Transfer` to the vault |
| The NFT inside each box | yes | `boxInfo`, `boxOf`, `tokenURI` (the NFT's own metadata) |
| A box's state, its listing, its pending request, its unclaimed ETH | yes | `boxInfo`, `listingInfo`, `requestInfo` |
| A Seaport listing | its price, its fees (OpenSea's, the creator's), end time and order hash; the seller is the vault. On mainnet the listing shows on OpenSea, as any listing | `Listed`, `VaultListings.Prepared`, and Seaport is public |
| A Seaport purchase | the buyer and the price, as any Seaport fill | Seaport's `OrderFulfilled`, `SoldOnSeaport` |
| An offer | the buyer, the NFT, the WETH and its end time, as on any marketplace | `OfferPosted`, Seaport's `OrderValidated` |
| An accepted offer | the buyer, the box, what it netted, where the ETH went | `OfferAccepted`, `Claimed`, Seaport's `OrderFulfilled` |
| A box's delegate | the wallet, and when it was set or cleared | `boxInfo`, `Delegated`, the registry's own events |
| A request | the sender, the box, the action and its terms (`to`, price, end time, an offer's order hash), and whether it settled `Done`, `Refused`, `Stale` or `Expired` | `RequestPlaced`, `RequestSettled`, calldata. With the relayer, the sender is the relayer |
| Where an NFT or a sale's ETH goes | the address and the amount | `Withdrawn`, `Claimed`, the transfers themselves |
| A transfer | the sender and the recipient addresses, not whether it moved | `ConfidentialTransfer` |
| A `setKey` | the caller, not whether it took effect | `KeySet` |
| A private sale | the seller and the buyer addresses, that it was offered, cancelled or settled | `SaleOffered`, `SaleCancelled`, `SaleSettled` |

Never public: who holds a box, the key, a private sale's price and fee, whether a private sale
or a transfer moved anything, a buyer's or seller's cUSDC balance.

What that means in practice:

- **The deposit names the depositor.** With its decoys (the page's default) the depositor is not
  its obvious holder: any of the transfers may have moved the box. Without them, they are until
  the box moves. Decoys are only as good as the doubt they leave, which is why they go to wallets
  that use the vault and not to fresh addresses (a fresh address never acts: nobody believes it
  holds anything): someone who sees a "Make the
  key mine" (`KeySet`) from none of the decoy addresses may bet the box stayed; a real send among
  them, followed by a `setKey`, names its receiver. The page tells each holder how many wallets
  may hold each of their boxes, as far as the chain tells.
- **A request hides its sender only when the relayer sends it.** Sent from the holder's wallet,
  it ties that wallet to the box (it held the key).
- **The exit is public**: the address an NFT or a sale's ETH goes to, and the amount. An address
  with no history shows no link to the holder; timing still can.
- **A delegate is public.** The wallet named for the NFT shows in the registry: a fresh one says
  nothing about the holder, their main wallet would name them.
- **Accepting an offer is a Seaport sale**: the buyer, the price and the payout address show,
  the holder does not.
- **`setKey` names its caller.** A `setKey` right after a transfer to the same address is a
  strong hint, though anyone may call `setKey` on any box and it looks the same.
- **A private sale names both sides**, not who held the box nor whether it moved.

## The relayer

`apps/api` can send holders' requests and their proofs from a wallet of its own, so the holder's
address appears in no transaction. `GET /v1/vault/relayer` answers `{ address }` (null without
one); `POST /v1/vault/relay` takes `{ call: "request" | "finalize", args }` and answers the
transaction hash. A request carries `ref` (an offer's order hash, zero otherwise); a `finalize`
with `offer` (the encoded order) is sent as `finalizeOffer`. Details and settings: [`apps/api/README.md`](../apps/api/README.md#the-sealed-vaults-relayer).

- **It learns nothing a chain observer would not.** The key arrives encrypted for the vault and
  bound to the request's terms and nonce: the relayer can neither read it, change the terms, nor
  reuse it. The API does see the IP a relay comes from, as any web server does, and counts it in
  memory for the rate limit.
- **It pays the gas**, so it is capped: `VAULT_RELAY_RATE_PER_MINUTE` (10) per IP, and
  `VAULT_RELAY_PER_DAY` (500) transactions a day per replica. Every call is estimated first, so
  a request the vault would refuse (wrong state, bad price) costs nothing and answers
  `400` with the contract's reason.
- **It can refuse, not cheat.** A relayer that is down, capped or censoring leaves the holder
  their wallet: the page sends the request itself, and says the address then shows.
- **Replicas share one key and one nonce space**; a nonce taken by another replica is retried
  with a fresh count, twice at most. The indexer role never sends.

## The marketplace's offers

OpenSea's offers live off-chain: a buyer signs a Seaport order, OpenSea keeps it, and its signed
zone lets Seaport fill it only with `extraData` OpenSea's server signs for the one address that
fills it, for a few minutes. The page cannot read them from the chain as it reads the board's,
so on mainnet the API reads them for it, with its own key (`OPENSEA_API_KEY`; the key never
reaches a browser): `GET /v1/vault/market` names the marketplace and the address OpenSea signs
for (`VaultOffers`; `{ name: null }` where there is none), `GET /v1/vault/offers/:collection/:tokenId`
lists the live WETH offers on a token and on its collection as the board's are listed (the order
included, without the zone's signature, so the page can `inspect` it), and
`POST /v1/vault/offers/fulfillment` answers the encoded order with the zone's signature for the
vault (OpenSea signs a fill only for the address that holds the NFT, and Seaport's caller must
be that address: the vault sends the fill itself), which the page asks for right before
`finalizeOffer`, since the signature lasts minutes (`OpenSeaOffers` in `packages/chain-adapter/src/opensea.ts`, `VaultMarket` in
`apps/api/src/application/vaultMarket.ts`). The page shows them next to the board's, marked "on
OpenSea"; accepting one is the same request, the order hash as `ref`. Details:
[`apps/api/README.md`](../apps/api/README.md#openseas-offers).

- **The API learns nothing about the holder.** It reads what opensea.io shows anyone, for a
  token anyone can name; the fill is asked for the vault, never for a wallet.
- **OpenSea closed its testnets**: on Sepolia the API reads no marketplace and the page shows
  the board's offers only. The path is checked against a live mainnet offer on a local fork:
  `pnpm --filter @dno/chain-adapter opensea:fork -- --collection <address> --token <id>` reads the
  token's offers, forks mainnet with anvil, deploys `VaultOffers` there, has the NFT's mainnet
  holder play the vault (OpenSea signs only for the holder), asks OpenSea the fill signed for it,
  and sends Seaport the call `VaultOffers` wrote from that holder. Done on 2026-10-10 with BAYC
  #1: a live offer of 9.504 WETH net (9.6 with OpenSea's 1%), OpenSea's signature good for about
  five minutes, 217,748 gas, the NFT to the buyer and the 9.504 WETH to the holder.
- **Trait offers are left out** (an offer on some of a collection's NFTs, by trait): the
  contracts could fill one with its criteria proof, but the page does not list them.

## What the team sees

The API's index reads the vault's events and keeps their counts, never an address that could
name a holder: the depositor, a withdrawal's or a claim's recipient, a private sale's parties and
a request's sender are public on-chain but dropped when the logs are decoded. The admin site's
"Coffre" tab shows boxes by state, deposits per collection, Seaport listings, sales (accepted
offers among them) and volume, delegations set or cleared, private sales offered and settled (their price stays encrypted, to the team too), requests by
action and outcome, and the latest events. Grafana's "The sealed vault" row shows the same
counts and the relayer's wallet, its day against its cap and what it sent or refused; Discord
gets an alert when the relayer runs low (`VaultRelayerLow` under 0.05 ETH, `VaultRelayerEmpty`),
fails to send, nears its cap, or a request waits over an hour, and an activity post for each
deposit, Seaport sale, private sale and withdrawal ([`deploy/README.md`](../deploy/README.md#monitoring)).

## Decisions

- **Requests are asked with a key, not an address.** An address check needs the holder to sign
  the transaction, which names them. A key compared under encryption lets any wallet carry the
  request, and only one bit ("matched") is decrypted.
- **The key is bound to the terms with an XOR, not a signature.** Checking a signature under
  encryption is out of reach; XOR with a public hash of the terms and a per-box nonce costs one
  `xor` and one `eq` on `euint256`, and makes a changed or replayed request fail like a wrong key.
- **Nobody is allowed on the key.** ACL grants cannot be revoked
  ([ZAMA_NOTES.md](ZAMA_NOTES.md#2-acl-grants-cannot-be-revoked)): a holder allowed on their key
  would keep reading it after selling the box. The app derives the key from a signature instead
  of reading it back.
- **A transfer gives the box a random key.** The old key must not open the box for the next
  holder; a fresh `randEuint256` selected by `moved` does it without revealing whether it moved.
- **Requests do not lock each other out; transfers wait for them.** A first version took one
  request per box and refused the others while it waited (`busy`), and moved the nonce on with
  every request: a stranger could send wrong-key requests in a loop, about 323k gas each, keep
  the holder from taking the NFT out, listing it, taking a listing down or collecting, and spoil
  every request the holder prepared. Now any number may wait; each is decided alone, `_canRun`
  turns a request the box outgrew into `Stale`, and only a matched key moves the nonce on. A
  request decided for one holder must still never run for the next, so transfers and private
  sales wait until no request does (`pending` is public anyway). A stranger can still delay a
  transfer, never an exit, and anyone can clear the way: `finalize` as soon as the KMS answers,
  `expire` after a day.
- **Decoys at the deposit, not an encrypted recipient.** Minting the box to an encrypted address
  would hide who it went to, but the receiver could not find it: receipts are how a holder finds
  their boxes, and a receipt names its address. Transfers in the same transaction, each real or
  not under encryption, leave the same doubt as the game's decoys and keep the receipts working.
- **Seaport, with the vault as the offerer, validated on-chain.** No signature to forge and no
  ERC-1271 to get wrong; the operator (OpenSea's conduit, or Seaport) is approved for one token
  at a time and only while it is listed; the ETH comes to the vault, which takes it from Seaport
  only (`receive`).
- **Listings written by `VaultListings`, the way OpenSea shows them.** An order validated
  on-chain was thought invisible to OpenSea, which was believed to list only what its API was
  given. Two live contract listings read on 2026-10-10 (TokenWorks' "NFT strategy" contracts,
  `0xd0cC2b0eFb168bFe1f94a948D8df70FA10257196` selling Good Vibes Club #4678 and
  `0x3ca20831EBea5C99AA6E574D83f0A7C733F7e4D0` selling Chimpers #209) showed otherwise: their
  verified source does exactly `validate`, with OpenSea's conduit, its signed zone and its fee,
  no ERC-1271 and no API, and opensea.io shows "Buy now" on both. OpenSea ingests Seaport 1.6's
  `OrderValidated` events of orders built its way. So a contract of its own, `VaultListings`,
  writes the vault's orders that way and keeps them (the vault had 254 bytes left, and the
  order's construction was the piece to move out), while the vault still sends `validate` and
  `cancel` itself, so the offerer is the vault and nothing is listed unless the vault lists it.
  The trade-off of the zone: a `FULL_RESTRICTED` order is filled only with OpenSea's signature,
  so on mainnet a listing is bought on OpenSea, not from the vault's page (the adapter's `buy`
  refuses, the page shows "Buy on OpenSea"), and OpenSea can decline to sign; where OpenSea is
  not (Sepolia, local networks) the order has no zone and anyone fills it. The fees are the
  owner's to set, per collection, because OpenSea shows a listing only with the fees it asks for
  that collection (its 1%, the creator's enforced fee): the order carries them as consideration
  items, so a listing keeps the fees it was made with whatever the owner sets later, and the
  vault's `Listing` keeps `net`, what comes to the vault, next to the buyer's price. It had to
  be Seaport 1.6: OpenSea's conduit's channel is open to it, and its zone signs for it. Seaport
  1.6, OpenSea's conduit and its zone are on Sepolia too (checked on-chain on 2026-10-10;
  earlier docs said 1.6 was not there), but OpenSea closed its testnets, so nothing signs for
  the zone there and Sepolia's listings are the mainnet ones without it.
- **Offers are filled through a helper that holds one NFT.** The vault, as the fulfiller, would
  hand Seaport any NFT it approved (a listed box's included) that an order asked for; checking
  every item in the vault cost more than the bytes left at the time. `VaultOffers` is handed
  the box's NFT for one call and holds nothing else, so what an order can take is bounded by
  what it holds, and the item checks (`inspect`) live there too. The order travels as bytes the
  vault never decodes, for the same reason.
- **An on-chain offer board, not a marketplace's API.** OpenSea's API needs a key and lists its
  own orders; a log on `VaultOffers`, indexed by collection and token, is read by the page like
  any other event, and anyone can post to it. The orders themselves are plain Seaport orders,
  validated on Seaport. OpenSea's own offers fill through the same helper, unchanged, with
  OpenSea's zone signature in the order's `extraData`: proven on a fork of mainnet with
  `dno:opensea-replay` (above); reading them and asking OpenSea for that signature is the API
  side still to build.
- **WETH only, fixed amounts.** That is what Seaport offers pay in; other tokens, auctions
  (amounts that change over time) and tips are refused, so what an offer nets is known before it
  fills.
- **A failed fill keeps the request.** Anyone may send `finalizeOffer`, with any data: if a fill
  that only failed this time settled `Stale`, a stranger could spoil the holder's request with a
  bad order or proof. Only facts read from Seaport (cancelled, filled, ended) or the order's
  own terms settle it.
- **A delegate survives a transfer.** Clearing it on every transfer would let anyone clear any
  box's delegate with a transfer that moves nothing (a "maybe" anyone may send). The new holder
  replaces it with one request; withdrawals and sales clear it, as the NFT leaves.
- **`sync` is lazy and permissionless.** Seaport does not call back. Any request syncs first, and
  `finalize` checks again (`_canRun`), so a sale that landed between the two settles `Stale`.
- **The private sale is decided under encryption, in one transaction.** A public decryption would
  tell everyone whether the box moved; `select` on "paid and the seller held it" moves the box,
  the key and the money together, and only the two sides may read `moved`.
- **A failed ETH payout is not a revert.** A `to` that refuses ETH settles the claim `Stale` and
  leaves the proceeds in the box, so a mistaken address costs a retry, not the money.
- **Any ERC-721 comes in; the owner can shut a collection out.** Until 2026-10-10 the owner
  allowed collections one by one, as `deposit` trusts the collection's `transferFrom` and
  `tokenURI` (the latter called through `try/catch`). Now `deposit` checks the NFT is really the
  vault's after the transfer (`NotReceived`), so a contract that moves nothing mints no box; a
  worthless collection mints a worthless box, which its collection's address shows, as on any
  marketplace. `banCollection` stops new deposits from one; its boxes still come out. Nothing to
  set up per collection, on mainnet as on Sepolia.
- **Its own contract, at the default optimizer.** It shares nothing with `DoNotOpen` but the
  base and needs no privilege in it; at 23,795 bytes (23,650 before the deposit opened to any ERC-721 and checked the NFT arrived, 22,712 before it sent the offers' fills
  itself, 24,322 before the listings' orders moved out to `VaultListings`) it is under the limit without the size tricks `DoNotOpen` needs (an
  optimizer at 1 run saved 440 bytes only). The next feature moves logic out first, as offers
  and listings did.

## Limits

- On Sepolia the public decryptions wait on Zama's gateway: it answered nothing on 2026-10-08 and
  2026-10-09 ("ciphertext not ready" for every new handle), and on 2026-10-10 it answered within a
  minute or two, sometimes only after a retry ("not allowed for public decryption" until it has
  seen the ACL grant: `dno:vault-demo` asks again for up to five minutes). On the current vault
  the demo ran whole on 2026-10-10: a listing on Seaport 1.6, the buyer's fill through OpenSea's
  conduit, the ETH claimed to a fresh address, a wrong key refused, a withdrawal, a delegation
  the registry shows, and a WETH offer posted to the board and accepted, the vault sending the
  fill itself (its last request settled in
  `0xf2aef92850bcd5f40c42e03701fe9abba591ba2bac02508e945dd355e73c7295` on the vault taking any
  ERC-721; `0x55058ea1c8e13c3ead32e738bc2514c9813f035b2ac1d6388219f0abd39a02c0` and
  `0xda3b44e7f41ff688e361ac27aa986b60ac8854c589882de5a2f9fa8b8ede37f5` on the day's earlier
  vaults). A public
  RPC's nodes lag the one that mined a transaction (reads behind, "nonce too low"), so the demo
  reads until the state is there, and runs best on a single endpoint (`SEPOLIA_RPC_URL`). The
  previous vaults' pending listing requests (2026-10-09) can be expired by anyone.
- On mainnet a listing is bought on OpenSea only: it names OpenSea's signed zone, so a fill
  needs OpenSea's signature, which its checkout gives and the vault's page cannot (`buy` refuses
  with "This listing is bought on OpenSea."; the page links to the NFT's OpenSea page instead).
  OpenSea may also decline to sign, or stop showing orders it did not make. On Sepolia and on a
  local node the order has no zone and the page's "Buy now" fills it.
- Sepolia's listings show nowhere but the vault's page: OpenSea closed its testnets
  (`testnets.opensea.io` redirects to its farewell page, checked 2026-10-09), so the page links
  boxes and NFTs to Etherscan only there; on mainnet the chain's `marketplaceUrl` adds the
  OpenSea link. The orders are real Seaport orders: any Seaport marketplace, aggregator or
  script can fill an open one.
- The fees on a listing are what the owner set (`VaultListings.setFees`): the default ones, under
  collection 0, for every collection (OpenSea's 1%, set at deployment on mainnet), and a
  collection's own where OpenSea enforces a creator fee (read from its collection page or API),
  which replace the default. They must match what OpenSea asks, or OpenSea may not show the
  listing. Capped at 15% together; a listing keeps the fees it was made with.
- OpenSea's own offers (made on opensea.io, behind its signed zone) fill through `VaultOffers`
  as they are, and on mainnet the API reads them for the page and asks OpenSea the signed fill
  (`OPENSEA_API_KEY`, [The marketplace's offers](#the-marketplaces-offers)); not yet exercised
  with a vault on mainnet, only with a live offer on a fork. OpenSea's signature lasts minutes:
  the page asks for it right before the proof is sent, and a `finalizeOffer` that arrives after it
  expired reverts, leaving the request to a later try. OpenSea may also decline to sign. Where
  OpenSea is not (Sepolia), offers come from the vault's board, or any Seaport order that pays
  WETH and that the holder names.
- Offers on some of a collection's tokens (a criteria root other than 0, as for trait offers)
  are refused by the board; the vault would fill one only with its Merkle proof.
- A stranger's wrong-key requests can still hold a box's transfers and private sales back until
  someone finalizes them (anyone may, as soon as the KMS answers; the page does) or, after a day
  without a proof, expires them. Each try costs the stranger a request's gas (~290k to 375k). A
  transfer sent in the same block as such a request reverts and must be sent again. Exits
  (withdraw, list, unlist, claim) are never held back.
- The deposit, the exit and the request's sender without the relayer are public (above).
- The crowd is what it is: a deposit's decoys hide the box among the wallets that use the vault,
  and while few do, the rest go to fresh addresses that fool nobody for long; a box hides among
  its depositor and its decoys, a pocket among its group's five at most. The page shows the
  counts rather than promise more. A decoy's wallet is named, on-chain, as the "maybe" receiver
  of a box it never asked for; it is a wallet that already acts on the vault, never a stranger
  to it, and it costs it one false bit to decrypt.
- The relayer is one hot key on the API; its daily cap is per replica, so the stack's is
  `VAULT_RELAY_PER_DAY` times the replicas.
- The key comes from one signature of a fixed message: a site that tricks a wallet into signing
  it can take out every NFT that wallet holds in the vault.
- A private sale's outcome is readable by the two sides only; the seller learns it from `moved`
  or their cUSDC balance.
- The fee is read when a Seaport sale is synced, not when it is listed: the owner can change it
  in between (at most 10%).
- ERC-721 only (no ERC-1155), ETH listings and WETH offers only, one NFT per box, one delegate
  per box (every right).

## Cost

Measured on the local FHEVM with Seaport 1.5's Sepolia bytecode and, for the OpenSea-style
listings and offers, Seaport 1.6's mainnet bytecode (gas from `REPORT_GAS=1 pnpm test
test/SealedVault.ts`, HCU with `fhevm.computeTransactionHCU`; the FHE did not change with
`VaultListings`, so the HCU column is the one measured before it):

| Action | Gas | HCU |
| --- | --- | --- |
| `deposit`, no decoy | 450,000 to 470,000 | 83,000 |
| `deposit`, each decoy (or real send) more | about 230,000 | about 363,000 (with 5: 1,898,000, depth 1,233,000) |
| `request` (any action) | 291,000 to 379,000 | 191,000 |
| `finalize`, every action (refused the least, a listing the most: it now calls `VaultListings` and approves the conduit, one more contract call than before; with fees, one order item more per fee) | 101,000 to 606,000 | 0 |
| `finalizeOffer` (one WETH offer filled, a fee paid, ETH sent; the most with OpenSea's zone and conduit) | 145,000 to 426,000 | 0 |
| `VaultListings.setFees` (the owner, per collection) | 40,000 to 98,000 | 0 |
| `VaultOffers.post` (the buyer's offer validated and logged) | 101,000 | 0 |
| `expire` | 56,000 | 0 |
| Seaport `fulfillOrder` (the buyer, an open order on 1.5) | 97,000 | 0 |
| `sync` (expired / sold) | 51,000 to 113,000 | 0 |
| `confidentialTransfer` | 209,000 to 266,000 | 338,000 |
| `setKey` | 185,000 | 225,000 |
| `offerSale` | 304,000 | 150,000 |
| `acceptSale` | 1,660,000 | 4,342,000 (depth 2,307,000) |
| `cancelSale`, `sendFees` | 30,000, 36,000 | 0 |

The pockets, measured the same way (`REPORT_COSTS=1 npx hardhat test test/SealedPockets.ts`):

| Action | Gas | HCU |
| --- | --- | --- |
| `open` | 280,000 to 317,000 | 32 |
| `deposit`, set of 1 / 3 / 5 | 835,000 / 1,026,000 / 1,242,000 | 1,633,000 / 2,555,000 / 3,477,000 |
| `send`, 1 / 3 / 5 pockets a side | 541,000 / 1,079,000 / 1,614,000 | 1,315,000 / 3,915,000 / 6,515,000 (depth 1,971,000) |
| `withdraw`, set of 1 / 3 / 5 | 696,000 / 970,000 / 1,268,000 | 1,358,000 / 2,824,000 / 4,290,000 |
| `PocketDesk.ask` | 432,000 | 368,000 |
| `PocketDesk.buy` (the sale accepted on the vault) | 2,679,000 | 6,277,000 (depth 3,277,000) |

Deploying the vault takes about 5.18M gas (5.5M before `VaultListings`), `VaultListings` about
1.45M, `VaultOffers` about 1.9M. Every call is far under the protocol's 20M HCU (5M depth) a
transaction.

## Run it

```bash
pnpm --filter @dno/contracts-evm test test/SealedVault.ts   # 71 tests, Seaport 1.5's, 1.6's (with OpenSea's conduit) and delegate.xyz's real bytecode
pnpm --filter @dno/contracts-evm test test/SealedPockets.ts # 45 tests: the pockets and the desk, on the real vault
pnpm --filter @dno/contracts-evm test test/PocketsAdapter.ts # 5: the adapter's EvmPockets against them, relayed or not
pnpm --filter @dno/chain-adapter exec vitest run test/vault.test.ts   # the mock vault
pnpm --filter @dno/api exec vitest run test/vaultRelay.test.ts        # the relayer and its routes
pnpm dev                                                    # http://localhost:5173/vault, on the mock
```

The tests put Seaport 1.5's runtime code, read from Sepolia with `eth_getCode`
(`test/fixtures/seaport-1.5.json`, with its conduit controller), at its usual address with
`hardhat_setCode`, and set storage slot 0 to 1, its reentrancy guard (`test/seaport.ts`,
`installSeaport`): the vault is tested against Seaport itself, not a stand-in, and the original
tests still run on 1.5 with open listings (`deployOpenListings`). Two groups run the way the
listings are deployed: "the way OpenSea shows it (mainnet)" puts Seaport 1.6, the
ConduitController and OpenSea's conduit with its storage, read from mainnet with `eth_getCode`
and `eth_getStorageAt` (`test/fixtures/seaport-1.6.json`), at their addresses, and
`mocks/TestZone.sol` at OpenSea's zone's address (`installOpenSea()`; the real zone wants
OpenSea's server's signature): a listing with fees paid to OpenSea's recipient and the creator,
fees kept per listing, a withdrawal cancelling on 1.6, owner-only fees at most 15%, an
OpenSea-style offer (conduit, zone, 1% WETH fee) and a collection offer accepted. "As on
Sepolia" (`installOpenSea(false)`) is 1.6 and the conduit without the zone: an open listing
filled by anyone, a posted offer signed for 1.6. delegate.xyz's registry is put the same way
(`test/fixtures/delegate-registry-v2.json`, no constructor state), and WETH is `TestWETH`.

OpenSea's own offers are replayed against mainnet itself:

```bash
npx hardhat dno:opensea-replay --tx 0xd49327e0f801e4c9ad58c63096f572b9edbbaafbdf9b471dfd097bd4ff97923f
```

OpenSea's offers live off-chain and a fill needs a signature from OpenSea's server (its signed
zone), made for the one address that fills it, so there is no way to make one on a test
network. A fill that already happened carries both the order and the signature in its
calldata: the task forks mainnet with anvil at the block before a real fill a contract made,
puts `VaultOffers`' code at the address OpenSea signed for, hands it the NFT and lets it fill
the very same order through the real Seaport 1.6, zone and conduit. Nothing leaves the machine
(no key, no gas, no deployment). It needs `anvil` (Foundry) on the PATH, or `--rpc` to an anvil
already forked there, and a mainnet RPC with archive state and `debug_traceTransaction`
(`MAINNET_RPC_URL`; `eth.drpc.org`, the default, served both for free on 2026-10-10). Such
fills are Seaport 1.6's `OrderFulfilled` logs with OpenSea's zone, a WETH offer item and a
transaction `to` a contract other than Seaport.
In the mock (`MockVault`) the night shift holds two boxes, one listed on Seaport; a listing of
yours finds a buyer after 20 mock seconds, the night shift offers 0.03 WETH for every NFT you
seal, and it accepts any private sale offered to it. Its pockets: four strangers' and the night
shift's, which buys any box offered to it; opening yours brings an offer of one of its boxes for
5 cUSDC, so paying from a pocket can be played alone.

End to end, on a local node or on Sepolia (`dno:vault-demo`: mints a test NFT, seals it, lists
it, buys it the way any Seaport buyer would, sends the ETH to a fresh address, shows a wrong key
refused, takes a second NFT out to another fresh address, then names a fresh wallet a third
NFT's delegate and sells it by accepting a WETH offer posted to the board; the fresh addresses
are the team's kept test wallets `vault-proceeds`, `vault-withdrawals` and `vault-delegate`):

```bash
pnpm chain                                        # terminal 1, in packages/contracts-evm
pnpm deploy:localhost                             # terminal 2: the game, then the vault
npx hardhat --network localhost dno:vault-demo

npx hardhat deploy --network sepolia --tags Vault # the vault alone, next to a live collection
pnpm export:sepolia                               # writes its `vault` entry in sepolia.json
npx hardhat --network sepolia dno:vault-demo
```

`deploy/vault.ts` (tag `Vault`, run at the end, redeploys nothing else; `pnpm deploy:<net>` runs
it with every other script) takes `VAULT_FEE_BPS`
(250), `STUDIO_TREASURY` (or the owner) for the fee, and `COLLECTION_OWNER` (or the deployer) as
the owner. It deploys `VaultOffers` first, with the network's WETH (`WETH` in `deploy/vault.ts`,
OpenSea's; a `TestWETH` locally), then `VaultListings(seaport, zone, conduitKey, conduit,
owner)` from `listingVenue(network)` in `lib/opensea.ts` (mainnet: Seaport 1.6, OpenSea's
conduit and signed zone; Sepolia: the same Seaport and conduit, no zone; elsewhere Seaport 1.5,
no zone, no conduit), then `SealedVault(listings, cUSDC, offers, registry, treasury, owner,
feeBps)`, which reads its Seaport from `VaultListings`. On a test network it deploys
`VaultTestNFT`; on a local node it first puts Seaport 1.5's and delegate.xyz's
Sepolia code at their addresses. On mainnet it sets `VaultListings`' default fees to OpenSea's 1%
(`0x0000a26b00c1F0DF003000390027140000fAa719`, under collection 0); the owner then sets a
collection's own fees with `setFees` only where OpenSea enforces a creator fee (read from its
collection page or API). Payments
are in the network's cUSDC (Zama's on Sepolia, a test one locally). `dno:export` writes `vault`
(address, ABI, deploy block, Seaport, `listings` with its ABI (null for a vault from before it),
`offers` with its ABI and deploy block, WETH, the registry, the collections the page offers to seal, `pockets`
with its `desk` and its `token` when they are deployed, and `otherPockets`: each other token's
pockets, deploy block and token) for the adapter and the API. `deploy/pockets.ts` (tag `Pockets`, after `Vault`) deploys
`SealedPockets` on the vault's cUSDC and `PocketDesk` on the vault, sets the desk once and hands
the pockets to `COLLECTION_OWNER`, then one `SealedPockets_<symbol>` per token of
`lib/pocketTokens.ts`: `npx hardhat deploy --network sepolia --tags Pockets` adds them next to a
live vault (with `STUDIO_TREASURY` and `COLLECTION_OWNER` set as the live vault's, or the vault's
script redeploys it). Set `VAULT_RELAYER_KEY` on the API, and
fund that address with a little ETH, for the relayer.
