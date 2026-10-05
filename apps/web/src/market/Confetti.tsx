import { useEffect, useMemo, type CSSProperties } from "react";

const COLORS = ["#C2261D", "#FFB454", "#7DE3D0", "#D9C28A", "#B8895A", "#E9DFC8"];
const SHAPES = ["square", "strip", "dot", "fish"] as const;

/**
 * A deal struck: a stamp slams down and paper bits rain over the market. Pure CSS motion,
 * gone after a few seconds; with reduced motion, only the stamp shows, still.
 */
export function Confetti({ text, onDone }: { text: string; onDone: () => void }) {
  const bits = useMemo(
    () =>
      Array.from({ length: 70 }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 0.6,
        duration: 1.8 + Math.random() * 1.4,
        drift: (Math.random() - 0.5) * 220,
        spin: (Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 720),
        color: COLORS[i % COLORS.length]!,
        shape: SHAPES[i % SHAPES.length]!,
      })),
    [],
  );

  useEffect(() => {
    const id = setTimeout(onDone, 3200);
    return () => clearTimeout(id);
  }, [onDone]);

  return (
    <div className="fm-party" aria-live="polite">
      {bits.map((b, i) => (
        <span
          key={i}
          className={`fm-bit fm-bit-${b.shape}`}
          style={
            {
              left: `${b.left}%`,
              background: b.shape === "fish" ? undefined : b.color,
              color: b.color,
              animationDelay: `${b.delay}s`,
              animationDuration: `${b.duration}s`,
              "--drift": `${b.drift}px`,
              "--spin": `${b.spin}deg`,
            } as CSSProperties
          }
        />
      ))}
      <p className="fm-party-stamp">{text}</p>
    </div>
  );
}
