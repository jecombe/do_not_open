import "./parade.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "../i18n/locale";
import { stateName, variantName } from "../i18n/names";
import { CAT_SETS, oneIn, roster, type CatSet, type RosterCat } from "./cats";
import { useT } from "./i18n";
import { ParadeScene } from "./three/parade";

/**
 * The cats on a turntable, with a card for the one in front: its name, how often it
 * turns up, and a line about its character. Used by the manual and the home page.
 */
export function CatParade() {
  const t = useT();
  const locale = useLocale();
  const cats = useMemo(() => roster(), []);
  const [set, setSet] = useState<CatSet>("breeds");
  const [index, setIndex] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<ParadeScene | null>(null);
  const list = cats[set];
  const current = list[index] ?? list[0]!;

  useEffect(() => {
    if (!host.current) return;
    let made: ParadeScene;
    try {
      made = new ParadeScene(host.current);
    } catch {
      // No WebGL: the card and the buttons still tell the whole story.
      host.current.classList.add("no-webgl");
      return;
    }
    made.onSelect = setIndex;
    scene.current = made;
    return () => {
      made.dispose();
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    scene.current?.setCats(list.map((c) => c.cat), 0);
  }, [list]);

  useEffect(() => {
    scene.current?.select(index);
  }, [index]);

  const step = (by: number) => setIndex((i) => (i + by + list.length) % list.length);

  return (
    <div className="parade">
      <div className="parade-tabs" role="tablist" aria-label={t("docs.cats.tabs")}>
        {CAT_SETS.map((s) => (
          <button type="button" role="tab" key={s} aria-selected={s === set} onClick={() => {
              setSet(s);
              setIndex(0);
            }}>
            {t(`docs.cats.tab.${s}`)}
          </button>
        ))}
      </div>
      <div className="parade-body">
        <div ref={host} className="stage parade-stage" title={t("docs.cats.hint")} />
        <div className="parade-card" aria-live="polite">
          <p className="parade-count">
            {index + 1} / {list.length}
          </p>
          <h3>{nameOf(set, current, t)}</h3>
          <p className="parade-odds">
            {current.odds === null
              ? t("docs.cats.oddsPlay")
              : current.odds >= 0.25
                ? t("docs.cats.oddsTen", { n: Math.round(current.odds * 10) })
                : t("docs.cats.odds", { n: oneIn(current.odds).toLocaleString(locale) })}
          </p>
          <p className="parade-blurb">{t(`docs.cats.${set}.${current.key}` as "docs.cats.breeds.tabby")}</p>
          <div className="parade-nav">
            <button type="button" onClick={() => step(-1)} aria-label={t("docs.cats.prev")}>
              ‹
            </button>
            <button type="button" onClick={() => step(1)} aria-label={t("docs.cats.next")}>
              ›
            </button>
          </div>
        </div>
      </div>
      <div className="parade-picker" role="group" aria-label={t("docs.cats.picker")}>
        {list.map((c, i) => (
          <button type="button" key={c.key} aria-pressed={i === index} onClick={() => setIndex(i)}>
            {nameOf(set, c, t)}
          </button>
        ))}
      </div>
    </div>
  );
}

function nameOf(set: CatSet, c: RosterCat, t: ReturnType<typeof useT>): string {
  if (set === "breeds") return variantName("breed", c.key);
  if (set === "states") return stateName(c.cat.state);
  if (set === "vices") return t(`docs.cats.vices.${c.key}.name` as "docs.cats.vices.stoned.name");
  return t(`docs.cats.extras.${c.key}.name` as "docs.cats.extras.golden.name");
}
