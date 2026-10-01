/**
 * Renders token metadata: <id>.json, <id>.png (the 3D scene, drawn offscreen in headless
 * Chrome) and <id>.svg (a flat fallback that needs no GPU).
 *
 *   pnpm --filter @dno/web render:metadata                       five fixture cats and a sealed box
 *   pnpm --filter @dno/web render:metadata --source sepolia      every minted token, read from the chain
 *   pnpm --filter @dno/web render:metadata --source sepolia --tokens 0-9
 *   pnpm --filter @dno/web render:metadata --svg-only            no browser needed
 *
 * Options: --out <dir> (default out/metadata), --base-uri <prefix> for the "image" field,
 * CHROME_PATH to point at a specific Chrome or Chromium binary.
 *
 * A sealed token's files depend on its token id and on public chain facts only. Nothing
 * here can read a sealed box, so nothing here can leak one.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSepoliaNodeAdapter } from "@dno/chain-adapter/node";
import {
  buildBoxSpec,
  buildCatSpec,
  FIXTURE_SEEDS,
  renderBoxSvg,
  renderCatSvg,
  revealedMetadata,
  sealedMetadata,
  type CatSpec,
  type PublicBoxFacts,
} from "@dno/generator";

interface Job {
  tokenId: number;
  cat: CatSpec | null;
  facts: PublicBoxFacts;
}

const root = resolve(__dirname, "..");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};

function range(text: string, max: number): number[] {
  if (!text) return Array.from({ length: max }, (_, i) => i);
  return text.split(",").flatMap((part) => {
    const [from, to] = part.split("-").map(Number) as [number, number | undefined];
    return Array.from({ length: (to ?? from) - from + 1 }, (_, i) => from + i);
  });
}

async function jobs(): Promise<Job[]> {
  if (option("source", "fixtures") === "fixtures") {
    const cats: Job[] = FIXTURE_SEEDS.map(({ seed }, tokenId) => ({ tokenId, cat: buildCatSpec({ seed }), facts: {} }));
    return [...cats, { tokenId: cats.length, cat: null, facts: {} }];
  }
  const chain = createSepoliaNodeAdapter({ rpcUrl: process.env.SEPOLIA_RPC_URL });
  const { totalMinted } = await chain.collection();
  const out: Job[] = [];
  for (const tokenId of range(option("tokens", ""), totalMinted)) {
    const box = await chain.box(tokenId);
    // The weigh-in lives in the Pantry; a network without one still renders its cats.
    const weighIn = box.revealed ? await chain.boxPantry(tokenId).then((p) => p.weighIn, () => null) : null;
    out.push({
      tokenId,
      cat: box.revealed ? buildCatSpec({ seed: box.revealed.seed, affection: box.revealed.affection, weighIn: weighIn ?? undefined }) : null,
      facts: { feeds: box.feeds, duelsWon: box.wins, vetCertified: box.aliveCheck === "alive", entangledWith: box.partner },
    });
  }
  return out;
}

async function main() {
  const out = resolve(root, option("out", "out/metadata"));
  const baseUri = option("base-uri", "");
  const svgOnly = flag("svg-only");
  mkdirSync(out, { recursive: true });

  const list = await jobs();
  console.log(`${list.length} token(s) -> ${out}`);

  let shoot: ((job: Job) => Promise<Buffer>) | null = null;
  let close = async () => {};
  if (!svgOnly) {
    const { createServer } = await import("vite");
    const { chromium } = await import("playwright-core");
    const server = await createServer({ root, configFile: resolve(root, "vite.config.ts"), server: { port: 0 }, logLevel: "error" });
    await server.listen();
    const url = server.resolvedUrls!.local[0]!;
    const browser = await chromium.launch({
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }),
      // Software GL is enough for one still frame, and works on a machine with no GPU.
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    });
    const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
    shoot = async ({ tokenId, cat }) => {
      const weighed = cat?.weight ? `&weight=${cat.weight.weight}&sick=${cat.weight.sick ? 1 : 0}${cat.weight.disease ? `&disease=${cat.weight.disease}` : ""}` : "";
      const query = cat ? `token=${tokenId}&seed=${cat.seed}&affection=${cat.affection}${weighed}` : `token=${tokenId}`;
      await page.goto(`${url}render.html?${query}`);
      await page.waitForFunction("window.__dnoRender || window.__dnoRenderError", undefined, { timeout: 60_000 });
      const error = await page.evaluate("window.__dnoRenderError");
      if (error) throw new Error(`token ${tokenId}: ${error}`);
      const dataUrl = (await page.evaluate("window.__dnoRender")) as string;
      return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
    };
    close = async () => {
      await browser.close();
      await server.close();
    };
  }

  try {
    for (const job of list) {
      const { tokenId, cat, facts } = job;
      writeFileSync(resolve(out, `${tokenId}.svg`), cat ? renderCatSvg(cat) : renderBoxSvg(buildBoxSpec(tokenId)));
      if (shoot) writeFileSync(resolve(out, `${tokenId}.png`), await shoot(job));
      const image = `${baseUri}${tokenId}.${shoot ? "png" : "svg"}`;
      const metadata = cat ? revealedMetadata(tokenId, cat, image, facts) : sealedMetadata(tokenId, image, facts);
      writeFileSync(resolve(out, `${tokenId}.json`), JSON.stringify(metadata, null, 2) + "\n");
      console.log(`  ${tokenId}: ${cat ? `${cat.state} ${cat.traits.breed.name}, ${cat.rarity.tierName}` : "sealed"}`);
    }
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
