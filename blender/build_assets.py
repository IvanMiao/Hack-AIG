import argparse
import math
import os
import random
import sys

import bpy
from mathutils import Vector


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


def material(role):
    existing = bpy.data.materials.get(role)
    if existing:
        return existing
    mat = bpy.data.materials.new(role)
    mat.diffuse_color = ROLES[role]
    mat.use_nodes = True
    principled = mat.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = ROLES[role]
    principled.inputs["Roughness"].default_value = 0.85
    if role in ("accent", "glow"):
        principled.inputs["Emission Color"].default_value = ROLES[role]
        principled.inputs["Emission Strength"].default_value = 1.8
    return mat


def clean_scene(asset_name, frames=49):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in list(bpy.data.materials):
        bpy.data.materials.remove(block)
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = frames
    scene.render.fps = 24
    root = bpy.data.objects.new(asset_name, None)
    scene.collection.objects.link(root)
    return root


def finish(obj, role, parent):
    if not obj.name or obj.name.startswith("Cube") or obj.name.startswith("Sphere"):
        obj.name = f"{parent.name}_{role}_{len(parent.children):03d}"
    if obj.type == "MESH" and obj.data.vertices:
        bounds = [tuple(vertex.co) for vertex in obj.data.vertices]
        center = Vector((
            (min(point[0] for point in bounds) + max(point[0] for point in bounds)) / 2,
            (min(point[1] for point in bounds) + max(point[1] for point in bounds)) / 2,
            (min(point[2] for point in bounds) + max(point[2] for point in bounds)) / 2,
        ))
        if center.length > 1e-6:
            for vertex in obj.data.vertices:
                vertex.co -= center
            obj.location += center
    obj.data.materials.clear()
    obj.data.materials.append(material(role))
    for polygon in getattr(obj.data, "polygons", []):
        polygon.use_smooth = False
    obj.parent = parent
    return obj


def sphere(parent, name, role, pos, scale, segments=10, rings=6):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=pos)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    return finish(obj, role, parent)


def ico(parent, name, role, pos, scale, subdivisions=1):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=1, location=pos)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    return finish(obj, role, parent)


def cube(parent, name, role, pos, scale, bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=pos)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod = obj.modifiers.new("Chipped edges", "BEVEL")
        mod.width = bevel
        mod.segments = 1
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return finish(obj, role, parent)


def cylinder(parent, name, role, pos, radius, depth, vertices=8, radius_top=None):
    if radius_top is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=pos)
    else:
        bpy.ops.mesh.primitive_cone_add(
            vertices=vertices, radius1=radius, radius2=radius_top, depth=depth, location=pos
        )
    obj = bpy.context.object
    obj.name = name
    return finish(obj, role, parent)


def between(parent, name, role, start, end, radius, vertices=8):
    a, b = Vector(start), Vector(end)
    direction = b - a
    obj = cylinder(parent, name, role, (a + b) / 2, radius, direction.length, vertices)
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = direction.to_track_quat("Z", "Y")
    return obj


def torus(parent, name, role, pos, major, minor, rotation=None, major_segments=24):
    bpy.ops.mesh.primitive_torus_add(
        major_segments=major_segments, minor_segments=4, major_radius=major, minor_radius=minor, location=pos
    )
    obj = bpy.context.object
    obj.name = name
    if rotation:
        obj.rotation_euler = rotation
    return finish(obj, role, parent)


def animate_idle(root, length=49, amplitude=0.08):
    middle = (length + 1) // 2
    for frame, z in ((1, 0), (middle, amplitude), (length, 0)):
        root.location.z = z
        root.keyframe_insert(data_path="location", frame=frame, group="Idle")
    if root.animation_data and root.animation_data.action:
        root.animation_data.action.name = "Idle"
        for curve in root.animation_data.action.fcurves:
            for point in curve.keyframe_points:
                point.interpolation = "BEZIER"
            curve.modifiers.new("CYCLES")


def build_arena():
    root = clean_scene("arena", 1)
    rng = random.Random(7251)
    segments = 64
    verts = []
    for z, radius in ((0, 9), (-1.2, 7.25), (-5.8, 2.0)):
        for i in range(segments):
            angle = i * math.tau / segments
            edge = 1 + (rng.random() - 0.5) * (0.09 if z == 0 else 0.035)
            verts.append((math.cos(angle) * radius * edge, math.sin(angle) * radius * edge, z))
    faces = []
    faces.append(tuple(range(segments)))
    for layer in range(2):
        top, bottom = layer * segments, (layer + 1) * segments
        for i in range(segments):
            j = (i + 1) % segments
            faces.extend(((top + i, top + j, bottom + j), (top + i, bottom + j, bottom + i)))
    mesh = bpy.data.meshes.new("Fractured platform")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    platform = bpy.data.objects.new("Arena solid walkable disc", mesh)
    bpy.context.scene.collection.objects.link(platform)
    finish(platform, "stone", root)
    for i in range(6):
        angle = math.tau * i / 6 + rng.uniform(-0.12, 0.12)
        radius = rng.uniform(9.2, 10.2)
        scale = rng.uniform(0.7, 1.15)
        ico(
            root, "Broken edge shard", "stone_dark",
            (math.cos(angle) * radius, math.sin(angle) * radius, rng.uniform(-0.12, 0.18)),
            (scale, scale * 0.72, scale * 0.42), 1,
        )
    torus(root, "Runic circle", "glow", (0, 0, 0.035), 3.45, 0.035, major_segments=64)
    torus(root, "Runic inner ring", "glow", (0, 0, 0.038), 2.95, 0.018, major_segments=48)
    for i in range(16):
        angle = math.tau * i / 16
        x, y = math.cos(angle), math.sin(angle)
        a, b = 3.1, 3.75 if i % 2 == 0 else 3.52
        p0 = (a * x, a * y, 0.045)
        p1 = (b * math.cos(angle + 0.06), b * math.sin(angle + 0.06), 0.045)
        between(root, "Runic glyph", "glow", p0, p1, 0.027, 5)
    for i in range(24):
        angle = math.tau * i / 24 + 0.04 * (i % 2)
        inner, outer = 7.3 + rng.random() * 0.45, 8.65 + rng.random() * 0.3
        between(
            root,
            "Rim fracture",
            "glow",
            (math.cos(angle) * inner, math.sin(angle) * inner, 0.035),
            (math.cos(angle + 0.045) * outer, math.sin(angle + 0.045) * outer, 0.035),
            0.025,
            4,
        )
    for i in range(7):
        angle = math.tau * i / 7 + 0.15
        radius = 10.8 + rng.uniform(0, 1.1)
        height = rng.uniform(3.2, 6.0)
        x, y = math.cos(angle) * radius, math.sin(angle) * radius
        pillar = cylinder(root, "Broken obelisk", "stone_dark" if i % 3 == 0 else "stone",
                          (x, y, height / 2), rng.uniform(0.42, 0.62), height, 5, 0.21)
        pillar.rotation_euler.x = rng.uniform(-0.14, 0.14)
        pillar.rotation_euler.y = rng.uniform(-0.18, 0.18)
        if i % 2 == 0:
            ico(root, "Snapped cap", "stone_dark", (x + 0.3, y, height + 0.7), (0.55, 0.55, 0.45), 1)
    for i in range(20):
        angle = rng.uniform(0, math.tau)
        radius = rng.uniform(12, 25)
        pos = (math.cos(angle) * radius, math.sin(angle) * radius, rng.uniform(-8, 6))
        scale = rng.uniform(0.22, 0.9)
        ico(root, "Floating debris", "stone_dark" if i % 3 == 0 else "stone",
            pos, (scale * 1.3, scale, scale * rng.uniform(0.7, 1.5)), 1)
    return root


def build_player():
    root = clean_scene("player", 49)
    # Faceted cloak with an uneven, torn hem.
    verts = [
        (-0.18, 0.06, 0.35), (0.18, 0.06, 0.35),
        (-0.34, 0.08, 1.48), (0.34, 0.08, 1.48),
        (-0.42, 0.02, 0.22), (-0.22, 0.05, 0.10), (0.02, 0.03, 0.28),
        (0.25, 0.05, 0.08), (0.43, 0.01, 0.23), (0, 0.12, 1.8),
    ]
    faces = [(0, 2, 9), (2, 3, 9), (3, 1, 9), (1, 0, 9),
             (0, 4, 5, 6), (0, 6, 7, 1), (1, 7, 8), (1, 8, 3),
             (0, 1, 3, 2), (4, 0, 2), (8, 7, 3)]
    mesh = bpy.data.meshes.new("Tattered cloak mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    cloak = bpy.data.objects.new("Cloak", mesh)
    bpy.context.scene.collection.objects.link(cloak)
    finish(cloak, "cloth", root)
    sphere(root, "Hood", "cloth_dark", (0, 0.0, 1.65), (0.43, 0.4, 0.43), 10, 7)
    sphere(root, "Face void", "shade", (0, -0.33, 1.63), (0.245, 0.06, 0.25), 8, 6)
    for x in (-0.11, 0.11):
        sphere(root, "Eye", "glow", (x, -0.395, 1.68), (0.043, 0.028, 0.035), 6, 4)
    for sign in (-1, 1):
        sphere(root, "Mantle", "cloth_dark", (sign * 0.36, 0, 1.32), (0.3, 0.34, 0.18), 7, 5)
        between(root, "Sleeve", "cloth", (sign * 0.33, 0, 1.25), (sign * 0.52, -0.03, 0.78), 0.12)
        sphere(root, "Glove", "metal", (sign * 0.52, -0.04, 0.72), (0.13, 0.14, 0.12), 7, 5)
    for i in range(7):
        y = -0.12 + i * 0.1
        x = 0.55 + (0.1 if i % 2 else 0)
        torus(root, "Chain link", "metal", (x, y, 0.67 - i * 0.09), 0.085, 0.022,
              (math.pi / 2, 0, (i % 2) * math.pi / 2), 8)
    ico(root, "Chain weight", "bone", (0.6, 0.58, 0.03), (0.12, 0.15, 0.16), 1)
    animate_idle(root, 49, 0.045)
    return root


def build_colossus(root):
    sphere(root, "Hunched torso", "deep", (0, 0.1, 2.45), (1.15, 0.85, 1.35), 10, 7)
    sphere(root, "Back hump", "shade", (0, 0.56, 3.1), (0.95, 0.7, 0.8), 8, 5)
    sphere(root, "Head", "deep", (0, -0.43, 3.45), (0.66, 0.57, 0.66), 9, 6)
    for x in (-0.23, 0.23):
        sphere(root, "Eye", "accent", (x, -0.91, 3.53), (0.1, 0.06, 0.08), 6, 4)
        between(root, "Horn", "bone", (x * 2.3, -0.38, 3.72), (x * 3.1, -0.45, 4.45), 0.12, 6)
    for sign in (-1, 1):
        shoulder = ico(root, "Rock shoulder", "stone", (sign * 1.05, 0.03, 3.15), (0.62, 0.75, 0.57), 1)
        shoulder.rotation_euler.y = sign * 0.25
        between(root, "Long arm", "deep", (sign * 1.06, 0.04, 2.95), (sign * 1.52, -0.2, 1.35), 0.34)
        ico(root, "Fist", "stone_dark", (sign * 1.56, -0.28, 0.95), (0.48, 0.42, 0.48), 1)
        for claw in range(3):
            between(root, "Fist spike", "bone",
                    (sign * (1.34 + claw * 0.2), -0.58, 0.9),
                    (sign * (1.34 + claw * 0.2), -0.7, 0.55), 0.075, 5)
        between(root, "Leg", "deep", (sign * 0.42, 0.08, 1.25), (sign * 0.5, -0.12, 0.2), 0.29)
    for i in range(5):
        y = 0.55 + i * 0.25
        between(root, "Dorsal plate", "bone", (0, y, 3.3 - i * 0.27), (0, y + 0.16, 3.9 - i * 0.26), 0.13, 5)


def build_hound(root):
    sphere(root, "Low body", "deep", (0, 0.2, 0.83), (0.63, 1.05, 0.55), 9, 6)
    sphere(root, "Long neck", "deep", (0, -0.75, 1.18), (0.39, 0.72, 0.42), 8, 5)
    sphere(root, "Skull", "shade", (0, -1.25, 1.15), (0.52, 0.58, 0.4), 8, 5)
    sphere(root, "Maw", "accent", (0, -1.67, 1.02), (0.31, 0.08, 0.18), 8, 4)
    for x in (-0.34, 0.34):
        sphere(root, "Eye", "glow", (x, -1.53, 1.3), (0.08, 0.04, 0.055), 6, 4)
    for x in (-0.42, 0.42):
        for y in (-0.42, 0.83):
            between(root, "Leg", "deep", (x, y, 0.83), (x * 1.2, y + 0.12, 0.12), 0.14)
            ico(root, "Paw", "bone", (x * 1.2, y + 0.08, 0.12), (0.21, 0.25, 0.12), 1)
    for i in range(8):
        y = -0.75 + i * 0.28
        between(root, "Spine spike", "bone", (0, y, 1.35 if i < 3 else 1.22), (0, y + 0.06, 1.85 - i * 0.08), 0.09, 5)
    between(root, "Tail", "deep", (0, 1.05, 0.92), (0, 1.72, 1.48), 0.13)
    between(root, "Tail tip", "bone", (0, 1.72, 1.48), (0, 2.05, 1.78), 0.09, 5)


def build_seraph(root):
    sphere(root, "Torso", "deep", (0, 0.08, 2.15), (0.58, 0.4, 0.92), 9, 6)
    sphere(root, "Mask", "bone", (0, -0.12, 2.92), (0.4, 0.3, 0.48), 8, 5)
    sphere(root, "Face void", "shade", (0, -0.39, 2.91), (0.24, 0.05, 0.25), 8, 5)
    for x in (-0.12, 0.12):
        sphere(root, "Eye", "accent", (x, -0.44, 2.96), (0.055, 0.025, 0.06), 6, 4)
    torus(root, "Halo", "glow", (0, 0.04, 3.12), 0.5, 0.045, major_segments=32)
    for sign in (-1, 1):
        for level, z in enumerate((1.25, 2.0, 2.72)):
            start = (sign * 0.35, 0.12, z)
            end = (sign * (1.3 + level * 0.12), 0.17, z + (0.58 if level == 2 else 0.25))
            blade = between(root, "Blade wing", "bone", start, end, 0.22, 5)
            blade.rotation_euler.y = sign * -0.18
            between(root, "Wing edge", "accent", end, (end[0] * 1.06, end[1] - 0.03, end[2] + 0.16), 0.035, 4)
    for x in (-0.24, 0, 0.24):
        between(root, "Trailing robe spike", "cloth", (x, 0.07, 1.65), (x * 1.5, 0.12, 0.25 + abs(x) * 0.2), 0.13, 5)


def build_serpent(root):
    for i in range(11):
        angle = math.tau * i / 11
        z = 0.43 + i * 0.2
        radius = 1.05 - i * 0.037
        pos = (math.cos(angle) * radius, math.sin(angle) * radius + 0.25, z)
        segment = ico(root, "Coil segment", "deep" if i % 3 else "shade", pos, (0.47, 0.45, 0.38), 1)
        segment.rotation_euler.z = angle
        sphere(root, "Scale plate", "bone", (pos[0], pos[1] - 0.34, z + 0.08), (0.19, 0.07, 0.14), 7, 4)
    sphere(root, "Raised neck", "deep", (0, -0.1, 2.25), (0.42, 0.48, 0.88), 8, 6)
    sphere(root, "Hood", "shade", (0, -0.03, 2.92), (0.82, 0.3, 0.66), 9, 5)
    sphere(root, "Head", "deep", (0, -0.4, 3.12), (0.42, 0.47, 0.4), 8, 5)
    for x in (-0.17, 0.17):
        sphere(root, "Eye", "accent", (x, -0.81, 3.2), (0.07, 0.035, 0.06), 6, 4)
        between(root, "Fang", "bone", (x * 0.6, -0.78, 2.98), (x * 0.7, -0.83, 2.7), 0.055, 5)
    for sign in (-1, 1):
        between(root, "Crown horn", "bone", (sign * 0.3, -0.12, 3.28), (sign * 0.76, -0.02, 3.72), 0.105, 5)


def build_knight(root):
    sphere(root, "Armoured torso", "deep", (0, 0.08, 1.78), (0.68, 0.43, 0.77), 9, 6)
    sphere(root, "Helm", "metal", (0, -0.05, 2.63), (0.48, 0.4, 0.55), 8, 5)
    cube(root, "Visor", "accent", (0, -0.43, 2.65), (0.5, 0.055, 0.09))
    for x in (-0.28, 0.28):
        ico(root, "Pauldron", "bone", (x * 2, 0, 2.14), (0.43, 0.48, 0.32), 1)
        between(root, "Armour arm", "metal", (x * 1.8, 0, 2), (x * 2, -0.2, 1.17), 0.2)
        between(root, "Leg", "metal", (x * 0.75, 0.08, 1.17), (x, -0.05, 0.22), 0.22)
        sphere(root, "Boot", "shade", (x, -0.2, 0.17), (0.27, 0.35, 0.16), 7, 5)
        between(root, "Helm horn", "bone", (x * 0.9, 0.02, 2.88), (x * 1.6, 0.04, 3.48), 0.1, 5)
    # Torn tabard and its split hem.
    cube(root, "Tabard", "cloth", (0, -0.3, 1.15), (0.62, 0.08, 0.98))
    for x in (-0.21, 0, 0.21):
        between(root, "Tabard tear", "cloth_dark", (x, -0.36, 0.78), (x * 1.12, -0.37, 0.38), 0.045, 4)
    between(root, "Greatsword blade", "bone", (0.85, -0.25, 1.5), (1.05, -0.28, 0.12), 0.12, 4)
    cube(root, "Sword crossguard", "metal", (0.85, -0.25, 1.55), (0.56, 0.1, 0.11))
    between(root, "Sword hilt", "cloth_dark", (0.85, -0.25, 1.62), (0.85, -0.25, 2.0), 0.075)
    sphere(root, "Sword pommel", "accent", (0.85, -0.25, 2.04), (0.11, 0.11, 0.11), 6, 4)


def build_swarm(root, length=73):
    sphere(root, "Heart", "deep", (0, 0, 1.55), (0.55, 0.55, 0.62), 9, 6)
    sphere(root, "Core", "accent", (0, -0.48, 1.6), (0.27, 0.12, 0.33), 8, 5)
    for i in range(28):
        angle = i * math.tau / 28
        radius = 1.1 + 0.24 * math.sin(i * 3.7)
        z = 0.85 + (i % 7) * 0.33
        scale = 0.11 + (i % 3) * 0.035
        pos = (math.cos(angle) * radius, math.sin(angle) * radius, z)
        shard = ico(root, "Orbiting shard", "accent" if i % 5 == 0 else ("bone" if i % 3 == 0 else "deep"),
                    pos, (scale, scale * 0.75, scale * 1.8), 1)
        shard.rotation_euler = (angle * 0.7, angle, angle * 1.6)
        orbit = i % 4
        start = shard.location.copy()
        turn = angle + (math.tau if orbit % 2 == 0 else -math.tau)
        end = (math.cos(turn) * radius, math.sin(turn) * radius, z)
        mid = (math.cos(angle + math.pi) * radius, math.sin(angle + math.pi) * radius, z)
        for frame, p in ((1, start), ((length + 1) // 2, mid), (length, end)):
            shard.location = p
            shard.keyframe_insert(data_path="location", frame=frame, group="Orbit")
    animate_idle(root, length, 0.04)


BOSSES = {
    "colossus": build_colossus,
    "hound": build_hound,
    "seraph": build_seraph,
    "serpent": build_serpent,
    "knight": build_knight,
    "swarm": build_swarm,
}


def build_boss(silhouette):
    frames = 73 if silhouette == "swarm" else 49
    root = clean_scene(f"boss_{silhouette}", frames)
    BOSSES[silhouette](root)
    if silhouette != "swarm":
        animate_idle(root, frames, 0.055)
    return root


def mesh_triangles():
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
    )
    size = os.path.getsize(filepath)
    triangles = mesh_triangles()
    triangle_budget = 12000 if name == "arena" else 6000
    if size >= 300 * 1024:
        raise RuntimeError(f"{name} exceeds 300 KB: {size:,} bytes")
    if triangles >= triangle_budget:
        raise RuntimeError(f"{name} exceeds {triangle_budget} triangles: {triangles:,}")
    print(f"ASSET {name}: {size:,} bytes, {triangles:,} triangles")


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="src/assets/models")
    args = parser.parse_args(argv)
    output = os.path.abspath(args.out)
    os.makedirs(output, exist_ok=True)
    for name, builder in [("arena", build_arena), ("player", build_player)]:
        builder()
        export_asset(name, output)
    for silhouette in BOSSES:
        build_boss(silhouette)
        export_asset(f"boss_{silhouette}", output)
    total_size = sum(os.path.getsize(os.path.join(output, name)) for name in os.listdir(output) if name.endswith(".glb"))
    if total_size >= 2 * 1024 * 1024:
        raise RuntimeError(f"model library exceeds 2 MB: {total_size:,} bytes")
    print(f"TOTAL: {total_size:,} bytes")


if __name__ == "__main__":
    main()
