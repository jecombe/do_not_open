import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { formatAmount, type EconomyInfo, type Step } from "@dno/chain-adapter";
import { useChain } from "../chain/ChainProvider";
import { problemOf, stepCopy, type Problem } from "../chain/copy";
import {
  canKeep,
  DECRYPTS,
  deskOf,
  findRoute,
  publicBalance,
  quoteRoute,
  reachable,
  runRoute,
  StoppedAt,
  SWAPS,
  TOKENS,
  txCount,
  type Desk,
  type Leg,
  type LegKind,
  type Quote,
  type TokenInfo,
  type TokenKey,
} from "../chain/exchange";
import { useShielded } from "../chain/shielded";
import { useT, type AppKey } from "../i18n/app";
import { takePreset, onOpenExchange, type ExchangePreset } from "./exchangeLink";
import { parseAmount } from "./PantryView";
import { ProblemNote } from "./ProblemNote";
import { BoxSpinner } from "./TxPending";
import "./exchange.css";

/** Kept for gas when "Max" is pressed on the chain's own coin, in thousandths of a coin. */
const GAS_RESERVE_MILLI = 3n;
const SLIPPAGE_PRESETS = [50, 100, 200];

/** The user's slippage tolerance, in basis points, kept across visits. */
const SLIP_KEY = "dno.slippage";
const slipListeners = new Set<() => void>();
let slippage = (() => {
  try {
    const n = Number(localStorage.getItem(SLIP_KEY));
    return Number.isInteger(n) && n >= 1 && n <= 5_000 ? n : 100;
  } catch {
    return 100;
  }
})();
function setSlippage(bps: number) {
  slippage = bps;
  try {
    localStorage.setItem(SLIP_KEY, String(bps));
  } catch {
    // Private mode: it lasts for this visit.
  }
  for (const l of slipListeners) l();
}
const useSlippage = () =>
  useSyncExternalStore(
    (l) => {
      slipListeners.add(l);
      return () => slipListeners.delete(l);
    },
    () => slippage,
  );

/** Shares of a cUSDC purchase that can be kept as plain USDC, for decryption credits, in basis points. */
const KEEP_PRESETS = [0, 500, 1000, 2000];
const KEEP_KEY = "dno.keepUsdc";
function storedKeep(): number {
  try {
    const n = Number(localStorage.getItem(KEEP_KEY));
    return KEEP_PRESETS.includes(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** "1,234.5678" for a token amount: grouped, at most six decimals, never a dust amount shown as zero. */
function show(amount: bigint, decimals: number, places = 6): string {
  const [whole, frac = ""] = formatAmount(amount < 0n ? -amount : amount, decimals).split(".");
  const kept = frac.slice(0, places).replace(/0+$/, "");
  if (whole === "0" && !kept && frac) return `< 0.${"0".repeat(places - 1)}1`;
  const grouped = BigInt(whole!).toLocaleString("en-US");
  return kept ? `${grouped}.${kept}` : grouped;
}

/** A plain-text rate, like "2,492.5": six significant digits are plenty. */
function rate(out: bigint, outDec: number, inn: bigint, inDec: number): string {
  if (inn <= 0n) return "—";
  const r = Number(out) / 10 ** outDec / (Number(inn) / 10 ** inDec);
  if (!Number.isFinite(r)) return "—";
  return r >= 1 ? r.toLocaleString("en-US", { maximumFractionDigits: 4 }) : r.toPrecision(4);
}

const pct = (bps: number) => `${bps / 100}%`;

const LEG_LABEL: Record<LegKind, AppKey> = {
  ramp: "ex.leg.ramp",
  rampShield: "ex.leg.rampShield",
  shield: "ex.leg.shield",
  unshield: "ex.leg.unshield",
  buyCroq: "ex.leg.buyCroq",
  sellCroq: "ex.leg.sellCroq",
  wrap: "ex.leg.wrap",
  unwrap: "ex.leg.unwrap",
};

const LEG_PUBLIC: Record<LegKind, AppKey> = {
  ramp: "ex.public.ramp",
  rampShield: "ex.public.rampShield",
  shield: "ex.public.shield",
  unshield: "ex.public.unshield",
  buyCroq: "ex.public.market",
  sellCroq: "ex.public.market",
  wrap: "ex.public.wrap",
  unwrap: "ex.public.unwrap",
};

/** The one-word verb on the stamp when the route is a single leg. */
const LEG_VERB: Record<LegKind, AppKey> = {
  ramp: "ex.verb.buy",
  rampShield: "ex.verb.buy",
  shield: "ex.verb.shield",
  unshield: "ex.verb.unshield",
  buyCroq: "ex.verb.buy",
  sellCroq: "ex.verb.sell",
  wrap: "ex.verb.wrap",
  unwrap: "ex.verb.unwrap",
};

/** One-click pairs for what people come here for most. */
const QUICK: { label: AppKey; from: TokenKey; to: TokenKey }[] = [
  { label: "ex.quick.buyUsdc", from: "eth", to: "cusdc" },
  { label: "ex.quick.shield", from: "usdc", to: "cusdc" },
  { label: "ex.quick.unshield", from: "cusdc", to: "usdc" },
  { label: "ex.quick.buyCroq", from: "usdc", to: "croq" },
  { label: "ex.quick.wrap", from: "croq", to: "ccroq" },
];

type Phase = { kind: "idle" } | { kind: "running"; leg: number; step: Step | null } | { kind: "done"; received: bigint | null; kept: bigint; to: TokenKey; legs: number } | { kind: "failed"; problem: Problem; stoppedAt: number | null };

/**
 * The bureau de change: hand over one token, get another. Buying USDC with ETH, shielding it
 * into cUSDC and back, trading CROQ and sealing it into cCROQ are all the same form; pairs
 * with no direct way are routed through the public tokens in between, one transaction a step.
 */
export function ExchangeView() {
  const { adapter, account, collection, connect } = useChain();
  const t = useT();
  const slip = useSlippage();
  const formId = useId();
  const [economy, setEconomy] = useState<EconomyInfo | null | "none">(null);
  const [from, setFrom] = useState<TokenKey>("eth");
  const [to, setTo] = useState<TokenKey>("cusdc");
  const [text, setText] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteFailed, setQuoteFailed] = useState(false);
  const [picking, setPicking] = useState<"from" | "to" | null>(null);
  const [settings, setSettings] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [inverted, setInverted] = useState(false);
  const [details, setDetails] = useState(false);
  const detailsRef = useRef<HTMLDivElement>(null);
  // Opened details unfold under the stamp: on a short screen, bring them up.
  useEffect(() => {
    if (details) detailsRef.current?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [details]);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [balances, setBalances] = useState<Partial<Record<TokenKey, bigint>>>({});
  const [sealedCroq, setSealedCroq] = useState<bigint | null>(null);
  const [revealing, setRevealing] = useState<TokenKey | null>(null);
  const [tick, setTick] = useState(0);
  const [keepBps, setKeepBps] = useState(storedKeep);
  const [creditPrice, setCreditPrice] = useState<bigint | null>(null);
  const running = phase.kind === "running";
  const shielded = useShielded(running ? "running" : tick);

  // The croquettes may not be deployed on every network: the desk then offers what it can.
  useEffect(() => {
    let live = true;
    adapter.economy().then(
      (e) => live && setEconomy(e),
      () => live && setEconomy("none"),
    );
    return () => {
      live = false;
    };
  }, [adapter, tick]);

  const desk: Desk | null = useMemo(() => (collection && economy !== null ? deskOf(collection, economy === "none" ? null : economy) : null), [collection, economy]);

  const [presetAmount, setPresetAmount] = useState<bigint | null>(null);
  const applyPreset = useCallback((p: ExchangePreset | null) => {
    if (!p) return;
    if (p.from) setFrom(p.from);
    if (p.to) setTo(p.to);
    setText("");
    setPhase({ kind: "idle" });
    if (p.amount !== undefined) setPresetAmount(p.amount);
  }, []);
  useEffect(() => {
    applyPreset(takePreset());
    return onOpenExchange(() => applyPreset(takePreset()));
  }, [applyPreset]);
  useEffect(() => {
    if (presetAmount === null || !desk) return;
    setText(formatAmount(presetAmount, desk.tokens[from].decimals));
    setPresetAmount(null);
  }, [presetAmount, desk, from]);

  // Public balances, read on arrival and after every exchange.
  useEffect(() => {
    if (!account || running) return;
    let live = true;
    for (const k of ["eth", "usdc", "croq"] as const) {
      if (k === "croq" && economy === "none") continue;
      publicBalance(adapter, account, k).then(
        (v) => live && v !== null && setBalances((b) => ({ ...b, [k]: v })),
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
  }, [adapter, account, running, economy, tick]);
  useEffect(() => {
    setBalances({});
    setSealedCroq(null);
  }, [account]);

  // What a decryption credit costs, to tell how many the kept USDC buys. Null where nobody sells them.
  useEffect(() => {
    if (!account) return;
    let live = true;
    adapter.decryptionAllowance().then(
      (a) => live && setCreditPrice(a?.price ?? null),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [adapter, account]);

  const route = useMemo(() => (desk ? findRoute(desk, from, to) : null), [desk, from, to]);
  const keep = route && canKeep(route) ? keepBps : 0;
  const chooseKeep = (bps: number) => {
    setKeepBps(bps);
    try {
      localStorage.setItem(KEEP_KEY, String(bps));
    } catch {
      // Private mode: it lasts for this visit.
    }
  };
  const fromInfo = desk?.tokens[from];
  const toInfo = desk?.tokens[to];
  const amount = fromInfo ? parseAmount(text, fromInfo.decimals) : null;

  const sealedValue = (k: TokenKey): bigint | null => (k === "cusdc" ? (shielded.known && !shielded.stale ? shielded.known.value : null) : k === "ccroq" ? sealedCroq : null);
  const held = (k: TokenKey): bigint | null => (desk?.tokens[k].sealed ? sealedValue(k) : (balances[k] ?? null));

  // A fresh quote a moment after the user stops typing, and again every 20 seconds.
  useEffect(() => {
    // While a route runs, the quote it started from stays on screen.
    if (running) return;
    setQuote(null);
    setQuoteFailed(false);
    if (!desk || !route || !amount) return;
    let live = true;
    const ask = () => {
      setQuoting(true);
      quoteRoute(adapter, desk, route, amount, slip, keep).then(
        (q) => {
          if (!live) return;
          setQuote(q);
          setQuoteFailed(false);
          setQuoting(false);
        },
        () => {
          if (!live) return;
          setQuoteFailed(true);
          setQuoting(false);
        },
      );
    };
    const first = setTimeout(ask, 300);
    const again = setInterval(ask, 20_000);
    return () => {
      live = false;
      clearTimeout(first);
      clearInterval(again);
      setQuoting(false);
    };
  }, [adapter, desk, route, amount, slip, keep, running]);

  const pick = (side: "from" | "to", k: TokenKey) => {
    setPicking(null);
    setPhase({ kind: "idle" });
    if (side === "from") {
      if (k === from) return;
      // Keep the wanted token if it can still be had from the new one, else the first that can.
      let next = k === to ? from : to;
      if (desk && (next === "eth" || !findRoute(desk, k, next))) next = [...reachable(desk, k)][0] ?? to;
      setFrom(k);
      setTo(next);
      setText("");
    } else {
      if (k === from) setFrom(to);
      setTo(k);
    }
  };

  const canFlip = to !== "eth" && from !== "eth";
  const flip = () => {
    if (!canFlip || running) return;
    setFlipped((f) => !f);
    setFrom(to);
    setTo(from);
    setText(quote && toInfo ? formatAmount(quote.amountOut, toInfo.decimals) : "");
    setPhase({ kind: "idle" });
  };

  const setMax = () => {
    if (!fromInfo) return;
    let v = held(from);
    if (v === null) return;
    if (from === "eth") v -= (GAS_RESERVE_MILLI * 10n ** BigInt(fromInfo.decimals)) / 1000n;
    if (v <= 0n) return;
    setText(formatAmount(v, fromInfo.decimals));
  };

  const reveal = async (k: TokenKey) => {
    if (revealing) return;
    setRevealing(k);
    try {
      if (k === "cusdc") await shielded.reveal();
      else setSealedCroq(await adapter.confidentialBalance());
    } catch (error) {
      console.error("[exchange] decrypt failed", error);
    } finally {
      setRevealing(null);
    }
  };

  const go = async () => {
    if (!account || !route || !amount || !desk) return;
    setPhase({ kind: "running", leg: 0, step: null });
    let leg = 0;
    try {
      const { received, kept } = await runRoute(
        adapter,
        account,
        route,
        amount,
        slip,
        { onStep: (step) => setPhase((p) => (p.kind === "running" ? { ...p, step } : p)) },
        (i) => {
          leg = i;
          setPhase({ kind: "running", leg: i, step: null });
        },
        keep,
      );
      setPhase({ kind: "done", received, kept, to, legs: route.length });
      setText("");
      // A cCROQ balance decrypted before is out of date once the route went through it.
      if (route.some((l) => l.from === "ccroq" || l.to === "ccroq")) setSealedCroq(null);
    } catch (error) {
      console.error("[exchange] failed", error);
      if (error instanceof StoppedAt) {
        const l = route[error.index]!;
        const text =
          error.index === 0
            ? t("ex.stopped.first", { from: desk.tokens[l.from].symbol })
            : t("ex.stopped.later", { n: error.index + 1, kept: desk.tokens[l.from].symbol });
        setPhase({ kind: "failed", problem: { text, hints: [], txUrl: null, fix: null }, stoppedAt: error.index });
      } else {
        const problem = problemOf(error, { collection });
        if (leg > 0) problem.hints.unshift(t("ex.stopped.partial", { n: leg + 1, kept: desk.tokens[route[leg]!.from].symbol }));
        setPhase({ kind: "failed", problem, stoppedAt: leg });
      }
    } finally {
      setTick((n) => n + 1);
    }
  };

  // --- what the stamp says, and whether it can be pressed
  const heldFrom = held(from);
  const short = !!amount && heldFrom !== null && amount > heldFrom;
  const worstImpact = quote ? Math.max(0, ...quote.legs.map((l) => l.impact ?? 0)) : 0;
  let stamp: string;
  let ready = false;
  if (!account) stamp = t("nav.connect");
  else if (!desk) stamp = t("ex.reading");
  else if (!route) stamp = t("ex.noRoute");
  else if (!amount) stamp = t("ex.enterAmount");
  else if (short) stamp = t("ex.short", { symbol: fromInfo!.symbol });
  else if (quoteFailed) stamp = t("ex.quoteFailed");
  else if (!quote) stamp = t("ex.quoting");
  // A pool leg that gives nothing: CROQ before anyone has bought, or past the end of its range.
  else if (quote.legs.some((l) => (l.kind === "buyCroq" || l.kind === "sellCroq") && l.amountOut === 0n)) stamp = t("ex.noBuyers");
  else {
    ready = true;
    const verb = route.length === 1 ? t(LEG_VERB[route[0]!.kind]) : t("ex.verb.swapSteps", { n: route.length });
    stamp = worstImpact > 0.05 ? t("ex.verb.anyway", { verb }) : verb;
  }

  return (
    <main className="bureau" aria-labelledby={`${formId}-title`}>
      <div className="bureau-sign" aria-hidden="true">
        DO NOT OPEN · DO NOT OPEN · DO NOT OPEN
      </div>
      <header className="bureau-head">
        <h2 id={`${formId}-title`} className="bureau-title">
          {t("ex.title")}
        </h2>
        <p className="bureau-tagline">{t("ex.tagline")}</p>
      </header>

      <div className="bureau-grid">
        <section className="counter" aria-label={t("ex.title")}>
          <div className="counter-tape" aria-hidden="true" />
          {/* While a route runs, the slip gives way to the rattled box and its steps. */}
          {phase.kind === "running" && desk && route && (
            <div className="tx-pending" role="status" aria-live="polite">
              <BoxSpinner />
              <p className="tx-title">{t("tx.working")}</p>
              <Progress desk={desk} route={route} keepBps={keep} leg={phase.leg} step={phase.step} />
            </div>
          )}
          <div className="tx-body" hidden={running}>
            <div className="counter-top">
              <div className="quick" role="group" aria-label={t("ex.quickLabel")}>
                {QUICK.filter((q) => desk && findRoute(desk, q.from, q.to)).map((q) => (
                  <button
                    type="button"
                    key={q.label}
                    aria-pressed={from === q.from && to === q.to}
                    onClick={() => applyPreset({ from: q.from, to: q.to })}
                    disabled={running}
                  >
                    {t(q.label)}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className={`gear${settings ? " is-open" : ""}`}
                aria-expanded={settings}
                aria-controls={`${formId}-settings`}
                onClick={() => setSettings((s) => !s)}
                title={t("ex.settings")}
              >
                <span className="gear-value">{pct(slip)}</span>
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M19.4 13a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.5 7.5 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"
                    transform="translate(-1 0)"
                  />
                </svg>
              </button>
            </div>

            {settings && <Settings id={`${formId}-settings`} onClose={() => setSettings(false)} />}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!account) void connect();
                else if (ready) void go();
              }}
            >
              <div className="crate">
                <div className="crate-row">
                  <label htmlFor={`${formId}-in`} className="crate-label">
                    {t("ex.youGive")}
                  </label>
                  {account && fromInfo && (
                    <Holding token={fromInfo} value={held(from)} onMax={setMax} onReveal={() => void reveal(from)} revealing={revealing === from} disabled={running} />
                  )}
                </div>
                <div className="crate-row">
                  <input
                    id={`${formId}-in`}
                    className="crate-amount"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0"
                    value={text}
                    onChange={(e) => {
                      setText(e.target.value);
                      if (phase.kind !== "running") setPhase({ kind: "idle" });
                    }}
                    disabled={running}
                    aria-invalid={short || undefined}
                  />
                  {fromInfo && <TokenButton token={fromInfo} onClick={() => setPicking(picking === "from" ? null : "from")} disabled={running} expanded={picking === "from"} />}
                </div>
                {picking === "from" && desk && (
                  <TokenList desk={desk} side="from" current={from} other={to} held={held} onPick={(k) => pick("from", k)} onClose={() => setPicking(null)} />
                )}
              </div>

              <div className="flip-wrap">
                <button type="button" className={`flip${flipped ? " is-flipped" : ""}`} onClick={flip} disabled={!canFlip || running} title={canFlip ? t("ex.flip") : t("ex.flipNo")} aria-label={t("ex.flip")}>
                  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                    <path fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="square" d="M12 4v15M6 13l6 6 6-6" />
                  </svg>
                </button>
              </div>

              <div className={`crate is-receive${toInfo?.sealed ? " is-sealed" : ""}`}>
                <div className="crate-row">
                  <span className="crate-label">{t("ex.youGet")}</span>
                  {account && toInfo && <Holding token={toInfo} value={held(to)} onReveal={() => void reveal(to)} revealing={revealing === to} disabled={running} />}
                </div>
                <div className="crate-row">
                  <output className={`crate-amount${quoting && !quote ? " is-quoting" : ""}`} htmlFor={`${formId}-in`} aria-live="polite">
                    {quote && toInfo ? (
                      <>
                        <span className="approx">≈</span>
                        {show(quote.amountOut, toInfo.decimals)}
                      </>
                    ) : (
                      <span className="crate-placeholder">0</span>
                    )}
                  </output>
                  {toInfo && <TokenButton token={toInfo} onClick={() => setPicking(picking === "to" ? null : "to")} disabled={running} expanded={picking === "to"} />}
                </div>
                {quote && quote.kept > 0n && desk && (
                  <p className="crate-note crate-kept">
                    {t("ex.keep.plus", { amount: show(quote.kept, desk.tokens.usdc.decimals), symbol: desk.tokens.usdc.symbol })}
                  </p>
                )}
                {route && canKeep(route) && desk && !running && phase.kind !== "done" && <KeepPicker id={`${formId}-keep`} desk={desk} keepBps={keepBps} onPick={chooseKeep} disabled={running} />}
                {picking === "to" && desk && <TokenList desk={desk} side="to" current={to} other={from} held={held} onPick={(k) => pick("to", k)} onClose={() => setPicking(null)} />}
              </div>

              {phase.kind === "running" ? null : phase.kind === "done" ? (
                <Done desk={desk!} phase={phase} onReveal={() => void reveal(phase.to)} revealing={revealing === phase.to} sealedShown={sealedValue(phase.to)} onAgain={() => setPhase({ kind: "idle" })} />
              ) : (
                <>
                  {desk && route && fromInfo && toInfo && (
                    <div className="summary">
                      <span className="summary-line">
                        {quote ? (
                          <button type="button" className="link" onClick={() => setInverted((v) => !v)} title={t("ex.invert")}>
                            {inverted
                              ? `1 ${toInfo.symbol} = ${rate(quote.amountIn, fromInfo.decimals, quote.amountOut + quote.kept, toInfo.decimals)} ${fromInfo.symbol}`
                              : `1 ${fromInfo.symbol} = ${rate(quote.amountOut + quote.kept, toInfo.decimals, quote.amountIn, fromInfo.decimals)} ${toInfo.symbol}`}
                          </button>
                        ) : (
                          <span>{t("ex.route")}</span>
                        )}
                        <span className="summary-txs">· {t("ex.txs", { n: txCount(route, keep) })}</span>
                        {worstImpact > 0.02 && <span className={`summary-impact ${worstImpact > 0.05 ? "is-bad" : "is-warn"}`}>· {(worstImpact * 100).toFixed(1)}%</span>}
                      </span>
                      <button type="button" className="summary-toggle" aria-expanded={details} aria-controls={`${formId}-details`} onClick={() => setDetails((d) => !d)}>
                        {t("ex.details")}
                        <span className="caret" aria-hidden="true" />
                      </button>
                    </div>
                  )}
                  {quote && worstImpact > 0.05 && <p className="fine problem counter-hint">{t("ex.impactWarn", { pct: (worstImpact * 100).toFixed(1) })}</p>}
                  {phase.kind === "failed" && (
                    <div className="counter-problem">
                      <ProblemNote problem={phase.problem} />
                    </div>
                  )}
                  {!!amount && desk?.tokens[from].sealed && heldFrom === null && <p className="fine counter-hint">{t("ex.sealedUnknown", { symbol: fromInfo!.symbol })}</p>}
                </>
              )}

              {phase.kind !== "running" && phase.kind !== "done" && (
                <button type="submit" className={`stamp-button counter-go${worstImpact > 0.05 && ready ? " is-risky" : ""}`} disabled={!!account && !ready}>
                  {stamp}
                </button>
              )}
              {details && phase.kind !== "running" && phase.kind !== "done" && desk && route && fromInfo && toInfo && (
                <div className="details" id={`${formId}-details`} ref={detailsRef}>
                  <RouteStrip desk={desk} route={route} keepBps={keep} />
                  {toInfo.sealed && <p className="fine">{t("ex.landsSealed", { symbol: toInfo.symbol })}</p>}
                  {canKeep(route) && <p className="fine">{t("ex.keep.hint", { symbol: desk.tokens.usdc.symbol, sealed: desk.tokens.cusdc.symbol })}</p>}
                  {quote && (
                    <Manifest desk={desk} quote={quote} to={toInfo} slip={slip} onSlippage={() => setSettings(true)} impact={worstImpact} route={route} keepBps={keep} creditPrice={creditPrice} />
                  )}
                </div>
              )}
            </form>
          </div>
        </section>

        <Ledger desk={desk} held={held} sealedKnown={(k) => sealedValue(k) !== null} revealing={revealing} onReveal={(k) => void reveal(k)} onPick={(k) => pick("from", k)} current={from} onDone={() => setTick((n) => n + 1)} disabled={running} />
      </div>
    </main>
  );
}

function Coin({ token }: { token: TokenInfo }) {
  const glyph = token.key === "eth" ? "Ξ" : token.key === "usdc" || token.key === "cusdc" ? "$" : "◆";
  return (
    <span className={`coin coin-${token.key}${token.sealed ? " is-sealed" : ""}`} aria-hidden="true">
      {glyph}
    </span>
  );
}

function TokenButton({ token, onClick, disabled, expanded }: { token: TokenInfo; onClick: () => void; disabled: boolean; expanded: boolean }) {
  const t = useT();
  return (
    <button type="button" className="token-button" onClick={onClick} disabled={disabled} aria-expanded={expanded} aria-haspopup="listbox" title={t("ex.pickToken")}>
      <Coin token={token} />
      <span className="token-symbol">{token.symbol}</span>
      <span className="caret" aria-hidden="true" />
    </button>
  );
}

function Holding(props: { token: TokenInfo; value: bigint | null; onMax?: () => void; onReveal: () => void; revealing: boolean; disabled: boolean }) {
  const { token, value, onMax, onReveal, revealing, disabled } = props;
  const t = useT();
  if (token.sealed && value === null) {
    return (
      <span className="holding">
        {t("ex.balance")} <span className="sealed-dots">••••</span>{" "}
        <button type="button" className="link" onClick={onReveal} disabled={disabled || revealing}>
          {revealing ? t("ex.decrypting") : t("ex.decrypt")}
        </button>
      </span>
    );
  }
  return (
    <span className="holding">
      {t("ex.balance")} {value === null ? "…" : show(value, token.decimals, 4)}
      {onMax && value !== null && value > 0n && (
        <button type="button" className="max" onClick={onMax} disabled={disabled}>
          {t("ex.max")}
        </button>
      )}
    </span>
  );
}

/** The token picker, laid over the crate it belongs to. */
function TokenList(props: { desk: Desk; side: "from" | "to"; current: TokenKey; other: TokenKey; held: (k: TokenKey) => bigint | null; onPick: (k: TokenKey) => void; onClose: () => void }) {
  const { desk, side, current, other, held, onPick, onClose } = props;
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = root.current;
    (list?.querySelector<HTMLButtonElement>("button[aria-selected='true']:not(:disabled)") ?? list?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onPointer = (e: PointerEvent) => !root.current?.contains(e.target as Node) && onClose();
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [onClose]);
  // From where the user hands over, which tokens can be had; and the reverse for "from".
  const ways = side === "to" ? reachable(desk, other) : null;
  return (
    <div className="token-list" ref={root} role="listbox" aria-label={side === "from" ? t("ex.youGive") : t("ex.youGet")}>
      {TOKENS.map((k) => {
        const info = desk.tokens[k];
        const off = side === "to" ? k === "eth" || (k !== other && !ways!.has(k)) : !desk.croq && (k === "croq" || k === "ccroq");
        const v = held(k);
        return (
          <button type="button" role="option" key={k} aria-selected={k === current} disabled={off} onClick={() => onPick(k)}>
            <Coin token={info} />
            <span className="token-name">
              <strong>{info.symbol}</strong>
              <small>{t(info.sealed ? "ex.sealed" : "ex.plain")}</small>
            </span>
            <span className="token-held">{off ? t("ex.noWay") : info.sealed && v === null ? "••••" : v === null ? "" : show(v, info.decimals, 4)}</span>
          </button>
        );
      })}
    </div>
  );
}

function Settings({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT();
  const slip = useSlippage();
  const [custom, setCustom] = useState(SLIPPAGE_PRESETS.includes(slip) ? "" : String(slip / 100));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const applyCustom = (v: string) => {
    setCustom(v);
    const n = Number(v.replace(",", "."));
    if (Number.isFinite(n) && n >= 0.01 && n <= 50) setSlippage(Math.round(n * 100));
  };
  return (
    <div className="settings" id={id} role="group" aria-label={t("ex.settings")}>
      <div className="settings-head">
        <span>{t("ex.slippage")}</span>
        <button type="button" className="link" onClick={onClose}>
          {t("ex.close")}
        </button>
      </div>
      <div className="settings-row">
        {SLIPPAGE_PRESETS.map((bps) => (
          <button
            type="button"
            key={bps}
            aria-pressed={slip === bps}
            onClick={() => {
              setCustom("");
              setSlippage(bps);
            }}
          >
            {pct(bps)}
          </button>
        ))}
        <label className="settings-custom">
          <input inputMode="decimal" placeholder={t("ex.custom")} value={custom} onChange={(e) => applyCustom(e.target.value)} aria-label={t("ex.customLabel")} />
          <span>%</span>
        </label>
      </div>
      <p className="fine">{slip < 10 ? t("ex.slipLow") : slip > 500 ? t("ex.slipHigh") : t("ex.slipHint")}</p>
    </div>
  );
}

/** How much of a cUSDC purchase stays plain USDC, for decryption credits. */
function KeepPicker({ id, desk, keepBps, onPick, disabled }: { id: string; desk: Desk; keepBps: number; onPick: (bps: number) => void; disabled: boolean }) {
  const t = useT();
  const usdc = desk.tokens.usdc.symbol;
  return (
    <div className="keep" role="group" aria-labelledby={`${id}-label`}>
      <span id={`${id}-label`} className="keep-label" title={t("ex.keep.label", { symbol: usdc })}>
        {t("ex.keep.short", { symbol: usdc })}
      </span>
      <div className="keep-row">
        {KEEP_PRESETS.map((bps) => (
          <button type="button" key={bps} aria-pressed={keepBps === bps} onClick={() => onPick(bps)} disabled={disabled}>
            {bps === 0 ? t("ex.keep.none") : pct(bps)}
          </button>
        ))}
      </div>
    </div>
  );
}

function RouteStrip({ desk, route, keepBps }: { desk: Desk; route: Leg[]; keepBps: number }) {
  const t = useT();
  const txs = txCount(route, keepBps);
  return (
    <div className="route" aria-label={t("ex.route")}>
      <span className="route-title">{txs === 1 ? t("ex.oneTx") : t("ex.nTx", { n: txs })}</span>
      <ol className="route-line">
        <li className="route-stop">
          <Coin token={desk.tokens[route[0]!.from]} />
          {desk.tokens[route[0]!.from].symbol}
        </li>
        {route.map((leg, i) => (
          <li key={i} className="route-hop">
            <span className="route-leg">{t(LEG_LABEL[leg.kind], { pct: pct(desk.rampBps ?? 0) })}</span>
            <span className="route-stop">
              <Coin token={desk.tokens[leg.to]} />
              {desk.tokens[leg.to].symbol}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Manifest(props: {
  desk: Desk;
  quote: Quote;
  to: TokenInfo;
  slip: number;
  onSlippage: () => void;
  impact: number;
  route: Leg[];
  keepBps: number;
  creditPrice: bigint | null;
}) {
  const { desk, quote, to, slip, onSlippage, impact, route, keepBps, creditPrice } = props;
  const usdc = desk.tokens.usdc;
  const t = useT();
  const hasSwap = quote.legs.some((l) => SWAPS.has(l.kind));
  const ramp = quote.legs.find((l) => l.kind === "ramp" || l.kind === "rampShield");
  const free = quote.legs.filter((l) => l.kind === "shield" || l.kind === "wrap" || l.kind === "unshield" || l.kind === "unwrap");
  const slow = quote.legs.some((l) => DECRYPTS.has(l.kind));
  const publics = [...new Set(quote.legs.map((l) => LEG_PUBLIC[l.kind]))];
  if (quote.kept > 0n) publics.push("ex.keep.public");
  const impactClass = impact > 0.05 ? "is-bad" : impact > 0.02 ? "is-warn" : "";
  return (
    <dl className="manifest">
      {ramp && desk.rampBps !== null && (
        <div>
          <dt>{t("ex.siteFee", { pct: pct(desk.rampBps) })}</dt>
          <dd>
            {show(ramp.fee, desk.tokens.eth.decimals)} {desk.tokens.eth.symbol}
          </dd>
        </div>
      )}
      {quote.legs.some((l) => l.impact !== null) && (
        <div>
          <dt>{t("ex.impact")}</dt>
          <dd className={impactClass}>{impact < 0.0001 ? "< 0.01%" : `${(impact * 100).toFixed(2)}%`}</dd>
        </div>
      )}
      {hasSwap && (
        <>
          <div>
            <dt>{t("ex.slippage")}</dt>
            <dd>
              <button type="button" className="link" onClick={onSlippage}>
                {pct(slip)}
              </button>
            </dd>
          </div>
          <div>
            <dt>{t("ex.minimum")}</dt>
            <dd>
              {show(quote.minOut, to.decimals)} {to.symbol}
            </dd>
          </div>
        </>
      )}
      {quote.kept > 0n && (
        <div>
          <dt>{t("ex.keep.row", { symbol: usdc.symbol })}</dt>
          <dd>
            {show(quote.kept, usdc.decimals)} {usdc.symbol}
            {creditPrice !== null && creditPrice > 0n && <small className="manifest-sub">{t("ex.keep.credits", { n: (quote.keptMin / creditPrice).toLocaleString("en-US") })}</small>}
          </dd>
        </div>
      )}
      {free.length > 0 && (
        <div>
          <dt>{t("ex.sealFee")}</dt>
          <dd>{t("ex.free")}</dd>
        </div>
      )}
      <div>
        <dt>{t("ex.gas")}</dt>
        <dd>{t("ex.gasValue", { coin: desk.tokens.eth.symbol, n: txCount(route, keepBps) })}</dd>
      </div>
      {slow && (
        <div>
          <dt>{t("ex.time")}</dt>
          <dd>{t("ex.timeSlow")}</dd>
        </div>
      )}
      <div className="manifest-public">
        <dt>{t("ex.whatShows")}</dt>
        <dd>
          <ul>
            {publics.map((k) => (
              <li key={k}>{t(k)}</li>
            ))}
          </ul>
        </dd>
      </div>
    </dl>
  );
}

function Progress({ desk, route, keepBps, leg, step }: { desk: Desk; route: Leg[]; keepBps: number; leg: number; step: Step | null }) {
  const t = useT();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => setSeconds(0), [leg, step]);
  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="progress" aria-live="polite">
      <ol>
        {route.map((l, i) => (
          <li key={i} className={i < leg ? "done" : i === leg ? "now" : undefined} aria-current={i === leg ? "step" : undefined}>
            <span className="tick" aria-hidden="true" />
            <span>
              {t("ex.stepOf", { n: i + 1, total: route.length })} · {desk.tokens[l.from].symbol} → {keepBps > 0 && i === route.length - 1 ? `${desk.tokens.usdc.symbol} + ` : ""}
              {desk.tokens[l.to].symbol}
              {i === leg && (
                <small>
                  {stepCopy(step)}
                  {seconds > 2 ? ` · ${t("track.seconds", { n: seconds })}` : ""}
                </small>
              )}
            </span>
          </li>
        ))}
      </ol>
      {DECRYPTS.has(route[leg]!.kind) && <p className="fine">{t("ex.decryptWait")}</p>}
      <p className="fine">{t("ex.keepOpen")}</p>
    </div>
  );
}

function Done(props: { desk: Desk; phase: Extract<Phase, { kind: "done" }>; onReveal: () => void; revealing: boolean; sealedShown: bigint | null; onAgain: () => void }) {
  const { desk, phase, onReveal, revealing, sealedShown, onAgain } = props;
  const t = useT();
  const token = desk.tokens[phase.to];
  return (
    <div className="ex-done" role="status">
      <p className="done-stamp" aria-hidden="true">
        {t("ex.doneStamp")}
      </p>
      {phase.received !== null ? (
        <p className="done-line">{t("ex.received", { amount: show(phase.received, token.decimals), symbol: token.symbol })}</p>
      ) : (
        <>
          <p className="done-line">{t("ex.receivedSealed", { symbol: token.symbol })}</p>
          <p className="fine">
            {sealedShown !== null ? (
              t("ex.sealedNow", { amount: show(sealedShown, token.decimals), symbol: token.symbol })
            ) : (
              <button type="button" className="link" onClick={onReveal} disabled={revealing}>
                {revealing ? t("ex.decrypting") : t("ex.decryptToSee")}
              </button>
            )}
          </p>
        </>
      )}
      {phase.kept > 0n && <p className="done-line">{t("ex.keep.received", { amount: show(phase.kept, desk.tokens.usdc.decimals), symbol: desk.tokens.usdc.symbol })}</p>}
      <button type="button" className="plain-button" onClick={onAgain}>
        {t("ex.again")}
      </button>
    </div>
  );
}

/** What the account holds of each token, the sealed ones on demand, and the test faucet. */
function Ledger(props: {
  desk: Desk | null;
  held: (k: TokenKey) => bigint | null;
  sealedKnown: (k: TokenKey) => boolean;
  revealing: TokenKey | null;
  onReveal: (k: TokenKey) => void;
  onPick: (k: TokenKey) => void;
  current: TokenKey;
  onDone: () => void;
  disabled: boolean;
}) {
  const { desk, held, sealedKnown, revealing, onReveal, onPick, current, onDone, disabled } = props;
  const { adapter, account, collection } = useChain();
  const t = useT();
  const [faucet, setFaucet] = useState<"idle" | "busy" | "done" | "failed">("idle");
  if (!account || !desk) {
    return (
      <aside className="ledger">
        <h3 className="ledger-title">{t("ex.ledger")}</h3>
        <p className="fine">{account ? t("ex.reading") : t("ex.ledgerConnect")}</p>
      </aside>
    );
  }
  const payment = collection?.payment;
  return (
    <aside className="ledger" aria-label={t("ex.ledger")}>
      <h3 className="ledger-title">{t("ex.ledger")}</h3>
      <ul>
        {TOKENS.filter((k) => desk.croq || (k !== "croq" && k !== "ccroq")).map((k) => {
          const info = desk.tokens[k];
          const v = held(k);
          return (
            <li key={k} className={k === current ? "is-current" : undefined}>
              <button type="button" className="ledger-pick" onClick={() => onPick(k)} disabled={disabled} title={t("ex.handOver", { symbol: info.symbol })}>
                <Coin token={info} />
                <span className="token-name">
                  <strong>{info.symbol}</strong>
                  <small>{t(info.sealed ? "ex.sealed" : "ex.plain")}</small>
                </span>
              </button>
              <span className="ledger-amount">
                {info.sealed && !sealedKnown(k) ? (
                  <button type="button" className="link" onClick={() => onReveal(k)} disabled={disabled || !!revealing}>
                    {revealing === k ? t("ex.decrypting") : t("ex.decrypt")}
                  </button>
                ) : v === null ? (
                  "…"
                ) : (
                  show(v, info.decimals, 4)
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="fine ledger-note">{t("ex.ledgerNote")}</p>
      {payment?.faucet != null && (
        <p className="fine">
          <button
            type="button"
            className="link"
            disabled={disabled || faucet === "busy"}
            onClick={async () => {
              setFaucet("busy");
              try {
                await adapter.faucetUsdc();
                setFaucet("done");
                onDone();
              } catch (error) {
                console.error("[exchange] faucet failed", error);
                setFaucet("failed");
              }
            }}
          >
            {faucet === "busy" ? t("ex.faucetBusy") : t("pay.faucet", { amount: formatAmount(payment.faucet, payment.decimals), symbol: payment.symbol })}
          </button>
          {faucet === "done" ? ` ${t("ex.faucetDone")}` : faucet === "failed" ? ` ${t("ex.faucetFailed")}` : ""}
        </p>
      )}
    </aside>
  );
}
