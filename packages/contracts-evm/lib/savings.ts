/**
 * Zama's confidential vault batchers the pockets' savings use, per network: the deposit batcher
 * (cUSDC in, the vault's confidential shares out) and the redeem batcher (the way back) of one
 * Morpho vault. From https://docs.zama.org/protocol/confidential-vault/reference/addresses.
 * On a local network the deploy stands up test batchers instead.
 */
export const SAVINGS_BATCHERS: Record<string, { vault: string; depositBatcher: string; redeemBatcher: string }> = {
  sepolia: {
    // Steakhouse USDC Prime.
    vault: "steakhouse-usdc-prime",
    depositBatcher: "0xF66Fc55060DF981449Fa746e8F58bD003370bE28",
    redeemBatcher: "0x9f3cF93246cBf333C6BE65fb7277724eC0c38543",
  },
  mainnet: {
    vault: "steakhouse-usdc-prime",
    depositBatcher: "0x321C9AaB1390100f6e7fE1735a928ec0F16252f0",
    redeemBatcher: "0x807C367dA7B9228643b06390e199E33ccA7Cc533",
  },
};

/** The test batchers' rates: 1 USDC gives 0.98 share, 1 share gives 1.02 USDC. */
export const TEST_DEPOSIT_RATE = 980_000n;
export const TEST_REDEEM_RATE = 1_020_000n;
/** The test vault's price per share, in USDC units per 1e18 shares. */
export const TEST_SHARE_PRICE = 1_020_000n;
