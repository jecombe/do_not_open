import type { ReactNode } from "react";

const ICONS: Record<string, ReactNode> = {
  lock: <path d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5zM12 15v2" />,
  eyeOff: <path d="M3 3l18 18M10.6 6.1A9.6 9.6 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3 3.6M6.6 6.6C4.3 8.1 3 12 3 12s4 6 9 6c1.5 0 2.9-.4 4.1-1M9.9 9.9a3 3 0 0 0 4.2 4.2" />,
  shield: <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4" />,
  key: <path d="M14 10a4 4 0 1 0-1.2 2.8L21 21M17 17l2-2M19 19l2-2" />,
  exit: <path d="M14 4h6v16h-6M10 8l-4 4 4 4M6 12h11" />,
  eye: <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z" />,
};

export function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg className="sec-icon" viewBox="0 0 24 24" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}
