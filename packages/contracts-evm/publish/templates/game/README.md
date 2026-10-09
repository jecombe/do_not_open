# DO NOT OPEN: the game

Smart contracts of DO NOT OPEN, a confidential NFT collection on [Zama's FHEVM](https://docs.zama.ai/protocol):
10,000 sealed boxes whose cats, owners, balances and sale count are encrypted on-chain.

| Contract | Role |
| --- | --- |
| `DoNotOpen` | The boxes: hidden mint quantity, sale milestones, shake, reveal requests, the duel shelf |
| `DoNotOpenConfig` | The rules and `decode(seed)`, set from `vendor/game-spec/spec.json` at deploy (its keccak256 is stored as `specHash`) |
| `DoNotOpenHooks`, `BoxMetadata` | Hooks around transfers, and the token metadata |
| `confidential/ConfidentialERC721` | The reusable base: encrypted owners, transfers that never revert on ownership |
| `Croq`, `ConfidentialCroq`, `Pantry` | The croquette economy: a fixed-supply ERC-20, its ERC-7984 wrapper, and the pantry that feeds the cats |
| `LiquidityLocker`, `UsdcRamp` | The CROQ/USDC liquidity, locked, and the ETH to USDC/cUSDC ramp |
| `Rats`, `RatPantry`, `RatTricks` | The depot's rats: an encrypted power per rat, their daily CROQ, their tricks on boxes |
| `FleaMarket`, `StudioPacks`, `DecryptionCredits`, `WhitelistGifts` | The players' market, the studio's packs, decryption credits, the whitelist's gifts |
| `mocks/*` | Local stand-ins for USDC, cUSDC, a swap router and test NFTs |

Every reveal is a request on-chain, a public decryption off-chain by Zama's KMS, then a
permissionless `finalize` that checks the KMS signatures. `vendor/game-spec` holds every number of
the game, and `vendor/generator` the TypeScript decoder the tests check the Solidity one against.

The deployed addresses are in [`DEPLOYMENTS.md`](DEPLOYMENTS.md) and, with their ABIs, in
`addresses/sepolia.json`.

## Run the tests

Node 20 or later.

```bash
npm install
npm run compile
npm test          # on Zama's FHEVM mock
REPORT_COSTS=1 npx hardhat test test/Costs.ts   # gas and HCU table
```

## Deploy

Copy `.env.example` to `.env`, then `npm run deploy:sepolia`. `Pantry.fund` uses FHE, so a local
deploy needs a node (`npx hardhat node --no-deploy`, then `npx hardhat deploy --network localhost`),
not the in-process network.

## About this repository

It is published automatically from the project's main repository each time the contracts change
there: commits here are not edited by hand. Questions and reports are welcome as issues.
