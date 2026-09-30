import { CameraControls } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { Vector3 } from "three";
import { createWarehouse, DEPOT_COLORS, type QualitySettings, type WarehouseBoxState } from "@dno/scene";

export interface WarehouseBox {
  state: WarehouseBoxState;
  mine: boolean;
}

interface WarehouseSceneProps {
  count: number;
  /** By token id; boxes not read yet are drawn sealed. */
  boxes: Map<number, WarehouseBox>;
  quality: QualitySettings;
  selected: number | null;
  /** Bumped to fly the camera to `selected` again. */
  flight: number;
  onHover: (tokenId: number | null) => void;
  onPick: (tokenId: number) => void;
}

const WALK_SPEED = 4.5;
const MOVES: Record<string, [number, number]> = {
  KeyW: [0, 1],
  ArrowUp: [0, 1],
  KeyS: [0, -1],
  ArrowDown: [0, -1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const typing = (e: KeyboardEvent) => e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));

/** Every minted box on racks. Walk the aisles with the keys or by dragging; click a box to pick it. */
export function WarehouseScene({ count, boxes, quality, selected, flight, onHover, onPick }: WarehouseSceneProps) {
  const controls = useRef<CameraControls>(null);
  const warehouse = useMemo(() => createWarehouse(count, quality), [count, quality]);
  useEffect(() => () => warehouse.dispose(), [warehouse]);

  useEffect(() => {
    for (const [tokenId, b] of boxes) warehouse.setState(tokenId, b.state, b.mine);
  }, [warehouse, boxes]);

  useEffect(() => warehouse.select(selected), [warehouse, selected]);

  // Enter by the door, once per warehouse. A narrow screen stands further back to take in the row.
  useEffect(() => {
    const { position: p, target: t } = warehouse.entrance;
    const back = Math.min(1.9, Math.max(1, 1.6 / (window.innerWidth / window.innerHeight)));
    // On a phone the slip covers the lower half: aim under the rack so it sits above the slip.
    const drop = (back - 1) * 1.6;
    void controls.current?.setLookAt(p.x, p.y + (back - 1) * 0.6, t.z + (p.z - t.z) * back, t.x, t.y - drop, t.z, false);
  }, [warehouse]);

  // Fly to the picked box: stand in the aisle in front of it.
  useEffect(() => {
    if (selected === null || selected >= count) return;
    const b = warehouse.positionOf(selected);
    // A little above it, so an open box shows its flaps.
    void controls.current?.setLookAt(b.x, b.y + 1.1, b.z + 3.4, b.x, b.y, b.z, !reducedMotion());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warehouse, flight]);

  // Keys held down, walked on every frame.
  const held = useRef(new Set<string>());
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!(e.code in MOVES) || typing(e)) return;
      e.preventDefault();
      held.current.add(e.code);
    };
    const up = (e: KeyboardEvent) => held.current.delete(e.code);
    const blur = () => held.current.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  const pos = useMemo(() => new Vector3(), []);
  const target = useMemo(() => new Vector3(), []);
  const forward = useMemo(() => new Vector3(), []);
  const right = useMemo(() => new Vector3(), []);
  useFrame((state, dt) => {
    warehouse.update(state.clock.elapsedTime, dt);
    const c = controls.current;
    if (!c || !held.current.size) return;
    let ahead = 0;
    let side = 0;
    for (const code of held.current) {
      const m = MOVES[code];
      if (!m) continue;
      side += m[0];
      ahead += m[1];
    }
    if (!ahead && !side) return;
    c.getPosition(pos);
    c.getTarget(target);
    // Walk on the floor: the look direction flattened, and its right-hand side.
    forward.subVectors(target, pos).setY(0).normalize();
    right.set(-forward.z, 0, forward.x);
    const step = WALK_SPEED * Math.min(dt, 0.05);
    const dx = (forward.x * ahead + right.x * side) * step;
    const dz = (forward.z * ahead + right.z * side) * step;
    const { minX, maxX, minZ, maxZ } = warehouse.bounds;
    const nx = Math.min(maxX, Math.max(minX, pos.x + dx));
    const nz = Math.min(maxZ, Math.max(minZ, pos.z + dz));
    void c.setLookAt(nx, pos.y, nz, target.x + (nx - pos.x), target.y, target.z + (nz - pos.z), false);
  });

  const cursor = (on: boolean) => {
    document.body.style.cursor = on ? "pointer" : "";
  };
  useEffect(() => () => cursor(false), []);

  return (
    <>
      <color attach="background" args={[DEPOT_COLORS.shadow]} />
      <fogExp2 attach="fog" args={[DEPOT_COLORS.shadow, 0.045]} />
      <primitive object={warehouse.group} />
      <primitive
        object={warehouse.bodies}
        onPointerMove={(e: { instanceId?: number; stopPropagation: () => void }) => {
          e.stopPropagation();
          const id = e.instanceId ?? null;
          cursor(id !== null);
          onHover(id);
          warehouse.hover(id);
        }}
        onPointerOut={() => {
          cursor(false);
          onHover(null);
          warehouse.hover(null);
        }}
        onClick={(e: { instanceId?: number; delta: number; stopPropagation: () => void }) => {
          e.stopPropagation();
          // A drag to look around ends with a click too: only a still click picks.
          if (e.delta > 6 || e.instanceId === undefined) return;
          onPick(e.instanceId);
        }}
      />
      <CameraControls
        ref={controls}
        makeDefault
        smoothTime={0.5}
        minDistance={0.6}
        maxDistance={9}
        minPolarAngle={0.35}
        maxPolarAngle={Math.PI / 2 - 0.04}
        dollyToCursor
      />
    </>
  );
}
