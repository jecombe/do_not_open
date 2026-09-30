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
  type WaitKind,
  type WaitStage,
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
  /** Keeps the box busy while a chain action is pending; `null` lets it settle. */
  wait(stage: WaitStage | null, kind: WaitKind): void;
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
    return {
      box,
      shaker: new BoxShaker(box, { reducedMotion: reducedMotion() }),
      feeder: new FeedEffect(box, reducedMotion()),
      waiter: new BoxAnticipation(box, reducedMotion()),
    };
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
      rig.waiter.dispose();
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
    rig.waiter.onRattle = (strength) => sound.impact(strength);
    rig.waiter.onMutter = () => sound.complaint();
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
      wait: (stage, kind) => rig.waiter.set(stage, kind),
      open: (cat) => {
        if (opening.current) return;
        const made = makeOpener(rig.box, cat, sound);
        made.opener.onDone = onOpened;
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
    rig.waiter.update(step);
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
  /** Token ids just minted: they drop onto the bench, once, with a thud. */
  arrivals?: number[];
  quality: QualitySettings;
  sound: ShakeSound;
  onSelect: (tokenId: number) => void;
}

export const SHELF_CAPACITY = 8;
const SHELF_SCALE = 0.44;
/** A new box falls from this high above the bench, one after the other. */
const DROP_HEIGHT = 1.4;
const DROP_GRAVITY = 9;
const DROP_STAGGER = 0.22;
const BOUNCE_HEIGHT = 0.07;
const BOUNCE_TIME = 0.2;

/** The bench with the account's boxes laid out on it, up to eight. Click one to pick it up. */
export function ShelfScene({ boxes, arrivals = [], quality, sound, onSelect }: ShelfSceneProps) {
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

  // Drops in flight, by token id: when each started and how far it has got. A token drops once.
  const slots = useRef(new Map<number, Group>());
  const drops = useRef(new Map<number, { start: number; landed: boolean; bounced: boolean }>());
  const dropped = useRef(new Set<number>());
  const waiting = (tokenId: number) => arrivals.includes(tokenId) && !dropped.current.has(tokenId);

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    depot.update(t);
    for (const item of items) {
      item.opening?.opener.update(Math.min(dt, 0.1));
      item.opening?.content.update(t);
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

/** Where the camera looks when a specimen is picked. */
const focusOn = (i: number, n: number) => {
  const [x, , z] = slot(i, n);
  const narrow = isNarrow();
  return {
    eye: [x + 0.5, narrow ? 2.4 : 1.25, z + (narrow ? 6.2 : 3.7)] as const,
    target: [x + (narrow ? 0 : 0.45), narrow ? -0.9 : 0.62, z] as const,
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
