import type { RatSpec } from "./ratSpec";

const HATS: Record<RatSpec["hat"], string> = {
  none: "",
  party: `<path d="M86 34 L100 2 L114 34 Z" fill="#E8467C"/><circle cx="100" cy="3" r="5" fill="#F5C542"/>`,
  beanie: `<path d="M70 40 Q100 6 130 40 Z" fill="#2E6FD8"/><rect x="68" y="36" width="64" height="9" rx="4" fill="#F2EEE6"/><circle cx="100" cy="12" r="6" fill="#F2EEE6"/>`,
  crown: `<path d="M78 40 L78 22 L88 32 L100 16 L112 32 L122 22 L122 40 Z" fill="#F2C14E"/>`,
  tophat: `<rect x="72" y="36" width="56" height="6" rx="2" fill="#1E1B22"/><rect x="82" y="6" width="36" height="32" fill="#1E1B22"/><rect x="82" y="28" width="36" height="5" fill="#C8102E"/>`,
  chef: `<rect x="80" y="26" width="40" height="16" fill="#FFFDF6"/><circle cx="86" cy="22" r="10" fill="#FFFDF6"/><circle cx="100" cy="16" r="12" fill="#FFFDF6"/><circle cx="114" cy="22" r="10" fill="#FFFDF6"/>`,
};

function eyes(spec: RatSpec): string {
  const e = spec.colors.eye;
  if (spec.eyes === "shades") return `<rect x="76" y="58" width="21" height="12" rx="3" fill="#15121A"/><rect x="103" y="58" width="21" height="12" rx="3" fill="#15121A"/><rect x="96" y="61" width="8" height="3" fill="#15121A"/>`;
  if (spec.eyes === "dots") return `<circle cx="86" cy="63" r="4" fill="${e}"/><circle cx="114" cy="63" r="4" fill="${e}"/>`;
  const r = spec.eyes === "sleepy" ? 8 : 10;
  const [dl, dr] = spec.eyes === "derp" ? [[3, -2], [-2, 3]] : [[1, 1], [1, 1]];
  const lid = spec.eyes === "sleepy" ? `<path d="M77 63 A9 9 0 0 1 95 63 Z" fill="${spec.colors.fur}"/><path d="M105 63 A9 9 0 0 1 123 63 Z" fill="${spec.colors.fur}"/>` : "";
  return (
    `<circle cx="86" cy="63" r="${r}" fill="#fff" stroke="${spec.colors.outline}" stroke-width="2"/><circle cx="114" cy="63" r="${r}" fill="#fff" stroke="${spec.colors.outline}" stroke-width="2"/>` +
    `<circle cx="${86 + dl![0]!}" cy="${64 + dl![1]!}" r="${r * 0.5}" fill="${e}"/><circle cx="${114 + dr![0]!}" cy="${64 + dr![1]!}" r="${r * 0.5}" fill="${e}"/>` +
    lid
  );
}

function mouth(spec: RatSpec): string {
  const o = spec.colors.outline;
  const teeth = spec.face === "shock" ? "" : `<rect x="94" y="96" width="6" height="${spec.face === "teeth" ? 13 : 9}" fill="#FFFDF6" stroke="${o}" stroke-width="1.5"/><rect x="100" y="96" width="6" height="${spec.face === "teeth" ? 13 : 9}" fill="#FFFDF6" stroke="${o}" stroke-width="1.5"/>`;
  const extra =
    spec.face === "tongue"
      ? `<ellipse cx="104" cy="108" rx="5" ry="4" fill="#E8607A"/>`
      : spec.face === "shock"
        ? `<ellipse cx="100" cy="102" rx="6" ry="8" fill="#1A1410"/>`
        : spec.face === "grin" || spec.face === "smug"
          ? `<path d="M86 94 Q100 ${spec.face === "smug" ? 98 : 104} 114 ${spec.face === "smug" ? 90 : 94}" stroke="#1A1410" stroke-width="2.5" fill="none"/>`
          : "";
  return extra + teeth;
}

/**
 * A flat front view of a rat, in the house style: thick outlines, flat colours. Stands in for an
 * AI sketch in the studio's demo.
 */
export function renderRatSvg(spec: RatSpec): string {
  const c = spec.colors;
  const o = c.outline;
  const head = spec.coat === "hooded" ? c.patch : c.fur;
  const ear = 22 * spec.body.ears;
  const prop =
    spec.prop === "cheese"
      ? `<path d="M84 140 L118 128 L118 148 Z" fill="#F5C542" stroke="${o}" stroke-width="2.5"/><circle cx="108" cy="139" r="3" fill="#C99A1E"/>`
      : spec.prop === "crumb"
        ? `<ellipse cx="100" cy="140" rx="12" ry="8" fill="#C98B4A" stroke="${o}" stroke-width="2.5"/>`
        : spec.prop === "fork"
          ? `<path d="M118 175 L118 95 M112 95 L112 108 M118 95 L118 108 M124 95 L124 108 M112 108 L124 108" stroke="#9AA2AE" stroke-width="3" fill="none"/>`
          : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="400" height="400">
<rect width="200" height="200" fill="#EDE8E0"/>
<path d="M128 170 Q175 175 172 140 Q170 118 186 112" stroke="${c.skin}" stroke-width="6" fill="none" stroke-linecap="round"/>
<ellipse cx="100" cy="148" rx="${38 * spec.body.girth}" ry="42" fill="${c.fur}" stroke="${o}" stroke-width="3"/>
<ellipse cx="100" cy="152" rx="${24 * spec.body.girth}" ry="26" fill="${c.belly}"/>
<ellipse cx="80" cy="188" rx="12" ry="6" fill="${c.skin}" stroke="${o}" stroke-width="2.5"/><ellipse cx="120" cy="188" rx="12" ry="6" fill="${c.skin}" stroke="${o}" stroke-width="2.5"/>
<circle cx="${100 - 30}" cy="40" r="${ear}" fill="${head}" stroke="${o}" stroke-width="3"/><circle cx="${100 - 30}" cy="40" r="${ear * 0.66}" fill="${c.skin}"/>
<circle cx="${100 + 30}" cy="40" r="${ear}" fill="${head}" stroke="${o}" stroke-width="3"/><circle cx="${100 + 30}" cy="40" r="${ear * 0.66}" fill="${c.skin}"/>
<ellipse cx="100" cy="70" rx="34" ry="30" fill="${head}" stroke="${o}" stroke-width="3"/>
<ellipse cx="100" cy="88" rx="16" ry="12" fill="${head}" stroke="${o}" stroke-width="3"/>
<circle cx="100" cy="86" r="6" fill="${c.skin}" stroke="${o}" stroke-width="2"/>
<path d="M84 88 L58 82 M84 92 L58 94 M116 88 L142 82 M116 92 L142 94" stroke="${o}" stroke-width="1.5"/>
${eyes(spec)}
${mouth(spec)}
${HATS[spec.hat]}
${spec.scarf ? `<path d="M72 104 Q100 116 128 104 L124 112 Q100 122 76 112 Z" fill="${spec.scarf}" stroke="${o}" stroke-width="2"/>` : ""}
${prop}
<circle cx="86" cy="140" r="6" fill="${c.skin}" stroke="${o}" stroke-width="2"/><circle cx="114" cy="140" r="6" fill="${c.skin}" stroke="${o}" stroke-width="2"/>
</svg>`;
}
