#!/usr/bin/env python3
"""An original, editable Wabi profile banner example.

Run with Python 3 and Pillow: python3 aurora-loop.py
Install the one dependency with: python3 -m pip install Pillow

Edit COLORS, RIBBONS, or wave() below to make your own design. This file draws
original geometric shapes; it contains no account data, imported images, or
external requests. Output goes beside this source file unless --output is set.

Canvas: 1200 × 400 pixels (3:1). Duration: four seconds, 64 frames (16 fps).
The lower-left area stays quiet for Wabi's overlapping avatar. Animation loops
through periodic sine waves, so time=0 and time=4 have identical geometry.
WebP has 62/63 ms frame delays; GIF uses 60/70 ms because of its coarser clock.
Both formats add up to exactly four seconds. The PNG is a useful still fallback.

Artwork and source: CC0 1.0, dedicated to the public domain.
https://creativecommons.org/publicdomain/zero/1.0/
"""

from __future__ import annotations

import argparse
import math
import random
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

WIDTH, HEIGHT = 1200, 400
FRAME_COUNT, SECONDS = 64, 4
COLORS = {
    "background_top": (8, 15, 34),
    "background_bottom": (18, 19, 49),
    "cyan": (71, 219, 233),
    "blue": (82, 130, 239),
    "violet": (173, 103, 235),
    "silver": (153, 228, 246),
}
# Color, vertical offset, phase offset, ribbon thickness, opacity.
RIBBONS = [
    ("violet", 46, 0.56, 36, 122),
    ("blue", 17, 0.31, 28, 148),
    ("cyan", -9, 0.00, 23, 172),
    ("silver", -32, 0.08, 10, 91),
]


def mix(a: tuple[int, ...], b: tuple[int, ...], amount: float) -> tuple[int, ...]:
    return tuple(round(x + (y - x) * amount) for x, y in zip(a, b))


def wave(x: float, time: float, phase: float = 0.0) -> float:
    """A periodic ribbon centerline; change amplitudes for a different shape."""
    u = x / WIDTH
    loop = time / SECONDS
    return (
        159
        + 50 * math.sin(math.tau * (u * 0.84 - loop + phase))
        + 17 * math.sin(math.tau * (u * 1.7 + loop - phase))
        - 35 * u
    )


def background() -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT))
    draw = ImageDraw.Draw(image)
    for y in range(HEIGHT):
        color = mix(COLORS["background_top"], COLORS["background_bottom"], y / HEIGHT)
        draw.line((0, y, WIDTH, y), fill=color)

    atmosphere = Image.new("RGBA", image.size)
    haze = ImageDraw.Draw(atmosphere)
    haze.ellipse((470, -110, 1280, 360), fill=(75, 61, 168, 38))
    haze.ellipse((420, -170, 1100, 220), fill=(32, 142, 172, 28))
    image = Image.alpha_composite(image.convert("RGBA"), atmosphere.filter(ImageFilter.GaussianBlur(65)))

    # A fixed seed makes rerenders reproducible and avoids twinkling/flashes.
    stars = ImageDraw.Draw(image)
    random_source = random.Random(1984)
    for _ in range(70):
        x, y = random_source.uniform(20, WIDTH - 20), random_source.uniform(18, HEIGHT - 18)
        radius = random_source.choice((0.45, 0.6, 0.8))
        stars.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(142, 170, 201, 58))
    return image


def ribbon(time: float, color_name: str, offset: float, phase: float, width: float, opacity: int) -> Image.Image:
    # Draw at twice the size, then downsample for smooth thin contours.
    scale = 2
    layer = Image.new("RGBA", (WIDTH * scale, HEIGHT * scale))
    draw = ImageDraw.Draw(layer)
    rgb = COLORS[color_name]
    scaled = lambda points: [(x * scale, y * scale) for x, y in points]
    xs = range(180, WIDTH + 9, 4)
    centers = [(x, wave(x, time, phase) + offset) for x in xs]
    upper, lower = [], []
    for x, y in centers:
        u = x / WIDTH
        half_width = width * (0.38 + 0.18 * math.sin(math.tau * (u - time / SECONDS + phase)))
        upper.append((x, y - half_width))
        lower.append((x, y + half_width))
    polygon = upper + list(reversed(lower))
    draw.polygon(scaled(polygon), fill=(*rgb, round(opacity * 0.24)))

    # A luminous edge and several translucent contours create depth without
    # large changes in brightness. Change these lines to flatten the style.
    draw.line(scaled(upper), fill=(*rgb, opacity), width=2 * scale)
    for contour in (0.32, 0.57, 0.78):
        points = [
            (x, top_y + (bottom_y - top_y) * contour)
            for (x, top_y), (_, bottom_y) in zip(upper, lower)
        ]
        draw.line(scaled(points), fill=(*rgb, round(opacity * (0.48 - contour * 0.23))), width=scale)
    draw.line(scaled(lower), fill=(*rgb, round(opacity * 0.5)), width=scale)

    glow = layer.filter(ImageFilter.GaussianBlur(13 * scale))
    layer = Image.alpha_composite(glow, layer).resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)

    # Fade in from the left so all frames leave room for the overlapping avatar.
    fade = Image.new("L", (WIDTH, HEIGHT))
    fade_draw = ImageDraw.Draw(fade)
    for x in range(WIDTH):
        amount = max(0.0, min(1.0, (x - 220) / 280))
        smooth = amount * amount * (3 - 2 * amount)
        fade_draw.line((x, 0, x, HEIGHT), fill=round(255 * smooth))
    layer.putalpha(ImageChops.multiply(layer.getchannel("A"), fade))
    return layer


def frame(time: float, backdrop: Image.Image | None = None) -> Image.Image:
    image = (backdrop or background()).copy()
    for color, offset, phase, width, opacity in RIBBONS:
        image = Image.alpha_composite(image, ribbon(time, color, offset, phase, width, opacity))
    return image.convert("RGB")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    backdrop = background()
    frames = [frame(SECONDS * i / FRAME_COUNT, backdrop) for i in range(FRAME_COUNT)]
    frames[0].save(args.output / "aurora-loop-poster.png", optimize=True)
    frames[0].save(
        args.output / "aurora-loop.webp",
        save_all=True,
        append_images=frames[1:],
        duration=[62, 63] * (FRAME_COUNT // 2),
        loop=0,
        quality=90,
        method=6,
        minimize_size=True,
    )

    # Use one shared palette for every frame: this avoids palette flicker.
    palette = frames[0].quantize(colors=128, method=Image.Quantize.MEDIANCUT)
    gif_frames = [image.quantize(palette=palette, dither=Image.Dither.NONE) for image in frames]
    gif_frames[0].save(
        args.output / "aurora-loop.gif",
        save_all=True,
        append_images=gif_frames[1:],
        duration=[60, 60, 60, 70] * (FRAME_COUNT // 4),
        loop=0,
        disposal=1,
        optimize=True,
    )
    for name in ("aurora-loop.webp", "aurora-loop.gif", "aurora-loop-poster.png"):
        path = args.output / name
        print(f"{path.name}: {path.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
