import { memo, useEffect, useMemo, useRef } from "react";
import { PrivyProvider, useLogin, usePrivy, useWallets, type PrivyClientConfig } from "@privy-io/react-auth";
import { ChainError, type ExternalWallet } from "@dno/chain-adapter";

type PrivyChain = NonNullable<PrivyClientConfig["defaultChain"]>;

/**
 * Signs the user in with Privy (e-mail, a social account, or any wallet) and hands the
 * resulting account to the chain adapter. Loaded only when a Privy app id is set.
 */
export default memo(function PrivyBridge({ appId, wallet }: { appId: string; wallet: ExternalWallet }) {
  const params = wallet.chain!;
  const config = useMemo<PrivyClientConfig>(() => {
    const chain: PrivyChain = {
      id: params.chainId,
      name: params.name,
      nativeCurrency: params.currency,
      rpcUrls: { default: { http: [params.rpcUrl] } },
      blockExplorers: params.explorerUrl ? { default: { name: "Explorer", url: params.explorerUrl } } : undefined,
      testnet: true,
    };
    return {
      defaultChain: chain,
      supportedChains: [chain],
      // Whoever comes in without a wallet gets one made for them.
      embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
      appearance: { theme: "dark", accentColor: "#e0b23c" },
    };
  }, [params]);
  return (
    <PrivyProvider appId={appId} config={config}>
      <Bridge wallet={wallet} chainId={params.chainId} />
    </PrivyProvider>
  );
});

function Bridge({ wallet, chainId }: { wallet: ExternalWallet; chainId: number }) {
  const { ready, authenticated, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { login } = useLogin({
    onError: () => wallet.fail(new ChainError("rejected", "The sign-in was closed.")),
  });

  // Privy's functions change identity between renders: bind once, call the latest.
  const latest = useRef({ login, logout });
  latest.current = { login, logout };
  useEffect(() => {
    if (ready) wallet.bind({ login: () => latest.current.login(), logout: () => latest.current.logout() });
  }, [ready, wallet]);

  // The wallet connected last comes first. A fresh embedded wallet shows up a moment
  // after sign-in, and this runs again then.
  const active = authenticated ? wallets[0] : undefined;
  useEffect(() => {
    if (!ready || !walletsReady) return;
    if (!authenticated) {
      void wallet.use(null);
      return;
    }
    if (!active) return;
    let live = true;
    (async () => {
      await active.switchChain(chainId);
      const ethereum = await active.getEthereumProvider();
      if (live) await wallet.use(ethereum, active.address);
    })().catch((error) => {
      console.error("[chain] could not use the signed-in wallet", error);
      wallet.fail(new ChainError("wrong-network", "Switch your wallet to Sepolia to continue."));
    });
    return () => {
      live = false;
    };
  }, [ready, walletsReady, authenticated, active, chainId, wallet]);

  return null;
}
