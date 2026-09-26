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
TEXTURE_IMAGES = {}
CURRENT_TEXTURE_SIZE = 1024
CURRENT_ASSET = ""
SMALL_TEXTURES = {"bone", "sigil"}
DOWNSAMPLED_TEXTURES = {"boss_knight": {"cloth"}, "boss_swarm": {"rock"}}
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
    "player": {"cloth": None, "cloth_dark": "cloth", "metal": "armor", "deep": None},
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
    key = (texture_id, normal)
    if key in TEXTURE_IMAGES:
        return TEXTURE_IMAGES[key]
    suffix = "_n" if normal else ""
    filepath = os.path.join(TEXTURES, f"{texture_id}{suffix}.jpg")
    source = bpy.data.images.load(filepath, check_existing=True)
    source.colorspace_settings.name = "Non-Color" if normal else "sRGB"
    target_size = 512 if (
        CURRENT_ASSET == "arena"
        or texture_id in SMALL_TEXTURES
        or texture_id in DOWNSAMPLED_TEXTURES.get(CURRENT_ASSET, set())
    ) else CURRENT_TEXTURE_SIZE
    if max(source.size) > target_size:
        scaled = source.copy()
        scaled.scale(target_size, target_size)
        image = bpy.data.images.new(
            f"{texture_id}{suffix}_{target_size}",
            width=target_size,
            height=target_size,
            alpha=False,
        )
        image.pixels.foreach_set(scaled.pixels[:])
        bpy.data.images.remove(scaled)
    else:
        image = source
    image.colorspace_settings.name = "Non-Color" if normal else "sRGB"
    TEXTURE_IMAGES[key] = image
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


def mesh_object(name, vertices, faces, role, parent, texture_id=None, uv_mode="world", smooth=False):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, role, parent, texture_id, uv_mode, smooth=smooth)


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
    if smooth:
        modifier = obj.modifiers.new("Weighted surface normals", "WEIGHTED_NORMAL")
        apply_modifier(obj, modifier)
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
    global CURRENT_TEXTURE_SIZE, CURRENT_ASSET
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in list(bpy.data.materials):
        bpy.data.materials.remove(block)
    for block in list(bpy.data.images):
        if block.users == 0:
            bpy.data.images.remove(block)
    MATERIALS.clear()
    TEXTURE_IMAGES.clear()
    CURRENT_PROFILE.clear()
    CURRENT_PROFILE.update(PROFILES[profile])
    CURRENT_ASSET = asset_name
    CURRENT_TEXTURE_SIZE = 1024
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
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-5)
    bm.verts.index_update()
    bmesh.ops.dissolve_degenerate(bm, edges=list(bm.edges), dist=1e-5)
    seen_faces = set()
    duplicate_faces = []
    for face in bm.faces:
        key = tuple(sorted(vertex.index for vertex in face.verts))
        if key in seen_faces:
            duplicate_faces.append(face)
        else:
            seen_faces.add(key)
    if duplicate_faces:
        bmesh.ops.delete(bm, geom=duplicate_faces, context="FACES")
    loose_vertices = [vertex for vertex in bm.verts if not vertex.link_faces]
    if loose_vertices:
        bmesh.ops.delete(bm, geom=loose_vertices, context="VERTS")
    if bm.faces:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.validate(verbose=True, clean_customdata=True)
    obj.data.update()
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


def tapered_curve(parent, name, role, points, radii, bevel_depth=0.1, resolution=6):
    curve = bpy.data.curves.new(f"{name} curve", "CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = resolution
    curve.bevel_depth = bevel_depth
    curve.bevel_resolution = 2
    curve.use_fill_caps = True
    spline = curve.splines.new("BEZIER")
    spline.bezier_points.add(len(points) - 1)
    for bezier_point, point, radius in zip(spline.bezier_points, points, radii):
        bezier_point.co = point
        bezier_point.radius = radius
        bezier_point.handle_left_type = "AUTO"
        bezier_point.handle_right_type = "AUTO"
    obj = bpy.data.objects.new(name, curve)
    bpy.context.scene.collection.objects.link(obj)
    active(obj)
    bpy.ops.object.convert(target="MESH")
    obj = bpy.context.object
    obj.name = name
    return finish(obj, role, parent, smooth=True)


def extruded_plate(parent, name, role, points, y, thickness=0.09, bevel=0.025):
    bm = bmesh.new()
    front = [bm.verts.new((point[0], y, point[1])) for point in points]
    face = bm.faces.new(front)
    result = bmesh.ops.extrude_face_region(bm, geom=[face])
    original = set(front)
    extruded = [element for element in result["geom"]
                if isinstance(element, bmesh.types.BMVert) and element not in original]
    bmesh.ops.translate(bm, verts=extruded, vec=Vector((0, thickness, 0)))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    if bevel:
        modifier = obj.modifiers.new("Plate edge bevel", "BEVEL")
        modifier.width = min(bevel, thickness * 0.3)
        modifier.segments = 2
        apply_modifier(obj, modifier)
    return finish(obj, role, parent)


def ground_plate(parent, name, role, center, angle, length, width, thickness):
    cx, cy, cz = center
    forward = (math.cos(angle), math.sin(angle))
    across = (-forward[1], forward[0])
    outline = ((-0.5, -0.32), (-0.34, -0.5), (0.28, -0.45),
               (0.5, 0), (0.28, 0.45), (-0.34, 0.5))
    vertices = []
    for z in (cz - thickness * 0.5, cz + thickness * 0.5):
        for along, side in outline:
            vertices.append((cx + forward[0] * along * length + across[0] * side * width,
                             cy + forward[1] * along * length + across[1] * side * width,
                             z))
    faces = [tuple(range(6)), tuple(range(11, 5, -1))]
    for index in range(6):
        next_index = (index + 1) % 6
        faces.append((index, next_index, next_index + 6, index + 6))
    return mesh_object(name, vertices, faces, role, parent, uv_mode="fit")


def sword_blade(parent, name, role, start, end, width, thickness=0.075):
    start, end = Vector(start), Vector(end)
    direction = Vector((end.x - start.x, end.z - start.z)).normalized()
    perpendicular = Vector((-direction.y, direction.x))
    profile = ((0.0, 0.18), (0.18, 0.72), (0.68, 0.48), (0.9, 0.28), (1.0, 0.0))
    positive = []
    negative = []
    for fraction, factor in profile:
        center_x = start.x + (end.x - start.x) * fraction
        center_z = start.z + (end.z - start.z) * fraction
        positive.append((center_x + perpendicular.x * width * factor,
                         center_z + perpendicular.y * width * factor))
        negative.append((center_x - perpendicular.x * width * factor,
                         center_z - perpendicular.y * width * factor))
    return extruded_plate(parent, name, role, positive + list(reversed(negative[:-1])),
                          start.y - thickness * 0.5, thickness, min(0.02, thickness * 0.2))


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


def animate_object(obj, rotations=None, locations=None, scales=None, frames=FRAME_END, interpolation="BEZIER"):
    if rotations:
        obj.rotation_mode = "XYZ"
        for frame, rotation in rotations:
            obj.rotation_euler = rotation
            obj.keyframe_insert(data_path="rotation_euler", frame=frame, group="Idle")
    if locations:
        for frame, location in locations:
            obj.location = location
            obj.keyframe_insert(data_path="location", frame=frame, group="Idle")
    if scales:
        for frame, scale in scales:
            obj.scale = scale
            obj.keyframe_insert(data_path="scale", frame=frame, group="Idle")
    if obj.animation_data and obj.animation_data.action:
        action = obj.animation_data.action
        action.name = "Idle"
        for curve in action.fcurves:
            for point in curve.keyframe_points:
                point.interpolation = interpolation


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
    underside = mesh_object("Fractured rock under-platform", vertices, faces, "stone_dark", parent)
    fracture(underside, voxel_size=0.28, strength=0.16, decimate=0.18)
    finish(underside, "stone_dark", parent)


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
    fracture(obj, voxel_size=0.12, strength=0.06, decimate=0.18)
    return finish(obj, "stone_dark", parent)


def build_arena():
    root = clean_scene("arena", "arena", frames=1)
    platform_mesh(root)
    disk(root, "sigil", "glow", 3.2, 0.012, 128, "sigil", "fit")
    rng = random.Random(9143)
    for i in range(8):
        angle = math.tau * i / 8 + 0.11
        start_r = rng.uniform(7.65, 8.05)
        end_r = rng.uniform(8.5, 8.85)
        tapered_curve(root, "Rim fracture", "glow",
                      ((math.cos(angle) * start_r, math.sin(angle) * start_r, 0.015),
                       (math.cos(angle + 0.013) * (start_r + end_r) * 0.5,
                        math.sin(angle + 0.013) * (start_r + end_r) * 0.5, 0.016),
                       (math.cos(angle + 0.025) * end_r, math.sin(angle + 0.025) * end_r, 0.015)),
                      (0.8, 1.0, 0.12), 0.008, 8)
    for i in range(18):
        angle = rng.uniform(0, math.tau)
        inner = rng.uniform(4.1, 6.9)
        outer = rng.uniform(7.1, 8.8)
        middle = (inner + outer) * 0.5
        side = rng.uniform(-0.12, 0.12)
        points = (
            (math.cos(angle) * inner, math.sin(angle) * inner, 0.016),
            (math.cos(angle + side) * middle, math.sin(angle + side) * middle, 0.017),
            (math.cos(angle - side * 0.4) * outer, math.sin(angle - side * 0.4) * outer, 0.016),
        )
        tapered_curve(root, "Hairline floor fracture", "stone_dark",
                      points, (0.35, 1.0, 0.25), 0.024, 8)
    for i in range(10):
        angle = rng.uniform(0, math.tau)
        radius = rng.uniform(6.0, 8.4)
        size = rng.uniform(0.26, 0.56)
        rock_chunk(root, "Raised fractured floor slab", "stone",
                   (math.cos(angle) * radius, math.sin(angle) * radius, 0.02),
                   (size * 1.35, size, 0.08), 1700 + i, voxel=0.075, decimate=0.16)
    pillars = []
    for i in range(7):
        angle = math.tau * i / 7 + 0.2
        radius = rng.uniform(10.8, 11.8)
        height = rng.uniform(3.7, 5.7)
        pos = (math.cos(angle) * radius, math.sin(angle) * radius, -0.2)
        pillars.append((pos, height))
        pillar = pillar_mesh(root, f"Broken obelisk {i + 1}", pos, height, 220 + i)
        pillar.rotation_euler.x = rng.uniform(-0.14, 0.14)
        pillar.rotation_euler.y = rng.uniform(-0.18, 0.18)
        x = pos[0] + 0.22
        tapered_curve(root, "Pillar broken rib", "stone",
                      ((x, pos[1], 0.2), (x * 1.01, pos[1] + 0.07, height * 0.38),
                       (x * 1.02, pos[1], height * 0.78)),
                      (0.8, 1.0, 0.15), 0.12, 8)
        if i % 2 == 0:
            blade(root, "Gothic arch footing", "stone",
                  (pos[0], pos[1], height * 0.47),
                  (pos[0], pos[1], height * 0.64), 0.42, 0.16, 8)
    for i in range(0, 7, 2):
        (first, first_height), (second, second_height) = pillars[i], pillars[(i + 1) % 7]
        crown_z = min(first_height, second_height) * 0.88
        midpoint = ((first[0] + second[0]) * 0.5, (first[1] + second[1]) * 0.5)
        tapered_curve(root, "Broken pointed arch", "stone_dark",
                      ((first[0], first[1], first_height * 0.8),
                       (midpoint[0], midpoint[1], crown_z),
                       (second[0], second[1], second_height * 0.8)),
                      (0.9, 1.0, 0.08), 0.22, 10)
        tapered_curve(root, "Arch keystone spine", "stone",
                      ((midpoint[0] - 0.12, midpoint[1], crown_z - 0.55),
                       (midpoint[0], midpoint[1], crown_z),
                       (midpoint[0] + 0.12, midpoint[1], crown_z - 0.55)),
                      (0.65, 1.0, 0.65), 0.12, 8)
    for i in range(20):
        angle = rng.uniform(0, math.tau)
        radius = rng.uniform(12, 25)
        pos = (math.cos(angle) * radius, math.sin(angle) * radius, rng.uniform(-8, 6))
        size = rng.uniform(0.28, 0.82)
        rock_chunk(root, f"Floating debris {i + 1}", "stone_dark" if i % 3 else "stone",
                   pos, (size * 1.35, size, size * rng.uniform(0.72, 1.35)),
                   800 + i, voxel=max(0.075, size * 0.14), decimate=0.11)
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


def hugging_hand(parent, sign, wrist, frames=FRAME_END):
    """Open palm raised beside the face, fingers spread: the 🤗 gesture."""
    pivot = bpy.data.objects.new("Hugging hand pivot", None)
    bpy.context.scene.collection.objects.link(pivot)
    pivot.parent = parent
    pivot.location = wrist
    palm = ellipsoid(pivot, "Open palm", "cloth", (sign * 0.02, 0, 0.07),
                     (0.13, 0.055, 0.15), 12, 8)
    for index in range(4):
        spread = (index - 1.5) * 0.075
        length = 0.19 - abs(index - 1.5) * 0.03
        limb(pivot, "Spread finger", "cloth",
             (sign * 0.02 + spread, 0, 0.17),
             (sign * 0.02 + spread * 1.35, -0.02, 0.17 + length), 0.038, 0.8, 8)
    limb(pivot, "Spread thumb", "cloth",
         (sign * 0.12, 0, 0.05), (sign * 0.25, -0.03, 0.15), 0.042, 0.8, 8)
    animate_object(pivot, rotations=((1, (0, 0, 0)), (frames // 2, (0.05, sign * -0.14, 0)),
                                     (frames, (0, 0, 0))), frames=frames)
    return pivot


def build_player():
    root = clean_scene("player", "player")
    # Big round 🤗 head is the whole read of the character: brand-yellow ball,
    # squeezed happy eyes, wide smile, blush, and both open hands held beside it.
    head = ellipsoid(root, "Hugging face", "cloth", (0, 0, 1.42), (0.5, 0.48, 0.5), 24, 16)
    for sign in (-1, 1):
        x = sign * 0.19
        tapered_curve(root, "Happy eye", "deep",
                      ((x - 0.1, -0.415, 1.51), (x, -0.45, 1.57), (x + 0.1, -0.415, 1.51)),
                      (0.55, 1.0, 0.55), 0.028, 8)
        ellipsoid(root, "Blush", "accent", (sign * 0.36, -0.33, 1.4), (0.085, 0.035, 0.055), 10, 6)
    tapered_curve(root, "Wide smile", "deep",
                  ((-0.25, -0.405, 1.3), (0, -0.46, 1.18), (0.25, -0.405, 1.3)),
                  (0.5, 1.0, 0.5), 0.038, 10)
    ellipsoid(root, "Open mouth", "shade", (0, -0.43, 1.23), (0.17, 0.04, 0.06), 12, 8)
    # Compact hoodie body under the head, so the head stays the dominant shape.
    ellipsoid(root, "Hoodie torso", "cloth_dark", (0, 0, 0.72), (0.34, 0.28, 0.36), 16, 10)
    torus(root, "Hoodie collar", "cloth_dark", (0, -0.02, 0.98), 0.22, 0.06, (0, 0, 0), 20)
    bevelled_box(root, "Kangaroo pocket", "cloth_dark", (0, -0.27, 0.6), (0.34, 0.08, 0.16), 0.03)
    for sign in (-1, 1):
        limb(root, "Hoodie sleeve", "cloth_dark", (sign * 0.28, -0.02, 0.86),
             (sign * 0.6, -0.2, 1.05), 0.1, 0.8)
        limb(root, "Leg", "deep", (sign * 0.15, 0, 0.45), (sign * 0.17, 0, 0.1), 0.1, 0.85)
        ellipsoid(root, "Sneaker", "shade", (sign * 0.18, -0.06, 0.08), (0.13, 0.2, 0.09), 12, 8)
        ellipsoid(root, "Sneaker sole", "bone", (sign * 0.18, -0.06, 0.03), (0.135, 0.205, 0.03), 12, 6)
        hugging_hand(root, sign, (sign * 0.64, -0.22, 1.02))
    # A short chain still hangs from the right forearm: the git chain, kept
    # from the original summoner so the attack blade has something to belong to.
    for i in range(8):
        angle = i * math.tau / 8
        link = torus(root, "Forearm wrapped chain", "metal",
                     (0.5 + math.cos(angle) * 0.1, -0.14 + math.sin(angle) * 0.075,
                      0.98 - i * 0.012),
                     0.062, 0.016, (math.pi / 2, 0, angle), 8)
        rest = tuple(link.rotation_euler)
        animate_object(link, rotations=((1, rest), (49, (rest[0] + 0.06, rest[1], rest[2] + 0.08)),
                                        (FRAME_END, rest)))
    for i in range(7):
        angle = i * 0.42
        link = torus(root, "Chain weapon link", "metal",
                     (0.56 + 0.06 * math.sin(angle), -0.16, 0.86 - i * 0.065),
                     0.06, 0.016, (math.pi / 2, 0, (i % 2) * math.pi / 2), 8)
        rest = tuple(link.rotation_euler)
        animate_object(link, rotations=((1, rest), (49, (rest[0] + 0.08, rest[1], rest[2] + 0.1)),
                                        (FRAME_END, rest)))
    ellipsoid(root, "Chain weight", "metal", (0.57, -0.16, 0.36), (0.09, 0.09, 0.11), 10, 8)
    animate_idle(root, 0.03)
    animate_object(head, rotations=((1, (0, 0, 0)), (49, (0.04, 0.06, 0)), (FRAME_END, (0, 0, 0))))
    return root


def build_colossus(root):
    ellipsoid(root, "Hunched stone trunk", "deep", (0, 0.08, 2.48),
              (0.92, 0.68, 1.12), 16, 12)
    ellipsoid(root, "Ribbed chest core", "deep", (0, -0.49, 2.55),
              (0.71, 0.31, 0.79), 16, 12)
    ellipsoid(root, "Caved back hump", "shade", (0, 0.54, 3.08),
              (0.88, 0.57, 0.68), 14, 10)
    ellipsoid(root, "Sunken skull", "stone", (0, -0.3, 3.34),
              (0.4, 0.4, 0.43), 20, 14)
    for sign in (-1, 1):
        ellipsoid(root, "Eye socket", "shade", (sign * 0.18, -0.64, 3.4),
                  (0.13, 0.08, 0.09), 12, 8)
        ellipsoid(root, "Magma eye", "accent", (sign * 0.18, -0.705, 3.4),
                  (0.075, 0.032, 0.047), 8, 6, smooth=False)
        tapered_curve(root, "Broken crown horn", "stone_dark",
                      ((sign * 0.25, -0.18, 3.6), (sign * 0.37, -0.13, 3.91),
                       (sign * 0.52, -0.08, 4.25)),
                      (1.0, 0.62, 0.04), 0.18, 10)
        rock_chunk(root, "Jagged shoulder mantle", "stone",
                   (sign * 0.94, 0.03, 3.12), (0.73, 0.67, 0.7), 310 + sign, 0.13)
        for plate in range(3):
            rock_chunk(root, "Backgrown shoulder shard", "stone_dark" if plate == 1 else "stone",
                       (sign * (0.61 + plate * 0.22), 0.45 + plate * 0.14, 3.35 + plate * 0.19),
                       (0.36, 0.31, 0.28), 1250 + (sign + 1) * 5 + plate,
                       voxel=0.085, decimate=0.38)
        upper_arm = limb(root, "Heavy upper arm", "deep",
                         (sign * 0.92, 0.01, 2.94), (sign * 1.28, -0.07, 1.92), 0.42, 0.74, 12)
        forearm = limb(root, "Stone gauntlet", "stone_dark",
                       (sign * 1.28, -0.07, 1.96), (sign * 1.53, -0.22, 0.98), 0.52, 0.9, 12)
        fist = rock_chunk(root, "Knotted boulder fist", "stone",
                          (sign * 1.56, -0.27, 0.78), (0.48, 0.42, 0.43), 450 + sign, 0.105)
        for claw in range(4):
            x = sign * (1.3 + claw * 0.17)
            tapered_curve(root, "Knuckle dragging finger", "stone_dark",
                          ((x, -0.53, 0.96), (x + sign * 0.035, -0.7, 0.74),
                           (x + sign * 0.07, -0.72, 0.43)),
                          (1.0, 0.88, 0.1), 0.15, 8)
        for plate in range(3):
            rock_chunk(root, "Forearm fractured plate", "stone",
                       (sign * (1.36 + plate * 0.07), -0.4, 1.78 - plate * 0.29),
                       (0.32, 0.18, 0.22), 1350 + (sign + 1) * 4 + plate,
                       voxel=0.075, decimate=0.32)
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
    for i in range(4):
        z = 2.05 + i * 0.28
        offset = (i % 2) * 0.12
        tapered_curve(root, "Molten chest fissure", "accent",
                      ((-0.55 + offset, -0.69, z + 0.16),
                       (-0.27, -0.77, z + 0.03),
                       (0.02 + offset, -0.79, z + 0.13),
                       (0.34, -0.75, z - 0.02),
                       (0.55 - offset, -0.66, z + 0.08)),
                      (0.28, 0.85, 0.6, 1.0, 0.14), 0.025, 10)
    for sign in (-1, 1):
        for crack in range(3):
            z = 1.24 + crack * 0.27
            tapered_curve(root, "Molten arm fissure", "accent",
                          ((sign * 1.25, -0.32, z + 0.18),
                           (sign * 1.43, -0.5, z + 0.04),
                           (sign * 1.57, -0.47, z - 0.1)),
                          (0.2, 0.85, 0.08), 0.018, 8)


def build_hound(root):
    ellipsoid(root, "Long ribcage", "deep", (0, 0.16, 0.91),
              (0.36, 0.78, 0.26), 20, 14)
    ellipsoid(root, "Shoulder mass", "deep", (0, -0.52, 0.97),
              (0.39, 0.43, 0.39), 16, 12)
    neck = tube_mesh(root, "Rising wolf neck", "deep",
                     ((0, -0.56, 0.88), (0, -0.91, 1.19), (0, -1.19, 1.56),
                      (0, -1.43, 1.87)),
                     (0.31, 0.27, 0.22, 0.17), 12)
    skull = ellipsoid(root, "Long skull", "shade", (0, -1.48, 1.75),
                      (0.31, 0.5, 0.26), 20, 14)
    ellipsoid(root, "Upper jaw", "bone", (0, -1.81, 1.64),
              (0.23, 0.38, 0.09), 16, 10)
    ellipsoid(root, "Lower jaw", "deep", (0, -1.83, 1.4),
              (0.2, 0.34, 0.075), 16, 10)
    ellipsoid(root, "Glowing open maw", "accent", (0, -2.04, 1.52),
              (0.16, 0.035, 0.068), 12, 8, smooth=False)
    for sign in (-1, 1):
        ellipsoid(root, "Amber eye", "accent", (sign * 0.21, -1.82, 1.88),
                  (0.055, 0.036, 0.052), 8, 6, smooth=False)
        tapered_curve(root, "Long curved canine", "bone",
                      ((sign * 0.13, -1.96, 1.65), (sign * 0.16, -2.02, 1.51),
                       (sign * 0.12, -2.07, 1.36)),
                      (0.8, 0.56, 0.02), 0.075, 10)
        for tooth in range(4):
            x = sign * (0.05 + tooth * 0.045)
            tapered_curve(root, "Upper jaw tooth", "bone",
                          ((x, -2.01, 1.63), (x, -2.04, 1.53)),
                          (0.8, 0.02), 0.034, 6)
            tapered_curve(root, "Lower jaw tooth", "bone",
                          ((x, -2.03, 1.44), (x, -2.05, 1.53)),
                          (0.8, 0.02), 0.028, 6)
        for rib in range(6):
            z = 0.64 + rib * 0.105
            y = -0.88 + abs(rib - 2.5) * 0.025
            tapered_curve(root, "Raised rib ridge", "bone",
                          ((sign * 0.24, y, z - 0.12),
                           (sign * 0.4, y - 0.04, z - 0.08),
                           (sign * 0.51, y + 0.09, z),
                           (sign * 0.4, y + 0.21, z + 0.1),
                           (sign * 0.24, y + 0.18, z + 0.13)),
                          (0.02, 0.8, 1.0, 0.8, 0.02), 0.045, 2)
        for y, z in ((-0.55, 1.22), (0.02, 1.32), (0.48, 1.25), (0.72, 1.16)):
            tapered_curve(root, "Jagged neck spine", "bone",
                          ((sign * 0.05, y, z), (sign * 0.1, y + 0.1, z + 0.22),
                           (sign * 0.12, y + 0.18, z + 0.39)),
                          (1.0, 0.55, 0.02), 0.12, 8)
    legs = []
    for sign in (-1, 1):
        for front, y in ((True, -0.48), (False, 0.73)):
            hip_z = 1.02 if front else 0.94
            knee = (sign * 0.34, y + (0.2 if front else -0.19), 0.45)
            paw = (sign * 0.4, y + (0.17 if front else -0.02), 0.12)
            upper = limb(root, "Sinewed foreleg" if front else "Sinewed hindleg",
                         "deep", (sign * 0.36, y, hip_z), knee, 0.17 if front else 0.2, 0.7, 9)
            lower = limb(root, "Hock", "shade", knee, paw, 0.12, 0.68, 8)
            ellipsoid(root, "Bone paw", "bone", paw, (0.15, 0.22, 0.095), 12, 8)
            for claw in range(3):
                x = sign * (0.3 + claw * 0.09)
                tapered_curve(root, "Splayed paw claw", "bone",
                              ((x, paw[1] - 0.13, 0.105), (x + sign * 0.02, paw[1] - 0.22, 0.08),
                               (x + sign * 0.045, paw[1] - 0.31, 0.04)),
                              (0.85, 0.52, 0.02), 0.045, 8)
            legs.extend((upper, lower))
    tail = tapered_curve(root, "Whiplash tail", "deep",
                         ((0, 0.82, 0.93), (0.12, 1.2, 0.99), (0.02, 1.62, 1.18),
                          (-0.1, 2.02, 1.45), (0.02, 2.35, 1.62)),
                         (1.0, 0.86, 0.61, 0.34, 0.02), 0.18, 12)
    animate_object(tail, rotations=((1, (0, 0, 0)), (49, (0.12, 0.02, 0.1)),
                                    (FRAME_END, (0, 0, 0))))
    animate_object(neck, rotations=((1, (0, 0, 0)), (49, (0.025, 0, 0)),
                                    (FRAME_END, (0, 0, 0))))
    animate_idle(root, 0.015)
    root.scale.z = 1.08


def build_seraph(root):
    animate_idle(root, 0.1)
    chest = ellipsoid(root, "Slender porcelain cuirass", "deep", (0, 0.08, 2.25),
                      (0.42, 0.28, 0.62), 20, 14)
    extruded_plate(root, "Etched breastplate", "metal",
                   ((-0.32, 2.68), (-0.22, 2.86), (0.22, 2.86),
                    (0.32, 2.68), (0.24, 2.17), (0, 1.92), (-0.24, 2.17)),
                   -0.23, 0.11, 0.026)
    ellipsoid(root, "Shoulder mantle", "shade", (0, 0.13, 2.69),
              (0.62, 0.3, 0.21), 16, 10)
    mask = ellipsoid(root, "Porcelain oval mask", "bone", (0, -0.04, 3.1),
                     (0.29, 0.19, 0.36), 16, 12)
    ellipsoid(root, "Mask eye shadow", "shade", (0, -0.222, 3.11),
              (0.17, 0.03, 0.09), 14, 10)
    for sign in (-1, 1):
        ellipsoid(root, "Seraph eye glow", "accent", (sign * 0.1, -0.252, 3.13),
                  (0.042, 0.018, 0.03), 10, 8, smooth=False)
        tapered_curve(root, "Porcelain cheek ridge", "bone",
                      ((sign * 0.12, -0.2, 3.05), (sign * 0.2, -0.16, 2.99),
                       (sign * 0.24, -0.12, 2.9)),
                      (0.8, 0.55, 0.08), 0.035, 8)
        limb(root, "Armoured arm", "metal", (sign * 0.4, 0.04, 2.58),
             (sign * 0.5, -0.13, 1.9), 0.12, 0.62, 10)
        ellipsoid(root, "Seraph gauntlet", "bone", (sign * 0.5, -0.2, 1.86),
                  (0.12, 0.11, 0.14), 12, 8)

    halo_group = bpy.data.objects.new("Broken halo spin", None)
    bpy.context.scene.collection.objects.link(halo_group)
    halo_group.parent = root
    halo_group.location = (0, 0.12, 3.42)
    for segment in range(4):
        start_angle = segment * math.tau / 4 + 0.16
        end_angle = (segment + 1) * math.tau / 4 - 0.16
        points = [
            (math.cos(start_angle + (end_angle - start_angle) * step / 8) * 0.47,
             0,
             math.sin(start_angle + (end_angle - start_angle) * step / 8) * 0.47)
            for step in range(9)
        ]
        radii = [0.15 if step in (0, 8) else 1.0 for step in range(9)]
        tapered_curve(halo_group, "Cracked halo segment", "glow", points, radii, 0.045, 6)
    animate_object(halo_group, rotations=((1, (0, 0, 0)), (FRAME_END, (0, 0, math.tau))))

    wings = []
    for sign in (-1, 1):
        for pair, z in enumerate((2.74, 2.31, 1.88)):
            for blade_index in range(5):
                height_offsets = (
                    (0.88, 0.66, 0.44, 0.22, 0.02),
                    (0.36, 0.19, 0.02, -0.15, -0.3),
                    (0.06, -0.2, -0.43, -0.65, -0.84),
                )[pair]
                start = (sign * (0.37 + pair * 0.025), 0.16 + pair * 0.06, z)
                end = (sign * (0.73 + blade_index * 0.255),
                       0.18 + blade_index * 0.012,
                       z + height_offsets[blade_index])
                wing = sword_blade(root, "Layered sword wing", "bone", start, end,
                                   0.075 - blade_index * 0.004, 0.065)
                wing.rotation_euler.y = sign * (pair - 1) * 0.035
                wings.append((wing, sign, pair))
                if blade_index % 2 == 0:
                    cross = (sign * (0.43 + pair * 0.025), 0.14 + pair * 0.06, z + 0.05)
                    tapered_curve(root, "Wing blade crossguard", "metal",
                                  ((cross[0] - 0.09, cross[1], cross[2] - 0.03),
                                   (cross[0], cross[1] - 0.025, cross[2] + 0.01),
                                   (cross[0] + 0.09, cross[1], cross[2] + 0.05)),
                                  (0.08, 1.0, 0.08), 0.032, 8)
    for wing, sign, pair in wings:
        rest = tuple(wing.rotation_euler)
        animate_object(wing, rotations=((1, rest),
                                        (49, (rest[0], rest[1] + sign * 0.04, rest[2])),
                                        (FRAME_END, rest)))

    for index in range(8):
        x = -0.36 + index * 0.103
        sway = (-1 if index % 2 else 1) * (0.12 + index * 0.015)
        robe = tapered_curve(root, "Trailing ribbon robe", "shade",
                             ((x * 0.45, 0.12, 1.82),
                              (x + sway, 0.22, 1.18),
                              (x - sway * 0.45, 0.16, 0.68),
                              (x + sway, 0.24, 0.12 + (index % 3) * 0.07)),
                             (1.0, 0.86, 0.48, 0.015), 0.12, 8)
        rest = tuple(robe.rotation_euler)
        animate_object(robe, rotations=((1, rest), (49, (rest[0] + 0.045, rest[1], rest[2] + 0.035)),
                                        (FRAME_END, rest)))


def build_serpent(root):
    coil_points = []
    coil_radii = []
    for i in range(65):
        t = i / 64
        angle = -math.pi / 2 + math.tau * 2.0 * t
        radius = 1.65 - 1.3 * t
        coil_points.append((math.cos(angle) * radius, math.sin(angle) * radius + 0.12, 0.31))
        coil_radii.append(0.55 + math.sin(math.pi * t) * 0.45 - 0.28 * t)
    coil = tapered_curve(root, "Tapered spiral coil", "deep", coil_points,
                         coil_radii, 0.34, 4)
    for i in range(40):
        t = 0.02 + i / 42
        angle = -math.pi / 2 + math.tau * 2.0 * t
        radius = 1.65 - 1.3 * t
        x, y = math.cos(angle) * radius, math.sin(angle) * radius + 0.12
        curve_radius = 0.55 + math.sin(math.pi * t) * 0.45 - 0.28 * t
        ground_plate(root, "Coil overlapping scale", "shade",
                     (x, y, 0.31 + 0.34 * curve_radius * 0.88),
                     angle + math.pi / 2, 0.34 - t * 0.06, 0.23, 0.045)

    neck = tapered_curve(root, "S-curve rising neck", "deep",
                         ((0, -0.12, 0.39), (0, -0.18, 0.9),
                          (0.15, -0.26, 1.48), (0.1, -0.18, 2.04),
                          (0, -0.14, 2.48)),
                         (1.0, 0.94, 0.78, 0.7, 0.55), 0.36, 14)
    for i in range(10):
        z = 0.74 + i * 0.16
        width = 0.28 - i * 0.012
        extruded_plate(root, "Segmented ventral scute", "shade",
                       ((-width, z - 0.065), (-width * 0.76, z + 0.035),
                        (width * 0.76, z + 0.035), (width, z - 0.065),
                        (0, z - 0.105)),
                       -0.42 + i * 0.015, 0.075, 0.012)

    hood_vertices = []
    hood_faces = []
    columns = 20
    rows = (0.0, 0.18, 0.38, 0.6, 0.82, 1.0)
    for row, t in enumerate(rows):
        width = 0.16 + 0.8 * math.sin(math.pi * t * 0.82)
        z = 2.36 + t * 0.83
        for column in range(columns + 1):
            u = column / columns * 2 - 1
            y = 0.04 + abs(u) * 0.1 - (1 - abs(u)) * 0.09
            hood_vertices.append((u * width, y, z + abs(u) * 0.08))
    for row in range(len(rows) - 1):
        for column in range(columns):
            a = row * (columns + 1) + column
            hood_faces.append((a, a + 1, a + columns + 2, a + columns + 1))
    hood = mesh_object("Flared cobra hood membrane", hood_vertices, hood_faces,
                       "shade", root, smooth=True)
    solidify = hood.modifiers.new("Hood membrane thickness", "SOLIDIFY")
    solidify.thickness = 0.065
    apply_modifier(hood, solidify)
    for sign in (-1, 1):
        for ridge in range(5):
            spread = ridge / 4
            tapered_curve(root, "Raised cobra hood rib", "bone",
                          ((sign * (0.12 + spread * 0.15), -0.11, 2.45),
                           (sign * (0.27 + spread * 0.22), -0.1, 2.72),
                           (sign * (0.38 + spread * 0.52), 0.02, 3.05)),
                          (0.55, 0.8, 0.06), 0.055, 6)
    ellipsoid(root, "Narrow serpent skull", "deep", (0, -0.34, 2.87),
              (0.27, 0.36, 0.24), 20, 14)
    ellipsoid(root, "Serpent lower jaw", "shade", (0, -0.55, 2.7),
              (0.2, 0.27, 0.09), 14, 10)
    for sign in (-1, 1):
        ellipsoid(root, "Serpent ember eye", "accent",
                  (sign * 0.13, -0.62, 2.94), (0.045, 0.025, 0.035), 10, 8, smooth=False)
        tapered_curve(root, "Curved cobra fang", "bone",
                      ((sign * 0.13, -0.64, 2.78), (sign * 0.18, -0.73, 2.6),
                       (sign * 0.12, -0.78, 2.42)),
                      (0.9, 0.62, 0.02), 0.09, 8)
    animate_object(neck, rotations=((1, (0, 0, 0)), (49, (0, 0.03, 0.045)),
                                    (FRAME_END, (0, 0, 0))))
    animate_idle(root, 0.045)


def build_knight(root):
    body = ellipsoid(root, "Armoured body", "deep", (0, 0.08, 1.65),
                     (0.43, 0.33, 0.7), 20, 14)
    chest = extruded_plate(root, "Forged breastplate", "metal",
                           ((-0.35, 2.28), (-0.43, 2.08), (-0.39, 1.78),
                            (-0.23, 1.55), (0, 1.49), (0.23, 1.55),
                            (0.39, 1.78), (0.43, 2.08), (0.35, 2.28),
                            (0.18, 2.38), (-0.18, 2.38)),
                           -0.44, 0.16, 0.045)
    extruded_plate(root, "Raised cuirass gorget", "metal",
                   ((-0.27, 2.36), (-0.37, 2.09), (0, 1.98),
                    (0.37, 2.09), (0.27, 2.36), (0, 2.47)),
                   -0.43, 0.09, 0.025)
    helm = bevelled_box(root, "Great helm", "metal", (0, 0.02, 2.63),
                        (0.69, 0.58, 0.68), 0.17, 4)
    bevelled_box(root, "Helm brow", "metal", (0, -0.32, 2.88),
                 (0.64, 0.12, 0.14), 0.045, 3)
    visor = bevelled_box(root, "Visor cross slit", "accent", (0, -0.37, 2.67),
                         (0.48, 0.045, 0.055), 0.016, 2)
    animate_object(visor, scales=((1, tuple(visor.scale)), (49, (1.08, 1, 1.35)),
                                  (FRAME_END, tuple(visor.scale))))
    tapered_curve(root, "Visor center slit", "accent",
                  ((0, -0.397, 2.48), (0, -0.4, 2.65), (0, -0.4, 2.79)),
                  (0.8, 1.0, 0.05), 0.032, 8)
    for sign in (-1, 1):
        tapered_curve(root, "Visor fork slit", "accent",
                      ((sign * 0.045, -0.4, 2.67), (sign * 0.13, -0.4, 2.76),
                       (sign * 0.22, -0.39, 2.81)),
                      (0.12, 1.0, 0.05), 0.025, 8)
    for sign in (-1, 1):
        for row in range(3):
            center_x = sign * (0.62 + row * 0.025)
            center_z = 2.23 - row * 0.15
            width = 0.32 - row * 0.035
            extruded_plate(root, "Stacked pauldron plate", "metal",
                           ((center_x - width, center_z + 0.12),
                            (center_x - width * 0.78, center_z + 0.2),
                            (center_x + width * 0.65, center_z + 0.16),
                            (center_x + width, center_z - 0.05),
                            (center_x + width * 0.44, center_z - 0.17),
                            (center_x - width * 0.58, center_z - 0.1)),
                           -0.29 - row * 0.015, 0.11, 0.035)
        for rivet in range(3):
            ellipsoid(root, "Pauldron rivet", "bone",
                      (sign * (0.49 + rivet * 0.13), -0.37, 2.25 - rivet * 0.12),
                      (0.035, 0.022, 0.035), 8, 6, smooth=False)
        limb(root, "Armoured upper arm", "metal",
             (sign * 0.6, 0.03, 2.03), (sign * 0.37, -0.4, 1.54), 0.19, 0.72, 12)
        limb(root, "Armoured forearm", "deep",
             (sign * 0.37, -0.4, 1.54), (sign * 0.16, -0.62, 1.99), 0.15, 0.72, 10)
        ellipsoid(root, "Sword gripping gauntlet", "metal", (sign * 0.13, -0.65, 1.98),
                  (0.15, 0.12, 0.13), 14, 10)
        for finger in range(3):
            x = sign * (0.04 + finger * 0.065)
            tapered_curve(root, "Gauntlet finger plate", "metal",
                          ((x, -0.76, 2.02), (x, -0.79, 1.93), (x, -0.75, 1.87)),
                          (0.8, 1.0, 0.25), 0.035, 8)
        limb(root, "Greave", "metal", (sign * 0.25, 0.04, 1.17),
             (sign * 0.34, -0.08, 0.31), 0.18, 0.72, 12)
        extruded_plate(root, "Greave front plate", "metal",
                       ((sign * 0.18, 1.02), (sign * 0.32, 1.08),
                        (sign * 0.43, 0.42), (sign * 0.33, 0.24),
                        (sign * 0.22, 0.4)),
                       -0.29, 0.08, 0.025)
        bevelled_box(root, "Sabatons", "deep",
                     (sign * 0.34, -0.2, 0.18), (0.31, 0.5, 0.2), 0.075, 3)
        for toe in range(3):
            tapered_curve(root, "Sabatons toe ridge", "metal",
                          ((sign * (0.24 + toe * 0.09), -0.42, 0.21),
                           (sign * (0.24 + toe * 0.09), -0.51, 0.17)),
                          (0.8, 0.3), 0.022, 6)
        tapered_curve(root, "Swept horn", "metal",
                      ((sign * 0.25, 0.0, 2.85), (sign * 0.36, 0.02, 3.12),
                       (sign * 0.58, 0.08, 3.35), (sign * 0.71, 0.12, 3.58)),
                      (1.0, 0.72, 0.36, 0.02), 0.15, 14)
        tapered_curve(root, "Horn ridge", "bone",
                      ((sign * 0.34, -0.02, 3.08), (sign * 0.54, 0.01, 3.31),
                       (sign * 0.68, 0.05, 3.48)),
                      (0.42, 0.28, 0.02), 0.028, 10)
    for row, z in enumerate((1.62, 1.48, 1.34)):
        width = 0.41 - row * 0.035
        bevelled_box(root, "Overlapping fauld plate", "metal",
                     (0, -0.36, z), (width * 2, 0.15, 0.16), 0.045, 3)
    tabard = cloak_panel(root, "Torn knight tabard", "cloth", 0, 1.42, 0.58,
                         0.39, -0.47, 0.14)
    back_tabard = cloak_panel(root, "Rear knight tabard", "cloth_dark", 0, 1.42, 0.58,
                              0.36, 0.28, 0.15)
    for panel, sign in ((tabard, 1), (back_tabard, -1)):
        animate_object(panel, rotations=((1, tuple(panel.rotation_euler)),
                                         (49, (sign * 0.035, 0, sign * 0.03)),
                                         (FRAME_END, tuple(panel.rotation_euler))))
    for sign in (-1, 1):
        for panel in range(2):
            extruded_plate(root, "Tabard torn hem", "cloth",
                           ((sign * (0.1 + panel * 0.16), 0.46),
                            (sign * (0.28 + panel * 0.08), 0.7),
                            (sign * (0.37 + panel * 0.02), 0.44),
                            (sign * (0.22 + panel * 0.1), 0.55)),
                           -0.53, 0.045, 0.008)
    for sign in (-1, 1):
        limb(root, "Tabard seam", "cloth_dark",
             (sign * 0.09, -0.49, 1.42), (sign * 0.13, -0.49, 0.2), 0.025, 0.3, 5)
    for z in (1.66, 1.82, 1.98):
        bevelled_box(root, "Cuirass engraved rib", "shade",
                     (0, -0.414, z), (0.52, 0.035, 0.045), 0.018, 2)
    sword = sword_blade(root, "Point-down cruciform greatsword", "metal",
                        (0, -0.61, 1.76), (0, -0.61, 0.025), 0.19, 0.11)
    tapered_curve(root, "Greatsword fuller", "stone_dark",
                  ((0, -0.674, 0.23), (0, -0.674, 0.82), (0, -0.674, 1.62)),
                  (0.12, 0.2, 0.08), 0.022, 10)
    extruded_plate(root, "Cruciform sword crossguard", "metal",
                   ((-0.42, 1.72), (-0.32, 1.84), (-0.12, 1.77),
                    (0.12, 1.77), (0.32, 1.84), (0.42, 1.72),
                    (0.28, 1.66), (0, 1.71), (-0.28, 1.66)),
                   -0.65, 0.14, 0.035)
    tapered_curve(root, "Sword leather grip", "cloth_dark",
                  ((0, -0.61, 1.8), (0, -0.61, 2.04), (0, -0.61, 2.18)),
                  (1.0, 1.0, 0.78), 0.07, 10)
    torus(root, "Sword grip ring", "metal", (0, -0.61, 1.98), 0.078, 0.018,
          (math.pi / 2, 0, 0), 16)
    ellipsoid(root, "Crown pommel", "bone", (0, -0.61, 2.23),
              (0.12, 0.11, 0.12), 12, 8)
    animate_idle(root, 0.05)
    animate_object(chest, locations=((1, tuple(chest.location)),
                                     (49, (chest.location.x, chest.location.y, chest.location.z + 0.03)),
                                     (FRAME_END, tuple(chest.location))))


def build_swarm(root):
    ellipsoid(root, "Caged heart", "deep", (0, 0, 1.53),
              (0.43, 0.42, 0.55), 16, 12)
    ellipsoid(root, "Singularity core", "accent", (0, -0.38, 1.56),
              (0.22, 0.075, 0.28), 16, 12, smooth=False)
    for rib in range(10):
        azimuth = math.tau * rib / 10
        start_angle = 0.12 + (rib % 3) * 0.06
        end_angle = math.pi - 0.16 - (rib % 4) * 0.055
        points = []
        radii = []
        for i in range(11):
            t = start_angle + (end_angle - start_angle) * i / 10
            swell = math.sin(t)
            radius = 0.035 + 0.19 * swell
            points.append((math.cos(azimuth) * 0.67 * swell,
                           math.sin(azimuth) * 0.48 * swell - 0.01,
                           1.53 + math.cos(t) * 0.83))
            radii.append(0.15 if i in (0, 10) else 0.82 + swell * 0.2)
        tapered_curve(root, "Broken bone cage rib", "bone", points, radii, 0.085, 10)
    for i in range(40):
        angle = i * math.tau / 40
        orbit = i % 4
        radius = 0.9 + 0.42 * math.sin(i * 2.6)
        z = 0.5 + (i % 9) * 0.25
        size = 0.14 + (i % 4) * 0.045
        pos = (math.cos(angle) * radius, math.sin(angle) * radius, z)
        role = "bone" if i % 7 == 0 else "deep"
        if i % 3 == 0:
            shard = rock_chunk(root, "Floating fractured shard", role, pos,
                               (size * 0.58, size * 0.72, size * 1.65),
                               2200 + i, voxel=0.04, decimate=0.28)
        else:
            shard = blade(root, "Orbiting crystal splinter", role,
                          (pos[0] - size * 0.36, pos[1], pos[2] - size),
                          (pos[0] + size * 0.24, pos[1] + size * 0.08, pos[2] + size * 1.1),
                          size * 0.72, 0.045, 8)
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
    asset_names = ("arena", "player", *(f"boss_{name}" for name in BOSSES))
    parser.add_argument("asset", nargs="?", choices=asset_names)
    args = parser.parse_args(argv)
    output = os.path.abspath(args.out)
    os.makedirs(output, exist_ok=True)
    sizes = []
    if args.asset:
        if args.asset == "arena":
            build_arena()
        elif args.asset == "player":
            build_player()
        else:
            build_boss(args.asset.removeprefix("boss_"))
        sizes.append(export_asset(args.asset, output))
    else:
        for name, builder in (("arena", build_arena), ("player", build_player)):
            builder()
            sizes.append(export_asset(name, output))
        for silhouette, builder in BOSSES.items():
            build_boss(silhouette)
            sizes.append(export_asset(f"boss_{silhouette}", output))
    total = sum(
        os.path.getsize(os.path.join(output, f"{name}.glb"))
        for name in asset_names
        if os.path.exists(os.path.join(output, f"{name}.glb"))
    )
    if total > 15 * 1024 * 1024:
        raise RuntimeError(f"model library exceeds 15 MB: {total:,} bytes")
    print(f"TOTAL: {total:,} bytes")


if __name__ == "__main__":
    main()
