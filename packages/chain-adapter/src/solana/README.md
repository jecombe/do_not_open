# Solana adapter (not started)

This folder is a placeholder. It will hold `SolanaAdapter`, a third implementation of the
`ChainAdapter` interface in `../types.ts`, next to `MockAdapter` and `EvmFhevmAdapter`.

Nothing above this package needs to change for it: the web app, the generator and the
scene only ever see `ChainAdapter`. The interface was written with that port in mind:

- Accounts are opaque strings (`Address`), not EVM addresses.
- Amounts are `bigint` in the chain's smallest unit, with the symbol and decimals reported
  by `collection()`.
- Every action reports the same four steps (`wallet`, `confirming`, `decrypting`,
  `proving`), whatever the chain does underneath.
- Errors are `ChainError` with chain-neutral codes; `reason` carries the program's own
  error name.
- Trait picks are reported as indexes into `spec.traits`, never as bit offsets.

What is missing is on Zama's side: a confidential-computation SDK for Solana. The porting
plan, account layout and open questions are in `docs/` (Phase 5).
