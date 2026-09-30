export type QualityTier = "high" | "low";

export interface QualitySettings {
  tier: QualityTier;
  maxDpr: number;
  shadows: boolean;
  postprocessing: boolean;
  dustCount: number;
  shelfBoxes: number;
  targetFps: number;
}

export const QUALITY: Record<QualityTier, QualitySettings> = {
  high: { tier: "high", maxDpr: 2, shadows: true, postprocessing: true, dustCount: 500, shelfBoxes: 140, targetFps: 60 },
  low: { tier: "low", maxDpr: 1.25, shadows: false, postprocessing: false, dustCount: 120, shelfBoxes: 60, targetFps: 30 },
};

/** Coarse device check. Anything that looks like a phone or a weak GPU gets the low tier. */
export function detectQuality(): QualitySettings {
  if (typeof navigator === "undefined" || typeof window === "undefined") return QUALITY.high;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const small = Math.min(window.innerWidth, window.innerHeight) < 600;
  const weak = (nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 4;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  return QUALITY[(coarse && (small || weak)) || reduced ? "low" : "high"];
}
