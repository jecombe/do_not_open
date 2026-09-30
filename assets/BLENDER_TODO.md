# Blender asset backlog

Rule: build in code first. An asset lands here only when a procedural version cannot
reach the art direction in `docs/DESIGN.md`. Each entry gets a magenta wireframe
placeholder in `packages/scene/src/assets/gltf.ts` (`GLTF_ASSETS`) so the app runs
before the model exists.

## Status after Phase 3

**Nothing needs Blender yet.** Box, tape, label, stamp, depot, all 10 breeds, 8 moods,
9 accessories, 7 broken objects and every effect (opening, feeding, duel, thread) are
procedural.

Decisions on the Phase 1 candidates:

| Candidate            | Decision                                                            |
| -------------------- | ------------------------------------------------------------------- |
| Torn tape strips     | Stays procedural: the strips fly off and fade in under a second, a modelled curl would not be seen |
| Maine Coon mane      | Stays procedural for now; revisit if close-up metadata renders show it |
| Room props (8 rooms) | Still open. Rooms are colour-only. To be decided in Phase 4 with the metadata renders |

## Spec template

Copy this block per asset.

```
### <asset id>            (must match the key in GLTF_ASSETS)
File:        public/models/<id>.glb
Dimensions:  W x H x D in scene units (1 unit = 1 m; the box is 1.2 x 0.9 x 1.0)
Pivot:       where the origin sits and which way is forward (+Z) and up (+Y)
Poly budget: triangles, per LOD if any
Materials:   count, names, base colours. Flat colours only: toon shading and the
             outline are applied in code. No baked lighting.
Textures:    none unless listed; if any, one atlas, max 1024 px
Animations:  clip names, length, loop or one-shot
Export:      glTF binary, Draco or meshopt compression, +Y up, apply transforms
```
