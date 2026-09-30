import { AdditiveBlending, Color, CylinderGeometry, Mesh, Object3D, ShaderMaterial, SphereGeometry, MeshBasicMaterial, Vector3, Group } from "three";

export const SPECTRAL = "#7DE3D0";

/**
 * The entanglement thread: a glowing strand sagging between two boxes, with pulses
 * travelling along it in both directions. One mesh; the curve is computed in the
 * vertex shader from the two end points, so it follows a shaking box for free.
 */
export class EntanglementThread {
  readonly group = new Group();
  private readonly material: ShaderMaterial;
  private readonly knots: Mesh[] = [];
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly side = new Vector3();
  private appear = 0;

  /**
   * @param from object the thread starts at (its local `anchor` point)
   * @param to   object the thread ends at
   * @param anchor point in each object's local space, e.g. the centre of a box lid
   */
  constructor(
    private readonly from: Object3D,
    private readonly to: Object3D,
    private readonly anchor = new Vector3(0, 0.95, 0),
    color = SPECTRAL,
  ) {
    const geo = new CylinderGeometry(1, 1, 1, 8, 48, true);
    geo.translate(0, 0.5, 0);
    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        uA: { value: this.a },
        uB: { value: this.b },
        uSide: { value: this.side },
        uColor: { value: new Color(color) },
        uTime: { value: 0 },
        uAppear: { value: 0 },
        uRadius: { value: 0.016 },
      },
      vertexShader: /* glsl */ `
        uniform vec3 uA;
        uniform vec3 uB;
        uniform vec3 uSide;
        uniform float uTime;
        uniform float uRadius;
        varying float vT;
        void main() {
          vT = position.y;
          vec3 centre = mix(uA, uB, vT);
          float belly = sin(vT * 3.14159);
          // Lifts into an arc between the boxes and breathes a little.
          centre.y += belly * (0.32 + 0.04 * sin(uTime * 1.3));
          centre += uSide * belly * 0.05 * sin(uTime * 2.1 + vT * 6.0);
          vec3 p = centre + (uSide * position.x + vec3(0.0, 1.0, 0.0) * position.z) * uRadius * (0.7 + 0.6 * belly);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uTime;
        uniform float uAppear;
        varying float vT;
        void main() {
          // The strand grows from both ends and meets in the middle.
          float reach = min(vT, 1.0 - vT) * 2.0;
          if (reach > uAppear) discard;
          float pulseA = pow(0.5 + 0.5 * sin(vT * 22.0 - uTime * 5.0), 10.0);
          float pulseB = pow(0.5 + 0.5 * sin(vT * 17.0 + uTime * 3.7), 10.0);
          float glow = 0.45 + pulseA + pulseB;
          gl_FragColor = vec4(uColor * glow, min(1.0, glow) * 0.9);
        }`,
    });
    const strand = new Mesh(geo, this.material);
    strand.frustumCulled = false;
    this.group.add(strand);

    const knotGeo = new SphereGeometry(0.05, 12, 10);
    const knotMat = new MeshBasicMaterial({ color });
    for (let i = 0; i < 2; i++) {
      const knot = new Mesh(knotGeo, knotMat);
      this.knots.push(knot);
      this.group.add(knot);
    }
  }

  /** Call every frame. `dt` drives the grow-in animation. */
  update(time: number, dt: number): void {
    this.appear = Math.min(1, this.appear + dt / 1.1);
    this.a.copy(this.anchor);
    this.from.localToWorld(this.a);
    this.b.copy(this.anchor);
    this.to.localToWorld(this.b);
    this.side.subVectors(this.b, this.a).cross(new Vector3(0, 1, 0)).normalize();
    this.material.uniforms.uTime!.value = time;
    this.material.uniforms.uAppear!.value = this.appear;
    this.knots[0]!.position.copy(this.a);
    this.knots[1]!.position.copy(this.b);
    const beat = 1 + 0.25 * Math.sin(time * 5);
    this.knots[0]!.scale.setScalar(beat);
    this.knots[1]!.scale.setScalar(2 - beat);
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as Mesh;
      m.geometry?.dispose();
      (m.material as ShaderMaterial | undefined)?.dispose?.();
    });
  }
}
