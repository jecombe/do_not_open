import { useEffect, useState } from "react";
import { formatAmount } from "@dno/chain-adapter";
import { useChain } from "../chain/ChainProvider";
import { setPayment, usePayment } from "../chain/payment";
import { useShielded } from "../chain/shielded";
import { useT } from "../i18n/app";
import { openExchange } from "./exchangeLink";

interface Props {
  /** The parent's running action: balances are read again once it is over. */
  busy: string | null;
  /** What the next action costs, in USDC units. */
  need: bigint;
  /** Only the USDC / cUSDC switch, the balance and the link to the wallet. */
  compact?: boolean;
}

/**
 * Picks how paid actions are paid: plain USDC, or cUSDC whose balance only its holder can read.
 * Shows what the chosen token holds, and sends to the bureau de change to buy or shield more.
 * The cUSDC balance is the one last decrypted there, if the user ever did.
 */
export function PayWith({ busy, need, compact = false }: Props) {
  const { adapter, account, collection } = useChain();
  const t = useT();
  const pay = usePayment();
  const { known, stale } = useShielded(busy);
  const [usdc, setUsdc] = useState<bigint | null>(null);
  const payment = collection?.payment;

  useEffect(() => {
    if (!account || busy) return;
    let live = true;
    void adapter.usdcBalance(account).then((b) => live && setUsdc(b)).catch(() => live && setUsdc(null));
    return () => {
      live = false;
    };
  }, [adapter, account, busy]);

  if (!payment || !account) return null;
  const amount = (v: bigint) => formatAmount(v, payment.decimals);
  const cSymbol = payment.confidentialSymbol;
  const held = pay === "usdc" ? usdc : known && !stale ? known.value : null;
  const short = held !== null && held < need;

  return (
    <div className={compact ? "pay-with is-compact" : "pay-with"}>
      <div className="picker" role="group" aria-label={t("pay.label")}>
        <button type="button" aria-pressed={pay === "usdc"} onClick={() => setPayment("usdc")} disabled={!!busy}>
          {payment.symbol}
        </button>
        <button type="button" aria-pressed={pay === "cusdc"} onClick={() => setPayment("cusdc")} disabled={!!busy}>
          {cSymbol}
        </button>
      </div>
      <p className="fine">
        {pay === "usdc"
          ? t("pay.held", { amount: usdc === null ? "…" : amount(usdc), symbol: payment.symbol })
          : !known
            ? t("pay.heldHidden", { cSymbol })
            : stale
              ? t("pay.heldStale", { amount: amount(known.value), cSymbol })
              : t("pay.held", { amount: amount(known.value), symbol: cSymbol })}{" "}
        <button type="button" className="link" onClick={() => openExchange({ from: pay === "usdc" ? "eth" : "usdc", to: pay })}>
          {t("pay.getTokens")}
        </button>
      </p>
      {short && <p className="fine problem">{t("pay.short", { need: amount(need), symbol: pay === "usdc" ? payment.symbol : cSymbol })}</p>}
      {!compact && <p className="fine">{pay === "cusdc" ? t("pay.cusdcHint", { cSymbol }) : t("pay.usdcHint", { cSymbol })}</p>}
    </div>
  );
}
