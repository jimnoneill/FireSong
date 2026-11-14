#!/usr/bin/env python3
"""Build FireSong's derived brand images from the source art in branding/source/.

Outputs:
  branding/icon-1024.png            mascot on transparency (store listings, README)
  branding/readme-banner.webp       social art as a rounded card (README hero, both themes)
  branding/social-preview-1280x640.jpg  GitHub social preview (Settings -> Social preview)
  branding/banner-1280x720.png      opaque TV banner master (store / promo)
  branding/tile-320x180.png         opaque TV banner at launcher size
  android/firesong-tv/app/src/main/res/
    drawable-<dpi>/banner.png       Fire TV launcher banner, 160x90 dp (320x180 px at xhdpi, the Cube's UI density)
    mipmap-<dpi>/ic_launcher_foreground.png   adaptive-icon foreground (108 dp)
    mipmap-<dpi>/ic_launcher_monochrome.png   single-colour silhouette (API 33+ themed icons)
    drawable-<dpi>/ic_firesong_mark.png       mascot on the loading/error overlay (160 dp)
    drawable-nodpi/tv_connecting.webp         full-screen art while the TV first connects
    drawable-nodpi/stage_backdrop.webp        full-screen art behind the reconnecting/error overlay

The source PNGs come out of a background remover: the body is about 99%
opaque (alpha 252-253) and there are faint specks. clean_alpha() makes the
body fully opaque and drops near-invisible specks before anything is scaled.

Usage (repo root):  /usr/bin/python3 branding/make_assets.py
Needs Pillow.
"""
from __future__ import annotations

import pathlib

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "branding" / "source"
OUT = ROOT / "branding"
RES = ROOT / "android" / "firesong-tv" / "app" / "src" / "main" / "res"

# Palette shared with android/firesong-tv/app/src/main/res/values/colors.xml.
PLUM = (0x2A, 0x14, 0x50)
NIGHT = (0x12, 0x0A, 0x24)
NIGHT_DEEP = (0x07, 0x04, 0x0F)

# Adaptive icon: 108 dp canvas, the launcher shows the inner 72 dp and masks
# to its own shape; keep the art inside the 66 dp safe circle.
DENSITIES = {"mdpi": 1.0, "hdpi": 1.5, "xhdpi": 2.0, "xxhdpi": 3.0, "xxxhdpi": 4.0}


def clean_alpha(image: Image.Image, opaque_from: int = 245, drop_below: int = 6) -> Image.Image:
    image = image.convert("RGBA")
    alpha = image.getchannel("A").point(
        lambda a: 0 if a < drop_below else (255 if a >= opaque_from else a)
    )
    image.putalpha(alpha)
    return image


def trim(image: Image.Image) -> Image.Image:
    box = image.getchannel("A").point(lambda a: 255 if a > 24 else 0).getbbox()
    return image.crop(box) if box else image


def fit(image: Image.Image, width: int, height: int) -> Image.Image:
    scale = min(width / image.width, height / image.height)
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    return image.resize(size, Image.LANCZOS)


def night_gradient(width: int, height: int, glow_at: tuple[float, float] = (0.35, 0.45)) -> Image.Image:
    """Opaque plum-to-night radial gradient, the same ground as the TV app."""
    small_w, small_h = 160, max(1, round(160 * height / width))
    ground = Image.new("RGB", (small_w, small_h))
    cx, cy = glow_at[0] * small_w, glow_at[1] * small_h
    reach = (small_w**2 + small_h**2) ** 0.5 * 0.62
    pixels = ground.load()
    for y in range(small_h):
        for x in range(small_w):
            t = min(1.0, ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5 / reach)
            if t < 0.55:
                k = t / 0.55
                colour = tuple(round(PLUM[i] + (NIGHT[i] - PLUM[i]) * k) for i in range(3))
            else:
                k = (t - 0.55) / 0.45
                colour = tuple(round(NIGHT[i] + (NIGHT_DEEP[i] - NIGHT[i]) * k) for i in range(3))
            pixels[x, y] = colour
    return ground.resize((width, height), Image.BICUBIC).filter(ImageFilter.GaussianBlur(2))


def card(ground: Image.Image, art: Image.Image, art_box: tuple[int, int], radius: int = 0) -> Image.Image:
    canvas = ground.convert("RGBA")
    placed = fit(art, *art_box)
    canvas.alpha_composite(
        placed, ((canvas.width - placed.width) // 2, (canvas.height - placed.height) // 2)
    )
    if radius:
        mask = Image.new("L", canvas.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, canvas.width - 1, canvas.height - 1), radius, fill=255)
        canvas.putalpha(ImageChops.multiply(canvas.getchannel("A"), mask))
    return canvas


def cover(image: Image.Image, width: int, height: int) -> Image.Image:
    """Opaque, scaled to fill width x height, centre-cropped."""
    image = image.convert("RGB")
    scale = max(width / image.width, height / image.height)
    size = (max(width, round(image.width * scale)), max(height, round(image.height * scale)))
    image = image.resize(size, Image.LANCZOS)
    left, top = (image.width - width) // 2, (image.height - height) // 2
    return image.crop((left, top, left + width, top + height))


def rounded(image: Image.Image, radius: int) -> Image.Image:
    canvas = image.convert("RGBA")
    mask = Image.new("L", canvas.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, canvas.width - 1, canvas.height - 1), radius, fill=255)
    canvas.putalpha(mask)
    return canvas


def save_webp(image: Image.Image, path: pathlib.Path, quality: int = 80) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, "WEBP", quality=quality, method=6)
    print(f"{path.relative_to(ROOT)}  {image.width}x{image.height}  {path.stat().st_size // 1024} KB")


def save_jpeg(image: Image.Image, path: pathlib.Path, quality: int = 88) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(path, "JPEG", quality=quality, optimize=True, progressive=True)
    print(f"{path.relative_to(ROOT)}  {image.width}x{image.height}  {path.stat().st_size // 1024} KB")


def save(image: Image.Image, path: pathlib.Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, optimize=True)
    print(f"{path.relative_to(ROOT)}  {image.width}x{image.height}  {path.stat().st_size // 1024} KB")


def main() -> None:
    mascot = trim(clean_alpha(Image.open(SRC / "mascot.png")))

    # Square mascot icon, transparent, a little breathing room.
    side = round(max(mascot.size) / 0.9)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.alpha_composite(mascot, ((side - mascot.width) // 2, (side - mascot.height) // 2))
    save(square.resize((1024, 1024), Image.LANCZOS), OUT / "icon-1024.png")

    # README hero: the 2:1 social art as a rounded card (reads the same on GitHub's
    # light and dark themes); the same art at GitHub's social-preview size.
    social = cover(Image.open(SRC / "social-preview.png"), 1600, 800)
    save_webp(rounded(social, 36), OUT / "readme-banner.webp", quality=86)
    save_jpeg(cover(Image.open(SRC / "social-preview.png"), 1280, 640), OUT / "social-preview-1280x640.jpg")

    # TV banners: the owner's 16:9 banner art.
    master = cover(Image.open(SRC / "tv-banner.png"), 1280, 720)
    save(master.convert("RGB"), OUT / "banner-1280x720.png")
    save(master.convert("RGB").resize((320, 180), Image.LANCZOS), OUT / "tile-320x180.png")
    for name in ("mdpi", "hdpi", "xhdpi", "xxhdpi"):
        width, height = round(160 * DENSITIES[name]), round(90 * DENSITIES[name])
        save(master.convert("RGB").resize((width, height), Image.LANCZOS), RES / f"drawable-{name}" / "banner.png")

    # Full-screen overlay art at the Cube's 1920x1080 UI size; nodpi, so never rescaled on load.
    for name, source in (("tv_connecting", "tv-connecting.png"), ("stage_backdrop", "stage-backdrop.png")):
        save_webp(cover(Image.open(SRC / source), 1920, 1080), RES / "drawable-nodpi" / f"{name}.webp")

    # Loading/error overlay mark, shown at 160 dp.
    for name in ("mdpi", "hdpi", "xhdpi", "xxhdpi"):
        px = round(160 * DENSITIES[name])
        canvas = Image.new("RGBA", (px, px), (0, 0, 0, 0))
        placed = fit(mascot, px, px)
        canvas.alpha_composite(placed, ((px - placed.width) // 2, (px - placed.height) // 2))
        save(canvas, RES / f"drawable-{name}" / "ic_firesong_mark.png")

    # Adaptive icon layers. The art box is 64 dp of the 108 dp canvas (safe circle is 66 dp).
    silhouette = Image.new("RGBA", mascot.size, (255, 255, 255, 0))
    silhouette.putalpha(mascot.getchannel("A"))
    for name, scale in DENSITIES.items():
        canvas_px = round(108 * scale)
        art_px = round(64 * scale)
        for layer, art in (("foreground", mascot), ("monochrome", silhouette)):
            canvas = Image.new("RGBA", (canvas_px, canvas_px), (0, 0, 0, 0))
            placed = fit(art, art_px, art_px)
            canvas.alpha_composite(
                placed, ((canvas_px - placed.width) // 2, (canvas_px - placed.height) // 2)
            )
            save(canvas, RES / f"mipmap-{name}" / f"ic_launcher_{layer}.png")


if __name__ == "__main__":
    main()
