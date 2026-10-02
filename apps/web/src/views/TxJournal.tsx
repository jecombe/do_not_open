import type { LoggedTx } from "../chain/txLog";
import { useT, type AppKey } from "../i18n/app";

/** The contract calls a pair can see, worded for people. */
const CALLS: Record<string, AppKey> = {
  postDuel: "tx.postDuel",
  acceptDuel: "tx.acceptDuel",
  cancelDuel: "tx.cancelDuel",
  finalizeDuel: "tx.finalizeDuel",
  proposeEntangle: "tx.proposeEntangle",
  acceptEntangle: "tx.acceptEntangle",
  observe: "tx.observe",
  finalize: "tx.finalize",
};

const shortHash = (hash: string) => `${hash.slice(0, 8)}…${hash.slice(-6)}`;

/**
 * Every transaction sent about this pair from this browser: what it did, where it is,
 * the block and gas once mined, and a link to the explorer.
 */
export function TxJournal({ txs, locale }: { txs: LoggedTx[]; locale: string }) {
  const t = useT();
  if (!txs.length) return null;
  const time = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" });
  const number = new Intl.NumberFormat(locale);

  return (
    <details className="tx-journal" open>
      <summary>{t("tx.title", { count: txs.length })}</summary>
      <ol>
        {txs.map((tx) => {
          const call = CALLS[tx.call];
          return (
            <li key={tx.hash} className={`tx-${tx.status}`}>
              <div className="tx-line">
                <strong>{call ? t(call) : tx.call}</strong>
                <span className="tx-status">
                  {tx.status === "sent" ? t("tx.sent") : tx.status === "failed" ? t("tx.failed") : t("tx.confirmed", { block: number.format(tx.block ?? 0) })}
                </span>
              </div>
              <div className="tx-line fine">
                {tx.url ? (
                  <a className="link tx-hash" href={tx.url} target="_blank" rel="noreferrer" title={tx.hash}>
                    {shortHash(tx.hash)}
                  </a>
                ) : (
                  <code className="tx-hash" title={tx.hash}>
                    {shortHash(tx.hash)}
                  </code>
                )}
                {tx.gas && <span>{t("tx.gas", { gas: number.format(Number(tx.gas)) })}</span>}
                <span className="tx-time">{time.format(tx.at)}</span>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="fine">{t("tx.note")}</p>
    </details>
  );
}
