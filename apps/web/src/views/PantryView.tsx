import { useCallback, useEffect, useMemo, useState } from "react";
import { formatAmount, type BoxPantry, type EconomyInfo, type TradeSide } from "@dno/chain-adapter";
import { spec as gameSpec } from "@dno/game-spec";
import type { QualitySettings, ShakeSound } from "@dno/scene";
import { useAction, useChain } from "../chain/ChainProvider";
import { stepCopy } from "../chain/copy";
import { useT, type AppKey } from "../i18n/app";
import { ShelfScene, SHELF_CAPACITY } from "../scenes/Scenes";
import { Stage } from "./Stage";
import { useFold } from "./useFold";

interface Props {
  quality: QualitySettings;
  sound: ShakeSound;
  onSelect: (tokenId: number) => void;
}

type Tab = "stock" | "market" | "wrap" | "rules";
const TABS: { key: Tab; label: AppKey }[] = [
  { key: "stock", label: "pantry.tabStock" },
  { key: "market", label: "pantry.tabMarket" },
  { key: "wrap", label: "pantry.tabWrap" },
  { key: "rules", label: "pantry.tabRules" },
];

const STATE_KEYS = [...gameSpec.states].sort((a, b) => a.id - b.id).map((s) => s.key);

/** "0.005" to 5000000000000000n at 18 decimals; null for anything that is not a plain positive number. */
export function parseAmount(text: string, decimals: number): bigint | null {
  const clean = text.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(clean)) return null;
  const [whole, frac = ""] = clean.split(".");
  if (frac.length > decimals) return null;
  const value = BigInt(whole!) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return value > 0n ? value : null;
}

/** A coin amount kept short: four decimals are plenty to compare prices. */
const coin = (wei: bigint, decimals: number) => {
  const [whole, frac = ""] = formatAmount(wei, decimals).split(".");
  const kept = frac.slice(0, 6).replace(/0+$/, "");
  return kept ? `${whole}.${kept}` : whole!;
};

/**
 * The pantry: the croquettes the account holds, the bags and purrs its boxes owe it, the
 * public market, the bridge between plain CROQ and confidential cCROQ, and the rules.
 */
export function PantryView({ quality, sound, onSelect }: Props) {
  const { adapter, account, myBoxes, collection, connect } = useChain();
  const t = useT();
  const { foldClass, foldButton } = useFold();
  const action = useAction();
  const [tab, setTab] = useState<Tab>("stock");
  const [economy, setEconomy] = useState<EconomyInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [plain, setPlain] = useState<bigint | null>(null);
  const [hidden, setHidden] = useState<bigint | null>(null);
  const [boxes, setBoxes] = useState<Map<number, BoxPantry>>(new Map());
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [done, setDone] = useState<AppKey | null>(null);
  const decimals = collection?.currency.decimals ?? 18;
  const symbol = collection?.currency.symbol ?? "ETH";

  const load = useCallback(async () => {
    try {
      setEconomy(await adapter.economy());
      setFailed(false);
    } catch {
      setFailed(true);
      return;
    }
    if (!account) return;
    const [balance, rows] = await Promise.all([
      adapter.croqBalance(account),
      Promise.all(myBoxes.map(async (id) => [id, await adapter.boxPantry(id)] as const)),
    ]);
    setPlain(balance);
    setBoxes(new Map(rows));
  }, [adapter, account, myBoxes]);

  useEffect(() => void load(), [load]);
  // The account changed: what was decrypted belongs to the previous one.
  useEffect(() => setHidden(null), [account]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(timer);
  }, []);

  const due = useMemo(() => myBoxes.filter((id) => {
    const b = boxes.get(id);
    return b && (!b.welcomed || b.nextClaimAt <= now);
  }), [myBoxes, boxes, now]);
  const nextAt = useMemo(() => {
    const later = myBoxes.map((id) => boxes.get(id)).filter((b): b is BoxPantry => !!b && b.welcomed && b.nextClaimAt > now);
    return later.length ? Math.min(...later.map((b) => b.nextClaimAt)) : null;
  }, [myBoxes, boxes, now]);

  const after = async (key: AppKey, reveal = true) => {
    setDone(key);
    await load();
    if (reveal && hidden !== null) setHidden(await adapter.confidentialBalance().catch(() => null));
  };

  const reveal = async () => {
    setDone(null);
    const value = await action.run("reveal", (o) => adapter.confidentialBalance(o));
    if (value !== undefined) setHidden(value);
  };

  const collect = async () => {
    setDone(null);
    const ids = due.slice(0, economy?.maxBoxesPerClaim ?? 10);
    const ok = await action.run("collect", async (o) => {
      await adapter.claimCroquettes(ids, o);
      return true;
    });
    if (ok) await after("pantry.collected");
  };

  const shelf = useMemo(() => myBoxes.slice(0, SHELF_CAPACITY).map((tokenId) => ({ tokenId, cat: null })), [myBoxes]);

  return (
    <>
      <Stage quality={quality}>
        <ShelfScene boxes={shelf} quality={quality} sound={sound} onSelect={onSelect} />
      </Stage>

      <section className={`slip pantry${foldClass}`} aria-label={t("pantry.title")}>
        {foldButton}
        <div className="slip-head">
          <span>{t("pantry.title")}</span>
        </div>
        <div className="picker pantry-tabs" role="group" aria-label={t("pantry.title")}>
          {TABS.map((tb) => (
            <button type="button" key={tb.key} aria-pressed={tab === tb.key} onClick={() => setTab(tb.key)} disabled={!!action.busy}>
              {t(tb.label)}
            </button>
          ))}
        </div>

        {failed ? (
          <p className="fine problem">{t("pantry.failed")}</p>
        ) : !economy ? (
          <p className="state-note">{t("pantry.reading")}</p>
        ) : tab === "rules" ? (
          <Rules economy={economy} />
        ) : !account ? (
          <>
            <p className="state-note">{t("pantry.connectFirst")}</p>
            <button type="button" className="stamp-button" onClick={() => void connect()}>
              {t("nav.connect")}
            </button>
          </>
        ) : tab === "stock" ? (
          <>
            <dl className="fields pantry-balances">
              <div>
                <dt>{economy.confidentialSymbol}</dt>
                <dd>{hidden === null ? "••••" : hidden.toLocaleString()}</dd>
              </div>
              <div>
                <dt>{economy.symbol}</dt>
                <dd>{plain === null ? "…" : plain.toLocaleString()}</dd>
              </div>
              <div>
                <dt>{t("pantry.boxes")}</dt>
                <dd>{myBoxes.length}</dd>
              </div>
            </dl>
            <div className="actions">
              <button type="button" className="stamp-button" onClick={() => void collect()} disabled={!!action.busy || due.length === 0}>
                {action.busy === "collect" ? t("pantry.collecting") : due.length === 0 ? t("pantry.upToDate") : t("pantry.collect", { count: Math.min(due.length, economy.maxBoxesPerClaim) })}
              </button>
              <button type="button" className="plain-button" onClick={() => void reveal()} disabled={!!action.busy}>
                {action.busy === "reveal" ? t("pantry.revealing") : hidden === null ? t("pantry.reveal") : t("pantry.revealAgain")}
              </button>
            </div>
            <Feedback busy={action.busy} step={action.step} error={action.error} done={done}>
              {myBoxes.length === 0
                ? t("pantry.noBoxes")
                : due.length > 0
                  ? t("pantry.dueHint", { bag: economy.welcomeBag, max: economy.purrMaxPerDay })
                  : nextAt
                    ? t("pantry.nextPurr", { time: new Date(nextAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })
                    : ""}
              {due.length > economy.maxBoxesPerClaim ? t("pantry.batched", { n: economy.maxBoxesPerClaim }) : ""}
            </Feedback>
          </>
        ) : tab === "market" ? (
          <Market economy={economy} decimals={decimals} symbol={symbol} busy={action.busy} run={action.run} onDone={(k) => void after(k, false)} />
        ) : (
          <Bridge economy={economy} hidden={hidden} plain={plain} busy={action.busy} run={action.run} onDone={(k) => void after(k)} />
        )}

        {tab !== "stock" && tab !== "rules" && account && (
          <Feedback busy={action.busy} step={action.step} error={action.error} done={done}>
            {null}
          </Feedback>
        )}
      </section>
    </>
  );
}

type Run = ReturnType<typeof useAction>["run"];

function Feedback({ busy, step, error, done, children }: { busy: string | null; step: Parameters<typeof stepCopy>[0]; error: string | null; done: AppKey | null; children: React.ReactNode }) {
  const t = useT();
  return (
    <div className="felt" aria-live="polite">
      {error ? (
        <p className="fine problem">{error}</p>
      ) : busy ? (
        <>
          <p className="fine">{stepCopy(step, busy === "reveal")}</p>
          {step === "decrypting" && <p className="fine">{t("track.slow")}</p>}
        </>
      ) : done ? (
        <p className="fine">{t(done)}</p>
      ) : children ? (
        <p className="fine">{children}</p>
      ) : null}
    </div>
  );
}

function Market({
  economy,
  decimals,
  symbol,
  busy,
  run,
  onDone,
}: {
  economy: EconomyInfo;
  decimals: number;
  symbol: string;
  busy: string | null;
  run: Run;
  onDone: (key: AppKey) => void;
}) {
  const { adapter } = useChain();
  const t = useT();
  const [side, setSide] = useState<TradeSide>("buy");
  const [text, setText] = useState("");
  const [quoted, setQuoted] = useState<bigint | null>(null);
  const market = economy.market;
  const amount = parseAmount(text, side === "buy" ? decimals : 0);

  useEffect(() => {
    setQuoted(null);
    if (!amount || !market) return;
    let live = true;
    const timer = setTimeout(() => {
      adapter.quote(side, amount).then((q) => live && setQuoted(q), () => live && setQuoted(null));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [adapter, side, amount, market]);

  if (!market) return <p className="state-note">{t("pantry.noMarket")}</p>;

  // The pool's own price, before fees: coin per thousand croquettes.
  const perThousand = market.croqReserve > 0n ? (market.nativeReserve * 1000n) / market.croqReserve : 0n;
  const trade = async () => {
    if (!amount) return;
    const ok = await run("trade", async (o) => {
      await adapter.trade(side, amount, o);
      return true;
    });
    if (ok) {
      setText("");
      onDone(side === "buy" ? "pantry.bought" : "pantry.sold");
    }
  };

  return (
    <>
      <dl className="fields pantry-balances">
        <div>
          <dt>{t("pantry.price")}</dt>
          <dd>{coin(perThousand, decimals)}</dd>
        </div>
        <div>
          <dt>{t("pantry.poolCroq")}</dt>
          <dd>{Number(market.croqReserve).toLocaleString()}</dd>
        </div>
        <div>
          <dt>{t("pantry.poolCoin", { symbol })}</dt>
          <dd>{coin(market.nativeReserve, decimals)}</dd>
        </div>
      </dl>
      <p className="fine">{t("pantry.priceNote", { symbol, market: market.name })}</p>
      <div className="picker" role="group" aria-label={t("pantry.tabMarket")}>
        <button type="button" aria-pressed={side === "buy"} onClick={() => setSide("buy")} disabled={!!busy}>
          {t("pantry.buy")}
        </button>
        <button type="button" aria-pressed={side === "sell"} onClick={() => setSide("sell")} disabled={!!busy}>
          {t("pantry.sell")}
        </button>
      </div>
      <form
        className="find pantry-form"
        onSubmit={(e) => {
          e.preventDefault();
          void trade();
        }}
      >
        <label htmlFor="trade-amount">{side === "buy" ? t("pantry.payWith", { symbol }) : t("pantry.sellAmount")}</label>
        <input id="trade-amount" inputMode="decimal" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} placeholder={side === "buy" ? "0.001" : "1000"} disabled={!!busy} />
        <button type="submit" className="plain-button" disabled={!!busy || !amount}>
          {busy === "trade" ? t("pantry.trading") : side === "buy" ? t("pantry.buy") : t("pantry.sell")}
        </button>
      </form>
      <p className="fine">
        {quoted !== null
          ? side === "buy"
            ? t("pantry.quoteBuy", { n: Number(quoted).toLocaleString() })
            : t("pantry.quoteSell", { amount: coin(quoted, decimals), symbol })
          : t("pantry.marketHint")}
      </p>
      <p className="fine">
        {market.appUrl && (
          <a className="link" href={market.appUrl} target="_blank" rel="noreferrer">
            {t("pantry.openMarket", { market: market.name })}
          </a>
        )}
        {market.appUrl && market.poolUrl ? " · " : ""}
        {market.poolUrl && (
          <a className="link" href={market.poolUrl} target="_blank" rel="noreferrer">
            {t("pantry.pool")}
          </a>
        )}
      </p>
    </>
  );
}

/** Plain CROQ in and out of cCROQ, and confidential transfers between players. */
function Bridge({
  economy,
  hidden,
  plain,
  busy,
  run,
  onDone,
}: {
  economy: EconomyInfo;
  hidden: bigint | null;
  plain: bigint | null;
  busy: string | null;
  run: Run;
  onDone: (key: AppKey) => void;
}) {
  const { adapter } = useChain();
  const t = useT();
  const [text, setText] = useState("");
  const [to, setTo] = useState("");
  const amount = parseAmount(text, 0);
  const validTo = /^0x[0-9a-fA-F]{40}$/.test(to.trim());

  const go = async (name: "wrap" | "unwrap" | "send") => {
    if (!amount) return;
    const ok = await run(name, async (o) => {
      if (name === "wrap") await adapter.wrap(amount, o);
      else if (name === "unwrap") await adapter.unwrap(amount, o);
      else await adapter.sendCroquettes(to.trim(), amount, o);
      return true;
    });
    if (ok) {
      setText("");
      onDone(name === "wrap" ? "pantry.wrapped" : name === "unwrap" ? "pantry.unwrapped" : "pantry.sent");
    }
  };

  return (
    <>
      <p className="fine">{t("pantry.bridgeIntro", { plain: economy.symbol, hidden: economy.confidentialSymbol })}</p>
      <form className="find pantry-form" onSubmit={(e) => e.preventDefault()}>
        <label htmlFor="bridge-amount">{t("pantry.amount")}</label>
        <input id="bridge-amount" inputMode="numeric" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} placeholder="100" disabled={!!busy} />
      </form>
      <div className="actions">
        <button type="button" className="plain-button" onClick={() => void go("wrap")} disabled={!!busy || !amount || (plain !== null && amount > plain)}>
          {busy === "wrap" ? t("pantry.wrapping") : t("pantry.wrap", { plain: economy.symbol, hidden: economy.confidentialSymbol })}
        </button>
        <button type="button" className="plain-button" onClick={() => void go("unwrap")} disabled={!!busy || !amount}>
          {busy === "unwrap" ? t("pantry.unwrapping") : t("pantry.unwrap", { plain: economy.symbol, hidden: economy.confidentialSymbol })}
        </button>
      </div>
      <form
        className="find pantry-form"
        onSubmit={(e) => {
          e.preventDefault();
          void go("send");
        }}
      >
        <label htmlFor="send-to">{t("pantry.sendTo")}</label>
        <input id="send-to" autoComplete="off" spellCheck={false} value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" disabled={!!busy} />
        <button type="submit" className="plain-button" disabled={!!busy || !amount || !validTo}>
          {busy === "send" ? t("pantry.sending") : t("pantry.send")}
        </button>
      </form>
      <p className="fine">{hidden !== null && amount && amount > hidden ? t("pantry.tooMuch") : t("pantry.bridgeNote")}</p>
    </>
  );
}

function Rules({ economy }: { economy: EconomyInfo }) {
  const t = useT();
  const pct = (bps: number) => `${bps / 100}%`;
  const parts = gameSpec.economy.allocation;
  const total = Number(economy.totalSupply);
  return (
    <>
      <p className="fine">{t("pantry.rulesIntro", { supply: total.toLocaleString(), plain: economy.symbol, hidden: economy.confidentialSymbol })}</p>
      <ul className="pantry-split" aria-label={t("pantry.split")}>
        {parts.map((p) => (
          <li key={p.key} style={{ flexGrow: p.amount }}>
            <span>{t(`pantry.alloc.${p.key}` as AppKey)}</span>
            <strong>{Math.round((p.amount / total) * 100)}%</strong>
          </li>
        ))}
      </ul>
      <ul className="marks">
        <li>{t("pantry.ruleBag", { n: economy.welcomeBag })}</li>
        <li>{t("pantry.rulePurr", { max: economy.purrMaxPerDay, vet: economy.vetMultiplier, days: economy.purrMaxDays })}</li>
        <li>{economy.halvings > 0 ? t("pantry.ruleHalvedCount", { count: economy.halvings }) : t("pantry.ruleHalving")}</li>
        <li>{t("pantry.ruleMeal", { burn: pct(economy.mealBurnBps), keep: pct(10_000 - economy.mealBurnBps) })}</li>
      </ul>
      <table className="pantry-payouts">
        <caption>{t("pantry.payouts")}</caption>
        <tbody>
          {STATE_KEYS.map((key, id) => (
            <tr key={key}>
              <th scope="row">{t(`state.${key}` as AppKey)}</th>
              <td>{economy.payoutBps[id] === 0 ? t("pantry.allBurnt") : t("pantry.paid", { pct: pct(economy.payoutBps[id]!) })}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="fine after-table">
        {t("pantry.secret")}{" "}
        {economy.links.pantry && (
          <a className="link" href={economy.links.pantry} target="_blank" rel="noreferrer">
            {t("pantry.contract")}
          </a>
        )}
      </p>
    </>
  );
}
