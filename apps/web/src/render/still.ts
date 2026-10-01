import { Color, DirectionalLight, FogExp2, HemisphereLight, Mesh, MeshLambertMaterial, PCFSoftShadowMap, PerspectiveCamera, PlaneGeometry, PointLight, Scene, WebGLRenderer } from "three";
import { buildBoxSpec, type CatSpec } from "@dno/generator";
import { BENCH_HEIGHT, createBox, createDepot, createDiorama, DEPOT_COLORS, QUALITY } from "@dno/scene";

/**
 * One square still, drawn with the same builders as the app: the opened cat in its room when
 * `cat` is given, the sealed box on its bench otherwise. Used for token metadata and share cards.
 * The renderer is dropped afterwards, so the canvas keeps the picture but no GPU context.
 */
export async function renderStill({ tokenId, cat, size = 1024 }: { tokenId: number; cat?: CatSpec | null; size?: number }): Promise<HTMLCanvasElement> {
  const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(size, size);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;

    const scene = new Scene();
    scene.background = new Color(DEPOT_COLORS.shadow);
    const camera = new PerspectiveCamera(34, 1, 0.1, 60);

    if (cat) {
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
      // The cat's meshes load from the kit; a canonical image must never show the placeholder.
      await diorama.ready;
      if (diorama.group.getObjectByName("placeholder")) throw new Error("cat kit failed to load");
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
    const out = document.createElement("canvas");
    out.width = out.height = size;
    out.getContext("2d")!.drawImage(renderer.domElement, 0, 0);
    return out;
  } finally {
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
