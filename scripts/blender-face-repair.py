# pyright: reportMissingImports=false, reportAttributeAccessIssue=false
import bpy
import hashlib
import heapq
import json
import math
import os
import struct
from collections import deque
from mathutils import Vector


ROOT = os.environ.get("JEV_CU_BLEND_OUTPUT_DIR")
SOURCE = os.environ.get("JEV_CU_BLEND_INPUT")
if not ROOT or not SOURCE:
    raise RuntimeError("JEV_CU_BLEND_INPUT and JEV_CU_BLEND_OUTPUT_DIR are required")
ROOT = os.path.abspath(os.path.expanduser(ROOT))
SOURCE = os.path.abspath(os.path.expanduser(SOURCE))
OUTPUT = os.path.join(ROOT, "Female_FaceNeck_Repaired.blend")
FINAL_DIR = os.path.join(ROOT, "evidence", "final")
LOG_PATH = os.path.join(ROOT, "implementation-log.json")
OBJECT_NAME = "Female_Base_Assembly"

EXPECTED = {
    "source_sha256": "ad60f8affdef8fb67659214a25b887bc3795c86c207279d224b3ca5da3d0976d",
    "vertices": 45777,
    "edges": 94159,
    "faces": 48382,
    "components": [45777],
    "boundary_count": 126,
    "nonmanifold_count": 126,
    "topology_digest": "8c1e401fb351df0b7fef3def31383d5d88ce67600045fcd0f4fa61dc9c03792d",
    "boundary_digest": "61b110042b32c8623b36ede8d550c25666b8472a84eb771c06c83539588fadbd",
    "transition_faces_count": 166,
    "transition_faces_digest": "cdb9c37d6dc3c9aec8bd54ef5f23726f82e46c85f286b289fc868b3b3ea96515",
    "locked_count": 26440,
    "active_count": 19337,
    "head_count": 1426,
    "locked_ids_digest": "c59485e397f976f97f8c090dfaaa617a3dc881a10d7404004e169dc457747c1c",
    "active_ids_digest": "b404eb635b5a80ae2c43238ed49be641f4d1acb705c6628bde0a7845a7a27aa0",
    "head_ids_digest": "6f13fc79e5fe651b40329b1176f69a5f5e3c93f5f05707fa0735ac295218b615",
    "locked_coordinates_digest": "aa6d5625b9279046d30c1e8b3a309b56646207cff1ee655530716d52de22d1af",
    "weights_digest": "eef19696c8173fa22f9a422e54703722b87c0fd883d079067ec2255c1aee3e95",
}

PARAMETERS = {
    "stage1_head_uniform_scale": 0.60,
    "current_space_head_scale_multiplier": 0.27,
    "final_head_uniform_scale": 0.162,
    "head_translation_x_m": 0.0,
    "head_translation_y_m": 0.0,
    "rigid_source_z_min_m": 0.82,
    "rigid_geodesic_radius_m": 0.48,
    "stage1_rigid_target_lowest_z_m": 0.95,
    "clavicle_line_z_m": 0.6947194338,
    "final_chin_clearance_in_stage1_head_heights": 0.10,
    "visible_neck_length_in_new_head_heights": 0.37,
    "lower_neck_width_over_head_width": 0.50,
    "under_jaw_width_over_head_width": 0.40,
    "head_seed_z_m": 1.34,
    "front_throat_depth_over_head_width": 0.012,
    "scm_depth_over_head_width": 0.008,
    "posterior_trapezius_depth_over_head_width": 0.015,
    "neck_easing": "current-space graph smoothstep between locked seam and final rigid collar",
    "rigid_resolution_note": "Recreates the structurally successful 18493-vertex stage1 current-space rigid set at scale 0.60, then uniformly scales that current-space result by 0.27",
    "render_resolution": [900, 900],
}


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def png_resolution(path):
    with open(path, "rb") as handle:
        header = handle.read(24)
    if header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        raise AssertionError(f"Not a valid PNG with IHDR: {path}")
    return list(struct.unpack(">2I", header[16:24]))


def digest_ids(ids):
    return hashlib.sha256(b"".join(struct.pack("<I", i) for i in sorted(ids))).hexdigest()


def topology_digest(mesh):
    packed = bytearray(struct.pack("<3I", len(mesh.vertices), len(mesh.edges), len(mesh.polygons)))
    for edge in mesh.edges:
        packed.extend(struct.pack("<2I", edge.vertices[0], edge.vertices[1]))
    for polygon in mesh.polygons:
        packed.extend(struct.pack("<I", len(polygon.vertices)))
        packed.extend(struct.pack("<%dI" % len(polygon.vertices), *polygon.vertices))
    return hashlib.sha256(packed).hexdigest()


def connected_components(adjacency, allowed=None):
    remaining = set(range(len(adjacency))) if allowed is None else set(allowed)
    components = []
    while remaining:
        seed = min(remaining)
        remaining.remove(seed)
        queue = deque([seed])
        component = {seed}
        while queue:
            current = queue.popleft()
            for neighbor in sorted(adjacency[current]):
                if neighbor in remaining:
                    remaining.remove(neighbor)
                    component.add(neighbor)
                    queue.append(neighbor)
        components.append(component)
    return components


def multi_source_distances(adjacency, seeds):
    distances = [-1] * len(adjacency)
    queue = deque()
    for seed in sorted(seeds):
        distances[seed] = 0
        queue.append(seed)
    while queue:
        current = queue.popleft()
        next_distance = distances[current] + 1
        for neighbor in sorted(adjacency[current]):
            if distances[neighbor] == -1:
                distances[neighbor] = next_distance
                queue.append(neighbor)
    return distances


def geometric_distances(adjacency, coordinates, seeds, allowed):
    distances = [float("inf")] * len(adjacency)
    queue = []
    for seed in sorted(seeds):
        distances[seed] = 0.0
        heapq.heappush(queue, (0.0, seed))
    while queue:
        distance, current = heapq.heappop(queue)
        if distance != distances[current]:
            continue
        for neighbor in sorted(adjacency[current]):
            if neighbor not in allowed:
                continue
            candidate = distance + (coordinates[current] - coordinates[neighbor]).length
            if candidate < distances[neighbor]:
                distances[neighbor] = candidate
                heapq.heappush(queue, (candidate, neighbor))
    return distances


def smoothstep(value):
    return value * value * (3.0 - 2.0 * value)


def lerp(a, b, t):
    return a + (b - a) * t


def smootherstep01(value):
    value = max(0.0, min(1.0, value))
    return value * value * value * (value * (value * 6.0 - 15.0) + 10.0)


def edge_facts(mesh):
    lookup = {tuple(sorted(edge.vertices)): edge.index for edge in mesh.edges}
    face_counts = [0] * len(mesh.edges)
    for polygon in mesh.polygons:
        vertices = polygon.vertices
        for index, first in enumerate(vertices):
            second = vertices[(index + 1) % len(vertices)]
            face_counts[lookup[tuple(sorted((first, second)))]] += 1
    boundary = {index for index, count in enumerate(face_counts) if count == 1}
    nonmanifold = {index for index, count in enumerate(face_counts) if count != 2}
    wire = {index for index, count in enumerate(face_counts) if count == 0}
    return boundary, nonmanifold, wire


def boundary_digest(edge_ids):
    return hashlib.sha256(b"".join(struct.pack("<I", i) for i in sorted(edge_ids))).hexdigest()


def locked_coordinates_digest(mesh, locked):
    packed = b"".join(
        struct.pack("<I3d", index, *tuple(mesh.vertices[index].co)) for index in sorted(locked)
    )
    return hashlib.sha256(packed).hexdigest()


def assert_equal(actual, expected, label):
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def build_source_state(obj):
    mesh = obj.data
    source_coordinates = [vertex.co.copy() for vertex in mesh.vertices]
    adjacency = [set() for _ in mesh.vertices]
    for edge in mesh.edges:
        first, second = edge.vertices
        adjacency[first].add(second)
        adjacency[second].add(first)

    attribute = mesh.attributes.get("NeckTransition")
    if attribute is None or attribute.domain != "FACE":
        raise AssertionError("NeckTransition face attribute is missing")
    transition_faces = {index for index, item in enumerate(attribute.data) if item.value != 0}
    transition = {
        vertex_id
        for face_id in transition_faces
        for vertex_id in mesh.polygons[face_id].vertices
    }
    split_components = sorted(
        connected_components(adjacency, set(range(len(mesh.vertices))) - transition),
        key=len,
        reverse=True,
    )
    assert_equal([len(component) for component in split_components], [26404, 19159], "split components")
    body, upper = split_components
    body_transition = {index for index in transition if adjacency[index] & body}
    upper_transition = {index for index in transition if adjacency[index] & upper}
    transition_interior = transition - body_transition - upper_transition
    locked = body | body_transition
    active = set(range(len(mesh.vertices))) - locked
    head = {index for index in upper if source_coordinates[index].z >= PARAMETERS["head_seed_z_m"]}

    assert_equal(len(transition), 214, "transition vertex count")
    assert_equal(len(body_transition), 36, "body transition count")
    assert_equal(len(upper_transition), 60, "upper transition count")
    assert_equal(len(transition_interior), 118, "transition interior count")
    assert_equal(len(locked), EXPECTED["locked_count"], "locked count")
    assert_equal(len(active), EXPECTED["active_count"], "active count")
    assert_equal(len(head), EXPECTED["head_count"], "head count")
    assert_equal(digest_ids(locked), EXPECTED["locked_ids_digest"], "locked IDs digest")
    assert_equal(digest_ids(active), EXPECTED["active_ids_digest"], "active IDs digest")
    assert_equal(digest_ids(head), EXPECTED["head_ids_digest"], "head IDs digest")

    distance_locked = multi_source_distances(adjacency, locked)
    distance_head = multi_source_distances(adjacency, head)
    weights = []
    for index in range(len(mesh.vertices)):
        if index in locked:
            weight = 0.0
        elif index in head:
            weight = 1.0
        else:
            weight = distance_locked[index] / (distance_locked[index] + distance_head[index])
        weights.append(weight)
    packed_weights = b"".join(
        struct.pack("<Id", index, weights[index]) for index in range(len(weights))
    )
    assert_equal(hashlib.sha256(packed_weights).hexdigest(), EXPECTED["weights_digest"], "w_base digest")

    rigid_eligible = {
        index for index in active if source_coordinates[index].z >= PARAMETERS["rigid_source_z_min_m"]
    }
    rigid_distances = geometric_distances(adjacency, source_coordinates, head, rigid_eligible)
    rigid = {
        index
        for index in rigid_eligible
        if rigid_distances[index] <= PARAMETERS["rigid_geodesic_radius_m"]
    }
    neck = active - rigid
    if not head <= rigid:
        raise AssertionError("Rigid flood-fill does not contain the original HEAD seed")
    assert_equal(len(rigid), 18493, "complete current-space rigid set count")
    rigid_source_low = min(source_coordinates[index].z for index in rigid)
    rigid_source_crown = max(source_coordinates[index].z for index in rigid)
    stage1_scale = PARAMETERS["stage1_head_uniform_scale"]
    stage1_z_translation = (
        PARAMETERS["stage1_rigid_target_lowest_z_m"]
        - stage1_scale * rigid_source_low
    )
    stage1_low = stage1_scale * rigid_source_low + stage1_z_translation
    stage1_crown = stage1_scale * rigid_source_crown + stage1_z_translation
    stage1_height = stage1_crown - stage1_low
    final_scale_multiplier = PARAMETERS["current_space_head_scale_multiplier"]
    final_head_height = stage1_height * final_scale_multiplier
    final_chin_z = (
        PARAMETERS["clavicle_line_z_m"]
        + PARAMETERS["final_chin_clearance_in_stage1_head_heights"] * stage1_height
    )
    final_crown_z = final_chin_z + final_head_height

    source_head_width = max(source_coordinates[index].x for index in rigid) - min(
        source_coordinates[index].x for index in rigid
    )
    final_head_width = source_head_width * stage1_scale * final_scale_multiplier
    lower_neck_width = final_head_width * PARAMETERS["lower_neck_width_over_head_width"]
    under_jaw_width = final_head_width * PARAMETERS["under_jaw_width_over_head_width"]
    visible_neck_length = final_head_height * PARAMETERS["visible_neck_length_in_new_head_heights"]
    neck_base_z = PARAMETERS["clavicle_line_z_m"]
    neck_top_z = neck_base_z + visible_neck_length

    neck_distance_locked = multi_source_distances(adjacency, locked)
    neck_distance_rigid = multi_source_distances(adjacency, rigid)

    return {
        "coordinates": source_coordinates,
        "matrix_world": obj.matrix_world.copy(),
        "adjacency": adjacency,
        "transition_faces": transition_faces,
        "transition": transition,
        "locked": locked,
        "active": active,
        "head": head,
        "weights": weights,
        "rigid": rigid,
        "neck": neck,
        "rigid_distances": rigid_distances,
        "rigid_source_low": rigid_source_low,
        "rigid_source_crown": rigid_source_crown,
        "stage1_z_translation": stage1_z_translation,
        "stage1_low": stage1_low,
        "stage1_crown": stage1_crown,
        "stage1_height": stage1_height,
        "final_chin_z": final_chin_z,
        "final_crown_z": final_crown_z,
        "final_head_height": final_head_height,
        "final_head_width": final_head_width,
        "lower_neck_width": lower_neck_width,
        "under_jaw_width": under_jaw_width,
        "visible_neck_length": visible_neck_length,
        "neck_base_z": neck_base_z,
        "neck_top_z": neck_top_z,
        "neck_distance_locked": neck_distance_locked,
        "neck_distance_rigid": neck_distance_rigid,
    }


def validate_structure(obj, state, validate_repair_shape=False):
    mesh = obj.data
    assert_equal(obj.name, OBJECT_NAME, "object name")
    assert_equal(tuple(tuple(row) for row in obj.matrix_world), tuple(tuple(row) for row in state["matrix_world"]), "object matrix")
    assert_equal(len(mesh.vertices), EXPECTED["vertices"], "vertex count")
    assert_equal(len(mesh.edges), EXPECTED["edges"], "edge count")
    assert_equal(len(mesh.polygons), EXPECTED["faces"], "face count")
    assert_equal(topology_digest(mesh), EXPECTED["topology_digest"], "topology digest")
    component_sizes = sorted((len(x) for x in connected_components(state["adjacency"])), reverse=True)
    assert_equal(component_sizes, EXPECTED["components"], "connected components")
    boundary, nonmanifold, wire = edge_facts(mesh)
    assert_equal(len(boundary), EXPECTED["boundary_count"], "boundary edge count")
    assert_equal(len(nonmanifold), EXPECTED["nonmanifold_count"], "nonmanifold edge count")
    assert_equal(boundary, nonmanifold, "boundary/nonmanifold edge set")
    assert_equal(len(wire), 0, "wire edge count")
    assert_equal(boundary_digest(boundary), EXPECTED["boundary_digest"], "boundary edge digest")
    assert_equal(len(state["transition_faces"]), EXPECTED["transition_faces_count"], "transition face count")
    assert_equal(digest_ids(state["transition_faces"]), EXPECTED["transition_faces_digest"], "transition face digest")
    assert_equal(locked_coordinates_digest(mesh, state["locked"]), EXPECTED["locked_coordinates_digest"], "locked coordinates digest")
    results = {
        "vertices": len(mesh.vertices),
        "edges": len(mesh.edges),
        "faces": len(mesh.polygons),
        "components": component_sizes,
        "boundary_edges": len(boundary),
        "nonmanifold_edges": len(nonmanifold),
        "wire_edges": len(wire),
        "topology_digest": topology_digest(mesh),
        "boundary_digest": boundary_digest(boundary),
        "locked_coordinates_digest": locked_coordinates_digest(mesh, state["locked"]),
    }
    if validate_repair_shape:
        rigid_low = min(mesh.vertices[index].co.z for index in state["rigid"])
        rigid_crown = max(mesh.vertices[index].co.z for index in state["rigid"])
        if abs(rigid_low - state["final_chin_z"]) > 1.0e-5:
            raise AssertionError(f"final chin z: expected {state['final_chin_z']}, got {rigid_low}")
        if abs(rigid_crown - state["final_crown_z"]) > 1.0e-5:
            raise AssertionError(f"final crown z: expected {state['final_crown_z']}, got {rigid_crown}")
        total_height = max(vertex.co.z for vertex in mesh.vertices) - min(vertex.co.z for vertex in mesh.vertices)
        head_height = rigid_crown - rigid_low
        total_height_ratio = total_height / head_height
        if not 6.5 <= total_height_ratio <= 7.5:
            raise AssertionError(f"total height / head height outside [6.5,7.5]: {total_height_ratio}")
        results["rigid_lowest_z"] = rigid_low
        results["rigid_crown_z"] = rigid_crown
        results["total_height"] = total_height
        results["crown_to_chin_height"] = head_height
        results["total_height_over_head_height"] = total_height_ratio
    return results


def rigid_edge_ratio_assertions(mesh, state):
    source = state["coordinates"]
    rigid = state["rigid"]
    expected_scale = PARAMETERS["final_head_uniform_scale"]
    deviations = []
    edge_count = 0
    for edge in mesh.edges:
        first, second = edge.vertices
        if first not in rigid or second not in rigid:
            continue
        source_length = (source[first] - source[second]).length
        if source_length == 0.0:
            continue
        current_length = (mesh.vertices[first].co - mesh.vertices[second].co).length
        deviations.append(abs(current_length / source_length - expected_scale) / expected_scale)
        edge_count += 1
    if edge_count == 0:
        raise AssertionError("Rigid set has no internal edges")
    maximum_deviation = max(deviations)
    if maximum_deviation > 0.005:
        raise AssertionError(f"Rigid internal edge ratio deviation exceeds 0.5%: {maximum_deviation}")
    return {
        "internal_edge_count": edge_count,
        "expected_ratio": expected_scale,
        "maximum_relative_deviation": maximum_deviation,
        "limit": 0.005,
    }


def apply_repair(obj, state):
    mesh = obj.data
    source = state["coordinates"]
    locked = state["locked"]
    active = state["active"]
    rigid = state["rigid"]
    neck = state["neck"]
    stage1_scale = PARAMETERS["stage1_head_uniform_scale"]
    stage1_z_translation = state["stage1_z_translation"]
    current_multiplier = PARAMETERS["current_space_head_scale_multiplier"]

    def stage1_rigid_target(original):
        return Vector((
            stage1_scale * original.x,
            stage1_scale * original.y,
            stage1_scale * original.z + stage1_z_translation,
        ))

    stage1_centroid = sum((stage1_rigid_target(source[index]) for index in rigid), Vector()) / len(rigid)
    current_scaled_low = stage1_centroid.z + current_multiplier * (state["stage1_low"] - stage1_centroid.z)
    final_z_translation = state["final_chin_z"] - current_scaled_low

    def rigid_target(original):
        current = stage1_rigid_target(original)
        return stage1_centroid + current_multiplier * (current - stage1_centroid) + Vector((0.0, 0.0, final_z_translation))

    for index in sorted(rigid):
        original = source[index]
        mesh.vertices[index].co = rigid_target(original)

    head_half_width = state["final_head_width"] * 0.5
    lower_half_width = state["lower_neck_width"] * 0.5
    under_jaw_half_width = state["under_jaw_width"] * 0.5
    lower_half_depth = lower_half_width * 1.10
    under_jaw_half_depth = under_jaw_half_width * 1.08
    neck_targets = {}
    for index in sorted(neck):
        original = source[index]
        distance_locked = state["neck_distance_locked"][index]
        distance_rigid = state["neck_distance_rigid"][index]
        if distance_locked + distance_rigid == 0:
            graph_weight = 0.0
        else:
            graph_weight = distance_locked / (distance_locked + distance_rigid)
        eased = smoothstep(graph_weight)
        graph_z = lerp(state["neck_base_z"], state["neck_top_z"], eased)
        angle = math.atan2(original.y, original.x)
        half_width = lerp(lower_half_width, under_jaw_half_width, eased)
        half_depth = lerp(lower_half_depth, under_jaw_half_depth, eased)
        target = Vector((half_width * math.cos(angle), half_depth * math.sin(angle), graph_z))

        # Subtle directional anatomy is strongest mid-blend and vanishes at both
        # hard boundaries, so neither LOCKED nor the rigid face can be distorted.
        field_weight = 4.0 * eased * (1.0 - eased)
        radial_x = abs(target.x) / max(head_half_width, 1.0e-9)
        front = math.exp(-((target.x / max(under_jaw_half_width * 0.65, 1.0e-9)) ** 2)) * max(0.0, -math.sin(angle))
        scm = math.exp(-(((radial_x - 0.55) / 0.22) ** 2)) * max(0.0, -original.y / 0.25 + 0.25)
        posterior = math.exp(-((target.x / max(lower_half_width * 0.85, 1.0e-9)) ** 2)) * max(0.0, math.sin(angle))
        target.y -= PARAMETERS["front_throat_depth_over_head_width"] * state["final_head_width"] * front * field_weight
        target.y -= PARAMETERS["scm_depth_over_head_width"] * state["final_head_width"] * scm * field_weight
        target.y += PARAMETERS["posterior_trapezius_depth_over_head_width"] * state["final_head_width"] * posterior * field_weight
        neck_targets[index] = target
        mesh.vertices[index].co = target

    # Mandatory hard Dirichlet restoration after the only deformation pass.
    for index in sorted(locked):
        mesh.vertices[index].co = source[index]
    mesh.update()

    final_coordinates = [vertex.co.copy() for vertex in mesh.vertices]
    lower_band = [
        final_coordinates[index]
        for index in neck
        if state["neck_base_z"] <= final_coordinates[index].z <= state["neck_base_z"] + state["visible_neck_length"] * 0.30
    ]
    upper_band = [
        final_coordinates[index]
        for index in neck
        if state["neck_top_z"] - state["visible_neck_length"] * 0.30 <= final_coordinates[index].z <= state["neck_top_z"]
    ]
    lower_width = max(point.x for point in lower_band) - min(point.x for point in lower_band)
    upper_width = max(point.x for point in upper_band) - min(point.x for point in upper_band)
    lower_ratio = lower_width / state["final_head_width"]
    upper_ratio = upper_width / state["final_head_width"]
    if not 0.45 <= lower_ratio <= 0.55:
        raise AssertionError(f"lower neck width/head width outside range: {lower_ratio}")
    if not 0.35 <= upper_ratio <= 0.45:
        raise AssertionError(f"under-jaw width/head width outside range: {upper_ratio}")
    state["final_z_translation"] = final_z_translation
    state["measured_lower_neck_width"] = lower_width
    state["measured_under_jaw_width"] = upper_width
    state["measured_lower_neck_ratio"] = lower_ratio
    state["measured_under_jaw_ratio"] = upper_ratio


def render_evidence(obj):
    os.makedirs(FINAL_DIR, exist_ok=True)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "SINGLE"
    scene.display.shading.single_color = (0.24, 0.48, 0.72)
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.display.shading.background_type = "VIEWPORT"
    scene.display.shading.background_color = (0.025, 0.035, 0.055)
    scene.render.resolution_x = 900
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False

    for candidate in list(bpy.data.objects):
        if candidate.type == "CAMERA":
            bpy.data.objects.remove(candidate, do_unlink=True)
    bpy.ops.object.camera_add()
    camera = bpy.context.object
    camera.name = "RepairEvidenceCamera"
    camera.data.type = "ORTHO"
    scene.camera = camera

    views = [
        ("front", (0.0, -2.0, 0.43), 1.02, (0.0, 0.0, 0.43)),
        ("side", (2.0, 0.0, 0.43), 1.02, (0.0, 0.0, 0.43)),
        ("rear", (0.0, 2.0, 0.43), 1.02, (0.0, 0.0, 0.43)),
        ("threequarter", (1.5, -1.5, 0.43), 1.02, (0.0, 0.0, 0.43)),
        ("neck_close", (0.0, -1.0, 0.75), 0.32, (0.0, 0.0, 0.75)),
    ]
    renders = {}
    for name, location, scale, target in views:
        camera.location = location
        camera.rotation_euler = (Vector(target) - camera.location).to_track_quat("-Z", "Y").to_euler()
        camera.data.ortho_scale = scale
        path = os.path.join(FINAL_DIR, name + ".png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        renders[name] = {
            "path": path,
            "sha256": sha256_file(path),
            "resolution": png_resolution(path),
            "camera_location": list(location),
            "camera_target": list(target),
            "orthographic_scale": scale,
        }
        assert_equal(renders[name]["resolution"], [900, 900], f"{name} render resolution")
    bpy.data.objects.remove(camera, do_unlink=True)
    return renders


def main():
    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    os.makedirs(FINAL_DIR, exist_ok=True)
    source_sha_before = sha256_file(SOURCE)
    assert_equal(source_sha_before, EXPECTED["source_sha256"], "source SHA-256 before repair")
    assert_equal(bpy.app.version_string, "5.1.2", "Blender version")

    obj = bpy.data.objects.get(OBJECT_NAME)
    if obj is None or obj.type != "MESH":
        raise AssertionError(f"Required mesh object {OBJECT_NAME!r} is missing")
    state = build_source_state(obj)
    preflight = validate_structure(obj, state)
    apply_repair(obj, state)
    structural = validate_structure(obj, state, validate_repair_shape=True)
    rigid_edges = rigid_edge_ratio_assertions(obj.data, state)

    # Save only after every structural assertion passes. The evidence camera is
    # temporary and is added after save so the final Blend remains the mesh scene.
    bpy.ops.wm.save_as_mainfile(filepath=OUTPUT, check_existing=False)
    output_sha = sha256_file(OUTPUT)
    renders = render_evidence(obj)
    source_sha_after = sha256_file(SOURCE)
    assert_equal(source_sha_after, source_sha_before, "source SHA-256 after repair")

    log = {
        "status": "PASS",
        "blender_version": bpy.app.version_string,
        "input": {"path": SOURCE, "sha256_before": source_sha_before, "sha256_after": source_sha_after},
        "output": {"path": OUTPUT, "sha256": output_sha},
        "script": {"path": os.path.abspath(__file__), "sha256": sha256_file(os.path.abspath(__file__))},
        "parameters": PARAMETERS,
        "mask_counts": {
            "LOCKED": len(state["locked"]),
            "ACTIVE": len(state["active"]),
            "HEAD": len(state["head"]),
            "RIGID": len(state["rigid"]),
            "NECK": len(state["neck"]),
        },
        "digests": {
            "LOCKED_ids": digest_ids(state["locked"]),
            "ACTIVE_ids": digest_ids(state["active"]),
            "HEAD_ids": digest_ids(state["head"]),
            "RIGID_ids": digest_ids(state["rigid"]),
            "NECK_ids": digest_ids(state["neck"]),
            "w_base": EXPECTED["weights_digest"],
        },
        "rigid_set": {
            "count": len(state["rigid"]),
            "source_lowest_z": state["rigid_source_low"],
            "source_crown_z": state["rigid_source_crown"],
            "stage1_z_translation": state["stage1_z_translation"],
            "stage1_lowest_z": state["stage1_low"],
            "stage1_crown_z": state["stage1_crown"],
            "stage1_head_height": state["stage1_height"],
            "current_space_multiplier": PARAMETERS["current_space_head_scale_multiplier"],
            "final_z_translation": state["final_z_translation"],
            "final_chin_z": state["final_chin_z"],
            "final_crown_z": state["final_crown_z"],
            "final_head_height": state["final_head_height"],
            "final_head_width": state["final_head_width"],
            "internal_edge_ratios": rigid_edges,
        },
        "neck_proportions": {
            "clavicle_line_z": PARAMETERS["clavicle_line_z_m"],
            "visible_neck_length": state["visible_neck_length"],
            "visible_neck_length_over_new_head_height": state["visible_neck_length"] / state["final_head_height"],
            "measured_lower_neck_width": state["measured_lower_neck_width"],
            "measured_under_jaw_width": state["measured_under_jaw_width"],
            "lower_neck_width_over_head_width": state["measured_lower_neck_ratio"],
            "under_jaw_width_over_head_width": state["measured_under_jaw_ratio"],
        },
        "preflight": preflight,
        "structural_assertions": structural,
        "renders": renders,
        "forbidden_operations_used": [],
    }
    with open(LOG_PATH, "w", encoding="utf-8") as handle:
        json.dump(log, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print("REPAIR_PASS", json.dumps(log, sort_keys=True))


if __name__ == "__main__":
    main()
