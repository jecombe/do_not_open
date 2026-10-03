import { CameraControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useImperativeHandle, useMemo, useRef, type Ref } from "react";
import { Group, Vector3 } from "three";
import { buildBoxSpec, type CatSpec } from "@dno/generator";
import {
  BENCH_HEIGHT,
  BOX_SIZE,
  BoxAnticipation,
  BoxOpener,
  BoxShaker,
  BoxTags,
  createBox,
  createCat,
  createDepot,
  createDiorama,
  DEPOT_COLORS,
  DuelArena,
  EntanglementThread,
  FeedEffect,
  KibblePile,
  PetEffect,
  SPECTRAL,
  type BoxObject,
  type BoxTagSpec,
  type CatObject,
  type QualitySettings,
  type ShakeSound,
  Unboxing,
  VetMark,
  type WaitKind,
  type WaitStage,
} from "@dno/scene";
import { boxComplaint } from "../home/sound";
import { useLeash, type Leash } from "./leash";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isNarrow = () => window.innerWidth < 700;
/** The bench and what stands on it: the view may slide about it, never off into the racks. */
const BENCH_LEASH: Leash = { min: [-1.0, 0.6, -0.8], max: [1.0, 1.9, 1.0], touch: "orbit" };
/** How far round the bench the camera may swing: the front and both ends, never behind the racks. */
const BENCH_AZIMUTH = { minAzimuthAngle: -1.15, maxAzimuthAngle: 1.3 };
/** Hangs `tags` on a box's tags whenever their wording changes, not on every render. */
function useTags(tags: BoxTags, specs: readonly BoxTagSpec[] | undefined) {
  const key = JSON.stringify(specs ?? []);
  useEffect(() => tags.set(specs ?? []), [tags, key]);
}

const glowFor = (cat: CatSpec) => (cat.state === "ghost" || cat.state === "quantum" ? SPECTRAL : cat.room.light);

function Backdrop() {
  return (
    <>
      <color attach="background" args={[DEPOT_COLORS.shadow]} />
      <fogExp2 attach="fog" args={[DEPOT_COLORS.shadow, 0.06]} />
    </>
  );
}

interface Opening {
  opener: BoxOpener;
  /** Once open, the cat jumps out and the box is gone. */
  unbox: Unboxing;
  content: CatObject;
  /** The cat `content` was built from. */
  cat: CatSpec;
  /** What the opener and the unboxing move. The cat animates inside it. */
  holder: Group;
  /** Called when the whole thing is over: the box opened, the cat out on the bench. */
  onDone: (() => void) | null;
}

/** Builds the opening sequence for one box, then the cat's jump out of it, and wires their sounds. */
function makeOpener(box: BoxObject, cat: CatSpec, sound: ShakeSound, opts: { lamp?: boolean } = {}): Opening {
  const content = createCat(cat);
  const holder = new Group();
  holder.add(content.group);
  const opener = new BoxOpener(box, { content: holder, glow: glowFor(cat), reducedMotion: reducedMotion() });
  const unbox = new Unboxing(box, holder, { reducedMotion: reducedMotion(), lamp: opts.lamp });
  const made: Opening = { opener, unbox, content, cat, holder, onDone: null };
  opener.onRip = () => sound.rip();
  opener.onBurst = () => sound.reveal(cat.state !== "ghost");
  opener.onDone = () => unbox.start();
  unbox.onCrush = () => sound.impact(0.4);
  unbox.onLand = () => {
    sound.impact(0.2);
    made.onDone?.();
  };
  return made;
}

/** A box opened some other day: just the cat, standing where the box was. */
function showOpened(o: Opening) {
  o.opener.openInstant();
  o.unbox.finishInstant();
}

function updateOpening(o: Opening, step: number, time: number) {
  o.opener.update(step);
  o.unbox.update(step);
  o.content.update(time);
}

/** Same cat, new build: the scales said something after it was already out. */
function reweigh(o: Opening, cat: CatSpec) {
  o.content.group.removeFromParent();
  o.content.dispose();
  o.content = createCat(cat);
  o.cat = cat;
  o.holder.add(o.content.group);
}

const sameWeight = (a: CatSpec, b: CatSpec) => JSON.stringify(a.weight) === JSON.stringify(b.weight);

function disposeOpening(o: Opening) {
  o.unbox.dispose();
  o.holder.removeFromParent();
  o.opener.dispose();
  o.content.dispose();
}

export type InspectAngle = "front" | "left" | "back" | "right" | "above";

export interface BoxSceneHandle {
  shake(): void;
  /** Croquettes rain on the lid and slip in under the front flap. */
  feed(): void;
  /** A hand reaches in under the back flap and strokes the cat. */
  pet(): void;
  /** Keeps the box busy while a chain action is pending; `null` lets it settle. */
  wait(stage: WaitStage | null, kind: WaitKind): void;
  /** The vet's stamp comes down on the box: green if alive, grey if not. */
  certify(alive: boolean): void;
  /** Plays the opening sequence. */
  open(cat: CatSpec): void;
  /** Takes the cat out onto the bench, or puts it back. Only once the box is open. */
  inspect(out: boolean): void;
  /** Swings the camera around the cat while it is out. */
  lookFrom(angle: InspectAngle): void;
}

interface BoxSceneProps {
  ref: Ref<BoxSceneHandle>;
  tokenId: number;
  /** Set when the box is already open: it is shown open, with no sequence. */
  opened: CatSpec | null;
  /** The vet's verdict, if the box was checked: its stamp is on the box, visible to all. */
  vet: "alive" | "notAlive" | null;
  /** Paper tags on the box: up for a duel, entangled. */
  tags?: BoxTagSpec[];
  quality: QualitySettings;
  sound: ShakeSound;
  onShakeDone: () => void;
  onFed: () => void;
  onOpened: () => void;
}

const ANGLES: Record<InspectAngle, [azimuth: number, polar: number]> = {
  front: [0, 1.22],
  left: [-Math.PI / 2, 1.22],
  back: [Math.PI, 1.22],
  right: [Math.PI / 2, 1.22],
  above: [0, 0.28],
};

/** The mail room with one box on the bench: shake it, pet it, feed it, open it, take the cat out. */
export function BoxScene({ ref, tokenId, opened, vet, tags, quality, sound, onShakeDone, onFed, onOpened }: BoxSceneProps) {
  const controls = useRef<CameraControls>(null);
  const opening = useRef<Opening | null>(null);
  const vetMark = useRef<VetMark | null>(null);
  /** Looking closely at the cat, once it is out. */
  const inspecting = useRef(false);

  const depot = useMemo(() => createDepot(quality), [quality]);
  useEffect(() => () => depot.dispose(), [depot]);

  const rig = useMemo(() => {
    const box = createBox(buildBoxSpec(tokenId));
    return {
      box,
      shaker: new BoxShaker(box, { reducedMotion: reducedMotion() }),
      feeder: new FeedEffect(box, reducedMotion()),
      petter: new PetEffect(box, reducedMotion()),
      waiter: new BoxAnticipation(box, reducedMotion()),
      tags: new BoxTags(box, { reducedMotion: reducedMotion() }),
    };
  }, [tokenId]);
  useTags(rig.tags, tags);

  useEffect(() => {
    depot.benchAnchor.add(rig.box.group);
    return () => {
      inspecting.current = false;
      if (opening.current) disposeOpening(opening.current);
      opening.current = null;
      depot.benchAnchor.remove(rig.box.group);
      vetMark.current?.dispose();
      vetMark.current = null;
      rig.feeder.dispose();
      rig.petter.dispose();
      rig.waiter.dispose();
      rig.tags.dispose();
      rig.box.dispose();
    };
  }, [depot, rig]);

  // A box certified earlier simply carries the stamp.
  useEffect(() => {
    if (!vet || vetMark.current) return;
    vetMark.current = new VetMark(rig.box, vet === "alive", { reducedMotion: reducedMotion() });
    vetMark.current.showInstant();
  }, [rig, vet]);

  // A box that was opened earlier is simply shown open.
  useEffect(() => {
    if (!opened) return;
    const o = opening.current;
    if (o) {
      if (o.unbox.done && o.cat.seed === opened.seed && !sameWeight(o.cat, opened)) reweigh(o, opened);
      return;
    }
    opening.current = makeOpener(rig.box, opened, sound, { lamp: true });
    showOpened(opening.current);
  }, [rig, opened, sound]);

  useEffect(() => {
    rig.shaker.onImpact = (strength) => sound.impact(strength);
    rig.shaker.onDone = () => {
      if (Math.random() < 0.6) boxComplaint(sound);
      onShakeDone();
    };
    rig.waiter.onRattle = (strength) => sound.impact(strength);
    rig.waiter.onMutter = () => boxComplaint(sound);
    rig.waiter.onBeat = () => sound.heartbeat();
    rig.feeder.onTick = () => sound.tick();
    rig.feeder.onEaten = () => {
      sound.purr();
      onFed();
    };
    rig.petter.onPetted = () => {
      sound.purr();
      onFed();
    };
  }, [rig, sound, onShakeDone, onFed]);

  const frame = (close: boolean, animate: boolean) => {
    const c = controls.current;
    if (!c) return;
    const n = isNarrow();
    c.minDistance = 1.8;
    c.minAzimuthAngle = BENCH_AZIMUTH.minAzimuthAngle;
    c.maxAzimuthAngle = BENCH_AZIMUTH.maxAzimuthAngle;
    // On a phone the stage keeps what the camera looks at above the slip: aim at the box itself.
    if (close) void c.setLookAt(n ? 1.4 : 1.3, n ? 5.3 : 3.5, n ? 4.6 : 3.1, n ? 0 : -0.35, 1.45, 0, animate);
    else void c.setLookAt(n ? 2.5 : 2.3, n ? 4.3 : 3.3, n ? 6.6 : 3.7, n ? 0 : -0.45, n ? 1.2 : 1.15, 0, animate);
  };

  // Orbit all the way round the cat, and let the camera come much closer.
  const closeUp = (o: Opening) => {
    const c = controls.current;
    if (!c) return;
    const f = o.unbox.focus().add(depot.benchAnchor.position);
    const n = isNarrow();
    c.minDistance = 0.9;
    c.minAzimuthAngle = -Infinity;
    c.maxAzimuthAngle = Infinity;
    void c.setLookAt(f.x + (n ? 0.6 : 0.9), f.y + (n ? 0.8 : 0.5), f.z + (n ? 4.4 : 3.2), f.x, f.y, f.z, !reducedMotion());
  };

  useLeash(controls, BENCH_LEASH, () => {
    const o = opening.current;
    if (inspecting.current && o) closeUp(o);
    else frame(false, !reducedMotion());
  });

  useImperativeHandle(
    ref,
    () => ({
      shake: () => rig.shaker.shake(),
      feed: () => rig.feeder.drop(),
      pet: () => rig.petter.pet(),
      wait: (stage, kind) => rig.waiter.set(stage, kind),
      certify: (alive) => {
        if (vetMark.current) return;
        const mark = new VetMark(rig.box, alive, { reducedMotion: reducedMotion() });
        mark.onThud = () => sound.stamp();
        vetMark.current = mark;
        mark.stamp();
      },
      open: (cat) => {
        if (opening.current) return;
        const made = makeOpener(rig.box, cat, sound, { lamp: true });
        made.onDone = () => {
          // The box is gone: step back to see the cat on the bench.
          frame(false, !reducedMotion());
          onOpened();
        };
        opening.current = made;
        // Scripted move: push in over the lid so the reveal happens under the camera.
        frame(true, !reducedMotion());
        // After a long wait the lid is cracked and glowing: it slams shut for a beat, then bursts open.
        if (rig.waiter.active) rig.waiter.release(0.35, () => made.opener.open());
        else made.opener.open();
      },
      inspect: (out) => {
        const o = opening.current;
        const c = controls.current;
        if (!o?.unbox.done || !c) return;
        inspecting.current = out;
        if (!out) {
          frame(false, !reducedMotion());
          return;
        }
        closeUp(o);
      },
      lookFrom: (angle) => {
        if (!inspecting.current) return;
        const [azimuth, polar] = ANGLES[angle];
        void controls.current?.rotateTo(azimuth, polar, !reducedMotion());
      },
    }),
    [rig, depot, sound, onOpened],
  );

  // Arrival: one dolly from the aisle to the bench. A new box resets the framing.
  const arrived = useRef(false);
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    if (!arrived.current) {
      arrived.current = true;
      void c.setLookAt(5.5, 3.2, 8.5, 0, 1.3, 0, false);
    }
    frame(false, !reducedMotion());
  }, [tokenId]);

  useFrame((state, dt) => {
    const step = Math.min(dt, 0.1);
    depot.update(state.clock.elapsedTime);
    rig.shaker.update(step);
    rig.feeder.update(step);
    rig.petter.update(step);
    rig.waiter.update(step);
    vetMark.current?.update(step);
    rig.tags.update(state.clock.elapsedTime);
    if (opening.current) updateOpening(opening.current, step, state.clock.elapsedTime);
  });

  return (
    <>
      <Backdrop />
      <primitive object={depot.group} />
      <CameraControls ref={controls} makeDefault smoothTime={0.9} minDistance={1.8} maxDistance={8.5} {...BENCH_AZIMUTH} minPolarAngle={0.2} maxPolarAngle={Math.PI / 2 - 0.08} />
    </>
  );
}

export interface PairSceneHandle {
  duel(aWins: boolean): void;
  /** Plays the opening sequence on whichever box gets a cat. */
  open(catA: CatSpec | null, catB: CatSpec | null): void;
}

interface PairSceneProps {
  ref: Ref<PairSceneHandle>;
  tokenA: number;
  tokenB: number;
  /** Set for a box that is already open: shown open, with no sequence. */
  openedA: CatSpec | null;
  openedB: CatSpec | null;
  /** Draws the thread between the two boxes. */
  entangled: boolean;
  /** Paper tags on each box: up for a duel, entangled. */
  tagsA?: BoxTagSpec[];
  tagsB?: BoxTagSpec[];
  quality: QualitySettings;
  sound: ShakeSound;
  onDuelDone: () => void;
  onOpened: () => void;
}

const PAIR_SCALE = 0.82;

/** Two boxes on the bench: duel them, entangle them, open one and watch the other follow. */
export function PairScene({ ref, tokenA, tokenB, openedA, openedB, entangled, tagsA, tagsB, quality, sound, onDuelDone, onOpened }: PairSceneProps) {
  const controls = useRef<CameraControls>(null);
  const thread = useRef<EntanglementThread | null>(null);
  const openings = useRef<{ a?: Opening; b?: Opening }>({});

  const depot = useMemo(() => createDepot(quality), [quality]);
  useEffect(() => () => depot.dispose(), [depot]);

  const rig = useMemo(() => {
    const boxA = createBox(buildBoxSpec(tokenA));
    const boxB = createBox(buildBoxSpec(tokenB));
    const arena = new DuelArena(boxA, boxB, { reducedMotion: reducedMotion() });
    arena.group.scale.setScalar(PAIR_SCALE);
    arena.setSpotlights(true);
    const tags = { a: new BoxTags(boxA, { reducedMotion: reducedMotion() }), b: new BoxTags(boxB, { reducedMotion: reducedMotion() }) };
    return { boxA, boxB, arena, tags };
  }, [tokenA, tokenB]);
  useTags(rig.tags.a, tagsA);
  useTags(rig.tags.b, tagsB);

  useEffect(() => {
    depot.benchAnchor.add(rig.arena.group);
    return () => {
      depot.benchAnchor.remove(rig.arena.group);
      for (const o of Object.values(openings.current)) disposeOpening(o);
      openings.current = {};
      rig.arena.dispose();
      rig.tags.a.dispose();
      rig.tags.b.dispose();
      rig.boxA.dispose();
      rig.boxB.dispose();
    };
  }, [depot, rig]);

  useEffect(() => {
    if (!entangled) return;
    const t = new EntanglementThread(rig.boxA.group, rig.boxB.group, new Vector3(0, BOX_SIZE.height + 0.06, 0));
    thread.current = t;
    depot.group.add(t.group);
    return () => {
      depot.group.remove(t.group);
      t.dispose();
      thread.current = null;
    };
  }, [depot, rig, entangled]);

  useEffect(() => {
    const o = openings.current;
    if (openedA && !o.a) showOpened((o.a = makeOpener(rig.boxA, openedA, sound)));
    if (openedB && !o.b) showOpened((o.b = makeOpener(rig.boxB, openedB, sound)));
  }, [rig, openedA, openedB, sound]);

  const frame = (above: boolean, animate: boolean) => {
    const c = controls.current;
    if (!c) return;
    const n = isNarrow();
    // A phone is narrow: stand further back to take in both boxes, aimed at them (the stage keeps them above the slip).
    if (above) void c.setLookAt(n ? 0 : 0.3, n ? 6.6 : 4.4, n ? 6.6 : 4.0, n ? 0 : -0.55, n ? 1.3 : 1.35, 0, animate);
    else void c.setLookAt(n ? 0 : 0.4, n ? 4.4 : 3.1, n ? 8.2 : 5.0, n ? 0 : -0.55, 1.15, 0, animate);
  };

  useEffect(() => {
    rig.arena.onImpact = (strength) => sound.impact(strength);
    rig.arena.onClash = () => sound.impact(1);
    rig.arena.onDone = onDuelDone;
  }, [rig, sound, onDuelDone]);

  useImperativeHandle(
    ref,
    () => ({
      duel: (aWins) => {
        rig.arena.play(aWins);
        // Low two-shot, slightly off-axis.
        if (!isNarrow()) void controls.current?.setLookAt(0.5, 1.75, 4.8, -0.55, 1.3, 0, !reducedMotion());
      },
      open: (catA, catB) => {
        const o = openings.current;
        const fresh: Opening[] = [];
        if (catA && !o.a) fresh.push((o.a = makeOpener(rig.boxA, catA, sound)));
        if (catB && !o.b) fresh.push((o.b = makeOpener(rig.boxB, catB, sound)));
        if (!fresh.length) {
          onOpened();
          return;
        }
        fresh[fresh.length - 1]!.onDone = onOpened;
        // Back on their marks, then look down into both boxes.
        rig.arena.reset();
        frame(true, !reducedMotion());
        for (const f of fresh) f.opener.open();
      },
    }),
    [rig, sound, onOpened],
  );

  useEffect(() => frame(!!(openedA || openedB), false), [tokenA, tokenB]);
  useLeash(controls, BENCH_LEASH, () => frame(!!(openings.current.a || openings.current.b), !reducedMotion()));

  useFrame((state, dt) => {
    const step = Math.min(dt, 0.1);
    const t = state.clock.elapsedTime;
    depot.update(t);
    rig.arena.update(step);
    thread.current?.update(t, step);
    rig.tags.a.update(t);
    rig.tags.b.update(t);
    for (const o of Object.values(openings.current)) updateOpening(o, step, t);
  });

  return (
    <>
      <Backdrop />
      <primitive object={depot.group} />
      <CameraControls ref={controls} makeDefault smoothTime={0.8} minDistance={2} maxDistance={10.5} {...BENCH_AZIMUTH} minPolarAngle={0.3} maxPolarAngle={Math.PI / 2 - 0.08} />
    </>
  );
}

export interface ShelfBox {
  tokenId: number;
  /** Set when the box is open. */
  cat: CatSpec | null;
  /** The vet's verdict, if it was checked. */
  vet?: "alive" | "notAlive" | null;
  /** Paper tags on the box: up for a duel, entangled. */
  tags?: BoxTagSpec[];
  /** Croquettes wait for the holder in the Pantry: once the box is open, a heap of them sits beside the cat. */
  croquettes?: boolean;
}

interface ShelfSceneProps {
  boxes: ShelfBox[];
  /** Token ids just minted: they drop onto the bench, once, with a thud. */
  arrivals?: number[];
  quality: QualitySettings;
  sound: ShakeSound;
  /** A box pointed at from outside the scene (its tag in the slip): it lifts as if hovered. */
  highlight?: number | null;
  onSelect: (tokenId: number) => void;
}

export const SHELF_CAPACITY = 8;
/** How high a hovered box rises off the bench, and how long a picked one hops before it is taken. */
const LIFT_HEIGHT = 0.14;
const PICK_TIME = 0.42;
const SHELF_SCALE = 0.44;
/** Where a cat's heap of croquettes sits, in the box's own units: in front of it, a little aside, clear of its neighbours. */
const PILE_SPOT: [number, number, number] = [0.65, 0, 0.85];
/** A new box falls from this high above the bench, one after the other. */
const DROP_HEIGHT = 1.4;
const DROP_GRAVITY = 9;
const DROP_STAGGER = 0.22;
const BOUNCE_HEIGHT = 0.07;
const BOUNCE_TIME = 0.2;

/** The bench with the account's boxes laid out on it, up to eight. Click one to pick it up. */
export function ShelfScene({ boxes, arrivals = [], quality, sound, highlight = null, onSelect }: ShelfSceneProps) {
  const controls = useRef<CameraControls>(null);
  const depot = useMemo(() => createDepot(quality), [quality]);
  useEffect(() => () => depot.dispose(), [depot]);

  const key = boxes.map((b) => `${b.tokenId}${b.cat ? "o" : "s"}${b.vet ?? ""}`).join(",");
  const items = useMemo(
    () =>
      boxes.slice(0, SHELF_CAPACITY).map((b) => {
        const box = createBox(buildBoxSpec(b.tokenId));
        const opening = b.cat ? makeOpener(box, b.cat, sound) : null;
        if (opening) showOpened(opening);
        const vet = b.vet ? new VetMark(box, b.vet === "alive") : null;
        vet?.showInstant();
        // Only beside a cat: a sealed box keeps the banner in the slip.
        const pile = opening ? new KibblePile(b.tokenId, reducedMotion()) : null;
        pile?.group.position.set(...PILE_SPOT);
        return { tokenId: b.tokenId, box, opening, vet, pile, tags: new BoxTags(box, { reducedMotion: reducedMotion(), scale: 1.5 }) };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, sound],
  );
  useEffect(
    () => () => {
      for (const item of items) {
        if (item.opening) disposeOpening(item.opening);
        item.vet?.dispose();
        item.pile?.dispose();
        item.tags.dispose();
        item.box.dispose();
      }
    },
    [items],
  );
  const tagKey = JSON.stringify(boxes.map((b) => b.tags ?? []));
  useEffect(() => {
    for (const item of items) item.tags.set(boxes.find((b) => b.tokenId === item.tokenId)?.tags ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, tagKey]);
  const pileKey = boxes.map((b) => (b.croquettes ? 1 : 0)).join("");
  useEffect(() => {
    for (const item of items) item.pile?.set(!!boxes.find((b) => b.tokenId === item.tokenId)?.croquettes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, pileKey]);

  const frame = (animate: boolean) => {
    const n = isNarrow();
    void controls.current?.setLookAt(n ? 0.6 : 0.9, n ? 4.3 : 2.7, n ? 6.6 : 3.6, n ? 0 : -0.5, 1.05, 0, animate);
  };
  useEffect(() => frame(false), []);
  useLeash(controls, BENCH_LEASH, () => frame(!reducedMotion()));

  // Drops in flight, by token id: when each started and how far it has got. A token drops once.
  const slots = useRef(new Map<number, Group>());
  const drops = useRef(new Map<number, { start: number; landed: boolean; bounced: boolean }>());
  const dropped = useRef(new Set<number>());
  const waiting = (tokenId: number) => arrivals.includes(tokenId) && !dropped.current.has(tokenId);

  // Hover lifts a box off the bench and sways it; a click makes it hop, then it is taken.
  const lifters = useRef(new Map<number, Group>());
  const hovered = useRef<number | null>(null);
  const lifts = useRef(new Map<number, number>());
  const picking = useRef<{ tokenId: number; start: number } | null>(null);
  const clock = useRef(0);
  const pick = (tokenId: number) => {
    if (picking.current) return;
    if (reducedMotion()) {
      onSelect(tokenId);
      return;
    }
    sound.impact(0.18);
    picking.current = { tokenId, start: clock.current };
  };

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    clock.current = t;
    depot.update(t);
    for (const item of items) {
      if (item.opening) updateOpening(item.opening, Math.min(dt, 0.1), t);
      item.pile?.update(dt);
      item.tags.update(t);
    }

    const calm = reducedMotion() ? 0 : 1;
    for (const item of items) {
      const g = lifters.current.get(item.tokenId);
      if (!g) continue;
      const goal = item.tokenId === hovered.current || item.tokenId === highlight ? 1 : 0;
      const k = goal + ((lifts.current.get(item.tokenId) ?? 0) - goal) * Math.exp(-10 * Math.min(dt, 0.1));
      lifts.current.set(item.tokenId, k);
      // Lifted, it floats and turns a little towards the viewer.
      let y = k * LIFT_HEIGHT * (1 + 0.12 * Math.sin(t * 2.6) * calm);
      let rz = k * Math.sin(t * 3.1 + item.tokenId) * 0.035 * calm;
      let ry = k * Math.sin(t * 1.7 + item.tokenId) * 0.08 * calm;
      const p = picking.current;
      if (p?.tokenId === item.tokenId) {
        // The hop: up and a quick shake from side to side, then off to its own page.
        const u = Math.min(1, (t - p.start) / PICK_TIME);
        y += Math.sin(Math.PI * u) * 0.22;
        rz += Math.sin(u * Math.PI * 4) * 0.12 * (1 - u);
        ry += u * 0.5;
        if (u >= 1) {
          picking.current = null;
          onSelect(item.tokenId);
        }
      }
      g.position.y = y;
      g.rotation.set(0, ry, rz);
    }

    let queued = 0;
    for (const item of items) {
      if (!waiting(item.tokenId)) continue;
      dropped.current.add(item.tokenId);
      if (reducedMotion()) sound.land();
      else drops.current.set(item.tokenId, { start: t + queued++ * DROP_STAGGER, landed: false, bounced: false });
    }
    const fall = Math.sqrt((2 * DROP_HEIGHT) / DROP_GRAVITY);
    for (const [tokenId, d] of drops.current) {
      const slot = slots.current.get(tokenId);
      if (!slot) continue;
      const s = Math.max(0, t - d.start);
      if (s < fall) {
        slot.position.y = DROP_HEIGHT - 0.5 * DROP_GRAVITY * s * s;
        continue;
      }
      if (!d.landed) {
        d.landed = true;
        sound.land();
      }
      const b = s - fall;
      if (b < BOUNCE_TIME) {
        slot.position.y = BOUNCE_HEIGHT * Math.sin((Math.PI * b) / BOUNCE_TIME);
        continue;
      }
      slot.position.y = 0;
      if (!d.bounced) {
        d.bounced = true;
        sound.impact(0.12);
      }
      drops.current.delete(tokenId);
    }
  });

  const perRow = Math.min(4, Math.max(1, Math.ceil(items.length / (items.length > 4 ? 2 : 1))));
  const hover = (tokenId: number | null) => () => {
    if (tokenId === null && hovered.current === null) return;
    hovered.current = tokenId;
    document.body.style.cursor = tokenId !== null ? "pointer" : "";
  };
  useEffect(() => () => void (document.body.style.cursor = ""), []);

  return (
    <>
      <Backdrop />
      <primitive object={depot.group} />
      <group position={[0, BENCH_HEIGHT, 0]}>
        {items.map((item, i) => {
          const row = Math.floor(i / perRow);
          const inRow = Math.min(perRow, items.length - row * perRow);
          const x = (i % perRow - (inRow - 1) / 2) * 0.66;
          const z = items.length > perRow ? (row === 0 ? -0.32 : 0.32) : 0;
          return (
            <group
              key={item.tokenId}
              ref={(g) => {
                if (g) slots.current.set(item.tokenId, g);
                else slots.current.delete(item.tokenId);
              }}
              position={[x, waiting(item.tokenId) || drops.current.has(item.tokenId) ? DROP_HEIGHT : 0, z]}
              scale={SHELF_SCALE}
              rotation-y={buildBoxSpec(item.tokenId).labelSkew * 3}
            >
              {/* The handlers sit on the lifter: an open box is only its cat, which lives here too. */}
              <group
                ref={(g) => {
                  if (g) lifters.current.set(item.tokenId, g);
                  else lifters.current.delete(item.tokenId);
                }}
                onPointerOver={(e: { stopPropagation: () => void }) => {
                  e.stopPropagation();
                  hover(item.tokenId)();
                }}
                onPointerOut={() => {
                  if (hovered.current === item.tokenId) hover(null)();
                }}
                onClick={(e: { stopPropagation: () => void }) => {
                  e.stopPropagation();
                  pick(item.tokenId);
                }}
              >
                <primitive object={item.box.group} />
                {item.pile && <primitive object={item.pile.group} />}
              </group>
            </group>
          );
        })}
      </group>
      <CameraControls ref={controls} makeDefault smoothTime={0.8} minDistance={1.8} maxDistance={8.5} {...BENCH_AZIMUTH} minPolarAngle={0.3} maxPolarAngle={Math.PI / 2 - 0.08} />
    </>
  );
}

interface SpecimenSceneProps {
  specs: CatSpec[];
  selected: number;
  onSelect: (index: number) => void;
}

const SPACING = 3.1;
const slot = (i: number, n: number): [number, number, number] => {
  const k = i - (n - 1) / 2;
  return [k * SPACING, 0, -Math.abs(k) * 0.55];
};

/** Where the camera looks when a specimen is picked. */
const focusOn = (i: number, n: number) => {
  const [x, , z] = slot(i, n);
  const narrow = isNarrow();
  return {
    eye: [x + 0.5, narrow ? 1.8 : 1.25, z + (narrow ? 5.2 : 3.7)] as const,
    target: [x + (narrow ? 0 : 0.45), 0.62, z] as const,
  };
};

/** The slot nearest to a point on the row. */
const nearestSlot = (x: number, n: number) => Math.max(0, Math.min(n - 1, Math.round(x / SPACING + (n - 1) / 2)));

/** A sideways trackpad swipe this long (in wheel pixels) moves to the next specimen. */
const SWIPE_DISTANCE = 80;
/** After a swipe, ignore the rest of the gesture's momentum for this long. */
const SWIPE_COOLDOWN_MS = 450;

/**
 * Revealed cats on display, each in its own room. Moving along the row: arrow keys,
 * a sideways trackpad swipe, or a right-drag / two-finger drag that snaps to the
 * nearest cat when released. Left-drag still turns around the current one.
 */
export function SpecimenScene({ specs, selected, onSelect }: SpecimenSceneProps) {
  const controls = useRef<CameraControls>(null);
  const canvas = useThree((s) => s.gl.domElement);
  const dioramas = useMemo(() => specs.map((s) => createDiorama(s)), [specs]);
  useEffect(() => () => dioramas.forEach((d) => d.dispose()), [dioramas]);
  const count = specs.length;

  // The listeners below outlive renders; they read the latest values from here.
  const latest = useRef({ selected, onSelect, count });
  latest.current = { selected, onSelect, count };

  useEffect(() => {
    const { eye, target } = focusOn(selected, count);
    void controls.current?.setLookAt(...eye, ...target, !reducedMotion());
  }, [selected, count]);

  // The row and the rooms along it; the button puts the picked cat back in view.
  const reach = ((count - 1) / 2) * SPACING + 1;
  useLeash(controls, { min: [-reach, -1.2, -Math.abs(reach) * 0.2 - 2], max: [reach, 2.4, 1.5], touch: "row" }, () => {
    const { eye, target } = focusOn(latest.current.selected, latest.current.count);
    void controls.current?.setLookAt(...eye, ...target, !reducedMotion());
  });

  const step = (delta: number) => {
    const { selected: i, onSelect: pick, count: n } = latest.current;
    const next = Math.max(0, Math.min(n - 1, i + delta));
    if (next !== i) pick(next);
  };

  // Arrow keys, unless the visitor is typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName))) return;
      if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A sideways swipe on a trackpad walks the row. Vertical scrolling still zooms.
  useEffect(() => {
    let travelled = 0;
    let quietUntil = 0;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      if (performance.now() < quietUntil) return;
      travelled += e.deltaX;
      if (Math.abs(travelled) < SWIPE_DISTANCE) return;
      step(Math.sign(travelled));
      travelled = 0;
      quietUntil = performance.now() + SWIPE_COOLDOWN_MS;
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [canvas]);

  // Dragging the view sideways (right button, or two fingers) lands on the nearest cat.
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const at = new Vector3();
    const onEnd = () => {
      const { selected: i, onSelect: pick, count: n } = latest.current;
      c.getTarget(at);
      const nearest = nearestSlot(at.x, n);
      if (nearest !== i) return pick(nearest);
      // Still on the same cat but pushed off it: slide back.
      const { target } = focusOn(i, n);
      if (Math.abs(at.x - target[0]) > 0.4 || Math.abs(at.y - target[1]) > 0.6) {
        const cam = c.camera.position;
        void c.setLookAt(cam.x + target[0] - at.x, cam.y, cam.z, ...target, !reducedMotion());
      }
    };
    c.addEventListener("controlend", onEnd);
    return () => c.removeEventListener("controlend", onEnd);
  }, []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    for (const d of dioramas) d.update(t);
  });

  return (
    <>
      <color attach="background" args={[DEPOT_COLORS.shadow]} />
      <fogExp2 attach="fog" args={[DEPOT_COLORS.shadow, 0.055]} />
      <hemisphereLight args={["#AEB9C9", "#2A2018", 1.1]} />
      <directionalLight position={[3, 6, 5]} intensity={1.5} color="#FFE9CC" />
      <mesh rotation-x={-Math.PI / 2} position-y={-0.081}>
        <planeGeometry args={[60, 60]} />
        <meshLambertMaterial color={DEPOT_COLORS.concrete} />
      </mesh>
      {dioramas.map((d, i) => {
        const pos = slot(i, specs.length);
        return (
          <group key={specs[i]!.seed + specs[i]!.affection} position={pos} rotation-y={-pos[0] * 0.05}>
            <primitive
              object={d.group}
              onClick={(e: { stopPropagation: () => void }) => {
                e.stopPropagation();
                onSelect(i);
              }}
            />
            <pointLight position={[0.6, 1.9, 1.6]} intensity={i === selected ? 9 : 3} color={specs[i]!.room.light} distance={6} />
          </group>
        );
      })}
      <CameraControls ref={controls} makeDefault smoothTime={0.5} minDistance={1.6} maxDistance={9} minAzimuthAngle={-1.2} maxAzimuthAngle={1.2} maxPolarAngle={Math.PI / 2 - 0.05} />
    </>
  );
}
