import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Intersection, Object3D } from "three";
import type { QualitySettings } from "@dno/scene";
import { useT } from "../i18n/app";
import { ASTRAY, RECENTER } from "../scenes/leash";

const NARROW = "(max-width: 700px)";

/**
 * On a phone the slip lies across the bottom of the scene. This shifts the picture up so the
 * point the camera looks at sits in the middle of what is left above the slip, and follows the
 * slip as it folds, unfolds or grows. The scale stays the same; the camera does not move.
 */
function AboveTheSlip() {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const shift = useRef(0);
  useFrame(() => {
    // A slip sent `.is-away` by its tabs is hidden on a phone: the one showing is the other.
    const slip = document.querySelector<HTMLElement>(".slip:not(.is-away)");
    let goal = 0;
    if (slip && window.matchMedia(NARROW).matches) goal = Math.max(0, size.top + size.height - slip.getBoundingClientRect().top) / 2;
    const next = Math.abs(goal - shift.current) < 0.5 ? goal : shift.current + (goal - shift.current) * 0.18;
    const view = camera.view;
    const same = view?.enabled ? view.offsetY === next && view.fullWidth === size.width && view.fullHeight === size.height : next === 0;
    if (same) return;
    shift.current = next;
    if (next === 0) camera.clearViewOffset();
    else camera.setViewOffset(size.width, size.height, 0, next, size.width, size.height);
  });
  return null;
}

/** Whether an object is drawn at all: it and every one of its parents visible. */
function shown(o: Object3D) {
  for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

/**
 * The raycaster tests hidden objects too, and Points with a one-unit reach. An opened box keeps
 * its hidden carton, light beam and dust around its cat, and they would take the pointer from
 * the box next to it. Only what is drawn can be pointed at, and dust never.
 */
function PickWhatIsDrawn() {
  const setEvents = useThree((s) => s.setEvents);
  useEffect(() => {
    setEvents({ filter: (hits: Intersection[]) => hits.filter((h) => !(h.object as { isPoints?: boolean }).isPoints && shown(h.object)) });
  }, [setEvents]);
  return null;
}

/** The full-bleed 3D canvas every view draws into, and a way back once the view is lost. */
export function Stage({ quality, children }: { quality: QualitySettings; children: ReactNode }) {
  const t = useT();
  // Shown once the visitor has moved the camera, until it is put back.
  const [astray, setAstray] = useState(false);
  useEffect(() => {
    const on = (e: Event) => setAstray((e as CustomEvent<boolean>).detail);
    window.addEventListener(ASTRAY, on);
    return () => window.removeEventListener(ASTRAY, on);
  }, []);

  return (
    <>
      <Canvas
        className="stage"
        shadows={quality.shadows}
        dpr={[1, quality.maxDpr]}
        camera={{ fov: 38, near: 0.1, far: 60, position: [5.5, 3.2, 8.5] }}
      >
        <AboveTheSlip />
        <PickWhatIsDrawn />
        {children}
        {quality.postprocessing && (
          <EffectComposer>
            <Bloom intensity={0.4} luminanceThreshold={0.92} luminanceSmoothing={0.2} mipmapBlur />
            <Noise opacity={0.035} />
            <Vignette offset={0.25} darkness={0.72} />
          </EffectComposer>
        )}
      </Canvas>
      {astray && (
        <button type="button" className="recenter" title={t("stage.recenterHint")} onClick={() => window.dispatchEvent(new Event(RECENTER))}>
          <span aria-hidden="true">⌖</span> {t("stage.recenter")}
        </button>
      )}
    </>
  );
}
