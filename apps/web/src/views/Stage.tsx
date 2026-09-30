import { Canvas } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import type { ReactNode } from "react";
import type { QualitySettings } from "@dno/scene";

/** The full-bleed 3D canvas every view draws into. */
export function Stage({ quality, children }: { quality: QualitySettings; children: ReactNode }) {
  return (
    <Canvas
      className="stage"
      shadows={quality.shadows}
      dpr={[1, quality.maxDpr]}
      camera={{ fov: 38, near: 0.1, far: 60, position: [5.5, 3.2, 8.5] }}
    >
      {children}
      {quality.postprocessing && (
        <EffectComposer>
          <Bloom intensity={0.4} luminanceThreshold={0.92} luminanceSmoothing={0.2} mipmapBlur />
          <Noise opacity={0.035} />
          <Vignette offset={0.25} darkness={0.72} />
        </EffectComposer>
      )}
    </Canvas>
  );
}
