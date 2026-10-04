import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { formatAmount, type ApiSession, type StudioPack } from "@dno/chain-adapter";
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
import type { Subject } from "./CatViewer";
import { HttpStudio, LocalStudio, randomSeed, StudioError, type StudioCredits, type StudioErrorCode, type StudioInfo, type StudioJob, type StudioService } from "./service";
import { storedSession, storeSession } from "./session";

// three.js and its helpers load with the turntable, never with the page's text.
const CatViewer = lazy(() => import("./CatViewer").then((m) => ({ default: m.CatViewer })));

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
        {t("studio.next")}{" "}
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
  unauthorized: "studio.err.unauthorized",
  unreachable: "studio.err.unreachable",
};

function Trouble({ code }: { code: StudioErrorCode }) {
  const t = useT();
  return (
    <p className="fine problem studio-trouble" role="alert">
      {t(ERRORS[code])}
    </p>
  );
}

function StudioLive() {
  const { adapter, account, mode, connect } = useChain();
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const ledger = useLedger();
  const buying = useAction();
  const apiUrl = import.meta.env.VITE_API_URL as string | undefined;
  const demo = mode === "mock" || !apiUrl;

  const [session, setSession] = useState<ApiSession | null>(() => storedSession(account));
  const sessionRef = useRef(session);
  sessionRef.current = session;
  useEffect(() => setSession(storedSession(account)), [account]);

  const service = useMemo<StudioService>(
    () => (demo ? new LocalStudio(() => adapter.studioPending(null)) : new HttpStudio(apiUrl!, () => sessionRef.current?.token ?? null)),
    [demo, adapter, apiUrl],
  );

  const [subject, setSubject] = useState<Subject>(() => ({ kind: "cat", seed: randomSeed() }));
  const [showing, setShowing] = useState<string | null>(null);
  const [info, setInfo] = useState<StudioInfo | null>(null);
  const [infoFailed, setInfoFailed] = useState(false);
  const [packs, setPacks] = useState<StudioPack[] | null | undefined>(undefined);
  const [credits, setCredits] = useState<StudioCredits | null>(null);
  const [jobs, setJobs] = useState<StudioJob[]>([]);
  const [prompt, setPrompt] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  /** Why the last studio call failed, shown next to what was tried. */
  const [problem, setProblem] = useState<{ code: StudioErrorCode; at: "sketch" | "model" | "desk" } | null>(null);
  const [signing, setSigning] = useState(false);
  const [sending, setSending] = useState(false);

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
    return () => {
      live = false;
    };
  }, [service, adapter]);

  const signedIn = demo ? !!account : !!session;

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
    } catch (error) {
      failed(error);
    }
  }, [signedIn, service, adapter, demo, failed]);

  useEffect(() => {
    if (signedIn) void reload();
    else (setCredits(null), setJobs([]));
  }, [signedIn, reload, ledger]);

  // While the AI works, ask how it is going; a finished model goes on the turntable.
  const running = jobs.some((j) => j.status === "running");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, reload]);

  // Only a model that finishes while the page watches goes on the turntable by itself.
  const wasRunning = useRef(new Set<string>());
  useEffect(() => {
    const finished = jobs.find((j) => j.kind === "model" && j.status === "done" && wasRunning.current.has(j.id));
    wasRunning.current = new Set(jobs.filter((j) => j.status === "running").map((j) => j.id));
    if (finished) show(finished);
  }, [jobs]);

  function show(job: StudioJob) {
    if (job.modelUrl) setSubject({ kind: "model", url: job.modelUrl });
    else if (job.seed) setSubject({ kind: "cat", seed: BigInt(job.seed) });
    else return;
    setShowing(job.id);
    // On a phone the turntable is above the desk, out of sight: bring it back.
    if (window.matchMedia("(max-width: 899px)").matches) {
      document.querySelector(".studio-stage")?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  }

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

  const sketch = async () => {
    setProblem(null);
    setSending(true);
    try {
      const job = await service.sketch(prompt);
      setJobs((js) => [job, ...js]);
      setPicked(null);
      await reload();
    } catch (error) {
      failed(error, "sketch");
    } finally {
      setSending(false);
    }
  };

  const model = async () => {
    if (!picked) return;
    setProblem(null);
    setSending(true);
    try {
      const job = await service.model(picked);
      setJobs((js) => [job, ...js]);
      await reload();
    } catch (error) {
      failed(error, "model");
    } finally {
      setSending(false);
    }
  };

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
  const showingJob = jobs.find((j) => j.id === showing);

  return (
    <>
      <Masthead view="studio" onView={(v) => window.location.assign(gameAt(locale, v))} />

      <section className="studio-workshop" aria-labelledby={`${id}-stage`}>
        <div className="studio-stage">
          <h2 className="studio-h2" id={`${id}-stage`}>
            {showingJob ? t("studio.stage.yours") : t("studio.stage.free")}
          </h2>
          <Suspense fallback={<div className="studio-viewer" aria-hidden="true" />}>
            <CatViewer subject={subject} label={showingJob ? t("studio.viewer.yours", { prompt: showingJob.prompt }) : t("studio.viewer.label")} />
          </Suspense>
          <div className="studio-stage-actions">
            <button
              type="button"
              className="stamp-button studio-another"
              onClick={() => {
                setSubject({ kind: "cat", seed: randomSeed() });
                setShowing(null);
              }}
            >
              {t("studio.free.another")}
            </button>
            <p className="fine">{showingJob ? `“${showingJob.prompt}”` : t("studio.free.body")}</p>
          </div>
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
                        <button
                          type="button"
                          className="studio-sketch"
                          aria-pressed={picked === j.id}
                          disabled={j.status !== "done"}
                          onClick={() => setPicked((p) => (p === j.id ? null : j.id))}
                          title={j.prompt}
                        >
                          {j.status === "done" && j.imageUrl ? (
                            <img src={j.imageUrl} alt={j.prompt} loading="lazy" />
                          ) : (
                            <span className="studio-sketch-state">{j.status === "running" ? t("studio.job.drawing") : j.status === "rejected" ? t("studio.job.rejected") : t("studio.job.failed")}</span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="stamp-button" onClick={() => void model()} disabled={!picked || sending || (credits?.models.left ?? 0) < 1}>
                    {t("studio.model.button")}
                  </button>
                  <p className="fine">{picked ? t("studio.model.cost") : t("studio.model.pick")}</p>
                  {problem?.at === "model" && <Trouble code={problem.code} />}
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
                          <button type="button" className="link" onClick={() => show(j)} aria-pressed={showing === j.id}>
                            {showing === j.id ? t("studio.model.onStage") : t("studio.model.show")}
                          </button>
                        ) : (
                          <span className="fine">{j.status === "running" ? t("studio.job.modelling") : j.status === "rejected" ? t("studio.job.rejected") : t("studio.job.failed")}</span>
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
