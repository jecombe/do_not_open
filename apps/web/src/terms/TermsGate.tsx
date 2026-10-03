import { useEffect, useRef, useState } from "react";
import { shortAddress, type SignedTerms } from "@dno/chain-adapter";
import { useChain } from "../chain/ChainProvider";
import { problemOf } from "../chain/copy";
import { useT, type AppKey } from "../i18n/app";
import { CLAUSES, keepSignature, markInitialed, onOpenTerms, setGateUp, termsHash, termsMessage, TERMS_VERSION, useTermsRecord } from "./terms";
import "./terms.css";

/**
 * The release form, before the first box: every clause initialed by hand, then signed with the
 * wallet (free, off-chain), and the signature filed with the API as a record. It comes back for
 * each new wallet and each new version of the terms. From the menu, it shows what was signed.
 */
export function TermsGate() {
  const { account, mode } = useChain();
  const record = useTermsRecord();
  const [viewing, setViewing] = useState(false);
  // A form just signed stays up until the player walks in: they see their seal.
  const [sealed, setSealed] = useState<SignedTerms | null>(null);
  useEffect(() => onOpenTerms(() => setViewing(true)), []);

  const mine = account ? record.signed[account.toLowerCase()] : undefined;
  // Without a wallet (none installed, or not connected yet) the clauses can still be read and
  // initialed; the signature is asked as soon as a wallet connects.
  const required = !record.initialed || (!!account && !mine);
  const shown = required || !!sealed || viewing;
  useEffect(() => setGateUp(shown), [shown]);
  useEffect(() => () => setGateUp(false), []);
  if (!shown) return null;
  return (
    <Form
      required={required && !sealed}
      viewOnly={!required && !sealed}
      signedOnly={record.initialed}
      sealed={sealed ?? (viewing ? (mine ?? null) : null)}
      mock={mode === "mock"}
      onSealed={setSealed}
      onClose={() => {
        setSealed(null);
        setViewing(false);
      }}
    />
  );
}

function Form(props: { required: boolean; viewOnly: boolean; signedOnly: boolean; sealed: SignedTerms | null; mock: boolean; onSealed: (s: SignedTerms) => void; onClose: () => void }) {
  const { required, viewOnly, signedOnly, sealed, mock, onSealed, onClose } = props;
  const chain = useChain();
  const { account, adapter, picking } = chain;
  const t = useT();
  const [initials, setInitials] = useState<Set<number>>(() => new Set(signedOnly ? CLAUSES.map((_, i) => i) : []));
  const [english, setEnglish] = useState(false);
  const [hash, setHash] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => void termsHash().then(setHash), []);
  useEffect(() => {
    root.current?.querySelector<HTMLElement>(".initial:not(.is-done), .terms-sign button, .terms-close")?.focus();
  }, []);
  // A form being signed cannot be pushed away; one being read can.
  useEffect(() => {
    if (required) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [required, onClose]);

  const allInitialed = initials.size === CLAUSES.length;
  const stampText = account ? account.slice(2, 5).toUpperCase() : "OK";
  const clause = (i: number) => (english ? CLAUSES[i]! : { title: t(`terms.c${i + 1}.title` as AppKey), body: t(`terms.c${i + 1}.body` as AppKey) });

  const sign = async () => {
    if (!account || !hash) return;
    setError(null);
    setSigning(true);
    try {
      const s = await adapter.signTerms(termsMessage(account, hash, new Date()));
      keepSignature(s);
      onSealed(s);
    } catch (e) {
      console.error("[terms] signing failed", e);
      setError(problemOf(e).text);
    } finally {
      setSigning(false);
    }
  };

  return (
    <div className="terms-backdrop">
      <div className="terms-form" ref={root} role="dialog" aria-modal="true" aria-labelledby="terms-title" aria-describedby="terms-intro">
        <header className="terms-head">
          <p className="terms-formno">{t("terms.formNo", { version: TERMS_VERSION })}</p>
          <h2 id="terms-title" className="terms-title">
            {t("terms.title")}
          </h2>
          <p className="terms-risk" aria-hidden="true">
            {t("terms.stamp")}
          </p>
        </header>

        <div className="terms-scroll">
          <p id="terms-intro" className="terms-intro">
            {viewOnly || sealed ? t("terms.introRead") : signedOnly && account ? t("terms.newAccount", { account: shortAddress(account) }) : t("terms.intro")}
          </p>
          <p className="fine terms-lang">
            {english ? t("terms.englishShown") : t("terms.englishNote")}{" "}
            <button type="button" className="link" onClick={() => setEnglish((e) => !e)}>
              {english ? t("terms.showTranslation") : t("terms.showEnglish")}
            </button>
          </p>

          <ol className="clauses">
            {CLAUSES.map((_, i) => {
              const c = clause(i);
              const done = !!sealed || initials.has(i);
              return (
                <li key={i} className={done ? "is-done" : undefined}>
                  <span className="clause-no">{String(i + 1).padStart(2, "0")}</span>
                  <div className="clause-text">
                    <strong>{c.title}</strong>
                    <p>{c.body}</p>
                  </div>
                  {(!viewOnly || sealed) && (
                    <button
                      type="button"
                      className={`initial${done ? " is-done" : ""}`}
                      style={{ "--tilt": `${((i * 37) % 13) - 6}deg` } as React.CSSProperties}
                      aria-pressed={done}
                      aria-label={done ? t("terms.initialed", { n: i + 1 }) : t("terms.initialHere", { n: i + 1 })}
                      onClick={() =>
                        setInitials((s) => {
                          const next = new Set(s);
                          if (next.has(i)) next.delete(i);
                          else next.add(i);
                          return next;
                        })
                      }
                      disabled={signing || signedOnly || !!sealed}
                    >
                      {done ? <span className="initial-ink">{stampText}</span> : t("terms.initial")}
                    </button>
                  )}
                </li>
              );
            })}
          </ol>

          <p className="fine terms-hash">
            {t("terms.hash")} <code>{hash ?? "…"}</code>
          </p>
        </div>

        <footer className="terms-foot">
          {sealed ? (
            <Seal sealed={sealed} required={!viewOnly} onEnter={onClose} copied={copied} onCopy={() => void navigator.clipboard?.writeText(sealed.signature).then(() => setCopied(true))} />
          ) : viewOnly ? (
            <div className="terms-viewfoot">
              <p className="fine">{account ? t("terms.notSignedYet") : t("terms.connectToSign")}</p>
              <button type="button" className="plain-button terms-close" onClick={onClose}>
                {t("terms.close")}
              </button>
            </div>
          ) : (
            <div className="terms-sign">
              <p className="terms-progress" aria-live="polite">
                {t("terms.progress", { done: initials.size, total: CLAUSES.length })}
              </p>
              {account ? (
                <>
                  <div className="sign-line">
                    <span className="sign-x" aria-hidden="true">
                      ✕
                    </span>
                    <span className="sign-who">{shortAddress(account)}</span>
                  </div>
                  <button type="button" className="stamp-button" onClick={() => void sign()} disabled={!allInitialed || signing || !hash}>
                    {signing ? t("terms.signing") : t("terms.sign")}
                  </button>
                  <p className="fine">{mock ? t("terms.mockSign") : t("terms.free")}</p>
                </>
              ) : picking ? (
                <div className="terms-wallets" role="group" aria-label={t("nav.pickWallet")}>
                  <p className="fine">{t("nav.pickWallet")}</p>
                  {picking.map((w) => (
                    <button type="button" key={w.id} className="plain-button" onClick={() => void chain.connect(w.id)}>
                      {w.icon && <img src={w.icon} alt="" width={20} height={20} />} {w.name}
                    </button>
                  ))}
                </div>
              ) : (
                <>
                  <button type="button" className="stamp-button" onClick={() => void chain.connect()} disabled={!allInitialed}>
                    {t("terms.connect")}
                  </button>
                  <p className="fine">
                    {t("terms.noWallet")}{" "}
                    <button type="button" className="link" onClick={markInitialed} disabled={!allInitialed}>
                      {t("terms.continueAnyway")}
                    </button>
                  </p>
                </>
              )}
              {(error || chain.connectError) && (
                <p className="fine problem" role="alert">
                  {error ?? chain.connectError}
                </p>
              )}
              <p className="fine terms-leave">
                <a className="link" href="/">
                  {t("terms.leave")}
                </a>
              </p>
            </div>
          )}
        </footer>
      </div>
    </div>
  );
}

/** The signature, sealed: a wax seal, the signature drawn as a barcode, and where it is kept. */
function Seal({ sealed, required, onEnter, copied, onCopy }: { sealed: SignedTerms; required: boolean; onEnter: () => void; copied: boolean; onCopy: () => void }) {
  const t = useT();
  const at = /Signed on (\S+)\./.exec(sealed.message)?.[1];
  const date = at ? new Date(at).toLocaleString() : "";
  return (
    <div className="seal-block">
      <div className="wax" aria-hidden="true">
        <svg viewBox="0 0 120 120" width="112" height="112">
          <defs>
            <path id="seal-ring" d="M60 60 m-41 0 a41 41 0 1 1 82 0 a41 41 0 1 1 -82 0" />
          </defs>
          <circle cx="60" cy="60" r="56" className="wax-edge" />
          <circle cx="60" cy="60" r="48" className="wax-face" />
          <text className="wax-ring">
            <textPath href="#seal-ring">DO NOT OPEN · DO NOT OPEN · DO NOT OPEN ·</textPath>
          </text>
          <text x="60" y="58" className="wax-mark">
            DNO
          </text>
          <text x="60" y="76" className="wax-sig">
            {sealed.signature.slice(2, 8)}
          </text>
        </svg>
      </div>
      <div className="seal-text">
        <p className="seal-title">{t("terms.sealed")}</p>
        <p className="fine">{t("terms.signedBy", { account: shortAddress(sealed.account), date })}</p>
        <Barcode hex={sealed.signature} />
        <p className="fine">
          {sealed.recorded ? t("terms.recorded") : t("terms.local")}{" "}
          <button type="button" className="link" onClick={onCopy}>
            {copied ? t("terms.copied") : t("terms.copy")}
          </button>
        </p>
        {required ? (
          <button type="button" className="stamp-button seal-enter" onClick={onEnter}>
            {t("terms.enter")}
          </button>
        ) : (
          <button type="button" className="plain-button terms-close" onClick={onEnter}>
            {t("terms.close")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Each hex digit of the signature as a bar: no two signatures print alike. */
function Barcode({ hex }: { hex: string }) {
  const digits = hex.replace(/^0x/, "").slice(0, 96);
  let x = 0;
  const bars = [...digits].map((d, i) => {
    const v = parseInt(d, 16);
    const w = 1 + (v % 3);
    const bar = <rect key={i} x={x} y={0} width={w} height={v > 11 ? 30 : 24} />;
    x += w + 1 + (v >> 3);
    return bar;
  });
  return (
    <svg className="barcode" viewBox={`0 0 ${x} 30`} preserveAspectRatio="none" role="img" aria-label={hex}>
      {bars}
    </svg>
  );
}
