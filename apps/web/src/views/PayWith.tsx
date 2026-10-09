import { useEffect, useState } from "react";
import { formatAmount } from "@dno/chain-adapter";
import { useChain } from "../chain/ChainProvider";
import { setPayment, usePayment } from "../chain/payment";
import { useShielded } from "../chain/shielded";
import { useT } from "../i18n/app";
import { openExchange } from "./exchangeLink";
import { TokenIcon } from "../brand/logos";

interface Props {
  /** The parent's running action: balances are read again once it is over. */
  busy: string | null;
  /** What the next action costs, in USDC units. */
  need: bigint;
}

/** The plain balance of the connected account, read again once the parent's action is over. */
function usePlainUsdc(busy: string | null): bigint | null {
  const { adapter, account } = useChain();
  const [usdc, setUsdc] = useState<bigint | null>(null);
  useEffect(() => {
    if (!account || busy) return;
    let live = true;
    void adapter.usdcBalance(account).then((b) => live && setUsdc(b)).catch(() => live && setUsdc(null));
    return () => {
      live = false;
    };
  }, [adapter, account, busy]);
  return usdc;
}

/**
 * Picks how paid actions are paid: plain USDC, or cUSDC whose balance only its holder can read.
 * Shows what the chosen token holds, and sends to the bureau de change to buy or shield more.
 * The cUSDC balance is the one last decrypted there, if the user ever did.
 */
export function PayWith({ busy, need }: Props) {
  const { account, collection } = useChain();
  const t = useT();
  const pay = usePayment();
  const { known, stale } = useShielded(busy);
  const usdc = usePlainUsdc(busy);
  const payment = collection?.payment;

  if (!payment || !account) return null;
  const amount = (v: bigint) => formatAmount(v, payment.decimals);
  const cSymbol = payment.confidentialSymbol;
  const held = pay === "usdc" ? usdc : known && !stale ? known.value : null;
  const short = held !== null && held < need;

  return (
    <div className="pay-with">
      <div className="picker" role="group" aria-label={t("pay.label")}>
        <button type="button" className="with-logo" aria-pressed={pay === "usdc"} onClick={() => setPayment("usdc")} disabled={!!busy}>
          <TokenIcon symbol={payment.symbol} />
          {payment.symbol}
        </button>
        <button type="button" className="with-logo" aria-pressed={pay === "cusdc"} onClick={() => setPayment("cusdc")} disabled={!!busy}>
          <TokenIcon symbol={cSymbol} />
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
      <p className="fine">{pay === "cusdc" ? t("pay.cusdcHint", { cSymbol }) : t("pay.usdcHint", { cSymbol })}</p>
    </div>
  );
}

/**
 * One quiet line under a box's actions, whose buttons carry their own price: what pays, what it
 * holds, and a way to change it. The other token only comes up when this one falls short.
 */
export function PayLine({ busy, need }: Props) {
  const { account, collection } = useChain();
  const t = useT();
  const pay = usePayment();
  const { known, stale } = useShielded(busy);
  const usdc = usePlainUsdc(busy);
  const [changing, setChanging] = useState(false);
  const payment = collection?.payment;

  if (!payment || !account) return null;
  const amount = (v: bigint) => formatAmount(v, payment.decimals);
  const symbol = (p: typeof pay) => (p === "usdc" ? payment.symbol : payment.confidentialSymbol);
  const sealed = known && !stale ? known.value : null;
  const heldBy = (p: typeof pay) => (p === "usdc" ? usdc : sealed);
  const other = pay === "usdc" ? "cusdc" : "usdc";
  const held = heldBy(pay);
  const short = need > 0n && held !== null && held < need;
  const otherHeld = heldBy(other);
  const otherCovers = otherHeld !== null && otherHeld >= need;

  return (
    <div className="pay-line">
      <p className="fine">
        {t("pay.paidIn", { symbol: symbol(pay) })} ·{" "}
        {held !== null ? t("pay.balance", { amount: amount(held) }) : pay === "cusdc" ? t("pay.balanceSealed") : "…"} ·{" "}
        <button type="button" className="link" onClick={() => setChanging((c) => !c)} disabled={!!busy} aria-expanded={changing}>
          {t("pay.change")}
        </button>
      </p>
      {changing && (
        <div className="picker" role="group" aria-label={t("pay.label")}>
          {(["cusdc", "usdc"] as const).map((p) => (
            <button
              type="button"
              key={p}
              aria-pressed={pay === p}
              onClick={() => {
                setPayment(p);
                setChanging(false);
              }}
              disabled={!!busy}
              className="with-logo"
            >
              <TokenIcon symbol={symbol(p)} />
              {symbol(p)}
            </button>
          ))}
        </div>
      )}
      {changing && <p className="fine">{pay === "cusdc" ? t("pay.cusdcHint", { cSymbol: payment.confidentialSymbol }) : t("pay.usdcHint", { cSymbol: payment.confidentialSymbol })}</p>}
      {short && (
        <p className="fine problem">
          {t("pay.short", { need: amount(need), symbol: symbol(pay) })}{" "}
          {otherCovers ? (
            <button type="button" className="link" onClick={() => setPayment(other)} disabled={!!busy}>
              {t(other === "usdc" ? "pay.switchToUsdc" : "pay.switchToCusdc", { symbol: symbol(other) })}
            </button>
          ) : (
            <button type="button" className="link" onClick={() => openExchange({ from: pay === "usdc" ? "eth" : "usdc", to: pay })}>
              {t("pay.getTokens")} →
            </button>
          )}
        </p>
      )}
    </div>
  );
}
