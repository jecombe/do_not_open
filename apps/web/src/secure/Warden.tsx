import { useEffect, useId, useRef, useState } from "react";
import { askClerk, chatApi, ClerkError, type ClerkAnswer, type Turn } from "../chat/api";
import { useLocale, type Locale } from "../i18n/locale";
import { projectDocsPath, vaultDocsPath } from "../site";
import { glyphs, reduced, useDecrypt } from "./cipher";
import { useT } from "./i18n";
import "./warden.css";

/** One line of the conversation: a question, an answer, the docs quoted instead, or a failure. */
type Line =
  | { role: "user"; text: string }
  | { role: "assistant"; answer: ClerkAnswer }
  | { role: "error"; kind: "busy" | "network" };

const STORAGE_KEY = "dno.warden";
const KEPT = 30;
const QUOTE = 420;
const SUGGESTIONS = ["warden.try1", "warden.try2", "warden.try3"] as const;

function load(): Line[] {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Line[]) : [];
  } catch {
    return [];
  }
}

function save(lines: Line[]): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(lines.slice(-KEPT)));
  } catch {
    // Private mode or full storage: the conversation lives for this page only.
  }
}

const history = (lines: Line[]): Turn[] =>
  lines.flatMap((l): Turn[] => (l.role === "user" ? [{ role: "user", text: l.text }] : l.role === "assistant" && l.answer.answer ? [{ role: "assistant", text: l.answer.answer }] : []));

/** A section of the Warden's book: `vault-<id>` is in the vault's docs, `project-<id>` in the project's. */
function docsLink(section: string, locale: Locale): string {
  const [book, ...rest] = section.split("-");
  const id = rest.join("-");
  return `${book === "project" ? projectDocsPath(locale) : vaultDocsPath(locale)}#${id}`;
}

type Mood = "idle" | "thinking" | "speaking" | "unlocking";

/**
 * The Warden's face: a small safe with two eyes on its door and a combination dial that spins
 * while it thinks. It blinks now and then; it clicks its dial and opens its door a crack when
 * the panel opens.
 */
function Safe({ mood }: { mood: Mood }) {
  return (
    <svg className={`warden-safe is-${mood}`} viewBox="0 0 64 64" aria-hidden="true">
      <rect className="warden-body" x="6" y="8" width="52" height="48" rx="8" />
      <rect className="warden-foot" x="12" y="55" width="8" height="4" rx="1.5" />
      <rect className="warden-foot" x="44" y="55" width="8" height="4" rx="1.5" />
      <g className="warden-door">
        <rect x="11" y="13" width="42" height="38" rx="5" />
        <g className="warden-eyes">
          <circle cx="22" cy="25" r="3.2" />
          <circle cx="42" cy="25" r="3.2" />
        </g>
        <g className="warden-dial">
          <circle cx="32" cy="39" r="7.5" />
          <path d="M32 31.5v3M32 43.5v3M24.5 39h3M36.5 39h3" />
          <circle className="warden-dial-dot" cx="32" cy="34" r="1.2" />
        </g>
        <rect className="warden-handle" x="47" y="35" width="3" height="9" rx="1.5" />
      </g>
    </svg>
  );
}

/** An answer that arrives as ciphertext and decrypts in place. */
function Reveal({ text, animate }: { text: string; animate: boolean }) {
  const shown = useDecrypt(text, 600, animate ? 9 : 0);
  return (
    <p className="warden-text" aria-label={text}>
      <span aria-hidden="true">{animate ? shown : text}</span>
    </p>
  );
}

/** A line of ciphertext that keeps churning: what thinking looks like here. */
function Churn() {
  const [text, setText] = useState(() => glyphs(18));
  useEffect(() => {
    if (reduced()) return;
    const id = setInterval(() => setText(glyphs(18)), 90);
    return () => clearInterval(id);
  }, []);
  return <span className="warden-churn">{text}</span>;
}

/**
 * The Warden: the home page's and the vault's chat. It answers questions about the vault and
 * the project from their docs (the API's `book: "vault"`), as the clerk does for the game.
 * Without an API it is not shown.
 */
export function Warden() {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<Line[]>(load);
  const [draft, setDraft] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [mood, setMood] = useState<Mood>("idle");
  /** Lines from before this opening: shown as they are, not decrypted again. */
  const [seen, setSeen] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  const titleId = useId();

  useEffect(() => save(lines), [lines]);
  useEffect(() => {
    if (!open) return;
    setSeen(lines.length);
    input.current?.focus();
    setMood("unlocking");
    const id = setTimeout(() => setMood("idle"), 900);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(id);
      window.removeEventListener("keydown", onKey);
    };
    // Only when it opens: `lines` grows while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [lines, waiting, open]);
  useEffect(() => () => abort.current?.abort(), []);

  if (!chatApi()) return null;

  const send = async (question: string) => {
    const q = question.trim();
    if (q.length < 2 || waiting) return;
    const before = history(lines);
    setLines((l) => [...l, { role: "user", text: q }]);
    setDraft("");
    setWaiting(true);
    setMood("thinking");
    abort.current = new AbortController();
    try {
      const answer = await askClerk(q.slice(0, 500), locale, before, abort.current.signal, "vault");
      setLines((l) => [...l, { role: "assistant", answer }]);
      setMood("speaking");
      setTimeout(() => setMood("idle"), 1600);
    } catch (error) {
      if (abort.current.signal.aborted) return;
      setLines((l) => [...l, { role: "error", kind: error instanceof ClerkError ? error.kind : "network" }]);
      setMood("idle");
    } finally {
      setWaiting(false);
    }
  };

  const link = (section: string, title: string) => (
    <a key={section} className="warden-source" href={docsLink(section, locale)}>
      {title}
    </a>
  );

  return (
    <>
      <button type="button" data-tour="warden" className={`warden-tab${open ? " is-open" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-label={t("warden.open")} title={t("warden.open")}>
        <Safe mood={open ? mood : waiting ? "thinking" : "idle"} />
        <span className="warden-tab-label">{t("warden.name")}</span>
      </button>

      {open && (
        <section className="warden" role="dialog" aria-labelledby={titleId} aria-modal="false">
          <header className="warden-head">
            <Safe mood={mood} />
            <div>
              <h2 id={titleId}>{t("warden.title")}</h2>
              <p className="warden-status">
                <i aria-hidden="true" />
                {waiting ? t("warden.thinking") : t("warden.on")}
              </p>
            </div>
            <div className="warden-head-actions">
              {lines.length > 0 && (
                <button type="button" className="warden-link" onClick={() => setLines([])} disabled={waiting}>
                  {t("warden.clear")}
                </button>
              )}
              <button type="button" className="warden-close" onClick={() => setOpen(false)} aria-label={t("warden.close")}>
                ×
              </button>
            </div>
          </header>

          <div className="warden-log" ref={log} aria-live="polite">
            <p className="warden-line is-warden">{t("warden.hello")}</p>
            {lines.length === 0 && (
              <div className="warden-try">
                {SUGGESTIONS.map((k) => (
                  <button key={k} type="button" onClick={() => void send(t(k))}>
                    {t(k)}
                  </button>
                ))}
              </div>
            )}
            {lines.map((l, i) =>
              l.role === "user" ? (
                <p key={i} className="warden-line is-you">
                  {l.text}
                </p>
              ) : l.role === "error" ? (
                <p key={i} className="warden-line is-warden is-problem">
                  {t(l.kind === "busy" ? "warden.busy" : "warden.network")}
                </p>
              ) : l.answer.mode === "ai" ? (
                <div key={i} className="warden-line is-warden">
                  <Reveal text={l.answer.answer ?? ""} animate={i >= seen} />
                  {l.answer.sources.length > 0 && (
                    <p className="warden-sources">
                      {t("warden.read")} {l.answer.sources.map((s) => link(s.section, s.title))}
                    </p>
                  )}
                </div>
              ) : (
                <div key={i} className="warden-line is-warden">
                  <p className="warden-text">{t(l.answer.reason === "limit" ? "warden.quota" : l.answer.passages.length ? "warden.away" : "warden.nothing")}</p>
                  {l.answer.passages.map((p, j) => (
                    <blockquote key={j} className="warden-quote">
                      <cite>{link(p.section, p.heading ? `${p.title}, ${p.heading}` : p.title)}</cite>
                      <p>{p.text.length > QUOTE ? `${p.text.slice(0, QUOTE).replace(/\s+\S*$/, "")}…` : p.text}</p>
                    </blockquote>
                  ))}
                </div>
              ),
            )}
            {waiting && (
              <p className="warden-line is-warden is-waiting">
                {t("warden.thinking")} <Churn />
              </p>
            )}
          </div>

          <form
            className="warden-form"
            onSubmit={(e) => {
              e.preventDefault();
              void send(draft);
            }}
          >
            <textarea
              ref={input}
              value={draft}
              rows={2}
              maxLength={500}
              placeholder={t("warden.placeholder")}
              aria-label={t("warden.placeholder")}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(draft);
                }
              }}
            />
            <button type="submit" className="sec-btn sec-btn-small" disabled={waiting || draft.trim().length < 2}>
              {t("warden.send")}
            </button>
          </form>
          <p className="warden-fine">{t("warden.fine")}</p>
        </section>
      )}
    </>
  );
}
