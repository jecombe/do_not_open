/**
 * The protocols the site is built on, as a row of their own logos, each from its owner (Zama's
 * site, Uniswap's brand assets, delegate.xyz's repository, Arweave's site; Ethereum and OpenSea from
 * Simple Icons; USDC from cryptocurrency-icons). Each is drawn as a mask in the text's colour, so
 * the row stays one quiet tone on the dark page and a logo lights up in teal on hover.
 */
import arweave from "./protocols/arweave.svg";
import delegate from "./protocols/delegate.png";
import ethereum from "./protocols/ethereum.svg";
import opensea from "./protocols/opensea.svg";
import uniswap from "./protocols/uniswap.svg";
import zama from "./protocols/zama.svg";
import { USDC_GLYPH } from "./logos";
import "./protocols.css";

const usdc = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="4 4 24 24">${USDC_GLYPH.replace('fill="#FFF"', 'fill="#000"')}</svg>`,
)}`;

/** `ratio` is the logo's width over its height; `name` is written beside a logo that is only a mark. */
export const PROTOCOLS = [
  { id: "zama", title: "Zama", href: "https://www.zama.ai/", src: zama, ratio: 110 / 21 },
  { id: "ethereum", title: "Ethereum", href: "https://ethereum.org/", src: ethereum, ratio: 1, name: true },
  { id: "usdc", title: "USDC", href: "https://www.circle.com/usdc", src: usdc, ratio: 1, name: true },
  { id: "seaport", title: "Seaport", href: "https://github.com/ProjectOpenSea/seaport", src: opensea, ratio: 1, name: true },
  { id: "uniswap", title: "Uniswap", href: "https://uniswap.org/", src: uniswap, ratio: 400 / 434, name: true },
  { id: "delegate", title: "delegate.xyz", href: "https://delegate.xyz/", src: delegate, ratio: 480 / 113 },
  { id: "arweave", title: "Arweave", href: "https://arweave.org/", src: arweave, ratio: 184 / 32 },
] as const;

export type Protocol = (typeof PROTOCOLS)[number]["id"];

/** The row: each logo links to its protocol, with what the site uses it for written under it. */
export function ProtocolWall({ role }: { role: (id: Protocol) => string }) {
  return (
    <ul className="protocol-wall">
      {PROTOCOLS.map((p) => (
        <li key={p.id}>
          <a href={p.href} target="_blank" rel="noreferrer" title={p.title}>
            <span className="protocol-logo">
              <span
                className={`protocol-mark protocol-${p.id}`}
                style={{ "--ratio": p.ratio, maskImage: `url("${p.src}")`, WebkitMaskImage: `url("${p.src}")` } as React.CSSProperties}
                role="img"
                aria-label={p.title}
              />
              {"name" in p && <span className="protocol-name" aria-hidden="true">{p.title}</span>}
            </span>
            <span className="protocol-role">{role(p.id)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
