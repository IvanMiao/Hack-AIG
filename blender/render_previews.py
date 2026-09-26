import os
import sys

import bpy
from mathutils import Vector


PREVIEW_TINTS = {
    "deep": (0.28, 0.27, 0.3, 1),
    "shade": (0.09, 0.09, 0.12, 1),
    "accent": (0.82, 0.055, 0.16, 1),
    "bone": (0.65, 0.62, 0.55, 1),
    "stone": (0.3, 0.32, 0.38, 1),
    "stone_dark": (0.13, 0.14, 0.18, 1),
    "cloth": (0.25, 0.23, 0.27, 1),
    "cloth_dark": (0.09, 0.09, 0.12, 1),
    "metal": (0.43, 0.46, 0.52, 1),
    "glow": (0.88, 0.12, 0.36, 1),
}


def point_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def tint_preview_materials():
    for material in bpy.data.materials:
        role = material.name.split(".")[0]
        tint = PREVIEW_TINTS.get(role)
        if not tint or not material.use_nodes:
            continue
        nodes = material.node_tree.nodes
        links = material.node_tree.links
        principled = nodes.get("Principled BSDF")
        if not principled:
            continue
        color_input = principled.inputs["Base Color"]
        image_links = [link for link in color_input.links if link.from_node.type == "TEX_IMAGE"]
        if image_links:
            source = image_links[0].from_socket
            for link in list(color_input.links):
                links.remove(link)
            multiply = nodes.new("ShaderNodeMixRGB")
            multiply.blend_type = "MULTIPLY"
            multiply.inputs[0].default_value = 1
            multiply.inputs[2].default_value = tint
            links.new(source, multiply.inputs[1])
            links.new(multiply.outputs["Color"], color_input)
        else:
            color_input.default_value = tint


def bounds(scene):
    meshes = [obj for obj in scene.objects if obj.type == "MESH"]
    corners = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    minimum = Vector(tuple(min(point[axis] for point in corners) for axis in range(3)))
    maximum = Vector(tuple(max(point[axis] for point in corners) for axis in range(3)))
    return minimum, maximum, (minimum + maximum) / 2, maximum - minimum


def add_light(scene, name, center, offset, size, energy, color):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy * max(size / 5, 0.5)
    data.shape = "DISK"
    data.size = max(size * 0.28, 1.8)
    data.color = color
    lamp = bpy.data.objects.new(name, data)
    scene.collection.objects.link(lamp)
    lamp.location = center + Vector(offset) * max(size / 4, 0.7)
    point_at(lamp, center)


def render_view(filepath, output, view, engine):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=filepath)
    tint_preview_materials()
    scene = bpy.context.scene
    scene.render.engine = engine
    scene.render.resolution_x = 640
    scene.render.resolution_y = 576
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    if engine == "BLENDER_EEVEE_NEXT":
        scene.eevee.taa_render_samples = 8
    scene.render.film_transparent = False
    scene.world = bpy.data.worlds.new("Mid-grey preview world")
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes["Background"]
    background.inputs["Color"].default_value = (0.19, 0.2, 0.21, 1)
    background.inputs["Strength"].default_value = 0.8
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1

    minimum, maximum, center, extent = bounds(scene)
    size = max(extent.x, extent.y, extent.z)
    is_arena = os.path.basename(filepath).startswith("arena")
    is_serpent = os.path.basename(filepath).startswith("boss_serpent")
    if is_arena:
        center = Vector((0, 0, -1.0))
    camera_data = bpy.data.cameras.new("Preview camera")
    camera = bpy.data.objects.new("Preview camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 54 if is_arena else max(extent.x, extent.z) * 1.7
    distance = max(size * 1.8, 8)
    if is_arena and view == "front":
        camera.location = center + Vector((0, -38, 31))
    elif is_arena:
        camera.location = center + Vector((22, -38, 31))
    elif is_serpent and view == "front":
        camera.location = center + Vector((0, -distance, size * 0.55))
    elif is_serpent:
        camera.location = center + Vector((distance * 0.68, -distance, size * 0.9))
    elif view == "front":
        camera.location = center + Vector((0, -distance, size * 0.05))
    else:
        camera.location = center + Vector((distance * 0.68, -distance, size * 0.35))
    point_at(camera, center)

    add_light(scene, "Key", center, (0.7, -1.0, 1.3), size, 250, (1.0, 0.91, 0.78))
    add_light(scene, "Fill", center, (-1.0, -0.5, 0.5), size, 140, (0.72, 0.82, 1.0))
    add_light(scene, "Rim", center, (0.5, 1.0, 1.2), size, 240, (1.0, 0.58, 0.72))
    scene.render.filepath = output
    bpy.ops.render.render(write_still=True)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    here = os.path.dirname(os.path.abspath(__file__))
    assets = os.path.abspath(argv[0]) if argv else os.path.join(here, "..", "src", "assets", "models")
    requested = set(argv[1:])
    output_dir = os.path.join(here, "previews")
    os.makedirs(output_dir, exist_ok=True)
    asset_files = sorted(
        os.path.join(assets, name) for name in os.listdir(assets)
        if name.endswith(".glb") and (not requested or os.path.splitext(name)[0] in requested)
    )
    available = {os.path.splitext(os.path.basename(filepath))[0] for filepath in asset_files}
    missing = requested - available
    if missing:
        raise ValueError(f"Unknown assets: {', '.join(sorted(missing))}")
    for filepath in asset_files:
        name = os.path.splitext(os.path.basename(filepath))[0]
        for view in ("front", "three-quarter"):
            output = os.path.join(output_dir, f"{name}-{view}.png")
            try:
                render_view(filepath, output, view, "BLENDER_EEVEE_NEXT")
            except Exception as error:
                print(f"EEVEE preview failed for {name} {view}: {error}; trying WORKBENCH")
                render_view(filepath, output, view, "BLENDER_WORKBENCH")
            if not os.path.exists(output):
                print(f"EEVEE produced no preview for {name} {view}; trying WORKBENCH")
                render_view(filepath, output, view, "BLENDER_WORKBENCH")
            print(f"PREVIEW {output}")


if __name__ == "__main__":
    main()
