import "./tx.css";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Step } from "@dno/chain-adapter";
import { useLocale } from "../../i18n/locale";
import { vaultBoxPath, vaultPath } from "../../site";
import { useT } from "./i18n";
import type { VaultTxKey } from "./i18n/en";
import { currentRun, dismissRun, isOwnRun, isStale, subscribeRuns, txUrl, worthShowing, type VaultRun } from "./runStore";
import { CipherLine, SCENE_OF, TxScene } from "./scenes";

/** The run any page should know about: this page's own, else the last one a vault page left. */
export function useVaultRun(): VaultRun | null {
  return useSyncExternalStore(subscribeRuns, currentRun, () => null);
}

/** Ticks once a second while `on`, so durations and staleness stay current. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

const known = (name: string) => name in SCENE_OF;
const titleKey = (name: string) => `vtx.title.${known(name) ? name : "other"}` as VaultTxKey;
const stampKey = (run: VaultRun) => (run.status === "failed" ? "vtx.stamp.failed" : (`vtx.stamp.${known(run.name) ? run.name : "other"}` as VaultTxKey));
const stepKey = (step: Step | null) => (step ? (`vtx.step.${step}` as VaultTxKey) : "vtx.step.starting");
const shortHash = (hash: string) => `${hash.slice(0, 8)}…${hash.slice(-6)}`;

/** The steps the run went through, the current one with its seconds. */
function Steps({ run, now }: { run: VaultRun; now: number }) {
  const t = useT();
  const running = run.status === "running";
  if (!run.steps.length) return <ol className="vx-steps">{running && <li className="now">{t("vtx.step.starting")}</li>}</ol>;
  return (
    <ol className="vx-steps">
      {run.steps.map((s, i) => {
        const current = running && i === run.steps.length - 1;
        const seconds = Math.floor((now - s.at) / 1000);
        return (
          <li key={i} className={current ? "now" : "done"} aria-current={current ? "step" : undefined}>
            <span className="vx-tick" aria-hidden="true" />
            {t(stepKey(s.step))}
            {current && seconds > 2 && <span className="vx-secs">{t("vtx.seconds", { n: seconds })}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** Every transaction the run sent: what it called, where it is, its block and gas, a link to the explorer. */
function Txs({ run }: { run: VaultRun }) {
  const t = useT();
  const locale = useLocale();
  const number = new Intl.NumberFormat(locale);
  return (
    <section className="vx-txs">
      <h3>{t("vtx.txs")}</h3>
      {run.txs.length === 0 ? (
        <p className="vx-fine">{t("vtx.txs.none")}</p>
      ) : (
        <ol>
          {run.txs.map((tx) => {
            const url = txUrl(run, tx.hash);
            return (
              <li key={tx.hash} className={`vx-tx vx-tx-${tx.status}`}>
                <span className="vx-tx-dot" aria-hidden="true" />
                <code className="vx-tx-call">{tx.call}()</code>
                <span className="vx-tx-status">
                  {tx.status === "sent" ? t("vtx.tx.sent") : tx.status === "failed" ? t("vtx.tx.failed") : t("vtx.tx.confirmed", { block: number.format(tx.block ?? 0) })}
                </span>
                {tx.gas && <span className="vx-tx-gas">{t("vtx.tx.gas", { gas: number.format(Number(tx.gas)) })}</span>}
                {url ? (
                  <a className="vx-tx-hash" href={url} target="_blank" rel="noreferrer" title={tx.hash}>
                    {shortHash(tx.hash)} ↗
                  </a>
                ) : (
                  <code className="vx-tx-hash" title={tx.hash}>
                    {shortHash(tx.hash)}
                  </code>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/**
 * The vault page's own action, front and centre: its scene, its steps, its transactions, then how
 * it ended under a stamp. "Keep browsing" folds it into the dock; Escape does the same.
 */
export function TxStage({ run, onMinimize, onClose }: { run: VaultRun; onMinimize: () => void; onClose: () => void }) {
  const t = useT();
  const running = run.status === "running";
  const now = useNow(running);
  const panel = useRef<HTMLDivElement>(null);
  const leave = running ? onMinimize : onClose;
  const leaving = useRef(leave);
  leaving.current = leave;

  useEffect(() => {
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && leaving.current();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const secret = run.step === "encrypting" || run.step === "decrypting";
  return (
    <div className="vx-overlay" onPointerDown={(e) => e.target === e.currentTarget && leave()}>
      <div className={`vx-stage vx-stage-${run.status}`} role="dialog" aria-modal="true" aria-labelledby={`vx-title-${run.id}`} tabIndex={-1} ref={panel}>
        <p className="vx-kicker">{running ? t(stepKey(run.step)) : run.status === "done" ? t("vtx.done") : t("vtx.failed")}</p>
        <h2 id={`vx-title-${run.id}`}>{t(titleKey(run.name))}</h2>
        <TxScene name={run.name} decoys={run.decoys} token={run.token} live={running} stamp={running ? null : t(stampKey(run))} failed={run.status === "failed"} />
        <p className={`vx-cipher${secret ? " is-on" : ""}`} aria-hidden="true">
          <CipherLine length={28} live={secret} />
        </p>
        <div className="vx-detail" role="status" aria-live="polite">
          <Steps run={run} now={now} />
          {run.note && <p className={`vx-note vx-note-${run.status}`}>{run.note}</p>}
          <Txs run={run} />
        </div>
        {running && <p className="vx-fine">{t("vtx.keepOpen")}</p>}
        <div className="vx-buttons">
          {running ? (
            <button type="button" className="sec-btn sec-btn-ghost sec-btn-small" onClick={onMinimize}>
              {t("vtx.minimize")}
            </button>
          ) : (
            <button type="button" className="sec-btn sec-btn-small" onClick={onClose}>
              {t("vtx.close")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The bar at the foot of a page that shows the vault's action while it is not in front: folded
 * away on the vault's page, or left behind when the visitor went to another page of the site.
 * On the vault's page it opens the stage again; elsewhere it leads back to the vault.
 */
export function TxDock({ onShow }: { onShow?: () => void }) {
  const t = useT();
  const locale = useLocale();
  const run = useVaultRun();
  const now = useNow(!!run && run.status === "running");
  if (!worthShowing(run, now)) return null;

  const own = isOwnRun(run);
  const stale = isStale(run, now);
  const live = run.status === "running" && !stale;
  const line = stale
    ? t("vtx.dock.interrupted")
    : live
      ? `${t(stepKey(run.step))}${own ? "" : ` · ${t("vtx.dock.elsewhere")}`}`
      : (run.note ?? (run.status === "done" ? t("vtx.done") : t("vtx.failed")));
  const last = run.txs[run.txs.length - 1];
  const lastUrl = last ? txUrl(run, last.hash) : null;
  const vault = run.box !== undefined ? vaultBoxPath(locale, run.box) : vaultPath(locale);

  return (
    <aside className={`vx-dock vx-dock-${stale ? "stale" : run.status}`} aria-label={t("vtx.dock.label")} role="status" aria-live="polite">
      <TxScene name={run.name} decoys={run.decoys} token={run.token} live={live} failed={run.status === "failed" || stale} small />
      <div className="vx-dock-text">
        <strong>{t(titleKey(run.name))}</strong>
        <span>{line}</span>
        {run.txs.length > 0 && (
          <span className="vx-dock-txs">
            {t("vtx.dock.txs", { count: run.txs.length })}
            {last &&
              (lastUrl ? (
                <a href={lastUrl} target="_blank" rel="noreferrer" title={last.hash}>
                  {shortHash(last.hash)} ↗
                </a>
              ) : (
                <code>{shortHash(last.hash)}</code>
              ))}
          </span>
        )}
      </div>
      <div className="vx-dock-actions">
        {own && onShow ? (
          <button type="button" className="sec-btn sec-btn-small" onClick={onShow}>
            {t("vtx.dock.show")}
          </button>
        ) : (
          !onShow && (
            <a className="sec-btn sec-btn-small" href={vault}>
              {t("vtx.dock.open")}
            </a>
          )
        )}
        {!(own && live) && (
          <button type="button" className="vx-dock-x" aria-label={t("vtx.dock.dismiss")} onClick={dismissRun}>
            ×
          </button>
        )}
      </div>
    </aside>
  );
}
