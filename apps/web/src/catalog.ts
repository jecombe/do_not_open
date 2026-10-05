/**
 * Contact sheet of the cat kit, for reviewing models without going through a mint.
 *
 *   /catalog.html?set=breeds            every breed (default)
 *   /catalog.html?set=moods&breed=void  every mood on one breed
 *   /catalog.html?set=poses | accessories | states | golden | vices
 *   /catalog.html?set=rats&from=1          sixteen studio rats from seed 1
 *   /catalog.html?set=rat-eyes&seed=7      every rat eye (or rat-faces, rat-hats, rat-props,
 *                                          rat-poses, rat-coats) on one rat
 *   &size=64                            marketplace thumbnail size
 *   &t=1.5                              freeze time, for comparable screenshots
 *   &dist=2.5&height=3&yaw=-1            camera distance and height, model turn
 */
import { Color, DirectionalLight, Group, HemisphereLight, PerspectiveCamera, Scene, WebGLRenderer } from "three";
import { spec as game, type TraitKey } from "@dno/game-spec";
import { buildCatSpec, buildRatSpec, encodeSeed, type CatSpec, type RatSpec } from "@dno/generator";
import { createCat, createRat } from "@dno/scene";

const params = new URLSearchParams(location.search);
const set = params.get("set") ?? "breeds";
const frozen = params.has("t") ? Number(params.get("t")) : null;
const cell = Number(params.get("size") ?? 0);

const variants = (key: TraitKey) => game.traits.find((t) => t.key === key)!.variants.map((v) => v.key);

/** Lowest roll that lands on a variant. */
function rollFor(key: TraitKey, variant: string): number {
  let roll = 0;
  for (const v of game.traits.find((t) => t.key === key)!.variants) {
    if (v.key === variant) return roll;
    roll += v.width;
  }
  throw new Error(`no ${key} "${variant}"`);
}

interface Pick {
  breed?: string;
  mood?: string;
  accessory?: string;
  state?: string;
  affection?: number;
  cosmetic?: number;
}

function specFor(pick: Pick): CatSpec {
  const state = game.states.findIndex((s) => s.key === (pick.state ?? "alive"));
  const seed = encodeSeed({
    stateRoll: state === 0 ? 0 : game.states[state - 1]!.rollBelow,
    rolls: {
      breed: rollFor("breed", pick.breed ?? params.get("breed") ?? "tabby"),
      mood: rollFor("mood", pick.mood ?? params.get("mood") ?? "unbothered"),
      accessory: rollFor("accessory", pick.accessory ?? params.get("accessory") ?? "none"),
      brokenThing: 0,
      room: 0,
    },
    cosmetic: pick.cosmetic ?? 1,
  });
  return buildCatSpec({ seed, affection: pick.affection ?? 0 });
}

const moods = variants("mood");
const SETS: Record<string, () => [string, Pick][]> = {
  breeds: () => variants("breed").map((breed, i) => [breed, { breed, mood: params.get("mood") ?? moods[i % moods.length]! }]),
  moods: () => moods.map((mood) => [mood, { mood }]),
  // Every pose: four moods reach four of them, sleep reaches the fifth.
  poses: () => [["sit", { mood: "judging" }], ["loaf", { mood: "smug" }], ["crouch", { mood: "zoomies" }], ["float", { mood: "enlightened" }], ["curl", { state: "asleep" }]],
  accessories: () => variants("accessory").map((accessory) => [accessory, { accessory }]),
  golden: () => variants("accessory").map((accessory) => [accessory, { accessory, affection: 99 }]),
  states: () => game.states.map((s) => [s.key, { state: s.key }]),
  // Cosmetic bytes 42 and 13 are the first that give each vice.
  vices: () => variants("breed").flatMap((breed) => [["stoned", 42], ["drunk", 13]].map(([vice, cosmetic]): [string, Pick] => [`${breed} ${vice}`, { breed, cosmetic: cosmetic as number }])),
  all: () => variants("breed").flatMap((breed) => moods.map((mood, i): [string, Pick] => [`${breed} ${mood}`, { breed, mood, accessory: variants("accessory")[(i + breed.length) % 10]! }])),
};

/** One rat with a trait forced; colours follow the coat, so a coat is found by seed instead. */
const ratSeed = BigInt(params.get("seed") ?? 1);
const ratWith = (change: Partial<RatSpec>): RatSpec => ({ ...buildRatSpec(ratSeed), ...change });
function ratOfCoat(coat: RatSpec["coat"]): RatSpec {
  for (let seed = ratSeed; ; seed++) {
    const rat = buildRatSpec(seed);
    if (rat.coat === coat) return rat;
  }
}
const RAT_SETS: Record<string, () => [string, RatSpec][]> = {
  rats: () => Array.from({ length: Number(params.get("n") ?? 16) }, (_, i) => BigInt(params.get("from") ?? 1) + BigInt(i)).map((seed) => [`rat ${seed}`, buildRatSpec(seed)]),
  "rat-eyes": () => (["dots", "big", "derp", "sleepy", "shades"] as const).map((eyes) => [eyes, ratWith({ eyes, prop: "none" })]),
  "rat-faces": () => (["grin", "teeth", "tongue", "smug", "shock"] as const).map((face) => [face, ratWith({ face, prop: "none", hat: "none" })]),
  "rat-hats": () => (["none", "party", "beanie", "crown", "tophat", "chef"] as const).map((hat) => [hat, ratWith({ hat })]),
  "rat-props": () => (["none", "cheese", "crumb", "fork"] as const).map((prop) => [prop, ratWith({ prop })]),
  "rat-poses": () => (["sit", "stand", "sniff"] as const).flatMap((pose) => [[pose, ratWith({ pose, prop: "cheese" })], [`${pose}, empty-handed`, ratWith({ pose, prop: "none" })]] as [string, RatSpec][]),
  "rat-coats": () => (["grey", "brown", "white", "black", "caramel", "patched", "hooded"] as const).map((coat) => [coat, ratOfCoat(coat)]),
};

const only = params.get("only")?.split(",");
type Entry = [string, { cat: Pick } | { rat: RatSpec }];
const entries: Entry[] = (
  RAT_SETS[set] ? RAT_SETS[set]!().map(([label, rat]): Entry => [label, { rat }]) : (SETS[set] ?? SETS.breeds!)().map(([label, cat]): Entry => [label, { cat }])
).filter(([label]) => !only || only.includes(label));
const canvas = document.getElementById("view") as HTMLCanvasElement;
const labels = document.getElementById("labels") as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setScissorTest(true);

const cats: { label: string; scene: Scene; cat: { group: Group; update(t: number): void; ready: Promise<void> } }[] = entries.map(([label, what]) => {
  const s = "cat" in what ? specFor(what.cat) : null;
  const scene = new Scene();
  scene.background = new Color(params.get("bg") ? `#${params.get("bg")}` : (s?.room.wall ?? "#3A2E24"));
  scene.add(new HemisphereLight("#AEB9C9", "#2A2018", 1.1));
  const sun = new DirectionalLight("#FFE9CC", 1.5);
  sun.position.set(3, 6, 5);
  scene.add(sun);
  const cat = s ? createCat(s) : createRat((what as { rat: RatSpec }).rat);
  const turn = new Group();
  turn.rotation.y = Number(params.get("yaw") ?? -0.35);
  turn.add(cat.group);
  scene.add(turn);
  return { label, scene, cat };
});

const camera = new PerspectiveCamera(24, 1, 0.1, 50);
camera.position.set(0, Number(params.get("height") ?? 1.0), Number(params.get("dist") ?? 4.3));
camera.lookAt(0, 0.7, 0);

function frame(ms: number) {
  const dpr = Math.min(window.devicePixelRatio, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    labels.width = w;
    labels.height = h;
  }
  const cols = cell ? Math.floor(w / cell) : Math.ceil(Math.sqrt((entries.length * w) / h));
  const size = cell || Math.min(w / cols, h / Math.ceil(entries.length / cols));
  const ctx = labels.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);
  ctx.font = "600 13px system-ui";
  renderer.setScissor(0, 0, w, h);
  renderer.setViewport(0, 0, w, h);
  renderer.setClearColor("#17130F");
  renderer.clear();
  const t = frozen ?? ms / 1000;
  cats.forEach(({ label, scene, cat }, i) => {
    const x = (i % cols) * size;
    const y = Math.floor(i / cols) * size;
    renderer.setViewport(x, h - y - size, size, size);
    renderer.setScissor(x, h - y - size, size, size);
    cat.update(t);
    renderer.render(scene, camera);
    if (size >= 120) {
      ctx.fillStyle = "#17130F";
      ctx.fillRect(x + 6, y + 6, ctx.measureText(label).width + 10, 20);
      ctx.fillStyle = "#E9DFC8";
      ctx.fillText(label, x + 11, y + 20);
    }
  });
  requestAnimationFrame(frame);
}

void Promise.all(cats.map((c) => c.cat.ready)).then(() => document.body.setAttribute("data-ready", "1"));
requestAnimationFrame(frame);
