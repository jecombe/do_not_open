# DESIGN — art direction

## The idea in one line

A lost-parcel depot at night. Five thousand boxes nobody collected, each stamped
DO NOT OPEN, each with something moving inside.

The interface borrows nothing from crypto dashboards. Its vocabulary is shipping:
kraft cardboard, parcel tape, rubber stamps, thermal labels, manila tags, customs
declarations. A sealed box is dim, brown and anonymous. An opened one is a small,
bright, slightly ridiculous stage.

## Palette

| Name          | Hex       | Role                                                     |
| ------------- | --------- | -------------------------------------------------------- |
| Dock shadow   | `#17130F` | Scene background, fog. The depot is mostly this.         |
| Kraft         | `#B8895A` | Cardboard. The dominant material.                        |
| Tape          | `#D9C28A` | Parcel tape, inactive tags.                              |
| Stamp red     | `#C2261D` | The stamp. Reserved for DO NOT OPEN and primary actions. |
| Manifest      | `#E9DFC8` | Paper: every UI panel is a label or a form.              |
| Sodium        | `#FFC070` | The one warm lamp. Focus rings.                          |
| Spectral      | `#7DE3D0` | Anything that is not quite there: ghosts, quantum, links |

Red appears only on the stamp and on the button that acts on a box. Spectral never
appears in the depot until a box is opened. Room palettes (one per room trait) live in
the generator and are deliberately brighter than the depot: opening a box should feel
like a light coming on.

## Typography

| Face              | Role                                                         |
| ----------------- | ------------------------------------------------------------ |
| Stardos Stencil   | Stamps only: the wordmark, the stamp texture, stamp buttons. |
| Barlow Condensed  | Everything else. Thermal-label grotesque, 500 / 600 / 700.   |

Two families. The stencil is never used for reading text. Both are self-hosted
(`@fontsource`) because the same fonts are drawn into the canvas textures of the 3D
label and stamp, so UI and scene share one voice. Numbers are tabular.

## Layout

The scene is full-bleed. UI is paper laid on top of it, slightly rotated, never a
sidebar or a card grid.

```
+----------------------------------------------------------------+
| [DO NOT OPEN]  <- stamp as wordmark        (tag) (tag)  <- views|
|                                                                |
|                     the box, under the lamp                    |
|                                                                |
| +-- consignment slip --+                                       |
| | DNO-0042             |                                       |
| | Dock  Weight Contents|                                       |
| | [ SHAKE THE BOX ]    |                                       |
| | what you felt        |                                       |
| +----------------------+                 sound is on           |
+----------------------------------------------------------------+
```

Sealed boxes get a **consignment slip** (bottom left). Opened cats get a **declaration
of contents** (bottom right) laid out like a customs form. On phones the slip spans the
width at the bottom and the camera frames the subject in the upper half.

## Lighting

- One hanging sodium spot over the bench, with a soft shadow. It is the only warm light.
- Cold blue rim from behind the shelves, so silhouettes separate from the dark.
- Dim hemisphere fill. Exponential fog in Dock shadow, so the shelves fade out rather
  than end.
- Dust motes drift through the lamp cone only; outside it they are invisible.
- Dioramas carry their own point light in the room's colour.

## Camera language

| Moment           | Move                                                              |
| ---------------- | ----------------------------------------------------------------- |
| Arrival          | One dolly from the aisle to the bench. The only unprompted motion |
| Idle             | Free orbit and zoom, clamped above the floor                       |
| Shake            | Camera holds still. The box moves; the camera must not            |
| Observe          | Push in and rise over the lid, so the reveal happens under the camera |
| Duel             | Drop to a low two-shot for the fight                              |
| Specimen select  | Short glide to the chosen diorama                                 |

## Rendering style

- **Cel shading**: `MeshToonMaterial` with a shared four-step ramp.
- **Outlines by inverted hull**, not an outline post-pass. Back faces are pushed along
  the normal in the vertex shader. Reasons: it costs no extra render target, it works
  per object (ghosts simply skip it), it survives instancing, and it renders the same
  in the headless metadata renderer.
- **Post-processing** (desktop only): bloom for emissive things, film grain, vignette.
- Environment uses plain Lambert so the toon ramp stays reserved for characters and
  the hero box.

## Why plain three.js builders inside a React Three Fiber app

`packages/scene` is plain three.js: every builder takes a spec and returns an
`Object3D` plus `update` and `dispose`. `apps/web` is React Three Fiber and mounts
those objects with `<primitive>`.

- The metadata image must be a deterministic offscreen render. A builder that needs a
  React reconciler cannot run in a render script; a plain function can.
- The same builders will serve the Solana frontend unchanged.
- R3F still earns its place in the app: camera controls, the post-processing stack,
  pointer events and scene switching are all declarative there.

## Effect catalogue

| Effect                          | Trigger      | Status   | Notes                                         |
| ------------------------------- | ------------ | -------- | --------------------------------------------- |
| Box rock and hop, lid bulge     | shake        | Phase 1  | Decaying wobble, seeded per box               |
| Thump and rattle, muffled mrrp  | shake        | Phase 1  | Synthesised with WebAudio, no files           |
| Dust in lamp cone, lamp sway    | ambient      | Phase 1  | Point sprites, one draw call                  |
| Ghost fresnel and ripple        | ghost state  | Phase 1  |                                               |
| Quantum flicker between forms   | quantum      | Phase 1  | Two built forms, irregular switching          |
| Glitch wireframe echoes         | glitch breed | Phase 1  | Quantised jitter                              |
| Ghost wisps fraying to the floor | ghost state | Phase 3  | Follows the cat wherever it is placed         |
| Tape rip, flaps open, burst, cat rises | observe | Phase 3 | `BoxOpener`; light takes the room's colour, spectral for ghosts |
| Kibble drop, lid gap, happy hop | feed         | Phase 3  | `FeedEffect`; two pieces always miss and rattle off |
| Spotlight face-off              | duel         | Phase 3  | `DuelArena`; loser left leaning in the dark   |
| Glowing thread                  | entangle     | Phase 3  | `EntanglementThread`; one mesh, curve in the vertex shader |
| Take the cat out                | inspection   | Phase 4  | `CatInspector`; the box slides aside, the cat hops onto a mat under its own lamp, the camera orbits it |
| Room props                      | reveal       | Not done | Rooms are still colour-only. Listed in `assets/BLENDER_TODO.md` |

Sounds are all synthesised (`ShakeSound`): thump, rattle, muffled complaint, tape rip,
reveal chime (a darker one for ghosts), kibble tick, purr.

## Performance budget

| Target             | Desktop         | Mobile (low tier)                 |
| ------------------ | --------------- | --------------------------------- |
| Frame rate         | 60 fps          | 30 fps                            |
| Pixel ratio        | up to 2         | up to 1.25                        |
| Shadows            | one 1024 map    | off                               |
| Post-processing    | bloom, grain, vignette | off                        |
| Dust               | 500 points      | 120                               |
| Shelf boxes        | 140 instances   | 60                                |

`detectQuality()` picks the tier from pointer type, screen size, core count, device
memory and `prefers-reduced-motion`. Every box on the shelves is one `InstancedMesh`
(plus one for their stamps): two draw calls for the whole wall. The "Your shelf" view
puts the account's eight newest boxes on the bench as full boxes, each with its own
label texture, and lists the rest as text. Eight is what the bench holds and what a
phone draws comfortably; an instanced, atlas-backed shelf is the path if holders end
up with hundreds.

## Privacy rule for rendering

**A sealed box is rendered from its token id only.** `buildBoxSpec(tokenId)` never sees
the seed. If the box's dents, tape or stamp depended on the encrypted seed, the image
would leak it. The cat, room and broken object exist only in `CatSpec`, which can only
be built once the seed is public.

## Metadata image

Canonical image = the same builders rendered offscreen at a fixed camera, fixed time
and fixed size (1024 x 1024), in headless Chrome with software GL, so it runs on a
machine with no GPU. `apps/web/render.html` draws one frame; `scripts/render-metadata.cts`
drives it and writes `<id>.json`, `<id>.png` and `<id>.svg`.

The SVG fallback (`renderBoxSvg`, `renderCatSvg` in the generator) is a flat drawing
built from the same `BoxSpec` / `CatSpec`. It needs no browser (`--svg-only`) and is
what to serve where a large PNG is unwelcome.

The privacy rule holds here too: a sealed token's three files depend on the token id
and on public chain facts (times fed, duels won, Vet Certified, entangled partner).

## Inspection

Once a box is open, "Take the cat out" lifts it onto the bench. The point is to look
at it properly: the camera target moves to the cat, the minimum distance drops from
1.8 to 0.9, five preset angles (front, left, back, right, above) are one click away,
and drag and pinch do the rest. "Put it back" reverses the move. The cat is
re-parented from the box to the bench with its world transform kept, so nothing jumps.
