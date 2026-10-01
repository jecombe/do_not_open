import { useEffect, useState } from "react";
import { formatAmount } from "@dno/chain-adapter";
import { useAction, useChain } from "../chain/ChainProvider";
import { stepCopy } from "../chain/copy";
import { setPayment, usePayment } from "../chain/payment";
import { useT } from "../i18n/app";
import { parseAmount } from "./PantryView";

interface Props {
  /** The parent's running action: balances are read again once it is over. */
  busy: string | null;
  /** What the next action costs, in USDC units: the shortfall is offered from it. */
  need: bigint;
  /** Only the USDC / cUSDC switch, with a link that unfolds the rest. */
  compact?: boolean;
}

/**
 * Picks how paid actions are paid: plain USDC, or cUSDC whose balance only its holder can read.
 * Below it, the ways to get what is missing: test USDC from the faucet, USDC bought with the
 * chain's coin through the site's ramp (for a small fee), and USDC shielded as cUSDC (free).
 */
export function PayWith({ busy, need, compact = false }: Props) {
  const { adapter, account, collection } = useChain();
  const t = useT();
  const pay = usePayment();
  const own = useAction();
  const [usdc, setUsdc] = useState<bigint | null>(null);
  // Encrypted: read only when asked, since it costs a signature.
  const [hidden, setHidden] = useState<bigint | null>(null);
  const [open, setOpen] = useState(false);
  const [shieldText, setShieldText] = useState("");
  const [buyText, setBuyText] = useState("");
  const [buyShielded, setBuyShielded] = useState(pay === "cusdc");
  const [quote, setQuote] = useState<{ usdcOut: bigint; fee: bigint } | null>(null);
  const payment = collection?.payment;
  const coin = collection?.currency;
  const working = busy ?? own.busy;
  // Anything but a reveal may have moved money.
  const moving = busy ?? (own.busy === "reveal" ? null : own.busy);

  useEffect(() => {
    if (!account || moving) return;
    let live = true;
    void adapter.usdcBalance(account).then((b) => live && setUsdc(b)).catch(() => live && setUsdc(null));
    // A payment or a shield changed it: hide it again rather than show a stale figure.
    setHidden(null);
    return () => {
      live = false;
    };
  }, [adapter, account, moving]);

  useEffect(() => setBuyShielded(pay === "cusdc"), [pay]);

  const coinIn = coin ? parseAmount(buyText, coin.decimals) : null;
  const hasRamp = !!payment?.ramp;
  useEffect(() => {
    setQuote(null);
    if (!coinIn || !hasRamp) return;
    let live = true;
    const timer = setTimeout(() => void adapter.quoteUsdc(coinIn).then((q) => live && setQuote(q), () => undefined), 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [adapter, coinIn, hasRamp]);

  if (!payment || !account || !coin) return null;
  const amount = (v: bigint) => formatAmount(v, payment.decimals);
  const shortOfUsdc = usdc !== null && usdc < need;
  // Shield what the next action costs, unless the user typed something else.
  const shieldAmount = shieldText ? parseAmount(shieldText, payment.decimals) : need;
  const shieldTooMuch = !!shieldAmount && usdc !== null && shieldAmount > usdc;
  const unfolded = !compact || open || (pay === "usdc" && shortOfUsdc);

  const shield = async () => {
    if (!shieldAmount || shieldTooMuch) return;
    if ((await own.run("shield", (o) => adapter.shieldUsdc(shieldAmount, o))) === undefined) return;
    setShieldText("");
  };
  const buy = async () => {
    if (!coinIn) return;
    if ((await own.run("buy", (o) => adapter.buyUsdc(coinIn, buyShielded, o))) === undefined) return;
    setBuyText("");
  };

  return (
    <div className={compact ? "pay-with is-compact" : "pay-with"}>
      <div className="picker" role="group" aria-label={t("pay.label")}>
        <button type="button" aria-pressed={pay === "usdc"} onClick={() => setPayment("usdc")} disabled={!!working}>
          {payment.symbol}
        </button>
        <button type="button" aria-pressed={pay === "cusdc"} onClick={() => setPayment("cusdc")} disabled={!!working}>
          {payment.confidentialSymbol}
        </button>
        {compact && (
          <button type="button" className="link" onClick={() => setOpen((o) => !o)} aria-expanded={unfolded}>
            {t("pay.topUp")}
          </button>
        )}
      </div>
      {unfolded && (
        <>
          <p className="fine">
            {t("pay.balances", { usdc: usdc === null ? "…" : amount(usdc), symbol: payment.symbol, cSymbol: payment.confidentialSymbol })}{" "}
            {hidden === null ? (
              <button type="button" className="link" onClick={() => void own.run("reveal", (o) => adapter.confidentialUsdcBalance(o)).then((v) => v !== undefined && setHidden(v))} disabled={!!working}>
                {t("pay.reveal")}
              </button>
            ) : (
              <strong>{amount(hidden)}</strong>
            )}
          </p>
          <p className="fine">{pay === "cusdc" ? t("pay.cusdcHint", { cSymbol: payment.confidentialSymbol }) : t("pay.usdcHint", { cSymbol: payment.confidentialSymbol })}</p>

          {pay === "usdc" && shortOfUsdc && <p className="fine problem">{t("pay.short", { need: amount(need), symbol: payment.symbol })}</p>}

          {/* A cUSDC balance cannot be checked without a signature: offer to shield what the next action costs. */}
          {pay === "cusdc" && (
            <>
              <form
                className="find pantry-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void shield();
                }}
              >
                <label htmlFor="shield-amount">{t("pay.shieldLabel", { symbol: payment.symbol, cSymbol: payment.confidentialSymbol })}</label>
                <input id="shield-amount" inputMode="decimal" autoComplete="off" value={shieldText} onChange={(e) => setShieldText(e.target.value)} placeholder={amount(need)} disabled={!!working} />
                <button type="submit" className="plain-button" disabled={!!working || !shieldAmount || shieldTooMuch}>
                  {own.busy === "shield" ? t("pay.shielding") : t("pay.shieldGo")}
                </button>
              </form>
              <p className="fine">{shieldTooMuch ? t("pay.short", { need: amount(shieldAmount!), symbol: payment.symbol }) : t("pay.shieldFree")}</p>
            </>
          )}

          {payment.ramp && (
            <>
              <form
                className="find pantry-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void buy();
                }}
              >
                <label htmlFor="buy-usdc">{t("pay.buyLabel", { coin: coin.symbol, symbol: buyShielded ? payment.confidentialSymbol : payment.symbol })}</label>
                <input id="buy-usdc" inputMode="decimal" autoComplete="off" value={buyText} onChange={(e) => setBuyText(e.target.value)} placeholder="0.01" disabled={!!working} />
                <button type="submit" className="plain-button" disabled={!!working || !coinIn}>
                  {own.busy === "buy" ? t("pay.buying") : t("pay.buyGo")}
                </button>
              </form>
              <p className="fine">
                <label>
                  <input type="checkbox" checked={buyShielded} onChange={(e) => setBuyShielded(e.target.checked)} disabled={!!working} />{" "}
                  {t("pay.buyShielded", { cSymbol: payment.confidentialSymbol })}
                </label>
              </p>
              <p className="fine">
                {quote
                  ? t("pay.buyQuote", {
                      out: amount(quote.usdcOut),
                      symbol: buyShielded ? payment.confidentialSymbol : payment.symbol,
                      fee: formatAmount(quote.fee, coin.decimals),
                      coin: coin.symbol,
                      pct: payment.ramp.feeBps / 100,
                    })
                  : t("pay.buyHint", { pct: payment.ramp.feeBps / 100, coin: coin.symbol })}
              </p>
            </>
          )}

          {payment.faucet !== null && (
            <p className="fine">
              <button type="button" className="link" onClick={() => void own.run("faucet", (o) => adapter.faucetUsdc(o))} disabled={!!working}>
                {t("pay.faucet", { amount: amount(payment.faucet), symbol: payment.symbol })}
              </button>
            </p>
          )}
          {own.error ? <p className="fine problem">{own.error}</p> : own.busy ? <p className="fine">{stepCopy(own.step, own.busy === "reveal")}</p> : null}
        </>
      )}
    </div>
  );
}
