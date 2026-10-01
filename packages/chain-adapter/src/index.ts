import { MockAdapter, type MockOptions } from "./mock/MockAdapter";
import type { ChainAdapter } from "./types";

export * from "./types";
export { traitIndexAtOffset } from "./layout";
export { MockAdapter, mockSeedForToken, mockWeighIn, MOCK_YOU, MOCK_NIGHT_SHIFT, type MockOptions } from "./mock/MockAdapter";

export type ChainMode = "mock" | "sepolia";

export interface AdapterConfig {
  mode: ChainMode;
  /** sepolia: read endpoint, and an optional contract address override. */
  rpcUrl?: string;
  address?: string;
  mock?: MockOptions;
}

/**
 * The app's single entry point. The EVM adapter, ethers and the Relayer SDK sit behind a
 * dynamic import, so mock mode never downloads them.
 */
export async function createAdapter(config: AdapterConfig): Promise<ChainAdapter> {
  if (config.mode === "sepolia") {
    const { createSepoliaBrowserAdapter } = await import("./evm/browser");
    return createSepoliaBrowserAdapter({ rpcUrl: config.rpcUrl, address: config.address });
  }
  return new MockAdapter(config.mock);
}
