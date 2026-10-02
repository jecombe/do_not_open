import { useCallback, useEffect, useMemo, useState } from "react";
import { formatAmount, type BoxPantry, type EconomyInfo } from "@dno/chain-adapter";
import { spec as gameSpec } from "@dno/game-spec";
import type { QualitySettings, ShakeSound } from "@dno/scene";
import { useAction, useChain } from "../chain/ChainProvider";
import { stepCopy, type Problem } from "../chain/copy";
import { useT, type AppKey } from "../i18n/app";
import { buildName } from "../i18n/names";
import { ShelfScene, SHELF_CAPACITY } from "../scenes/Scenes";
import { Stage } from "./Stage";
import { useFold } from "./useFold";
import { ProblemNote } from "./ProblemNote";
import { openExchange } from "./exchangeLink";

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

const { weight: WEIGHT } = gameSpec.economy;

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
          <Market economy={economy} decimals={economy.market?.quote.decimals ?? 6} symbol={economy.market?.quote.symbol ?? "USDC"} busy={action.busy} />
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

function Feedback({ busy, step, error, done, children }: { busy: string | null; step: Parameters<typeof stepCopy>[0]; error: Problem | null; done: AppKey | null; children: React.ReactNode }) {
  const t = useT();
  return (
    <div className="felt" aria-live="polite">
      {error ? (
        <ProblemNote problem={error} />
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

/** The pool's price and depth. Trades happen at the bureau de change, with their quote and slippage. */
function Market({ economy, decimals, symbol, busy }: { economy: EconomyInfo; decimals: number; symbol: string; busy: string | null }) {
  const t = useT();
  const market = economy.market;
  if (!market) return <p className="state-note">{t("pantry.noMarket")}</p>;

  // The pool's own price, before fees: coin per thousand croquettes.
  const perThousand = market.croqReserve > 0n ? (market.quoteReserve * 1000n) / market.croqReserve : 0n;

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
          <dd>{coin(market.quoteReserve, decimals)}</dd>
        </div>
      </dl>
      <p className="fine">{t("pantry.priceNote", { symbol, market: market.name })}</p>
      <div className="actions">
        <button type="button" className="plain-button" onClick={() => openExchange({ from: "usdc", to: "croq" })} disabled={!!busy}>
          {t("pantry.buy")}
        </button>
        <button type="button" className="plain-button" onClick={() => openExchange({ from: "croq", to: "usdc" })} disabled={!!busy}>
          {t("pantry.sell")}
        </button>
      </div>
      <p className="fine">{t("pantry.marketHint")}</p>
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

  const send = async () => {
    if (!amount) return;
    const ok = await run("send", async (o) => {
      await adapter.sendCroquettes(to.trim(), amount, o);
      return true;
    });
    if (ok) {
      setText("");
      onDone("pantry.sent");
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
        <button type="button" className="plain-button" onClick={() => openExchange({ from: "croq", to: "ccroq", amount: amount ?? undefined })} disabled={!!busy}>
          {t("pantry.wrap", { plain: economy.symbol, hidden: economy.confidentialSymbol })}
        </button>
        <button type="button" className="plain-button" onClick={() => openExchange({ from: "ccroq", to: "croq", amount: amount ?? undefined })} disabled={!!busy}>
          {t("pantry.unwrap", { plain: economy.symbol, hidden: economy.confidentialSymbol })}
        </button>
      </div>
      <form
        className="find pantry-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
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
  const meal = [
    { key: "treasury" as const, bps: economy.mealTreasuryBps },
    { key: "reserve" as const, bps: 10_000 - economy.mealTreasuryBps - economy.mealBurnBps },
    { key: "burn" as const, bps: economy.mealBurnBps },
  ];
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
        <li>{t("pantry.ruleMeal", { meals: economy.mealsPerDay, cap: Number(economy.maxEatenPerDay).toLocaleString() })}</li>
      </ul>
      <ul className="pantry-split" aria-label={t("pantry.mealSplit")}>
        {meal.map((p) => (
          <li key={p.key} style={{ flexGrow: p.bps }}>
            <span>{t(`pantry.meal.${p.key}`)}</span>
            <strong>{pct(p.bps)}</strong>
          </li>
        ))}
      </ul>
      <table className="pantry-payouts">
        <caption>{t("pantry.builds")}</caption>
        <tbody>
          {WEIGHT.builds.slice(2).map((b) => (
            <tr key={b.key}>
              <th scope="row">{buildName(b.key)}</th>
              <td>{t("pantry.buildFrom", { n: b.minWeight.toLocaleString(), days: Math.ceil(b.minWeight / Number(economy.maxEatenPerDay)) })}</td>
            </tr>
          ))}
          <tr>
            <th scope="row">{t("pantry.sick")}</th>
            <td>
              {t("pantry.sickFrom", {
                min: WEIGHT.sick.minWeight.toLocaleString(),
                max: (WEIGHT.sick.minWeight + WEIGHT.sick.weightSpread).toLocaleString(),
              })}
            </td>
          </tr>
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
