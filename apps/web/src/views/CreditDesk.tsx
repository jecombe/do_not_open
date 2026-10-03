import { useEffect, useId, useState } from "react";
import { formatAmount, type DecryptionAllowance } from "@dno/chain-adapter";
import { useAction, useChain, useLedger } from "../chain/ChainProvider";
import { useT } from "../i18n/app";
import { ProblemNote } from "./ProblemNote";
import { TxPending } from "./TxPending";

const PRESETS = [50, 100, 500];

/**
 * The bureau's other window: decryption credits are no holding, they are spent to read sealed
 * values, so they sit beside the ledger rather than in it. Bought in plain USDC only; when the
 * wallet is short, it points back to the counter to get some.
 */
export function CreditDesk(props: { usdc: bigint | null; onGetUsdc: (() => void) | null; onDone: () => void; disabled: boolean }) {
  const { usdc, onGetUsdc, onDone, disabled } = props;
  const { adapter, account, collection } = useChain();
  const t = useT();
  const id = useId();
  const own = useAction();
  const ledger = useLedger();
  const [allowance, setAllowance] = useState<DecryptionAllowance | null>(null);
  const [count, setCount] = useState("100");

  useEffect(() => {
    if (!account || own.busy) return;
    let live = true;
    adapter.decryptionAllowance().then(
      (a) => live && setAllowance(a),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [adapter, account, own.busy, ledger]);

  const payment = collection?.payment;
  if (!account || !payment || !allowance || allowance.price === null) return null;
  const { symbol, decimals } = payment;
  const n = /^\d{1,7}$/.test(count.trim()) ? Number(count.trim()) : 0;
  const total = allowance.price * BigInt(n);
  const short = n > 0 && usdc !== null && usdc < total;
  const buy = async () => {
    if (n <= 0 || short) return;
    await own.run("credits", (o) => adapter.buyCredits(n, o));
    onDone();
  };

  return (
    <aside className="credit-desk" aria-labelledby={`${id}-title`}>
      <h3 className="credit-desk-title" id={`${id}-title`}>
        {t("ex.credits.title")}
      </h3>
      <p className="credit-desk-left">
        <strong>{allowance.freeLeft + allowance.credits}</strong> {t("ex.credits.left", { free: allowance.freeLeft, perDay: allowance.freePerDay, credits: allowance.credits })}
      </p>
      <TxPending busy={own.busy} step={own.step} title={t("credits.buying")}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void buy();
          }}
        >
          <div className="credit-desk-presets" role="group" aria-label={t("credits.label")}>
            {PRESETS.map((p) => (
              <button type="button" key={p} aria-pressed={n === p} onClick={() => setCount(String(p))} disabled={disabled}>
                {p}
              </button>
            ))}
            <input id={`${id}-n`} inputMode="numeric" autoComplete="off" value={count} onChange={(e) => setCount(e.target.value)} disabled={disabled} aria-label={t("credits.label")} />
          </div>
          <p className="credit-desk-price">
            {n > 0 ? t("ex.credits.price", { n: n.toLocaleString("en-US"), total: formatAmount(total, decimals), symbol }) : t("ex.credits.pick")}
          </p>
          <p className="fine">
            {t("ex.credits.have", { amount: usdc === null ? "…" : formatAmount(usdc, decimals), symbol })}
          </p>
          {short && (
            <p className="fine problem">
              {t("ex.credits.short", { symbol })}{" "}
              {onGetUsdc && (
                <button type="button" className="link" onClick={onGetUsdc} disabled={disabled}>
                  {t("ex.credits.getUsdc", { symbol })}
                </button>
              )}
            </p>
          )}
          <button type="submit" className="plain-button credit-desk-go" disabled={disabled || n <= 0 || short}>
            {t("credits.go")}
          </button>
        </form>
        <div aria-live="polite">{own.error && <ProblemNote problem={own.error} />}</div>
        <p className="fine">{t("ex.credits.why", { symbol })}</p>
      </TxPending>
    </aside>
  );
}
