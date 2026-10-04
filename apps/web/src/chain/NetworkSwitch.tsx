import { useT } from "../i18n/app";
import { chosenNetwork, switchNetwork } from "./mode";

/**
 * Two rows of tags under the languages: the chain family (Ethereum only, Solana waits for Zama's
 * SVM support) and the network (Testnet only, Mainnet stays disabled until it is deployed).
 * Picking Testnet from the demo reloads the page on Sepolia.
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
        <button
          type="button"
          aria-pressed={current === "sepolia"}
          title={t("nav.testnetTitle")}
          onClick={() => current !== "sepolia" && switchNetwork("sepolia")}
        >
          {t("nav.testnet")}
        </button>
        <button type="button" disabled title={t("nav.mainnetTitle")} aria-label={t("nav.mainnetTitle")}>
          {t("nav.mainnet")}
        </button>
      </div>
    </div>
  );
}
