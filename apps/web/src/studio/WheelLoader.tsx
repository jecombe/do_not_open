import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { BoxGeometry, ConeGeometry, CylinderGeometry, Group, Mesh, SphereGeometry, TorusGeometry, type BufferGeometry } from "three";
import { buildRatSpec } from "@dno/generator";
import { createRat, outlineMaterial, toon } from "@dno/scene";
import type { JobKind } from "./service";

const INK = "#17130F";
const WHEEL_R = 0.95;
const WHEEL_W = 0.55;

/** A toon mesh with its inverted-hull outline, its geometry and materials collected for disposal. */
function inked(geometry: BufferGeometry, color: string, owned: { dispose(): void }[], line = 0.018): Mesh {
  const material = toon(color);
  const hullMaterial = outlineMaterial(INK, line);
  owned.push(geometry, material, hullMaterial);
  const mesh = new Mesh(geometry, material);
  mesh.add(new Mesh(geometry, hullMaterial));
  return mesh;
}

/** The hamster wheel: two rims, rungs between them, spokes on the far side and a stand. */
function buildWheel(owned: { dispose(): void }[]): { stand: Group; wheel: Group } {
  const stand = new Group();
  const wheel = new Group();
  wheel.position.y = WHEEL_R + 0.12;
  stand.add(wheel);

  const rim = new TorusGeometry(WHEEL_R, 0.045, 10, 64);
  for (const x of [-WHEEL_W, WHEEL_W]) {
    const r = inked(rim, "#d9472b", owned);
    r.rotation.y = Math.PI / 2;
    r.position.x = x;
    wheel.add(r);
  }
  const rung = new CylinderGeometry(0.022, 0.022, WHEEL_W * 2, 6);
  const rungs = 26;
  for (let i = 0; i < rungs; i++) {
    const a = (i / rungs) * Math.PI * 2;
    const m = inked(rung, "#e9dfc8", owned, 0.01);
    m.rotation.z = Math.PI / 2;
    m.position.set(0, Math.cos(a) * WHEEL_R, Math.sin(a) * WHEEL_R);
    wheel.add(m);
  }
  const spoke = new CylinderGeometry(0.02, 0.02, WHEEL_R * 2, 6);
  for (let i = 0; i < 3; i++) {
    const s = inked(spoke, "#d9472b", owned, 0.01);
    s.position.x = -WHEEL_W;
    s.rotation.x = (i / 3) * Math.PI;
    wheel.add(s);
  }
  const hub = inked(new SphereGeometry(0.08, 16, 12), "#f2b33d", owned);
  hub.position.x = -WHEEL_W - 0.02;
  wheel.add(hub);

  const leg = new CylinderGeometry(0.035, 0.05, WHEEL_R + 0.2, 8);
  for (const z of [-0.35, 0.35]) {
    const l = inked(leg, "#7a5434", owned, 0.012);
    l.position.set(-WHEEL_W - 0.08, (WHEEL_R + 0.12) / 2, z);
    l.rotation.x = z > 0 ? -0.36 : 0.36;
    stand.add(l);
  }
  return { stand, wheel };
}

/** What circles the wheel: pencils for a sketch, clay blocks for a 3D model. */
function buildOrbiters(kind: JobKind, owned: { dispose(): void }[]): Group[] {
  const colors = ["#f2b33d", "#3f8fd8", "#e8467c", "#5fb35a", "#9b6be0", "#f07d32"];
  return colors.map((color, i) => {
    const g = new Group();
    if (kind === "sketch") {
      const body = inked(new CylinderGeometry(0.035, 0.035, 0.32, 6), color, owned, 0.01);
      const tip = inked(new ConeGeometry(0.035, 0.09, 6), "#f4d9a8", owned, 0.01);
      tip.position.y = -0.205;
      const lead = inked(new ConeGeometry(0.012, 0.03, 6), INK, owned, 0.004);
      lead.position.y = -0.245;
      lead.rotation.x = Math.PI;
      tip.rotation.x = Math.PI;
      g.add(body, tip, lead);
    } else {
      const s = 0.1 + (i % 3) * 0.03;
      g.add(inked(new BoxGeometry(s, s, s), color, owned, 0.012));
    }
    return g;
  });
}

function Scene({ kind, seed, progress }: { kind: JobKind; seed: bigint; progress: () => number }) {
  const owned = useRef<{ dispose(): void }[]>([]);
  const built = useMemo(() => {
    const list: { dispose(): void }[] = [];
    const { stand, wheel } = buildWheel(list);
    const rat = createRat(buildRatSpec(seed));
    rat.group.scale.setScalar(0.7);
    const runner = new Group();
    runner.position.y = 0.17;
    runner.add(rat.group);
    stand.add(runner);
    const orbiters = buildOrbiters(kind, list);
    for (const o of orbiters) stand.add(o);
    owned.current = list;
    return { stand, wheel, rat, runner, orbiters };
  }, [kind, seed]);

  useEffect(
    () => () => {
      built.rat.dispose();
      for (const o of owned.current) o.dispose();
    },
    [built],
  );

  const turned = useRef(0);
  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    const p = progress();
    // The closer to done, the faster it runs.
    const speed = 2.4 + p * 4;
    turned.current += Math.min(dt, 0.1) * speed;
    built.wheel.rotation.x = turned.current;
    const stride = t * speed * 3.2;
    built.runner.position.y = 0.17 + Math.abs(Math.sin(stride)) * 0.05;
    built.runner.rotation.x = Math.sin(stride * 2) * 0.05 + 0.08;
    built.rat.update(t * 2);
    built.orbiters.forEach((o, i) => {
      const a = t * (0.7 + (i % 2) * 0.25) + (i / built.orbiters.length) * Math.PI * 2;
      const r = 1.5 + Math.sin(t * 0.9 + i) * 0.12;
      o.position.set(Math.cos(a) * r * 0.55, 1.1 + Math.sin(a * 2 + i) * 0.45, Math.sin(a) * r);
      o.rotation.set(t * 1.3 + i, t * 0.8, Math.sin(t + i) * 0.6);
    });
  });

  return <primitive object={built.stand} />;
}

/**
 * The studio's waiting room: a rat running in a hamster wheel while the AI works, pencils
 * circling it for a sketch, blocks of clay for a 3D model. `progress` (0 to 1) speeds it up.
 */
export function WheelLoader({ kind, seed, progress }: { kind: JobKind; seed: bigint; progress: () => number }) {
  return (
    <Canvas dpr={[1, 2]} camera={{ fov: 34, near: 0.1, far: 40, position: [4.9, 1.9, 3.1] }} onCreated={({ camera }) => camera.lookAt(0, 0.62, 0)}>
      <color attach="background" args={["#241d17"]} />
      <hemisphereLight args={["#ffe9c4", "#3a2c20", 1.2]} />
      <directionalLight position={[3, 5, 2]} intensity={2} />
      <mesh rotation-x={-Math.PI / 2}>
        <circleGeometry args={[1.7, 48]} />
        <meshToonMaterial color="#b8895a" />
      </mesh>
      <Scene kind={kind} seed={seed} progress={progress} />
    </Canvas>
  );
}
