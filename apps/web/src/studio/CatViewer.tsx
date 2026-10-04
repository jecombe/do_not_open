import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useState } from "react";
import { buildCatSpec } from "@dno/generator";
import { createCat } from "@dno/scene";
import { useT } from "../i18n/app";
import { loadToonModel, type StageObject } from "./toonModel";

/** What stands on the turntable: a procedural cat from a seed, or a model the AI made. */
export type Subject = { kind: "cat"; seed: bigint } | { kind: "model"; url: string };

function Turntable({ subject, onState }: { subject: Subject; onState: (s: "loading" | "ready" | "failed") => void }) {
  const [object, setObject] = useState<StageObject | null>(null);

  useEffect(() => {
    let live = true;
    let made: StageObject | null = null;
    onState("loading");
    setObject(null);
    if (subject.kind === "cat") {
      const cat = createCat(buildCatSpec({ seed: subject.seed }));
      made = cat;
      setObject(cat);
      cat.ready.then(
        () => live && onState("ready"),
        () => live && onState("failed"),
      );
    } else {
      loadToonModel(subject.url).then(
        (m) => {
          if (!live) return m.dispose();
          made = m;
          setObject(m);
          onState("ready");
        },
        () => live && onState("failed"),
      );
    }
    return () => {
      live = false;
      made?.dispose();
    };
  }, [subject, onState]);

  useFrame(({ clock }) => object?.update(clock.elapsedTime));
  return object ? <primitive object={object.group} /> : null;
}

/** The studio's stage: one cat on a round of floor, turned with a drag. */
export function CatViewer({ subject, label }: { subject: Subject; label: string }) {
  const t = useT();
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  return (
    <div className="studio-viewer" role="img" aria-label={label}>
      <Canvas shadows dpr={[1, 2]} camera={{ fov: 32, near: 0.1, far: 40, position: [1.9, 1.25, 2.9] }}>
        <color attach="background" args={["#241d17"]} />
        <hemisphereLight args={["#ffe9c4", "#3a2c20", 1.1]} />
        <directionalLight position={[3, 5, 2]} intensity={2.2} castShadow shadow-mapSize={[1024, 1024]} />
        <mesh rotation-x={-Math.PI / 2} receiveShadow>
          <circleGeometry args={[1.4, 48]} />
          <meshToonMaterial color="#b8895a" />
        </mesh>
        <Turntable subject={subject} onState={setState} />
        <OrbitControls target={[0, 0.5, 0]} enablePan={false} minDistance={1.6} maxDistance={5} minPolarAngle={0.3} maxPolarAngle={1.45} />
      </Canvas>
      {state !== "ready" && <p className="studio-viewer-state">{state === "loading" ? t("studio.viewer.loading") : t("studio.viewer.failed")}</p>}
    </div>
  );
}
