"""Shows kit parts in a running Blender, for looking at shapes while editing the scripts.

In Blender's Python console (or through the Blender MCP):

    import sys; sys.path.insert(0, "<repo>/assets/blender")
    import preview; preview.show(["prop_joint", "prop_bottle"])

Builds into a scene of its own, "DNO preview", and never touches any other scene.
Call `preview.clear()` to remove it. The scripts stay the source of truth: nothing
edited by hand in that scene is exported.
"""

import importlib

import bpy
from mathutils import Euler, Vector

import build
import cats
import parts
import sdf

SCENE = "DNO preview"


def _scene():
    scene = bpy.data.scenes.get(SCENE) or bpy.data.scenes.new(SCENE)
    bpy.context.window.scene = scene
    for obj in list(scene.collection.all_objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    return scene


def _look(centre, distance, pitch=1.25, yaw=0.5):
    for area in bpy.context.screen.areas:
        if area.type != "VIEW_3D":
            continue
        space = area.spaces[0]
        space.shading.type = "SOLID"
        space.shading.light = "STUDIO"
        space.shading.color_type = "MATERIAL"
        space.shading.show_object_outline = True
        space.overlay.show_overlays = False
        view = space.region_3d
        view.view_perspective = "PERSP"
        view.view_location = Vector(centre)
        view.view_distance = distance
        view.view_rotation = Euler((pitch, 0, yaw)).to_quaternion()


def show(names, spacing=0.45, distance=None, pitch=1.25, yaw=0.5, detail=None):
    """Rebuilds the named kit parts from the current scripts and frames them."""
    for module in (sdf, cats, parts, build):
        importlib.reload(module)
    if detail:
        parts.DETAIL = detail
    _scene()
    materials = build.kit_materials()
    groups = build.kit_groups()
    for i, name in enumerate(names):
        root, _ = build.add_group(name, groups[name], materials)
        root.location.x = (i - (len(names) - 1) / 2) * spacing
    _look((0, 0, 0.05), distance or 0.5 + spacing * len(names), pitch, yaw)


def clear():
    scene = bpy.data.scenes.get(SCENE)
    if not scene:
        return
    for obj in list(scene.collection.all_objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.context.window.scene = next(s for s in bpy.data.scenes if s != scene)
    bpy.data.scenes.remove(scene)
