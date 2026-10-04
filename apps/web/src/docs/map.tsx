import { spec, studio } from "@dno/game-spec";
import { useLocale } from "../i18n/locale";
import { C } from "./croq";
import { RAMP_PCT } from "./fees";
import { useT } from "./i18n";

/** What a counter keeps to itself: everything, nothing, or something in between. */
type Seal = "sealed" | "border" | "public";

const SEAL_COLOR: Record<Seal, string> = { sealed: C.spectral, border: C.tape, public: C.sodium };

/** The depot's counters, each with the chapter that tells it in full. */
const COUNTERS = [
  { key: "boxes", href: "#seed", seal: "sealed", fill: C.kraft },
  { key: "croquettes", href: "#croquettes", seal: "sealed", fill: C.tape },
  { key: "bureau", href: "#exchange", seal: "border", fill: C.paper },
  { key: "studio", href: "#studio", seal: "public", fill: C.sodium },
  { key: "rats", href: "#rats", seal: "public", fill: C.spectral },
] as const satisfies readonly { key: string; href: string; seal: Seal; fill: string }[];

/** The whole game on one page: five counters, what each is for, what it costs, what it keeps secret. */
export function MapFigure() {
  const t = useT();
  const locale = useLocale();
  const vars = {
    supply: spec.collection.maxSupply.toLocaleString(locale),
    starter: studio.packs[0]!.priceUsdc,
    litter: studio.packs[1]!.priceUsdc,
    seed: studio.rats.mint.seedPriceUsdc,
    model: studio.rats.mint.modelPriceUsdc,
    perDay: studio.rats.croquettes.perDay,
    pct: RAMP_PCT,
  };
  return (
    <figure className="diagram">
      {/* Cards, not list items: the chatbot's export skips them, so a question lands on the
          chapter that tells it in full rather than on this summary. */}
      <div className="map">
        {COUNTERS.map((c, i) => (
          <article key={c.key} className="map-card">
            <p className="map-no">{String(i + 1).padStart(2, "0")}</p>
            <h3 style={{ background: c.fill }}>{t(`fig.map.${c.key}`)}</h3>
            <p>{t(`fig.map.${c.key}.v`, vars)}</p>
            <div className="map-meta">
              <p>
                <b>{t("fig.map.cost")}</b>
                <span>{t(`fig.map.${c.key}.cost`, vars)}</span>
              </p>
              <p>
                <b>{t("fig.map.seal")}</b>
                <span>
                  <span className="map-seal" style={{ borderColor: SEAL_COLOR[c.seal], color: SEAL_COLOR[c.seal] }}>
                    {t(`fig.map.seal.${c.seal}`)}
                  </span>{" "}
                  {t(`fig.map.${c.key}.seal`)}
                </span>
              </p>
            </div>
            <a href={c.href}>{t("fig.map.read")}</a>
          </article>
        ))}
      </div>
      <figcaption>{t("fig.map.caption")}</figcaption>
    </figure>
  );
}
