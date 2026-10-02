import { useChain } from "../chain/ChainProvider";
import { gasFaucet, type Problem } from "../chain/copy";
import { useT } from "../i18n/app";
import { openWallet } from "../Masthead";
import { openExchange } from "./exchangeLink";

/** Why an action failed, what to try, and a way to get what was missing. */
export function ProblemNote({ problem }: { problem: Problem }) {
  const { collection } = useChain();
  const t = useT();
  const faucet = problem.fix === "gas" ? gasFaucet(collection) : null;
  return (
    <div className="problem-note" role="alert">
      <p className="fine problem">{problem.text}</p>
      {problem.hints.length > 0 && (
        <ul className="fine problem-hints">
          {problem.hints.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}
      {(problem.fix === "wallet" || problem.fix === "exchange" || faucet || problem.txUrl) && (
        <p className="fine problem-ways">
          {problem.fix === "wallet" && (
            <button type="button" className="link" onClick={openWallet}>
              {t("problem.openWallet")}
            </button>
          )}
          {problem.fix === "exchange" && (
            <button type="button" className="link" onClick={() => openExchange(problem.wanted === "usdc" ? { from: "eth", to: "usdc" } : { from: "usdc", to: "cusdc" })}>
              {t("problem.openExchange")}
            </button>
          )}
          {faucet && (
            <a className="link" href={faucet} target="_blank" rel="noreferrer">
              {t("problem.gasFaucet", { coin: collection?.currency.symbol ?? "ETH" })}
            </a>
          )}
          {problem.txUrl && (
            <a className="link" href={problem.txUrl} target="_blank" rel="noreferrer">
              {t("problem.seeTx")}
            </a>
          )}
        </p>
      )}
    </div>
  );
}
