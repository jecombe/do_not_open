"""Builds the cat kit and exports it as Draco-compressed glTF.

    blender -b --factory-startup --python assets/blender/build.py -- [--out DIR] [--only a,b] [--jobs N]

Outputs one `cat-<breed>.glb` per breed, one `cat-kit.glb` (face parts and
accessories) and `rat.glb` (the studio's rats, everything in one file). With no
`--only`, every file is rebuilt, one Blender process per file.
"""

import argparse
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import bpy
import numpy as np
from mathutils import Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import cats  # noqa: E402
import parts  # noqa: E402
import rats  # noqa: E402
import sdf  # noqa: E402

DEFAULT_OUT = os.path.normpath(os.path.join(HERE, "..", "..", "apps", "web", "public", "models"))

# glTF (+Y up, +Z forward) -> Blender (+Z up, -Y forward). The exporter undoes it.
TO_BLENDER = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], dtype=float)

VOXEL = {"head": 0.02, "body": 0.024, "ear": 0.013, "tail": 0.016}
RAT_VOXEL = {"head": 0.009, "body": 0.014, "ear": 0.007, "tail": 0.006, "arm": 0.007}
# Triangle caps: meshed fine for a clean surface, then decimated to keep the file small.
RAT_BUDGET = {"head": 7000, "body": 6000, "ear": 2000, "tail": 3000, "arm": 1500, "part": 2500}


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def add_mesh(name, model, voxel, parent=None, material=None, props=None, budget=None):
    """`budget` caps the triangle count: the mesh is decimated down to it, then smooth-shaded."""
    verts, normals, tris, masks = sdf.mesh(model, voxel)
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata((verts @ TO_BLENDER.T.astype(np.float32)).tolist(), [], tris.tolist())
    mesh.polygons.foreach_set("use_smooth", [True] * len(mesh.polygons))
    if not budget or len(tris) <= budget:
        mesh.normals_split_custom_set_from_vertices((normals @ TO_BLENDER.T.astype(np.float32)).tolist())
    if material is None:
        zone = mesh.color_attributes.new("zone", "FLOAT_COLOR", "POINT")
        zone.data.foreach_set("color", masks.astype(np.float32).ravel())
        mesh.color_attributes.active_color = zone
        mesh.color_attributes.render_color_index = 0
    else:
        mesh.materials.append(material)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    if budget and len(tris) > budget:
        # Collapse keeps the silhouette and interpolates the zone masks.
        mod = obj.modifiers.new("decimate", "DECIMATE")
        mod.ratio = budget / len(tris)
        evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
        decimated = bpy.data.meshes.new_from_object(evaluated)
        obj.modifiers.remove(mod)
        obj.data = decimated
        bpy.data.meshes.remove(mesh)
        mesh = decimated
        mesh.polygons.foreach_set("use_smooth", [True] * len(mesh.polygons))
        tris = np.zeros((len(mesh.polygons), 3))
    obj.parent = parent
    for key, value in (props or {}).items():
        obj[key] = value
    return obj, len(tris)


def add_empty(name, parent=None, pos=(0, 0, 0), rot=None, scale=1.0):
    obj = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = parent
    m = np.eye(4)
    r = np.eye(3) if rot is None else rot
    m[:3, :3] = TO_BLENDER @ (r * scale) @ TO_BLENDER.T
    m[:3, 3] = TO_BLENDER @ np.asarray(pos, dtype=float)
    obj.matrix_local = Matrix(m.tolist())
    return obj


def add_part(name, part, voxel, budget=None):
    obj, tris = add_mesh(name, part.model, voxel, budget=budget)
    for anchor, (pos, rot, scale) in part.anchors.items():
        add_empty(f"{name}__{anchor.removeprefix('anchor_')}", obj, pos, rot, scale)
    return tris


def export(path, with_materials, zones=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_normals=True,
        export_texcoords=False,
        export_materials="EXPORT" if with_materials else "NONE",
        export_vertex_color="NONE" if with_materials and not zones else "ACTIVE",
        export_active_vertex_color_when_no_material=True,
        export_extras=True,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_cameras=False,
        export_lights=False,
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=6,
        export_draco_position_quantization=14,
        export_draco_normal_quantization=16,
        export_draco_color_quantization=12,
    )


def build_breed(key, out):
    reset()
    breed = cats.BREEDS[key]
    tris = add_part("head", cats.build_head(breed), VOXEL["head"])
    for side, name in ((-1, "L"), (1, "R")):
        tris += add_part(f"ear_{name}", cats.build_ear(breed, side), VOXEL["ear"])
    tris += add_part("tail", cats.build_tail(breed), VOXEL["tail"])
    for pose in cats.POSES:
        tris += add_part(f"body_{pose}", cats.build_body(breed, pose), VOXEL["body"])
    export(os.path.join(out, f"cat-{key}.glb"), with_materials=False)
    return tris


def hex_to_linear(hex_color):
    srgb = [int(hex_color[i : i + 2], 16) / 255 for i in (1, 3, 5)]
    return [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb] + [1.0]


def kit_materials(table=None):
    """One flat material per name in the table (parts.MATERIALS by default), reused if it already exists."""
    materials = {}
    for name, color in (table or parts.MATERIALS).items():
        mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        mat.diffuse_color = hex_to_linear(color)
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = hex_to_linear(color)
        materials[name] = mat
    return materials


def kit_groups():
    """Every part of the shared kit: name -> pieces."""
    groups = {**parts.face_parts(), **parts.vice_props()}
    for key, pieces in parts.accessories().items():
        groups[f"accessory_{key}"] = pieces
    return groups


def add_group(name, pieces, materials, parent=None, budget=None):
    """One empty per part, one child mesh per material."""
    root = add_empty(name, parent)
    if name.startswith("accessory_"):
        root["anchor"] = parts.ACCESSORY_ANCHORS[name[len("accessory_") :]]
    tris = 0
    for i, piece in enumerate(pieces):
        props = {"outline": int(piece.outline), "flat": int(piece.flat), "opacity": float(piece.opacity)}
        count = add_mesh(f"{name}_{i}", piece.model, piece.voxel, root, materials[piece.material], props, budget)[1]
        print(f"[part] {name}_{i} ({piece.material}): {count} triangles")
        tris += count
    return root, tris


def build_kit(out):
    reset()
    materials = kit_materials()
    tris = sum(add_group(name, pieces, materials)[1] for name, pieces in kit_groups().items())
    export(os.path.join(out, "cat-kit.glb"), with_materials=True)
    return tris


def build_rat(out):
    """The whole rat in one file: fur meshes with colour zones, then flat-coloured parts."""
    reset()
    v, cap = RAT_VOXEL, RAT_BUDGET
    tris = add_part("head", rats.build_head(), v["head"], cap["head"])
    for side, name in ((-1, "L"), (1, "R")):
        tris += add_part(f"ear_{name}", rats.build_ear(side), v["ear"], cap["ear"])
    tris += add_part("ear_R_nicked", rats.build_ear(1, nicked=True), v["ear"], cap["ear"])
    tris += add_part("tail", rats.build_tail(), v["tail"], cap["tail"])
    tris += add_part("arm_wave", rats.build_arm(), v["arm"], cap["arm"])
    for pose in rats.POSES:
        tris += add_part(f"body_{pose}", rats.build_body(pose), v["body"], cap["body"])
    materials = kit_materials(rats.MATERIALS)
    for name, pieces in rats.kit_groups().items():
        tris += add_group(name, pieces, materials, budget=cap["part"])[1]
    export(os.path.join(out, "rat.glb"), with_materials=True, zones=True)
    return tris


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--only", default="")
    parser.add_argument("--jobs", type=int, default=os.cpu_count() or 4)
    args = parser.parse_args(argv)
    targets = ["kit", "rat", *cats.BREEDS]

    if not args.only:
        # One process per file: the meshing is numpy-bound and Blender is happy to be run in parallel.
        def run(target):
            cmd = [bpy.app.binary_path, "-b", "--factory-startup", "--python", __file__, "--", "--out", args.out, "--only", target]
            done = subprocess.run(cmd, capture_output=True, text=True)
            lines = [line for line in done.stdout.splitlines() if line.startswith("[kit]")]
            if done.returncode != 0 or not lines:
                raise RuntimeError(f"{target} failed:\n{done.stdout[-3000:]}\n{done.stderr[-3000:]}")
            print("\n".join(lines), flush=True)

        with ThreadPoolExecutor(args.jobs) as pool:
            list(pool.map(run, targets))
        return

    for target in args.only.split(","):
        if target not in targets:
            raise SystemExit(f"unknown target '{target}', expected one of {', '.join(targets)}")
        started = time.time()
        tris = build_kit(args.out) if target == "kit" else build_rat(args.out) if target == "rat" else build_breed(target, args.out)
        name = {"kit": "cat-kit.glb", "rat": "rat.glb"}.get(target, f"cat-{target}.glb")
        size = os.path.getsize(os.path.join(args.out, name)) / 1024
        print(f"[kit] {name}: {tris} triangles, {size:.0f} kB, {time.time() - started:.1f} s", flush=True)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException:
        # Blender keeps a zero exit code after a Python error unless told otherwise.
        import traceback

        traceback.print_exc()
        sys.exit(1)
