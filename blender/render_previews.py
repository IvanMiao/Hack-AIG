import os
import sys

import bpy
from mathutils import Vector


def point_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def render_asset(filepath, output, engine):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=filepath)
    scene = bpy.context.scene
    scene.render.engine = engine
    scene.render.resolution_x = 900
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.world = bpy.data.worlds.new("Void") if not scene.world else scene.world
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.005, 0.006, 0.012, 1)
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.32

    meshes = [obj for obj in scene.objects if obj.type == "MESH"]
    corners = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    minimum = Vector(tuple(min(v[axis] for v in corners) for axis in range(3)))
    maximum = Vector(tuple(max(v[axis] for v in corners) for axis in range(3)))
    center = (minimum + maximum) / 2
    extent = maximum - minimum
    size = max(extent.x, extent.y, extent.z)

    camera_data = bpy.data.cameras.new("Preview camera")
    camera = bpy.data.objects.new("Preview camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera_data.type = "ORTHO"
    is_arena = "arena" in filepath
    if is_arena:
        center = Vector((0, 0, -0.6))
    camera_data.ortho_scale = 42 if is_arena else size * 1.55
    camera.location = center + Vector((size * 0.9, -size * 1.35, size * 0.82))
    point_at(camera, center)

    for name, position, energy, size_factor in (
        ("Key", (4, -7, 9), 1600, 0.7),
        ("Fill", (-6, -4, 4), 900, 1.0),
        ("Rim", (2, 5, 8), 1900, 0.65),
    ):
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.shape = "DISK"
        data.size = max(size * size_factor, 2)
        lamp = bpy.data.objects.new(name, data)
        scene.collection.objects.link(lamp)
        lamp.location = center + Vector(position) * max(size / 5, 1)
        point_at(lamp, center)

    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "Medium High Contrast"
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1
    scene.render.filepath = output
    bpy.ops.render.render(write_still=True)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    here = os.path.dirname(os.path.abspath(__file__))
    assets = os.path.abspath(argv[0]) if argv else os.path.join(here, "..", "src", "assets", "models")
    output_dir = os.path.join(here, "previews")
    os.makedirs(output_dir, exist_ok=True)
    assets_to_render = sorted(
        os.path.join(assets, name) for name in os.listdir(assets) if name.endswith(".glb")
    )
    for filepath in assets_to_render:
        name = os.path.splitext(os.path.basename(filepath))[0]
        output = os.path.join(output_dir, f"{name}.png")
        try:
            render_asset(filepath, output, "BLENDER_EEVEE_NEXT")
        except Exception as error:
            print(f"EEVEE preview failed for {name}: {error}; trying WORKBENCH")
            render_asset(filepath, output, "BLENDER_WORKBENCH")
        if not os.path.exists(output):
            print(f"EEVEE produced no preview for {name}; trying WORKBENCH")
            render_asset(filepath, output, "BLENDER_WORKBENCH")
        print(f"PREVIEW {output}")


if __name__ == "__main__":
    main()
