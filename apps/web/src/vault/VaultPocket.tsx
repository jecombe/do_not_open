import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  formatAmount,
  isStealthMeta,
  shortAddress,
  type ActionOptions,
  type Address,
  type PocketDoorsAdapter,
  type PocketDoorsInfo,
  type PocketGroup,
  type PocketSale,
  type PocketSavingsAdapter,
  type PocketToken,
  type SavingsInfo,
  type SavingsPending,
  type SideAddress,
  type VaultAdapter,
  type VaultBox,
  type VaultLinks,
} from "@dno/chain-adapter";
import { useAction } from "../chain/ChainProvider";
import { useLocale } from "../i18n/locale";
import { vaultDocsPath } from "../site";
import { useT } from "./i18n";
import { TokenIcon, tokenLogoUrl } from "../brand/logos";

/** What the vault page runs an action with: the stage, the steps, the transactions; `extra.token`
 *  is the token the action moves, whose logo its scene wears. */
type Act = <T>(name: string, run: (opts: ActionOptions) => Promise<T>, message?: (r: T) => string, extra?: { token?: string }) => Promise<T | undefined>;

type Run = <T>(name: string, task: (o: ActionOptions) => Promise<T>, message?: (r: T) => string) => Promise<T | undefined>;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Where the page remembers the token picked last, in this browser only. */
const TOKEN_KEY = "dno.vault.pocketToken";

/** The pocket's four doings, one shown at a time; the savings only where the pockets have them. */
type Doing = "deposit" | "send" | "withdraw" | "save";

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

/** What the page read of the pocket's savings: sealed shares, their worth today, what is on the way. */
interface SavingsRead {
  shares: bigint;
  worth: bigint | null;
  pending: SavingsPending[];
}

/**
 * The wallet's pocket: tokens held under a key, not an address. Each token (cUSDC, cUSDT, cWETH,
 * cZAMA) has its own pockets; one signature (none in the demo) finds the wallet's pocket of every
 * one. The picked token's pocket is one card (its code, its balance and its savings, read by the
 * page as soon as the pocket is found), one thing to do at a time under it (put in, send, take
 * out, save), the boxes sellers offered it, and, folded away, what a curious holder asks next:
 * the group it hides in, its fresh addresses, and what shows on-chain.
 */
export function PocketTab({
  vault,
  links,
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
  links: VaultLinks;
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
  /** The pocket's balance: null while sealed (not read yet, or the read failed). */
  const [balance, setBalance] = useState<bigint | null>(null);
  const [reading, setReading] = useState(false);
  const [sales, setSales] = useState<PocketSale[]>([]);
  const [prices, setPrices] = useState<Record<number, bigint>>({});
  /** The pocket's group: what its every action names, and who is known to feed it. */
  const [group, setGroup] = useState<PocketGroup | null>(null);
  const [copied, setCopied] = useState(false);
  /** The pocket's savings, where the cUSDC pockets have them; null elsewhere. */
  const savings = useMemo(() => pockets.savings(), [pockets]);
  const [saved, setSaved] = useState<SavingsRead | null>(null);
  /** The pockets' doors (stealth exits, the entry address), where ERC-5564's contracts are known. */
  const doors = useMemo(() => pockets.doors(), [pockets]);
  /** Bumped after every action: the doors read their addresses again. */
  const [tick, setTick] = useState(0);
  const [doing, setDoing] = useState<Doing>("deposit");

  /** The balance and the savings, read with the pocket's viewer: no signature, a moment. */
  const read = useCallback(
    async (opts?: ActionOptions) => {
      setReading(true);
      try {
        const [b, s, p] = await Promise.all([pockets.balance(opts), savings?.shares(opts) ?? null, savings?.pending(opts) ?? null]);
        setBalance(b);
        if (savings && s !== null && p !== null) setSaved({ shares: s, worth: await savings.value(s).catch(() => null), pending: p });
      } finally {
        setReading(false);
      }
    },
    [pockets, savings],
  );

  const find = useCallback(
    async (opts?: ActionOptions) => {
      const mine = await pockets.mine(opts);
      unlocked.current = true;
      setId(mine);
      if (mine !== null) {
        setGroup(await pockets.group(mine).catch(() => null));
        setSales(await pockets.sales());
        if (pockets.token.desk) onPocket();
        // A failed read leaves the balance sealed, with a button to read it again.
        void read().catch(() => undefined);
      }
      return mine;
    },
    [pockets, onPocket, read],
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
    setSaved(null);
    setGroup(null);
    setSales([]);
    setPrices({});
    setPlain(null);
    readPlain();
    if (demo || unlocked.current) void find().catch(() => undefined);
  }, [account, demo, find, readPlain]);

  // The savings are the cUSDC pockets': another token's pocket has no such thing to do.
  useEffect(() => {
    if (!savings && doing === "save") setDoing("deposit");
  }, [savings, doing]);

  const pick = (next: string) => {
    setSymbol(next);
    try {
      localStorage.setItem(TOKEN_KEY, next);
    } catch {
      // Remembering the token is a convenience: without storage the page starts on cUSDC.
    }
  };

  /** After an action: the wallet's plain balance, the pocket, its balance and its savings again. */
  const after = async () => {
    readPlain();
    await find().catch(() => undefined);
    setTick((n) => n + 1);
  };

  const run: Run = async (name, task, message) => {
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
  const amount = (v: bigint) => formatAmount(v, decimals);
  const quiet = busy || !!own.busy;
  const onTheWay = saved?.pending.length ?? 0;
  const doings: Doing[] = savings ? ["deposit", "send", "withdraw", "save"] : ["deposit", "send", "withdraw"];

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
          <p className="vault-pocket-amount">
            <TokenIcon symbol={token.symbol} size={18} />
            <strong aria-live="polite">{reading && balance === null ? "…" : balance === null ? "••••" : amount(balance)}</strong>
            <span className="vault-pocket-symbol">{token.symbol}</span>
            <button type="button" className="sec-btn sec-btn-ghost sec-btn-small vault-pocket-reread" disabled={quiet || reading} onClick={() => void own.run("reveal", (o) => read(o))} title={t("vault.pocket.reveal")}>
              {reading ? "…" : balance === null ? t("vault.pocket.read") : "↻"}
            </button>
          </p>
          {savings && saved && (saved.shares > 0n || onTheWay > 0) && (
            <p className="vault-meta vault-pocket-saved">
              {saved.worth !== null ? t("vault.pocket.savings.saved", { amount: amount(saved.worth), symbol: token.symbol }) : t("vault.pocket.savings.savedShares", { shares: formatAmount(saved.shares, savings.share.decimals), symbol: savings.share.symbol })}
              {onTheWay > 0 && <> · {t("vault.pocket.savings.onTheWay", { n: onTheWay })}</>}
            </p>
          )}
          <p className="vault-meta">{balance === null && !reading ? t("vault.pocket.balanceSealed") : t("vault.pocket.balanceHint")}</p>
          {own.error && own.busy === null && <p className="vault-error">{own.error.text}</p>}
        </div>
      </div>

      <div className="vault-pocket-do">
        <div className="vault-pocket-doings" role="tablist" aria-label={t("vault.pocket.doings")}>
          {doings.map((d) => (
            <button key={d} type="button" role="tab" aria-selected={doing === d} className={doing === d ? "on" : undefined} onClick={() => setDoing(d)}>
              {t(`vault.pocket.act.${d}`)}
            </button>
          ))}
        </div>

        {doing === "deposit" && (
          <DepositForm key={`deposit-${token.symbol}`} token={token} plain={plain} busy={quiet} run={run} pockets={pockets} />
        )}
        {doing === "send" && <SendForm key={`send-${token.symbol}`} token={token} balance={balance} busy={quiet} run={run} pockets={pockets} />}
        {doing === "withdraw" && (
          <WithdrawForm key={`withdraw-${token.symbol}`} token={token} balance={balance} account={account} busy={quiet} run={run} pockets={pockets} doors={doors} />
        )}
        {doing === "save" && savings && <SavingsForm key={`save-${token.symbol}`} token={token} savings={savings} balance={balance} saved={saved} busy={quiet} run={run} />}
      </div>

      {token.desk && sales.length > 0 && (
        <section className="vault-pocket-sales">
          <div className="vault-toolbar">
            <h3>{t("vault.pocket.sales.title")}</h3>
            {sales.some((s) => s.status === "open") && (
              <button
                type="button"
                className="sec-btn sec-btn-ghost sec-btn-small"
                disabled={quiet}
                onClick={() => void own.run("prices", async (o) => setPrices(await pockets.salePrices(sales.map((s) => s.saleId), o)))}
              >
                {t("vault.pocket.sales.read")}
              </button>
            )}
          </div>
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
                  <span className="vault-price">{prices[s.saleId] !== undefined ? t("vault.sales.price", { price: amount(prices[s.saleId]!) }) : "••••"}</span>
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
        </section>
      )}

      <div className="vault-pocket-more">
        {group && (
          <More title={t("vault.pocket.more.group")} sub={t("vault.pocket.groupOf", { n: group.members.length, size: group.size })} tour="group">
            <GroupNote group={group} id={id} />
          </More>
        )}
        {doors && (
          <More title={t("vault.pocket.more.doors")} sub={t("vault.pocket.more.doorsSub")} tour="doors">
            <DoorsCard doors={doors} token={token} links={links} busy={quiet} tick={tick} run={run} />
          </More>
        )}
        <More title={t("vault.pocket.more.leaks")} sub={t("vault.pocket.more.leaksSub")}>
          <div className="vault-pocket-leaks">
            <p className="vault-meta">{t("vault.pocket.public")}</p>
            {doors && <p className="vault-meta">{t("vault.pocket.doors.public")}</p>}
            {savings && <p className="vault-meta">{t("vault.pocket.savings.public")}</p>}
          </div>
        </More>
        <DocsLink />
      </div>
    </PocketShell>
  );
}

/** A fold a curious holder opens: closed, one line says what is inside. */
function More({ title, sub, tour, children }: { title: string; sub: string; tour?: string; children: ReactNode }) {
  return (
    <details className="vault-fold" data-tour={tour}>
      <summary>
        <span className="vault-fold-title">{title}</span>
        <span className="vault-fold-sub">{sub}</span>
      </summary>
      <div className="vault-fold-body">{children}</div>
    </details>
  );
}

function DocsLink() {
  const t = useT();
  const locale = useLocale();
  return (
    <a className="sec-link vault-pocket-docs" href={`${vaultDocsPath(locale)}#pockets`}>
      {t("vault.pocket.more.docs")}
    </a>
  );
}

/**
 * Put in: the wallet's confidential token goes into the pocket; the wallet can convert the plain
 * token first (that conversion shows). The two sources are a choice, not a checkbox under the amount.
 */
function DepositForm({ token, plain, busy, run, pockets }: { token: PocketToken; plain: bigint | null; busy: boolean; run: Run; pockets: ReturnType<VaultAdapter["pockets"]> & object }) {
  const t = useT();
  const [source, setSource] = useState<"sealed" | "plain">("sealed");
  const plainText = (v: bigint) => formatAmount(v, token.underlying.decimals);
  const done = { symbol: token.symbol };
  return (
    <AmountForm
      busy={busy}
      token={token}
      go={t("vault.pocket.act.deposit")}
      hint={t(source === "plain" ? "vault.pocket.deposit.plainHint" : "vault.pocket.deposit.hint", { plain: token.underlying.symbol, symbol: token.symbol })}
      before={
        <fieldset className="vault-choice">
          <legend>{t("vault.pocket.deposit.from")}</legend>
          <label>
            <input type="radio" name="deposit-source" checked={source === "sealed"} onChange={() => setSource("sealed")} />
            <span>
              <TokenIcon symbol={token.symbol} size={14} /> {t("vault.pocket.deposit.sealed", done)}
            </span>
          </label>
          <label>
            <input type="radio" name="deposit-source" checked={source === "plain"} onChange={() => setSource("plain")} />
            <span>
              <TokenIcon symbol={token.underlying.symbol} size={14} /> {t("vault.pocket.deposit.plain", { plain: token.underlying.symbol, symbol: token.symbol })}
              <small>{t("vault.pocket.deposit.wallet", { amount: plain === null ? "…" : plainText(plain), plain: token.underlying.symbol })}</small>
            </span>
          </label>
        </fieldset>
      }
      after={
        token.faucet !== null && (
          <button type="button" className="sec-link" disabled={busy} onClick={() => void run("faucet", (o) => pockets.faucet(o))}>
            {t("vault.pocket.faucet", { amount: plainText(token.faucet), plain: token.underlying.symbol })}
          </button>
        )
      }
      check={(amount) =>
        source === "plain" && plain !== null && plain < amount * token.rate
          ? t("vault.pocket.short", { held: plainText(plain), needed: plainText(amount * token.rate), plain: token.underlying.symbol })
          : null
      }
      onSubmit={(amount) =>
        void run(
          "pocketDeposit",
          async (o) => {
            if (source === "plain") await pockets.shield(amount, o);
            await pockets.deposit(amount, o);
          },
          () => t("vault.done.pocketDeposit", done),
        )
      }
    />
  );
}

/** Send: to another pocket, by its code. The page warns when the balance it read is short. */
function SendForm({ token, balance, busy, run, pockets }: { token: PocketToken; balance: bigint | null; busy: boolean; run: Run; pockets: ReturnType<VaultAdapter["pockets"]> & object }) {
  const t = useT();
  const [to, setTo] = useState("");
  const [badTo, setBadTo] = useState(false);
  const usdc = (v: bigint) => formatAmount(v, token.decimals);
  return (
    <AmountForm
      busy={busy}
      token={token}
      go={t("vault.pocket.act.send")}
      hint={badTo ? t("vault.pocket.badCode") : t("vault.pocket.send.hint")}
      bad={badTo}
      before={
        <label>
          {t("vault.pocket.send.to")}
          <input
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setBadTo(false);
            }}
            placeholder="P-12"
            spellCheck={false}
            autoComplete="off"
            inputMode="numeric"
          />
        </label>
      }
      check={(amount) => {
        if (parsePocketCode(to) === null) {
          setBadTo(true);
          return "";
        }
        return balance !== null && balance < amount ? t("vault.pocket.shortPocket", { held: usdc(balance), needed: usdc(amount), symbol: token.symbol }) : null;
      }}
      onSubmit={(amount) => {
        const code = parsePocketCode(to)!;
        void run("pocketSend", (o) => pockets.send(code, amount, o), () => t("vault.done.pocketSend", { id: pocketCode(code) }));
      }}
    />
  );
}

/**
 * Take out: to a fresh address of one's own by default where the doors are known (nothing links
 * it to the wallet), or to an address typed: a wallet's, or a stealth meta-address for a fresh
 * address of theirs. Without the doors, an address, the wallet's own to start.
 */
function WithdrawForm({
  token,
  balance,
  account,
  busy,
  run,
  pockets,
  doors,
}: {
  token: PocketToken;
  balance: bigint | null;
  account: Address;
  busy: boolean;
  run: Run;
  pockets: ReturnType<VaultAdapter["pockets"]> & object;
  doors: PocketDoorsAdapter | null;
}) {
  const t = useT();
  const [where, setWhere] = useState<"fresh" | "typed">(doors ? "fresh" : "typed");
  const [to, setTo] = useState(doors ? "" : account);
  const [badTo, setBadTo] = useState(false);
  const usdc = (v: bigint) => formatAmount(v, token.decimals);
  const typed = to.trim();
  const okTo = ADDRESS.test(typed) || (!!doors && isStealthMeta(typed));
  const hint = badTo
    ? doors
      ? t("vault.pocket.badTo")
      : t("vault.form.bad")
    : where === "fresh"
      ? t("vault.pocket.withdraw.freshHint")
      : doors
        ? t("vault.pocket.withdraw.typedHint")
        : t("vault.pocket.withdraw.hint", { symbol: token.symbol });
  return (
    <AmountForm
      busy={busy}
      token={token}
      go={t("vault.pocket.act.withdraw")}
      hint={hint}
      bad={badTo}
      before={
        <>
          {doors && (
            <fieldset className="vault-choice">
              <legend>{t("vault.pocket.withdraw.where")}</legend>
              <label>
                <input type="radio" name="withdraw-where" checked={where === "fresh"} onChange={() => setWhere("fresh")} />
                <span>{t("vault.pocket.withdraw.fresh")}</span>
              </label>
              <label>
                <input type="radio" name="withdraw-where" checked={where === "typed"} onChange={() => setWhere("typed")} />
                <span>{t("vault.pocket.withdraw.typed")}</span>
              </label>
            </fieldset>
          )}
          {where === "typed" && (
            <label>
              {t("vault.pocket.withdraw.to")}
              <input
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setBadTo(false);
                }}
                placeholder={doors ? "0x… / st:eth:…" : "0x…"}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
          )}
        </>
      }
      check={(amount) => {
        if (where === "typed" && !okTo) {
          setBadTo(true);
          return "";
        }
        return balance !== null && balance < amount ? t("vault.pocket.shortPocket", { held: usdc(balance), needed: usdc(amount), symbol: token.symbol }) : null;
      }}
      onSubmit={(amount) =>
        void run(
          "pocketWithdraw",
          async (o) => {
            // A fresh address of one's own; a meta-address, or a wallet that published one: a
            // fresh address of theirs. Any other address: in the open.
            if (doors && where === "fresh") return { stealth: true, address: await doors.withdrawStealth(amount, null, o) };
            if (doors && (isStealthMeta(typed) || (await doors.resolve(typed)))) return { stealth: true, address: await doors.withdrawStealth(amount, typed, o) };
            await pockets.withdraw(typed as Address, amount, o);
            return { stealth: false, address: typed as Address };
          },
          (r) => t(r.stealth ? "vault.done.pocketWithdrawStealth" : "vault.done.pocketWithdraw", { address: shortAddress(r.address) }),
        )
      }
    />
  );
}

/** "{n} min" under an hour and a half, "{n} h" above: how long a batch ages before it is dispatched. */
function waitText(t: ReturnType<typeof useT>, seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes < 90 ? t("vault.pocket.savings.minutes", { n: minutes }) : t("vault.pocket.savings.hours", { n: Math.round(minutes / 60) });
}

/**
 * Savings: part of the pocket's cUSDC put to work in one of Zama's confidential vaults on Morpho.
 * Put aside or take back, one amount; what is put aside and what is on the way sit above the
 * form, read with the balance. Either way joins Zama's next batch, so nothing is instant.
 */
function SavingsForm({
  token,
  savings,
  balance,
  saved,
  busy,
  run,
}: {
  token: PocketToken;
  savings: PocketSavingsAdapter;
  balance: bigint | null;
  saved: SavingsRead | null;
  busy: boolean;
  run: Run;
}) {
  const t = useT();
  const [side, setSide] = useState<"put" | "take">("put");
  const [info, setInfo] = useState<SavingsInfo | null>(null);
  useEffect(() => {
    void savings.info().then(setInfo, () => setInfo(null));
  }, [savings]);

  const usdc = (v: bigint) => formatAmount(v, token.decimals);
  const share = savings.share;
  const wait = info ? waitText(t, info.minBatchAge) : "…";
  const worth = saved?.worth ?? null;
  const shares = saved?.shares ?? null;
  const amountOf = (p: SavingsPending) => (p.side === "save" ? `${usdc(p.amount)} ${token.symbol}` : `${formatAmount(p.amount, share.decimals)} ${share.symbol}`);

  return (
    <div className="vault-pocket-savings" data-tour="savings">
      <p className="vault-meta vault-pocket-savings-lede">{t("vault.pocket.savings.lede")}</p>
      {saved && saved.pending.length > 0 && (
        <ul className="vault-pocket-pending">
          {saved.pending.map((p) => (
            <li key={`${p.side}-${p.windowId}`}>
              <span className="vault-pocket-pending-side">{t(`vault.pocket.savings.side.${p.side}`)}</span>
              <strong>{amountOf(p)}</strong>
              <span className="vault-pocket-pending-state">{t(`vault.pocket.savings.state.${p.state}`)}</span>
            </li>
          ))}
        </ul>
      )}
      <AmountForm
        key={side}
        busy={busy}
        token={token}
        go={t(side === "put" ? "vault.pocket.savings.put" : "vault.pocket.savings.take")}
        hint={t(side === "put" ? "vault.pocket.savings.putHint" : "vault.pocket.savings.takeHint", { wait })}
        before={
          <div className="vault-pocket-sides" role="tablist">
            <button type="button" role="tab" aria-selected={side === "put"} className={side === "put" ? "on" : undefined} onClick={() => setSide("put")}>
              {t("vault.pocket.savings.put")}
            </button>
            <button type="button" role="tab" aria-selected={side === "take"} className={side === "take" ? "on" : undefined} onClick={() => setSide("take")}>
              {t("vault.pocket.savings.take")}
            </button>
          </div>
        }
        fill={side === "take" && worth !== null && shares !== null && shares > 0n ? { label: t("vault.pocket.savings.all"), value: usdc(worth) } : undefined}
        check={(amount) =>
          side === "put"
            ? balance !== null && balance < amount
              ? t("vault.pocket.shortPocket", { held: usdc(balance), needed: usdc(amount), symbol: token.symbol })
              : null
            : worth !== null && worth < amount
              ? t("vault.pocket.savings.shortShares", { held: usdc(worth), needed: usdc(amount), symbol: token.symbol })
              : null
        }
        onSubmit={(amount, all) =>
          side === "put"
            ? void run("pocketSave", (o) => savings.save(amount, o), () => t("vault.done.pocketSave"))
            : void run(
                "pocketUnsave",
                async (o) => {
                  // "All" asks the exact shares; an amount is converted at today's price, never
                  // past what the pocket holds (the estimate can round over it).
                  let asked = all && shares !== null ? shares : await savings.toShares(amount);
                  if (shares !== null && asked > shares) asked = shares;
                  await savings.unsave(asked, o);
                },
                () => t("vault.done.pocketUnsave"),
              )
        }
      />
    </div>
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
    <div className="vault-pocket-group">
      <p className="vault-crowd-codes">{group.members.map((m) => (m === id ? `${pocketCode(m)} ★` : pocketCode(m))).join(" · ")}</p>
      <p className="vault-meta">{t(n > 1 ? "vault.pocket.groupHint" : "vault.pocket.groupAlone", { size: group.size })}</p>
      {n > 1 && n < group.size && <p className="vault-meta vault-crowd-warn">{t("vault.pocket.groupFilling", { n, size: group.size })}</p>}
      <p className={`vault-meta${group.feeders <= 1 ? " vault-crowd-warn" : ""}`}>{t(fed, { n: group.feeders })}</p>
    </div>
  );
}

/** Wei as ETH, four decimals at most, for the gas a fresh address holds or needs. */
function ethText(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = ((wei % 10n ** 18n) / 10n ** 14n).toString().padStart(4, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/**
 * The pockets' doors. Out: the wallet's stealth meta-address (what a payer draws fresh addresses
 * from, published or handed over) and the fresh addresses paid to the wallet, each emptied into
 * the pocket by itself once it has gas. In: the entry address, funded from outside (a privacy
 * pool, an exchange), that feeds the pocket without the wallet ever appearing.
 */
function DoorsCard({
  doors,
  token,
  links,
  busy,
  tick,
  run,
}: {
  doors: PocketDoorsAdapter;
  token: PocketToken;
  links: VaultLinks;
  busy: boolean;
  /** Changes after every action of the pocket: what was read is read again. */
  tick: number;
  run: Run;
}) {
  const t = useT();
  const own = useAction();
  const [info, setInfo] = useState<PocketDoorsInfo | null>(null);
  const [meta, setMeta] = useState<string | null>(null);
  const [published, setPublished] = useState<boolean | null>(null);
  /** null: not looked at yet. */
  const [inbox, setInbox] = useState<SideAddress[] | null>(null);
  const [entry, setEntry] = useState<SideAddress | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const looked = useRef(false);

  const look = useCallback(
    async (opts?: ActionOptions) => {
      const [m, p, list, e] = await Promise.all([doors.metaAddress(opts), doors.published(opts), doors.inbox(opts), doors.entry(opts)]);
      setMeta(m);
      setPublished(p);
      setInbox(list);
      setEntry(e);
      looked.current = true;
    },
    [doors],
  );

  useEffect(() => {
    looked.current = false;
    setMeta(null);
    setPublished(null);
    setInbox(null);
    setEntry(null);
    void doors.info().then(setInfo, () => setInfo(null));
  }, [doors]);

  useEffect(() => {
    if (tick > 0 && looked.current) void look().catch(() => undefined);
  }, [tick, look]);

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(text);
      setTimeout(() => setCopied(null), 1500);
    });
  };
  const sealed = (v: bigint) => formatAmount(v, token.decimals);
  const plain = (v: bigint) => formatAmount(v, token.underlying.decimals);
  const fuelEth = info?.fuel ? ethText(info.fuel) : null;
  const needEth = info ? ethText(info.gasNeeded) : "…";
  const held = (s: SideAddress) => s.sealed > 0n || s.plain > 0n;
  const waiting = inbox?.filter(held) ?? [];
  const emptied = inbox ? inbox.length - waiting.length : 0;

  const addressLine = (s: SideAddress) => {
    const href = links.address(s.address);
    return (
      <>
        {href ? (
          <a className="vault-ext" href={href} target="_blank" rel="noreferrer" title={s.address}>
            {shortAddress(s.address)}
          </a>
        ) : (
          <span title={s.address}>{shortAddress(s.address)}</span>
        )}
        <button type="button" className="sec-btn sec-btn-ghost sec-btn-small" onClick={() => copy(s.address)}>
          {copied === s.address ? t("vault.pocket.copied") : t("vault.pocket.copy")}
        </button>
      </>
    );
  };

  const actions = (s: SideAddress) => (
    <span className="vault-doors-actions">
      {held(s) && s.fueled && (
        <button type="button" className="sec-btn sec-btn-small" disabled={busy} onClick={() => void run("pocketCollect", (o) => doors.collect(s.address, o), () => t("vault.done.pocketCollect", { address: shortAddress(s.address) }))}>
          {t("vault.pocket.doors.collect")}
        </button>
      )}
      {held(s) && !s.fueled && fuelEth && (
        <button type="button" className="sec-btn sec-btn-small" disabled={busy} onClick={() => void run("pocketFuel", (o) => doors.fuel(s.address, o), () => t("vault.done.pocketFuel", { address: shortAddress(s.address) }))}>
          {t("vault.pocket.doors.fuel")}
        </button>
      )}
    </span>
  );

  const gasNote = (s: SideAddress) =>
    held(s) && !s.fueled ? (
      <p className="vault-meta vault-crowd-warn">
        {t("vault.pocket.doors.needsGas", { eth: needEth })} {fuelEth ? t("vault.pocket.doors.fuelHint", { eth: fuelEth }) : t("vault.pocket.doors.noFuel")}
      </p>
    ) : null;

  if (meta === null) {
    return (
      <div className="vault-pocket-doors">
        <p className="vault-meta">{t("vault.pocket.doors.lede")}</p>
        <div className="vault-doors-actions">
          <button type="button" className="sec-btn sec-btn-small" disabled={busy || !!own.busy} onClick={() => void own.run("look", (o) => look(o))}>
            {own.busy === "look" ? "…" : t("vault.pocket.doors.look")}
          </button>
        </div>
        {own.error && <p className="vault-error">{own.error.text}</p>}
      </div>
    );
  }

  return (
    <div className="vault-pocket-doors">
      <p className="vault-meta">{t("vault.pocket.doors.lede")}</p>

      <div className="vault-doors-row">
        <div className="vault-toolbar">
          <h4>{t("vault.pocket.doors.inbox")}</h4>
          <button type="button" className="sec-btn sec-btn-ghost sec-btn-small" disabled={busy || !!own.busy} onClick={() => void own.run("look", (o) => look(o))}>
            {own.busy === "look" ? "…" : t("vault.pocket.doors.refresh")}
          </button>
        </div>
        {waiting.length === 0 ? (
          <p className="vault-meta">{t("vault.pocket.doors.inboxEmpty")}</p>
        ) : (
          <ul className="vault-doors-list">
            {waiting.map((s) => (
              <li key={s.address}>
                {addressLine(s)}
                <strong>
                  {sealed(s.sealed)} {token.symbol}
                </strong>
                <span className="vault-meta">{t("vault.pocket.doors.gas", { eth: ethText(s.gas) })}</span>
                {actions(s)}
                {gasNote(s)}
              </li>
            ))}
          </ul>
        )}
        {emptied > 0 && <p className="vault-meta">{t("vault.pocket.doors.collected", { n: emptied })}</p>}
        <p className="vault-meta">{t("vault.pocket.doors.collectHint")}</p>
        {own.error && <p className="vault-error">{own.error.text}</p>}
      </div>

      {entry && (
        <div className="vault-doors-row">
          <h4>{t("vault.pocket.doors.entry")}</h4>
          <p className="vault-meta">{t("vault.pocket.doors.entryLede", { plain: token.underlying.symbol })}</p>
          <p className="vault-doors-line">
            <code title={entry.address}>{entry.address}</code>
            <button type="button" className="sec-btn sec-btn-ghost sec-btn-small" onClick={() => copy(entry.address)}>
              {copied === entry.address ? t("vault.pocket.copied") : t("vault.pocket.copy")}
            </button>
          </p>
          <p className="vault-doors-line">
            <strong>{t("vault.pocket.doors.holds", { plain: plain(entry.plain), plainSymbol: token.underlying.symbol, sealed: sealed(entry.sealed), symbol: token.symbol })}</strong>
            <span className="vault-meta">{t("vault.pocket.doors.gas", { eth: ethText(entry.gas) })}</span>
            {actions(entry)}
            <a className="sec-link" href="https://privacypools.com" target="_blank" rel="noreferrer">
              {t("vault.pocket.doors.privacyPools")}&nbsp;↗
            </a>
          </p>
          {gasNote(entry)}
        </div>
      )}

      <div className="vault-doors-row">
        <h4>{t("vault.pocket.doors.meta")}</h4>
        <p className="vault-doors-line">
          <code title={meta}>{meta}</code>
          <button type="button" className="sec-btn sec-btn-ghost sec-btn-small" onClick={() => copy(meta)}>
            {copied === meta ? t("vault.pocket.copied") : t("vault.pocket.copy")}
          </button>
          {published ? (
            <span className="vault-chip">{t("vault.pocket.doors.published")}</span>
          ) : (
            <button type="button" className="sec-btn sec-btn-small" disabled={busy} onClick={() => void run("pocketPublish", (o) => doors.publish(o), () => t("vault.done.pocketPublish"))}>
              {t("vault.pocket.doors.publish")}
            </button>
          )}
        </p>
        <p className="vault-meta">{t("vault.pocket.doors.metaHint")}</p>
        {!published && <p className="vault-meta">{t("vault.pocket.doors.publishHint")}</p>}
      </div>
    </div>
  );
}

function PocketShell({ picker, children }: { picker?: ReactNode; children: ReactNode }) {
  return (
    <section className="vault-pocket">
      {picker}
      {children}
    </section>
  );
}

/** The tokens pockets hold, each with its logo: the pocket below is the picked one's. */
function TokenPicker({ tokens, value, onChange, disabled }: { tokens: PocketToken[]; value: string; onChange: (symbol: string) => void; disabled: boolean }) {
  const t = useT();
  return (
    <div className="vault-pocket-tokens" title={t("vault.pocket.tokenHint")}>
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

/**
 * One amount, what goes before it (a choice, a code, an address) and one button. `check` says
 * what is wrong before anything is sent: a message, or "" when the caller showed the problem
 * itself (a bad code, a bad address) and only wants the send stopped.
 */
function AmountForm({
  busy,
  token,
  go,
  hint,
  bad = false,
  before,
  after,
  fill,
  check,
  onSubmit,
}: {
  busy: boolean;
  token: PocketToken;
  /** The button's text. */
  go: string;
  hint: string;
  /** The hint shows a problem the caller found. */
  bad?: boolean;
  before?: ReactNode;
  after?: ReactNode;
  /** A link that fills the amount with everything there is (`value`, as text); `onSubmit` then gets `all`. */
  fill?: { label: string; value: string };
  check?: (amount: bigint) => string | null;
  onSubmit: (amount: bigint, all: boolean) => void;
}) {
  const t = useT();
  // An 18-decimal token (WETH, ZAMA) is worth more a unit: its faucet gives 1 WETH.
  const [amount, setAmount] = useState(token.rate > 1n ? "0.1" : "5");
  const [problem, setProblem] = useState<string | null>(null);
  /** The amount was filled with everything and not edited since. */
  const [all, setAll] = useState(false);
  return (
    <form
      className="vault-form vault-pocket-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        const units = parseUnits(amount, token.decimals);
        if (!units) return setProblem(t("vault.form.bad"));
        const found = check?.(units) ?? null;
        if (found !== null) return setProblem(found || null);
        setProblem(null);
        onSubmit(units, all && fill !== undefined && amount === fill.value);
      }}
    >
      {before}
      <label>
        {t("vault.pocket.amount", { symbol: token.symbol })}
        <span className="vault-amount-input">
          <TokenIcon symbol={token.symbol} size={16} />
          <input
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setAll(false);
              setProblem(null);
            }}
            inputMode="decimal"
          />
          {fill && (
            <button
              type="button"
              className="sec-link vault-amount-all"
              onClick={() => {
                setAmount(fill.value);
                setAll(true);
              }}
            >
              {fill.label}
            </button>
          )}
        </span>
      </label>
      {after}
      <p className={problem || bad ? "vault-hint vault-hint-bad" : "vault-hint"}>{problem ?? hint}</p>
      <button type="submit" className="sec-btn sec-btn-small" disabled={busy}>
        {go}
      </button>
    </form>
  );
}
