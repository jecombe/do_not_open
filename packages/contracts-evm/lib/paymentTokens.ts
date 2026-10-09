/** USDC and its confidential ERC-7984 wrapper, per network. From Zama's list of testnet tokens. */
export const PAYMENT_TOKENS: Record<string, { usdc: string; cUsdc: string }> = {
  sepolia: {
    usdc: "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF",
    cUsdc: "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639",
  },
};
