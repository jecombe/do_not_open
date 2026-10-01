/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "mock" (default) or "sepolia". */
  readonly VITE_CHAIN_MODE?: string;
  /** Comma-separated host names that run the mock whatever VITE_CHAIN_MODE says. */
  readonly VITE_MOCK_HOSTS?: string;
  /** Read endpoint for Sepolia. Must allow cross-origin requests. */
  readonly VITE_SEPOLIA_RPC_URL?: string;
  /** Overrides the committed DoNotOpen address. */
  readonly VITE_DNO_ADDRESS?: string;
  /** The DO NOT OPEN API (apps/api). Reads go there first; the RPC answers when it lags or is away. */
  readonly VITE_API_URL?: string;
}
