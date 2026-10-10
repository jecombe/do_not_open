/**
 * Where the sealed vault's liquidity positions live: Uniswap V3 on each network, and the pools
 * the deploy opens between the pockets' tokens when nobody has yet. On Sepolia those are Zama's
 * test ERC-20s (the ones cUSDC, cUSDT, cWETH and cZAMA wrap), free to mint, so the deploy seeds
 * each pool with a full-range position of its own: a market that trades, at a made-up price.
 */

export interface UniswapV3Deployment {
  factory: string;
  positionManager: string;
  swapRouter: string;
}

/** Uniswap V3 on Sepolia, from Uniswap's deployment list (the router is SwapRouter02). Local networks deploy Uniswap's own bytecode. */
export const POSITIONS_UNISWAP: Record<string, UniswapV3Deployment> = {
  sepolia: {
    factory: "0x0227628f3F023bb0B980b67D528571c95c6DaC1c",
    positionManager: "0x1238536071E1c677A632429e3655c799b22cDA52",
    swapRouter: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
  },
};

export interface PositionPoolPlan {
  /** The underlying ERC-20s' symbols, as the pockets' tokens wrap them. */
  base: string;
  quote: string;
  /** Uniswap's fee tier, in hundredths of a bip: 3000 is 0.3%. */
  fee: number;
  /** Whole `quote` per whole `base`, where the pool opens. */
  price: number;
  /** Whole tokens of each the deploy puts in, full range. */
  seedBase: number;
  seedQuote: number;
}

/** The pools to open per network, by the ERC-20s' symbols. Zama's mocks mint at most 1,000,000 a call. */
export const POSITION_POOLS: Record<string, PositionPoolPlan[]> = {
  sepolia: [
    { base: "WETH", quote: "USDC", fee: 3000, price: 2500, seedBase: 400, seedQuote: 1_000_000 },
    { base: "ZAMA", quote: "USDC", fee: 10000, price: 0.05, seedBase: 1_000_000, seedQuote: 50_000 },
    { base: "USDT", quote: "USDC", fee: 500, price: 1, seedBase: 500_000, seedQuote: 500_000 },
  ],
  localhost: [{ base: "WETH", quote: "USDC", fee: 3000, price: 2500, seedBase: 400, seedQuote: 1_000_000 }],
  hardhat: [{ base: "WETH", quote: "USDC", fee: 3000, price: 2500, seedBase: 400, seedQuote: 1_000_000 }],
};

/** 5% of the trading fees positions collect, unless POSITIONS_FEE_BPS says otherwise (10% at most). */
export const positionsFeeBps = () => Number(process.env.POSITIONS_FEE_BPS ?? 500);
