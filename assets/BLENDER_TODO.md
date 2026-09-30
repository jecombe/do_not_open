# Blender asset backlog

Rule: build in code first. An asset lands here only when a procedural version cannot
reach the art direction in `docs/DESIGN.md`. Each entry gets a magenta wireframe
placeholder in `packages/scene/src/assets/gltf.ts` (`GLTF_ASSETS`) so the app runs
before the model exists.

## Status after Phase 1

**Nothing needs Blender yet.** Box, tape, label, stamp, depot, all 10 breeds, 8 moods,
9 accessories and 7 broken objects are procedural.

## Candidates to re-evaluate in Phase 3

| Candidate            | Why it might need modelling                                   | Decision due |
| -------------------- | ------------------------------------------------------------- | ------------ |
| Torn tape strips     | The rip on `observe` needs believable curl; cloth-like bends   | Phase 3      |
| Maine Coon mane      | Cone ring reads as a collar at close range                    | Phase 3      |
| Room props (8 rooms) | Sofa, fridge, server rack: many parts, low procedural payoff  | Phase 3      |

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
