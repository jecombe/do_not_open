import { useT } from "../i18n/app";
import { chosenNetwork, switchNetwork } from "./mode";

const NETWORKS = [
  { key: "sepolia", label: "nav.testnet", title: "nav.testnetTitle" },
  { key: "mainnet", label: "nav.mainnet", title: "nav.mainnetTitle" },
] as const;

/**
 * Two rows of tags under the languages: the chain family (Ethereum only, Solana waits for Zama's
 * SVM support) and the network. Picking a network reloads the page on it.
 */
export function NetworkSwitch() {
  const t = useT();
  const current = chosenNetwork();
  return (
    <div className="net" role="group" aria-label={t("nav.network")}>
      <div className="lang" role="group" aria-label={t("nav.chainFamily")}>
        <button type="button" aria-pressed="true">
          ETH
        </button>
        <button type="button" disabled title={t("nav.solanaSoon")} aria-label={t("nav.solanaSoon")}>
          SOL
        </button>
      </div>
      <div className="lang" role="group" aria-label={t("nav.network")}>
        {NETWORKS.map((n) => (
          <button
            type="button"
            key={n.key}
            aria-pressed={current === n.key}
            title={t(n.title)}
            onClick={() => current !== n.key && switchNetwork(n.key)}
          >
            {t(n.label)}
          </button>
        ))}
      </div>
    </div>
  );
}
