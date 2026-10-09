import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { DEFAULT_POCKET_DECOYS, formatAmount, shortAddress, type ActionOptions, type Address, type PocketSale, type PocketsAdapter, type VaultBox } from "@dno/chain-adapter";
import { useAction, useChain } from "../chain/ChainProvider";
import { useT } from "./i18n";
import { TokenIcon } from "../brand/logos";

/** What the vault page runs an action with: the stage, the steps, the transactions. */
type Act = <T>(name: string, run: (opts: ActionOptions) => Promise<T>, message?: (r: T) => string) => Promise<T | undefined>;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** cUSDC's decimals. */
const DECIMALS = 6;

/** A pocket's code as people pass it around: P-12. */
export const pocketCode = (id: number) => `P-${id}`;

/** The pocket number in a code someone typed: "P-12", "p12", "#12" or "12". */
export function parsePocketCode(value: string): number | null {
  const m = /^\s*(?:p\s*-?\s*|#)?(\d{1,9})\s*$/i.exec(value);
  return m ? Number(m[1]) : null;
}

function parseUnits(value: string, decimals: number): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m || (m[2]?.length ?? 0) > decimals) return null;
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || "0");
}

/**
 * The wallet's pocket: tokens held under a key, not an address. Finding it takes one signature
 * (none in the demo); then its code, its balance (decrypted for this page only), putting cUSDC
 * in from the wallet, sending it to another pocket, taking it out to any address, and the boxes
 * sellers offered it in a private sale.
 */
export function PocketTab({
  pockets,
  account,
  act,
  busy,
  demo,
  boxes,
  labelOf,
  onOpenBox,
  onPocket,
}: {
  pockets: PocketsAdapter;
  account: Address;
  act: Act;
  busy: boolean;
  demo: boolean;
  boxes: VaultBox[];
  labelOf: (b: VaultBox) => string;
  onOpenBox: (boxId: number) => void;
  /** The page reads the pocket's boxes again once the pocket is known, or after a purchase. */
  onPocket: () => void;
}) {
  const t = useT();
  const own = useAction();
  const { adapter, collection } = useChain();
  /** undefined: not looked for yet (a signature away); null: none opened. */
  const [id, setId] = useState<number | null | undefined>(undefined);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [sales, setSales] = useState<PocketSale[]>([]);
  const [prices, setPrices] = useState<Record<number, bigint>>({});
  const [decoys, setDecoys] = useState(DEFAULT_POCKET_DECOYS);
  const [maxDecoys, setMaxDecoys] = useState(4);
  const [copied, setCopied] = useState(false);

  const find = useCallback(
    async (opts?: ActionOptions) => {
      const mine = await pockets.mine(opts);
      setId(mine);
      const info = await pockets.info();
      setMaxDecoys(Math.max(0, Math.min(info.maxSet - 1, info.count - 1)));
      if (mine !== null) {
        setSales(await pockets.sales());
        onPocket();
      }
      return mine;
    },
    [pockets, onPocket],
  );

  // A new account starts locked; the demo has nothing to sign, so it looks at once.
  useEffect(() => {
    setId(undefined);
    setBalance(null);
    setSales([]);
    setPrices({});
    if (demo) void find().catch(() => undefined);
  }, [account, demo, find]);

  /** After an action: the balance and the offered sales again, the balance only if it was shown. */
  const after = async () => {
    const mine = await find().catch(() => id ?? null);
    if (mine !== null && balance !== null) setBalance(await pockets.balance().catch(() => null));
  };

  const run = async <T,>(name: string, task: (o: ActionOptions) => Promise<T>, message?: (r: T) => string) => {
    const r = await act(name, task, message);
    await after();
    return r;
  };

  if (id === undefined) {
    return (
      <PocketShell>
        <Intro title={t("vault.pocket.unlock.title")} body={t("vault.pocket.unlock.body")}>
          <button type="button" className="sec-btn sec-btn-small" disabled={busy || !!own.busy} onClick={() => void own.run("pocket", (o) => find(o))}>
            {own.busy ? "…" : t("vault.pocket.unlock")}
          </button>
          {own.error && <p className="vault-error">{own.error.text}</p>}
        </Intro>
      </PocketShell>
    );
  }

  if (id === null) {
    return (
      <PocketShell>
        <Intro title={t("vault.pocket.none.title")} body={t("vault.pocket.none.body")}>
          <button type="button" className="sec-btn sec-btn-small" disabled={busy} onClick={() => void run("pocketOpen", (o) => pockets.open(o), (n) => t("vault.done.pocketOpen", { id: pocketCode(n) }))}>
            {t("vault.pocket.open")}
          </button>
        </Intro>
      </PocketShell>
    );
  }

  const code = pocketCode(id);
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const payment = collection?.payment;

  return (
    <PocketShell>
      <div className="vault-pocket-card">
        <PouchMark />
        <div className="vault-pocket-id">
          <p className="vault-pocket-label">{t("vault.pocket.code")}</p>
          <p className="vault-pocket-code">
            <strong>{code}</strong>
            <button type="button" className="sec-btn sec-btn-ghost sec-btn-small" onClick={copy}>
              {copied ? t("vault.pocket.copied") : t("vault.pocket.copy")}
            </button>
          </p>
          <p className="vault-meta">{t("vault.pocket.codeHint")}</p>
        </div>
        <div className="vault-pocket-balance">
          <p className="vault-pocket-label">{t("vault.pocket.balance")}</p>
          <button
            type="button"
            className={`vault-balance vault-balance-sealed${balance === null ? " is-locked" : ""}`}
            disabled={!!own.busy || busy}
            onClick={() => void own.run("reveal", async (o) => setBalance(await pockets.balance(o)))}
            title={t("vault.pocket.reveal")}
          >
            <span className="vault-balance-symbol">
              <TokenIcon symbol="cUSDC" size={14} />
              cUSDC
            </span>
            <strong className="vault-balance-value" aria-live="polite">
              {own.busy === "reveal" ? "…" : balance === null ? "••••" : formatAmount(balance, DECIMALS)}
            </strong>
          </button>
          <p className="vault-meta">{balance === null ? t("vault.pocket.reveal") : t("vault.pocket.balanceHint")}</p>
        </div>
      </div>

      <div className="vault-pocket-forms">
        <AmountForm
          title={t("vault.pocket.deposit")}
          hint={t("vault.pocket.depositHint")}
          busy={busy}
          extra={(shield, setShield) =>
            payment && (
              <>
                <label className="vault-check">
                  <input type="checkbox" checked={shield} onChange={(e) => setShield(e.target.checked)} />
                  <span>{t("vault.pocket.shieldFirst")}</span>
                </label>
                {payment.faucet !== null && (
                  <button type="button" className="sec-link" disabled={busy} onClick={() => void run("faucet", (o) => adapter.faucetUsdc(o))}>
                    {t("vault.pocket.faucet")}
                  </button>
                )}
              </>
            )
          }
          onSubmit={(amount, shield) =>
            void run(
              "pocketDeposit",
              async (o) => {
                if (shield) await adapter.shieldUsdc(amount, o);
                await pockets.deposit(amount, { ...o, decoys });
              },
              () => t("vault.done.pocketDeposit"),
            )
          }
        />
        <AmountForm
          title={t("vault.pocket.send")}
          hint={t("vault.pocket.sendHint")}
          busy={busy}
          target={{ label: t("vault.pocket.sendTo"), placeholder: "P-0", parse: (v) => parsePocketCode(v), bad: t("vault.pocket.badCode") }}
          onSubmit={(amount, _shield, to) =>
            void run("pocketSend", (o) => pockets.send(to as number, amount, { ...o, decoys }), () => t("vault.done.pocketSend", { id: pocketCode(to as number) }))
          }
        />
        <AmountForm
          title={t("vault.pocket.withdraw")}
          hint={t("vault.pocket.withdrawHint")}
          busy={busy}
          target={{ label: t("vault.form.to"), placeholder: "0x…", initial: account, parse: (v) => (ADDRESS.test(v.trim()) ? v.trim() : null), bad: t("vault.form.bad") }}
          onSubmit={(amount, _shield, to) =>
            void run(
              "pocketWithdraw",
              (o) => pockets.withdraw(to as Address, amount, { ...o, decoys }),
              () => t("vault.done.pocketWithdraw", { address: shortAddress(to as Address) }),
            )
          }
        />
      </div>

      <div className="vault-decoys vault-pocket-decoys">
        <span className="vault-decoys-label" id="pocket-decoys">
          {t("vault.pocket.decoys")}
        </span>
        <div role="radiogroup" aria-labelledby="pocket-decoys">
          {Array.from({ length: maxDecoys + 1 }, (_, n) => (
            <button key={n} type="button" role="radio" aria-checked={decoys === n} className={decoys === n ? "on" : undefined} disabled={busy} onClick={() => setDecoys(n)}>
              {n}
            </button>
          ))}
        </div>
        <p className="vault-meta">{t("vault.pocket.decoysHint", { n: Math.min(decoys, maxDecoys) })}</p>
      </div>

      <section className="vault-pocket-sales">
        <div className="vault-toolbar">
          <h3>{t("vault.pocket.sales.title")}</h3>
          {sales.some((s) => s.status === "open") && (
            <button
              type="button"
              className="sec-btn sec-btn-ghost sec-btn-small"
              disabled={busy || !!own.busy}
              onClick={() => void own.run("prices", async (o) => setPrices(await pockets.salePrices(sales.map((s) => s.saleId), o)))}
            >
              {t("vault.pocket.sales.read")}
            </button>
          )}
        </div>
        {sales.length === 0 ? (
          <p className="vault-meta">{t("vault.pocket.sales.empty")}</p>
        ) : (
          <ul className="vault-sales">
            {sales.map((s) => {
              const b = boxes.find((x) => x.boxId === s.boxId);
              return (
                <li key={s.saleId}>
                  {b && (
                    <button type="button" className="vault-sale-art" onClick={() => onOpenBox(b.boxId)} aria-label={labelOf(b)}>
                      <span className="vault-sale-box">#{b.boxId}</span>
                    </button>
                  )}
                  <span className="vault-sale-what">{b ? labelOf(b) : t("vault.sales.toYou", { box: s.boxId })}</span>
                  <span className="vault-chip">{t(`vault.sale.${s.status}`)}</span>
                  <span className="vault-price">{prices[s.saleId] !== undefined ? t("vault.sales.price", { price: formatAmount(prices[s.saleId]!, DECIMALS) }) : "••••"}</span>
                  {s.status === "open" && (
                    <button
                      type="button"
                      className="sec-btn sec-btn-small"
                      disabled={busy}
                      onClick={() => void run("pocketBuy", (o) => pockets.buy(s.saleId, o), (moved) => (moved ? t("vault.done.pocketBuy") : t("vault.done.pocketBuyMissed")))}
                    >
                      {t("vault.pocket.buy")}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <p className="vault-meta vault-pocket-public">{t("vault.pocket.public")}</p>
    </PocketShell>
  );
}

function PocketShell({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <section className="vault-pocket">
      <p className="vault-meta vault-pocket-lede">{t("vault.pocket.lede")}</p>
      {children}
    </section>
  );
}

function Intro({ title, body, children }: { title: string; body: string; children: ReactNode }) {
  return (
    <div className="vault-pocket-intro">
      <PouchMark />
      <h3>{title}</h3>
      <p className="vault-meta">{body}</p>
      {children}
    </div>
  );
}

/** A small taped pouch, sealed with the house's red stamp. */
function PouchMark() {
  return (
    <svg className="vault-pouch" viewBox="0 0 64 64" aria-hidden="true">
      <path d="M14 24 Q12 52 32 56 Q52 52 50 24 Z" fill="#c99a63" stroke="#07090c" strokeWidth="2" />
      <path d="M18 24 Q32 14 46 24" fill="none" stroke="#07090c" strokeWidth="2" />
      <rect x="12" y="20" width="40" height="7" rx="3" fill="#e8d3a2" stroke="#07090c" strokeWidth="1.5" />
      <circle cx="32" cy="40" r="7" fill="#ff4d3d" />
      <text x="32" y="43" textAnchor="middle" fontSize="7" fontWeight="700" fill="#07090c">
        $
      </text>
    </svg>
  );
}

/** An amount, with a pocket code or an address when the action goes somewhere. */
function AmountForm({
  title,
  hint,
  busy,
  target,
  extra,
  onSubmit,
}: {
  title: string;
  hint: string;
  busy: boolean;
  target?: { label: string; placeholder: string; initial?: string; parse: (v: string) => number | string | null; bad: string };
  extra?: (shield: boolean, setShield: (v: boolean) => void) => ReactNode;
  onSubmit: (amount: bigint, shield: boolean, to?: number | string) => void;
}) {
  const t = useT();
  const [amount, setAmount] = useState("5");
  const [to, setTo] = useState(target?.initial ?? "");
  const [shield, setShield] = useState(false);
  const [bad, setBad] = useState<string | null>(null);
  return (
    <form
      className="vault-form vault-pocket-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        const units = parseUnits(amount, DECIMALS);
        const where = target ? target.parse(to) : undefined;
        if (!units) return setBad(t("vault.form.bad"));
        if (target && where === null) return setBad(target.bad);
        setBad(null);
        onSubmit(units, shield, where ?? undefined);
      }}
    >
      <h4>{title}</h4>
      {target && (
        <label>
          {target.label}
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder={target.placeholder} spellCheck={false} autoComplete="off" />
        </label>
      )}
      <label>
        {t("vault.pocket.amount")}
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
      </label>
      {extra?.(shield, setShield)}
      <p className={bad ? "vault-hint vault-hint-bad" : "vault-hint"}>{bad ?? hint}</p>
      <button type="submit" className="sec-btn sec-btn-small" disabled={busy}>
        {title}
      </button>
    </form>
  );
}
