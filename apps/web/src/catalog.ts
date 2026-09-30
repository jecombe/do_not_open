/**
 * Contact sheet of the cat kit, for reviewing models without going through a mint.
 *
 *   /catalog.html?set=breeds            every breed (default)
 *   /catalog.html?set=moods&breed=void  every mood on one breed
 *   /catalog.html?set=poses | accessories | states | golden | vices
 *   &size=64                            marketplace thumbnail size
 *   &t=1.5                              freeze time, for comparable screenshots
 */
import { Color, DirectionalLight, Group, HemisphereLight, PerspectiveCamera, Scene, WebGLRenderer } from "three";
import { spec as game, type TraitKey } from "@dno/game-spec";
import { buildCatSpec, encodeSeed, type CatSpec } from "@dno/generator";
import { createCat, type CatObject } from "@dno/scene";

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

const only = params.get("only")?.split(",");
const entries = (SETS[set] ?? SETS.breeds!)().filter(([label]) => !only || only.includes(label));
const canvas = document.getElementById("view") as HTMLCanvasElement;
const labels = document.getElementById("labels") as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setScissorTest(true);

const cats: { label: string; scene: Scene; cat: CatObject }[] = entries.map(([label, pick]) => {
  const s = specFor(pick);
  const scene = new Scene();
  scene.background = new Color(params.get("bg") ? `#${params.get("bg")}` : s.room.wall);
  scene.add(new HemisphereLight("#AEB9C9", "#2A2018", 1.1));
  const sun = new DirectionalLight("#FFE9CC", 1.5);
  sun.position.set(3, 6, 5);
  scene.add(sun);
  const cat = createCat(s);
  const turn = new Group();
  turn.rotation.y = Number(params.get("yaw") ?? -0.35);
  turn.add(cat.group);
  scene.add(turn);
  return { label, scene, cat };
});

const camera = new PerspectiveCamera(24, 1, 0.1, 50);
camera.position.set(0, 1.0, Number(params.get("dist") ?? 4.3));
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
