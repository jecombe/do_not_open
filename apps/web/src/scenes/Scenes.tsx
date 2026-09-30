import { CameraControls } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useImperativeHandle, useMemo, useRef, type Ref } from "react";
import { Vector3 } from "three";
import { buildBoxSpec, type CatSpec } from "@dno/generator";
import {
  BOX_SIZE,
  BoxOpener,
  BoxShaker,
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

/** Builds the opening sequence for one box and wires its sounds. */
function makeOpener(box: BoxObject, cat: CatSpec, sound: ShakeSound) {
  const content = createCat(cat);
  const opener = new BoxOpener(box, { content: content.group, glow: glowFor(cat), reducedMotion: reducedMotion() });
  opener.onRip = () => sound.rip();
  opener.onBurst = () => sound.reveal(cat.state !== "ghost");
  return { opener, content };
}

export interface BoxSceneHandle {
  shake(): void;
  feed(): void;
  open(cat: CatSpec): void;
}

interface BoxSceneProps {
  ref: Ref<BoxSceneHandle>;
  tokenId: number;
  quality: QualitySettings;
  sound: ShakeSound;
  onShakeDone: () => void;
  onFed: () => void;
  onOpened: () => void;
}

/** The mail room with one box on the bench: shake it, feed it, open it. */
export function BoxScene({ ref, tokenId, quality, sound, onShakeDone, onFed, onOpened }: BoxSceneProps) {
  const controls = useRef<CameraControls>(null);
  const opening = useRef<{ opener: BoxOpener; content: CatObject } | null>(null);

  const depot = useMemo(() => createDepot(quality), [quality]);
  useEffect(() => () => depot.dispose(), [depot]);

  const rig = useMemo(() => {
    const box = createBox(buildBoxSpec(tokenId));
    return { box, shaker: new BoxShaker(box, { reducedMotion: reducedMotion() }), feeder: new FeedEffect(box, reducedMotion()) };
  }, [tokenId]);

  useEffect(() => {
    depot.benchAnchor.add(rig.box.group);
    return () => {
      depot.benchAnchor.remove(rig.box.group);
      opening.current?.opener.dispose();
      opening.current?.content.dispose();
      opening.current = null;
      rig.feeder.dispose();
      rig.box.dispose();
    };
  }, [depot, rig]);

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
    }),
    [rig, sound, onOpened],
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
  });

  return (
    <>
      <Backdrop />
      <primitive object={depot.group} />
      <CameraControls ref={controls} makeDefault smoothTime={0.9} minDistance={1.8} maxDistance={9} minPolarAngle={0.3} maxPolarAngle={Math.PI / 2 - 0.08} />
    </>
  );
}

export interface PairSceneHandle {
  duel(aWins: boolean): void;
  entangle(): void;
  /** Opens A; if the pair is entangled, B opens with it. */
  open(catA: CatSpec, catB: CatSpec | null): void;
}

interface PairSceneProps {
  ref: Ref<PairSceneHandle>;
  tokenA: number;
  tokenB: number;
  quality: QualitySettings;
  sound: ShakeSound;
  onDuelDone: () => void;
  onOpened: () => void;
}

const PAIR_SCALE = 0.82;

/** Two boxes on the bench: duel them, entangle them, open one and watch the other follow. */
export function PairScene({ ref, tokenA, tokenB, quality, sound, onDuelDone, onOpened }: PairSceneProps) {
  const controls = useRef<CameraControls>(null);
  const thread = useRef<EntanglementThread | null>(null);
  const openings = useRef<{ opener: BoxOpener; content: CatObject }[]>([]);

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
      if (thread.current) {
        depot.group.remove(thread.current.group);
        thread.current.dispose();
        thread.current = null;
      }
      for (const o of openings.current) {
        o.opener.dispose();
        o.content.dispose();
      }
      openings.current = [];
      rig.arena.dispose();
      rig.boxA.dispose();
      rig.boxB.dispose();
    };
  }, [depot, rig]);

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
      entangle: () => {
        if (thread.current) return;
        thread.current = new EntanglementThread(rig.boxA.group, rig.boxB.group, new Vector3(0, BOX_SIZE.height + 0.06, 0));
        depot.group.add(thread.current.group);
        sound.reveal(false);
      },
      open: (catA, catB) => {
        if (openings.current.length) return;
        const pairs: [BoxObject, CatSpec][] = catB ? [[rig.boxA, catA], [rig.boxB, catB]] : [[rig.boxA, catA]];
        openings.current = pairs.map(([box, cat]) => makeOpener(box, cat, sound));
        openings.current[openings.current.length - 1]!.opener.onDone = onOpened;
        // Back on their marks, then look down into both boxes.
        rig.arena.reset();
        frame(true, !reducedMotion());
        for (const o of openings.current) o.opener.open();
      },
    }),
    [rig, depot, sound, onOpened],
  );

  useEffect(() => frame(false, false), [tokenA, tokenB]);

  useFrame((state, dt) => {
    const step = Math.min(dt, 0.1);
    const t = state.clock.elapsedTime;
    depot.update(t);
    rig.arena.update(step);
    thread.current?.update(t, step);
    for (const o of openings.current) {
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
