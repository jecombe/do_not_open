/**
 * Where the vault's listings go on each network. On mainnet, the way OpenSea shows a contract's
 * listing (as the TokenWorks NFT strategies list theirs, read on 2026-10-10): Seaport 1.6,
 * OpenSea's conduit and its signed zone, and OpenSea's fee, read from opensea-js and seaport-js
 * `constants.ts`. Sepolia has the same Seaport 1.6, conduit (its channel open to 1.6) and zone
 * (checked on-chain on 2026-10-10), but OpenSea closed its testnets: nothing signs for the zone
 * there, so Sepolia's listings are the mainnet ones without it, open orders anyone can fill.
 * Local networks: Seaport 1.5, no zone, no conduit.
 */
export type ListingVenue = { seaport: string; zone: string; conduitKey: string; conduit: string };

export const SEAPORT_1_5 = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC";
export const SEAPORT_1_6 = "0x0000000000000068F116a894984e2DB1123eB395";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = `0x${"0".repeat(64)}`;

export const OPENSEA = {
  zone: "0x000056F7000000EcE9003ca63978907a00FFD100",
  conduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
  conduit: "0x1E0049783F008A0085193E00003D00cd54003c71",
  feeRecipient: "0x0000a26b00c1F0DF003000390027140000fAa719",
  /** OpenSea's own fee on a sale, as its listings on mainnet pay it (1%). */
  feeBps: 100,
} as const;

export const LISTING_VENUES: Record<string, ListingVenue> = {
  mainnet: { seaport: SEAPORT_1_6, zone: OPENSEA.zone, conduitKey: OPENSEA.conduitKey, conduit: OPENSEA.conduit },
  sepolia: { seaport: SEAPORT_1_6, zone: ZERO_ADDRESS, conduitKey: OPENSEA.conduitKey, conduit: OPENSEA.conduit },
};

/** Seaport 1.5 with an open order: local networks (`pnpm chain`), from Sepolia's code. */
export const OPEN_VENUE: ListingVenue = { seaport: SEAPORT_1_5, zone: ZERO_ADDRESS, conduitKey: ZERO_HASH, conduit: ZERO_ADDRESS };

export const listingVenue = (network: string) => LISTING_VENUES[network] ?? OPEN_VENUE;
