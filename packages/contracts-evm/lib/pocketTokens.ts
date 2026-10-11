/**
 * Zama's other confidential tokens the vault's pockets hold, per network, next to the cUSDC
 * pockets (the only ones with a desk, as the vault's private sales settle in cUSDC). Each gets its
 * own SealedPockets, deployed as `SealedPockets_<symbol>`. From Zama's Confidential Token Wrappers
 * Registry (0x2f0750Bbb0A246059d80e94c454586a7F27a128e on Sepolia), all ERC-7984 wrappers with
 * 6 decimals whose test ERC-20s anyone may mint.
 */
export const POCKET_TOKENS: Record<string, { symbol: string; token: string }[]> = {
  sepolia: [
    { symbol: "cUSDT", token: "0x4E7B06D78965594eB5EF5414c357ca21E1554491" },
    { symbol: "cWETH", token: "0x46208622DA27d91db4f0393733C8BA082ed83158" },
    { symbol: "cZAMA", token: "0xf2D628d2598aF4eAF94CB76a437Ff86CA78FfbFB" },
  ],
};

/** The deployment name of a token's pockets. */
export const pocketsDeployment = (symbol: string) => `SealedPockets_${symbol}`;

/**
 * A group's size: the most pockets one side of an action names, the real one included
 * (`SealedPockets.MAX_SET`, fixed at deployment). A pocket hides among its group, so larger hides
 * better and costs more, about 0.7M HCU a pocket a side on a send (`REPORT_COSTS=1 pnpm test
 * test/SealedPockets.ts` prints the table). `POCKETS_MAX_SET` overrides it at deploy time.
 */
export const POCKETS_MAX_SET = Number(process.env.POCKETS_MAX_SET || 5);
