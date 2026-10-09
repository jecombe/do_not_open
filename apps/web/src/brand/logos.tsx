/**
 * Official logos, drawn inline: the services the site links to (Discord, GitLab, X), from
 * Simple Icons, and the tokens it handles (ETH, WETH, USDC), from cryptocurrency-icons, both CC0,
 * in each brand's own colour. A confidential token (cUSDC, cWETH) is its plain token's logo
 * with the site's teal padlock: its issuers have no logo of their own for it.
 */
import "./logos.css";

/** Simple Icons' paths, on a 24 by 24 grid, with each brand's colour. */
const BRANDS = {
  discord: {
    title: "Discord",
    color: "#5865F2",
    path: "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z",
  },
  gitlab: {
    title: "GitLab",
    color: "#FC6D26",
    path: "m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z",
  },
  x: {
    title: "X",
    color: "currentColor",
    path: "M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z",
  },
} as const;

export type Brand = keyof typeof BRANDS;

/** A service's logo, in its colour (X's in the text's). Decorative: the link around it carries the name. */
export function BrandIcon({ brand, size = 18, mono = false }: { brand: Brand; size?: number; mono?: boolean }) {
  const b = BRANDS[brand];
  return (
    <svg className={`brand-icon brand-${brand}`} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d={b.path} fill={mono ? "currentColor" : b.color} />
    </svg>
  );
}

export const brandName = (brand: Brand): string => BRANDS[brand].title;

/** An icon-only link to a service: its logo, its name for screen readers and on hover. */
export function BrandLink({ brand, href, label, size, className }: { brand: Brand; href: string; label?: string; size?: number; className?: string }) {
  const name = label ?? BRANDS[brand].title;
  return (
    <a className={`brand-link${className ? ` ${className}` : ""}`} href={href} target="_blank" rel="noreferrer" aria-label={name} title={name}>
      <BrandIcon brand={brand} size={size} />
    </a>
  );
}

// --- tokens, on a 32 by 32 grid ---

const ETH_GLYPH =
  '<g fill="#FFF" fill-rule="nonzero"><path fill-opacity=".602" d="M16.498 4v8.87l7.497 3.35z"/><path d="M16.498 4L9 16.22l7.498-3.35z"/><path fill-opacity=".602" d="M16.498 21.968v6.027L24 17.616z"/><path d="M16.498 27.995v-6.028L9 17.616z"/><path fill-opacity=".2" d="M16.498 20.573l7.497-4.353-7.497-3.348z"/><path fill-opacity=".602" d="M9 16.22l7.498 4.353v-7.701z"/></g>';
export const USDC_GLYPH =
  '<g fill="#FFF"><path d="M20.022 18.124c0-2.124-1.28-2.852-3.84-3.156-1.828-.243-2.193-.728-2.193-1.578 0-.85.61-1.396 1.828-1.396 1.097 0 1.707.364 2.011 1.275a.458.458 0 00.427.303h.975a.416.416 0 00.427-.425v-.06a3.04 3.04 0 00-2.743-2.489V9.142c0-.243-.183-.425-.487-.486h-.915c-.243 0-.426.182-.487.486v1.396c-1.829.242-2.986 1.456-2.986 2.974 0 2.002 1.218 2.791 3.778 3.095 1.707.303 2.255.668 2.255 1.639 0 .97-.853 1.638-2.011 1.638-1.585 0-2.133-.667-2.316-1.578-.06-.242-.244-.364-.427-.364h-1.036a.416.416 0 00-.426.425v.06c.243 1.518 1.219 2.61 3.23 2.914v1.457c0 .242.183.425.487.485h.915c.243 0 .426-.182.487-.485V21.34c1.829-.303 3.047-1.578 3.047-3.217z"/><path d="M12.892 24.497c-4.754-1.7-7.192-6.98-5.424-11.653.914-2.55 2.925-4.491 5.424-5.402.244-.121.365-.303.365-.607v-.85c0-.242-.121-.424-.365-.485-.061 0-.183 0-.244.06a10.895 10.895 0 00-7.13 13.717c1.096 3.4 3.717 6.01 7.13 7.102.244.121.488 0 .548-.243.061-.06.061-.122.061-.243v-.85c0-.182-.182-.424-.365-.546zm6.46-18.936c-.244-.122-.488 0-.548.242-.061.061-.061.122-.061.243v.85c0 .243.182.485.365.607 4.754 1.7 7.192 6.98 5.424 11.653-.914 2.55-2.925 4.491-5.424 5.402-.244.121-.365.303-.365.607v.85c0 .242.121.424.365.485.061 0 .183 0 .244-.06a10.895 10.895 0 007.13-13.717c-1.096-3.46-3.778-6.07-7.13-7.162z"/></g>';
/** The site's padlock, on a dark disc at the bottom right: what makes a token confidential. */
const SEAL =
  '<circle cx="25" cy="25" r="7" fill="#07090c" stroke="#5be3c2" stroke-width="1.4"/><path d="M23 24.2v-1.4a2 2 0 0 1 4 0v1.4" fill="none" stroke="#5be3c2" stroke-width="1.3" stroke-linecap="round"/><rect x="22" y="24.2" width="6" height="4.6" rx="1" fill="#5be3c2"/>';

const coin = (color: string, glyph: string, sealed = false) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="${color}"/>${glyph}${sealed ? SEAL : ""}</svg>`;

const TOKENS: Record<string, string> = {
  ETH: coin("#627EEA", ETH_GLYPH),
  WETH: coin("#EC1C79", ETH_GLYPH),
  CWETH: coin("#EC1C79", ETH_GLYPH, true),
  USDC: coin("#2775CA", USDC_GLYPH),
  CUSDC: coin("#2775CA", USDC_GLYPH, true),
};

/** A token's logo as an SVG document, or null for a token without one (CROQ draws as text). */
export function tokenSvg(symbol: string): string | null {
  return TOKENS[symbol.toUpperCase()] ?? null;
}

/** A token's logo as a URL an `<img>` or a canvas can load. */
export function tokenLogoUrl(symbol: string): string | null {
  const svg = tokenSvg(symbol);
  return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null;
}

/** A token's logo next to its symbol. Decorative: the symbol stays written beside it. */
export function TokenIcon({ symbol, size = 16 }: { symbol: string; size?: number }) {
  const src = tokenLogoUrl(symbol);
  if (!src) return null;
  return <img className="token-icon" src={src} width={size} height={size} alt="" aria-hidden="true" draggable={false} />;
}
