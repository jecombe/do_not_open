import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { formatAmount, shortAddress, type Address } from "@dno/chain-adapter";
import { useChain } from "./chain/ChainProvider";
import { useT, type AppKey } from "./i18n/app";
import { LangSwitch } from "./i18n/LangSwitch";

export const VIEWS = [
  { key: "shelf", label: "nav.shelf" },
  { key: "warehouse", label: "nav.boxes" },
  { key: "pair", label: "nav.pair" },
  { key: "pantry", label: "nav.pantry" },
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

/** The connected account up close: its full address, what it holds, and the way out. */
function WalletSlip({ id, account, onDisconnect }: { id: string; account: Address; onDisconnect: () => void }) {
  const { adapter, collection } = useChain();
  const t = useT();
  const [balance, setBalance] = useState<bigint | null | "unread">(null);

  // Read on every opening: the balance moves with each paid action.
  useEffect(() => {
    let live = true;
    adapter.balance(account).then(
      (wei) => live && setBalance(wei),
      () => live && setBalance("unread"),
    );
    return () => {
      live = false;
    };
  }, [adapter, account]);

  const currency = collection?.currency ?? { symbol: "ETH", decimals: 18 };
  return (
    <div className="menu wallet-slip" id={id} role="group" aria-label={t("nav.yourWallet")}>
      <p className="menu-title">{t("nav.yourWallet")}</p>
      <p className="slip-address">{account}</p>
      <p className="slip-balance">
        <span>{t("nav.balance")}</span>
        <strong aria-live="polite">
          {balance === null ? "…" : balance === "unread" ? t("nav.balanceUnread") : `${roundAmount(balance, currency.decimals)} ${currency.symbol}`}
        </strong>
      </p>
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
