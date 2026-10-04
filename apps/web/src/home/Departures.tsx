import { useEffect, useRef, useState } from "react";
import { useLocale } from "../i18n/locale";
import { useT } from "./i18n";

/**
 * The depot's departure board: where the boxes ship from today, and where they ship next.
 * Split-flap letters, like an old station board. Sepolia's line counts the chain's blocks as
 * they come; mainnet's flips between its two notices now and then, never to a date.
 */

/** Sepolia makes a block every 12 seconds: the bar under the number fills over that time. */
const BLOCK_MS = 12_000;
/** How long the mainnet line waits before it flips to its other notice. */
const NOTICE_MS = 6_500;
const FLAPS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#·";

const calm = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The latest Sepolia block the game knows of: the API's indexer, or the RPC when there is no API. Null when neither answers. */
function useSepoliaBlock(): number | null {
  const [block, setBlock] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const api = import.meta.env.VITE_API_URL?.replace(/\/$/, "");
    const rpc = import.meta.env.VITE_SEPOLIA_RPC_URL;
    if (!api && !rpc) return;
    const read = async (): Promise<number> => {
      if (api) {
        const res = await fetch(`${api}/health`);
        if (!res.ok) throw new Error(`API ${res.status}`);
        return Number(((await res.json()) as { block: number | string }).block);
      }
      const res = await fetch(rpc!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });
      return Number.parseInt(((await res.json()) as { result: string }).result, 16);
    };
    const tick = () =>
      read().then(
        (b) => live && Number.isFinite(b) && b > 0 && setBlock(b),
        () => undefined,
      );
    void tick();
    const timer = setInterval(tick, BLOCK_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return block;
}

/** `text`, its letters flipping through the alphabet each time it changes, left to right. */
function useFlaps(text: string): string {
  const [shown, setShown] = useState(text);
  const from = useRef(text);
  useEffect(() => {
    if (from.current === text) return;
    const start = from.current.padEnd(text.length);
    from.current = text;
    if (calm()) {
      setShown(text);
      return;
    }
    const began = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = now - began;
      let done = true;
      const next = [...text]
        .map((c, i) => {
          // Each letter turns for a while, a little longer than the one to its left.
          if (t >= 260 + i * 55 || c === start[i]) return c;
          done = false;
          return c === " " ? " " : FLAPS[Math.floor(Math.random() * FLAPS.length)]!;
        })
        .join("");
      setShown(next);
      if (!done) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [text]);
  return shown;
}

/** One cell of the board: a row of flaps, one per letter, all the same width. */
function Flaps({ text, width, className }: { text: string; width: number; className?: string }) {
  const shown = useFlaps(text.toUpperCase().padEnd(width));
  return (
    <span className={`flaps${className ? ` ${className}` : ""}`} aria-hidden="true">
      {[...shown].map((c, i) => (
        <span key={i} className="flap">
          {c}
        </span>
      ))}
    </span>
  );
}

export function Departures() {
  const t = useT();
  const locale = useLocale();
  const block = useSepoliaBlock();
  const notices = [t("home.board.soon"), t("home.board.soon2")];
  const [notice, setNotice] = useState(0);
  useEffect(() => {
    if (calm()) return;
    const timer = setInterval(() => setNotice((n) => (n + 1) % notices.length), NOTICE_MS);
    return () => clearInterval(timer);
  }, [notices.length]);
  const statusWidth = Math.max(t("home.board.live").length, ...notices.map((n) => n.length));
  const number = block === null ? null : `#${block.toLocaleString(locale).replace(/\s|,|\./g, " ")}`;

  return (
    <figure className="board" aria-label={t("home.board.aria")}>
      <figcaption className="board-head">
        <span>{t("home.board.title")}</span>
        {number && (
          <span className="board-block" aria-hidden="true">
            {t("home.board.block")} <Flaps text={number} width={number.length} className="is-small" />
          </span>
        )}
      </figcaption>
      <p className="board-row is-live">
        <span className="visually-hidden">{t("home.board.liveSr")}</span>
        <Flaps text="Sepolia" width={8} />
        <span className="board-status">
          <span className="board-dot" aria-hidden="true" />
          <Flaps text={t("home.board.live")} width={statusWidth} />
        </span>
      </p>
      {/* Restarts with each new block: the time left until the next one, roughly. */}
      {number && <span key={block} className="board-next" aria-hidden="true" />}
      <p className="board-row">
        <span className="visually-hidden">{t("home.board.soonSr")}</span>
        <Flaps text="Mainnet" width={8} />
        <span className="board-status">
          <span className="board-dot is-off" aria-hidden="true" />
          <Flaps text={notices[notice]!} width={statusWidth} className="is-soon" />
        </span>
      </p>
    </figure>
  );
}
