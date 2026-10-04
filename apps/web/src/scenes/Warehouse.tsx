import { CameraControls } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { Group, Vector3, type Object3D } from "three";
import type { CatSpec } from "@dno/generator";
import { createCat, createWarehouse, DEPOT_COLORS, type CatObject, type QualitySettings, type WarehouseBoxState } from "@dno/scene";
import { useLeash } from "./leash";

export interface WarehouseBox {
  state: WarehouseBoxState;
  mine: boolean;
}

interface WarehouseSceneProps {
  count: number;
  /** By token id; boxes not read yet are drawn sealed. */
  boxes: Map<number, WarehouseBox>;
  /** The cats of opened boxes, by token id: the nearest stand on their flattened cartons. */
  cats: Map<number, CatSpec>;
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
/** How low and how high the camera may go in the warehouse, and how far it may back away from what it looks at. */
const FLOOR = 0.3;
const CEILING = 5;
const MAX_DISTANCE = 9;

/** How far from `from`, along the unit vector `dir`, before a wall, the floor or the ceiling. */
function reach(from: Vector3, dir: Vector3, b: { minX: number; maxX: number; minZ: number; maxZ: number }) {
  let t = Infinity;
  const axis = (p: number, d: number, lo: number, hi: number) => {
    if (d > 1e-6) t = Math.min(t, (hi - p) / d);
    else if (d < -1e-6) t = Math.min(t, (lo - p) / d);
  };
  axis(from.x, dir.x, b.minX, b.maxX);
  axis(from.y, dir.y, FLOOR, CEILING);
  axis(from.z, dir.z, b.minZ, b.maxZ);
  return Math.max(0.6, t);
}
/** How many cats are built at once, the nearest to the camera: thousands of them would not run. */
const CAT_POOL = { high: 16, low: 8 } as const;
/** How often the nearest cats are worked out again, in seconds. */
const CAT_RESORT = 0.5;
/** The token id a picked mesh belongs to: each cat's group carries it. */
const tokenOf = (o: Object3D | null): number | undefined => {
  for (let x = o; x; x = x.parent) if (typeof x.userData.tokenId === "number") return x.userData.tokenId as number;
  return undefined;
};

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const typing = (e: KeyboardEvent) => e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));

/** Every minted box on racks. Walk the aisles with the keys or by dragging; click a box to pick it. */
export function WarehouseScene({ count, boxes, cats, quality, selected, flight, onHover, onPick }: WarehouseSceneProps) {
  const controls = useRef<CameraControls>(null);
  const warehouse = useMemo(() => createWarehouse(count, quality), [count, quality]);
  useEffect(() => () => warehouse.dispose(), [warehouse]);

  useEffect(() => {
    for (const [tokenId, b] of boxes) warehouse.setState(tokenId, b.state, b.mine);
  }, [warehouse, boxes]);

  useEffect(() => warehouse.select(selected), [warehouse, selected]);

  // The cats out of their boxes: only the nearest are built, and swapped as the visitor walks.
  const catGroup = useMemo(() => new Group(), []);
  const live = useRef(new Map<number, { spec: CatSpec; cat: CatObject }>());
  const resortAt = useRef(0);
  const dropCat = (tokenId: number) => {
    const l = live.current.get(tokenId);
    if (!l) return;
    catGroup.remove(l.cat.group);
    l.cat.dispose();
    live.current.delete(tokenId);
  };
  useEffect(() => {
    // Another warehouse, or a cat no longer known: built again at the next sort.
    for (const [id, l] of [...live.current]) if (cats.get(id) !== l.spec) dropCat(id);
    resortAt.current = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warehouse, cats]);
  useEffect(
    () => () => {
      for (const id of [...live.current.keys()]) dropCat(id);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [warehouse],
  );

  // At the door. A narrow screen stands further back to take in the row.
  const enter = (animate: boolean) => {
    const { position: p, target: t } = warehouse.entrance;
    const back = Math.min(1.9, Math.max(1, 1.6 / (window.innerWidth / window.innerHeight)));
    void controls.current?.setLookAt(p.x, p.y + (back - 1) * 0.6, t.z + (p.z - t.z) * back, t.x, t.y, t.z, animate);
  };
  // In the aisle in front of a box, a little above it so an opened one shows it is flat.
  const face = (tokenId: number, animate: boolean) => {
    const b = warehouse.positionOf(tokenId);
    // A phone is narrow: back off so the neighbours show on either side.
    const back = window.innerWidth < 700 ? 1.9 : 1;
    void controls.current?.setLookAt(b.x, b.y + 1.1 * back, b.z + 3.4 * back, b.x, b.y, b.z, animate);
  };

  // Enter by the door, once per warehouse.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => enter(false), [warehouse]);

  // Fly to the picked box.
  useEffect(() => {
    if (selected === null || selected >= count) return;
    face(selected, !reducedMotion());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warehouse, flight]);

  // Between the racks: one finger slides along them, two pinch forward and turn. The button goes back
  // to the picked box, or to the door.
  const { minX, maxX, minZ } = warehouse.bounds;
  // What the camera looks at stays near the racks, no further back than the door.
  useLeash(controls, { min: [minX, 0.1, minZ], max: [maxX, 3.8, warehouse.entrance.position.z], touch: "walk" }, () => {
    if (selected !== null && selected < count) face(selected, !reducedMotion());
    else enter(!reducedMotion());
  });

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
    const time = state.clock.elapsedTime;
    if (time >= resortAt.current && cats.size) {
      resortAt.current = time + CAT_RESORT;
      const eye = state.camera.position;
      const near = [...cats.keys()]
        .filter((id) => id < count)
        .map((id) => ({ id, d: warehouse.positionOf(id).distanceToSquared(eye) }))
        .sort((x, y) => x.d - y.d)
        .slice(0, CAT_POOL[quality.tier])
        .map((x) => x.id);
      for (const id of [...live.current.keys()]) if (!near.includes(id)) dropCat(id);
      for (const id of near) {
        if (live.current.has(id)) continue;
        const spec = cats.get(id)!;
        const cat = createCat(spec);
        cat.group.position.copy(warehouse.catSpot(id));
        cat.group.scale.setScalar(warehouse.scale);
        cat.group.userData.tokenId = id;
        catGroup.add(cat.group);
        live.current.set(id, { spec, cat });
      }
    }
    for (const { cat } of live.current.values()) cat.update(time);
    const c = controls.current;
    if (!c) return;
    // The camera stays between the walls: backing out stops at the one behind it, however far
    // the wheel turns. Only the reach changes, so the next turn forward moves it at once.
    c.getPosition(pos);
    c.getTarget(target);
    c.maxDistance = Math.min(MAX_DISTANCE, reach(target, forward.subVectors(pos, target).normalize(), warehouse.bounds));
    if (!held.current.size) return;
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
      {/* A cat is picked like its box: a still click on it opens the box's page. */}
      <primitive
        object={catGroup}
        onPointerMove={(e: { object: Object3D; stopPropagation: () => void }) => {
          e.stopPropagation();
          const id = tokenOf(e.object) ?? null;
          cursor(id !== null);
          onHover(id);
          warehouse.hover(id);
        }}
        onPointerOut={() => {
          cursor(false);
          onHover(null);
          warehouse.hover(null);
        }}
        onClick={(e: { object: Object3D; delta: number; stopPropagation: () => void }) => {
          e.stopPropagation();
          const id = tokenOf(e.object);
          if (e.delta > 6 || id === undefined) return;
          onPick(id);
        }}
      />
      <CameraControls
        ref={controls}
        makeDefault
        smoothTime={0.5}
        minDistance={0.6}
        maxDistance={MAX_DISTANCE}
        minPolarAngle={0.35}
        maxPolarAngle={Math.PI / 2 - 0.04}
        dollyToCursor
      />
    </>
  );
}
