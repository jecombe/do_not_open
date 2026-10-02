import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n/app";
import { useLocale } from "../i18n/locale";
import { askClerk, chatApi, ClerkError, manualLink, type ClerkAnswer, type Turn } from "./api";
import "./clerk.css";

/** One line of the conversation as shown: a question, an answer, or the manual quoted instead. */
type Line =
  | { role: "user"; text: string }
  | { role: "assistant"; answer: ClerkAnswer }
  | { role: "error"; kind: "busy" | "network" };

const STORAGE_KEY = "dno.clerk";
/** Lines kept across reloads of the tab. */
const KEPT = 30;
/** How long a quoted passage may run before it is cut. */
const QUOTE = 420;
const SUGGESTIONS = ["chat.try1", "chat.try2", "chat.try3"] as const;

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

/** What the model is told came before: the questions and its own answers, not the quotes. */
function history(lines: Line[]): Turn[] {
  return lines.flatMap((l): Turn[] =>
    l.role === "user" ? [{ role: "user", text: l.text }] : l.role === "assistant" && l.answer.answer ? [{ role: "assistant", text: l.answer.answer }] : [],
  );
}

/**
 * The depot's clerk: a chat that answers questions about the game from the manual. It needs
 * the API (the model's key stays there); without one, it is not shown at all. `inline` puts its
 * opener in a line of text (the game's footer) instead of a tab on the page's edge.
 */
export function Clerk({ newTab = false, inline = false }: { newTab?: boolean; inline?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<Line[]>(load);
  const [draft, setDraft] = useState("");
  const [waiting, setWaiting] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  const titleId = useId();

  useEffect(() => save(lines), [lines]);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [lines, waiting, open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  useEffect(() => () => abort.current?.abort(), []);

  if (!chatApi()) return null;

  const send = async (question: string) => {
    const q = question.trim();
    if (q.length < 2 || waiting) return;
    const before = history(lines);
    setLines((l) => [...l, { role: "user", text: q }]);
    setDraft("");
    setWaiting(true);
    abort.current = new AbortController();
    try {
      const answer = await askClerk(q.slice(0, 500), locale, before, abort.current.signal);
      setLines((l) => [...l, { role: "assistant", answer }]);
    } catch (error) {
      if (abort.current.signal.aborted) return;
      setLines((l) => [...l, { role: "error", kind: error instanceof ClerkError ? error.kind : "network" }]);
    } finally {
      setWaiting(false);
    }
  };

  const link = (section: string, title: string) => (
    <a key={section} className="clerk-source" href={manualLink(section, locale)} {...(newTab ? { target: "_blank", rel: "noreferrer" } : { onClick: () => setOpen(false) })}>
      {title}
    </a>
  );

  return (
    <>
      <button
        type="button"
        className={inline ? "link clerk-inline" : `clerk-tab${open ? " is-open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={t("chat.open")}
        title={t("chat.open")}
      >
        {!inline && (
          <span className="clerk-tab-mark" aria-hidden="true">
            ?
          </span>
        )}
        <span className="clerk-tab-label">{t("chat.open")}</span>
      </button>

      {open && (
        <section className={`clerk${inline ? " is-inline" : ""}`} role="dialog" aria-labelledby={titleId} aria-modal="false">
          <header className="clerk-head">
            <h2 id={titleId}>{t("chat.title")}</h2>
            <div className="clerk-head-actions">
              {lines.length > 0 && (
                <button type="button" className="clerk-link" onClick={() => setLines([])} disabled={waiting}>
                  {t("chat.clear")}
                </button>
              )}
              <button type="button" className="clerk-close" onClick={() => setOpen(false)} aria-label={t("chat.close")}>
                ×
              </button>
            </div>
          </header>

          <div className="clerk-log" ref={log} aria-live="polite">
            <p className="clerk-line is-clerk">{t("chat.hello")}</p>
            {lines.length === 0 && (
              <div className="clerk-try">
                {SUGGESTIONS.map((k) => (
                  <button key={k} type="button" onClick={() => void send(t(k))}>
                    {t(k)}
                  </button>
                ))}
              </div>
            )}
            {lines.map((l, i) =>
              l.role === "user" ? (
                <p key={i} className="clerk-line is-you">
                  {l.text}
                </p>
              ) : l.role === "error" ? (
                <p key={i} className="clerk-line is-clerk is-problem">
                  {t(l.kind === "busy" ? "chat.busy" : "chat.network")}
                </p>
              ) : l.answer.mode === "ai" ? (
                <div key={i} className="clerk-line is-clerk">
                  <p className="clerk-text">{l.answer.answer}</p>
                  {l.answer.sources.length > 0 && (
                    <p className="clerk-sources">
                      {t("chat.read")} {l.answer.sources.map((s) => link(s.section, s.title))}
                    </p>
                  )}
                </div>
              ) : (
                <div key={i} className="clerk-line is-clerk">
                  <p className="clerk-text">{t(l.answer.reason === "limit" ? "chat.quotaYou" : l.answer.passages.length ? "chat.away" : "chat.nothing")}</p>
                  {l.answer.passages.map((p, j) => (
                    <blockquote key={j} className="clerk-quote">
                      <cite>{link(p.section, p.heading ? `${p.title}, ${p.heading}` : p.title)}</cite>
                      <p>{p.text.length > QUOTE ? `${p.text.slice(0, QUOTE).replace(/\s+\S*$/, "")}…` : p.text}</p>
                    </blockquote>
                  ))}
                </div>
              ),
            )}
            {waiting && (
              <p className="clerk-line is-clerk is-waiting">
                {t("chat.looking")}
                <span className="clerk-dots" aria-hidden="true" />
              </p>
            )}
          </div>

          <form
            className="clerk-form"
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
              placeholder={t("chat.placeholder")}
              aria-label={t("chat.placeholder")}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(draft);
                }
              }}
            />
            <button type="submit" className="clerk-send" disabled={waiting || draft.trim().length < 2}>
              {t("chat.send")}
            </button>
          </form>
          <p className="clerk-fine">{t("chat.fine")}</p>
        </section>
      )}
    </>
  );
}
