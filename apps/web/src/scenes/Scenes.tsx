import { CameraControls } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useImperativeHandle, useMemo, useRef, type Ref } from "react";
import { Group, Vector3 } from "three";
import { buildBoxSpec, type CatSpec } from "@dno/generator";
import {
  BENCH_HEIGHT,
  BOX_SIZE,
  BoxOpener,
  BoxShaker,
  CatInspector,
  createBox,
  createCat,
  createDepot,
  createDiorama,
  DEPOT_COLORS,
  DuelArena,
  EntanglementThread,
  FeedEffect,
  SPECTRAL,
  type BoxObject,
  type CatObject,
  type QualitySettings,
  type ShakeSound,
} from "@dno/scene";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isNarrow = () => window.innerWidth < 700;
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
  content: CatObject;
  /** What the opener and the inspector move. The cat animates inside it. */
  holder: Group;
}

/** Builds the opening sequence for one box and wires its sounds. */
function makeOpener(box: BoxObject, cat: CatSpec, sound: ShakeSound): Opening {
  const content = createCat(cat);
  const holder = new Group();
  holder.add(content.group);
  const opener = new BoxOpener(box, { content: holder, glow: glowFor(cat), reducedMotion: reducedMotion() });
  opener.onRip = () => sound.rip();
  opener.onBurst = () => sound.reveal(cat.state !== "ghost");
  return { opener, content, holder };
}

function disposeOpening(o: Opening) {
  o.holder.removeFromParent();
  o.opener.dispose();
  o.content.dispose();
}

export type InspectAngle = "front" | "left" | "back" | "right" | "above";

export interface BoxSceneHandle {
  shake(): void;
  feed(): void;
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

/** The mail room with one box on the bench: shake it, feed it, open it, take the cat out. */
export function BoxScene({ ref, tokenId, opened, quality, sound, onShakeDone, onFed, onOpened }: BoxSceneProps) {
  const controls = useRef<CameraControls>(null);
  const opening = useRef<Opening | null>(null);
  const inspector = useRef<CatInspector | null>(null);

  const depot = useMemo(() => createDepot(quality), [quality]);
  useEffect(() => () => depot.dispose(), [depot]);

  const rig = useMemo(() => {
    const box = createBox(buildBoxSpec(tokenId));
    return { box, shaker: new BoxShaker(box, { reducedMotion: reducedMotion() }), feeder: new FeedEffect(box, reducedMotion()) };
  }, [tokenId]);

  useEffect(() => {
    depot.benchAnchor.add(rig.box.group);
    return () => {
      inspector.current?.dispose();
      inspector.current = null;
      if (opening.current) disposeOpening(opening.current);
      opening.current = null;
      depot.benchAnchor.remove(rig.box.group);
      rig.feeder.dispose();
      rig.box.dispose();
    };
  }, [depot, rig]);

  // A box that was opened earlier is simply shown open.
  useEffect(() => {
    if (!opened || opening.current) return;
    opening.current = makeOpener(rig.box, opened, sound);
    opening.current.opener.openInstant();
  }, [rig, opened, sound]);

  useEffect(() => {
    rig.shaker.onImpact = (strength) => sound.impact(strength);
    rig.shaker.onDone = () => {
      if (Math.random() < 0.6) sound.complaint();
      onShakeDone();
    };
    rig.feeder.onTick = () => sound.tick();
    rig.feeder.onEaten = () => {
      sound.purr();
      onFed();
    };
  }, [rig, sound, onShakeDone, onFed]);

  const frame = (close: boolean, animate: boolean) => {
    const c = controls.current;
    if (!c) return;
    const n = isNarrow();
    c.minDistance = 1.8;
    if (close) void c.setLookAt(n ? 1.5 : 1.3, n ? 4.6 : 3.5, n ? 5.0 : 3.1, n ? 0 : -0.35, n ? 0.5 : 1.45, 0, animate);
    else void c.setLookAt(n ? 2.6 : 2.3, n ? 4.4 : 3.3, n ? 5.6 : 3.7, n ? 0 : -0.45, n ? 0.2 : 1.15, 0, animate);
  };

  useImperativeHandle(
    ref,
    () => ({
      shake: () => rig.shaker.shake(),
      feed: () => rig.feeder.drop(),
      open: (cat) => {
        if (opening.current) return;
        const made = makeOpener(rig.box, cat, sound);
        made.opener.onDone = onOpened;
        opening.current = made;
        made.opener.open();
        // Scripted move: push in over the lid so the reveal happens under the camera.
        frame(true, !reducedMotion());
      },
      inspect: (out) => {
        const o = opening.current;
        const c = controls.current;
        if (!o?.opener.opened || !c) return;
        if (!inspector.current) {
          inspector.current = new CatInspector(rig.box, o.holder, { reducedMotion: reducedMotion() });
          inspector.current.onLand = () => sound.impact(0.25);
        }
        if (!out) {
          inspector.current.putBack();
          frame(true, !reducedMotion());
          return;
        }
        inspector.current.takeOut();
        // Orbit around the cat from now on, and let the camera come much closer.
        const f = inspector.current.focus().add(depot.benchAnchor.position);
        const n = isNarrow();
        c.minDistance = 0.9;
        // On a phone the slip covers the lower third: aim below the cat so it sits above it.
        void c.setLookAt(f.x + (n ? 0.5 : 0.9), f.y + (n ? 0.9 : 0.5), f.z + (n ? 4.6 : 3.2), f.x, f.y - (n ? 0.55 : 0), f.z, !reducedMotion());
      },
      lookFrom: (angle) => {
        if (!inspector.current?.out) return;
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
    opening.current?.opener.update(step);
    opening.current?.content.update(state.clock.elapsedTime);
    inspector.current?.update(step);
  });

  return (
    <>
      <Backdrop />
      <primitive object={depot.group} />
      <CameraControls ref={controls} makeDefault smoothTime={0.9} minDistance={1.8} maxDistance={9} minPolarAngle={0.2} maxPolarAngle={Math.PI / 2 - 0.08} />
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
  quality: QualitySettings;
  sound: ShakeSound;
  onDuelDone: () => void;
  onOpened: () => void;
}

const PAIR_SCALE = 0.82;

/** Two boxes on the bench: duel them, entangle them, open one and watch the other follow. */
export function PairScene({ ref, tokenA, tokenB, openedA, openedB, entangled, quality, sound, onDuelDone, onOpened }: PairSceneProps) {
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
    return { boxA, boxB, arena };
  }, [tokenA, tokenB]);

  useEffect(() => {
    depot.benchAnchor.add(rig.arena.group);
    return () => {
      depot.benchAnchor.remove(rig.arena.group);
      for (const o of Object.values(openings.current)) disposeOpening(o);
      openings.current = {};
      rig.arena.dispose();
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
    if (openedA && !o.a) (o.a = makeOpener(rig.boxA, openedA, sound)).opener.openInstant();
    if (openedB && !o.b) (o.b = makeOpener(rig.boxB, openedB, sound)).opener.openInstant();
  }, [rig, openedA, openedB, sound]);

  const frame = (above: boolean, animate: boolean) => {
    const c = controls.current;
    if (!c) return;
    const n = isNarrow();
    if (above) void c.setLookAt(n ? 0 : 0.3, n ? 6.2 : 4.4, n ? 7.4 : 4.0, n ? 0 : -0.55, n ? 0.2 : 1.35, 0, animate);
    else void c.setLookAt(n ? 0 : 0.4, n ? 4.6 : 3.1, n ? 8.2 : 5.0, n ? 0 : -0.55, n ? 0.0 : 1.15, 0, animate);
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
        fresh[fresh.length - 1]!.opener.onDone = onOpened;
        // Back on their marks, then look down into both boxes.
        rig.arena.reset();
        frame(true, !reducedMotion());
        for (const f of fresh) f.opener.open();
      },
    }),
    [rig, sound, onOpened],
  );

  useEffect(() => frame(!!(openedA || openedB), false), [tokenA, tokenB]);

  useFrame((state, dt) => {
    const step = Math.min(dt, 0.1);
    const t = state.clock.elapsedTime;
    depot.update(t);
    rig.arena.update(step);
    thread.current?.update(t, step);
    for (const o of Object.values(openings.current)) {
      o.opener.update(step);
      o.content.update(t);
    }
  });

  return (
    <>
      <Backdrop />
      <primitive object={depot.group} />
      <CameraControls ref={controls} makeDefault smoothTime={0.8} minDistance={2} maxDistance={10} minPolarAngle={0.3} maxPolarAngle={Math.PI / 2 - 0.08} />
    </>
  );
}

export interface ShelfBox {
  tokenId: number;
  /** Set when the box is open. */
  cat: CatSpec | null;
}

interface ShelfSceneProps {
  boxes: ShelfBox[];
  quality: QualitySettings;
  sound: ShakeSound;
  onSelect: (tokenId: number) => void;
}

export const SHELF_CAPACITY = 8;
const SHELF_SCALE = 0.44;

/** The bench with the account's boxes laid out on it, up to eight. Click one to pick it up. */
export function ShelfScene({ boxes, quality, sound, onSelect }: ShelfSceneProps) {
  const controls = useRef<CameraControls>(null);
  const depot = useMemo(() => createDepot(quality), [quality]);
  useEffect(() => () => depot.dispose(), [depot]);

  const key = boxes.map((b) => `${b.tokenId}${b.cat ? "o" : "s"}`).join(",");
  const items = useMemo(
    () =>
      boxes.slice(0, SHELF_CAPACITY).map((b) => {
        const box = createBox(buildBoxSpec(b.tokenId));
        const opening = b.cat ? makeOpener(box, b.cat, sound) : null;
        opening?.opener.openInstant();
        return { tokenId: b.tokenId, box, opening };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, sound],
  );
  useEffect(
    () => () => {
      for (const item of items) {
        if (item.opening) disposeOpening(item.opening);
        item.box.dispose();
      }
    },
    [items],
  );

  useEffect(() => {
    const n = isNarrow();
    void controls.current?.setLookAt(n ? 0.6 : 0.9, n ? 4.2 : 2.7, n ? 6.4 : 3.6, n ? 0 : -0.5, n ? 0.3 : 1.05, 0, false);
  }, []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    depot.update(t);
    for (const item of items) item.opening?.content.update(t);
  });

  const perRow = Math.min(4, Math.max(1, Math.ceil(items.length / (items.length > 4 ? 2 : 1))));
  const hover = (on: boolean) => () => {
    document.body.style.cursor = on ? "pointer" : "";
  };
  useEffect(() => hover(false), []);

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
            <group key={item.tokenId} position={[x, 0, z]} scale={SHELF_SCALE} rotation-y={buildBoxSpec(item.tokenId).labelSkew * 3}>
              <primitive
                object={item.box.group}
                onPointerOver={hover(true)}
                onPointerOut={hover(false)}
                onClick={(e: { stopPropagation: () => void }) => {
                  e.stopPropagation();
                  onSelect(item.tokenId);
                }}
              />
            </group>
          );
        })}
      </group>
      <CameraControls ref={controls} makeDefault smoothTime={0.8} minDistance={1.8} maxDistance={9} minPolarAngle={0.3} maxPolarAngle={Math.PI / 2 - 0.08} />
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

/** Revealed cats on display, each in its own room. */
export function SpecimenScene({ specs, selected, onSelect }: SpecimenSceneProps) {
  const controls = useRef<CameraControls>(null);
  const dioramas = useMemo(() => specs.map((s) => createDiorama(s)), [specs]);
  useEffect(() => () => dioramas.forEach((d) => d.dispose()), [dioramas]);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const [x, , z] = slot(selected, specs.length);
    const n = isNarrow();
    void c.setLookAt(x + 0.5, n ? 2.4 : 1.25, z + (n ? 6.2 : 3.7), x + (n ? 0 : 0.45), n ? -0.9 : 0.62, z, true);
  }, [selected, specs.length]);

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
      <CameraControls ref={controls} makeDefault smoothTime={0.5} minDistance={1.6} maxDistance={9} maxPolarAngle={Math.PI / 2 - 0.05} />
    </>
  );
}
