# DO NOT OPEN, documentation

| Document | What it answers |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Which package does what, what depends on what, how data moves, how a seed becomes a picture |
| [DATA_MODEL.md](DATA_MODEL.md) | What is encrypted and what is public for each token, who may decrypt what, what a transfer changes |
| [FLOWS.md](FLOWS.md) | Sequence diagrams for every mechanic: mint, shake, feed, alive check, open, entangle, duel, and the croquette flows |
| [CROQ.md](CROQ.md) | The croquette economy: CROQ and cCROQ, supply, welcome bag, purr, meals and the daily cap, weight and weigh-in, builds and sickness, the public market, what leaks |
| [SOLANA_PORTING.md](SOLANA_PORTING.md) | Every EVM or FHEVM-specific point, where it lives, and what it becomes on Solana |
| [AUDIT_CHECKLIST.md](AUDIT_CHECKLIST.md) | What an auditor should check, what was checked here, and the findings still open |
| [DESIGN.md](DESIGN.md) | Art direction, mood board, effect catalogue, performance budget |
| [ZAMA_NOTES.md](ZAMA_NOTES.md) | Verified FHEVM versions, where the protocol differs from the original brief, deployment addresses |
| [../assets/BLENDER_TODO.md](../assets/BLENDER_TODO.md) | Assets that need modelling, with their specs |

Package-level detail lives next to the code:
[`game-spec`](../packages/game-spec/README.md) (seed layout, odds, rarity formula),
[`contracts-evm`](../packages/contracts-evm/README.md) (contracts, cost per function, deploy, CLI),
[`chain-adapter`](../packages/chain-adapter/README.md) (the interface and its implementations).

All diagrams are Mermaid and render on GitHub.
