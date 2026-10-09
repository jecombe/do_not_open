import { useEffect, useRef, useState } from "react";
import { shortAddress, type Address, type VaultAdapter, type VaultLinks } from "@dno/chain-adapter";
import { Lock, roundAmount } from "../Balances";
import { TokenIcon, tokenSvg } from "../brand/logos";
import { useAction, useChain, useLedger } from "../chain/ChainProvider";
import { useSealed } from "../chain/shielded";
import { useLive } from "../chain/useLive";
import { Delta, Figure, Flash, useLiveValue } from "../LiveValue";
import { useT } from "./i18n";

interface Plain {
  eth: bigint | null;
  weth: bigint | null;
  usdc: bigint | null;
}
const BLANK: Plain = { eth: null, weth: null, usdc: null };

/**
 * What the vault is paid with, read live: ETH (Seaport purchases, gas), WETH (offers), USDC and
 * the sealed cUSDC (private sales). Public balances read themselves after every action, every
 * block or so and on coming back to the tab; cUSDC shows a lock until its holder decrypts it.
 */
export function VaultBalances({ vault, coin, className }: { vault: VaultAdapter; coin: string; className?: string }) {
  const t = useT();
  const { adapter, account, collection } = useChain();
  const ledger = useLedger();
  const [plain, setPlain] = useState<Plain>(BLANK);
  const payment = collection?.payment;

  useLive(
    (live) => {
      if (!account) return;
      const soft = <T,>(p: Promise<T>) => p.catch(() => null);
      void Promise.all([soft(adapter.balance(account)), soft(vault.wethBalance(account)), payment ? soft(adapter.usdcBalance(account)) : null]).then(
        ([eth, weth, usdc]) => live() && setPlain({ eth, weth, usdc }),
      );
    },
    [adapter, vault, account, payment, ledger],
    !!account,
  );
  // A new account starts blank rather than showing the last one's figures.
  useEffect(() => setPlain(BLANK), [account]);

  if (!account) return null;
  return (
    <div className={`vault-balances${className ? ` ${className}` : ""}`} role="group" aria-label={t("vault.balances.label")}>
      <Chip symbol={coin} value={plain.eth} decimals={18} />
      <Chip symbol="WETH" value={plain.weth} decimals={18} />
      {payment && (
        <>
          <Chip symbol={payment.symbol} value={plain.usdc} decimals={payment.decimals} />
          <SealedChip symbol={payment.confidentialSymbol} decimals={payment.decimals} watch={ledger} />
        </>
      )}
    </div>
  );
}

/** A public balance: when it moves, the figure rolls to the new one and says by how much. */
function Chip({ symbol, value, decimals }: { symbol: string; value: bigint | null; decimals: number }) {
  const { shown, change } = useLiveValue(value);
  const format = (v: bigint) => roundAmount(v, decimals);
  return (
    <span className="vault-balance">
      <Flash change={change} />
      <span className="vault-balance-symbol">
        <TokenIcon symbol={symbol} size={14} />
        {symbol}
        <Delta change={change} format={format} />
      </span>
      <strong className="vault-balance-value">
        <Figure change={change}>{shown === null ? "…" : format(shown)}</Figure>
      </strong>
      <span className="vault-sr" aria-live="polite">
        {value === null ? "" : `${symbol} ${format(value)}`}
      </span>
    </span>
  );
}

/** The sealed cUSDC: the lock until it is decrypted (one signature), then the figure, dimmed once it moved. */
function SealedChip({ symbol, decimals, watch }: { symbol: string; decimals: number; watch: number }) {
  const t = useT();
  const own = useAction();
  const { known, stale, reveal } = useSealed("cusdc", watch);
  const { shown, change } = useLiveValue(known ? known.value : null);
  const format = (v: bigint) => roundAmount(v, decimals);
  const busy = own.busy === "reveal";
  const title = busy ? t("vault.balances.decrypting") : known ? t(stale ? "vault.balances.stale" : "vault.balances.kept") : t("vault.balances.reveal", { symbol });

  return (
    <button
      type="button"
      className={`vault-balance vault-balance-sealed${stale ? " is-stale" : ""}${known ? "" : " is-locked"}`}
      onClick={() => void own.run("reveal", reveal)}
      disabled={!!own.busy}
      title={title}
      aria-label={`${symbol}: ${known ? format(known.value) : t("vault.item.encrypted")}. ${title}`}
    >
      <Flash change={change} />
      <span className="vault-balance-symbol">
        {tokenSvg(symbol) ? <TokenIcon symbol={symbol} size={14} /> : <Lock open={!!known} />}
        {symbol}
        <Delta change={change} format={format} />
      </span>
      <strong className="vault-balance-value" aria-live="polite">
        {busy ? "…" : shown !== null ? <Figure change={change}>{format(shown)}</Figure> : "••••"}
      </strong>
    </button>
  );
}

/**
 * The connected wallet: its address in the header; a click opens its profile, with the full
 * address (copy, explorer), its balances, its boxes, and a way to switch wallets or disconnect.
 */
export function VaultProfile({
  account,
  vault,
  coin,
  links,
  boxes,
  onBoxes,
}: {
  account: Address;
  vault: VaultAdapter;
  coin: string;
  links: VaultLinks;
  /** The boxes the page found in the wallet's receipts, null until it looked. */
  boxes: number | null;
  onBoxes: () => void;
}) {
  const t = useT();
  const { disconnect, switchWallet } = useChain();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const explorer = links.address(account);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const copy = () => {
    void navigator.clipboard?.writeText(account).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="vault-profile-wrap" ref={root}>
      <button type="button" className="vault-me" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)} title={account}>
        {shortAddress(account)}
        <span className="vault-me-caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="vault-profile" role="dialog" aria-label={t("vault.profile.title")}>
          <p className="vault-profile-kicker">{t("vault.profile.title")}</p>
          <div className="vault-profile-id">
            <span className="vault-profile-dot" aria-hidden="true" />
            <code className="vault-profile-address">{account}</code>
          </div>
          <div className="vault-profile-row">
            <button type="button" className="sec-btn sec-btn-ghost sec-btn-small" onClick={copy}>
              {copied ? t("vault.profile.copied") : t("vault.profile.copy")}
            </button>
            {explorer && (
              <a className="sec-btn sec-btn-ghost sec-btn-small" href={explorer} target="_blank" rel="noreferrer">
                {t("vault.link.explorer")}&nbsp;↗
              </a>
            )}
          </div>

          <p className="vault-profile-kicker">{t("vault.balances.label")}</p>
          <VaultBalances vault={vault} coin={coin} className="vault-balances-stack" />
          <p className="vault-meta">{t("vault.profile.hint")}</p>

          <button
            type="button"
            className="vault-profile-boxes"
            onClick={() => {
              setOpen(false);
              onBoxes();
            }}
          >
            <span>{t("vault.profile.boxes")}</span>
            <strong>{boxes === null ? t("vault.profile.boxesUnknown") : boxes}</strong>
          </button>

          <div className="vault-profile-row vault-profile-foot">
            <button
              type="button"
              className="sec-btn sec-btn-ghost sec-btn-small"
              onClick={() => {
                setOpen(false);
                void switchWallet();
              }}
            >
              {t("vault.profile.switch")}
            </button>
            <button
              type="button"
              className="sec-btn sec-btn-small vault-disconnect"
              onClick={() => {
                setOpen(false);
                void disconnect();
              }}
            >
              {t("vault.profile.disconnect")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
