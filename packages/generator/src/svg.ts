import type { BoxSpec } from "./boxSpec";
import { GOLD, type CatSpec } from "./catSpec";

/**
 * Flat SVG stand-ins for the 3D renders: what a marketplace shows when the PNG is
 * missing, and what any environment without a GPU can produce. Pure strings, no DOM.
 * They follow the same specs as the 3D scene, so they never disagree with it.
 */

const SIZE = 1000;
const SPECTRAL = "#7DE3D0";

const svg = (body: string, background: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">` +
  `<rect width="${SIZE}" height="${SIZE}" fill="${background}"/>${body}</svg>`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** The sealed box. Reads the token id and nothing else, like the 3D one. */
export function renderBoxSvg(box: BoxSpec): string {
  const stampAngle = (box.stampRotation * 180) / Math.PI;
  const tapeX = 500 + box.tapeOffset * 520;
  const dents = box.dents
    .map((d) => `<ellipse cx="${250 + d.u * 500}" cy="${430 + d.v * 380}" rx="${d.radius * 420}" ry="${d.radius * 300}" fill="#1A1410" opacity="0.08"/>`)
    .join("");
  const bars = Array.from({ length: 26 }, (_, i) => {
    const w = 2 + ((box.noiseSeed >>> (i % 24)) & 3);
    return `<rect x="${14 + i * 7}" y="92" width="${w}" height="40" fill="#1C1814"/>`;
  }).join("");

  return svg(
    `<ellipse cx="500" cy="850" rx="330" ry="46" fill="#000" opacity="0.45"/>
<polygon points="220,400 500,330 780,400 500,470" fill="#C99A68" stroke="#1A1410" stroke-width="6" stroke-linejoin="round"/>
<polygon points="220,400 500,470 500,860 220,760" fill="#B8895A" stroke="#1A1410" stroke-width="6" stroke-linejoin="round"/>
<polygon points="780,400 500,470 500,860 780,760" fill="#9C7148" stroke="#1A1410" stroke-width="6" stroke-linejoin="round"/>
${dents}
<polygon points="${tapeX - 40},337 ${tapeX + 40},357 ${tapeX - 240},427 ${tapeX - 320},407" fill="#D9C28A" opacity="0.93"/>
<g transform="translate(250 545) skewY(14) rotate(${(box.labelSkew * 180) / Math.PI})">
  <rect width="218" height="150" fill="#E9DFC8" stroke="#1C1814" stroke-width="3"/>
  <text x="12" y="46" font-family="Arial Narrow, Arial, sans-serif" font-weight="700" font-size="40" fill="#1C1814">${esc(box.serial)}</text>
  <text x="12" y="72" font-family="Arial Narrow, Arial, sans-serif" font-size="17" fill="#1C1814">Dock ${esc(box.dock)}, ${box.weightKg.toFixed(1)} kg, undeclared</text>
  ${bars}
</g>
<g transform="translate(${636 + box.stampOffset[0] * 120} ${650 + box.stampOffset[1] * 120}) skewY(-14) rotate(${stampAngle})" opacity="${0.9 - box.wear * 0.3}">
  <rect x="-96" y="-28" width="192" height="56" fill="none" stroke="#C2261D" stroke-width="6"/>
  <text y="11" text-anchor="middle" font-family="Stencil, Impact, Arial Black, sans-serif" font-weight="700" font-size="28" fill="#C2261D">DO NOT OPEN</text>
</g>`,
    "#17130F",
  );
}

function accessorySvg(cat: CatSpec): string {
  const c = cat.accessory.golden ? GOLD : cat.accessory.color;
  const o = `stroke="${cat.body.outline}" stroke-width="5" stroke-linejoin="round"`;
  switch (cat.accessory.key) {
    case "bellCollar":
      return `<path d="M410 500 Q500 545 590 500 L590 522 Q500 568 410 522 Z" fill="${c}" ${o}/><circle cx="500" cy="556" r="20" fill="${GOLD}" ${o}/>`;
    case "bowTie":
      return `<path d="M500 530 L440 500 L440 562 Z M500 530 L560 500 L560 562 Z" fill="${c}" ${o}/><circle cx="500" cy="530" r="12" fill="${c}" ${o}/>`;
    case "bandana":
      return `<path d="M405 500 Q500 540 595 500 L500 610 Z" fill="${c}" ${o}/>`;
    case "sunglasses":
      return `<path d="M400 372 h88 v34 q-44 30 -88 0 Z M512 372 h88 v34 q-44 30 -88 0 Z" fill="${c}" ${o}/><path d="M488 380 h24" ${o} fill="none"/>`;
    case "partyHat":
      return `<path d="M450 262 L500 120 L550 262 Z" fill="${c}" ${o}/><circle cx="500" cy="118" r="16" fill="#FFF3B0" ${o}/>`;
    case "monocle":
      return `<circle cx="556" cy="392" r="40" fill="#FFFFFF" fill-opacity="0.18" stroke="${c}" stroke-width="8"/><path d="M590 412 Q620 480 600 560" fill="none" stroke="${c}" stroke-width="4"/>`;
    case "wizardHat":
      return `<path d="M400 268 L520 60 L600 268 Z" fill="${c}" ${o}/><ellipse cx="500" cy="268" rx="150" ry="24" fill="${c}" ${o}/><circle cx="505" cy="190" r="12" fill="${GOLD}"/>`;
    case "crown":
      return `<path d="M420 268 L420 190 L460 232 L500 170 L540 232 L580 190 L580 268 Z" fill="${c}" ${o}/>`;
    case "halo":
      return `<ellipse cx="500" cy="196" rx="92" ry="20" fill="none" stroke="${c}" stroke-width="12"/>`;
    default:
      return "";
  }
}

function eyesSvg(cat: CatSpec): string {
  const asleep = cat.state === "asleep";
  const shape = asleep ? "closed" : cat.face.eyeShape;
  return [
    { x: 444, color: cat.face.eyeColorLeft },
    { x: 556, color: cat.face.eyeColorRight },
  ]
    .map(({ x, color }) => {
      if (shape === "closed") return `<path d="M${x - 26} 392 Q${x} 410 ${x + 26} 392" fill="none" stroke="${cat.body.outline}" stroke-width="7" stroke-linecap="round"/>`;
      if (shape === "happy") return `<path d="M${x - 26} 400 Q${x} 372 ${x + 26} 400" fill="none" stroke="${cat.body.outline}" stroke-width="7" stroke-linecap="round"/>`;
      const ry = shape === "wide" ? 34 : shape === "round" ? 30 : shape === "half" ? 20 : 13;
      const pupil = cat.face.pupil === "slit" ? [5, ry * 0.8] : cat.face.pupil === "huge" ? [20, ry * 0.85] : [11, Math.min(11, ry * 0.8)];
      return (
        `<ellipse cx="${x}" cy="392" rx="30" ry="${ry}" fill="${color}" stroke="${cat.body.outline}" stroke-width="5"/>` +
        `<ellipse cx="${x}" cy="392" rx="${pupil[0]}" ry="${pupil[1]}" fill="#0E0B08"/>` +
        `<circle cx="${x + 9}" cy="${392 - ry * 0.4}" r="5" fill="#FFF"/>`
      );
    })
    .join("");
}

const MOUTHS: Record<string, string> = {
  neutral: "M484 452 Q500 462 516 452",
  frown: "M482 462 Q500 446 518 462",
  smirk: "M484 452 Q506 468 522 446",
  smile: "M478 450 Q500 474 522 450",
  open: "M484 450 Q500 486 516 450 Z",
};

function catSvg(cat: CatSpec, body = cat.body): string {
  const o = `stroke="${body.outline}" stroke-width="6" stroke-linejoin="round"`;
  const head = 128 * body.headSize;
  const girth = 150 * body.girth;
  const ear = 78 * body.earSize;
  const earLift = cat.face.earsFlat ? 0.45 : 1;
  const stripes =
    body.pattern === "tabby" || body.pattern === "glitch"
      ? [0, 1, 2].map((i) => `<path d="M${500 - girth * 0.72} ${640 + i * 52} q${girth * 0.72} 34 ${girth * 1.44} 0" fill="none" stroke="${i % 2 && body.pattern === "glitch" ? body.furTertiary : body.furSecondary}" stroke-width="16" stroke-linecap="round" opacity="0.85"/>`).join("")
      : body.pattern === "calico"
        ? `<circle cx="${500 - girth * 0.4}" cy="660" r="52" fill="${body.furSecondary}"/><circle cx="${500 + girth * 0.35}" cy="740" r="44" fill="${body.furTertiary}"/><path d="M${500 - head} 360 a${head} ${head} 0 0 1 ${head} -${head * 0.95} v${head * 0.7} Z" fill="${body.furSecondary}" opacity="0.9"/>`
        : "";
  const points = body.pattern === "points" ? body.furSecondary : null;

  return `
<path d="M${500 + girth * 0.8} 800 q${150 * body.tailLength} -20 ${130 * body.tailLength} -${170 * body.tailLength}" fill="none" stroke="${body.outline}" stroke-width="${46 * body.tailFluff + 12}" stroke-linecap="round"/>
<path d="M${500 + girth * 0.8} 800 q${150 * body.tailLength} -20 ${130 * body.tailLength} -${170 * body.tailLength}" fill="none" stroke="${points ?? body.furBase}" stroke-width="${46 * body.tailFluff}" stroke-linecap="round"/>
<ellipse cx="500" cy="700" rx="${girth}" ry="170" fill="${body.furBase}" ${o}/>
${body.pattern === "tuxedo" || body.pattern === "loaf" || body.pattern === "tabby" ? `<ellipse cx="500" cy="730" rx="${girth * 0.55}" ry="120" fill="${body.furBelly}"/>` : ""}
${stripes}
${body.mane ? `<ellipse cx="500" cy="520" rx="${head * 1.15}" ry="70" fill="${body.furBelly}" ${o}/>` : ""}
<ellipse cx="${500 - girth * 0.45}" cy="858" rx="52" ry="26" fill="${points ?? body.furBelly}" ${o}/>
<ellipse cx="${500 + girth * 0.45}" cy="858" rx="52" ry="26" fill="${points ?? body.furBelly}" ${o}/>
<path d="M${500 - head * 0.92} ${330} l${-ear * 0.1} ${-ear * 1.3 * earLift} l${ear * 0.95} ${ear * 0.55 * earLift} Z" fill="${points ?? body.furBase}" ${o}/>
<path d="M${500 + head * 0.92} ${330} l${ear * 0.1} ${-ear * 1.3 * earLift} l${-ear * 0.95} ${ear * 0.55 * earLift} Z" fill="${points ?? body.furBase}" ${o}/>
<ellipse cx="500" cy="395" rx="${head}" ry="${head * 0.9}" fill="${body.furBase}" ${o}/>
${body.pattern === "tuxedo" ? `<path d="M500 ${395 - head * 0.2} q${head * 0.55} ${head * 0.5} 0 ${head * 1.08} q-${head * 0.55} -${head * 0.58} 0 -${head * 1.08} Z" fill="${body.furSecondary}"/>` : ""}
${points ? `<ellipse cx="500" cy="425" rx="${head * 0.5}" ry="${head * 0.45}" fill="${points}" opacity="0.85"/>` : ""}
${eyesSvg(cat)}
<path d="M490 432 h20 l-10 12 Z" fill="${body.skin}" stroke="${body.outline}" stroke-width="3"/>
<path d="${MOUTHS[cat.face.mouth] ?? MOUTHS.neutral}" fill="${cat.face.mouth === "open" ? "#7A2A2A" : "none"}" stroke="${body.outline}" stroke-width="5" stroke-linecap="round"/>
<path d="M420 436 h-84 M422 452 l-78 22 M580 436 h84 M578 452 l78 22" stroke="#F4F0E6" stroke-width="3" stroke-linecap="round" opacity="0.85"/>
${accessorySvg(cat)}`;
}

/** A revealed cat in its room. */
export function renderCatSvg(cat: CatSpec): string {
  const room = cat.room;
  let figure = catSvg(cat);
  if (cat.render.ghost) {
    figure = `<g opacity="${Math.max(0.35, cat.render.opacity)}" style="mix-blend-mode:screen">${figure}</g><ellipse cx="500" cy="880" rx="190" ry="20" fill="${SPECTRAL}" opacity="0.25"/>`;
  } else if (cat.render.quantum && cat.altBody) {
    figure = `<g opacity="0.45" transform="translate(-34 6)">${catSvg(cat, cat.altBody)}</g><g opacity="0.45" transform="translate(34 -6)">${catSvg(cat, cat.altBody)}</g>${figure}`;
  }
  const asleep = cat.state === "asleep" ? `<text x="650" y="260" font-family="Arial, sans-serif" font-weight="700" font-size="64" fill="${room.accent}">z</text><text x="700" y="200" font-family="Arial, sans-serif" font-weight="700" font-size="44" fill="${room.accent}">z</text>` : "";

  return svg(
    `<rect y="0" width="${SIZE}" height="760" fill="${room.wall}"/>
<rect y="760" width="${SIZE}" height="240" fill="${room.floor}"/>
<rect y="748" width="${SIZE}" height="18" fill="${room.accent}"/>
<circle cx="500" cy="380" r="420" fill="${room.light}" opacity="0.22"/>
<ellipse cx="500" cy="882" rx="250" ry="30" fill="#000" opacity="0.3"/>
${figure}${asleep}`,
    room.wall,
  );
}
