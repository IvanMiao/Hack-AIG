import argparse
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Vector


HERE = os.path.dirname(os.path.abspath(__file__))
TEXTURES = os.path.join(HERE, "art", "textures")
TILE_METRES = 1.5
FRAME_END = 97
RNG = random.Random(7251)
MATERIALS = {}
CURRENT_PROFILE = {}
ROLES = {
    "deep": (0.08, 0.07, 0.10, 1),
    "shade": (0.025, 0.025, 0.035, 1),
    "accent": (0.8, 0.04, 0.18, 1),
    "bone": (0.72, 0.68, 0.57, 1),
    "stone": (0.18, 0.19, 0.23, 1),
    "stone_dark": (0.07, 0.08, 0.10, 1),
    "cloth": (0.13, 0.12, 0.15, 1),
    "cloth_dark": (0.035, 0.035, 0.045, 1),
    "metal": (0.25, 0.28, 0.32, 1),
    "glow": (1.0, 0.14, 0.48, 1),
}
PROFILES = {
    "arena": {"stone": "stone_floor", "stone_dark": "rock"},
    "player": {"cloth": "cloth", "cloth_dark": "cloth", "metal": "armor", "deep": "cloth"},
    "boss_colossus": {
        "deep": "rock", "shade": "rock", "stone": "rock", "stone_dark": "rock",
    },
    "boss_hound": {"deep": "hide", "shade": "hide", "bone": "bone"},
    "boss_seraph": {
        "deep": "armor", "shade": "armor", "metal": "armor", "bone": "bone",
    },
    "boss_serpent": {"deep": "hide", "shade": "hide", "bone": "bone"},
    "boss_knight": {
        "deep": "armor", "shade": "armor", "metal": "armor", "cloth": "cloth",
        "cloth_dark": "cloth",
    },
    "boss_swarm": {
        "deep": "rock", "shade": "rock", "bone": "bone", "stone": "rock",
        "stone_dark": "rock",
    },
}
TEXTURE_ROLES = {
    "stone": "rock",
    "stone_dark": "rock",
    "cloth": "cloth",
    "cloth_dark": "cloth",
    "metal": "armor",
    "bone": "bone",
}


def active(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def apply_modifier(obj, modifier):
    active(obj)
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def image_for(texture_id, normal=False):
    suffix = "_n" if normal else ""
    filepath = os.path.join(TEXTURES, f"{texture_id}{suffix}.jpg")
    image = bpy.data.images.load(filepath, check_existing=True)
    image.colorspace_settings.name = "Non-Color" if normal else "sRGB"
    return image


def material(role, texture_id=None, uv_mode="world"):
    if texture_id is None:
        texture_id = CURRENT_PROFILE.get(role, TEXTURE_ROLES.get(role))
    key = (role, texture_id, uv_mode)
    if key in MATERIALS:
        return MATERIALS[key]
    mat = bpy.data.materials.new(role)
    mat.diffuse_color = ROLES[role]
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    principled = nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = ROLES[role]
    principled.inputs["Roughness"].default_value = 0.78
    if role in ("accent", "glow"):
        principled.inputs["Emission Color"].default_value = ROLES[role]
        principled.inputs["Emission Strength"].default_value = 1.0
    if texture_id:
        uv = nodes.new("ShaderNodeTexCoord")
        base = nodes.new("ShaderNodeTexImage")
        base.image = image_for(texture_id)
        base.extension = "REPEAT"
        links.new(uv.outputs["UV"], base.inputs["Vector"])
        links.new(base.outputs["Color"], principled.inputs["Base Color"])
        if texture_id != "sigil":
            normal = nodes.new("ShaderNodeTexImage")
            normal.image = image_for(texture_id, normal=True)
            normal.extension = "REPEAT"
            normal_map = nodes.new("ShaderNodeNormalMap")
            normal_map.inputs["Strength"].default_value = 0.55
            links.new(uv.outputs["UV"], normal.inputs["Vector"])
            links.new(normal.outputs["Color"], normal_map.inputs["Color"])
            links.new(normal_map.outputs["Normal"], principled.inputs["Normal"])
        mat["uv_mode"] = uv_mode
    MATERIALS[key] = mat
    return mat


def mesh_object(name, vertices, faces, role, parent, texture_id=None, uv_mode="world"):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, role, parent, texture_id, uv_mode)


def make_uvs(obj, uv_mode):
    if not obj.data.polygons:
        return
    uv_layer = obj.data.uv_layers.new(name="UVMap")
    coords = [vertex.co for vertex in obj.data.vertices]
    minima = [min(co[axis] for co in coords) for axis in range(3)]
    maxima = [max(co[axis] for co in coords) for axis in range(3)]
    spans = [max(maxima[i] - minima[i], 1e-5) for i in range(3)]
    for polygon in obj.data.polygons:
        normal = polygon.normal
        axis = max(range(3), key=lambda index: abs(normal[index]))
        uv_axes = (0, 1) if axis == 2 else ((0, 2) if axis == 1 else (1, 2))
        for loop_index in polygon.loop_indices:
            co = coords[obj.data.loops[loop_index].vertex_index]
            if uv_mode == "fit":
                uv = tuple((co[axis] - minima[axis]) / spans[axis] for axis in uv_axes)
            else:
                uv = tuple(co[axis] / TILE_METRES for axis in uv_axes)
            uv_layer.data[loop_index].uv = uv


def finish(obj, role, parent, texture_id=None, uv_mode="world", smooth=False):
    if obj.type != "MESH":
        obj.parent = parent
        return obj
    active(obj)
    if any(abs(component - 1.0) > 1e-6 for component in obj.scale):
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if obj.data.vertices:
        mins = [min(vertex.co[axis] for vertex in obj.data.vertices) for axis in range(3)]
        maxs = [max(vertex.co[axis] for vertex in obj.data.vertices) for axis in range(3)]
        center = Vector(tuple((mins[axis] + maxs[axis]) / 2 for axis in range(3)))
        if center.length > 1e-7:
            for vertex in obj.data.vertices:
                vertex.co -= center
            obj.location += center
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    if bm.faces:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    obj.data.materials.clear()
    obj.data.materials.append(material(role, texture_id, uv_mode))
    make_uvs(obj, uv_mode)
    for polygon in obj.data.polygons:
        polygon.use_smooth = smooth
    obj.parent = parent
    obj["material_role"] = role
    return obj


def smooth_mesh(obj):
    modifier = obj.modifiers.new("Sculptural smoothing", "SUBSURF")
    modifier.subdivision_type = "CATMULL_CLARK"
    modifier.levels = 1
    modifier.render_levels = 1
    apply_modifier(obj, modifier)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def clean_scene(asset_name, profile, frames=FRAME_END):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in list(bpy.data.materials):
        bpy.data.materials.remove(block)
    MATERIALS.clear()
    CURRENT_PROFILE.clear()
    CURRENT_PROFILE.update(PROFILES[profile])
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = frames
    scene.render.fps = 24
    root = bpy.data.objects.new(asset_name, None)
    scene.collection.objects.link(root)
    return root


def ellipsoid(parent, name, role, pos, scale, segments=14, rings=10, smooth=True):
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=segments, ring_count=rings, radius=1, location=pos
    )
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    if smooth:
        active(obj)
        modifier = obj.modifiers.new("Organic subdivision", "SUBSURF")
        modifier.levels = 1
        apply_modifier(obj, modifier)
    return finish(obj, role, parent, smooth=smooth)


def ico(parent, name, role, pos, scale, subdivisions=2):
    bpy.ops.mesh.primitive_ico_sphere_add(
        subdivisions=subdivisions, radius=1, location=pos
    )
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    return finish(obj, role, parent)


def fracture(obj, voxel_size=0.12, strength=0.08, decimate=0.52):
    active(obj)
    obj.data.remesh_mode = "VOXEL"
    obj.data.remesh_voxel_size = voxel_size
    bpy.ops.object.voxel_remesh()
    if strength:
        noise = bpy.data.textures.new(f"{obj.name} fracture noise", type="CLOUDS")
        noise.noise_scale = 0.28
        noise.noise_depth = 2
        modifier = obj.modifiers.new("Noise-worn fracture", "DISPLACE")
        modifier.texture = noise
        modifier.texture_coords = "LOCAL"
        modifier.strength = strength
        modifier.mid_level = 0.5
        apply_modifier(obj, modifier)
    modifier = obj.modifiers.new("Fracture decimation", "DECIMATE")
    modifier.ratio = decimate
    apply_modifier(obj, modifier)
    for polygon in obj.data.polygons:
        polygon.use_smooth = False
    return obj


def rock_chunk(parent, name, role, pos, scale, seed, voxel=0.12, decimate=0.12):
    bpy.ops.mesh.primitive_ico_sphere_add(
        subdivisions=2, radius=1, location=pos
    )
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    active(obj)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    rng = random.Random(seed)
    for vertex in obj.data.vertices:
        vertex.co *= rng.uniform(0.82, 1.18)
    fracture(obj, voxel_size=voxel, strength=max(scale) * 0.09, decimate=decimate)
    return finish(obj, role, parent)


def bevelled_box(parent, name, role, pos, dimensions, bevel=0.07, segments=2, smooth=False):
    bpy.ops.mesh.primitive_cube_add(size=1, location=pos)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    active(obj)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        modifier = obj.modifiers.new("Soft-cut edges", "BEVEL")
        modifier.width = bevel
        modifier.segments = segments
        apply_modifier(obj, modifier)
    return finish(obj, role, parent, smooth=smooth)


def tube_mesh(parent, name, role, points, radii, sides=8, texture_id=None):
    points = [Vector(point) for point in points]
    vertices = []
    faces = []
    for index, point in enumerate(points):
        before = points[max(0, index - 1)]
        after = points[min(len(points) - 1, index + 1)]
        tangent = (after - before).normalized()
        axis_a = tangent.cross(Vector((0, 1, 0)))
        if axis_a.length < 1e-4:
            axis_a = tangent.cross(Vector((1, 0, 0)))
        axis_a.normalize()
        axis_b = tangent.cross(axis_a).normalized()
        for side in range(sides):
            angle = side * math.tau / sides
            offset = radii[index] * (axis_a * math.cos(angle) + axis_b * math.sin(angle))
            vertices.append(tuple(point + offset))
    for ring in range(len(points) - 1):
        for side in range(sides):
            a = ring * sides + side
            b = ring * sides + (side + 1) % sides
            c = (ring + 1) * sides + (side + 1) % sides
            d = (ring + 1) * sides + side
            faces.append((a, b, c, d))
    faces.extend((tuple(range(sides - 1, -1, -1)),
                  tuple((len(points) - 1) * sides + i for i in range(sides))))
    return mesh_object(name, vertices, faces, role, parent, texture_id)


def limb(parent, name, role, start, end, radius, tip=0.7, sides=10):
    start, end = Vector(start), Vector(end)
    direction = (end - start).normalized()
    axis_a = direction.cross(Vector((0, 1, 0)))
    if axis_a.length < 1e-4:
        axis_a = direction.cross(Vector((1, 0, 0)))
    axis_a.normalize()
    axis_b = direction.cross(axis_a).normalized()
    vertices = []
    faces = []
    rings = ((0.0, radius * 0.74), (0.16, radius), (0.62, radius * 0.8),
             (0.9, radius * tip), (1.0, radius * tip * 0.52))
    for fraction, ring_radius in rings:
        center = start.lerp(end, fraction)
        for side in range(sides):
            angle = side * math.tau / sides
            offset = ring_radius * (axis_a * math.cos(angle) + axis_b * math.sin(angle))
            vertices.append(tuple(center + offset))
    for ring in range(len(rings) - 1):
        for side in range(sides):
            a = ring * sides + side
            b = ring * sides + (side + 1) % sides
            faces.append((a, b, b + sides, a + sides))
    faces.extend((tuple(range(sides - 1, -1, -1)),
                  tuple((len(rings) - 1) * sides + i for i in range(sides))))
    return mesh_object(name, vertices, faces, role, parent)


def blade(parent, name, role, start, end, width, thickness=0.09, segments=10):
    start, end = Vector(start), Vector(end)
    direction = (end - start).normalized()
    normal = direction.cross(Vector((0, 1, 0)))
    if normal.length < 1e-4:
        normal = direction.cross(Vector((0, 0, 1)))
    normal.normalize()
    side = normal.cross(direction).normalized()
    profile = ((0.0, 0.12), (0.22, 0.72), (0.57, 1.0), (0.82, 0.7), (1.0, 0.0))
    vertices = []
    faces = []
    for t, width_factor in profile:
        center = start.lerp(end, t)
        w = width * width_factor
        for offset in ((-w, -thickness), (w, -thickness), (w, thickness), (-w, thickness)):
            vertices.append(tuple(center + side * offset[0] + normal * offset[1]))
    for ring in range(len(profile) - 1):
        base, next_base = ring * 4, (ring + 1) * 4
        for side_index in range(4):
            faces.append((base + side_index, base + (side_index + 1) % 4,
                          next_base + (side_index + 1) % 4, next_base + side_index))
    faces.extend(((0, 3, 2, 1), tuple(range((len(profile) - 1) * 4, len(profile) * 4))))
    return mesh_object(name, vertices, faces, role, parent)


def disk(parent, name, role, radius, z, segments=128, texture_id=None, uv_mode="world"):
    vertices = [(0, 0, z)]
    vertices.extend(
        (math.cos(math.tau * i / segments) * radius,
         math.sin(math.tau * i / segments) * radius, z)
        for i in range(segments)
    )
    faces = [(0, i + 1, (i + 1) % segments + 1) for i in range(segments)]
    return mesh_object(name, vertices, faces, role, parent, texture_id, uv_mode)


def animate_object(obj, rotations=None, locations=None, frames=FRAME_END, interpolation="BEZIER"):
    if rotations:
        obj.rotation_mode = "XYZ"
        for frame, rotation in rotations:
            obj.rotation_euler = rotation
            obj.keyframe_insert(data_path="rotation_euler", frame=frame, group="Idle")
    if locations:
        for frame, location in locations:
            obj.location = location
            obj.keyframe_insert(data_path="location", frame=frame, group="Idle")
    if obj.animation_data and obj.animation_data.action:
        action = obj.animation_data.action
        action.name = "Idle"
        for curve in action.fcurves:
            for point in curve.keyframe_points:
                point.interpolation = interpolation
            if interpolation == "BEZIER":
                curve.modifiers.new("CYCLES")


def animate_idle(root, amplitude=0.06, frames=FRAME_END):
    middle = (frames + 1) // 2
    animate_object(root, locations=((1, (0, 0, 0)), (middle, (0, 0, amplitude)),
                                    (frames, (0, 0, 0))), frames=frames)


def platform_mesh(parent):
    rng = random.Random(7251)
    segments = 64
    radii = (1.5, 3.0, 4.5, 6.0, 7.5, 9.0)
    vertices = [(0, 0, 0)]
    for ring, radius in enumerate(radii):
        for i in range(segments):
            angle = math.tau * i / segments
            jitter = 1 + rng.uniform(-0.018, 0.018) * (1.0 + ring / 5)
            vertices.append((math.cos(angle) * radius * jitter,
                             math.sin(angle) * radius * jitter, 0))
    faces = [(0, i + 1, (i + 1) % segments + 1) for i in range(segments)]
    for ring in range(len(radii) - 1):
        inner = 1 + ring * segments
        outer = inner + segments
        for i in range(segments):
            j = (i + 1) % segments
            faces.extend(((inner + i, outer + i, outer + j),
                          (inner + i, outer + j, inner + j)))
    mesh_object("Arena carved walkable stone", vertices, faces, "stone", parent, "stone_floor")

    levels = ((0, 8.97), (-0.65, 8.55), (-1.6, 6.8), (-3.4, 4.0), (-5.8, 1.25))
    vertices, faces = [], []
    for layer, (z, radius) in enumerate(levels):
        for i in range(segments):
            angle = math.tau * i / segments
            jitter = 1 + rng.uniform(-0.055, 0.055)
            vertices.append((math.cos(angle) * radius * jitter,
                             math.sin(angle) * radius * jitter, z))
    for layer in range(len(levels) - 1):
        top, bottom = layer * segments, (layer + 1) * segments
        for i in range(segments):
            j = (i + 1) % segments
            faces.extend(((top + i, top + j, bottom + j),
                          (top + i, bottom + j, bottom + i)))
    faces.append(tuple(range((len(levels) - 1) * segments, len(levels) * segments)))
    mesh_object("Fractured rock under-platform", vertices, faces, "stone_dark", parent)


def pillar_mesh(parent, name, pos, height, seed):
    rng = random.Random(seed)
    sides = 8
    profile = ((0.0, 0.62), (0.12, 0.47), (0.38, 0.42),
               (0.71, 0.36), (0.9, 0.31), (1.0, 0.16))
    vertices, faces = [], []
    for level, (fraction, radius) in enumerate(profile):
        z = fraction * height
        for side in range(sides):
            angle = math.tau * side / sides
            jitter = rng.uniform(0.88, 1.12)
            x = math.cos(angle) * radius * jitter
            y = math.sin(angle) * radius * jitter
            vertices.append((x + pos[0], y + pos[1], z + pos[2]))
    for ring in range(len(profile) - 1):
        for side in range(sides):
            a = ring * sides + side
            b = ring * sides + (side + 1) % sides
            faces.append((a, b, b + sides, a + sides))
    faces.extend((tuple(range(sides - 1, -1, -1)),
                  tuple((len(profile) - 1) * sides + i for i in range(sides))))
    obj = mesh_object(name, vertices, faces, "stone_dark", parent)
    fracture(obj, voxel_size=0.12, strength=0.06, decimate=0.06)
    return finish(obj, "stone_dark", parent)


def build_arena():
    root = clean_scene("arena", "arena", frames=1)
    platform_mesh(root)
    disk(root, "sigil", "glow", 4.0, 0.012, 128, "sigil", "fit")
    rng = random.Random(9143)
    for i in range(8):
        angle = math.tau * i / 8 + 0.11
        start_r = rng.uniform(7.65, 8.05)
        end_r = rng.uniform(8.5, 8.85)
        limb(root, "Rim fracture", "glow",
             (math.cos(angle) * start_r, math.sin(angle) * start_r, 0.015),
             (math.cos(angle + 0.025) * end_r, math.sin(angle + 0.025) * end_r, 0.015),
             0.013, 0.18, 5)
    for i in range(7):
        angle = math.tau * i / 7 + 0.2
        radius = rng.uniform(10.8, 11.8)
        height = rng.uniform(3.7, 5.7)
        pos = (math.cos(angle) * radius, math.sin(angle) * radius, -0.2)
        pillar = pillar_mesh(root, f"Broken obelisk {i + 1}", pos, height, 220 + i)
        pillar.rotation_euler.x = rng.uniform(-0.14, 0.14)
        pillar.rotation_euler.y = rng.uniform(-0.18, 0.18)
        x = pos[0] + 0.22
        limb(root, "Pillar broken rib", "stone_dark",
             (x, pos[1], 0.2), (x * 1.02, pos[1], height * 0.78), 0.055, 0.62, 6)
    for i in range(20):
        angle = rng.uniform(0, math.tau)
        radius = rng.uniform(12, 25)
        pos = (math.cos(angle) * radius, math.sin(angle) * radius, rng.uniform(-8, 6))
        size = rng.uniform(0.28, 0.82)
        rock_chunk(root, f"Floating debris {i + 1}", "stone_dark" if i % 3 else "stone",
                   pos, (size * 1.35, size, size * rng.uniform(0.72, 1.35)),
                   800 + i, voxel=max(0.075, size * 0.14), decimate=0.035)
    return root


def cloak_panel(parent, name, role, center_x, top_z, bottom_z, width, y=-0.08, jagged=0.12):
    columns = 12
    vertices = []
    faces = []
    for back_y in (0, 1):
        for row, (z, row_width) in enumerate(((top_z, width * 0.62),
                                               (top_z * 0.55, width * 0.88),
                                               (bottom_z, width))):
            for col in range(columns + 1):
                t = col / columns
                x = center_x + (t * 2 - 1) * row_width
                hem = jagged * (0.5 + 0.5 * math.sin(col * 2.7 + center_x * 9)) if row == 2 else 0
                fold = 0.055 * math.sin(col * 2.0 + row * 1.1)
                py = y + back_y * 0.12 + fold
                vertices.append((x, py, z - hem))
        surface = (columns + 1) * 3
        offset = surface * back_y
        for row in range(2):
            for col in range(columns):
                a = offset + row * (columns + 1) + col
                faces.append((a, a + 1, a + columns + 2, a + columns + 1))
    obj = mesh_object(name, vertices, faces, role, parent)
    modifier = obj.modifiers.new("Woven thickness", "SOLIDIFY")
    modifier.thickness = 0.035
    apply_modifier(obj, modifier)
    return obj


def torus(parent, name, role, pos, major, minor, rotation=None, segments=32):
    bpy.ops.mesh.primitive_torus_add(
        major_segments=segments, minor_segments=8, major_radius=major,
        minor_radius=minor, location=pos,
    )
    obj = bpy.context.object
    obj.name = name
    if rotation:
        obj.rotation_euler = rotation
    return finish(obj, role, parent, smooth=True)


def build_player():
    root = clean_scene("player", "player")
    cloak_panel(root, "Tattered cloak", "cloth", 0, 1.52, 0.07, 0.68, 0.08, 0.19)
    for sign in (-1, 1):
        cloak_panel(root, "Split cloak tail", "cloth_dark", sign * 0.32, 1.05, 0.05,
                    0.27, -0.13, 0.22)
        limb(root, "Cloak fold", "cloth_dark",
             (sign * 0.21, -0.12, 1.34), (sign * 0.39, -0.16, 0.15), 0.035, 0.28, 6)
    hood = ellipsoid(root, "Hooded cowl", "cloth_dark", (0, 0.015, 1.59),
                     (0.38, 0.34, 0.43), 16, 12)
    hood_tip = limb(root, "Hood peak", "cloth", (0, 0.02, 1.78), (0, 0.08, 2.0), 0.22, 0.08)
    ellipsoid(root, "Face shadow", "shade", (0, -0.302, 1.59), (0.235, 0.045, 0.25), 14, 10)
    for sign in (-1, 1):
        ellipsoid(root, "Eye ember", "glow", (sign * 0.105, -0.352, 1.66),
                  (0.035, 0.022, 0.032), 8, 6, smooth=False)
        shoulder = ellipsoid(root, "Layered mantle", "cloth_dark",
                             (sign * 0.37, 0.03, 1.36), (0.31, 0.3, 0.16), 12, 8)
        limb(root, "Mantle point", "cloth", (sign * 0.43, -0.1, 1.4),
             (sign * 0.64, -0.12, 1.18), 0.14, 0.12)
        limb(root, "Forearm sleeve", "cloth", (sign * 0.37, -0.02, 1.2),
             (sign * 0.54, -0.3, 0.82), 0.12, 0.62)
        ellipsoid(root, "Leather glove", "metal", (sign * 0.54, -0.33, 0.78),
                  (0.12, 0.15, 0.11), 10, 8)
        for pouch in range(2):
            x = sign * (0.28 + pouch * 0.16)
            bevelled_box(root, "Belt pouch", "cloth_dark",
                         (x, -0.31, 0.92), (0.16, 0.12, 0.21), 0.035)
    torus(root, "Crossed belt", "metal", (0, -0.14, 1.03), 0.36, 0.035,
          (math.pi / 2, 0, 0), 24)
    for i in range(12):
        angle = i * 0.42
        link = torus(root, "Chain weapon link", "metal",
                     (0.62 + 0.12 * math.sin(angle), -0.46, 0.84 - i * 0.065),
                     0.074, 0.018, (math.pi / 2, 0, (i % 2) * math.pi / 2), 12)
        rest = tuple(link.rotation_euler)
        animate_object(link, rotations=((1, rest), (49, (rest[0] + 0.08, rest[1], rest[2] + 0.1)),
                                        (FRAME_END, rest)))
    ellipsoid(root, "Chain weight", "metal", (0.63, -0.46, 0.06),
              (0.12, 0.12, 0.15), 10, 8)
    animate_idle(root, 0.025)
    animate_object(hood_tip, rotations=((1, (0, 0, 0)), (49, (0.08, 0, 0)),
                                        (FRAME_END, (0, 0, 0))))
    return root


def build_colossus(root):
    ellipsoid(root, "Hunched stone trunk", "deep", (0, 0.08, 2.48),
              (0.92, 0.68, 1.12), 16, 12)
    ellipsoid(root, "Ribbed chest core", "deep", (0, -0.49, 2.55),
              (0.71, 0.31, 0.79), 16, 12)
    ellipsoid(root, "Caved back hump", "shade", (0, 0.54, 3.08),
              (0.88, 0.57, 0.68), 14, 10)
    ellipsoid(root, "Boulder skull", "stone", (0, -0.35, 3.47),
              (0.53, 0.49, 0.58), 14, 10)
    for sign in (-1, 1):
        ellipsoid(root, "Eye socket", "shade", (sign * 0.22, -0.77, 3.54),
                  (0.16, 0.08, 0.11), 10, 8)
        ellipsoid(root, "Magma eye", "accent", (sign * 0.22, -0.835, 3.55),
                  (0.075, 0.032, 0.047), 8, 6, smooth=False)
        limb(root, "Broken crown horn", "stone_dark",
             (sign * 0.33, -0.22, 3.72), (sign * 0.53, -0.16, 4.35), 0.19, 0.08, 7)
        rock_chunk(root, "Jagged shoulder mantle", "stone",
                   (sign * 0.94, 0.03, 3.12), (0.73, 0.67, 0.7), 310 + sign, 0.13)
        upper_arm = limb(root, "Heavy upper arm", "deep",
                         (sign * 0.92, 0.01, 2.94), (sign * 1.28, -0.07, 1.92), 0.42, 0.74, 12)
        forearm = limb(root, "Stone gauntlet", "stone_dark",
                       (sign * 1.28, -0.07, 1.96), (sign * 1.53, -0.22, 0.98), 0.52, 0.9, 12)
        fist = rock_chunk(root, "Knotted boulder fist", "stone",
                          (sign * 1.56, -0.27, 0.78), (0.48, 0.42, 0.43), 450 + sign, 0.105)
        for claw in range(4):
            x = sign * (1.27 + claw * 0.18)
            limb(root, "Fist talon", "stone_dark", (x, -0.56, 0.84),
                 (x + sign * 0.04, -0.67, 0.49), 0.105, 0.12, 7)
        leg = limb(root, "Bent stone leg", "deep",
                   (sign * 0.39, 0.06, 1.48), (sign * 0.48, -0.12, 0.3), 0.35, 0.74, 12)
        rock_chunk(root, "Foot boulder", "stone_dark",
                   (sign * 0.49, -0.34, 0.2), (0.42, 0.56, 0.22), 550 + sign, 0.09)
        animate_object(upper_arm, rotations=((1, (0, 0, 0)), (49, (sign * 0.035, 0, sign * 0.025)),
                                             (FRAME_END, (0, 0, 0))))
        animate_object(forearm, rotations=((1, (0, 0, 0)), (49, (sign * 0.025, 0, 0)),
                                           (FRAME_END, (0, 0, 0))))
    for i in range(7):
        z = 3.67 - i * 0.25
        y = 0.5 + i * 0.1
        limb(root, "Dorsal ridge spike", "stone_dark", (0, y, z),
             (0, y + 0.28, z + 0.47), 0.19, 0.06, 7)
    for i in range(5):
        z = 2.12 + i * 0.23
        width = 0.52 - i * 0.055
        limb(root, "Molten chest seam", "accent", (-width, -0.75, z),
             (width, -0.74, z + 0.05), 0.022, 0.18, 5)


def build_hound(root):
    ellipsoid(root, "Long ribcage", "deep", (0, 0.16, 0.91),
              (0.56, 0.91, 0.43), 16, 10)
    ellipsoid(root, "Shoulder mass", "deep", (0, -0.52, 0.97),
              (0.51, 0.52, 0.52), 14, 10)
    neck = tube_mesh(root, "Rising wolf neck", "deep",
                     ((0, -0.56, 0.85), (0, -0.87, 1.11), (0, -1.1, 1.44),
                      (0, -1.31, 1.69)),
                     (0.4, 0.33, 0.27, 0.22), 12)
    skull = ellipsoid(root, "Long skull", "shade", (0, -1.48, 1.55),
                      (0.39, 0.47, 0.31), 14, 10)
    ellipsoid(root, "Upper jaw", "bone", (0, -1.78, 1.43),
              (0.28, 0.38, 0.13), 12, 8)
    ellipsoid(root, "Lower jaw", "deep", (0, -1.8, 1.25),
              (0.25, 0.32, 0.09), 12, 8)
    for sign in (-1, 1):
        ellipsoid(root, "Amber eye", "accent", (sign * 0.25, -1.74, 1.62),
                  (0.055, 0.036, 0.052), 8, 6, smooth=False)
        limb(root, "Long canine", "bone", (sign * 0.16, -1.95, 1.38),
             (sign * 0.13, -2.02, 1.17), 0.065, 0.08, 7)
        for y, z in ((-0.55, 1.15), (0.25, 1.18), (0.68, 1.12)):
            limb(root, "Neck spine", "bone", (sign * 0.07, y, z),
                 (sign * 0.12, y + 0.16, z + 0.37), 0.13, 0.045, 7)
    legs = []
    for sign in (-1, 1):
        for front, y in ((True, -0.48), (False, 0.73)):
            hip_z = 0.95 if front else 0.9
            knee = (sign * 0.36, y + (0.18 if front else -0.16), 0.48)
            paw = (sign * 0.4, y + (0.16 if front else -0.02), 0.14)
            upper = limb(root, "Sinewed foreleg" if front else "Sinewed hindleg",
                         "deep", (sign * 0.36, y, hip_z), knee, 0.17 if front else 0.2, 0.7, 9)
            lower = limb(root, "Hock", "shade", knee, paw, 0.12, 0.68, 8)
            ellipsoid(root, "Bone paw", "bone", paw, (0.19, 0.25, 0.12), 10, 7)
            for claw in range(3):
                x = sign * (0.3 + claw * 0.09)
                limb(root, "Paw claw", "bone", (x, paw[1] - 0.14, 0.12),
                     (x, paw[1] - 0.28, 0.065), 0.045, 0.12, 6)
            legs.extend((upper, lower))
    tail = tube_mesh(root, "Whiplash tail", "deep",
                     ((0, 0.86, 0.95), (0, 1.22, 1.05), (0, 1.56, 1.27),
                      (0, 1.86, 1.53), (0, 2.08, 1.61)),
                     (0.18, 0.15, 0.11, 0.075, 0.02), 9)
    animate_object(tail, rotations=((1, (0, 0, 0)), (49, (0.12, 0.02, 0.1)),
                                    (FRAME_END, (0, 0, 0))))
    animate_object(neck, rotations=((1, (0, 0, 0)), (49, (0.025, 0, 0)),
                                    (FRAME_END, (0, 0, 0))))
    animate_idle(root, 0.015)


def build_seraph(root):
    animate_idle(root, 0.12)
    chest = ellipsoid(root, "Armoured breastplate", "deep", (0, 0.06, 2.28),
                      (0.53, 0.38, 0.75), 16, 12)
    ellipsoid(root, "Shoulder mantle", "shade", (0, 0.14, 2.76),
              (0.72, 0.34, 0.3), 14, 10)
    mask = ellipsoid(root, "Porcelain mask", "bone", (0, -0.05, 3.08),
                     (0.34, 0.28, 0.43), 14, 10)
    ellipsoid(root, "Mask void", "shade", (0, -0.31, 3.05),
              (0.21, 0.045, 0.2), 10, 8)
    for sign in (-1, 1):
        ellipsoid(root, "Red eye slit", "accent", (sign * 0.115, -0.36, 3.09),
                  (0.04, 0.02, 0.035), 8, 6, smooth=False)
    halo = torus(root, "Spinning halo", "glow", (0, 0.15, 3.63), 0.46, 0.055,
                 (0.24, 0, 0), 48)
    animate_object(halo, rotations=((1, (0.24, 0, 0)), (FRAME_END, (0.24, 0, math.tau))))
    wings = []
    for sign in (-1, 1):
        for pair, z in enumerate((2.74, 2.35, 1.95)):
            reach = 1.15 + pair * 0.26
            end = (sign * reach, 0.13 + pair * 0.07, z + (0.5 if pair == 0 else 0.08))
            root_pos = (sign * 0.39, 0.12, z)
            wing = blade(root, "Ceramic wing blade", "bone", root_pos, end,
                         0.28 - pair * 0.035, 0.12, 10)
            wing.rotation_euler.y = sign * (-0.08 + pair * 0.11)
            wings.append((wing, sign, pair))
            limb(root, "Wing blade edge", "metal", end,
                 (end[0] + sign * 0.18, end[1] - 0.035, end[2] + 0.18), 0.045, 0.1, 6)
        limb(root, "Armoured arm", "metal", (sign * 0.39, 0.04, 2.62),
             (sign * 0.55, -0.12, 1.9), 0.15, 0.68, 9)
        for index in range(3):
            x = sign * (0.28 + index * 0.19)
            limb(root, "Trailing robe streamer", "shade",
                 (x * 0.55, 0.14, 1.73), (x, 0.22, 0.25 + index * 0.06),
                 0.11, 0.14, 8)
    for wing, sign, pair in wings:
        animate_object(wing, rotations=((1, tuple(wing.rotation_euler)),
                                        (49, (wing.rotation_euler.x,
                                              wing.rotation_euler.y + sign * 0.07,
                                              wing.rotation_euler.z)),
                                        (FRAME_END, tuple(wing.rotation_euler))))


def build_serpent(root):
    coil_points = []
    for i in range(25):
        angle = math.tau * i / 24
        coil_points.append((math.cos(angle) * 0.91, math.sin(angle) * 0.82 + 0.18, 0.39))
    coil = tube_mesh(root, "Coiled scaled body", "deep", coil_points,
                     [0.32 + 0.025 * math.sin(i * 0.5) for i in range(25)], 12)
    for i in range(18):
        angle = math.tau * i / 18
        pos = (math.cos(angle) * 0.92, math.sin(angle) * 0.83 + 0.18, 0.55)
        plate = blade(root, "Coil armour scale", "shade",
                      (pos[0], pos[1], pos[2] - 0.17),
                      (pos[0] * 1.06, pos[1] * 1.08, pos[2] + 0.16), 0.11, 0.055, 8)
    neck = tube_mesh(root, "Rising serpentine neck", "deep",
                     ((0, 0.15, 0.62), (0, 0.08, 1.0), (0, -0.04, 1.55),
                      (0, -0.1, 2.12), (0, -0.16, 2.51)),
                     (0.37, 0.35, 0.3, 0.28, 0.24), 12)
    for i in range(9):
        z = 0.91 + i * 0.18
        limb(root, "Neck scute", "shade", (-0.19, -0.27, z),
             (0.19, -0.27, z + 0.08), 0.095, 0.72, 8)
    hood = ellipsoid(root, "Spread cobra hood", "shade", (0, 0.02, 2.76),
                     (0.73, 0.26, 0.58), 16, 10)
    ellipsoid(root, "Hooded skull", "deep", (0, -0.25, 2.91),
              (0.37, 0.4, 0.37), 14, 10)
    for sign in (-1, 1):
        limb(root, "Hood spine", "bone", (sign * 0.44, -0.01, 2.9),
             (sign * 0.9, 0.0, 3.26), 0.14, 0.08, 8)
        ellipsoid(root, "Serpent ember eye", "accent",
                  (sign * 0.16, -0.6, 2.98), (0.06, 0.03, 0.045), 8, 6, smooth=False)
        limb(root, "Curved fang", "bone", (sign * 0.14, -0.59, 2.74),
             (sign * 0.18, -0.71, 2.43), 0.075, 0.06, 7)
    animate_object(neck, rotations=((1, (0, 0, 0)), (49, (0, 0.025, 0.04)),
                                    (FRAME_END, (0, 0, 0))))
    animate_idle(root, 0.055)


def build_knight(root):
    body = ellipsoid(root, "Armoured body", "deep", (0, 0.08, 1.65),
                     (0.51, 0.35, 0.67), 16, 12)
    chest = bevelled_box(root, "Forged breastplate", "metal",
                         (0, -0.27, 1.87), (0.82, 0.24, 0.64), 0.13, 3)
    helm = ellipsoid(root, "Horned greathelm", "metal", (0, 0.03, 2.55),
                     (0.43, 0.37, 0.5), 16, 12)
    bevelled_box(root, "Glowing visor", "accent", (0, -0.34, 2.6),
                 (0.47, 0.055, 0.09), 0.025, 2)
    for sign in (-1, 1):
        shoulder = bevelled_box(root, "Engraved pauldron", "deep",
                                (sign * 0.64, 0.02, 2.09), (0.52, 0.48, 0.38), 0.14, 3)
        for row in range(2):
            bevelled_box(root, "Pauldron rim", "metal",
                         (sign * (0.63 + row * 0.06), -0.28, 2.0 + row * 0.14),
                         (0.48 - row * 0.08, 0.055, 0.07), 0.025, 2)
        limb(root, "Armoured arm", "metal",
             (sign * 0.59, 0.02, 1.98), (sign * 0.56, -0.26, 1.24), 0.2, 0.7, 10)
        ellipsoid(root, "Gauntlet", "deep", (sign * 0.56, -0.31, 1.18),
                  (0.16, 0.13, 0.18), 10, 8)
        limb(root, "Greave", "metal", (sign * 0.27, 0.04, 1.12),
             (sign * 0.35, -0.06, 0.27), 0.2, 0.74, 10)
        bevelled_box(root, "War boot", "deep",
                     (sign * 0.35, -0.2, 0.18), (0.33, 0.45, 0.2), 0.075, 2)
        limb(root, "Helm horn", "metal",
             (sign * 0.26, 0.04, 2.82), (sign * 0.52, 0.06, 3.47), 0.13, 0.05, 8)
    cloak_panel(root, "Torn knight tabard", "cloth", 0, 1.46, 0.13,
                0.39, -0.43, 0.22)
    for sign in (-1, 1):
        limb(root, "Tabard seam", "cloth_dark",
             (sign * 0.09, -0.49, 1.42), (sign * 0.13, -0.49, 0.2), 0.025, 0.3, 5)
    for z in (1.66, 1.82, 1.98):
        bevelled_box(root, "Cuirass engraved rib", "shade",
                     (0, -0.414, z), (0.52, 0.035, 0.045), 0.018, 2)
    sword = blade(root, "Planted greatsword", "metal",
                  (0.81, -0.36, 0.1), (0.81, -0.36, 1.82), 0.17, 0.09, 12)
    bevelled_box(root, "Sword crossguard", "metal",
                 (0.81, -0.36, 1.76), (0.61, 0.13, 0.12), 0.04, 2)
    limb(root, "Sword grip", "cloth_dark", (0.81, -0.36, 1.81),
         (0.81, -0.36, 2.17), 0.075, 0.85, 8)
    ellipsoid(root, "Sword pommel", "accent", (0.81, -0.36, 2.2),
              (0.09, 0.09, 0.11), 8, 6, smooth=False)
    animate_idle(root, 0.05)
    animate_object(chest, locations=((1, tuple(chest.location)),
                                     (49, (chest.location.x, chest.location.y, chest.location.z + 0.03)),
                                     (FRAME_END, tuple(chest.location))))


def build_swarm(root):
    ellipsoid(root, "Caged heart", "deep", (0, 0, 1.53),
              (0.43, 0.42, 0.55), 16, 12)
    ellipsoid(root, "Singularity core", "accent", (0, -0.38, 1.56),
              (0.24, 0.08, 0.29), 12, 10, smooth=False)
    for axis in range(3):
        points = []
        for i in range(9):
            angle = math.tau * i / 8
            if axis == 0:
                points.append((math.cos(angle) * 0.64, -0.05, 1.53 + math.sin(angle) * 0.78))
            elif axis == 1:
                points.append((0.64 * math.cos(angle), 0.42 * math.sin(angle), 1.53 + 0.7 * math.sin(angle)))
            else:
                points.append((0.42 * math.sin(angle), 0.64 * math.cos(angle), 1.53 + 0.72 * math.sin(angle)))
        cage = tube_mesh(root, "Orbiting bone cage", "bone", points, [0.035] * len(points), 7)
        cage.rotation_euler.z = axis * math.pi / 3
    for i in range(32):
        angle = i * math.tau / 32
        orbit = i % 4
        radius = 0.95 + 0.3 * math.sin(i * 2.6)
        z = 0.65 + (i % 8) * 0.26
        size = 0.13 + (i % 3) * 0.035
        pos = (math.cos(angle) * radius, math.sin(angle) * radius, z)
        sign = "bone" if i % 6 == 0 else "deep"
        shard = blade(root, "Orbiting shard", sign,
                      (pos[0], pos[1], pos[2] - size),
                      (pos[0] * 1.13, pos[1] * 1.13, pos[2] + size), size * 0.72, 0.05, 7)
        start_rotation = tuple(shard.rotation_euler)
        turns = 1 + orbit
        middle_angle = angle + math.tau * turns / 2
        end_angle = angle + math.tau * turns
        for frame, turn_angle in ((1, angle), ((FRAME_END + 1) // 2, middle_angle),
                                  (FRAME_END, end_angle)):
            shard.location = (math.cos(turn_angle) * radius,
                              math.sin(turn_angle) * radius, z)
            shard.rotation_euler = (start_rotation[0] + turn_angle - angle,
                                    start_rotation[1], start_rotation[2] + turn_angle - angle)
            shard.keyframe_insert(data_path="location", frame=frame, group="Orbit")
            shard.keyframe_insert(data_path="rotation_euler", frame=frame, group="Orbit")
        if shard.animation_data and shard.animation_data.action:
            for curve in shard.animation_data.action.fcurves:
                for point in curve.keyframe_points:
                    point.interpolation = "LINEAR"
    animate_idle(root, 0.04)


BOSSES = {
    "colossus": build_colossus,
    "hound": build_hound,
    "seraph": build_seraph,
    "serpent": build_serpent,
    "knight": build_knight,
    "swarm": build_swarm,
}


def build_boss(silhouette):
    root = clean_scene(f"boss_{silhouette}", f"boss_{silhouette}")
    BOSSES[silhouette](root)
    if silhouette not in ("hound", "seraph", "knight", "swarm"):
        animate_idle(root, 0.05)
    return root


def triangle_count():
    total = 0
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        total += len(mesh.loop_triangles)
        evaluated.to_mesh_clear()
    return total


def export_asset(name, output):
    filepath = os.path.join(output, f"{name}.glb")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=filepath,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_animations=True,
        export_animation_mode="SCENE",
        export_cameras=False,
        export_lights=False,
        export_image_format="JPEG",
    )
    size = os.path.getsize(filepath)
    triangles = triangle_count()
    triangle_limit = 60000 if name == "arena" else (15000 if name == "player" else 25000)
    print(f"ASSET {name}: {size:,} bytes, {triangles:,} triangles")
    if size > 2.5 * 1024 * 1024:
        raise RuntimeError(f"{name} exceeds 2.5 MB: {size:,} bytes")
    if triangles > triangle_limit:
        raise RuntimeError(f"{name} exceeds {triangle_limit:,} triangles: {triangles:,}")
    return size


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="src/assets/models")
    args = parser.parse_args(argv)
    output = os.path.abspath(args.out)
    os.makedirs(output, exist_ok=True)
    sizes = []
    for name, builder in (("arena", build_arena), ("player", build_player)):
        builder()
        sizes.append(export_asset(name, output))
    for silhouette, builder in BOSSES.items():
        build_boss(silhouette)
        sizes.append(export_asset(f"boss_{silhouette}", output))
    total = sum(sizes)
    if total > 15 * 1024 * 1024:
        raise RuntimeError(f"model library exceeds 15 MB: {total:,} bytes")
    print(f"TOTAL: {total:,} bytes")


if __name__ == "__main__":
    main()
