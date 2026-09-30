import { useEffect, useMemo, useRef, useState } from "react";
import { spec, type SeedField } from "@dno/game-spec";
import { buildCatSpec, decodeSeed, FIXTURE_SEEDS, resolveTrait, seedToHex, stateFromRoll } from "@dno/generator";
import { FLOWS, PACKET_NAMES, type PacketKind, type StationId } from "./flows";
import { ARCH_NODES, ArchScene } from "./three/arch";
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
  const { host } = useScene((el) => new HeroScene(el, 42));
  return <div ref={host} className="stage hero-stage" title="Click the box to shake it" />;
}

// ------------------------------------------------------------------ seed

const FIELD_NAMES: Record<SeedField, string> = {
  stateRoll: "State roll",
  breed: "Breed",
  mood: "Mood",
  accessory: "Accessory",
  brokenThing: "Thing it broke",
  room: "Room",
  cosmetic: "Cosmetic",
};

const percent = (n: number, of: number) => `${((n / of) * 100).toFixed(n / of < 0.1 ? 1 : 0)}%`;

function randomSeed(): bigint {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return (BigInt(words[0]!) << 32n) | BigInt(words[1]!);
}

function FieldDetail({ field, seed, sealed }: { field: SeedField; seed: bigint; sealed: boolean }) {
  const slice = spec.seed.layout.find((l) => l.field === field)!;
  const range = `Bits ${slice.offset} to ${slice.offset + slice.bits - 1}.`;
  const decoded = decodeSeed(seed);

  if (field === "stateRoll") {
    const bounds = spec.states.map((s, i) => ({ s, share: s.rollBelow - (spec.states[i - 1]?.rollBelow ?? 0) }));
    return (
      <p>
        {range} Sixteen bits decide the state: {bounds.map(({ s, share }, i) => `${i ? ", " : ""}${s.name.toLowerCase()} ${percent(share, 65536)}`)}.{" "}
        {sealed ? (
          <>
            The alive check compares them with {spec.states[0]!.rollBelow.toLocaleString("en")} under encryption and publishes the one-bit answer. A shake can never return these bits.
          </>
        ) : (
          <>
            This one rolled {decoded.stateRoll.toLocaleString("en")}: <strong>{stateFromRoll(decoded.stateRoll).name.toLowerCase()}</strong>.
          </>
        )}
      </p>
    );
  }
  if (field === "cosmetic") {
    return (
      <p>
        {range} Looks only: small variations such as odd eyes. It never counts towards rarity, so there is nothing in it worth knowing early.
        {!sealed && ` This one is ${decoded.cosmetic}.`}
      </p>
    );
  }
  const def = spec.traits.find((t) => t.key === field)!;
  const trait = resolveTrait(field, decoded.rolls[field]);
  const variant = def.variants.find((v) => v.key === trait.variant);
  return (
    <p>
      {range} One byte, {def.variants.length} variants, rarer ones higher up. Counts {def.weight === 1 ? "once" : `${def.weight} times`} in the rarity score.{" "}
      {sealed ? (
        <>A shake may hand this byte to whoever shook, and only to them.</>
      ) : (
        <>
          This one rolled {trait.roll}: <strong>{trait.name}</strong>
          {variant ? `, which ${variant.width} rolls in 256 give` : ""}.
        </>
      )}
    </p>
  );
}

export function SeedFigure() {
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
  const hex = seedToHex(seed).slice(2);

  return (
    <figure className="figure">
      <div ref={host} className="stage short" />
      <figcaption className="slip">
        <div className="slip-head">
          <span>{sealed ? "A sealed seed" : "The same seed, opened"}</span>
          <button type="button" className="plain-button small" onClick={() => setSealed((s) => !s)}>
            {sealed ? "Open it" : "Seal it again"}
          </button>
        </div>
        <p className="hex" aria-label={sealed ? "Encrypted" : `Seed ${seedToHex(seed)}`}>
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
        <div className="picker" role="group" aria-label="Fields of the seed">
          {SEED_FIELDS.map((f) => (
            <button type="button" key={f.field} aria-pressed={picked === f.field} onClick={() => setPicked(f.field)} onMouseEnter={() => setHovered(f.field)} onMouseLeave={() => setHovered(null)}>
              <i style={{ background: FIELD_COLORS[f.field] }} />
              {FIELD_NAMES[f.field]}
            </button>
          ))}
        </div>
        <div className="detail" aria-live="polite">
          <FieldDetail field={focus} seed={seed} sealed={sealed} />
        </div>
        <p className="fine">
          {sealed ? (
            "On-chain it stays like this: a ciphertext that reads as noise. The contract computes on it without decrypting it."
          ) : (
            <>
              Decoded: a {cat.state} {cat.traits.breed.name.toLowerCase()}, {cat.traits.mood.name.toLowerCase()}, score {cat.rarity.score} ({cat.rarity.tierName.toLowerCase()}).
            </>
          )}
        </p>
        <button
          type="button"
          className="plain-button"
          onClick={() => {
            setSeed(randomSeed());
            setSealed(false);
          }}
        >
          Draw another seed
        </button>
      </figcaption>
    </figure>
  );
}

// ------------------------------------------------------------------ flows

/** Seconds a step stays up before the next one plays. */
const STEP_SECONDS = 4.2;

export function FlowFigure() {
  const [flowIndex, setFlowIndex] = useState(2);
  const [stepIndex, setStepIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const { host, scene, ready } = useScene((el) => new FlowScene(el));
  const flow = FLOWS[flowIndex]!;
  const step = flow.steps[stepIndex]!;

  useEffect(() => {
    const parties = new Set<StationId>(["contract"]);
    for (const s of flow.steps) parties.add(s.from).add(s.to);
    scene.current?.setParties([...parties]);
  }, [scene, ready, flow]);
  useEffect(() => scene.current?.setStep(step), [scene, ready, step]);

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
        <div className="picker tabs" role="group" aria-label="Which flow">
          {FLOWS.map((f, i) => (
            <button type="button" key={f.key} aria-pressed={i === flowIndex} onClick={() => choose(i)}>
              {f.name}
            </button>
          ))}
        </div>
        <p className="lead">{flow.summary}</p>
        <ol className="steps">
          {flow.steps.map((s, i) => (
            <li key={s.title} className={i === stepIndex ? "is-current" : i < stepIndex ? "is-done" : ""}>
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
            {playing ? "Pause" : atEnd ? "Play again" : "Play"}
          </button>
          <button type="button" className="plain-button" disabled={atEnd} onClick={() => (setStepIndex(stepIndex + 1), setPlaying(false))}>
            Next step
          </button>
        </div>
        <ul className="legend" aria-label="What the parcels are">
          {kinds.map((k: PacketKind) => (
            <li key={k} data-kind={k}>
              {PACKET_NAMES[k]}
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

// ---------------------------------------------------------- architecture

export function ArchFigure() {
  const [picked, setPicked] = useState("adapter");
  const [hovered, setHovered] = useState<string | null>(null);
  const { host, scene, ready } = useScene((el) => new ArchScene(el));
  const focus = hovered ?? picked;
  const node = ARCH_NODES.find((n) => n.id === focus)!;

  useEffect(() => {
    const s = scene.current;
    if (!s) return;
    s.onHover = setHovered;
    s.onSelect = setPicked;
  }, [scene, ready]);
  useEffect(() => scene.current?.setActive(focus), [scene, ready, focus]);

  return (
    <figure className="figure">
      <div ref={host} className="stage" />
      <figcaption className="slip">
        {(["portable", "chain"] as const).map((shelf) => (
          <div key={shelf}>
            <div className="slip-head">
              <span>{shelf === "portable" ? "Top shelf: runs on any chain" : "Bottom shelf: one chain each"}</span>
            </div>
            <div className="picker" role="group">
              {ARCH_NODES.filter((n) => n.shelf === shelf).map((n) => (
                <button type="button" key={n.id} aria-pressed={picked === n.id} onClick={() => setPicked(n.id)} onMouseEnter={() => setHovered(n.id)} onMouseLeave={() => setHovered(null)}>
                  {n.name}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="detail" aria-live="polite">
          <p>
            <strong>{node.name}.</strong> {node.text}
          </p>
        </div>
        <p className="fine">A thread means "depends on". Pick a crate to see what it needs and what needs it.</p>
      </figcaption>
    </figure>
  );
}
