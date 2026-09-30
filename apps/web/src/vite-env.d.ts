/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "mock" (default) or "sepolia". */
  readonly VITE_CHAIN_MODE?: string;
  /** Read endpoint for Sepolia. Must allow cross-origin requests. */
  readonly VITE_SEPOLIA_RPC_URL?: string;
  /** Overrides the committed DoNotOpen address. */
  readonly VITE_DNO_ADDRESS?: string;
}
