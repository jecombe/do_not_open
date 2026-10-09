import { useEffect, useMemo, useRef, useState } from "react";
import { spec, type SeedField } from "@dno/game-spec";
import { buildCatSpec, decodeSeed, FIXTURE_SEEDS, resolveTrait, seedToHex, stateFromRoll } from "@dno/generator";
import { useLocale } from "../i18n/locale";
import { catNames, stateName, variantName } from "../i18n/names";
import { flows, GAME_FLOWS, packetName, type FlowKey, type PacketKind, type StationId } from "./flows";
import { useT } from "./i18n";
import { FlowScene } from "./three/flow";
import { HeroScene } from "./three/hero";
import { FIELD_COLORS, SEED_FIELDS, SeedScene } from "./three/seed";

/** Builds a three.js scene into a div once, and tears it down with the component. */
function useScene<T extends { dispose(): void }>(make: (host: HTMLElement) => T) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<T | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    let made: T;
    try {
      made = make(host.current);
    } catch {
      // No WebGL: the text next to each figure says everything the figure shows.
      host.current.classList.add("no-webgl");
      return;
    }
    scene.current = made;
    setReady(true);
    return () => {
      made.dispose();
      scene.current = null;
      setReady(false);
    };
    // The factory is fixed for the life of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { host, scene, ready };
}

export function HeroFigure() {
  const t = useT();
  const { host } = useScene((el) => new HeroScene(el, 42));
  return <div ref={host} className="stage hero-stage" title={t("docs.hero.figure")} />;
}

// ------------------------------------------------------------------ seed

const percent = (n: number, of: number) => `${((n / of) * 100).toFixed(n / of < 0.1 ? 1 : 0)}%`;

function randomSeed(): bigint {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return (BigInt(words[0]!) << 32n) | BigInt(words[1]!);
}

function FieldDetail({ field, seed, sealed }: { field: SeedField; seed: bigint; sealed: boolean }) {
  const t = useT();
  const slice = spec.seed.layout.find((l) => l.field === field)!;
  const range = t("fig.bits", { from: slice.offset, to: slice.offset + slice.bits - 1 });
  const decoded = decodeSeed(seed);

  if (field === "stateRoll") {
    const bounds = spec.states.map((s, i) => ({ s, share: s.rollBelow - (spec.states[i - 1]?.rollBelow ?? 0) }));
    const list = bounds.map(({ s, share }) => `${stateName(s.key).toLowerCase()} ${percent(share, 65536)}`).join(", ");
    return (
      <p>
        {range} {t("fig.state.intro", { list })}{" "}
        {sealed ? (
          t("fig.state.sealed", { n: spec.states[0]!.rollBelow })
        ) : (
          <>
            {t("fig.rolled", { n: decoded.stateRoll })}
            <strong>{stateName(stateFromRoll(decoded.stateRoll).key).toLowerCase()}</strong>.
          </>
        )}
      </p>
    );
  }
  if (field === "cosmetic") {
    return (
      <p>
        {range} {t("fig.cosmetic")}
        {!sealed && t("fig.cosmetic.this", { n: decoded.cosmetic })}
      </p>
    );
  }
  const def = spec.traits.find((d) => d.key === field)!;
  const trait = resolveTrait(field, decoded.rolls[field]);
  const variant = def.variants.find((v) => v.key === trait.variant);
  return (
    <p>
      {range} {t("fig.trait", { n: def.variants.length, times: def.weight === 1 ? t("fig.once") : t("fig.times", { n: def.weight }) })}{" "}
      {sealed ? (
        t("fig.trait.sealed")
      ) : (
        <>
          {t("fig.rolled", { n: trait.roll })}
          <strong>{variantName(field, trait.variant)}</strong>
          {variant ? t("fig.trait.width", { n: variant.width }) : ""}.
        </>
      )}
    </p>
  );
}

export function SeedFigure() {
  const t = useT();
  const [seed, setSeed] = useState(FIXTURE_SEEDS[2]!.seed);
  const [sealed, setSealed] = useState(true);
  const [picked, setPicked] = useState<SeedField>("stateRoll");
  const [hovered, setHovered] = useState<SeedField | null>(null);
  const { host, scene, ready } = useScene((el) => new SeedScene(el));
  const focus = hovered ?? picked;

  useEffect(() => {
    const s = scene.current;
    if (!s) return;
    s.onHover = setHovered;
    s.onSelect = setPicked;
  }, [scene, ready]);
  useEffect(() => scene.current?.setSeed(seed), [scene, ready, seed]);
  useEffect(() => scene.current?.setSealed(sealed), [scene, ready, sealed]);
  useEffect(() => scene.current?.setActive(focus), [scene, ready, focus]);

  const cat = useMemo(() => buildCatSpec({ seed }), [seed]);
  const names = catNames(cat);
  const hex = seedToHex(seed).slice(2);

  return (
    <figure className="figure">
      <div ref={host} className="stage short" />
      <figcaption className="slip">
        <div className="slip-head">
          <span>{sealed ? t("fig.seed.sealedTitle") : t("fig.seed.openTitle")}</span>
          <button type="button" className="plain-button small" onClick={() => setSealed((s) => !s)}>
            {sealed ? t("fig.seed.open") : t("fig.seed.seal")}
          </button>
        </div>
        <p className="hex" aria-label={sealed ? t("fig.seed.encrypted") : t("fig.seed.aria", { hex: seedToHex(seed) })}>
          0x
          {SEED_FIELDS.map((f) => {
            const digits = f.bits / 4;
            const start = 16 - (f.offset + f.bits) / 4;
            return (
              <span key={f.field} style={{ borderColor: FIELD_COLORS[f.field] }} className={f.field === focus ? "is-focus" : ""}>
                {sealed ? "?".repeat(digits) : hex.slice(start, start + digits)}
              </span>
            );
          })}
        </p>
        <div className="picker" role="group" aria-label={t("fig.seed.fields")}>
          {SEED_FIELDS.map((f) => (
            <button type="button" key={f.field} aria-pressed={picked === f.field} onClick={() => setPicked(f.field)} onMouseEnter={() => setHovered(f.field)} onMouseLeave={() => setHovered(null)}>
              <i style={{ background: FIELD_COLORS[f.field] }} />
              {t(`fig.field.${f.field}`)}
            </button>
          ))}
        </div>
        <div className="detail" aria-live="polite">
          <FieldDetail field={focus} seed={seed} sealed={sealed} />
        </div>
        <p className="fine">
          {sealed
            ? t("fig.seed.noise")
            : t("fig.seed.decoded", { state: names.state.toLowerCase(), breed: names.breed.toLowerCase(), mood: names.mood.toLowerCase(), score: cat.rarity.score, tier: names.tier.toLowerCase() })}
        </p>
        <button
          type="button"
          className="plain-button"
          onClick={() => {
            setSeed(randomSeed());
            setSealed(false);
          }}
        >
          {t("fig.seed.draw")}
        </button>
      </figcaption>
    </figure>
  );
}

// ------------------------------------------------------------------ flows

/** Seconds a step stays up before the next one plays. */
const STEP_SECONDS = 4.2;

export function FlowFigure({ keys = GAME_FLOWS }: { keys?: readonly FlowKey[] }) {
  const t = useT();
  const locale = useLocale();
  // The words change with the language: `locale` is there for that.
  const FLOWS = useMemo(() => flows(keys), [locale, keys]);
  const [flowIndex, setFlowIndex] = useState(Math.max(0, keys.indexOf("open")));
  const [stepIndex, setStepIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const { host, scene, ready } = useScene((el) => new FlowScene(el));
  const flow = FLOWS[flowIndex]!;
  const step = flow.steps[stepIndex]!;

  useEffect(() => {
    const parties = new Set<StationId>(["contract"]);
    for (const s of flow.steps) parties.add(s.from).add(s.to);
    scene.current?.setParties([...parties], flow.cast);
  }, [scene, ready, flow]);
  useEffect(() => scene.current?.setStep(step), [scene, ready, step]);
  useEffect(() => scene.current?.relabel(), [scene, ready, locale]);

  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => {
      if (stepIndex + 1 < flow.steps.length) setStepIndex(stepIndex + 1);
      else setPlaying(false);
    }, STEP_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [playing, stepIndex, flow]);

  const choose = (index: number) => {
    setFlowIndex(index);
    setStepIndex(0);
    setPlaying(true);
  };
  const kinds = [...new Set(flow.steps.map((s) => s.kind))];
  const atEnd = stepIndex === flow.steps.length - 1;

  return (
    <figure className="figure">
      <div ref={host} className="stage tall" />
      <figcaption className="slip">
        {FLOWS.length > 1 && <div className="picker tabs" role="group" aria-label={t("fig.flow.which")}>
          {FLOWS.map((f, i) => (
            <button type="button" key={f.key} aria-pressed={i === flowIndex} onClick={() => choose(i)}>
              {f.name}
            </button>
          ))}
        </div>}
        <p className="lead">{flow.summary}</p>
        <ol className="steps">
          {flow.steps.map((s, i) => (
            <li key={i} className={i === stepIndex ? "is-current" : i < stepIndex ? "is-done" : ""}>
              <button
                type="button"
                aria-current={i === stepIndex ? "step" : undefined}
                onClick={() => {
                  setStepIndex(i);
                  setPlaying(false);
                }}
              >
                <strong>{s.title}</strong>
                {i === stepIndex && <span>{s.text}</span>}
              </button>
            </li>
          ))}
        </ol>
        <div className="controls">
          <button
            type="button"
            className="plain-button"
            onClick={() => {
              if (atEnd && !playing) setStepIndex(0);
              setPlaying((p) => !p);
            }}
          >
            {playing ? t("fig.flow.pause") : atEnd ? t("fig.flow.playAgain") : t("fig.flow.play")}
          </button>
          <button type="button" className="plain-button" disabled={atEnd} onClick={() => (setStepIndex(stepIndex + 1), setPlaying(false))}>
            {t("fig.flow.next")}
          </button>
        </div>
        <ul className="legend" aria-label={t("fig.flow.legend")}>
          {kinds.map((k: PacketKind) => (
            <li key={k} data-kind={k}>
              {packetName(k)}
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

