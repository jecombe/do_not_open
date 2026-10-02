import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { formatAmount, shortAddress, type Address, type ChainAdapter, type DecryptionAllowance } from "@dno/chain-adapter";
import { useAction, useChain } from "./chain/ChainProvider";
import { stepCopy } from "./chain/copy";
import { useShielded } from "./chain/shielded";
import { useT, type AppKey } from "./i18n/app";
import { LangSwitch } from "./i18n/LangSwitch";
import { openExchange } from "./views/exchangeLink";
import { ProblemNote } from "./views/ProblemNote";

/** Any view may open the wallet slip: balances, decryption credits, the way out. */
const openers = new Set<() => void>();
export function openWallet(): void {
  for (const o of openers) o();
}

export const VIEWS = [
  { key: "shelf", label: "nav.shelf" },
  { key: "warehouse", label: "nav.boxes" },
  { key: "duels", label: "nav.duels" },
  { key: "pair", label: "nav.pair" },
  { key: "pantry", label: "nav.pantry" },
  { key: "exchange", label: "nav.exchange" },
  { key: "leaderboard", label: "nav.leaderboard" },
  { key: "specimens", label: "nav.specimens" },
] as const satisfies readonly { key: string; label: AppKey }[];
/** "box" is one box looked at closely: it sits under "See boxes" in the menu. */
export type View = (typeof VIEWS)[number]["key"] | "box";
const menuKey = (view: View) => (view === "box" ? "warehouse" : view);

/**
 * The stamp on the left; on the right, a small wallet tag and one manila tag
 * naming the current view. The tag opens a packing list with the other views,
 * the manual and the languages; the wallet tag opens a list of the browser's
 * wallets when there is more than one, and once connected, a slip with the
 * balance and a way out.
 */
export function Masthead({ view, onView }: { view: View; onView: (v: View) => void }) {
  const chain = useChain();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [slip, setSlip] = useState(false);
  const menuId = useId();
  const pickerId = useId();
  const slipId = useId();
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const walletButton = useRef<HTMLButtonElement>(null);
  const { picking, closePicker } = chain;

  const closeMenu = useCallback(() => setOpen(false), []);
  const closeSlip = useCallback(() => setSlip(false), []);
  useDismiss(open, root, closeMenu, toggle);
  useDismiss(!!picking, root, closePicker, walletButton);
  useDismiss(slip, root, closeSlip, walletButton);

  useEffect(() => {
    const open = () => {
      setOpen(false);
      closePicker();
      setSlip(true);
    };
    openers.add(open);
    return () => void openers.delete(open);
  }, [closePicker]);

  const current = VIEWS.find((v) => v.key === menuKey(view))!;
  const { account, mode } = chain;
  // A slip left open must not outlive the account it shows.
  useEffect(() => {
    if (!account) setSlip(false);
  }, [account]);

  return (
    <header className="masthead">
      <h1 className="wordmark">Do not open</h1>
      <div className="controls" ref={root}>
        {mode !== "mock" &&
          (account ? (
            <button
              type="button"
              ref={walletButton}
              className="wallet"
              aria-expanded={slip}
              aria-controls={slip ? slipId : undefined}
              onClick={() => {
                setOpen(false);
                setSlip((s) => !s);
              }}
              title={t("nav.walletDetails")}
            >
              {shortAddress(account)}
            </button>
          ) : (
            <button
              type="button"
              ref={walletButton}
              className="wallet"
              aria-expanded={!!picking}
              aria-controls={picking ? pickerId : undefined}
              onClick={() => {
                setOpen(false);
                if (picking) closePicker();
                else void chain.connect();
              }}
              title={t("nav.connect")}
            >
              {t("nav.connectShort")}
            </button>
          ))}
        <button
          type="button"
          ref={toggle}
          className="menu-toggle"
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => {
            closePicker();
            setSlip(false);
            setOpen((o) => !o);
          }}
        >
          {t(current.label)}
          <span className="caret" aria-hidden="true" />
        </button>
        {slip && account && (
          <WalletSlip
            id={slipId}
            account={account}
            onDisconnect={() => {
              setSlip(false);
              void chain.disconnect();
              walletButton.current?.focus();
            }}
          />
        )}
        {picking && (
          <div className="menu" id={pickerId} role="group" aria-label={t("nav.pickWallet")}>
            <p className="menu-title">{t("nav.pickWallet")}</p>
            <ul>
              {picking.map((w) => (
                <li key={w.id}>
                  <button type="button" className="wallet-option" onClick={() => void chain.connect(w.id)}>
                    {w.icon ? <img src={w.icon} alt="" width={22} height={22} /> : <span className="wallet-blank" aria-hidden="true" />}
                    {w.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {open && (
          <nav className="menu" id={menuId} aria-label={t("nav.views")}>
            <ul>
              {VIEWS.map((v) => (
                <li key={v.key}>
                  <button
                    type="button"
                    aria-current={menuKey(view) === v.key ? "page" : undefined}
                    onClick={() => {
                      onView(v.key);
                      setOpen(false);
                    }}
                  >
                    {t(v.label)}
                  </button>
                </li>
              ))}
              <li className="menu-rule">
                <a href="/docs.html">{t("nav.manual")}</a>
              </li>
              <li>
                <a href="/">{t("nav.home")}</a>
              </li>
            </ul>
            <LangSwitch label={t("nav.language")} />
          </nav>
        )}
      </div>
    </header>
  );
}

/** The connected account up close: its full address, what it holds, the way to the bureau de
 *  change to get more, the test faucet, decryption credits, and the way out. */
function WalletSlip({ id, account, onDisconnect }: { id: string; account: Address; onDisconnect: () => void }) {
  const { adapter, collection } = useChain();
  const t = useT();
  const own = useAction();
  const shielded = useShielded(own.busy);
  const [balance, setBalance] = useState<bigint | null | "unread">(null);
  const [usdc, setUsdc] = useState<bigint | null>(null);
  const payment = collection?.payment;
  // Anything but a decryption may have moved money.
  const moving = own.busy === "reveal" ? null : own.busy;

  // Read on every opening, and again after each action taken from here.
  useEffect(() => {
    if (moving) return;
    let live = true;
    adapter.balance(account).then(
      (wei) => live && setBalance(wei),
      () => live && setBalance("unread"),
    );
    if (payment) void adapter.usdcBalance(account).then((b) => live && setUsdc(b), () => live && setUsdc(null));
    return () => {
      live = false;
    };
  }, [adapter, account, payment, moving]);

  const currency = collection?.currency ?? { symbol: "ETH", decimals: 18 };
  const amount = (v: bigint) => (payment ? formatAmount(v, payment.decimals) : "");
  const working = !!own.busy;
  const { known, stale } = shielded;

  return (
    <div className="menu wallet-slip" id={id} role="group" aria-label={t("nav.yourWallet")}>
      <p className="menu-title">{t("nav.yourWallet")}</p>
      <p className="slip-address">{account}</p>
      <p className="slip-balance">
        <span>{currency.symbol}</span>
        <strong aria-live="polite">
          {balance === null ? "…" : balance === "unread" ? t("nav.balanceUnread") : roundAmount(balance, currency.decimals)}
        </strong>
      </p>
      {payment && (
        <>
          <p className="slip-balance">
            <span>{payment.symbol}</span>
            <strong aria-live="polite">{usdc === null ? "…" : amount(usdc)}</strong>
          </p>
          <p className="slip-balance">
            <span>{payment.confidentialSymbol}</span>
            <strong aria-live="polite" className={stale ? "is-stale" : undefined}>
              {known ? amount(known.value) : t("nav.encrypted")}
            </strong>
          </p>
          <div className="slip-section">
            <p className="fine">
              <button type="button" className="link" onClick={() => void own.run("reveal", shielded.reveal)} disabled={working}>
                {known ? t("nav.decryptAgain") : t("nav.decrypt")}
              </button>{" "}
              {stale ? t("nav.decryptStale") : known ? t("nav.decryptKept") : t("nav.decryptHint")}
            </p>

            <p className="slip-heading">{t("nav.getTokens")}</p>
            <div className="slip-exchange">
              {payment.ramp && (
                <button type="button" className="plain-button" onClick={() => openExchange({ from: "eth", to: "cusdc" })} disabled={working}>
                  {t("nav.buyStable", { symbol: payment.symbol })}
                </button>
              )}
              <button type="button" className="plain-button" onClick={() => openExchange({ from: "usdc", to: "cusdc" })} disabled={working}>
                {t("nav.shieldUnshield")}
              </button>
            </div>
            <p className="fine">{t("nav.exchangeHint")}</p>

            {payment.faucet !== null && (
              <p className="fine">
                <button type="button" className="link" onClick={() => void own.run("faucet", (o) => adapter.faucetUsdc(o))} disabled={working}>
                  {t("pay.faucet", { amount: amount(payment.faucet), symbol: payment.symbol })}
                </button>
              </p>
            )}

            <DecryptionCredits id={id} adapter={adapter} own={own} symbol={payment.symbol} decimals={payment.decimals} />

            <div aria-live="polite">
              {own.error ? <ProblemNote problem={own.error} /> : own.busy ? <p className="fine">{stepCopy(own.step, own.busy === "reveal")}</p> : null}
            </div>
          </div>
        </>
      )}
      <ul>
        <li className="menu-rule">
          <button type="button" onClick={onDisconnect}>
            {t("nav.disconnectShort")}
          </button>
        </li>
      </ul>
    </div>
  );
}

/**
 * Where the collection pays Zama for each decryption (mainnet): what the wallet may still
 * decrypt today, and a way to buy more. Nothing shows where nobody counts.
 */
function DecryptionCredits(props: { id: string; adapter: ChainAdapter; own: ReturnType<typeof useAction>; symbol: string; decimals: number }) {
  const { id, adapter, own, symbol, decimals } = props;
  const t = useT();
  const [allowance, setAllowance] = useState<DecryptionAllowance | null>(null);
  const [count, setCount] = useState("100");

  // Again after every action: a decryption or a purchase changes it.
  useEffect(() => {
    if (own.busy) return;
    let live = true;
    adapter.decryptionAllowance().then(
      (a) => live && setAllowance(a),
      () => live && setAllowance(null),
    );
    return () => {
      live = false;
    };
  }, [adapter, own.busy]);

  if (!allowance) return null;
  const n = /^\d{1,7}$/.test(count.trim()) ? Number(count.trim()) : 0;
  const price = allowance.price;
  const buy = () => {
    if (n > 0) void own.run("credits", (o) => adapter.buyCredits(n, o));
  };
  return (
    <>
      <p className="slip-heading">{t("credits.heading")}</p>
      <p className="fine" aria-live="polite">
        {t("credits.left", { free: allowance.freeLeft, perDay: allowance.freePerDay, credits: allowance.credits })}
      </p>
      {price !== null && (
        <>
          <form
            className="find"
            onSubmit={(e) => {
              e.preventDefault();
              buy();
            }}
          >
            <label htmlFor={`${id}-credits`}>{t("credits.label")}</label>
            <input id={`${id}-credits`} inputMode="numeric" autoComplete="off" value={count} onChange={(e) => setCount(e.target.value)} disabled={!!own.busy} />
            <button type="submit" className="plain-button" disabled={!!own.busy || n <= 0}>
              {own.busy === "credits" ? t("credits.buying") : t("credits.go")}
            </button>
          </form>
          {n > 0 && <p className="fine">{t("credits.price", { n, total: formatAmount(price * BigInt(n), decimals), symbol })}</p>}
        </>
      )}
      <p className="fine">{t("credits.why", { input: allowance.inputUnits })}</p>
    </>
  );
}

/** "0.0123" for a balance: four decimals are plenty to see what is left, and never round a dust balance to zero. */
function roundAmount(amount: bigint, decimals: number): string {
  const full = formatAmount(amount, decimals);
  const [whole, frac = ""] = full.split(".");
  if (!frac || frac.length <= 4) return full;
  const kept = frac.slice(0, 4).replace(/0+$/, "");
  if (whole === "0" && !kept) return "< 0.0001";
  return kept ? `${whole}.${kept}` : whole!;
}

/** Closes a pop-over on a click outside `root` or on Escape, which also hands focus back. */
function useDismiss(open: boolean, root: RefObject<HTMLElement | null>, close: () => void, back: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      back.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, root, close, back]);
}
