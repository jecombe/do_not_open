import { useEffect, useRef, useState } from "react";
import { DISCORD, REPO } from "../links";
import { useSeats, useXPass } from "../xpass";
import { Boarding } from "../home/Boarding";
import { HomeTop } from "../home/HomeTop";
import { useT } from "../home/i18n";
import { Passport, SeatMeter } from "../home/Passport";
import { GateScene } from "./gateScene";
import { IdeaBox } from "./IdeaBox";

/**
 * The boarding page: a gate in 3D (boxes on the baggage belt, a cat at the desk, a rat on the
 * tarmac), then Sign in with X and the tasks on X, then the mainnet list and its points.
 */
export function ApplyPage() {
  const t = useT();
  const seats = useSeats();

  useEffect(() => {
    document.title = t("apply.title");
    document.querySelector('meta[name="description"]')?.setAttribute("content", t("apply.description"));
  }, [t]);

  return (
    <div className="home apply">
      <HomeTop here="apply" />

      <section className="apply-hero">
        <div className="apply-text">
          <p className="kicker">{t("apply.kicker")}</p>
          <h1>{t("apply.h1")}</h1>
          <p className="hero-lede">{t("apply.lede")}</p>
          {seats && seats.places !== null && <SeatMeter taken={seats.taken} places={seats.places} big />}
          <ol className="apply-why">
            <li>
              <strong>{t("apply.why1.title")}</strong> {t("apply.why1.body")}
            </li>
            <li>
              <strong>{t("apply.why2.title")}</strong> {t("apply.why2.body")}
            </li>
            <li>
              <strong>{t("apply.why3.title")}</strong> {t("apply.why3.body")}
            </li>
          </ol>
          <p className="hero-ctas">
            <a className="btn" href="#boarding">
              {t("apply.start")}&nbsp;↓
            </a>
          </p>
        </div>
        <Gate />
      </section>

      <Boarding />

      <Passport />

      <IdeaBox />

      <footer className="home-foot">
        <span>{t("home.foot")}</span>
        <a href={DISCORD} target="_blank" rel="noreferrer">
          {t("home.foot.discord")}
        </a>
        <a href={REPO}>{t("home.foot.source")}</a>
      </footer>
    </div>
  );
}

/** How long each of the cat's lines stays up, in milliseconds. */
const LINE_MS = 3_600;

/** The gate in 3D. The cat talks the player through boarding, and cheers once they are on. */
function Gate() {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<GateScene | null>(null);
  const [webgl, setWebgl] = useState(true);
  const { pass } = useXPass();
  const handle = pass?.handle ?? null;

  useEffect(() => {
    if (!host.current) return;
    let made: GateScene;
    try {
      made = new GateScene(host.current);
    } catch {
      setWebgl(false);
      return;
    }
    scene.current = made;
    return () => {
      made.dispose();
      scene.current = null;
    };
  }, []);

  // Until the player boards, the cat runs through its lines; then it welcomes them by name.
  useEffect(() => {
    const s = scene.current;
    if (!s) return;
    if (handle) {
      s.say(t("apply.gate.welcome", { handle }));
      s.cheer();
      return;
    }
    const lines = [t("apply.gate.say1"), t("apply.gate.say2"), t("apply.gate.say3"), t("apply.gate.say4")];
    let i = 0;
    s.say(lines[0]!);
    const timer = setInterval(() => scene.current?.say(lines[++i % lines.length]!), LINE_MS);
    return () => clearInterval(timer);
  }, [handle, t, webgl]);

  if (!webgl) return null;
  return (
    <figure className="apply-gate">
      <div
        ref={host}
        className="stage apply-stage"
        role="button"
        tabIndex={0}
        aria-label={t("apply.gate.aria")}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            scene.current?.pokeCat();
          }
        }}
      />
      <figcaption>{t("apply.gate.hint")}</figcaption>
    </figure>
  );
}
