import "@fontsource/stardos-stencil/700.css";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/700.css";
import { Color, DirectionalLight, FogExp2, HemisphereLight, Mesh, MeshLambertMaterial, PCFSoftShadowMap, PerspectiveCamera, PlaneGeometry, PointLight, Scene, WebGLRenderer } from "three";
import { buildBoxSpec, buildCatSpec } from "@dno/generator";
import { BENCH_HEIGHT, createBox, createDepot, createDiorama, DEPOT_COLORS, QUALITY } from "@dno/scene";

/**
 * One still frame for token metadata, drawn with the same builders as the app.
 *
 *   /render.html?token=12                       a sealed box (token id only)
 *   /render.html?token=12&seed=0x..&affection=3 an opened one
 *
 * The result is left on `window.__dnoRender` as a PNG data URL for the script that drives
 * the page (scripts/render-metadata.cts).
 */
declare global {
  interface Window {
    __dnoRender?: string;
    __dnoRenderError?: string;
  }
}

const SIZE = 1024;

async function render() {
  const params = new URLSearchParams(location.search);
  const tokenId = Number(params.get("token") ?? 0);
  const seed = params.get("seed");

  // Box labels are drawn on a canvas with these fonts.
  await Promise.all(['700 64px "Stardos Stencil"', '500 32px "Barlow Condensed"', '700 64px "Barlow Condensed"'].map((f) => document.fonts.load(f)));

  const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  document.body.append(renderer.domElement);

  const scene = new Scene();
  scene.background = new Color(DEPOT_COLORS.shadow);
  const camera = new PerspectiveCamera(34, 1, 0.1, 60);

  if (seed) {
    const cat = buildCatSpec({ seed, affection: Number(params.get("affection") ?? 0) });
    const diorama = createDiorama(cat);
    scene.fog = new FogExp2(DEPOT_COLORS.shadow, 0.05);
    scene.add(new HemisphereLight("#AEB9C9", "#2A2018", 1.1));
    const key = new DirectionalLight("#FFE9CC", 1.5);
    key.position.set(3, 6, 5);
    const lamp = new PointLight(cat.room.light, 9, 6);
    lamp.position.set(0.6, 1.9, 1.6);
    const floor = new Mesh(new PlaneGeometry(60, 60), new MeshLambertMaterial({ color: DEPOT_COLORS.concrete }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.081;
    scene.add(key, lamp, floor, diorama.group);
    diorama.update(1);
    camera.position.set(0.5, 1.3, 3.5);
    camera.lookAt(0, 0.66, 0);
  } else {
    const depot = createDepot(QUALITY.high);
    const box = createBox(buildBoxSpec(tokenId));
    depot.benchAnchor.add(box.group);
    scene.fog = new FogExp2(DEPOT_COLORS.shadow, 0.06);
    scene.add(depot.group);
    depot.update(1);
    camera.position.set(2.1, BENCH_HEIGHT + 1.75, 3.5);
    camera.lookAt(0, BENCH_HEIGHT + 0.42, 0);
  }

  // Twice: the first frame compiles shaders and fills the shadow map.
  renderer.render(scene, camera);
  renderer.render(scene, camera);
  window.__dnoRender = renderer.domElement.toDataURL("image/png");
}

render().catch((error) => {
  window.__dnoRenderError = String(error);
});
