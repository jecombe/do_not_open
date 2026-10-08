import { useEffect, useState, type FormEvent } from "react";
import { DISCORD_BONUS, REFERRAL_BONUS, REFERRAL_CAP, X_PASS_BONUS } from "@dno/chain-adapter/standings";
import { ANNOUNCEMENT_TWEET_ID, announcementLinks, DISCORD, X_FOLLOW, X_HANDLE, xPost } from "../links";
import { useLocale } from "../i18n/locale";
import { canShareFiles, copy, download, intentUrl } from "../share/links";
import { applyPath, duelRankingPath, homePath, SITE_URL } from "../site";
import {
  declareXTask,
  discordBoardCode,
  forgetReferral,
  pendingReferral,
  referralUrl,
  referXPass,
  rememberReferral,
  signInWithX,
  xPassStatus,
  startXPass,
  useSeats,
  useXPass,
  verifyXPassTweet,
  xPassApi,
  XPassError,
  xSettings,
  type XPassView,
  type XTask,
} from "../xpass";
import { useT } from "./i18n";

const REFUSALS = ["bad-tweet-url", "tweet-not-found", "code-missing", "tweet-used", "x-down", "no-pass", "sign-in-expired", "sign-in-refused", "list-full"] as const;
const TASKS: XTask[] = ["follow", "like", "reply", "repost"];
/** Seconds between opening X and "mark it done", as on other boarding pages: time to do it. */
const WAIT = 8;

/**
 * The first thing on the home page: a boarding pass for the mainnet list, X first. On the left,
 * the X account: Sign in with X, then the boarding tweet (where the API has no X app, a post
 * carrying the boarding code proves the account instead). On the right, four quick tasks on X,
 * declared by the player and checked by hand before mainnet. Below, the bonus: the Discord
 * server (proved with `/board` there), a wallet and testnet play, and once the account is
 * connected, the pass's referral link. A `?ref=` this page was opened with names the referrer of
 * the pass this browser starts.
 */
export function Boarding() {
  const t = useT();
  const locale = useLocale();
  const seats = useSeats();
  const { pass, loading, set } = useXPass();
  const [busy, setBusy] = useState<"code" | "verify" | "x" | null>(null);
  const [signIn, setSignIn] = useState<boolean | null>(null);
  const [discord, setDiscord] = useState(false);
  const [announcement, setAnnouncement] = useState<string | null>(ANNOUNCEMENT_TWEET_ID || null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const live = xPassApi() !== null;
  const url = `${SITE_URL}${homePath(locale)}`;

  useEffect(() => {
    let on = true;
    void xSettings().then((x) => {
      if (!on) return;
      setSignIn(x.signIn);
      setDiscord(x.discord);
      if (x.announcement) setAnnouncement(x.announcement);
    });
    return () => {
      on = false;
    };
  }, []);

  const fail = (e: unknown, code = pass?.code ?? "") => {
    const c = e instanceof XPassError ? e.code : "network";
    setError((REFUSALS as readonly string[]).includes(c) ? t(`home.boarding.error.${c as (typeof REFUSALS)[number]}`, { code }) : t("home.boarding.error.network"));
  };

  const ensurePass = async (): Promise<XPassView> => {
    if (pass) return pass;
    const p = await startXPass(pendingReferral());
    forgetReferral();
    set(p);
    return p;
  };

  // A referral link opened on a browser that already holds a pass: it names the referrer, if the
  // pass has none yet and its X account is not connected. Any refusal drops the code.
  useEffect(() => rememberReferral(), []);
  useEffect(() => {
    const ref = pendingReferral();
    if (!pass || !ref) return;
    if (pass.handle || pass.referredBy) {
      forgetReferral();
      return;
    }
    referXPass(ref).then(
      (p) => {
        forgetReferral();
        set(p);
      },
      (e: unknown) => {
        if (e instanceof XPassError && e.code !== "network") forgetReferral();
      },
    );
  }, [pass, set]);

  // Back from X: `?x=ok` or what went wrong. The pass itself reloads with the page.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("x");
    if (!outcome) return;
    if (outcome !== "ok") fail(new XPassError(outcome));
    params.delete("x");
    const q = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${q ? `?${q}` : ""}${window.location.hash}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connectX = async () => {
    setBusy("x");
    setError(null);
    try {
      await ensurePass();
      const here = new URL(window.location.href);
      await signInWithX(`${here.origin}${here.pathname}${here.search}`);
    } catch (e) {
      fail(e);
      setBusy(null);
    }
  };

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

  const declare = async (task: XTask) => {
    setError(null);
    try {
      await ensurePass();
      set(await declareXTask(task));
    } catch (e) {
      fail(e);
    }
  };

  const verified = !!pass?.handle;
  const seated = !!pass?.seated;
  const required: XTask[] = seats?.required ?? ["follow", "post"];
  const missing = required.filter((k) => !pass?.tasks?.[k]).length;
  const done = TASKS.filter((k) => pass?.tasks?.[k]).length;
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
          {seats && seats.places !== null && <span className="boarding-count">{t("home.boarding.seats", { taken: seats.taken, places: seats.places })}</span>}
        </p>
        <h2 id="boarding-title">
          {seated ? t("home.boarding.done", { handle: pass!.handle! }) : verified ? t("home.boarding.almost", { handle: pass!.handle! }) : t("home.boarding.title")}
        </h2>
        <p className={`boarding-seat${seated ? " is-seated" : ""}`}>
          {seated ? t("home.boarding.seated") : t("home.boarding.toSeat", { count: (verified ? 0 : 1) + missing })}
        </p>

        <div className="boarding-body">
          <div className="boarding-part">
            <h3>
              <span className="boarding-part-n">01</span> {t("home.boarding.connect")}
            </h3>
            {signIn ? (
              <ol className="boarding-steps">
                <li className={verified ? "is-done" : undefined}>
                  <span className="boarding-n" aria-hidden="true">
                    {verified ? "✓" : 1}
                  </span>
                  {verified ? (
                    <span className="boarding-proof">{t("home.boarding.connected", { handle: pass!.handle! })}</span>
                  ) : (
                    <button type="button" className="btn btn-x boarding-signin" onClick={() => void connectX()} disabled={busy === "x" || loading} aria-busy={busy === "x"}>
                      <XLogo />
                      {busy === "x" ? t("home.boarding.signingIn") : t("home.boarding.signIn")}
                    </button>
                  )}
                </li>
                <li className="boarding-post">
                  <span className="boarding-n" aria-hidden="true">
                    {pass?.tasks?.post ? "✓" : 2}
                  </span>
                  <ul className="boarding-tasks boarding-tasks-one">
                    <Task task="post" announcement={announcement} href={xPost(t("home.boarding.tweetNoCode", { handle: X_HANDLE }), url)} done={!!pass?.tasks?.post} live={live} onDone={() => declare("post")} />
                  </ul>
                </li>
              </ol>
            ) : signIn === false ? (
              <ol className="boarding-steps">
                <li className={pass ? "is-done" : undefined}>
                  <span className="boarding-n" aria-hidden="true">
                    {pass ? "✓" : 1}
                  </span>
                  {live && !pass ? (
                    <button type="button" className="btn btn-small" onClick={() => void getCode()} disabled={busy === "code" || loading} aria-busy={busy === "code"}>
                      {busy === "code" ? t("home.boarding.gettingCode") : t("home.boarding.getCode")}
                    </button>
                  ) : pass ? (
                    <span className="boarding-code" title={t("home.boarding.codeHint")}>
                      {pass.code}
                    </span>
                  ) : null}
                </li>
                <li className={verified ? "is-done" : undefined}>
                  <span className="boarding-n" aria-hidden="true">
                    {verified ? "✓" : 2}
                  </span>
                  <a className={`btn btn-small${live && !pass ? " is-waiting" : ""}`} href={xPost(tweet, url)} target="_blank" rel="noreferrer" aria-disabled={live && !pass}>
                    <XLogo />
                    {t("home.boarding.post")}&nbsp;↗
                  </a>
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
            ) : null}
          </div>

          <div className="boarding-part">
            <h3>
              <span className="boarding-part-n">02</span> {t("home.boarding.tasks", { done, total: TASKS.length })}
            </h3>
            <ul className="boarding-tasks">
              {TASKS.map((task) => (
                <Task key={task} task={task} announcement={announcement} done={!!pass?.tasks?.[task]} live={live} onDone={() => declare(task)} />
              ))}
            </ul>
            <p className="boarding-fine">{t("home.boarding.tasksFine")}</p>
          </div>
        </div>

        {discord && live && <DiscordStep pass={pass} ensurePass={ensurePass} onPass={set} onError={(e) => fail(e)} />}

        {verified && live && <Invite pass={pass!} />}

        <p className="boarding-error" aria-live="polite">
          {error}
        </p>

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
      </div>
    </section>
  );
}

/**
 * The pass's referral link: each friend who boards from it, takes a seat and links a wallet adds
 * REFERRAL_BONUS points, up to REFERRAL_CAP friends. The link goes out as is, in a post on X, or
 * printed on a picture of the pass.
 */
function Invite({ pass }: { pass: XPassView }) {
  const t = useT();
  const locale = useLocale();
  const [copied, setCopied] = useState(false);
  const [card, setCard] = useState<{ file: File; src: string } | null>(null);
  const [drawing, setDrawing] = useState(false);
  const link = referralUrl(SITE_URL, applyPath(locale), pass.code);
  const { counted, pending } = pass.referrals;
  const capped = counted >= REFERRAL_CAP;

  useEffect(() => {
    if (!card) return;
    return () => URL.revokeObjectURL(card.src);
  }, [card]);

  const draw = async () => {
    setDrawing(true);
    try {
      const { drawBoardingCard } = await import("../share/boardingCard");
      const blob = await drawBoardingCard({
        title: t("home.boarding.card.title"),
        passenger: t("home.boarding.card.passenger"),
        from: t("home.boarding.card.from"),
        to: t("home.boarding.card.to"),
        gate: t("home.boarding.card.gate"),
        handle: `@${pass.handle}`,
        fromValue: "SEPOLIA",
        toValue: "MAINNET",
        gateValue: "X",
        code: pass.code,
        stamp: t(pass.seated ? "home.boarding.card.seated" : "home.boarding.card.boarding"),
        invite: t("home.boarding.card.invite"),
        where: link.replace(/^https?:\/\//, ""),
      });
      setCard({ file: new File([blob], `${pass.code}.png`, { type: "image/png" }), src: URL.createObjectURL(blob) });
    } finally {
      setDrawing(false);
    }
  };

  const share = async () => {
    if (!card) return;
    try {
      await navigator.share({ files: [card.file], text: `${t("home.boarding.invite.post")}\n${link}` });
    } catch {
      // Closed without sharing.
    }
  };

  return (
    <div className="boarding-invite">
      <span className="boarding-bonus-tag">{t("home.boarding.invite.tag", { bonus: REFERRAL_BONUS })}</span>
      <strong>{t("home.boarding.invite.title", { bonus: REFERRAL_BONUS })}</strong>
      <span>{t("home.boarding.invite.body", { cap: REFERRAL_CAP, max: REFERRAL_CAP * REFERRAL_BONUS })}</span>
      <span className="boarding-task-actions">
        <button type="button" className="boarding-code boarding-command" onClick={() => void copy(link).then(setCopied)} title={t("home.boarding.discord.copy")}>
          {link}
          <span className="boarding-command-hint">{copied ? t("home.boarding.discord.copied") : t("home.boarding.discord.copy")}</span>
        </button>
      </span>
      <span className="boarding-invite-count">
        {t("home.boarding.invite.counted", { count: counted })}
        {pending > 0 && ` · ${t("home.boarding.invite.pending", { count: pending })}`}
        {capped && ` · ${t("home.boarding.invite.capped")}`}
      </span>
      <span className="boarding-task-actions">
        <a className="btn btn-small btn-x" href={intentUrl("x", t("home.boarding.invite.post"), link)} target="_blank" rel="noreferrer">
          <XLogo />
          {t("home.boarding.invite.onX")}&nbsp;↗
        </a>
        {!card && (
          <button type="button" className="btn btn-small btn-paper" onClick={() => void draw()} disabled={drawing} aria-busy={drawing}>
            {drawing ? t("home.boarding.invite.drawing") : t("home.boarding.invite.card")}
          </button>
        )}
      </span>
      {card && (
        <figure className="boarding-invite-card">
          <img src={card.src} alt={t("home.boarding.invite.cardAlt", { handle: pass.handle ?? "" })} width={1200} height={675} />
          <span className="boarding-task-actions">
            <button type="button" className="btn btn-small btn-paper" onClick={() => download(card.file)}>
              {t("home.boarding.invite.download")}
            </button>
            {canShareFiles(card.file) && (
              <button type="button" className="btn btn-small" onClick={() => void share()}>
                {t("home.boarding.invite.share")}
              </button>
            )}
          </span>
        </figure>
      )}
    </div>
  );
}

/** How often the page asks whether `/board` went through, while a code is up. */
const BOARD_POLL_MS = 4_000;

/**
 * The Discord server: join it, ask for a one-time code, run `/board <code>` there. Discord says who
 * ran it, so this one is proved, not declared. The page asks the API until the pass shows it.
 */
function DiscordStep({ pass, ensurePass, onPass, onError }: { pass: XPassView | null; ensurePass: () => Promise<XPassView>; onPass: (p: XPassView) => void; onError: (e: unknown) => void }) {
  const t = useT();
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const joined = !!pass?.discord;
  const command = code ? `/board code:${code.code}` : "";

  // While a code is up and the pass does not show Discord yet, ask again now and then.
  useEffect(() => {
    if (!code || joined) return;
    const timer = setInterval(() => {
      if (Date.now() / 1000 >= code.expiresAt) {
        setCode(null);
        return;
      }
      xPassStatus().then(onPass, () => undefined);
    }, BOARD_POLL_MS);
    return () => clearInterval(timer);
  }, [code, joined, onPass]);

  const ask = async () => {
    setBusy(true);
    try {
      await ensurePass();
      setCode(await discordBoardCode());
      setCopied(false);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    void navigator.clipboard?.writeText(command).then(() => setCopied(true), () => undefined);
  };

  return (
    <div className={`boarding-discord${joined ? " is-done" : ""}`}>
      <span className="boarding-bonus-tag">{t("home.boarding.discord.tag", { bonus: DISCORD_BONUS })}</span>
      <strong>{joined ? t("home.boarding.discord.done", { bonus: DISCORD_BONUS }) : t("home.boarding.discord.title", { bonus: DISCORD_BONUS })}</strong>
      <span>{joined ? t("home.boarding.discord.doneBody") : t("home.boarding.discord.body")}</span>
      {!joined && (
        <span className="boarding-task-actions">
          <a className="btn btn-small btn-discord" href={DISCORD} target="_blank" rel="noreferrer">
            {t("home.boarding.discord.join")}&nbsp;↗
          </a>
          {code ? (
            <button type="button" className="boarding-code boarding-command" onClick={copy} title={t("home.boarding.discord.copy")}>
              {command}
              <span className="boarding-command-hint">{copied ? t("home.boarding.discord.copied") : t("home.boarding.discord.copy")}</span>
            </button>
          ) : (
            <button type="button" className="btn btn-small btn-paper" onClick={() => void ask()} disabled={busy} aria-busy={busy}>
              {busy ? t("home.boarding.gettingCode") : t("home.boarding.discord.code")}
            </button>
          )}
        </span>
      )}
      {code && !joined && <span className="boarding-fine">{t("home.boarding.discord.waiting")}</span>}
    </div>
  );
}

/**
 * One task on X: open it, do it, and after a few seconds mark it done. Like, reply and repost
 * wait for the announcement post.
 */
function Task({ task, done, live, onDone, href: given, announcement }: { task: XTask; done: boolean; live: boolean; onDone: () => Promise<void>; href?: string; announcement: string | null }) {
  const t = useT();
  const [left, setLeft] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const post = announcement ? announcementLinks(announcement) : null;
  const href = given ?? (task === "follow" ? X_FOLLOW : task === "post" ? undefined : post?.[task]);

  useEffect(() => {
    if (left === null || left <= 0) return;
    const timer = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);

  const mark = async () => {
    setSaving(true);
    await onDone();
    setSaving(false);
  };

  return (
    <li className={`boarding-task${done ? " is-done" : ""}`}>
      <strong>
        {done && <span aria-hidden="true">✓ </span>}
        {t(`home.boarding.task.${task}`, { handle: X_HANDLE })}
      </strong>
      <span className="boarding-task-why">{t(`home.boarding.task.${task}.why`)}</span>
      <span className="boarding-task-actions">
        {href ? (
          <a className="btn btn-small btn-x" href={href} target="_blank" rel="noreferrer" onClick={() => !done && setLeft((l) => l ?? WAIT)}>
            <XLogo />
            {t(`home.boarding.task.${task}.cta`)}
          </a>
        ) : (
          <span className="btn btn-small btn-paper is-soon" aria-disabled="true">
            {t("home.pass.soon")}
          </span>
        )}
        {post && task !== "follow" && task !== "post" && (
          <a className="boarding-task-open" href={post.post} target="_blank" rel="noreferrer">
            {t("home.boarding.task.open")}
          </a>
        )}
        {live && !done && left !== null && (
          <button type="button" className="boarding-task-mark" onClick={() => void mark()} disabled={left > 0 || saving}>
            {left > 0 ? t("home.boarding.task.wait", { n: left }) : t("home.boarding.task.mark")}
          </button>
        )}
      </span>
    </li>
  );
}

function XLogo() {
  return (
    <svg className="x-logo" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-6.3L6.4 22H3.3l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z" />
    </svg>
  );
}
