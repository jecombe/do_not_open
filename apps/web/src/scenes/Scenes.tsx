import { CameraControls } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useImperativeHandle, useMemo, useRef, type Ref } from "react";
import { buildBoxSpec, type CatSpec } from "@dno/generator";
import {
  BoxShaker,
  createBox,
  createDepot,
  createDiorama,
  DEPOT_COLORS,
  type QualitySettings,
  type ShakeSound,
} from "@dno/scene";

export interface DepotHandle {
  shake(): void;
}

interface DepotSceneProps {
  ref: Ref<DepotHandle>;
  tokenId: number;
  quality: QualitySettings;
  sound: ShakeSound;
  onShakeDone: () => void;
}

/** The mail room with one sealed box on the bench. */
export function DepotScene({ ref, tokenId, quality, sound, onShakeDone }: DepotSceneProps) {
  const controls = useRef<CameraControls>(null);
  const reducedMotion = quality.tier === "low" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const depot = useMemo(() => createDepot(quality), [quality]);
  useEffect(() => () => depot.dispose(), [depot]);

  const box = useMemo(() => createBox(buildBoxSpec(tokenId)), [tokenId]);
  const shaker = useMemo(() => new BoxShaker(box, { reducedMotion }), [box, reducedMotion]);

  useEffect(() => {
    depot.benchAnchor.add(box.group);
    return () => {
      depot.benchAnchor.remove(box.group);
      box.dispose();
    };
  }, [depot, box]);

  useEffect(() => {
    shaker.onImpact = (strength) => sound.impact(strength);
    shaker.onDone = () => {
      if (Math.random() < 0.6) sound.complaint();
      onShakeDone();
    };
  }, [shaker, sound, onShakeDone]);

  useImperativeHandle(ref, () => ({ shake: () => shaker.shake() }), [shaker]);

  // One scripted move: walk in from the aisle and stop at the bench.
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const narrow = window.innerWidth < 700;
    void c.setLookAt(5.5, 3.2, 8.5, 0, 1.3, 0, false);
    void c.setLookAt(narrow ? 2.6 : 2.3, narrow ? 4.4 : 3.3, narrow ? 5.6 : 3.7, narrow ? 0 : -0.45, narrow ? 0.2 : 1.15, 0, !reducedMotion);
  }, [reducedMotion]);

  useFrame((state, dt) => {
    depot.update(state.clock.elapsedTime);
    shaker.update(Math.min(dt, 0.1));
  });

  return (
    <>
      <color attach="background" args={[DEPOT_COLORS.shadow]} />
      <fogExp2 attach="fog" args={[DEPOT_COLORS.shadow, 0.06]} />
      <primitive object={depot.group} />
      <CameraControls
        ref={controls}
        makeDefault
        smoothTime={0.9}
        minDistance={1.8}
        maxDistance={9}
        minPolarAngle={0.35}
        maxPolarAngle={Math.PI / 2 - 0.08}
      />
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
    const narrow = window.innerWidth < 700;
    void c.setLookAt(x + 0.5, narrow ? 2.4 : 1.25, z + (narrow ? 6.2 : 3.7), x + (narrow ? 0 : 0.45), narrow ? -0.9 : 0.62, z, true);
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
