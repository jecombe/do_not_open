import { Box3, CanvasTexture, Color, DirectionalLight, HemisphereLight, Mesh, MeshBasicMaterial, PCFSoftShadowMap, PerspectiveCamera, PlaneGeometry, PointLight, Scene, SpotLight, SRGBColorSpace, Vector3, WebGLRenderer } from "three";
import { buildBoxSpec, type CatSpec } from "@dno/generator";
import { BOX_SIZE, createBox, createCat, DEPOT_COLORS, stampTexture } from "@dno/scene";

/**
 * The collection's profile picture: an opened box, flaps thrown back, a cat's head poking out
 * over the rim, and the stamp big across the front so the name reads even in a small circle.
 * Square, centred for a round crop.
 */
export async function renderAvatar({ tokenId, cat, size = 1024 }: { tokenId: number; cat: CatSpec; size?: number }): Promise<HTMLCanvasElement> {
  const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(size, size);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;

    const scene = new Scene();
    scene.background = new Color(DEPOT_COLORS.shadow);
    // A warm glow behind, like the bench lamp in the dark depot.
    const glow = document.createElement("canvas");
    glow.width = glow.height = 512;
    const g = glow.getContext("2d")!;
    const fade = g.createRadialGradient(256, 230, 10, 256, 256, 256);
    fade.addColorStop(0, "#5A3618");
    fade.addColorStop(0.22, "#2E1E10");
    fade.addColorStop(0.5, DEPOT_COLORS.shadow);
    fade.addColorStop(1, DEPOT_COLORS.shadow);
    g.fillStyle = fade;
    g.fillRect(0, 0, 512, 512);
    const glowTexture = new CanvasTexture(glow);
    glowTexture.colorSpace = SRGBColorSpace;
    const backdrop = new Mesh(new PlaneGeometry(12, 12), new MeshBasicMaterial({ map: glowTexture, depthWrite: false }));
    backdrop.position.set(0, 1.1, -3);
    scene.add(backdrop);
    const { width: W, height: H, depth: D, wall: T } = BOX_SIZE;

    // The box, opened: tape gone, flaps thrown back, the dark floor dropped to the bottom.
    const spec = buildBoxSpec(tokenId);
    const box = createBox(spec);
    box.tape.visible = false;
    // The front flap is torn off: hanging down, it would hide the stamp; standing, the cat.
    box.flaps.major[0].visible = false;
    box.flaps.major[1].rotation.x = -2.2;
    box.flaps.minor[0].rotation.z = 1.95;
    box.flaps.minor[1].rotation.z = -1.95;
    box.interior.position.y = T + 0.003;
    // The front's label and small stamp give way to one big stamp: the name has to read at 48 px.
    box.body.traverse((o) => {
      if (o instanceof Mesh && o.material instanceof MeshBasicMaterial && o.material.map && o.position.z > D / 2) o.visible = false;
    });
    const stamp = stampTexture(spec.noiseSeed, Math.min(spec.wear, 0.25));
    const big = new Mesh(
      new PlaneGeometry(W * 0.86, W * 0.86 * 0.375),
      new MeshBasicMaterial({ map: stamp, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, color: "#E8DDCB" }),
    );
    big.position.set(0, H * 0.42, D / 2 + 0.003);
    big.rotation.z = -0.05;
    box.body.add(big);
    scene.add(box.group);

    // The cat, standing inside: only the head and a little of the shoulders clear the rim.
    const kitty = createCat(cat);
    await kitty.ready;
    if (kitty.group.getObjectByName("placeholder")) throw new Error("cat kit failed to load");
    kitty.update(1);
    const bounds = new Box3().setFromObject(kitty.group);
    const dims = bounds.getSize(new Vector3());
    // Sized by its height, not its bounds: the tail would make it tiny. The head about half the box wide.
    const scale = 0.95 / dims.y * 1.19;
    kitty.group.scale.setScalar(scale);
    const tall = dims.y * scale;
    const showing = tall * 0.6 + 0.17;
    // Pushed back so the chest stays inside the cardboard; the tail end goes through the back wall, out of sight.
    kitty.group.position.set(-((bounds.min.x + bounds.max.x) / 2) * scale, H + showing - tall - bounds.min.y * scale, -bounds.max.z * scale + D / 2 - T - 0.1);
    kitty.group.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      o.castShadow = true;
      // The tail (the one mesh bent on the CPU, never frustum-culled) would curl up beside the head.
      if (!o.frustumCulled) o.visible = false;
    });
    scene.add(kitty.group);
    kitty.update(1);

    // Lit like the bench: a warm lamp from above, cool fill, a rim to cut the cat from the dark.
    scene.add(new HemisphereLight("#AEB9C9", "#2A2018", 1.0));
    const key = new SpotLight("#FFE2B0", 40, 9, 0.55, 0.5, 1.4);
    key.position.set(0.8, H + 3.2, 2.4);
    key.target.position.set(0, H * 0.7, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    scene.add(key, key.target);
    const fill = new DirectionalLight("#9FB4D8", 0.5);
    fill.position.set(-3, 2, 3);
    const rim = new PointLight("#FFB454", 6, 5);
    rim.position.set(-0.9, H + 1.1, -1.4);
    scene.add(fill, rim);

    // Framed for a round crop: the crown and the stamp both inside the circle.
    const camera = new PerspectiveCamera(30, 1, 0.1, 60);
    camera.position.set(0, H + 0.45, 3.9);
    camera.lookAt(0, H * 0.95, 0);

    renderer.render(scene, camera);
    renderer.render(scene, camera);
    const out = document.createElement("canvas");
    out.width = out.height = size;
    out.getContext("2d")!.drawImage(renderer.domElement, 0, 0);
    (stamp as CanvasTexture).dispose();
    glowTexture.dispose();
    kitty.dispose();
    box.dispose();
    return out;
  } finally {
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
