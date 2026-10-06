import { useState, type FormEvent } from "react";
import { X_PASS_BONUS } from "@dno/chain-adapter/standings";
import { X_FOLLOW, X_HANDLE, xPost } from "../links";
import { useLocale } from "../i18n/locale";
import { duelRankingPath, homePath, SITE_URL } from "../site";
import { followXPass, startXPass, useXPass, verifyXPassTweet, xPassApi, XPassError } from "../xpass";
import { useT } from "./i18n";
import { usePassCount } from "./Passport";

const REFUSALS = ["bad-tweet-url", "tweet-not-found", "code-missing", "tweet-used", "x-down", "no-pass"] as const;

/**
 * The first thing on the home page: a boarding pass for the mainnet list, X first. Follow the
 * account, post a tweet carrying your boarding code, paste its link: the API reads it through X's
 * public oEmbed and the pass shows your handle. A wallet and testnet play are the bonus.
 */
export function Boarding() {
  const t = useT();
  const locale = useLocale();
  const [count] = usePassCount();
  const { pass, loading, set } = useXPass();
  const [busy, setBusy] = useState<"code" | "verify" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [clickedFollow, setClickedFollow] = useState(false);
  const live = xPassApi() !== null;
  const url = `${SITE_URL}${homePath(locale)}`;

  const fail = (e: unknown) => {
    const code = e instanceof XPassError ? e.code : "network";
    setError((REFUSALS as readonly string[]).includes(code) ? t(`home.boarding.error.${code as (typeof REFUSALS)[number]}`, { code: pass?.code ?? "" }) : t("home.boarding.error.network"));
  };

  const ensurePass = async () => pass ?? (await startXPass().then((p) => (set(p), p)));

  const getCode = async () => {
    setBusy("code");
    setError(null);
    try {
      await ensurePass();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  // The link opens X at once; the pass notes the declared follow behind it.
  const onFollow = () => {
    setClickedFollow(true);
    if (!live || pass?.followed) return;
    void ensurePass()
      .then(() => followXPass())
      .then(set, () => undefined);
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    if (!pass || !link.trim()) return;
    setBusy("verify");
    setError(null);
    try {
      set(await verifyXPassTweet(link.trim()));
      setLink("");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const followed = !!pass?.followed || clickedFollow;
  const verified = !!pass?.handle;
  const tweet = t(pass ? "home.boarding.tweet" : "home.boarding.tweetNoCode", { handle: X_HANDLE, code: pass?.code ?? "" });

  return (
    <section id="boarding" className={`boarding${verified ? " is-boarded" : ""}`} aria-labelledby="boarding-title">
      <div className="boarding-stub" aria-hidden="true">
        <span className="boarding-gate">{t("home.boarding.gate")}</span>
        <strong>X</strong>
        <span className="boarding-barcode" />
      </div>

      <div className="boarding-main">
        <p className="boarding-kicker">
          <span className="boarding-live" aria-hidden="true" />
          {t("home.boarding.kicker")}
          {count && <span className="boarding-count">{t("home.boarding.count", { count: count.claimants, places: count.places })}</span>}
        </p>
        <h2 id="boarding-title">{verified ? t("home.boarding.done", { handle: pass!.handle! }) : t("home.boarding.title")}</h2>

        <ol className="boarding-steps">
          <li className={followed ? "is-done" : undefined}>
            <span className="boarding-n" aria-hidden="true">
              {followed ? "✓" : 1}
            </span>
            <a className="btn btn-small btn-x" href={X_FOLLOW} target="_blank" rel="noreferrer" onClick={onFollow}>
              <XLogo />
              {t("home.boarding.follow", { handle: X_HANDLE })}&nbsp;↗
            </a>
          </li>

          <li className={verified ? "is-done" : undefined}>
            <span className="boarding-n" aria-hidden="true">
              {verified ? "✓" : 2}
            </span>
            {live && !pass ? (
              <button type="button" className="btn btn-small" onClick={() => void getCode()} disabled={busy === "code" || loading} aria-busy={busy === "code"}>
                {busy === "code" ? t("home.boarding.gettingCode") : t("home.boarding.getCode")}
              </button>
            ) : (
              <a className="btn btn-small" href={xPost(tweet, url)} target="_blank" rel="noreferrer">
                <XLogo />
                {t("home.boarding.post")}&nbsp;↗
              </a>
            )}
            {pass && (
              <span className="boarding-code" title={t("home.boarding.codeHint")}>
                {pass.code}
              </span>
            )}
          </li>

          {live && (
            <li className={`boarding-verify${verified ? " is-done" : ""}`}>
              <span className="boarding-n" aria-hidden="true">
                {verified ? "✓" : 3}
              </span>
              {verified ? (
                <a className="boarding-proof" href={pass!.tweetUrl ?? undefined} target="_blank" rel="noreferrer">
                  {t("home.boarding.verified", { handle: pass!.handle! })}&nbsp;↗
                </a>
              ) : (
                <form onSubmit={(e) => void verify(e)}>
                  <label className="sr-only" htmlFor="boarding-link">
                    {t("home.boarding.paste")}
                  </label>
                  <input
                    id="boarding-link"
                    value={link}
                    onChange={(e) => setLink(e.target.value)}
                    placeholder={pass ? t("home.boarding.paste") : t("home.boarding.pasteFirst")}
                    disabled={!pass}
                    inputMode="url"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <button type="submit" className="btn btn-small btn-paper" disabled={!pass || !link.trim() || busy === "verify"} aria-busy={busy === "verify"}>
                    {busy === "verify" ? t("home.boarding.verifying") : t("home.boarding.verify")}
                  </button>
                </form>
              )}
            </li>
          )}
        </ol>
        <p className="boarding-error" aria-live="polite">
          {error}
        </p>
      </div>

      <a className="boarding-bonus" href={verified ? duelRankingPath(locale) : "#pass"}>
        <span className="boarding-bonus-tag">{t("home.boarding.bonus.tag")}</span>
        {verified && pass!.address ? (
          <>
            <strong>{t("home.boarding.wallet.done", { bonus: X_PASS_BONUS })}</strong>
            <span>{t("home.boarding.wallet.doneBody")}</span>
            <span className="boarding-bonus-go">{t("home.boarding.wallet.play")}&nbsp;→</span>
          </>
        ) : verified ? (
          <>
            <strong>{t("home.boarding.wallet.add", { bonus: X_PASS_BONUS })}</strong>
            <span>{t("home.boarding.wallet.addBody")}</span>
            <span className="boarding-bonus-go">{t("home.boarding.wallet.go")}&nbsp;→</span>
          </>
        ) : (
          <>
            <strong>{t("home.boarding.bonus.title")}</strong>
            <span>{t("home.boarding.bonus.body")}</span>
            <span className="boarding-bonus-go">{t("home.boarding.bonus.go")}&nbsp;↓</span>
          </>
        )}
      </a>
    </section>
  );
}

function XLogo() {
  return (
    <svg className="x-logo" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-6.3L6.4 22H3.3l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z" />
    </svg>
  );
}
