import { useEffect, useState, type FormEvent } from "react";
import { useLocale } from "../i18n/locale";
import { useT } from "../home/i18n";
import { hasXPassToken, xPassApi } from "../xpass";

const MIN = 10;
const MAX = 600;
const TOKEN = "dno:xpass:token";

const passToken = (): string | null => {
  try {
    return hasXPassToken() ? localStorage.getItem(TOKEN) : null;
  } catch {
    return null;
  }
};

/**
 * The suggestion box: a cardboard box with a slot, and a slip to write an idea on. Only the team
 * reads them. The X handle of the player's pass goes with it, when there is one.
 */
export function IdeaBox() {
  const t = useT();
  const locale = useLocale();
  const api = xPassApi();
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "posted" | "error">("idle");
  const [received, setReceived] = useState<number | null>(null);

  useEffect(() => {
    if (!api) return;
    let on = true;
    fetch(`${api}/v1/ideas/count`)
      .then((r) => (r.ok ? (r.json() as Promise<{ data: { received: number } }>) : null))
      .then((j) => on && j && setReceived(j.data.received))
      .catch(() => undefined);
    return () => {
      on = false;
    };
  }, [api]);

  if (!api) return null;
  const length = text.trim().length;

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (length < MIN || length > MAX) return;
    setState("sending");
    try {
      const token = passToken();
      const res = await fetch(`${api}/v1/ideas`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ text, locale }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setReceived(((await res.json()) as { data: { received: number } }).data.received);
      setState("posted");
      setText("");
    } catch {
      setState("error");
    }
  };

  return (
    <section id="ideas" className="home-section idea-box" aria-labelledby="ideas-title">
      <div className="idea-crate" aria-hidden="true">
        <span className="idea-slot" />
        <span className="idea-label">{t("apply.ideas.label")}</span>
        {state === "posted" && <span className="idea-slip-in" />}
      </div>
      <div className="idea-desk">
        <p className="kicker">{t("apply.ideas.kicker")}</p>
        <h2 id="ideas-title">{t("apply.ideas.title")}</h2>
        <p className="section-lede">{t("apply.ideas.lede")}</p>
        <form className="idea-form" onSubmit={(e) => void send(e)}>
          <label className="sr-only" htmlFor="idea-text">
            {t("apply.ideas.title")}
          </label>
          <textarea
            id="idea-text"
            className="idea-slip"
            value={text}
            maxLength={MAX}
            rows={4}
            placeholder={t("apply.ideas.placeholder")}
            onChange={(e) => {
              setText(e.target.value);
              if (state !== "sending") setState("idle");
            }}
          />
          <p className="idea-foot">
            <span className={length > 0 && length < MIN ? "is-short" : undefined}>{t("apply.ideas.count", { n: length, max: MAX })}</span>
            <button type="submit" className="btn btn-small" disabled={length < MIN || state === "sending"} aria-busy={state === "sending"}>
              {state === "sending" ? t("apply.ideas.sending") : t("apply.ideas.send")}
            </button>
          </p>
          <p className="idea-out" aria-live="polite">
            {state === "posted" && t("apply.ideas.thanks")}
            {state === "error" && t("apply.ideas.error")}
            {state !== "posted" && state !== "error" && received !== null && received > 0 && t("apply.ideas.received", { count: received })}
          </p>
        </form>
      </div>
    </section>
  );
}
