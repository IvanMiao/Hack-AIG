import os
import sys

import bpy
from mathutils import Vector


def point_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


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
    scene = bpy.context.scene
    scene.render.engine = engine
    scene.render.resolution_x = 1000
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
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
    if is_arena:
        center = Vector((0, 0, -1.2))
    camera_data = bpy.data.cameras.new("Preview camera")
    camera = bpy.data.objects.new("Preview camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 54 if is_arena else max(extent.x, extent.z) * 1.7
    distance = max(size * 1.8, 8)
    if view == "front":
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
    output_dir = os.path.join(here, "previews")
    os.makedirs(output_dir, exist_ok=True)
    for filepath in sorted(
        os.path.join(assets, name) for name in os.listdir(assets) if name.endswith(".glb")
    ):
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
