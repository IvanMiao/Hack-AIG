import argparse
import contextlib
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
# Visible stone radius; must match ARENA_FLOOR_RADIUS in src/sim/constants.ts (playable disc + boss apron).
ARENA_RADIUS = 29.0
# Arena geometry was authored for a 9 m platform; horizontal extents are scaled by this factor.
ARENA_SCALE = ARENA_RADIUS / 9.0
FRAME_END = 97
# Every character exports the same named clips. `idle`/`move` loop and are cross-faded by ground speed; the
# rest are one-shots the runtime scrubs from sim state (attack phases, hit flash, death timer) or loops (stagger).
CLIP_FRAMES = {
    "idle": FRAME_END,
    "move": 41,
    "light": 25,
    "heavy": 25,
    "attack_melee": 25,
    "attack_ranged": 25,
    "hit": 13,
    "stagger": 49,
    "death": 49,
}
# Attack clips share one layout so the runtime can map windup/active/recover onto it regardless of their
# real durations: rest -> anticipation by WINDUP, contact by STRIKE, held until HOLD, back to rest by 1.
# Mirrors ATTACK_LAYOUT in src/game/locomotion.ts.
WINDUP, STRIKE, HOLD = 1 / 3, 1 / 2, 0.66
ZERO = (0, 0, 0)
CURRENT_CLIP = "idle"
RNG = random.Random(7251)
MATERIALS = {}
CURRENT_PROFILE = {}
TEXTURE_IMAGES = {}
CURRENT_TEXTURE_SIZE = 1024
CURRENT_ASSET = ""
SMALL_TEXTURES = {"bone", "sigil"}
DOWNSAMPLED_TEXTURES = {"boss_knight": {"cloth", "rock"}, "boss_swarm": {"rock"}}
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
        # Generated images have no file behind them; the glTF exporter writes them as solid black unless packed.
        image.pack()
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
    # Geometry is authored in world space; joints carry their own origin, so express the part relative to it.
    obj.location = Vector(obj.location) - world_origin(parent)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    if bm.faces:
        bmesh.ops.dissolve_degenerate(bm, edges=list(bm.edges), dist=1e-4)
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


def world_origin(obj):
    """Build-time joints are unrotated, so an object's world origin is the sum of locations up the chain."""
    origin = Vector((0, 0, 0))
    while obj is not None:
        origin += Vector(obj.location)
        obj = obj.parent
    return origin


def joint(parent, name, location):
    """An empty placed at an articulation point; parts parented to it rotate about that point."""
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = "PLAIN_AXES"
    obj.empty_display_size = 0.08
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = parent
    obj.rotation_mode = "XYZ"
    obj.location = Vector(location) - world_origin(parent)
    return obj


def settle(obj, floor=0.0):
    """Shift a part vertically so its lowest vertex rests on `floor` (world Z)."""
    bpy.context.view_layer.update()
    lowest = min((obj.matrix_world @ vertex.co).z for vertex in obj.data.vertices)
    obj.location.z += floor - lowest


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


def set_interpolation(obj, interpolation):
    if obj.animation_data and obj.animation_data.action:
        for curve in obj.animation_data.action.fcurves:
            for point in curve.keyframe_points:
                point.interpolation = interpolation


def animate_object(obj, rotations=None, locations=None, scales=None, frames=FRAME_END, interpolation="BEZIER"):
    if rotations:
        obj.rotation_mode = "XYZ"
        for frame, rotation in rotations:
            obj.rotation_euler = rotation
            obj.keyframe_insert(data_path="rotation_euler", frame=frame, group=CURRENT_CLIP)
    if locations:
        for frame, location in locations:
            obj.location = location
            obj.keyframe_insert(data_path="location", frame=frame, group=CURRENT_CLIP)
    if scales:
        for frame, scale in scales:
            obj.scale = scale
            obj.keyframe_insert(data_path="scale", frame=frame, group=CURRENT_CLIP)
    set_interpolation(obj, interpolation)


def oscillate(obj, frames, rotation=(0, 0, 0), location=(0, 0, 0), scale=(0, 0, 0),
              cycles=1, phase=0.0, shape="sin", samples=8):
    """
    Sinusoidal loop around the object's rest transform. `cycles` full waves span the clip so the loop is
    seamless; `shape="bounce"` uses |sin| for footfall-style bobs that never dip below rest and
    `shape="lift"` is a smooth 0..1 raised cosine for grounded idles that must not sink into the floor.
    """
    rest_rotation = Vector(obj.rotation_euler)
    rest_location = obj.location.copy()
    rest_scale = obj.scale.copy()
    obj.rotation_mode = "XYZ"
    count = max(4, int(round(samples * cycles)))
    for step in range(count + 1):
        t = step / count
        frame = 1 + t * (frames - 1)
        wave = math.sin(math.tau * cycles * t + phase)
        if shape == "bounce":
            wave = abs(wave)
        elif shape == "lift":
            wave = (1 - math.cos(math.tau * cycles * t + phase)) / 2
        if any(rotation):
            obj.rotation_euler = rest_rotation + Vector(rotation) * wave
            obj.keyframe_insert(data_path="rotation_euler", frame=frame, group=CURRENT_CLIP)
        if any(location):
            obj.location = rest_location + Vector(location) * wave
            obj.keyframe_insert(data_path="location", frame=frame, group=CURRENT_CLIP)
        if any(scale):
            obj.scale = rest_scale + Vector(scale) * wave
            obj.keyframe_insert(data_path="scale", frame=frame, group=CURRENT_CLIP)
    set_interpolation(obj, "BEZIER")
    obj.rotation_euler = rest_rotation
    obj.location = rest_location
    obj.scale = rest_scale


def spin(obj, frames, axis=2, turns=1.0):
    """Constant-rate rotation about one local axis; whole `turns` keep the loop seamless."""
    rest = Vector(obj.rotation_euler)
    end = rest.copy()
    end[axis] += math.tau * turns
    animate_object(obj, rotations=((1, tuple(rest)), (frames, tuple(end))), interpolation="LINEAR")


def orbit(obj, frames, centre, radius, start_angle, turns, z, samples_per_turn=16):
    """Circular path about `centre` (parent space) with matching yaw, sampled densely so chords stay round."""
    rest_rotation = Vector(obj.rotation_euler)
    count = max(8, int(round(samples_per_turn * abs(turns))))
    for step in range(count + 1):
        t = step / count
        angle = start_angle + math.tau * turns * t
        obj.location = (centre[0] + math.cos(angle) * radius, centre[1] + math.sin(angle) * radius, z)
        obj.rotation_euler = (rest_rotation[0] + angle - start_angle, rest_rotation[1],
                              rest_rotation[2] + angle - start_angle)
        obj.keyframe_insert(data_path="location", frame=1 + t * (frames - 1), group=CURRENT_CLIP)
        obj.keyframe_insert(data_path="rotation_euler", frame=1 + t * (frames - 1), group=CURRENT_CLIP)
    set_interpolation(obj, "LINEAR")


def pose(obj, frames, *keys):
    """
    One-shot clip keys for `obj`: each key is (fraction, rotation[, location[, scale]]) as offsets from rest,
    eased between with Bezier handles. Fractions are 0..1 of the clip.
    """
    rest_rotation = Vector(obj.rotation_euler)
    rest_location = obj.location.copy()
    rest_scale = obj.scale.copy()
    rotations, locations, scales = [], [], []
    for fraction, rotation, *extra in keys:
        frame = 1 + fraction * (frames - 1)
        rotations.append((frame, tuple(rest_rotation + Vector(rotation))))
        if extra and extra[0] is not None:
            locations.append((frame, tuple(rest_location + Vector(extra[0]))))
        if len(extra) > 1 and extra[1] is not None:
            scales.append((frame, tuple(rest_scale + Vector(extra[1]))))
    animate_object(obj, rotations=rotations, locations=locations or None, scales=scales or None)
    obj.rotation_euler = rest_rotation
    obj.location = rest_location
    obj.scale = rest_scale


def strike_keys(windup, contact, location=None, scale=None):
    """Attack layout keys: rest, anticipation at WINDUP, contact at STRIKE held to HOLD, rest at 1."""
    loc = location or (None, None)
    scl = scale or (None, None)
    rest_loc = ZERO if location else None
    rest_scl = ZERO if scale else None
    return (
        (0, ZERO, rest_loc, rest_scl),
        (WINDUP, windup, loc[0], scl[0]),
        (STRIKE, contact, loc[1], scl[1]),
        (HOLD, contact, loc[1], scl[1]),
        (1, ZERO, rest_loc, rest_scl),
    )


def flinch(obj, frames, rotation, peak=0.3):
    pose(obj, frames, (0, ZERO), (peak, rotation), (1, ZERO))


def hold(obj, frames, base, rotation=ZERO, location=ZERO, cycles=1, phase=0.0):
    """Looping sway about an offset pose (stagger tremble). Static when no wave is given."""
    rest_rotation = Vector(obj.rotation_euler)
    rest_location = obj.location.copy()
    obj.rotation_euler = rest_rotation + Vector(base)
    if any(rotation) or any(location):
        oscillate(obj, frames, rotation=rotation, location=location, cycles=cycles, phase=phase)
    else:
        held = tuple(obj.rotation_euler)
        animate_object(obj, rotations=((1, held), (frames, held)))
    obj.rotation_euler = rest_rotation
    obj.location = rest_location


def stride(hip, knee, frames, swing, bend, phase, elbow=False):
    """
    Two-segment limb gait: the hip/shoulder swings sinusoidally while the knee/elbow flexes once per cycle with
    a raised-cosine so it never hyper-extends. Knees bend most mid-swing (as the leg passes under the body);
    elbows bend most when the arm is forward.
    """
    oscillate(hip, frames, rotation=(swing, 0, 0), phase=phase)
    if knee is None:
        return
    if elbow:
        oscillate(knee, frames, rotation=(-bend, 0, 0), phase=phase - math.pi / 2, shape="lift")
    else:
        oscillate(knee, frames, rotation=(bend, 0, 0), phase=phase, shape="lift")


def ground(root, frames):
    """
    Floor clamp for the clip being authored: sample every frame, and wherever the lowest mesh point would dip
    below z=0 (a swinging leg's toe, a folded shin, a toppling body) key the root that much higher. Sampled
    first and keyed after so inserting keys does not perturb later samples.
    """
    scene = bpy.context.scene
    meshes = [obj for obj in scene.objects if obj.type == "MESH"]
    lifts = []
    for frame in range(1, frames + 1):
        scene.frame_set(frame)
        depsgraph = bpy.context.evaluated_depsgraph_get()
        lowest = min(
            (obj.evaluated_get(depsgraph).matrix_world @ Vector(corner)).z
            for obj in meshes
            for corner in obj.bound_box
        )
        lifts.append((frame, root.location.copy(), max(0.0, -lowest)))
    if not any(lift for _, _, lift in lifts):
        return
    for frame, location, lift in lifts:
        root.location = (location.x, location.y, location.z + lift)
        root.keyframe_insert(data_path="location", frame=frame, group=CURRENT_CLIP)
    for curve in root.animation_data.action.fcurves:
        if curve.data_path == "location":
            for point in curve.keyframe_points:
                point.interpolation = "LINEAR"
    scene.frame_set(1)


@contextlib.contextmanager
def clip(name, ground_root=None):
    """
    Author one named clip across the whole scene. Keys land on each object's active action; on exit the actions
    are pushed to muted NLA tracks named after the clip (the glTF exporter merges same-named tracks into one
    animation) and every object is returned to its rest transform so later clips and the export start from rest.
    Grounded characters pass their root as `ground_root` to have the clip floor-clamped (see `ground`).
    """
    global CURRENT_CLIP
    frames = CLIP_FRAMES[name]
    CURRENT_CLIP = name
    scene = bpy.context.scene
    scene.frame_end = max(scene.frame_end, frames)
    rest = {obj: (obj.location.copy(), obj.rotation_euler.copy(), obj.scale.copy()) for obj in scene.objects}
    yield frames
    if ground_root is not None:
        ground(ground_root, frames)
    for obj in scene.objects:
        data = obj.animation_data
        if data and data.action:
            action = data.action
            action.name = f"{obj.name}|{name}"
            track = data.nla_tracks.new()
            track.name = name
            track.strips.new(action.name, 1, action)
            track.mute = True
            data.action = None
        if obj in rest:
            obj.location, obj.rotation_euler, obj.scale = rest[obj]
    CURRENT_CLIP = "idle"


def bob(root, frames, amplitude, cycles=1, shape="sin", samples=8):
    """Whole-body vertical float/footfall on the root."""
    oscillate(root, frames, location=(0, 0, amplitude), cycles=cycles, shape=shape, samples=samples)


def platform_mesh(parent):
    rng = random.Random(7251)
    segments = 64
    ring_count = max(6, round(ARENA_RADIUS / 1.5))
    radii = tuple(ARENA_RADIUS * (ring + 1) / ring_count for ring in range(ring_count))
    vertices = [(0, 0, 0)]
    for ring, radius in enumerate(radii):
        for i in range(segments):
            angle = math.tau * i / segments
            jitter = 1 + rng.uniform(-0.018, 0.018) * (1.0 + ring / (ring_count - 1)) / ARENA_SCALE
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
            vertices.append((math.cos(angle) * radius * ARENA_SCALE * jitter,
                             math.sin(angle) * radius * ARENA_SCALE * jitter, z))
    for layer in range(len(levels) - 1):
        top, bottom = layer * segments, (layer + 1) * segments
        for i in range(segments):
            j = (i + 1) % segments
            faces.extend(((top + i, top + j, bottom + j),
                          (top + i, bottom + j, bottom + i)))
    faces.append(tuple(range((len(levels) - 1) * segments, len(levels) * segments)))
    underside = mesh_object("Fractured rock under-platform", vertices, faces, "stone_dark", parent)
    fracture(underside, voxel_size=0.28 * ARENA_SCALE, strength=0.16, decimate=0.18)
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
    disk(root, "sigil", "glow", 3.2 * math.sqrt(ARENA_SCALE), 0.012, 128, "sigil", "fit")
    rng = random.Random(9143)
    # Detail counts grow gently with the platform: the GLB has a 2.5 MB / 60k-triangle budget.
    count = lambda base, growth=1.3: max(base, round(base * growth))
    rim_count = count(8, 1.5)
    for i in range(rim_count):
        angle = math.tau * i / rim_count + 0.11
        start_r = rng.uniform(7.65, 8.05) * ARENA_SCALE
        end_r = rng.uniform(8.5, 8.85) * ARENA_SCALE
        tapered_curve(root, "Rim fracture", "glow",
                      ((math.cos(angle) * start_r, math.sin(angle) * start_r, 0.015),
                       (math.cos(angle + 0.013) * (start_r + end_r) * 0.5,
                        math.sin(angle + 0.013) * (start_r + end_r) * 0.5, 0.016),
                       (math.cos(angle + 0.025) * end_r, math.sin(angle + 0.025) * end_r, 0.015)),
                      (0.8, 1.0, 0.12), 0.008, 6)
    for i in range(count(18)):
        angle = rng.uniform(0, math.tau)
        inner = rng.uniform(4.1, 6.9) * ARENA_SCALE
        outer = rng.uniform(7.1, 8.8) * ARENA_SCALE
        middle = (inner + outer) * 0.5
        side = rng.uniform(-0.12, 0.12)
        points = (
            (math.cos(angle) * inner, math.sin(angle) * inner, 0.016),
            (math.cos(angle + side) * middle, math.sin(angle + side) * middle, 0.017),
            (math.cos(angle - side * 0.4) * outer, math.sin(angle - side * 0.4) * outer, 0.016),
        )
        tapered_curve(root, "Hairline floor fracture", "stone_dark",
                      points, (0.35, 1.0, 0.25), 0.024, 5)
    for i in range(count(10)):
        angle = rng.uniform(0, math.tau)
        radius = rng.uniform(2.5, 8.4) * ARENA_SCALE
        size = rng.uniform(0.26, 0.56)
        rock_chunk(root, "Raised fractured floor slab", "stone",
                   (math.cos(angle) * radius, math.sin(angle) * radius, 0.02),
                   (size * 1.35, size, 0.08), 1700 + i, voxel=0.075, decimate=0.16)
    pillars = []
    pillar_count = count(7, 1.15)
    for i in range(pillar_count):
        angle = math.tau * i / pillar_count + 0.2
        radius = rng.uniform(10.8, 11.8) * ARENA_SCALE
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
    for i in range(0, pillar_count, 2):
        (first, first_height), (second, second_height) = pillars[i], pillars[(i + 1) % pillar_count]
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
    for i in range(count(20, 1.1)):
        angle = rng.uniform(0, math.tau)
        radius = rng.uniform(12, 25) * ARENA_SCALE
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


def side(sign):
    return "R" if sign > 0 else "L"


def build_player():
    root = clean_scene("player", "player")
    spine = joint(root, "rig_spine", (0, 0, 1.0))
    head = joint(spine, "rig_head", (0, 0.02, 1.42))
    cloak = joint(spine, "rig_cloak", (0, 0.06, 1.5))
    arms = {sign: joint(spine, f"rig_arm_{side(sign)}", (sign * 0.37, -0.02, 1.24)) for sign in (-1, 1)}
    forearms = {sign: joint(arms[sign], f"rig_forearm_{side(sign)}", (sign * 0.46, -0.16, 1.02)) for sign in (-1, 1)}
    chain = joint(forearms[1], "rig_chain", (0.62, -0.46, 0.9))

    cloak_panel(cloak, "Tattered cloak", "cloth", 0, 1.52, 0.22, 0.68, 0.08, 0.19)
    cloak_panel(cloak, "Outer cloak mantle", "cloth_dark", 0, 1.38, 0.28, 0.78, 0.19, 0.16)
    for sign in (-1, 1):
        cloak_panel(cloak, "Split cloak tail", "cloth_dark", sign * 0.32, 1.05, 0.25,
                    0.27, -0.13, 0.22)
        limb(cloak, "Cloak fold", "cloth_dark",
             (sign * 0.21, -0.12, 1.34), (sign * 0.39, -0.16, 0.2), 0.035, 0.28, 6)
        for fold in range(3):
            x = sign * (0.09 + fold * 0.16)
            tapered_curve(cloak, "Woven cloak fold", "cloth_dark",
                          ((x, -0.015, 1.42 - fold * 0.04),
                           (x + sign * 0.055, -0.015, 0.78),
                           (x + sign * 0.02, 0.04, 0.16 + (fold % 2) * 0.08)),
                          (0.35, 1.0, 0.12), 0.025, 8)
    for index in range(5):
        x = -0.58 + index * 0.29
        extruded_plate(cloak, "Jagged cloak tear", "cloth",
                       ((x, 0.5), (x + 0.11, 0.43), (x + 0.06, 0.21),
                        (x + 0.19, 0.39), (x + 0.26, 0.49)),
                       -0.16, 0.05, 0.008)
    ellipsoid(head, "Hooded cowl", "cloth_dark", (0, 0.015, 1.59), (0.37, 0.33, 0.4), 20, 14)
    hood_tip = tapered_curve(head, "Pointed hood peak", "cloth",
                             ((0, 0.02, 1.77), (0, 0.08, 1.97), (0, 0.14, 2.12)),
                             (1.0, 0.48, 0.02), 0.22, 12)
    ellipsoid(head, "Face shadow", "shade", (0, -0.302, 1.59), (0.235, 0.045, 0.25), 14, 10)
    for sign in (-1, 1):
        ellipsoid(head, "Eye ember", "glow", (sign * 0.105, -0.352, 1.66),
                  (0.035, 0.022, 0.032), 8, 6, smooth=False)
        ellipsoid(spine, "Layered mantle", "cloth_dark",
                  (sign * 0.37, 0.03, 1.36), (0.31, 0.3, 0.16), 12, 8)
        extruded_plate(spine, "Mantle shoulder plate", "cloth",
                       ((sign * 0.18, 1.49), (sign * 0.54, 1.51),
                        (sign * 0.72, 1.31), (sign * 0.43, 1.24)),
                       -0.25, 0.09, 0.025)
        limb(spine, "Mantle point", "cloth", (sign * 0.43, -0.1, 1.4),
             (sign * 0.64, -0.12, 1.18), 0.14, 0.12)
        limb(arms[sign], "Upper arm sleeve", "cloth", (sign * 0.37, -0.02, 1.2),
             (sign * 0.47, -0.17, 1.0), 0.125, 0.86)
        limb(forearms[sign], "Forearm sleeve", "cloth", (sign * 0.46, -0.16, 1.04),
             (sign * 0.54, -0.3, 0.82), 0.11, 0.62)
        ellipsoid(forearms[sign], "Leather glove", "metal", (sign * 0.54, -0.33, 0.78),
                  (0.12, 0.15, 0.11), 10, 8)
        for pouch in range(2):
            x = sign * (0.28 + pouch * 0.16)
            bevelled_box(spine, "Belt pouch", "cloth_dark",
                         (x, -0.31, 0.92), (0.16, 0.12, 0.21), 0.035)
    torus(spine, "Crossed belt", "metal", (0, -0.14, 1.03), 0.36, 0.035,
          (math.pi / 2, 0, 0), 24)
    for i in range(12):
        angle = i * 0.42
        torus(chain, "Chain weapon link", "metal",
              (0.62 + 0.12 * math.sin(angle), -0.46, 0.84 - i * 0.065),
              0.074, 0.018, (math.pi / 2, 0, (i % 2) * math.pi / 2), 8)
    elbow, wrist = Vector((0.46, -0.16, 1.02)), Vector((0.54, -0.31, 0.8))
    for i in range(8):
        angle = i * math.tau / 8
        along = elbow.lerp(wrist, 0.18 + i * 0.09)
        torus(forearms[1], "Forearm wrapped chain", "metal",
              (along.x + math.cos(angle) * 0.085, along.y + math.sin(angle) * 0.06, along.z),
              0.06, 0.016, (math.pi / 2, 0, angle), 8)
    ellipsoid(chain, "Chain weight", "metal", (0.63, -0.46, 0.2),
              (0.12, 0.12, 0.15), 10, 8)

    with clip("idle", ground_root=root) as frames:
        bob(root, frames, 0.03, shape="lift")
        oscillate(spine, frames, rotation=(0.02, 0, 0))
        oscillate(head, frames, rotation=(0.03, 0, 0.05), phase=math.pi / 2)
        oscillate(cloak, frames, rotation=(0.03, 0.015, 0), phase=math.pi)
        for sign, arm in arms.items():
            oscillate(arm, frames, rotation=(0.04, 0, sign * 0.02), phase=0 if sign < 0 else math.pi / 3)
            oscillate(forearms[sign], frames, rotation=(-0.05, 0, 0), phase=math.pi / 2 if sign < 0 else math.pi)
        oscillate(chain, frames, rotation=(0.08, 0.06, 0), phase=math.pi / 2)
        oscillate(hood_tip, frames, rotation=(0.06, 0, 0), phase=math.pi / 4)
    with clip("move", ground_root=root) as frames:
        bob(root, frames, 0.035, shape="bounce")
        oscillate(spine, frames, rotation=(0.04, 0, 0.06))
        for sign, arm in arms.items():
            stride(arm, forearms[sign], frames, 0.35, 0.55, 0 if sign < 0 else math.pi, elbow=True)
        oscillate(cloak, frames, rotation=(0.08, 0.04, 0), cycles=2)
        oscillate(chain, frames, rotation=(0.25, 0.1, 0), phase=math.pi / 2)
        oscillate(head, frames, rotation=(0.03, 0, 0), cycles=2)
        oscillate(hood_tip, frames, rotation=(0.1, 0, 0), cycles=2, phase=math.pi / 2)
    with clip("light", ground_root=root) as frames:
        # Chain arm cocks back across the body, then whips through with the flail trailing the wrist.
        pose(spine, frames, *strike_keys((-0.04, 0, -0.5), (0.14, 0, 0.55)))
        pose(head, frames, *strike_keys((-0.06, 0, 0.3), (0.1, 0, -0.3)))
        pose(arms[1], frames, *strike_keys((0.55, 0, -0.35), (-1.75, 0, 0.35)))
        pose(forearms[1], frames, *strike_keys((-1.0, 0, 0), (-0.15, 0, 0)))
        pose(chain, frames, *strike_keys((0.55, 0.2, 0), (-1.15, -0.1, 0)))
        pose(arms[-1], frames, *strike_keys((-0.45, 0, 0.2), (0.4, 0, -0.15)))
        pose(forearms[-1], frames, *strike_keys((-0.5, 0, 0), (-0.1, 0, 0)))
        pose(cloak, frames, *strike_keys((-0.05, 0, 0.08), (0.14, 0.05, -0.1)))
    with clip("heavy", ground_root=root) as frames:
        # Overhead smash: arm winds up behind the shoulder, whole spine bows into the blow.
        pose(spine, frames, *strike_keys((-0.18, 0, -0.3), (0.34, 0, 0.35)))
        pose(head, frames, *strike_keys((-0.2, 0, 0.15), (0.3, 0, -0.15)))
        pose(arms[1], frames, *strike_keys((1.3, 0, -0.4), (-2.3, 0, 0.3)))
        pose(forearms[1], frames, *strike_keys((-1.5, 0, 0), (-0.1, 0, 0)))
        pose(chain, frames, *strike_keys((0.9, 0.1, 0), (-1.5, 0, 0)))
        pose(arms[-1], frames, *strike_keys((-0.7, 0, 0.35), (0.6, 0, -0.2)))
        pose(forearms[-1], frames, *strike_keys((-0.9, 0, 0), (-0.2, 0, 0)))
        pose(cloak, frames, *strike_keys((-0.12, 0, 0), (0.22, 0.06, 0)))
        pose(hood_tip, frames, *strike_keys((-0.2, 0, 0), (0.3, 0, 0)))
    with clip("hit", ground_root=root) as frames:
        flinch(spine, frames, (-0.14, 0, 0.12))
        flinch(head, frames, (-0.22, 0, 0.18))
        for sign in (-1, 1):
            flinch(arms[sign], frames, (-0.3, 0, sign * -0.25))
            flinch(forearms[sign], frames, (-0.5, 0, 0))
        flinch(cloak, frames, (0.12, 0, 0))
        flinch(chain, frames, (0.35, 0.2, 0))
    with clip("death", ground_root=root) as frames:
        # Struck back: the body arches, then topples backwards as one piece and lands flat, arms flung wide,
        # the hood lolling. The floor clamp keeps the cloak resting on the stone rather than through it.
        pose(root, frames, (0, ZERO), (0.2, (0.12, 0, 0)), (0.62, (-1.5, 0, 0.1)), (0.78, (-1.42, 0, 0.12)),
             (1, (-1.5, 0, 0.12)))
        pose(spine, frames, (0, ZERO), (0.2, (-0.35, 0, 0.15)), (0.62, (-0.1, 0, 0.1)), (1, (0.12, 0.05, 0.1)))
        pose(head, frames, (0, ZERO), (0.2, (-0.35, 0, 0.15)), (0.62, (-0.3, 0.1, 0.2)), (1, (-0.45, 0.2, 0.3)))
        pose(cloak, frames, (0, ZERO), (0.2, (0.15, 0, 0)), (0.62, (0.25, 0.05, 0)), (1, (0.3, 0.05, 0)))
        pose(hood_tip, frames, (0, ZERO), (0.2, (-0.25, 0, 0)), (0.62, (-0.5, 0, 0)), (1, (-0.6, 0, 0)))
        for sign in (-1, 1):
            pose(arms[sign], frames, (0, ZERO), (0.2, (-0.9, 0, sign * -0.2)), (0.62, (-0.6, 0, sign * -0.9)),
                 (1, (-0.5, 0, sign * -1.1)))
            pose(forearms[sign], frames, (0, ZERO), (0.2, (-0.8, 0, 0)), (0.62, (-0.3, 0, 0)), (1, (-0.15, 0, 0)))
        pose(chain, frames, (0, ZERO), (0.2, (0.6, 0.3, 0)), (0.62, (-0.3, 0.2, 0)), (1, (-0.1, 0.1, 0)))
    return root


def build_colossus(root):
    torso = joint(root, "rig_torso", (0, 0.1, 1.55))
    head = joint(torso, "rig_head", (0, -0.15, 3.0))
    strike = joint(torso, "rig_strike", (0, 0.0, 2.95))
    arms = {sign: joint(strike, f"rig_arm_{side(sign)}", (sign * 0.92, 0.01, 2.94)) for sign in (-1, 1)}
    forearms = {sign: joint(arms[sign], f"rig_forearm_{side(sign)}", (sign * 1.28, -0.07, 1.94)) for sign in (-1, 1)}
    legs = {sign: joint(root, f"rig_leg_{side(sign)}", (sign * 0.39, 0.06, 1.48)) for sign in (-1, 1)}
    shins = {sign: joint(legs[sign], f"rig_shin_{side(sign)}", (sign * 0.44, -0.04, 0.86)) for sign in (-1, 1)}

    ellipsoid(torso, "Hunched stone trunk", "deep", (0, 0.08, 2.48), (0.92, 0.68, 1.12), 16, 12)
    ellipsoid(torso, "Ribbed chest core", "deep", (0, -0.49, 2.55), (0.71, 0.31, 0.79), 16, 12)
    ellipsoid(torso, "Caved back hump", "shade", (0, 0.54, 3.08), (0.88, 0.57, 0.68), 14, 10)
    ellipsoid(head, "Sunken skull", "stone", (0, -0.3, 3.34), (0.4, 0.4, 0.43), 20, 14)
    for sign in (-1, 1):
        ellipsoid(head, "Eye socket", "shade", (sign * 0.18, -0.64, 3.4), (0.13, 0.08, 0.09), 12, 8)
        ellipsoid(head, "Magma eye", "accent", (sign * 0.18, -0.705, 3.4),
                  (0.075, 0.032, 0.047), 8, 6, smooth=False)
        tapered_curve(head, "Broken crown horn", "stone_dark",
                      ((sign * 0.25, -0.18, 3.6), (sign * 0.37, -0.13, 3.91),
                       (sign * 0.52, -0.08, 4.25)),
                      (1.0, 0.62, 0.04), 0.18, 10)
        rock_chunk(torso, "Jagged shoulder mantle", "stone",
                   (sign * 0.94, 0.03, 3.12), (0.73, 0.67, 0.7), 310 + sign, 0.13)
        for plate in range(3):
            rock_chunk(torso, "Backgrown shoulder shard", "stone_dark" if plate == 1 else "stone",
                       (sign * (0.61 + plate * 0.22), 0.45 + plate * 0.14, 3.35 + plate * 0.19),
                       (0.36, 0.31, 0.28), 1250 + (sign + 1) * 5 + plate,
                       voxel=0.085, decimate=0.38)
        limb(arms[sign], "Heavy upper arm", "deep",
             (sign * 0.92, 0.01, 2.94), (sign * 1.28, -0.07, 1.92), 0.42, 0.74, 12)
        limb(forearms[sign], "Stone gauntlet", "stone_dark",
             (sign * 1.28, -0.07, 1.96), (sign * 1.53, -0.22, 0.98), 0.52, 0.9, 12)
        rock_chunk(forearms[sign], "Knotted boulder fist", "stone",
                   (sign * 1.56, -0.27, 0.78), (0.48, 0.42, 0.43), 450 + sign, 0.105)
        for claw in range(4):
            x = sign * (1.3 + claw * 0.17)
            tapered_curve(forearms[sign], "Knuckle dragging finger", "stone_dark",
                          ((x, -0.53, 0.96), (x + sign * 0.035, -0.72, 0.55),
                           (x + sign * 0.07, -0.74, 0.1)),
                          (1.0, 0.88, 0.1), 0.15, 8)
        for plate in range(3):
            rock_chunk(forearms[sign], "Forearm fractured plate", "stone",
                       (sign * (1.36 + plate * 0.07), -0.4, 1.78 - plate * 0.29),
                       (0.32, 0.18, 0.22), 1350 + (sign + 1) * 4 + plate,
                       voxel=0.075, decimate=0.32)
        limb(legs[sign], "Bent stone thigh", "deep",
             (sign * 0.39, 0.06, 1.48), (sign * 0.45, -0.05, 0.84), 0.36, 0.9, 12)
        limb(shins[sign], "Bent stone shin", "deep",
             (sign * 0.44, -0.04, 0.88), (sign * 0.48, -0.12, 0.3), 0.31, 0.74, 12)
        foot = rock_chunk(shins[sign], "Foot boulder", "stone_dark",
                          (sign * 0.49, -0.34, 0.2), (0.42, 0.56, 0.22), 550, 0.09)
        settle(foot)
    for i in range(7):
        z = 3.67 - i * 0.25
        y = 0.5 + i * 0.1
        limb(torso, "Dorsal ridge spike", "stone_dark", (0, y, z), (0, y + 0.28, z + 0.47), 0.19, 0.06, 7)
    for i in range(4):
        z = 2.05 + i * 0.28
        offset = (i % 2) * 0.12
        tapered_curve(torso, "Molten chest fissure", "accent",
                      ((-0.55 + offset, -0.69, z + 0.16),
                       (-0.27, -0.77, z + 0.03),
                       (0.02 + offset, -0.79, z + 0.13),
                       (0.34, -0.75, z - 0.02),
                       (0.55 - offset, -0.66, z + 0.08)),
                      (0.28, 0.85, 0.6, 1.0, 0.14), 0.025, 10)
    for sign in (-1, 1):
        for crack in range(3):
            z = 1.24 + crack * 0.27
            tapered_curve(forearms[sign], "Molten arm fissure", "accent",
                          ((sign * 1.25, -0.32, z + 0.18),
                           (sign * 1.43, -0.5, z + 0.04),
                           (sign * 1.57, -0.47, z - 0.1)),
                          (0.2, 0.85, 0.08), 0.018, 8)

    with clip("idle", ground_root=root) as frames:
        bob(root, frames, 0.04, shape="lift")
        oscillate(torso, frames, rotation=(0.015, 0, 0))
        oscillate(head, frames, rotation=(0.03, 0, 0.08), phase=math.pi / 2)
        for sign in (-1, 1):
            oscillate(arms[sign], frames, rotation=(0.04, 0, sign * 0.02), phase=0 if sign < 0 else math.pi / 2)
            oscillate(forearms[sign], frames, rotation=(0.03, 0, 0), phase=math.pi if sign < 0 else math.pi / 4)
    with clip("move", ground_root=root) as frames:
        bob(root, frames, 0.06, shape="bounce")
        oscillate(torso, frames, rotation=(0.03, 0.05, 0.04))
        oscillate(head, frames, rotation=(0.04, 0, 0), cycles=2)
        for sign in (-1, 1):
            step = 0 if sign < 0 else math.pi
            stride(legs[sign], shins[sign], frames, 0.3, 0.55, step)
            stride(arms[sign], forearms[sign], frames, 0.2, 0.3, step + math.pi, elbow=True)
    with clip("attack_melee", ground_root=root) as frames:
        # Both arms haul overhead, then the whole trunk drives them down; the off leg braces.
        pose(torso, frames, *strike_keys((-0.22, 0, 0), (0.45, 0, 0)))
        pose(head, frames, *strike_keys((-0.3, 0, 0), (0.35, 0, 0)))
        pose(strike, frames, *strike_keys((-2.4, 0, 0), (-0.6, 0, 0)))
        for sign in (-1, 1):
            pose(forearms[sign], frames, *strike_keys((-0.6, 0, 0), (0.1, 0, 0)))
            pose(legs[sign], frames, *strike_keys((sign * 0.12, 0, 0), (sign * -0.28, 0, 0)))
            pose(shins[sign], frames, *strike_keys((0.15, 0, 0), (0.3, 0, 0)))
    with clip("attack_ranged", ground_root=root) as frames:
        # Arms lift and fists slam the ground line in front: the fissure/quake tell.
        pose(torso, frames, *strike_keys((-0.15, 0, 0), (0.3, 0, 0)))
        pose(head, frames, *strike_keys((-0.2, 0, 0), (0.25, 0, 0)))
        pose(strike, frames, *strike_keys((-2.0, 0, 0), (-1.35, 0, 0)))
        for sign in (-1, 1):
            pose(forearms[sign], frames, *strike_keys((-0.4, 0, 0), (-0.5, 0, 0)))
            pose(shins[sign], frames, *strike_keys((0.1, 0, 0), (0.25, 0, 0)))
    with clip("hit", ground_root=root) as frames:
        flinch(torso, frames, (-0.08, 0, 0.04))
        flinch(head, frames, (-0.25, 0, 0.1))
        flinch(strike, frames, (0.2, 0, 0))
    with clip("stagger", ground_root=root) as frames:
        hold(torso, frames, (0.38, 0, 0), (0.03, 0, 0.02), cycles=6)
        hold(head, frames, (0.4, 0, 0), (0.04, 0, 0.05), cycles=5)
        hold(strike, frames, (0.45, 0, 0), (0.05, 0, 0), cycles=6, phase=math.pi / 2)
        for sign in (-1, 1):
            hold(forearms[sign], frames, (-0.3, 0, 0))
            hold(shins[sign], frames, (0.25, 0, 0))
    with clip("death", ground_root=root) as frames:
        # Reel, then drop to the knees and slump: shins fold back along the floor, trunk bows over them.
        pose(root, frames, (0, ZERO, ZERO), (0.3, (-0.12, 0, 0), (0, 0, 0.05)),
             (0.7, (0.15, 0, 0), (0, -0.1, -0.6)), (1, (0.18, 0, 0.04), (0, -0.12, -0.64)))
        pose(torso, frames, (0, ZERO), (0.3, (-0.2, 0, 0)), (0.7, (0.55, 0, 0)), (1, (0.65, 0.04, 0.05)))
        pose(head, frames, (0, ZERO), (0.3, (-0.35, 0, 0)), (0.7, (0.4, 0, 0)), (1, (0.55, 0.08, 0.1)))
        pose(strike, frames, (0, ZERO), (0.3, (-1.1, 0, 0)), (0.7, (-0.4, 0, 0)), (1, (-0.5, 0, 0)))
        for sign in (-1, 1):
            pose(forearms[sign], frames, (0, ZERO), (0.3, (-0.5, 0, 0)), (0.7, (0.1, 0, 0)), (1, (0.15, 0, 0)))
            pose(legs[sign], frames, (0, ZERO), (0.3, (0.05, 0, 0)), (0.7, (-0.75, 0, sign * 0.1)),
                 (1, (-0.8, 0, sign * 0.12)))
            pose(shins[sign], frames, (0, ZERO), (0.3, (0.1, 0, 0)), (0.7, (1.95, 0, 0)), (1, (2.0, 0, 0)))


def build_hound(root):
    strike = joint(root, "rig_strike", (0, -0.5, 0.95))
    head = joint(strike, "rig_head", (0, -1.25, 1.62))
    jaw = joint(head, "rig_jaw", (0, -1.5, 1.46))
    tail = joint(root, "rig_tail", (0, 0.82, 0.93))
    legs = {}
    knees = {}

    ellipsoid(root, "Long ribcage", "deep", (0, 0.16, 0.91), (0.36, 0.78, 0.26), 20, 14)
    ellipsoid(root, "Shoulder mass", "deep", (0, -0.52, 0.97), (0.39, 0.43, 0.39), 16, 12)
    tube_mesh(strike, "Rising wolf neck", "deep",
              ((0, -0.56, 0.88), (0, -0.91, 1.19), (0, -1.19, 1.56), (0, -1.43, 1.87)),
              (0.31, 0.27, 0.22, 0.17), 12)
    ellipsoid(head, "Long skull", "shade", (0, -1.48, 1.75), (0.31, 0.5, 0.26), 20, 14)
    ellipsoid(head, "Upper jaw", "bone", (0, -1.81, 1.64), (0.23, 0.38, 0.09), 16, 10)
    ellipsoid(jaw, "Lower jaw", "deep", (0, -1.83, 1.4), (0.2, 0.34, 0.075), 16, 10)
    ellipsoid(head, "Glowing open maw", "accent", (0, -2.04, 1.52), (0.16, 0.035, 0.068), 12, 8, smooth=False)
    for sign in (-1, 1):
        ellipsoid(head, "Amber eye", "accent", (sign * 0.21, -1.82, 1.88), (0.055, 0.036, 0.052), 8, 6, smooth=False)
        tapered_curve(head, "Long curved canine", "bone",
                      ((sign * 0.13, -1.96, 1.65), (sign * 0.16, -2.02, 1.51), (sign * 0.12, -2.07, 1.36)),
                      (0.8, 0.56, 0.02), 0.075, 10)
        for tooth in range(4):
            x = sign * (0.05 + tooth * 0.045)
            tapered_curve(head, "Upper jaw tooth", "bone", ((x, -2.01, 1.63), (x, -2.04, 1.53)), (0.8, 0.02), 0.034, 6)
            tapered_curve(jaw, "Lower jaw tooth", "bone", ((x, -2.03, 1.44), (x, -2.05, 1.53)), (0.8, 0.02), 0.028, 6)
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
            tapered_curve(root, "Dorsal spine ridge", "bone",
                          ((sign * 0.05, y, z), (sign * 0.1, y + 0.1, z + 0.22), (sign * 0.12, y + 0.18, z + 0.39)),
                          (1.0, 0.55, 0.02), 0.12, 8)
    for sign in (-1, 1):
        for front, y in ((True, -0.48), (False, 0.73)):
            hip_z = 1.02 if front else 0.94
            leg = joint(root, f"rig_leg_{'F' if front else 'H'}{side(sign)}", (sign * 0.36, y, hip_z))
            legs[(front, sign)] = leg
            knee = (sign * 0.34, y + (0.2 if front else -0.19), 0.45)
            paw = (sign * 0.4, y + (0.17 if front else -0.02), 0.12)
            shin = joint(leg, f"rig_knee_{'F' if front else 'H'}{side(sign)}", knee)
            knees[(front, sign)] = shin
            limb(leg, "Sinewed foreleg" if front else "Sinewed hindleg",
                 "deep", (sign * 0.36, y, hip_z), knee, 0.17 if front else 0.2, 0.7, 9)
            limb(shin, "Hock", "shade", knee, paw, 0.12, 0.68, 8)
            settle(ellipsoid(shin, "Bone paw", "bone", paw, (0.15, 0.22, 0.095), 12, 8), 0.005)
            for claw in range(3):
                x = sign * (0.3 + claw * 0.09)
                settle(tapered_curve(shin, "Splayed paw claw", "bone",
                                     ((x, paw[1] - 0.13, 0.105), (x + sign * 0.02, paw[1] - 0.22, 0.08),
                                      (x + sign * 0.045, paw[1] - 0.31, 0.04)),
                                     (0.85, 0.52, 0.02), 0.045, 8), 0.01)
    tapered_curve(tail, "Whiplash tail", "deep",
                  ((0, 0.82, 0.93), (0.12, 1.2, 0.99), (0.02, 1.62, 1.18), (-0.1, 2.02, 1.45), (0.02, 2.35, 1.62)),
                  (1.0, 0.86, 0.61, 0.34, 0.02), 0.18, 12)
    root.scale.z = 1.08

    with clip("idle", ground_root=root) as frames:
        bob(root, frames, 0.02, shape="lift")
        oscillate(strike, frames, rotation=(0.03, 0, 0.04))
        oscillate(head, frames, rotation=(0.02, 0, 0.06), phase=math.pi / 2)
        oscillate(jaw, frames, rotation=(0.05, 0, 0), cycles=2, shape="bounce")
        oscillate(tail, frames, rotation=(0.06, 0, 0.25), cycles=2)
    with clip("move", ground_root=root) as frames:
        bob(root, frames, 0.05, cycles=0.5, shape="bounce", samples=24)
        oscillate(root, frames, rotation=(0.05, 0, 0), phase=math.pi / 2)
        oscillate(strike, frames, rotation=(0.08, 0, 0), phase=math.pi)
        oscillate(head, frames, rotation=(0.05, 0, 0))
        oscillate(jaw, frames, rotation=(0.08, 0, 0), shape="bounce")
        oscillate(tail, frames, rotation=(0.15, 0, 0.1))
        for (front, sign), leg in legs.items():
            phase = (0 if front else math.pi) + (0 if sign < 0 else 0.35)
            stride(leg, knees[(front, sign)], frames, 0.45 if front else 0.5, 0.7 if front else 0.85, phase)
    with clip("attack_melee", ground_root=root) as frames:
        # Rear back on the haunches with the jaw wide, then lunge the neck out and snap shut.
        pose(strike, frames, *strike_keys((-0.5, 0, 0), (0.55, 0, 0), location=(ZERO, (0, -0.45, -0.12))))
        pose(head, frames, *strike_keys((-0.35, 0, 0), (0.3, 0, 0)))
        pose(jaw, frames, *strike_keys((0.55, 0, 0), (0.04, 0, 0)))
        pose(root, frames, *strike_keys((-0.12, 0, 0), (0.08, 0, 0), location=((0, 0.1, 0.06), (0, -0.2, -0.02))))
        pose(tail, frames, *strike_keys((-0.5, 0, 0), (0.35, 0, 0)))
        for (front, sign), leg in legs.items():
            if front:
                pose(leg, frames, *strike_keys((-0.7, 0, 0), (0.25, 0, 0)))
                pose(knees[(front, sign)], frames, *strike_keys((0.9, 0, 0), (0.1, 0, 0)))
            else:
                pose(leg, frames, *strike_keys((0.3, 0, 0), (-0.25, 0, 0)))
                pose(knees[(front, sign)], frames, *strike_keys((0.35, 0, 0), (0.15, 0, 0)))
    with clip("attack_ranged", ground_root=root) as frames:
        # Head thrown up in a howl, jaw hanging open through the hold.
        pose(strike, frames, *strike_keys((-0.55, 0, 0), (-0.7, 0, 0)))
        pose(head, frames, *strike_keys((-0.4, 0, 0), (-0.55, 0, 0)))
        pose(jaw, frames, *strike_keys((0.35, 0, 0), (0.7, 0, 0)))
        pose(tail, frames, *strike_keys((-0.3, 0, 0.2), (-0.45, 0, -0.2)))
        for (front, sign), leg in legs.items():
            pose(leg, frames, *strike_keys((-0.2 if front else 0.15, 0, 0), (-0.35 if front else 0.2, 0, 0)))
    with clip("hit", ground_root=root) as frames:
        flinch(strike, frames, (-0.18, 0, 0.12))
        flinch(head, frames, (-0.2, 0, -0.15))
        flinch(jaw, frames, (0.25, 0, 0))
        flinch(tail, frames, (0.3, 0, 0))
    with clip("stagger", ground_root=root) as frames:
        hold(strike, frames, (0.45, 0, 0), (0.04, 0, 0.03), cycles=6)
        hold(head, frames, (0.25, 0, 0.1), (0.05, 0, 0.06), cycles=5)
        hold(jaw, frames, (0.4, 0, 0), (0.08, 0, 0), cycles=6)
        hold(tail, frames, (0.3, 0, 0), (0.05, 0, 0.15), cycles=4)
        for (front, sign), leg in legs.items():
            hold(leg, frames, (-0.3 if front else 0.2, 0, 0))
            hold(knees[(front, sign)], frames, (0.5, 0, 0))
    with clip("death", ground_root=root) as frames:
        # Legs buckle, the body rolls onto its flank and the neck stretches out along the floor.
        pose(root, frames, (0, ZERO, ZERO), (0.25, (-0.1, 0, 0), (0, 0, 0.08)),
             (0.65, (0.05, 1.25, 0), (0, 0.1, 0.22)), (1, (0.05, 1.38, 0), (0, 0.12, 0.2)))
        pose(strike, frames, (0, ZERO), (0.25, (-0.4, 0, 0)), (0.65, (0.35, 0, 0.3)), (1, (0.4, 0, 0.35)))
        pose(head, frames, (0, ZERO), (0.25, (-0.3, 0, 0)), (0.65, (0.35, 0, 0)), (1, (0.4, 0, 0)))
        pose(jaw, frames, (0, ZERO), (0.25, (0.6, 0, 0)), (0.65, (0.3, 0, 0)), (1, (0.25, 0, 0)))
        pose(tail, frames, (0, ZERO), (0.25, (-0.4, 0, 0)), (0.65, (0.45, 0, 0.4)), (1, (0.5, 0, 0.45)))
        for (front, sign), leg in legs.items():
            pose(leg, frames, (0, ZERO), (0.25, (-0.5 if front else 0.3, 0, 0)),
                 (0.65, (-0.9 if front else 0.7, 0, 0)), (1, (-1.0 if front else 0.75, 0, 0)))
            pose(knees[(front, sign)], frames, (0, ZERO), (0.25, (0.5, 0, 0)), (0.65, (1.1, 0, 0)), (1, (1.15, 0, 0)))


def build_seraph(root):
    torso = joint(root, "rig_torso", (0, 0.1, 2.0))
    head = joint(torso, "rig_head", (0, 0, 2.85))
    strike = joint(torso, "rig_strike", (0, 0.12, 2.6))
    arms = {sign: joint(strike, f"rig_arm_{side(sign)}", (sign * 0.4, 0.04, 2.58)) for sign in (-1, 1)}
    forearms = {sign: joint(arms[sign], f"rig_forearm_{side(sign)}", (sign * 0.45, -0.04, 2.25)) for sign in (-1, 1)}
    wings = {sign: joint(strike, f"rig_wing_{side(sign)}", (sign * 0.37, 0.16, 2.31)) for sign in (-1, 1)}
    halo = joint(head, "rig_halo", (0, 0.12, 3.42))
    robe = joint(torso, "rig_robe", (0, 0.12, 1.85))

    ellipsoid(torso, "Slender porcelain cuirass", "deep", (0, 0.08, 2.25), (0.42, 0.28, 0.62), 20, 14)
    extruded_plate(torso, "Etched breastplate", "metal",
                   ((-0.32, 2.68), (-0.22, 2.86), (0.22, 2.86),
                    (0.32, 2.68), (0.24, 2.17), (0, 1.92), (-0.24, 2.17)),
                   -0.23, 0.11, 0.026)
    ellipsoid(torso, "Shoulder mantle", "shade", (0, 0.13, 2.69), (0.62, 0.3, 0.21), 16, 10)
    ellipsoid(head, "Porcelain oval mask", "bone", (0, -0.04, 3.1), (0.29, 0.19, 0.36), 16, 12)
    ellipsoid(head, "Mask eye shadow", "shade", (0, -0.222, 3.11), (0.17, 0.03, 0.09), 14, 10)
    for sign in (-1, 1):
        ellipsoid(head, "Seraph eye glow", "accent", (sign * 0.1, -0.252, 3.13), (0.042, 0.018, 0.03), 10, 8, smooth=False)
        tapered_curve(head, "Porcelain cheek ridge", "bone",
                      ((sign * 0.12, -0.2, 3.05), (sign * 0.2, -0.16, 2.99), (sign * 0.24, -0.12, 2.9)),
                      (0.8, 0.55, 0.08), 0.035, 8)
        limb(arms[sign], "Armoured upper arm", "metal", (sign * 0.4, 0.04, 2.58), (sign * 0.455, -0.05, 2.23), 0.12, 0.88, 10)
        limb(forearms[sign], "Armoured forearm", "metal", (sign * 0.45, -0.04, 2.27), (sign * 0.5, -0.13, 1.9), 0.105, 0.62, 10)
        ellipsoid(forearms[sign], "Seraph gauntlet", "bone", (sign * 0.5, -0.2, 1.86), (0.12, 0.11, 0.14), 12, 8)

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
        tapered_curve(halo, "Cracked halo segment", "glow",
                      [(x, y + 0.12, z + 3.42) for x, y, z in points], radii, 0.045, 6)

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
                wing = sword_blade(wings[sign], "Layered sword wing", "bone", start, end,
                                   0.075 - blade_index * 0.004, 0.065)
                wing.rotation_euler.y = sign * (pair - 1) * 0.035
                if blade_index % 2 == 0:
                    cross = (sign * (0.43 + pair * 0.025), 0.14 + pair * 0.06, z + 0.05)
                    tapered_curve(wings[sign], "Wing blade crossguard", "metal",
                                  ((cross[0] - 0.09, cross[1], cross[2] - 0.03),
                                   (cross[0], cross[1] - 0.025, cross[2] + 0.01),
                                   (cross[0] + 0.09, cross[1], cross[2] + 0.05)),
                                  (0.08, 1.0, 0.08), 0.032, 8)

    for index in range(8):
        x = -0.36 + index * 0.103
        sway = (-1 if index % 2 else 1) * (0.12 + index * 0.015)
        tapered_curve(robe, "Trailing ribbon robe", "shade",
                      ((x * 0.45, 0.12, 1.82),
                       (x + sway, 0.22, 1.18),
                       (x - sway * 0.45, 0.16, 0.68),
                       (x + sway, 0.24, 0.12 + (index % 3) * 0.07)),
                      (1.0, 0.86, 0.48, 0.015), 0.12, 8)

    with clip("idle") as frames:
        bob(root, frames, 0.1)
        oscillate(torso, frames, rotation=(0.02, 0, 0))
        oscillate(head, frames, rotation=(0.03, 0, 0.06), phase=math.pi / 2)
        spin(halo, frames, axis=2, turns=1)
        oscillate(robe, frames, rotation=(0.04, 0, 0.02), phase=math.pi)
        for sign in (-1, 1):
            oscillate(wings[sign], frames, rotation=(0, sign * 0.06, sign * 0.03), phase=math.pi / 2)
            oscillate(arms[sign], frames, rotation=(0.04, 0, 0), phase=0 if sign < 0 else math.pi / 2)
            oscillate(forearms[sign], frames, rotation=(-0.06, 0, 0), phase=math.pi if sign < 0 else 0)
    with clip("move") as frames:
        bob(root, frames, 0.06)
        oscillate(torso, frames, rotation=(0.03, 0, 0), phase=math.pi / 2)
        spin(halo, frames, axis=2, turns=1)
        oscillate(robe, frames, rotation=(0.12, 0, 0.04))
        for sign in (-1, 1):
            oscillate(wings[sign], frames, rotation=(0, sign * 0.2, sign * 0.05), cycles=2)
            stride(arms[sign], forearms[sign], frames, 0.08, 0.2, math.pi, elbow=True)
    with clip("attack_melee") as frames:
        # Wings and arms sweep up and fold back, then scythe down and forward together.
        pose(torso, frames, *strike_keys((-0.2, 0, 0), (0.4, 0, 0)))
        pose(head, frames, *strike_keys((-0.2, 0, 0), (0.3, 0, 0)))
        pose(strike, frames, *strike_keys((-1.9, 0, 0), (-0.55, 0, 0)))
        pose(robe, frames, *strike_keys((-0.15, 0, 0), (0.35, 0, 0)))
        for sign in (-1, 1):
            pose(wings[sign], frames, *strike_keys((0, sign * 0.55, sign * 0.2), (0, sign * -0.5, sign * -0.15)))
            pose(forearms[sign], frames, *strike_keys((-0.9, 0, 0), (-0.2, 0, 0)))
    with clip("attack_ranged") as frames:
        # Arms level out ahead, wings fan wide and hold while the volley leaves.
        pose(torso, frames, *strike_keys((-0.1, 0, 0), (0.15, 0, 0)))
        pose(strike, frames, *strike_keys((-1.4, 0, 0), (-1.2, 0, 0)))
        pose(robe, frames, *strike_keys((-0.1, 0, 0), (0.2, 0, 0)))
        for sign in (-1, 1):
            pose(wings[sign], frames, *strike_keys((0, sign * 0.3, 0), (0, sign * -0.75, sign * -0.2)))
            pose(forearms[sign], frames, *strike_keys((-0.5, 0, 0), (-0.15, 0, 0)))
    with clip("hit") as frames:
        flinch(torso, frames, (-0.1, 0, 0.06))
        flinch(head, frames, (-0.22, 0, 0.12))
        for sign in (-1, 1):
            flinch(wings[sign], frames, (0, sign * 0.3, 0))
    with clip("stagger") as frames:
        hold(torso, frames, (0.35, 0, 0), (0.03, 0, 0.02), cycles=6)
        hold(head, frames, (0.35, 0, 0), (0.04, 0, 0.05), cycles=5)
        hold(strike, frames, (0.3, 0, 0), (0.04, 0, 0), cycles=6, phase=math.pi / 2)
        hold(robe, frames, (0.2, 0, 0), (0.03, 0, 0), cycles=4)
        for sign in (-1, 1):
            hold(wings[sign], frames, (0, sign * 0.5, sign * 0.1), (0, sign * 0.05, 0), cycles=6)
    with clip("death") as frames:
        # The hover fails: wings fold shut, the body pitches forward and settles onto the robe hem.
        pose(root, frames, (0, ZERO, ZERO), (0.25, (-0.15, 0, 0), (0, 0, 0.15)),
             (0.7, (0.2, 0, 0), (0, -0.1, -0.12)), (1, (0.22, 0, 0.05), (0, -0.12, -0.12)))
        pose(torso, frames, (0, ZERO), (0.25, (-0.2, 0, 0)), (0.7, (0.85, 0, 0.1)), (1, (0.95, 0, 0.12)))
        pose(head, frames, (0, ZERO), (0.25, (-0.3, 0, 0)), (0.7, (0.45, 0, 0)), (1, (0.55, 0.1, 0)))
        pose(strike, frames, (0, ZERO), (0.25, (-1.2, 0, 0)), (0.7, (-0.3, 0, 0)), (1, (-0.35, 0, 0)))
        pose(robe, frames, (0, ZERO), (0.25, (-0.2, 0, 0)), (0.7, (-0.6, 0, 0)), (1, (-0.7, 0, 0)))
        for sign in (-1, 1):
            pose(wings[sign], frames, (0, ZERO), (0.25, (0, sign * -0.6, 0)), (0.7, (0, sign * 0.9, sign * 0.3)),
                 (1, (0, sign * 1.0, sign * 0.35)))
            pose(forearms[sign], frames, (0, ZERO), (0.25, (-0.7, 0, 0)), (0.7, (-0.1, 0, 0)), (1, ZERO))


def build_serpent(root):
    strike = joint(root, "rig_strike", (0, -0.12, 0.45))
    head = joint(strike, "rig_head", (0, -0.3, 2.55))
    jaw = joint(head, "rig_jaw", (0, -0.4, 2.74))

    coil_points = []
    coil_radii = []
    for i in range(65):
        t = i / 64
        angle = -math.pi / 2 + math.tau * 2.0 * t
        radius = 1.65 - 1.3 * t
        coil_points.append((math.cos(angle) * radius, math.sin(angle) * radius + 0.12, 0.31))
        coil_radii.append(0.55 + math.sin(math.pi * t) * 0.45 - 0.28 * t)
    tapered_curve(root, "Tapered spiral coil", "deep", coil_points, coil_radii, 0.34, 4)
    for i in range(40):
        t = 0.02 + i / 42
        angle = -math.pi / 2 + math.tau * 2.0 * t
        radius = 1.65 - 1.3 * t
        x, y = math.cos(angle) * radius, math.sin(angle) * radius + 0.12
        curve_radius = 0.55 + math.sin(math.pi * t) * 0.45 - 0.28 * t
        ground_plate(root, "Coil overlapping scale", "shade",
                     (x, y, 0.31 + 0.34 * curve_radius * 0.88),
                     angle + math.pi / 2, 0.34 - t * 0.06, 0.23, 0.045)

    tapered_curve(strike, "S-curve rising neck", "deep",
                  ((0, -0.12, 0.39), (0, -0.18, 0.9), (0.15, -0.26, 1.48), (0.1, -0.18, 2.04), (0, -0.14, 2.48)),
                  (1.0, 0.94, 0.78, 0.7, 0.55), 0.36, 14)
    for i in range(10):
        z = 0.74 + i * 0.16
        width = 0.28 - i * 0.012
        extruded_plate(strike, "Segmented ventral scute", "shade",
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
    hood = mesh_object("Flared cobra hood membrane", hood_vertices, hood_faces, "shade", head, smooth=True)
    solidify = hood.modifiers.new("Hood membrane thickness", "SOLIDIFY")
    solidify.thickness = 0.065
    apply_modifier(hood, solidify)
    for sign in (-1, 1):
        for ridge in range(5):
            spread = ridge / 4
            tapered_curve(head, "Raised cobra hood rib", "bone",
                          ((sign * (0.12 + spread * 0.15), -0.11, 2.45),
                           (sign * (0.27 + spread * 0.22), -0.1, 2.72),
                           (sign * (0.38 + spread * 0.52), 0.02, 3.05)),
                          (0.55, 0.8, 0.06), 0.055, 6)
    ellipsoid(head, "Narrow serpent skull", "deep", (0, -0.34, 2.87), (0.27, 0.36, 0.24), 20, 14)
    ellipsoid(jaw, "Serpent lower jaw", "shade", (0, -0.55, 2.7), (0.2, 0.27, 0.09), 14, 10)
    for sign in (-1, 1):
        ellipsoid(head, "Serpent ember eye", "accent", (sign * 0.13, -0.62, 2.94), (0.045, 0.025, 0.035), 10, 8, smooth=False)
        tapered_curve(head, "Curved cobra fang", "bone",
                      ((sign * 0.13, -0.64, 2.78), (sign * 0.18, -0.73, 2.6), (sign * 0.12, -0.78, 2.42)),
                      (0.9, 0.62, 0.02), 0.09, 8)

    with clip("idle", ground_root=root) as frames:
        bob(root, frames, 0.03, shape="lift")
        oscillate(strike, frames, rotation=(0.04, 0.05, 0))
        oscillate(head, frames, rotation=(0.03, 0, 0.08), phase=math.pi / 2)
        oscillate(jaw, frames, rotation=(0.04, 0, 0), shape="bounce")
    with clip("move", ground_root=root) as frames:
        bob(root, frames, 0.03, shape="lift")
        oscillate(root, frames, rotation=(0, 0, 0.04))
        oscillate(strike, frames, rotation=(0.06, 0.12, 0))
        oscillate(head, frames, rotation=(0.04, 0, 0.1), phase=math.pi / 2)
        oscillate(jaw, frames, rotation=(0.06, 0, 0), shape="bounce")
    with clip("attack_melee", ground_root=root) as frames:
        # Neck draws back into an S with the hood flared, then the whole column drives forward and the jaw snaps.
        pose(strike, frames, *strike_keys((-0.5, 0, 0), (0.7, 0, 0), location=((0, 0.1, 0.05), (0, -0.7, -0.25))))
        pose(head, frames, *strike_keys((-0.35, 0, 0), (0.25, 0, 0)))
        pose(jaw, frames, *strike_keys((0.5, 0, 0), (0.08, 0, 0)))
        pose(root, frames, *strike_keys((0, 0, -0.06), (0, 0, 0.08)))
    with clip("attack_ranged", ground_root=root) as frames:
        # Rear up tall and spit: head tips back, then snaps down with the jaw wide through the hold.
        pose(strike, frames, *strike_keys((-0.3, 0, 0), (0.25, 0, 0), location=((0, 0.05, 0.1), (0, -0.15, 0.05))))
        pose(head, frames, *strike_keys((-0.45, 0, 0), (0.5, 0, 0)))
        pose(jaw, frames, *strike_keys((0.3, 0, 0), (0.75, 0, 0)))
    with clip("hit", ground_root=root) as frames:
        flinch(strike, frames, (-0.15, 0.08, 0))
        flinch(head, frames, (-0.25, 0, 0.15))
        flinch(jaw, frames, (0.3, 0, 0))
    with clip("stagger", ground_root=root) as frames:
        hold(strike, frames, (0.4, 0.15, 0), (0.05, 0.04, 0), cycles=6)
        hold(head, frames, (0.3, 0, 0.15), (0.06, 0, 0.08), cycles=5)
        hold(jaw, frames, (0.45, 0, 0), (0.08, 0, 0), cycles=6)
    with clip("death", ground_root=root) as frames:
        # The neck loses its lift and topples forward until the hood lies over the front of the coil.
        pose(root, frames, (0, ZERO, ZERO), (0.25, (-0.04, 0, 0), (0, 0, 0.04)), (0.7, (0.03, 0, 0), (0, 0, -0.04)),
             (1, (0.03, 0, 0), (0, 0, -0.05)))
        pose(strike, frames, (0, ZERO, ZERO), (0.25, (-0.4, 0.1, 0), (0, 0.1, 0.1)),
             (0.7, (1.1, 0.15, 0), (0, -0.3, -0.15)), (1, (1.15, 0.15, 0), (0, -0.32, -0.16)))
        pose(head, frames, (0, ZERO), (0.25, (-0.3, 0, 0)), (0.7, (0.25, 0, 0.2)), (1, (0.3, 0, 0.22)))
        pose(jaw, frames, (0, ZERO), (0.25, (0.6, 0, 0)), (0.7, (0.45, 0, 0)), (1, (0.5, 0, 0)))


def build_knight(root):
    torso = joint(root, "rig_torso", (0, 0.05, 1.25))
    head = joint(torso, "rig_head", (0, 0.02, 2.4))
    strike = joint(torso, "rig_strike", (0, -0.05, 2.03))
    arms = {sign: joint(strike, f"rig_arm_{side(sign)}", (sign * 0.6, 0.03, 2.03)) for sign in (-1, 1)}
    forearms = {sign: joint(arms[sign], f"rig_forearm_{side(sign)}", (sign * 0.37, -0.4, 1.54)) for sign in (-1, 1)}
    legs = {sign: joint(root, f"rig_leg_{side(sign)}", (sign * 0.25, 0.04, 1.17)) for sign in (-1, 1)}
    shins = {sign: joint(legs[sign], f"rig_shin_{side(sign)}", (sign * 0.3, -0.03, 0.72)) for sign in (-1, 1)}
    tabards = {1: joint(torso, "rig_tabard_F", (0, -0.47, 1.42)), -1: joint(torso, "rig_tabard_B", (0, 0.28, 1.42))}

    ellipsoid(torso, "Armoured body", "deep", (0, 0.08, 1.65), (0.43, 0.33, 0.7), 20, 14)
    extruded_plate(torso, "Forged breastplate", "metal",
                   ((-0.35, 2.28), (-0.43, 2.08), (-0.39, 1.78),
                    (-0.23, 1.55), (0, 1.49), (0.23, 1.55),
                    (0.39, 1.78), (0.43, 2.08), (0.35, 2.28),
                    (0.18, 2.38), (-0.18, 2.38)),
                   -0.44, 0.16, 0.045)
    extruded_plate(torso, "Raised cuirass gorget", "metal",
                   ((-0.27, 2.36), (-0.37, 2.09), (0, 1.98), (0.37, 2.09), (0.27, 2.36), (0, 2.47)),
                   -0.43, 0.09, 0.025)
    bevelled_box(head, "Great helm", "metal", (0, 0.02, 2.63), (0.69, 0.58, 0.68), 0.17, 4)
    bevelled_box(head, "Helm brow", "metal", (0, -0.32, 2.88), (0.64, 0.12, 0.14), 0.045, 3)
    visor = bevelled_box(head, "Visor cross slit", "accent", (0, -0.37, 2.67), (0.48, 0.045, 0.055), 0.016, 2)
    tapered_curve(head, "Visor center slit", "accent",
                  ((0, -0.397, 2.48), (0, -0.4, 2.65), (0, -0.4, 2.79)), (0.8, 1.0, 0.05), 0.032, 8)
    for sign in (-1, 1):
        tapered_curve(head, "Visor fork slit", "accent",
                      ((sign * 0.045, -0.4, 2.67), (sign * 0.13, -0.4, 2.76), (sign * 0.22, -0.39, 2.81)),
                      (0.12, 1.0, 0.05), 0.025, 8)
    for sign in (-1, 1):
        for row in range(3):
            center_x = sign * (0.62 + row * 0.025)
            center_z = 2.23 - row * 0.15
            width = 0.32 - row * 0.035
            extruded_plate(torso, "Stacked pauldron plate", "metal",
                           ((center_x - width, center_z + 0.12),
                            (center_x - width * 0.78, center_z + 0.2),
                            (center_x + width * 0.65, center_z + 0.16),
                            (center_x + width, center_z - 0.05),
                            (center_x + width * 0.44, center_z - 0.17),
                            (center_x - width * 0.58, center_z - 0.1)),
                           -0.29 - row * 0.015, 0.11, 0.035)
        for rivet in range(3):
            ellipsoid(torso, "Pauldron rivet", "bone",
                      (sign * (0.49 + rivet * 0.13), -0.305 - rivet * 0.015, 2.25 - rivet * 0.12),
                      (0.035, 0.022, 0.035), 8, 6, smooth=False)
        limb(arms[sign], "Armoured upper arm", "metal",
             (sign * 0.6, 0.03, 2.03), (sign * 0.37, -0.4, 1.54), 0.19, 0.72, 12)
        limb(forearms[sign], "Armoured forearm", "deep",
             (sign * 0.37, -0.4, 1.54), (sign * 0.16, -0.62, 1.99), 0.15, 0.72, 10)
        ellipsoid(forearms[sign], "Sword gripping gauntlet", "metal", (sign * 0.13, -0.65, 1.98), (0.15, 0.12, 0.13), 14, 10)
        for finger in range(3):
            x = sign * (0.04 + finger * 0.065)
            tapered_curve(forearms[sign], "Gauntlet finger plate", "metal",
                          ((x, -0.76, 2.02), (x, -0.79, 1.93), (x, -0.75, 1.87)), (0.8, 1.0, 0.25), 0.035, 8)
        limb(legs[sign], "Cuisse", "metal", (sign * 0.25, 0.04, 1.17), (sign * 0.3, -0.03, 0.7), 0.19, 0.8, 12)
        extruded_plate(legs[sign], "Cuisse front plate", "metal",
                       ((sign * 0.18, 1.02), (sign * 0.32, 1.08), (sign * 0.38, 0.8), (sign * 0.24, 0.76)),
                       -0.27, 0.08, 0.025)
        limb(shins[sign], "Greave", "metal", (sign * 0.3, -0.03, 0.74), (sign * 0.34, -0.08, 0.31), 0.165, 0.72, 12)
        extruded_plate(shins[sign], "Greave front plate", "metal",
                       ((sign * 0.21, 0.7), (sign * 0.37, 0.74), (sign * 0.43, 0.42), (sign * 0.33, 0.24), (sign * 0.22, 0.4)),
                       -0.29, 0.08, 0.025)
        settle(bevelled_box(shins[sign], "Sabatons", "deep", (sign * 0.34, -0.2, 0.15), (0.31, 0.5, 0.3), 0.075, 3))
        for toe in range(3):
            tapered_curve(shins[sign], "Sabatons toe ridge", "metal",
                          ((sign * (0.24 + toe * 0.09), -0.42, 0.1), (sign * (0.24 + toe * 0.09), -0.51, 0.06)),
                          (0.8, 0.3), 0.022, 6)
        tapered_curve(head, "Swept horn", "metal",
                      ((sign * 0.25, 0.0, 2.85), (sign * 0.36, 0.02, 3.12), (sign * 0.58, 0.08, 3.35), (sign * 0.71, 0.12, 3.58)),
                      (1.0, 0.72, 0.36, 0.02), 0.15, 14)
        tapered_curve(head, "Horn ridge", "bone",
                      ((sign * 0.34, -0.02, 3.08), (sign * 0.54, 0.01, 3.31), (sign * 0.68, 0.05, 3.48)),
                      (0.42, 0.28, 0.02), 0.028, 10)
    for row, z in enumerate((1.62, 1.48, 1.34)):
        width = 0.41 - row * 0.035
        bevelled_box(torso, "Overlapping fauld plate", "metal", (0, -0.36, z), (width * 2, 0.15, 0.16), 0.045, 3)
    cloak_panel(tabards[1], "Torn knight tabard", "cloth", 0, 1.42, 0.58, 0.39, -0.47, 0.14)
    cloak_panel(tabards[-1], "Rear knight tabard", "cloth_dark", 0, 1.42, 0.58, 0.36, 0.28, 0.15)
    for sign in (-1, 1):
        for panel in range(2):
            extruded_plate(tabards[1], "Tabard torn hem", "cloth",
                           ((sign * (0.1 + panel * 0.16), 0.46),
                            (sign * (0.28 + panel * 0.08), 0.7),
                            (sign * (0.37 + panel * 0.02), 0.44),
                            (sign * (0.22 + panel * 0.1), 0.55)),
                           -0.53, 0.045, 0.008)
    for sign in (-1, 1):
        limb(tabards[1], "Tabard seam", "cloth_dark", (sign * 0.09, -0.49, 1.42), (sign * 0.13, -0.49, 0.2), 0.025, 0.3, 5)
    for z in (1.66, 1.82, 1.98):
        bevelled_box(torso, "Cuirass engraved rib", "shade", (0, -0.414, z), (0.52, 0.035, 0.045), 0.01, 2)
    sword_blade(strike, "Point-down cruciform greatsword", "metal", (0, -0.61, 1.76), (0, -0.61, 0.025), 0.19, 0.11)
    tapered_curve(strike, "Greatsword fuller", "stone_dark",
                  ((0, -0.674, 0.23), (0, -0.674, 0.82), (0, -0.674, 1.62)), (0.12, 0.2, 0.08), 0.022, 10)
    extruded_plate(strike, "Cruciform sword crossguard", "metal",
                   ((-0.42, 1.72), (-0.32, 1.84), (-0.12, 1.77), (0.12, 1.77), (0.32, 1.84), (0.42, 1.72),
                    (0.28, 1.66), (0, 1.71), (-0.28, 1.66)),
                   -0.65, 0.14, 0.035)
    tapered_curve(strike, "Sword leather grip", "cloth_dark",
                  ((0, -0.61, 1.8), (0, -0.61, 2.04), (0, -0.61, 2.18)), (1.0, 1.0, 0.78), 0.07, 10)
    torus(strike, "Sword grip ring", "metal", (0, -0.61, 1.98), 0.078, 0.018, (math.pi / 2, 0, 0), 16)
    ellipsoid(strike, "Crown pommel", "bone", (0, -0.61, 2.23), (0.12, 0.11, 0.12), 12, 8)

    with clip("idle", ground_root=root) as frames:
        bob(root, frames, 0.025, shape="lift")
        oscillate(torso, frames, rotation=(0.012, 0, 0))
        oscillate(head, frames, rotation=(0.02, 0, 0.05), phase=math.pi / 2)
        oscillate(visor, frames, scale=(0.08, 0, 0.35), shape="bounce")
        for sign, tabard in tabards.items():
            oscillate(tabard, frames, rotation=(sign * 0.035, 0, 0), phase=math.pi / 4)
        for sign in (-1, 1):
            oscillate(arms[sign], frames, rotation=(0.02, 0, 0), phase=0 if sign < 0 else math.pi / 2)
    with clip("move", ground_root=root) as frames:
        bob(root, frames, 0.04, shape="bounce")
        oscillate(torso, frames, rotation=(0, 0.03, 0.05))
        oscillate(head, frames, rotation=(0.02, 0, 0), cycles=2)
        for sign, tabard in tabards.items():
            oscillate(tabard, frames, rotation=(sign * 0.12, 0, 0), cycles=2)
        for sign in (-1, 1):
            step = 0 if sign < 0 else math.pi
            stride(legs[sign], shins[sign], frames, 0.3, 0.5, step)
            oscillate(arms[sign], frames, rotation=(0.12, 0, 0), phase=step + math.pi)
    with clip("attack_melee", ground_root=root) as frames:
        # Greatsword hauled overhead behind the helm, then cleaved down and forward with a step into it.
        pose(torso, frames, *strike_keys((-0.2, 0, -0.25), (0.4, 0, 0.2)))
        pose(head, frames, *strike_keys((-0.25, 0, 0.1), (0.2, 0, -0.1)))
        pose(strike, frames, *strike_keys((-2.6, 0, 0), (-0.9, 0, 0)))
        pose(legs[-1], frames, *strike_keys((0.15, 0, 0), (-0.4, 0, 0)))
        pose(legs[1], frames, *strike_keys((-0.1, 0, 0), (0.25, 0, 0)))
        for sign in (-1, 1):
            pose(shins[sign], frames, *strike_keys((0.1, 0, 0), (0.35, 0, 0)))
        for sign, tabard in tabards.items():
            pose(tabard, frames, *strike_keys((sign * -0.1, 0, 0), (sign * 0.25, 0, 0)))
    with clip("attack_ranged", ground_root=root) as frames:
        # Sword levelled at the target and held there while the wave goes out.
        pose(torso, frames, *strike_keys((-0.12, 0, -0.15), (0.15, 0, 0.1)))
        pose(head, frames, *strike_keys((-0.1, 0, 0), (0.1, 0, 0)))
        pose(strike, frames, *strike_keys((-2.2, 0, 0), (-1.55, 0, 0)))
        pose(legs[-1], frames, *strike_keys((0.1, 0, 0), (-0.25, 0, 0)))
        pose(shins[-1], frames, *strike_keys((0.1, 0, 0), (0.3, 0, 0)))
    with clip("hit", ground_root=root) as frames:
        flinch(torso, frames, (-0.08, 0, 0.05))
        flinch(head, frames, (-0.2, 0, 0.12))
        flinch(strike, frames, (0.15, 0, 0))
        for sign, tabard in tabards.items():
            flinch(tabard, frames, (sign * 0.15, 0, 0))
    with clip("stagger", ground_root=root) as frames:
        hold(torso, frames, (0.3, 0, 0), (0.03, 0, 0.02), cycles=6)
        hold(head, frames, (0.35, 0, 0), (0.04, 0, 0.05), cycles=5)
        hold(strike, frames, (0.35, 0, 0), (0.04, 0, 0), cycles=6, phase=math.pi / 2)
        for sign in (-1, 1):
            hold(shins[sign], frames, (0.3, 0, 0))
            hold(legs[sign], frames, (-0.15, 0, 0))
    with clip("death", ground_root=root) as frames:
        # Knees fold and the knight drops onto them, the greatsword falling forward across the ground.
        pose(root, frames, (0, ZERO, ZERO), (0.3, (-0.1, 0, 0), (0, 0, 0.04)),
             (0.7, (0.12, 0, 0), (0, -0.08, -0.46)), (1, (0.14, 0, 0.03), (0, -0.1, -0.48)))
        pose(torso, frames, (0, ZERO), (0.3, (-0.15, 0, 0)), (0.7, (0.6, 0, 0.05)), (1, (0.7, 0.03, 0.06)))
        pose(head, frames, (0, ZERO), (0.3, (-0.3, 0, 0)), (0.7, (0.45, 0, 0)), (1, (0.55, 0.08, 0.05)))
        pose(strike, frames, (0, ZERO), (0.3, (-0.6, 0, 0)), (0.7, (-1.8, 0, 0)), (1, (-1.9, 0, 0)))
        for sign in (-1, 1):
            pose(legs[sign], frames, (0, ZERO), (0.3, (0.05, 0, 0)), (0.7, (-0.65, 0, sign * 0.08)),
                 (1, (-0.7, 0, sign * 0.1)))
            pose(shins[sign], frames, (0, ZERO), (0.3, (0.1, 0, 0)), (0.7, (1.7, 0, 0)), (1, (1.75, 0, 0)))
        for sign, tabard in tabards.items():
            pose(tabard, frames, (0, ZERO), (0.3, (sign * 0.1, 0, 0)), (0.7, (sign * -0.5, 0, 0)), (1, (sign * -0.55, 0, 0)))


def build_swarm(root):
    head = joint(root, "rig_head", (0, 0, 1.53))
    cage = joint(root, "rig_cage", (0, 0, 1.53))
    strike = joint(root, "rig_strike", (0, 0, 1.5))

    ellipsoid(head, "Caged heart", "deep", (0, 0, 1.53), (0.43, 0.42, 0.55), 16, 12)
    ellipsoid(head, "Singularity core", "accent", (0, -0.38, 1.56), (0.22, 0.075, 0.28), 16, 12, smooth=False)
    for rib in range(10):
        azimuth = math.tau * rib / 10
        start_angle = 0.12 + (rib % 3) * 0.06
        end_angle = math.pi - 0.16 - (rib % 4) * 0.055
        points = []
        radii = []
        for i in range(11):
            t = start_angle + (end_angle - start_angle) * i / 10
            swell = math.sin(t)
            points.append((math.cos(azimuth) * 0.67 * swell,
                           math.sin(azimuth) * 0.48 * swell - 0.01,
                           1.53 + math.cos(t) * 0.83))
            radii.append(0.15 if i in (0, 10) else 0.82 + swell * 0.2)
        tapered_curve(cage, "Broken bone cage rib", "bone", points, radii, 0.085, 10)
    shards = []
    for i in range(40):
        angle = i * math.tau / 40
        radius = 0.9 + 0.42 * math.sin(i * 2.6)
        z = 0.5 + (i % 9) * 0.25
        size = 0.14 + (i % 4) * 0.045
        pos = (math.cos(angle) * radius, math.sin(angle) * radius, z)
        role = "bone" if i % 7 == 0 else "deep"
        if i % 3 == 0:
            shard = rock_chunk(strike, "Floating fractured shard", role, pos,
                               (size * 0.58, size * 0.72, size * 1.65),
                               2200 + i, voxel=0.04, decimate=0.28)
        else:
            shard = blade(strike, "Orbiting crystal splinter", role,
                          (pos[0] - size * 0.36, pos[1], pos[2] - size),
                          (pos[0] + size * 0.24, pos[1] + size * 0.08, pos[2] + size * 1.1),
                          size * 0.72, 0.045, 8)
        # Orbit about the strike joint: the shard's rest offset from it gives the true radius and start angle.
        offset = Vector(shard.location)
        shards.append((shard, math.hypot(offset.x, offset.y), math.atan2(offset.y, offset.x), offset.z, 1 + i % 4))

    with clip("idle", ground_root=root) as frames:
        bob(root, frames, 0.05, shape="lift")
        spin(cage, frames, axis=2, turns=1)
        oscillate(head, frames, scale=(0.05, 0.05, 0.05), cycles=2)
        for shard, radius, start_angle, z, turns in shards:
            orbit(shard, frames, (0, 0), radius, start_angle, turns, z)
    with clip("move", ground_root=root) as frames:
        bob(root, frames, 0.04, shape="lift")
        spin(cage, frames, axis=2, turns=2)
        oscillate(head, frames, scale=(0.08, 0.08, 0.08))
        for shard, radius, start_angle, z, turns in shards:
            orbit(shard, frames, (0, 0), radius, start_angle, turns, z)
    with clip("attack_melee", ground_root=root) as frames:
        # The shard cloud contracts onto the heart, then bursts outward as the cage whips round.
        pose(strike, frames, *strike_keys(ZERO, ZERO, scale=((-0.3, -0.3, -0.3), (0.6, 0.6, 0.6))))
        pose(head, frames, *strike_keys(ZERO, ZERO, scale=((0.2, 0.2, 0.2), (-0.15, -0.15, -0.15))))
        pose(cage, frames, *strike_keys((0, 0, -0.7), (0.15, 0, 1.4)))
    with clip("attack_ranged", ground_root=root) as frames:
        # Cloud lifts and swells while the heart brightens: the volley tell.
        pose(strike, frames, *strike_keys(ZERO, ZERO, location=((0, 0, -0.1), (0, 0, 0.4)),
                                          scale=((-0.2, -0.2, -0.2), (0.35, 0.35, 0.35))))
        pose(head, frames, *strike_keys(ZERO, ZERO, scale=((0.15, 0.15, 0.15), (0.3, 0.3, 0.3))))
        pose(cage, frames, *strike_keys((0, 0, -0.4), (0, 0, 0.9)))
    with clip("hit", ground_root=root) as frames:
        flinch(cage, frames, (0.15, 0.1, 0))
        pose(head, frames, (0, ZERO, None, ZERO), (0.3, ZERO, None, (-0.12, -0.12, -0.12)), (1, ZERO, None, ZERO))
        pose(strike, frames, (0, ZERO, None, ZERO), (0.3, ZERO, None, (0.1, 0.1, 0.1)), (1, ZERO, None, ZERO))
    with clip("stagger", ground_root=root) as frames:
        hold(cage, frames, (0.35, 0.2, 0), (0.06, 0.04, 0), cycles=6)
        hold(strike, frames, (0.25, 0, 0), (0.04, 0, 0), cycles=5)
        oscillate(head, frames, scale=(0.06, 0.06, 0.06), cycles=6)
    with clip("death", ground_root=root) as frames:
        # The heart implodes, the cage tumbles and the shards lose their orbit, flattening out across the floor.
        pose(head, frames, (0, ZERO, None, ZERO), (0.3, ZERO, None, (0.25, 0.25, 0.25)),
             (0.7, ZERO, (0, 0, -0.5), (-0.6, -0.6, -0.6)), (1, ZERO, (0, 0, -0.55), (-0.65, -0.65, -0.65)))
        pose(cage, frames, (0, ZERO, ZERO, ZERO), (0.3, (0.1, 0, 0.3), (0, 0, 0.1), (0.05, 0.05, 0.05)),
             (0.7, (1.2, 0.4, 0.6), (0, 0, -0.65), (-0.3, -0.3, -0.3)), (1, (1.25, 0.42, 0.65), (0, 0, -0.7), (-0.3, -0.3, -0.3)))
        pose(strike, frames, (0, ZERO, ZERO, ZERO), (0.3, ZERO, (0, 0, 0.15), (-0.15, -0.15, -0.15)),
             (0.7, (0, 0, 0.5), (0, 0, -0.5), (0.9, 0.9, -0.4)), (1, (0, 0, 0.55), (0, 0, -0.55), (0.95, 0.95, -0.42)))


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
    bpy.context.scene.frame_set(1)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=filepath,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        # Held poses (stagger) key a constant offset from rest; the optimiser would otherwise drop them entirely.
        export_optimize_animation_keep_anim_object=True,
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
