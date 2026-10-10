import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { formatAmount, shortAddress, type ActionOptions, type Address, type PocketGroup, type PocketSale, type PocketToken, type VaultAdapter, type VaultBox } from "@dno/chain-adapter";
import { useAction } from "../chain/ChainProvider";
import { useT } from "./i18n";
import { TokenIcon, tokenLogoUrl } from "../brand/logos";

/** What the vault page runs an action with: the stage, the steps, the transactions; `extra.token`
 *  is the token the action moves, whose logo its scene wears. */
type Act = <T>(name: string, run: (opts: ActionOptions) => Promise<T>, message?: (r: T) => string, extra?: { token?: string }) => Promise<T | undefined>;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Where the page remembers the token picked last, in this browser only. */
const TOKEN_KEY = "dno.vault.pocketToken";

function rememberedToken(tokens: PocketToken[]): string | undefined {
  try {
    const saved = localStorage.getItem(TOKEN_KEY);
    return tokens.find((t) => t.symbol === saved)?.symbol ?? tokens[0]?.symbol;
  } catch {
    return tokens[0]?.symbol;
  }
}

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
 * The wallet's pocket: tokens held under a key, not an address. Each token (cUSDC, cUSDT, cWETH,
 * cZAMA) has its own pockets; one signature (none in the demo) finds the wallet's pocket of every
 * one. Then the picked token's pocket: its code, its balance (decrypted for this page only),
 * putting the token in from the wallet, sending it to another pocket, taking it out to any
 * address, and, for cUSDC, the boxes sellers offered it in a private sale. The token's logo is on
 * the pouch, the balance, and the scene of every action.
 */
export function PocketTab({
  vault,
  account,
  act,
  busy,
  demo,
  boxes,
  labelOf,
  onOpenBox,
  onPocket,
}: {
  vault: VaultAdapter;
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
  const tokens = useMemo(() => vault.pocketTokens(), [vault]);
  const [symbol, setSymbol] = useState(() => rememberedToken(tokens));
  const pockets = useMemo(() => vault.pockets(symbol) ?? vault.pockets()!, [vault, symbol]);
  const token = pockets.token;
  const decimals = token.decimals;
  /** The wallet signed this session: switching tokens finds the next pocket without asking again. */
  const unlocked = useRef(false);
  const [plain, setPlain] = useState<bigint | null>(null);
  /** undefined: not looked for yet (a signature away); null: none opened. */
  const [id, setId] = useState<number | null | undefined>(undefined);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [sales, setSales] = useState<PocketSale[]>([]);
  const [prices, setPrices] = useState<Record<number, bigint>>({});
  /** The pocket's group: what its every action names, and who is known to feed it. */
  const [group, setGroup] = useState<PocketGroup | null>(null);
  const [copied, setCopied] = useState(false);

  const find = useCallback(
    async (opts?: ActionOptions) => {
      const mine = await pockets.mine(opts);
      unlocked.current = true;
      setId(mine);
      if (mine !== null) {
        setGroup(await pockets.group(mine).catch(() => null));
        setSales(await pockets.sales());
        if (pockets.token.desk) onPocket();
      }
      return mine;
    },
    [pockets, onPocket],
  );

  const readPlain = useCallback(() => void pockets.plainBalance().then(setPlain, () => setPlain(null)), [pockets]);

  // A new account starts locked.
  useEffect(() => {
    unlocked.current = false;
  }, [account]);

  // A new account or token starts blank; the demo has nothing to sign, and a wallet that signed
  // this session finds its pocket of the next token without asking again.
  useEffect(() => {
    setId(undefined);
    setBalance(null);
    setGroup(null);
    setSales([]);
    setPrices({});
    setPlain(null);
    readPlain();
    if (demo || unlocked.current) void find().catch(() => undefined);
  }, [account, demo, find, readPlain]);

  const pick = (next: string) => {
    setSymbol(next);
    try {
      localStorage.setItem(TOKEN_KEY, next);
    } catch {
      // Remembering the token is a convenience: without storage the page starts on cUSDC.
    }
  };

  /** After an action: the balance and the offered sales again, the balance only if it was shown. */
  const after = async () => {
    readPlain();
    const mine = await find().catch(() => id ?? null);
    if (mine !== null && balance !== null) setBalance(await pockets.balance().catch(() => null));
  };

  const run = async <T,>(name: string, task: (o: ActionOptions) => Promise<T>, message?: (r: T) => string) => {
    const r = await act(name, task, message, { token: token.symbol });
    await after();
    return r;
  };

  const picker = tokens.length > 1 && <TokenPicker tokens={tokens} value={token.symbol} onChange={pick} disabled={busy || !!own.busy} />;

  if (id === undefined) {
    return (
      <PocketShell picker={picker}>
        <Intro token={token.symbol} title={t("vault.pocket.unlock.title")} body={t("vault.pocket.unlock.body")}>
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
      <PocketShell picker={picker}>
        <Intro token={token.symbol} title={t("vault.pocket.none.title")} body={t("vault.pocket.none.body")}>
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
  const plainText = (v: bigint) => formatAmount(v, token.underlying.decimals);
  const done = { symbol: token.symbol };

  return (
    <PocketShell picker={picker}>
      <div className="vault-pocket-card" data-tour="pocket">
        <PouchMark token={token.symbol} />
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
              <TokenIcon symbol={token.symbol} size={14} />
              {token.symbol}
            </span>
            <strong className="vault-balance-value" aria-live="polite">
              {own.busy === "reveal" ? "…" : balance === null ? "••••" : formatAmount(balance, decimals)}
            </strong>
          </button>
          <p className="vault-meta">{balance === null ? t("vault.pocket.reveal") : t("vault.pocket.balanceHint")}</p>
        </div>
      </div>

      <div className="vault-pocket-forms">
        <AmountForm
          key={`deposit-${token.symbol}`}
          title={t("vault.pocket.deposit")}
          hint={t("vault.pocket.depositHint", done)}
          busy={busy}
          token={token}
          check={(amount, shield) =>
            shield && plain !== null && plain < amount * token.rate
              ? t("vault.pocket.short", { held: plainText(plain), needed: plainText(amount * token.rate), plain: token.underlying.symbol })
              : null
          }
          extra={(shield, setShield) => (
            <>
              <label className="vault-check">
                <input type="checkbox" checked={shield} onChange={(e) => setShield(e.target.checked)} />
                <span>{t("vault.pocket.shieldFirst", { plain: token.underlying.symbol, symbol: token.symbol })}</span>
              </label>
              <p className="vault-meta vault-pocket-plain">
                <TokenIcon symbol={token.underlying.symbol} size={12} />
                {t("vault.pocket.plain", { amount: plain === null ? "…" : plainText(plain), plain: token.underlying.symbol })}
              </p>
              {token.faucet !== null && (
                <button type="button" className="sec-link" disabled={busy} onClick={() => void run("faucet", (o) => pockets.faucet(o))}>
                  {t("vault.pocket.faucet", { amount: plainText(token.faucet), plain: token.underlying.symbol })}
                </button>
              )}
            </>
          )}
          onSubmit={(amount, shield) =>
            void run(
              "pocketDeposit",
              async (o) => {
                if (shield) await pockets.shield(amount, o);
                await pockets.deposit(amount, o);
              },
              () => t("vault.done.pocketDeposit", done),
            )
          }
        />
        <AmountForm
          key={`send-${token.symbol}`}
          title={t("vault.pocket.send")}
          hint={t("vault.pocket.sendHint")}
          busy={busy}
          token={token}
          target={{ label: t("vault.pocket.sendTo"), placeholder: "P-0", parse: (v) => parsePocketCode(v), bad: t("vault.pocket.badCode") }}
          onSubmit={(amount, _shield, to) =>
            void run("pocketSend", (o) => pockets.send(to as number, amount, o), () => t("vault.done.pocketSend", { id: pocketCode(to as number) }))
          }
        />
        <AmountForm
          key={`withdraw-${token.symbol}`}
          title={t("vault.pocket.withdraw")}
          hint={t("vault.pocket.withdrawHint", done)}
          busy={busy}
          token={token}
          target={{ label: t("vault.form.to"), placeholder: "0x…", initial: account, parse: (v) => (ADDRESS.test(v.trim()) ? v.trim() : null), bad: t("vault.form.bad") }}
          onSubmit={(amount, _shield, to) =>
            void run(
              "pocketWithdraw",
              (o) => pockets.withdraw(to as Address, amount, o),
              () => t("vault.done.pocketWithdraw", { address: shortAddress(to as Address) }),
            )
          }
        />
      </div>

      {group && <GroupNote group={group} id={id} />}

      {!token.desk ? (
        <p className="vault-meta vault-pocket-nodesk">{t("vault.pocket.noDesk")}</p>
      ) : (
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
                  <span className="vault-price">{prices[s.saleId] !== undefined ? t("vault.sales.price", { price: formatAmount(prices[s.saleId]!, decimals) }) : "••••"}</span>
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
      )}

      <p className="vault-meta vault-pocket-public">{t("vault.pocket.public")}</p>
    </PocketShell>
  );
}

/**
 * The pocket's group: the same pockets its every action names, so a set says which group acted
 * and never which pocket, and how many wallets anyone can tie to the group. An honest count,
 * not a promise: it grows as pockets open and wallets feed them.
 */
function GroupNote({ group, id }: { group: PocketGroup; id: number }) {
  const t = useT();
  const n = group.members.length;
  const fed = group.feeders === 0 ? "vault.pocket.groupFedNone" : group.feeders === 1 ? "vault.pocket.groupFedOne" : "vault.pocket.groupFed";
  return (
    <div className="vault-crowd vault-pocket-group" data-tour="group">
      <p className="vault-crowd-line">
        <span className="vault-crowd-label">{t("vault.pocket.group")}</span>
        <strong>{t("vault.pocket.groupOf", { n, size: group.size })}</strong>
        <span className="vault-crowd-codes">{group.members.map((m) => (m === id ? `${pocketCode(m)} ★` : pocketCode(m))).join(" · ")}</span>
      </p>
      <p className="vault-meta">{t(n > 1 ? "vault.pocket.groupHint" : "vault.pocket.groupAlone")}</p>
      {n > 1 && n < group.size && <p className="vault-meta vault-crowd-warn">{t("vault.pocket.groupFilling", { n, size: group.size })}</p>}
      <p className={`vault-meta${group.feeders <= 1 ? " vault-crowd-warn" : ""}`}>{t(fed, { n: group.feeders })}</p>
    </div>
  );
}

function PocketShell({ picker, children }: { picker?: ReactNode; children: ReactNode }) {
  const t = useT();
  return (
    <section className="vault-pocket">
      <p className="vault-meta vault-pocket-lede">{t("vault.pocket.lede")}</p>
      {picker}
      {children}
    </section>
  );
}

/** The tokens pockets hold, each with its logo: the pocket below is the picked one's. */
function TokenPicker({ tokens, value, onChange, disabled }: { tokens: PocketToken[]; value: string; onChange: (symbol: string) => void; disabled: boolean }) {
  const t = useT();
  return (
    <div className="vault-pocket-tokens">
      <span className="vault-decoys-label" id="pocket-token">
        {t("vault.pocket.token")}
      </span>
      <div role="radiogroup" aria-labelledby="pocket-token">
        {tokens.map((k) => (
          <button
            key={k.symbol}
            type="button"
            role="radio"
            aria-checked={value === k.symbol}
            className={value === k.symbol ? "on" : undefined}
            disabled={disabled}
            onClick={() => onChange(k.symbol)}
            title={k.name}
          >
            <TokenIcon symbol={k.symbol} size={18} />
            {k.symbol}
          </button>
        ))}
      </div>
      <p className="vault-meta">{t("vault.pocket.tokenHint", { symbol: value })}</p>
    </div>
  );
}

function Intro({ token, title, body, children }: { token: string; title: string; body: string; children: ReactNode }) {
  return (
    <div className="vault-pocket-intro">
      <PouchMark token={token} />
      <h3>{title}</h3>
      <p className="vault-meta">{body}</p>
      {children}
    </div>
  );
}

/** A small taped pouch, sealed with the token's logo (the house's red stamp for one without). */
function PouchMark({ token }: { token: string }) {
  const logo = tokenLogoUrl(token);
  return (
    <svg className="vault-pouch" viewBox="0 0 64 64" aria-hidden="true">
      <path d="M14 24 Q12 52 32 56 Q52 52 50 24 Z" fill="#c99a63" stroke="#07090c" strokeWidth="2" />
      <path d="M18 24 Q32 14 46 24" fill="none" stroke="#07090c" strokeWidth="2" />
      <rect x="12" y="20" width="40" height="7" rx="3" fill="#e8d3a2" stroke="#07090c" strokeWidth="1.5" />
      {logo ? (
        <image key={token} className="vault-pouch-seal" href={logo} x="22" y="30" width="20" height="20" />
      ) : (
        <>
          <circle cx="32" cy="40" r="7" fill="#ff4d3d" />
          <text x="32" y="43" textAnchor="middle" fontSize="7" fontWeight="700" fill="#07090c">
            $
          </text>
        </>
      )}
    </svg>
  );
}

/** An amount, with a pocket code or an address when the action goes somewhere. */
function AmountForm({
  title,
  hint,
  busy,
  token,
  target,
  extra,
  check,
  onSubmit,
}: {
  title: string;
  hint: string;
  busy: boolean;
  token: PocketToken;
  target?: { label: string; placeholder: string; initial?: string; parse: (v: string) => number | string | null; bad: string };
  extra?: (shield: boolean, setShield: (v: boolean) => void) => ReactNode;
  /** A problem to show before anything is sent, or null. */
  check?: (amount: bigint, shield: boolean) => string | null;
  onSubmit: (amount: bigint, shield: boolean, to?: number | string) => void;
}) {
  const t = useT();
  // An 18-decimal token (WETH, ZAMA) is worth more a unit: its faucet gives 1 WETH.
  const [amount, setAmount] = useState(token.rate > 1n ? "0.1" : "5");
  const [to, setTo] = useState(target?.initial ?? "");
  const [shield, setShield] = useState(false);
  const [bad, setBad] = useState<string | null>(null);
  return (
    <form
      className="vault-form vault-pocket-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        const units = parseUnits(amount, token.decimals);
        const where = target ? target.parse(to) : undefined;
        if (!units) return setBad(t("vault.form.bad"));
        if (target && where === null) return setBad(target.bad);
        const problem = check?.(units, shield);
        if (problem) return setBad(problem);
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
        {t("vault.pocket.amount", { symbol: token.symbol })}
        <span className="vault-amount-input">
          <TokenIcon symbol={token.symbol} size={16} />
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        </span>
      </label>
      {extra?.(shield, setShield)}
      <p className={bad ? "vault-hint vault-hint-bad" : "vault-hint"}>{bad ?? hint}</p>
      <button type="submit" className="sec-btn sec-btn-small" disabled={busy}>
        {title}
      </button>
    </form>
  );
}
