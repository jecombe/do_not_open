import { CameraControlsImpl, type CameraControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useEffect, useRef, type RefObject } from "react";
import { Box3, Vector3 } from "three";

const { ACTION } = CameraControlsImpl;

/** Asks the scene on stage to put its camera back where it was framed. */
export const RECENTER = "dno:recenter";
/** Told by a scene when the visitor moves its camera away from the framing (`detail: true`) or back. */
export const ASTRAY = "dno:astray";

const coarse = () => window.matchMedia("(pointer: coarse)").matches;

export interface Leash {
  /** Where the point the camera looks at may go: dragging the view stops at the walls of this box. */
  min: [number, number, number];
  max: [number, number, number];
  /**
   * "orbit": one finger turns around the scene, two pinch (a bench seen from the front). A pinch
   * that also slid the view was how phones lost the bench: there is nothing to slide to here.
   * "row": the same, but two fingers also slide along a row of things.
   * "walk": one finger slides the view like a map, two pinch to go forward and turn (a warehouse).
   */
  touch: "orbit" | "row" | "walk";
}

/**
 * Keeps a visitor near what they came to see: the view cannot be dragged off into the
 * dark, a finger turns it gently, and a "recenter" button brings the framing back.
 * `reframe` puts the camera where the scene wants it; it is called on the button.
 */
export function useLeash(controls: RefObject<CameraControls | null>, leash: Leash, reframe: () => void) {
  const canvas = useThree((s) => s.gl.domElement);
  const latest = useRef(reframe);
  latest.current = reframe;
  const [x0, y0, z0] = leash.min;
  const [x1, y1, z1] = leash.max;

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    c.setBoundary(new Box3(new Vector3(x0, y0, z0), new Vector3(x1, y1, z1)));
    c.boundaryFriction = 0;
    c.boundaryEnclosesCamera = false;
    if (leash.touch === "walk") {
      c.touches.one = ACTION.TOUCH_TRUCK;
      c.touches.two = ACTION.TOUCH_DOLLY_ROTATE;
      c.touches.three = ACTION.NONE;
      // Pinching past the closest distance walks on instead of stopping dead.
      c.infinityDolly = true;
    } else {
      c.touches.one = ACTION.TOUCH_ROTATE;
      c.touches.two = leash.touch === "row" ? ACTION.TOUCH_DOLLY_TRUCK : ACTION.TOUCH_DOLLY;
      c.touches.three = ACTION.NONE;
    }
    // A thumb sweeps far more of a phone than a mouse does of a desk: turn slower under it.
    if (coarse()) {
      c.azimuthRotateSpeed = 0.55;
      c.polarRotateSpeed = 0.45;
      c.truckSpeed = 1.4;
    }
  }, [controls, x0, y0, z0, x1, y1, z1, leash.touch]);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const astray = (on: boolean) => window.dispatchEvent(new CustomEvent(ASTRAY, { detail: on }));
    const moved = () => astray(true);
    // A tap on a box starts and ends a control too: only a drag that went somewhere counts.
    const from = new Vector3();
    const start = () => c.getPosition(from);
    const end = () => {
      if (c.getPosition(new Vector3()).distanceTo(from) > 0.05) moved();
    };
    const back = () => {
      latest.current();
      astray(false);
    };
    c.addEventListener("controlstart", start);
    c.addEventListener("controlend", end);
    // The wheel does not raise controlstart.
    canvas.addEventListener("wheel", moved, { passive: true });
    window.addEventListener(RECENTER, back);
    return () => {
      c.removeEventListener("controlstart", start);
      c.removeEventListener("controlend", end);
      canvas.removeEventListener("wheel", moved);
      window.removeEventListener(RECENTER, back);
      astray(false);
    };
  }, [controls, canvas]);
}
