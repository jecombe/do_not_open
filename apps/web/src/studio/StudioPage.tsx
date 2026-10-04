import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { formatAmount, type ApiSession, type RatPrices, type RatSupply, type StudioPack } from "@dno/chain-adapter";
import { studio } from "@dno/game-spec";
import { ChainProvider, useAction, useChain, useLedger } from "../chain/ChainProvider";
import { useT, type AppKey } from "../i18n/app";
import { useLocale } from "../i18n/locale";
import { Masthead } from "../Masthead";
import { appPath, docsPath, homePath } from "../site";
import { TermsGate } from "../terms/TermsGate";
import { onOpenExchange } from "../views/exchangeLink";
import { ProblemNote } from "../views/ProblemNote";
import { TxPending } from "../views/TxPending";
import { JobLoader } from "./JobLoader";
import { expectedSeconds, progressOf, startedMs } from "./progress";
import type { Subject } from "./StageViewer";
import { HttpStudio, LocalStudio, randomSeed, StudioError, type StudioCredits, type StudioErrorCode, type StudioInfo, type StudioJob, type StudioService } from "./service";
import { storedSession, storeSession } from "./session";

// three.js and its helpers load with the turntable, never with the page's text.
const StageViewer = lazy(() => import("./StageViewer").then((m) => ({ default: m.StageViewer })));

/** How often a running job is asked about. */
const POLL_MS = 2000;

/** The game at one of its views, in the visitor's language. */
const gameAt = (locale: ReturnType<typeof useLocale>, view: string) => `${appPath(locale)}${locale === "en" ? "?" : "&"}view=${view}`;

/**
 * The studio: a page of its own, readable without a wallet. The top says what it is (and is
 * what a crawler reads); below, the turntable and the desk need the chain, so they wait for it.
 */
export function StudioPage() {
  return (
    <div className="studio">
      <StudioIntro />
      <ChainProvider>
        <StudioLive />
      </ChainProvider>
    </div>
  );
}

function StudioIntro() {
  const t = useT();
  const locale = useLocale();
  const starter = studio.packs[0]!;
  useEffect(() => {
    document.title = t("studio.title");
    document.querySelector('meta[name="description"]')?.setAttribute("content", t("studio.description"));
  }, [t]);
  return (
    <header className="studio-intro">
      <p className="studio-kicker">{t("studio.kicker")}</p>
      <h1 className="studio-title">{t("studio.h1")}</h1>
      <p className="studio-lead">{t("studio.lead")}</p>
      <ol className="studio-steps">
        <li>
          <strong>{t("studio.step1.title")}</strong> {t("studio.step1.body")}
        </li>
        <li>
          <strong>{t("studio.step2.title")}</strong> {t("studio.step2.body", { price: starter.priceUsdc, sketches: starter.sketches, models: starter.models })}
        </li>
        <li>
          <strong>{t("studio.step3.title")}</strong> {t("studio.step3.body")}
        </li>
      </ol>
      <p className="fine studio-next">
        {t("studio.next", { seed: studio.rats.mint.seedPriceUsdc, model: studio.rats.mint.modelPriceUsdc, perDay: studio.rats.croquettes.perDay })}{" "}
        <a className="link" href={`${docsPath(locale)}#studio`}>
          {t("studio.manualLink")}
        </a>
      </p>
    </header>
  );
}

const ERRORS: Record<StudioErrorCode, AppKey> = {
  "bad-prompt": "studio.err.badPrompt",
  "refused-prompt": "studio.err.refusedPrompt",
  "not-allowlisted": "studio.err.notAllowlisted",
  "no-credits": "studio.err.noCredits",
  "studio-paused": "studio.err.paused",
  "already-adopted": "studio.err.alreadyAdopted",
  "sold-out": "studio.err.soldOut",
  "wallet-limit": "studio.err.walletLimit",
  "storage-failed": "studio.err.storageFailed",
  "adopt-unavailable": "studio.err.adoptUnavailable",
  unauthorized: "studio.err.unauthorized",
  unreachable: "studio.err.unreachable",
};

/** How many rats of a kind are left out of the most there will ever be, and the wallet's share. */
function RatCount({ supply, kind }: { supply: RatSupply; kind: "seed" | "model" }) {
  const t = useT();
  const { minted, max } = supply[kind];
  return (
    <p className="fine studio-rat-count">
      <strong>{t(kind === "seed" ? "studio.supply.seed" : "studio.supply.model", { left: Math.max(0, max - minted), max })}</strong>
      {supply.mintedBy !== null && <> {t("studio.supply.mine", { mine: supply.mintedBy, max: supply.perWallet })}</>}
    </p>
  );
}

/** Why no rat of this kind can be adopted by this wallet, or null when one can. */
function closedFor(supply: RatSupply | null | undefined, kind: "seed" | "model"): AppKey | null {
  if (!supply) return null;
  if (supply[kind].minted >= supply[kind].max) return "studio.adopt.soldOut";
  if (supply.mintedBy !== null && supply.mintedBy >= supply.perWallet) return "studio.adopt.walletFull";
  return null;
}

function Trouble({ code }: { code: StudioErrorCode }) {
  const t = useT();
  return (
    <p className="fine problem studio-trouble" role="alert">
      {t(ERRORS[code])}
    </p>
  );
}

type Mode = "random" | "ai";
const MODE_KEY = "dno.studio.mode";

function storedMode(): Mode {
  try {
    return window.localStorage.getItem(MODE_KEY) === "ai" ? "ai" : "random";
  } catch {
    return "random";
  }
}

/** The two ways to make a rat, as one switch: the free generator, or the AI from your words. */
function ModeSwitch({ mode, onMode, busy }: { mode: Mode; onMode: (m: Mode) => void; busy: boolean }) {
  const t = useT();
  const option = (m: Mode, title: AppKey, hint: AppKey) => (
    <button type="button" className="studio-mode-option" aria-pressed={mode === m} onClick={() => onMode(m)}>
      <span className="studio-mode-title">{t(title)}</span>
      <span className="studio-mode-hint">{m === "ai" && busy ? <span className="studio-mode-busy">{t("studio.mode.busy")}</span> : t(hint)}</span>
    </button>
  );
  return (
    <div className="studio-mode" role="group" aria-label={t("studio.mode.label")} data-mode={mode}>
      <span className="studio-mode-thumb" aria-hidden="true" />
      {option("random", "studio.mode.random", "studio.mode.randomHint")}
      {option("ai", "studio.mode.ai", "studio.mode.aiHint")}
    </div>
  );
}

/** On a phone the board is above the desk, out of sight: bring it back. */
function bringBoardIntoView() {
  if (!window.matchMedia("(max-width: 899px)").matches) return;
  document.querySelector(".studio-stage")?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

function StudioLive() {
  const { adapter, account, mode: chainMode, connect } = useChain();
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const ledger = useLedger();
  const buying = useAction();
  const adopting = useAction();
  const apiUrl = import.meta.env.VITE_API_URL as string | undefined;
  const demo = chainMode === "mock" || !apiUrl;

  const [session, setSession] = useState<ApiSession | null>(() => storedSession(account));
  const sessionRef = useRef(session);
  sessionRef.current = session;
  useEffect(() => setSession(storedSession(account)), [account]);

  const service = useMemo<StudioService>(
    () => (demo ? new LocalStudio(() => adapter.studioPending(null)) : new HttpStudio(apiUrl!, () => sessionRef.current?.token ?? null)),
    [demo, adapter, apiUrl],
  );

  const [mode, setModeState] = useState<Mode>(storedMode);
  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    try {
      window.localStorage.setItem(MODE_KEY, m);
    } catch {
      // The switch then lasts as long as the page.
    }
  }, []);

  const [seed, setSeed] = useState<bigint>(randomSeed);
  const [info, setInfo] = useState<StudioInfo | null>(null);
  const [infoFailed, setInfoFailed] = useState(false);
  const [packs, setPacks] = useState<StudioPack[] | null | undefined>(undefined);
  const [credits, setCredits] = useState<StudioCredits | null>(null);
  const [jobs, setJobs] = useState<StudioJob[]>([]);
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [prompt, setPrompt] = useState("");
  /** The job on the drawing board: running, a sketch shown big, or a 3D rat on the turntable. */
  const [focus, setFocus] = useState<string | null>(null);
  /** When this page started its jobs, on its own clock: their bars start at zero. */
  const startedHere = useRef(new Map<string, number>());
  /** Why the last studio call failed, shown next to what was tried. */
  const [problem, setProblem] = useState<{ code: StudioErrorCode; at: "sketch" | "model" | "desk" } | null>(null);
  const [signing, setSigning] = useState(false);
  const [sending, setSending] = useState(false);
  const [ratPrices, setRatPrices] = useState<RatPrices | null | undefined>(undefined);
  /** Rats left, per kind, and this wallet's share. */
  const [ratSupply, setRatSupply] = useState<RatSupply | null | undefined>(undefined);
  /** Whether the random rat on the turntable was adopted already, by anyone. */
  const [taken, setTaken] = useState(false);
  /** The rat this visit adopted, to say so and point to it. */
  const [adopted, setAdopted] = useState<number | null>(null);

  // A "get USDC" link from a failed purchase goes to the bureau de change, in the game.
  useEffect(() => onOpenExchange(() => window.location.assign(gameAt(locale, "exchange"))), [locale]);

  useEffect(() => {
    let live = true;
    service.info().then(
      (i) => live && (setInfo(i), setInfoFailed(false)),
      () => live && setInfoFailed(true),
    );
    adapter.studioPacks().then(
      (p) => live && setPacks(p),
      () => live && setPacks(null),
    );
    adapter.ratPrices().then(
      (p) => live && setRatPrices(p),
      () => live && setRatPrices(null),
    );
    return () => {
      live = false;
    };
  }, [service, adapter]);

  // Read again after an adoption: one fewer left, one more for this wallet.
  useEffect(() => {
    let live = true;
    adapter.ratSupply(account).then(
      (s) => live && setRatSupply(s),
      () => live && setRatSupply(null),
    );
    return () => {
      live = false;
    };
  }, [adapter, account, adopted]);

  const signedIn = demo ? !!account : !!session;

  const randomSeedShown = mode === "random" ? seed : null;
  // Something else on show: the last adoption's message makes way for its own button.
  useEffect(() => setAdopted(null), [seed, focus, mode]);
  useEffect(() => {
    setTaken(false);
    if (randomSeedShown === null || !ratPrices) return;
    let live = true;
    adapter.seedRatTaken(randomSeedShown).then((t) => live && setTaken(t), () => undefined);
    return () => {
      live = false;
    };
  }, [adapter, randomSeedShown, ratPrices, ledger]);

  /** A session the API no longer takes: forget it, the visitor signs in again. */
  const failed = useCallback((error: unknown, at: "sketch" | "model" | "desk" = "desk") => {
    const code = error instanceof StudioError ? error.code : "unreachable";
    if (code === "unauthorized") {
      storeSession(null);
      setSession(null);
    }
    setProblem({ code, at: code === "unauthorized" ? "desk" : at });
  }, []);

  const reload = useCallback(async () => {
    if (!signedIn) return;
    try {
      const [c, j] = await Promise.all([service.credits(), service.jobs()]);
      // Packs bought from this browser count at once, before the API sees their block.
      const pending = adapter.studioPending(c.block);
      setCredits(
        demo
          ? c
          : {
              ...c,
              sketches: { ...c.sketches, bought: c.sketches.bought + pending.sketches, left: c.sketches.left + pending.sketches },
              models: { ...c.models, bought: c.models.bought + pending.models, left: c.models.left + pending.models },
            },
      );
      setJobs(j);
      setJobsLoaded(true);
    } catch (error) {
      failed(error);
    }
  }, [signedIn, service, adapter, demo, failed]);

  useEffect(() => {
    if (signedIn) void reload();
    else (setCredits(null), setJobs([]), setJobsLoaded(false), setFocus(null));
  }, [signedIn, reload, ledger]);

  // While the AI works, ask how it is going, and keep the little bars moving.
  const running = jobs.some((j) => j.status === "running");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const poll = setInterval(() => void reload(), POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 500);
    return () => (clearInterval(poll), clearInterval(tick));
  }, [running, reload]);

  // Back on the page: whatever the AI is still working on is on the board, its bar where it
  // was; else the last thing made.
  const settledOnLoad = useRef(false);
  useEffect(() => {
    if (!jobsLoaded || settledOnLoad.current) return;
    settledOnLoad.current = true;
    const pick = jobs.find((j) => j.status === "running") ?? jobs.find((j) => j.status === "done");
    if (pick) setFocus(pick.id);
    if (jobs.some((j) => j.status === "running")) setMode("ai");
  }, [jobsLoaded, jobs, setMode]);

  const focusJob = (jobId: string) => {
    setFocus(jobId);
    bringBoardIntoView();
  };

  const signIn = async () => {
    setProblem(null);
    setSigning(true);
    try {
      const s = await adapter.apiSession();
      storeSession(s);
      setSession(s);
    } catch {
      setProblem({ code: "unauthorized", at: "desk" });
    } finally {
      setSigning(false);
    }
  };

  const started = (job: StudioJob) => {
    startedHere.current.set(job.id, Date.now());
    setJobs((js) => [job, ...js]);
    focusJob(job.id);
  };

  const sketch = async () => {
    setProblem(null);
    setSending(true);
    try {
      started(await service.sketch(prompt));
      await reload();
    } catch (error) {
      failed(error, "sketch");
    } finally {
      setSending(false);
    }
  };

  const model = async (sketchId: string) => {
    setProblem(null);
    setSending(true);
    try {
      started(await service.model(sketchId));
      await reload();
    } catch (error) {
      failed(error, "model");
    } finally {
      setSending(false);
    }
  };

  const adoptSeed = async (s: bigint) => {
    if (!account) return void connect();
    setAdopted(null);
    const rat = await adopting.run("rat-adopt", (o) => adapter.mintSeedRat(s, o));
    if (rat !== undefined) setAdopted(rat);
  };

  const adoptModel = async (job: StudioJob) => {
    setProblem(null);
    setAdopted(null);
    let adoption;
    try {
      adoption = await service.adopt(job.id);
    } catch (error) {
      return failed(error, "model");
    }
    const rat = await adopting.run("rat-adopt", (o) => adapter.mintModelRat(adoption, o));
    if (rat !== undefined) setAdopted(rat);
  };

  const perDay = studio.rats.croquettes.perDay;

  const buy = async (pack: StudioPack) => {
    setProblem(null);
    await buying.run("studio-pack", (o) => adapter.buyStudioPack(pack.id, o));
    await reload();
  };

  const sketches = jobs.filter((j) => j.kind === "sketch");
  const models = jobs.filter((j) => j.kind === "model");
  const paused = info?.paused ?? null;
  const closed = !demo && (infoFailed || !info?.enabled || paused !== null);
  const promptOk = prompt.trim().length >= studio.prompt.minLength && prompt.trim().length <= studio.prompt.maxLength;
  const ready = !closed && signedIn && info?.allowlisted !== false;
  const focused = ready ? jobs.find((j) => j.id === focus) : undefined;

  const randomSubject = useMemo<Subject>(() => ({ kind: "rat", seed }), [seed]);
  const modelKey = focused?.kind === "model" && focused.status === "done" ? (focused.modelUrl ?? (focused.seed ? `seed:${focused.seed}` : null)) : null;
  const modelSubject = useMemo<Subject | null>(() => {
    if (!modelKey) return null;
    return modelKey.startsWith("seed:") ? { kind: "rat", seed: BigInt(modelKey.slice(5)) } : { kind: "model", url: modelKey };
  }, [modelKey]);

  const barOf = (job: StudioJob) => progressOf((now - startedMs(job, startedHere.current, now)) / 1000, expectedSeconds(job.kind, demo));
  const stateOf = (job: StudioJob) =>
    job.status === "running" ? t(job.kind === "sketch" ? "studio.job.drawing" : "studio.job.modelling") : job.status === "rejected" ? t("studio.job.rejected") : t("studio.job.failed");

  const adoptArea = (content: ReactNode) => (
    <TxPending busy={adopting.busy} step={adopting.step} title={t("studio.adopt.adopting")}>
      <div className="studio-adopt">
        {adopted !== null ? (
          <p className="studio-adopted" role="status">
            {t("studio.adopt.done", { id: adopted, perDay })}{" "}
            <a className="link" href={gameAt(locale, "rats")}>
              {t("studio.adopt.see")}
            </a>
          </p>
        ) : (
          content
        )}
        {adopting.error && <ProblemNote problem={adopting.error} />}
      </div>
    </TxPending>
  );

  const boardTitle: AppKey = !focused
    ? "studio.board.title"
    : focused.status === "running"
      ? focused.kind === "sketch"
        ? "studio.board.drawing"
        : "studio.board.modelling"
      : focused.status !== "done"
        ? "studio.board.failed"
        : focused.kind === "sketch"
          ? "studio.board.sketch"
          : "studio.board.model";

  const board = () => {
    if (!focused) {
      return (
        <div className="studio-viewer studio-board-empty">
          <p>{ready ? t("studio.board.empty") : t("studio.board.locked")}</p>
        </div>
      );
    }
    if (focused.status === "running") {
      return <JobLoader key={focused.id} id={focused.id} kind={focused.kind} startedMs={startedMs(focused, startedHere.current, Date.now())} expectedS={expectedSeconds(focused.kind, demo)} />;
    }
    if (focused.status !== "done") {
      return (
        <div className="studio-viewer studio-board-empty">
          <p>{stateOf(focused)}</p>
        </div>
      );
    }
    if (focused.kind === "sketch") {
      return (
        <>
          <figure className="studio-bigsketch">
            {focused.imageUrl ? <img src={focused.imageUrl} alt={focused.prompt} /> : <p className="studio-viewer-state">{t("studio.viewer.failed")}</p>}
          </figure>
          <div className="studio-board-actions">
            <button type="button" className="stamp-button studio-board-cta" onClick={() => void model(focused.id)} disabled={sending || (credits?.models.left ?? 0) < 1}>
              {t("studio.model.button")}
            </button>
            <p className="fine">{(credits?.models.left ?? 0) < 1 ? t("studio.err.noCredits") : t("studio.model.cost")}</p>
          </div>
          {problem?.at === "model" && <Trouble code={problem.code} />}
        </>
      );
    }
    return (
      <>
        {modelSubject && (
          <Suspense fallback={<div className="studio-viewer" aria-hidden="true" />}>
            <StageViewer subject={modelSubject} label={t("studio.viewer.yours", { prompt: focused.prompt })} />
          </Suspense>
        )}
        {adoptArea(
          <>
            {ratPrices && closedFor(ratSupply, "model") ? (
              <p className="fine">{t(closedFor(ratSupply, "model")!, { max: ratSupply!.perWallet })}</p>
            ) : ratPrices ? (
              <button type="button" className="stamp-button studio-adopt-button" disabled={!!adopting.busy} onClick={() => void adoptModel(focused)}>
                {t("studio.adopt.model", { price: formatAmount(ratPrices.model, 6) })}
              </button>
            ) : ratPrices === null ? (
              <p className="fine">{t("studio.adopt.closed")}</p>
            ) : null}
            {ratPrices && ratSupply && <RatCount supply={ratSupply} kind="model" />}
          </>,
        )}
        {problem?.at === "model" && <Trouble code={problem.code} />}
      </>
    );
  };

  return (
    <>
      <Masthead view="studio" onView={(v) => window.location.assign(gameAt(locale, v))} />

      <ModeSwitch mode={mode} onMode={setMode} busy={running} />

      {mode === "random" ? (
        <section className="studio-workshop studio-workshop-random" aria-labelledby={`${id}-stage`}>
          <div className="studio-stage">
            <h2 className="studio-h2" id={`${id}-stage`}>
              {t("studio.stage.free")}
            </h2>
            <Suspense fallback={<div className="studio-viewer" aria-hidden="true" />}>
              <StageViewer subject={randomSubject} label={t("studio.viewer.label")} />
            </Suspense>
            <div className="studio-stage-actions">
              <button type="button" className="stamp-button studio-another" onClick={() => setSeed(randomSeed())}>
                {t("studio.free.another")}
              </button>
              <p className="fine">{t("studio.free.body")}</p>
            </div>
            {adoptArea(
              <>
                {ratPrices === null ? (
                  <p className="fine">{t("studio.adopt.closed")}</p>
                ) : taken ? (
                  <p className="fine">{t("studio.adopt.taken")}</p>
                ) : closedFor(ratSupply, "seed") ? (
                  <p className="fine">{t(closedFor(ratSupply, "seed")!, { max: ratSupply!.perWallet })}</p>
                ) : (
                  <button type="button" className="stamp-button studio-adopt-button" disabled={!ratPrices || !!adopting.busy} onClick={() => void adoptSeed(seed)}>
                    {t("studio.adopt.seed", { price: ratPrices ? formatAmount(ratPrices.seed, 6) : studio.rats.mint.seedPriceUsdc })}
                  </button>
                )}
                {ratPrices !== null && !taken && !closedFor(ratSupply, "seed") && <p className="fine">{t("studio.adopt.hint", { perDay })}</p>}
                {ratPrices && ratSupply && <RatCount supply={ratSupply} kind="seed" />}
              </>,
            )}
          </div>
        </section>
      ) : (
        <section className="studio-workshop" aria-labelledby={`${id}-stage`}>
          <div className="studio-stage">
            <h2 className="studio-h2" id={`${id}-stage`}>
              {t(boardTitle)}
            </h2>
            {board()}
            {focused && <p className="fine studio-board-prompt">“{focused.prompt}”</p>}
          </div>

          <div className="studio-desk slip" aria-labelledby={`${id}-desk`}>
            <h2 className="studio-h2" id={`${id}-desk`}>
              {t("studio.ai.title")}
            </h2>
            <p className="fine">{t("studio.ai.body")}</p>
            {demo && <p className="fine studio-demo">{t("studio.demo")}</p>}

            {closed ? (
              <p className="fine studio-closed" role="status">
                {infoFailed ? t("studio.closed.unreachable") : paused === "budget" ? t("studio.closed.budget") : t("studio.closed.off")}
              </p>
            ) : !account ? (
              <button type="button" className="stamp-button" onClick={() => void connect()}>
                {t("studio.connect")}
              </button>
            ) : !signedIn ? (
              <div className="studio-block">
                <button type="button" className="stamp-button" onClick={() => void signIn()} disabled={signing} aria-busy={signing}>
                  {signing ? t("studio.signingIn") : t("studio.signIn")}
                </button>
                <p className="fine">{t("studio.signInHint")}</p>
              </div>
            ) : info?.allowlisted === false ? (
              <p className="fine studio-closed" role="status">
                {t("studio.err.notAllowlisted")}
              </p>
            ) : (
              <>
                {credits && (
                  <p className="studio-credits" aria-live="polite">
                    <span>
                      <strong>{credits.sketches.left}</strong> {t("studio.unit.sketches")}
                    </span>
                    <span>
                      <strong>{credits.models.left}</strong> {t("studio.unit.models")}
                    </span>
                  </p>
                )}

                <form
                  className="studio-block"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (promptOk && !sending) void sketch();
                  }}
                >
                  <label className="studio-label" htmlFor={`${id}-prompt`}>
                    {t("studio.prompt.label")}
                  </label>
                  <textarea
                    id={`${id}-prompt`}
                    className="studio-prompt"
                    rows={3}
                    maxLength={studio.prompt.maxLength}
                    placeholder={t("studio.prompt.placeholder")}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                  />
                  <p className="fine studio-count">{t("studio.prompt.count", { n: prompt.trim().length, max: studio.prompt.maxLength })}</p>
                  <button type="submit" className="stamp-button" disabled={!promptOk || sending || (credits?.sketches.left ?? 0) < 1} aria-busy={sending}>
                    {t("studio.sketch.button")}
                  </button>
                  <p className="fine">{t("studio.sketch.cost")}</p>
                  {problem?.at === "sketch" && <Trouble code={problem.code} />}
                </form>

                {sketches.length > 0 && (
                  <div className="studio-block">
                    <h3 className="studio-h3">{t("studio.sketches.title")}</h3>
                    <ul className="studio-sketches">
                      {sketches.map((j) => (
                        <li key={j.id}>
                          <button type="button" className="studio-sketch" aria-pressed={focus === j.id} onClick={() => focusJob(j.id)} title={j.prompt}>
                            {j.status === "done" && j.imageUrl ? (
                              <img src={j.imageUrl} alt={j.prompt} loading="lazy" />
                            ) : (
                              <span className="studio-sketch-state">{stateOf(j)}</span>
                            )}
                            {j.status === "running" && <MiniBar p={barOf(j)} />}
                          </button>
                        </li>
                      ))}
                    </ul>
                    <p className="fine">{t("studio.model.pick")}</p>
                  </div>
                )}

                {models.length > 0 && (
                  <div className="studio-block">
                    <h3 className="studio-h3">{t("studio.models.title")}</h3>
                    <ul className="studio-models">
                      {models.map((j) => (
                        <li key={j.id}>
                          <span className="studio-model-name">{j.prompt}</span>
                          {j.status === "done" ? (
                            <button type="button" className="link" onClick={() => focusJob(j.id)} aria-pressed={focus === j.id}>
                              {focus === j.id ? t("studio.model.onStage") : t("studio.model.show")}
                            </button>
                          ) : j.status === "running" ? (
                            <button type="button" className="link studio-model-running" onClick={() => focusJob(j.id)} aria-pressed={focus === j.id}>
                              {t("studio.job.modelling")} {Math.floor(barOf(j) * 100)}%
                            </button>
                          ) : (
                            <span className="fine">{stateOf(j)}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="studio-block studio-packs">
                  <h3 className="studio-h3">{t("studio.packs.title")}</h3>
                  {packs === null ? (
                    <p className="fine">{t("studio.packs.none")}</p>
                  ) : packs === undefined ? (
                    <p className="fine">{t("studio.packs.reading")}</p>
                  ) : (
                    <TxPending busy={buying.busy} step={buying.step} title={t("studio.packs.buying")}>
                      <ul className="studio-pack-list">
                        {packs.map((p) => (
                          <li key={p.id} className="studio-pack">
                            <span className="studio-pack-name">{p.name}</span>
                            <span className="fine">{t("studio.packs.holds", { count: p.models, sketches: p.sketches, models: p.models })}</span>
                            <button type="button" className="stamp-button studio-pack-buy" onClick={() => void buy(p)} disabled={!!buying.busy}>
                              {t("studio.packs.buy", { price: formatAmount(p.price, 6) })}
                            </button>
                          </li>
                        ))}
                      </ul>
                      {buying.error && <ProblemNote problem={buying.error} />}
                    </TxPending>
                  )}
                  <p className="fine">{t("studio.packs.fine")}</p>
                </div>
              </>
            )}

            {problem?.at === "desk" && <Trouble code={problem.code} />}
          </div>
        </section>
      )}

      <footer className="studio-foot">
        <a className="link" href={appPath(locale)}>
          {t("studio.foot.play")}
        </a>
        <a className="link" href={docsPath(locale)}>
          {t("nav.manual")}
        </a>
        <a className="link" href={homePath(locale)}>
          {t("nav.home")}
        </a>
      </footer>
      <TermsGate />
    </>
  );
}

/** A running sketch's bar, at the foot of its thumbnail. */
function MiniBar({ p }: { p: number }) {
  return (
    <span className="studio-minibar" aria-hidden="true">
      <span style={{ width: `${Math.max(4, p * 100)}%` }} />
    </span>
  );
}
