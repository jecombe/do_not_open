import { useEffect, useMemo, useState } from "react";
import { detectQuality, ShakeSound } from "@dno/scene";
import { BoxView } from "./views/BoxView";
import { PairView } from "./views/PairView";
import { SpecimensView } from "./views/SpecimensView";

const VIEWS = [
  { key: "box", label: "One box" },
  { key: "pair", label: "Two boxes" },
  { key: "specimens", label: "Specimens" },
] as const;
type View = (typeof VIEWS)[number]["key"];

export function App() {
  const quality = useMemo(detectQuality, []);
  const sound = useMemo(() => new ShakeSound(), []);
  const [view, setView] = useState<View>("box");
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    sound.muted = muted;
  }, [sound, muted]);
  useEffect(() => () => sound.dispose(), [sound]);

  return (
    <div className="app">
      {view === "box" && <BoxView quality={quality} sound={sound} />}
      {view === "pair" && <PairView quality={quality} sound={sound} />}
      {view === "specimens" && <SpecimensView quality={quality} />}

      <header className="masthead">
        <h1 className="wordmark">Do not open</h1>
        <nav className="views" aria-label="Views">
          {VIEWS.map((v) => (
            <button type="button" key={v.key} aria-pressed={view === v.key} onClick={() => setView(v.key)}>
              {v.label}
            </button>
          ))}
        </nav>
      </header>

      <footer className="notice">
        <span>Mock depot. No chain connected; seeds are local stand-ins.</span>
        <button type="button" className="link" onClick={() => setMuted((m) => !m)} aria-pressed={muted}>
          {muted ? "Sound is off" : "Sound is on"}
        </button>
      </footer>
    </div>
  );
}
