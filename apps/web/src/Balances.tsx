import { useEffect, useState } from "react";
import { formatAmount, type Address, type ChainAdapter } from "@dno/chain-adapter";
import { useAction, useChain, useLedger } from "./chain/ChainProvider";
import { useLive } from "./chain/useLive";
import { useSealed, type SealedToken } from "./chain/shielded";
import { useT } from "./i18n/app";
import { Delta, Figure, Flash, useLiveValue } from "./LiveValue";
import { TokenIcon, tokenSvg } from "./brand/logos";


interface Plain {
  coin: bigint | null;
  usdc: bigint | null;
  croq: bigint | null;
  /** Null while unknown; false where the croquettes are not deployed. */
  croqSymbols: { symbol: string; confidentialSymbol: string } | null | false;
}

/**
 * A strip of frosted glass across the masthead with everything the game is played with: the
 * chain's coin, USDC and cUSDC to pay, CROQ and cCROQ to feed. Public balances read themselves;
 * a sealed one shows a lock until it is decrypted, for the player's eyes only, with one signature.
 */
export function Balances() {
  const { adapter, account, collection } = useChain();
  const t = useT();
  const ledger = useLedger();
  const [plain, setPlain] = useState<Plain>({ coin: null, usdc: null, croq: null, croqSymbols: null });
  const payment = collection?.payment;

  // Public balances: after every action, every block or so, and on coming back to the tab.
  useLive(
    (live) => {
      if (account) void readPlain(adapter, account, !!payment).then((p) => live() && setPlain(p));
    },
    [adapter, account, payment, ledger],
    !!account,
  );

  // A new account starts blank rather than showing the last one's figures.
  useEffect(() => setPlain({ coin: null, usdc: null, croq: null, croqSymbols: null }), [account]);

  if (!account || !collection) return null;
  const currency = collection.currency;
  const croq = plain.croqSymbols;

  return (
    <div className="balances" data-tour="balances" role="group" aria-label={t("balances.label")}>
      <Chip symbol={currency.symbol} value={plain.coin} decimals={currency.decimals} />
      {payment && (
        <>
          <Chip symbol={payment.symbol} value={plain.usdc} decimals={payment.decimals} />
          <SealedChip token="cusdc" symbol={payment.confidentialSymbol} decimals={payment.decimals} watch={ledger} />
        </>
      )}
      {croq && (
        <>
          <Chip symbol={croq.symbol} value={plain.croq} decimals={CROQ_DECIMALS} />
          <SealedChip token="ccroq" symbol={croq.confidentialSymbol} decimals={CROQ_DECIMALS} watch={ledger} />
        </>
      )}
    </div>
  );
}

/** Croquettes are counted whole, plain or sealed. */
const CROQ_DECIMALS = 0;

async function readPlain(adapter: ChainAdapter, account: Address, paid: boolean): Promise<Plain> {
  const soft = <T,>(p: Promise<T>) => p.catch(() => null);
  const [coin, usdc, economy] = await Promise.all([soft(adapter.balance(account)), paid ? soft(adapter.usdcBalance(account)) : null, soft(adapter.economy())]);
  const croq = economy ? await soft(adapter.croqBalance(account)) : null;
  return { coin, usdc, croq, croqSymbols: economy ? { symbol: economy.symbol, confidentialSymbol: economy.confidentialSymbol } : false };
}

/** A public balance. When it moves, the figure rolls to the new one and says by how much. */
function Chip({ symbol, value, decimals }: { symbol: string; value: bigint | null; decimals: number }) {
  const { shown, change } = useLiveValue(value);
  const format = (v: bigint) => roundAmount(v, decimals);
  return (
    <span className="balance">
      <Flash change={change} />
      <span className="balance-symbol">
        <TokenIcon symbol={symbol} size={14} />
        {symbol}
        <Delta change={change} format={format} />
      </span>
      <strong className="balance-value">
        <Figure change={change}>{shown === null ? "…" : format(shown)}</Figure>
      </strong>
      <span className="visually-hidden" aria-live="polite">
        {value === null ? "" : `${symbol} ${format(value)}`}
      </span>
    </span>
  );
}

/** A sealed balance: the lock until it is decrypted, then the figure, dimmed once it moved. A click decrypts. */
function SealedChip({ token, symbol, decimals, watch }: { token: SealedToken; symbol: string; decimals: number; watch: number }) {
  const t = useT();
  const own = useAction();
  const { known, stale, reveal } = useSealed(token, watch);
  const { shown, change } = useLiveValue(known ? known.value : null);
  const format = (v: bigint) => roundAmount(v, decimals);
  const busy = !!own.busy;
  const title = busy ? t("balances.decrypting") : known ? (stale ? t("nav.decryptStale") : t("nav.decryptKept")) : t("balances.reveal", { symbol });

  return (
    <button type="button" className={`balance sealed${stale ? " is-stale" : ""}${known ? "" : " is-locked"}`} onClick={() => void own.run("reveal", reveal)} disabled={busy} title={title} aria-label={`${symbol}: ${known ? roundAmount(known.value, decimals) : t("nav.encrypted")}. ${title}`}>
      <Flash change={change} />
      <span className="balance-symbol">
        {tokenSvg(symbol) ? <TokenIcon symbol={symbol} size={14} /> : <Lock open={!!known} />}
        {symbol}
        <Delta change={change} format={format} />
      </span>
      <strong className="balance-value" aria-live="polite">
        {busy ? "…" : shown !== null ? <Figure change={change}>{format(shown)}</Figure> : "••••"}
      </strong>
    </button>
  );
}

export function Lock({ open }: { open: boolean }) {
  return (
    <svg className="balance-lock" viewBox="0 0 12 14" width="10" height="12" aria-hidden="true">
      <path d={open ? "M3.5 6V4a2.5 2.5 0 0 1 4.9-.7" : "M3.5 6V4a2.5 2.5 0 0 1 5 0v2"} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <rect x="1.5" y="6" width="9" height="7" rx="1" fill="currentColor" />
    </svg>
  );
}

/** "0.0123" for a balance: four decimals are plenty to see what is left, and never round a dust balance to zero. */
export function roundAmount(amount: bigint, decimals: number): string {
  const full = formatAmount(amount, decimals);
  const [whole, frac = ""] = full.split(".");
  if (!frac || frac.length <= 4) return full;
  const kept = frac.slice(0, 4).replace(/0+$/, "");
  if (whole === "0" && !kept) return "< 0.0001";
  return kept ? `${whole}.${kept}` : whole!;
}
