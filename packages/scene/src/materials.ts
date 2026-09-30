import {
  AdditiveBlending,
  BackSide,
  BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
  FrontSide,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  NearestFilter,
  Object3D,
  RedFormat,
  ShaderMaterial,
} from "three";

let ramp: DataTexture | null = null;

/** Four-step cel shading ramp shared by every toon material. */
export function toonRamp(): DataTexture {
  if (!ramp) {
    ramp = new DataTexture(new Uint8Array([70, 130, 200, 255]), 4, 1, RedFormat);
    ramp.minFilter = ramp.magFilter = NearestFilter;
    ramp.needsUpdate = true;
  }
  return ramp;
}

export function toon(color: string, extra: Partial<ConstructorParameters<typeof MeshToonMaterial>[0]> = {}): MeshToonMaterial {
  return new MeshToonMaterial({ color, gradientMap: toonRamp(), ...extra });
}

/**
 * Inverted-hull outline: back faces pushed out along the normal. Cheaper than a
 * post-process outline pass, works with instancing and in headless renders.
 */
export function outlineMaterial(color: string, thickness: number): MeshBasicMaterial {
  const m = new MeshBasicMaterial({ color, side: BackSide });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.outlineThickness = { value: thickness };
    shader.vertexShader =
      "uniform float outlineThickness;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\ntransformed += normalize(normal) * outlineThickness;",
      );
  };
  return m;
}

/** The colours a kit mesh paints over its zone masks. */
export interface ZonePalette {
  base: string;
  secondary: string;
  tertiary: string;
  belly: string;
  skin: string;
}

/**
 * Toon material for kit meshes. The mesh carries one smooth mask per colour zone in its
 * `zone` attribute (secondary, tertiary, belly, skin); thresholding the masks per pixel
 * gives flat colours with clean edges from very few vertices, and no textures.
 */
export function zoneToon(palette: ZonePalette): MeshToonMaterial {
  const m = toon(palette.base);
  const uniforms = {
    zoneSecondary: { value: new Color(palette.secondary) },
    zoneTertiary: { value: new Color(palette.tertiary) },
    zoneBelly: { value: new Color(palette.belly) },
    zoneSkin: { value: new Color(palette.skin) },
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader =
      "attribute vec4 zone;\nvarying vec4 vZone;\n" +
      shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\nvZone = zone;");
    shader.fragmentShader =
      "uniform vec3 zoneSecondary;\nuniform vec3 zoneTertiary;\nuniform vec3 zoneBelly;\nuniform vec3 zoneSkin;\nvarying vec4 vZone;\n" +
      shader.fragmentShader.replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
        vec4 zoneEdge = max(fwidth(vZone), vec4(0.0005));
        vec4 zoneIn = smoothstep(0.5 - zoneEdge, 0.5 + zoneEdge, vZone);
        diffuseColor.rgb = mix(diffuseColor.rgb, zoneBelly, zoneIn.b);
        diffuseColor.rgb = mix(diffuseColor.rgb, zoneSecondary, zoneIn.r);
        diffuseColor.rgb = mix(diffuseColor.rgb, zoneTertiary, zoneIn.g);
        diffuseColor.rgb = mix(diffuseColor.rgb, zoneSkin, zoneIn.a);`,
      );
  };
  m.customProgramCacheKey = () => "zoneToon";
  return m;
}

/** Translucent fresnel material for ghost cats. `uTime` is advanced by the owner. */
export function ghostMaterial(color: string, opacity: number): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    uniforms: { uColor: { value: new Color(color) }, uOpacity: { value: opacity }, uTime: { value: 0 }, uFloor: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vHeight;
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        // Slow vertical ripple so the silhouette never sits still.
        world.x += sin(world.y * 6.0 + uTime * 1.7) * 0.012;
        world.z += cos(world.y * 5.0 + uTime * 1.3) * 0.012;
        vHeight = world.y;
        vWorld = world.xyz;
        vec4 mv = viewMatrix * world;
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uTime;
      uniform float uFloor;
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vHeight;
      varying vec3 vWorld;
      void main() {
        float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.0);
        float scan = 0.85 + 0.15 * sin(vHeight * 40.0 - uTime * 3.0);
        vec3 spectral = vec3(0.49, 0.89, 0.82);
        vec3 col = mix(uColor * 0.55, spectral, rim);
        // The lower body frays into drifting wisps instead of ending at the floor.
        float wisp = sin(vWorld.x * 23.0 + uTime * 1.9) * sin(vWorld.z * 19.0 - uTime * 1.4) * 0.5 + 0.5;
        float ground = smoothstep(uFloor + 0.12, uFloor + 0.7, vHeight + wisp * 0.22);
        gl_FragColor = vec4(col * scan, (0.22 + rim * 0.9) * uOpacity * ground);
      }`,
  });
}

export type RenderMode = "toon" | "ghost";

/** Builds meshes with a consistent shading mode and collects what needs disposing. */
export class Kit {
  readonly materials: Material[] = [];
  readonly geometries: BufferGeometry[] = [];
  readonly ghostMaterials: ShaderMaterial[] = [];
  private readonly cache = new Map<string, Material>();
  private readonly outlines = new Map<string, MeshBasicMaterial>();

  constructor(
    readonly mode: RenderMode,
    readonly outlineColor: string,
    readonly opacity = 1,
    readonly outlineThickness = 0.012,
  ) {}

  /** Lit material in the current mode. */
  fur(color: string): Material {
    const key = `fur:${color}`;
    let m = this.cache.get(key);
    if (!m) {
      if (this.mode === "ghost") {
        const g = ghostMaterial(color, this.opacity);
        this.ghostMaterials.push(g);
        m = g;
      } else {
        m = toon(color);
      }
      this.track(key, m);
    }
    return m;
  }

  /** Lit material for a kit mesh with colour zones. Ghosts keep a single spectral tint. */
  zoned(palette: ZonePalette): Material {
    if (this.mode === "ghost") return this.fur(palette.base);
    const key = `zone:${palette.base}:${palette.secondary}:${palette.tertiary}:${palette.belly}:${palette.skin}`;
    let m = this.cache.get(key);
    if (!m) {
      m = zoneToon(palette);
      this.track(key, m);
    }
    return m;
  }

  /** Unlit flat colour. Used for eyes and glowing bits. */
  flat(color: string, opts: { doubleSide?: boolean; opacity?: number } = {}): Material {
    const opacity = (opts.opacity ?? 1) * (this.mode === "ghost" ? 0.8 : 1);
    const key = `flat:${color}:${opts.doubleSide ? 1 : 0}:${opacity}`;
    let m = this.cache.get(key);
    if (!m) {
      m = new MeshBasicMaterial({
        color,
        side: opts.doubleSide ? DoubleSide : FrontSide,
        transparent: opacity < 1,
        opacity,
        depthWrite: opacity >= 1,
      });
      this.track(key, m);
    }
    return m;
  }

  private track(key: string, m: Material) {
    this.cache.set(key, m);
    this.materials.push(m);
  }

  /**
   * Adds a mesh to `parent`. Outlined by default in toon mode. A `shared` geometry
   * belongs to the asset library and is left alone on dispose.
   */
  add(
    parent: Object3D,
    geometry: BufferGeometry,
    material: Material,
    opts: { outline?: boolean; thickness?: number; shadow?: boolean; shared?: boolean } = {},
  ): Mesh {
    if (!opts.shared) this.geometries.push(geometry);
    const mesh = new Mesh(geometry, material);
    mesh.castShadow = opts.shadow ?? this.mode === "toon";
    parent.add(mesh);
    if (this.mode === "toon" && (opts.outline ?? true)) {
      const thickness = opts.thickness ?? this.outlineThickness;
      const key = `${this.outlineColor}:${thickness}`;
      let om = this.outlines.get(key);
      if (!om) {
        om = outlineMaterial(this.outlineColor, thickness);
        this.outlines.set(key, om);
        this.materials.push(om);
      }
      mesh.add(new Mesh(geometry, om));
    }
    return mesh;
  }

  dispose() {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
