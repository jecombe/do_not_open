# Blender asset backlog

Rule: build in code first. An asset lands here only when a procedural version cannot
reach the art direction in `docs/DESIGN.md`. Each entry gets a magenta wireframe
placeholder in `packages/scene/src/assets/gltf.ts` (`GLTF_ASSETS`) so the app runs
before the model exists.

## Status at the end of Phase 5

In the committed code, **everything is procedural**: box, tape, label, stamp, depot, all
10 breeds, 8 moods, 9 accessories, 7 broken objects and every effect (opening, feeding,
duel, thread, inspection). `GLTF_ASSETS` is empty and the app loads no model file.

Final decisions on the candidates raised along the way:

| Candidate            | Decision                                                            |
| -------------------- | ------------------------------------------------------------------- |
| Torn tape strips     | Closed, stays procedural: the strips fly off and fade in under a second |
| Maine Coon mane      | Closed for the procedural cat. It reads as a collar of fur in the metadata render, which is acceptable at 1024 px |
| Room props (8 rooms) | **Open, specified below.** Rooms are a coloured floor and wall. It shows in the metadata renders and in the inspection view |
| Cat bodies           | **In progress outside this commit**, see the next section |

### A generated cat kit is in progress

As of 2026-09-30 the working tree holds an uncommitted Blender pipeline:
`assets/blender/*.py` builds the cats headlessly (`blender -b --python
assets/blender/build.py`) and writes `apps/web/public/models/cat-<breed>.glb` plus a
shared `cat-kit.glb`, and `packages/scene` is being changed to load them. None of that
is part of the Phase 5 commit and nothing in `docs/` describes it yet. When it lands,
this file, the 3D pipeline section of `docs/ARCHITECTURE.md` and the effect table in
`docs/DESIGN.md` need a pass, and the metadata renders have to be regenerated.

## Backlog

One asset set is specified and waiting: the room props. They are scenery behind a
revealed cat, so they must stay quiet: low, flat-coloured, never taller than the cat.

### room-props            (one file, eight named root nodes)

```
File:        public/models/room-props.glb
Nodes:       one root per room key in spec.json: livingRoom, kitchen, bedroom,
             bathroom, attic, serverRoom, laboratory, theVoid
Dimensions:  each set fits a half ring around the origin: inner radius 0.75, outer
             radius 1.3, height at most 0.9 (the cat is about 1.0 tall and sits at the
             origin; the diorama floor is a disc of radius 1.35)
Pivot:       origin at floor level, centre of the disc. Forward +Z (towards the
             camera), up +Y. Keep +Z clear: props go behind and beside the cat.
             Leave (-0.72, 0, 0.28) free, that is where the broken object sits.
Poly budget: 1,500 triangles per room, 12,000 for the file. No LOD.
Materials:   at most 4 per room, flat colours, named <room>_<part>. Take them from
             the room palette in packages/generator/src/catSpec.ts (ROOMS): floor,
             wall, accent. Toon shading and outlines are applied in code.
Textures:    none
Animations:  none. serverRoom may have one looping clip "blink" (2 s) on a named
             emissive node; theVoid may have one looping clip "drift" (6 s)
Export:      glTF binary, Draco compression, +Y up, apply transforms
```

| Room          | Props (two or three, no more)                       |
| ------------- | --------------------------------------------------- |
| `livingRoom`  | sofa arm and cushion, floor lamp, rug edge          |
| `kitchen`     | counter corner with one drawer, stool, hanging pan  |
| `bedroom`     | bed corner with a folded blanket, bedside table     |
| `bathroom`    | bathtub rim, towel rail, bath mat                   |
| `attic`       | two stacked trunks, a roof beam, a bare bulb        |
| `serverRoom`  | one rack with status lights, a cable run            |
| `laboratory`  | bench corner with two flasks, a stool               |
| `theVoid`     | three floating slabs, nothing touching the floor    |

Loading path: add `"room-props"` to `GLTF_ASSETS` with a placeholder, and have
`createDiorama` attach the node named after `spec.room.key`. Until the file exists the
placeholder shows, as the rule at the top of this file requires.

A procedural version is also possible (the broken objects are built that way) and would
keep the repository free of binary assets. The specification above holds either way.

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
