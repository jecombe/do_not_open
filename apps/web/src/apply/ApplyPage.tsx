import { useEffect, useRef, useState } from "react";
import { DISCORD } from "../links";
import { useSeats, useXPass } from "../xpass";
import { Boarding } from "../home/Boarding";
import { useT } from "../home/i18n";
import { GiftTiers } from "../home/GiftTiers";
import { Passport, SeatMeter } from "../home/Passport";
import { Icon } from "../secure/Icon";
import { SecureTop } from "../secure/SecureTop";
import { ShieldScene } from "../secure/shieldScene";
import { IdeaBox } from "./IdeaBox";

/**
 * The boarding page, in the secure theme: a box behind its encryption shield at the top, then
 * Sign in with X and the tasks on X, then the mainnet list and its points.
 */
export function ApplyPage() {
  const t = useT();
  const seats = useSeats();

  useEffect(() => {
    document.title = t("apply.title");
    document.querySelector('meta[name="description"]')?.setAttribute("content", t("apply.description"));
  }, [t]);

  return (
    <div className="sec apply">
      <SecureTop here="apply" />

      <section className="sec-hero apply-hero">
        <div className="apply-text">
          <p className="sec-kicker">
            <Icon name="key" />
            {t("apply.kicker")}
          </p>
          <h1>{t("apply.h1")}</h1>
          <p className="sec-lede">{t("apply.lede")}</p>
          {seats && seats.places !== null && <SeatMeter taken={seats.taken} places={seats.places} big />}
          <ol className="apply-why">
            {(["1", "2", "3"] as const).map((n) => (
              <li key={n}>
                <strong>{t(`apply.why${n}.title`)}</strong> {t(`apply.why${n}.body`)}
              </li>
            ))}
          </ol>
          <p className="sec-ctas">
            <a className="sec-btn" href="#boarding">
              {t("apply.start")}&nbsp;↓
            </a>
          </p>
        </div>
        <Gate />
      </section>

      <section className="sec-section apply-boarding">
        <Boarding />
      </section>

      <GiftTiers />

      <Passport />

      <IdeaBox />

      <footer className="sec-foot">
        <span>{t("home.foot")}</span>
        <a className="sec-link" href={DISCORD} target="_blank" rel="noreferrer">
          {t("home.foot.discord")}
        </a>
      </footer>
    </div>
  );
}

/** The gate: a box behind the shield. Probes cannot read the passenger; once boarded, the player sees their own handle. */
function Gate() {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<ShieldScene | null>(null);
  const [webgl, setWebgl] = useState(true);
  const { pass } = useXPass();
  const handle = pass?.handle ?? null;
  const labels = useRef({ holder: t("apply.gate.holder"), denied: t("apply.gate.denied") });

  useEffect(() => {
    if (!host.current) return;
    try {
      scene.current = new ShieldScene(host.current, labels.current);
    } catch {
      setWebgl(false);
    }
    return () => {
      scene.current?.dispose();
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    scene.current?.reveal(handle ? `@${handle}` : null);
  }, [handle, webgl]);

  return (
    <figure className="sec-shield">
      {webgl && (
        <div
          ref={host}
          className="stage sec-shield-stage"
          role="button"
          tabIndex={0}
          aria-label={t("apply.gate.aria")}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              scene.current?.probe();
            }
          }}
        />
      )}
      <figcaption>
        <span>{handle ? t("apply.gate.welcome", { handle }) : t("apply.gate.hint")}</span>
      </figcaption>
    </figure>
  );
}
