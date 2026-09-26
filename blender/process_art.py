import os
import sys

import bpy
import numpy as np


TEXTURE_IDS = ("stone_floor", "rock", "cloth", "armor", "bone", "hide")
NORMAL_IDS = TEXTURE_IDS
REFERENCE_IDS = (
    "player",
    "boss_colossus",
    "boss_hound",
    "boss_seraph",
    "boss_serpent",
    "boss_knight",
    "boss_swarm",
)


def load_pixels(filepath):
    image = bpy.data.images.load(filepath, check_existing=False)
    image.colorspace_settings.name = "Non-Color"
    width, height = image.size
    pixels = np.empty(width * height * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    return image, pixels.reshape((height, width, 4))[:, :, :3].copy()


def write_jpeg(filepath, pixels, quality=85):
    height, width = pixels.shape[:2]
    image = bpy.data.images.new(
        os.path.basename(filepath),
        width=width,
        height=height,
        alpha=False,
        float_buffer=False,
    )
    image.colorspace_settings.name = "Non-Color"
    rgba = np.ones((height, width, 4), dtype=np.float32)
    rgba[:, :, :3] = np.clip(pixels, 0, 1)
    image.pixels.foreach_set(rgba.ravel())
    image.filepath_raw = filepath
    image.file_format = "JPEG"
    bpy.context.scene.render.image_settings.quality = quality
    image.save()
    bpy.data.images.remove(image)


def resize(pixels, width, height):
    source = bpy.data.images.new("Resize source", width=pixels.shape[1], height=pixels.shape[0], alpha=False)
    source.colorspace_settings.name = "Non-Color"
    rgba = np.ones((*pixels.shape[:2], 4), dtype=np.float32)
    rgba[:, :, :3] = pixels
    source.pixels.foreach_set(rgba.ravel())
    source.scale(width, height)
    result = np.empty(width * height * 4, dtype=np.float32)
    source.pixels.foreach_get(result)
    bpy.data.images.remove(source)
    return result.reshape((height, width, 4))[:, :, :3].copy()


def blend_offset_seam(pixels, axis, band=64):
    values = np.moveaxis(pixels, axis, 0)
    midpoint = values.shape[0] // 2
    radius = min(band, midpoint // 2)
    if radius < 2:
        return
    left = values[midpoint - radius:midpoint].copy()
    right = values[midpoint:midpoint + radius][::-1].copy()
    average = (left + right) * 0.5
    ramp = np.linspace(0, 1, radius, dtype=np.float32).reshape(
        (radius,) + (1,) * (values.ndim - 1)
    )
    values[midpoint - radius:midpoint] = left * (1 - ramp) + average * ramp
    values[midpoint:midpoint + radius] = (
        right * (1 - ramp) + average * ramp
    )[::-1]


def make_tileable(pixels):
    offset = np.roll(pixels, (pixels.shape[0] // 2, pixels.shape[1] // 2), axis=(0, 1))
    blend_offset_seam(offset, 1)
    blend_offset_seam(offset, 0)
    return np.roll(offset, (-offset.shape[0] // 2, -offset.shape[1] // 2), axis=(0, 1))


def tangent_normal(pixels, strength=4.0):
    luminance = pixels @ np.array((0.2126, 0.7152, 0.0722), dtype=np.float32)
    sample = lambda dy, dx: np.roll(np.roll(luminance, dy, axis=0), dx, axis=1)
    luminance = (
        sample(0, 0) * 4
        + 2 * (sample(-1, 0) + sample(1, 0) + sample(0, -1) + sample(0, 1))
        + sample(-1, -1) + sample(-1, 1) + sample(1, -1) + sample(1, 1)
    ) / 16
    sample = lambda dy, dx: np.roll(np.roll(luminance, dy, axis=0), dx, axis=1)
    dx = (
        sample(-1, 1) + 2 * sample(0, 1) + sample(1, 1)
        - sample(-1, -1) - 2 * sample(0, -1) - sample(1, -1)
    ) / 8
    dy = (
        sample(1, -1) + 2 * sample(1, 0) + sample(1, 1)
        - sample(-1, -1) - 2 * sample(-1, 0) - sample(-1, 1)
    ) / 8
    normal = np.stack((-dx * strength, -dy * strength, np.ones_like(dx)), axis=-1)
    normal /= np.maximum(np.linalg.norm(normal, axis=-1, keepdims=True), 1e-6)
    return normal * 0.5 + 0.5


def find_raw(raw_dir, item_id):
    matches = sorted(
        name for name in os.listdir(raw_dir)
        if os.path.splitext(name)[0] == item_id
    )
    if len(matches) != 1:
        raise RuntimeError(f"Expected one raw image for {item_id}; found {matches}")
    return os.path.join(raw_dir, matches[0])


def process_texture(raw_dir, output_dir, item_id):
    _, pixels = load_pixels(find_raw(raw_dir, item_id))
    pixels = resize(pixels, 1024, 1024)
    if item_id in TEXTURE_IDS:
        pixels = make_tileable(pixels)
    else:
        luminance = pixels @ np.array((0.2126, 0.7152, 0.0722), dtype=np.float32)
        if float(luminance.mean()) > 0.5:
            luminance = 1 - luminance
        pixels = np.repeat(luminance[:, :, None], 3, axis=2)
    output = os.path.join(output_dir, f"{item_id}.jpg")
    write_jpeg(output, pixels)
    print(f"ART {output}: 1024x1024")
    if item_id in NORMAL_IDS:
        normal = tangent_normal(pixels)
        normal_output = os.path.join(output_dir, f"{item_id}_n.jpg")
        write_jpeg(normal_output, normal, quality=75)
        print(f"ART {normal_output}: 1024x1024 tangent-space Sobel")


def seamless_horizontal(pixels, band=96):
    band = min(band, pixels.shape[1] // 4)
    fade = np.linspace(0, 1, band, dtype=np.float32)[None, :, None]
    seam = (pixels[:, :1, :] + pixels[:, -1:, :]) * 0.5
    result = pixels.copy()
    result[:, :band, :] = seam * (1 - fade) + pixels[:, :band, :] * fade
    reverse_fade = fade[:, ::-1, :]
    result[:, -band:, :] = seam * (1 - reverse_fade) + pixels[:, -band:, :] * reverse_fade
    return result


def process_wide(raw_dir, output_dir, item_id, width):
    _, pixels = load_pixels(find_raw(raw_dir, item_id))
    if item_id == "sky":
        height, source_width = pixels.shape[:2]
        x_margin = max(1, round(source_width * 0.018))
        y_margin = max(1, round(height * 0.035))
        pixels = pixels[y_margin:-y_margin, x_margin:-x_margin]
    height = max(1, round(pixels.shape[0] * width / pixels.shape[1]))
    pixels = resize(pixels, width, height)
    if item_id == "sky":
        pixels = seamless_horizontal(pixels)
    output = os.path.join(output_dir, f"{item_id}.jpg")
    write_jpeg(output, pixels)
    print(f"ART {output}: {width}x{height}")


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    art_dir = os.path.join(here, "art")
    raw_dir = os.path.join(art_dir, "raw")
    textures_dir = os.path.join(art_dir, "textures")
    refs_dir = os.path.join(art_dir, "refs")
    if not os.path.isdir(raw_dir):
        raise RuntimeError("Raw art is missing; run scripts/gen-art.mjs first.")
    os.makedirs(textures_dir, exist_ok=True)
    os.makedirs(refs_dir, exist_ok=True)
    for item_id in (*TEXTURE_IDS, "sigil"):
        process_texture(raw_dir, textures_dir, item_id)
    process_wide(raw_dir, textures_dir, "sky", 2048)
    for item_id in REFERENCE_IDS:
        process_wide(raw_dir, refs_dir, item_id, 1280)


if __name__ == "__main__":
    main()
