# DO NOT OPEN: the sealed vault

Smart contracts of the sealed vault, built on [Zama's FHEVM](https://docs.zama.ai/protocol): any ERC-721
sits in a box whose holder is encrypted on-chain (the owner can shut a collection out). The NFT can come out to
any address, be sold on Seaport 1.5 with the vault as the seller (a listing, or a buyer's WETH offer
the holder accepts), change hands privately for an encrypted cUSDC price, and lend its rights
(airdrops, token gates) to a wallet through delegate.xyz. Every holder action is asked with the
box's key, never with the holder's address.

| Contract | Role |
| --- | --- |
| `SealedVault` | The vault: a Confidential ERC-721 of its own, one box per NFT, each with an encrypted key; withdrawals, Seaport listings, private sales, delegation |
| `vault/VaultOffers` | The on-chain board buyers post their Seaport offers to; fills the offers the vault accepts |
| `confidential/ConfidentialERC721` | The reusable base: encrypted owners, transfers that never revert on ownership |
| `SealedPockets`, `vault/PocketDesk` | cUSDC held in pockets locked by a key, paying the vault's private sales (when present) |
| `mocks/*` | Local stand-ins for USDC, cUSDC, WETH and test NFTs |

The deployed addresses are in [`DEPLOYMENTS.md`](DEPLOYMENTS.md) and, with their ABIs, in
`addresses/sepolia.json`.

## Run the tests

Node 20 or later.

```bash
npm install
npm run compile
npm test          # on Zama's FHEVM mock, with Seaport 1.5's and delegate.xyz's real bytecode
```

## Deploy

Copy `.env.example` to `.env`, then `npm run deploy:sepolia`. It uses Zama's test USDC and cUSDC,
Seaport 1.5 and delegate.xyz's registry at their Sepolia addresses.

## About this repository

It is published automatically from the project's main repository each time the contracts change
there: commits here are not edited by hand. Questions and reports are welcome as issues.
