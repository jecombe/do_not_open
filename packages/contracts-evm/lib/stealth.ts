/**
 * The stealth address contracts the pockets' exits use, per network: ERC-5564's announcer (every
 * stealth payment is published through it, so the recipient's page finds it) and ERC-6538's
 * registry (where a wallet publishes its stealth meta-address). Both are deployed once for
 * everyone, at the same addresses on Ethereum, Sepolia and most other chains (checked on-chain
 * on 2026-10-11). On a local network the deploy stands up test ones.
 */
export const STEALTH: Record<string, { announcer: string; registry: string }> = {
  sepolia: { announcer: "0x55649E01B5Df198D18D95b5cc5051630cfD45564", registry: "0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538" },
  mainnet: { announcer: "0x55649E01B5Df198D18D95b5cc5051630cfD45564", registry: "0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538" },
};
