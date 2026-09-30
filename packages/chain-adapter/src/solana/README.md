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

What is missing is on Zama's side: a confidential-computation SDK for Solana (on the
roadmap for H2 2026, nothing published as of 2026-09-30). The porting map, the account
layout, the member-by-member plan for this adapter and the open questions are in
[`docs/SOLANA_PORTING.md`](../../../../docs/SOLANA_PORTING.md).
