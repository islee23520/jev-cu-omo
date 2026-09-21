# pyright: reportMissingImports=false, reportArgumentType=false
import bpy
import bmesh
import json
import math
import os
from mathutils import Vector


OBJECT = "Female_Base_Assembly"
LOCK_Z = 1.325
HEAD_Z = 1.425
PIVOT_Z = 1.375
PIVOT_Y_OFFSET = 0.0


def ensure_region(obj):
    attr = obj.data.attributes.get("JevVisionRegion")
    if attr is None:
        attr = obj.data.attributes.new("JevVisionRegion", "INT", "POINT")
        for index, vertex in enumerate(obj.data.vertices):
            z = (obj.matrix_world @ vertex.co).z
            attr.data[index].value = 0 if z <= LOCK_Z else (2 if z >= HEAD_Z else 1)
    return attr


def ids(obj, region):
    return [index for index, value in enumerate(ensure_region(obj).data) if value.value == region]


def inspect():
    obj = bpy.data.objects[OBJECT]
    head = ids(obj, 2)
    points = [obj.matrix_world @ vertex.co for vertex in obj.data.vertices]
    skull = [points[index] for index in head]
    mesh = bmesh.new(); mesh.from_mesh(obj.data)
    total_height = max(point.z for point in points) - min(point.z for point in points)
    skull_height = max(point.z for point in skull) - min(point.z for point in skull)
    result = {
        "vision_boundary": {"lock_z": LOCK_Z, "head_z": HEAD_Z, "pivot_z": PIVOT_Z},
        "head_morphed": bool(obj.get("jev_vision_head_scale")),
        "falloff_applied": bool(obj.get("jev_vision_falloff")),
        "saved": bool(bpy.context.scene.get("jev_vision_saved")),
        "head_scale": obj.get("jev_vision_head_scale"),
        "falloff": obj.get("jev_vision_falloff"),
        "locked_vertices": len(ids(obj, 0)),
        "falloff_vertices": len(ids(obj, 1)),
        "head_vertices": len(head),
        "total_height": total_height,
        "skull_height": skull_height,
        "heads_tall": total_height / skull_height,
        "nonmanifold_edges": sum(1 for edge in mesh.edges if not edge.is_manifold),
        "boundary_edges": sum(1 for edge in mesh.edges if edge.is_boundary),
    }
    mesh.free()
    return result


def curve(kind, t):
    if kind == "linear": return t
    if kind == "smoothstep": return t * t * (3.0 - 2.0 * t)
    if kind == "cosine": return 0.5 - 0.5 * math.cos(math.pi * t)
    raise RuntimeError("unknown falloff")


def morph_head(scale, falloff):
    obj = bpy.data.objects[OBJECT]
    if obj.get("jev_vision_head_scale"):
        raise RuntimeError("head already morphed")
    points = [obj.matrix_world @ vertex.co for vertex in obj.data.vertices]
    head_ids = ids(obj, 2)
    band_ids = ids(obj, 1)
    anchor_points = [points[index] for index in head_ids if points[index].z <= HEAD_Z + 0.02]
    pivot = Vector((
        sum(point.x for point in anchor_points) / len(anchor_points),
        sum(point.y for point in anchor_points) / len(anchor_points),
        PIVOT_Z,
    ))
    pivot.y += PIVOT_Y_OFFSET
    inverse = obj.matrix_world.inverted()
    for index in head_ids:
        point = points[index]
        obj.data.vertices[index].co = inverse @ (pivot + (point - pivot) * scale)
    for index in band_ids:
        point = points[index]
        t = max(0.0, min(1.0, (point.z - LOCK_Z) / (HEAD_Z - LOCK_Z)))
        weight = curve(falloff, t)
        transformed = pivot + (point - pivot) * scale
        obj.data.vertices[index].co = inverse @ (point * (1.0 - weight) + transformed * weight)
    obj.data.update()
    obj["jev_vision_head_scale"] = scale
    obj["jev_vision_falloff"] = falloff


def refine(strength):
    obj = bpy.data.objects[OBJECT]
    if not obj.get("jev_vision_head_scale"):
        raise RuntimeError("morph_head must run first")
    selected = ids(obj, 1)
    bpy.context.view_layer.objects.active = obj; obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="DESELECT"); bpy.ops.object.mode_set(mode="OBJECT")
    for index in selected: obj.data.vertices[index].select = True
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.vertices_smooth(factor=strength, repeat=2); bpy.ops.mesh.normals_make_consistent(inside=False); bpy.ops.object.mode_set(mode="OBJECT")
    obj["jev_vision_refine"] = strength


request = json.loads(os.environ["JEV_BLENDER_REQUEST"])
operation = request["operation"]
if operation == "inspect": pass
elif operation == "morph_head": morph_head(float(request["scale"]), str(request["falloff"]))
elif operation == "refine": refine(float(request["value"]))
elif operation == "save": bpy.context.scene["jev_vision_saved"] = True
else: raise RuntimeError(f"unknown operation {operation}")
bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)
print("JEV_BLENDER_STATE=" + json.dumps(inspect()))
