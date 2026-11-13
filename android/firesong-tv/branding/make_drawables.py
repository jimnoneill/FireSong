#!/usr/bin/env python3
"""Generate FireSong's launcher icon, banner and overlay mark as Android
vector drawables (plus SVG previews) from one description.

The mark (a microphone whose head is a flame, with sound arcs) is original
artwork drawn here as path data. The wordmark outlines come from Noto Sans
Bold Italic and Noto Sans CJK KR Bold, both under the SIL Open Font License
1.1, which allows using rendered outlines in logos.

Usage (from android/firesong-tv/):
    python3 branding/make_drawables.py            # writes app/src/main/res/...
    python3 branding/make_drawables.py --svg DIR  # also writes SVG previews

Needs fontTools. Font paths can be overridden with FIRESONG_LATIN_FONT and
FIRESONG_KR_FONT.
"""
from __future__ import annotations

import argparse
import os
import pathlib

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTCollection, TTFont

HERE = pathlib.Path(__file__).resolve().parent
RES = HERE.parent / "app" / "src" / "main" / "res"

LATIN_FONT = os.environ.get("FIRESONG_LATIN_FONT", "/usr/share/fonts/truetype/noto/NotoSans-BoldItalic.ttf")
KR_FONT = os.environ.get("FIRESONG_KR_FONT", "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc")

# Palette (matches res/values/colors.xml)
NIGHT = "#120A24"
NIGHT_DEEP = "#07040F"
PLUM = "#2A1450"
PLUM_LIGHT = "#4B2A86"
EMBER = "#FF6A2B"
GOLD = "#FFC247"
ROSE = "#FF3D7F"
CREAM = "#FFF4E8"
LAVENDER = "#E6DAFF"

# ---------------------------------------------------------------------------
# Scene description: a list of shapes in a local coordinate space.
# shape = dict(d=path, fill=color|gradient, stroke=color, width=float, alpha=float)
# gradient = ("linear", x1, y1, x2, y2, [(offset, color), ...])
#          | ("radial", cx, cy, r, [(offset, color), ...])
# ---------------------------------------------------------------------------

FLAME_GRAD = ("linear", 50, 6, 50, 66, [(0.0, GOLD), (0.45, EMBER), (1.0, ROSE)])


def mark_shapes() -> list[dict]:
    """The FireSong mark in a 100x100 box."""
    return [
        # sound arcs
        dict(d="M19,34 Q12,45 19,56", stroke=EMBER, width=3.6, alpha=0.9),
        dict(d="M11,28 Q1,45 11,62", stroke=ROSE, width=3.6, alpha=0.75),
        dict(d="M81,34 Q88,45 81,56", stroke=EMBER, width=3.6, alpha=0.9),
        dict(d="M89,28 Q99,45 89,62", stroke=ROSE, width=3.6, alpha=0.75),
        # flame-shaped microphone head
        dict(
            d=(
                "M50,6 C56,15 66,22 71,32 C75,40 75,52 69,58 C64,63 57,66 50,66 "
                "C43,66 36,63 31,58 C25,52 25,41 30,33 C32,37 35,40 39,41 "
                "C36,30 41,17 50,6 Z"
            ),
            fill=FLAME_GRAD,
        ),
        # inner glow
        dict(
            d="M50,30 C56,37 61,43 61,50 C61,56 56,60 50,60 C44,60 39,56 39,50 C39,43 44,37 50,30 Z",
            fill=CREAM,
            alpha=0.85,
        ),
        # grille
        dict(d="M43,48 L57,48", stroke=PLUM, width=2.4, alpha=0.55),
        dict(d="M42,53 L58,53", stroke=PLUM, width=2.4, alpha=0.55),
        # collar
        dict(d="M40,66 L60,66 L58,72 L42,72 Z", fill=PLUM_LIGHT),
        # handle
        dict(d="M42.5,72 L57.5,72 L54.5,93 Q50,97 45.5,93 Z", fill=LAVENDER),
    ]


def text_path(text: str, font_path: str, size: float, x: float, baseline: float, font_number: int | None = None,
              tracking: float = 0.0, skew: float = 0.0) -> tuple[str, float]:
    """Outline [text] as one SVG path (y down). Returns (path, advance width)."""
    if font_path.endswith(".ttc"):
        coll = TTCollection(font_path)
        font = coll.fonts[font_number or 0]
    else:
        font = TTFont(font_path)
    upm = font["head"].unitsPerEm
    cmap = font.getBestCmap()
    glyphs = font.getGlyphSet()
    hmtx = font["hmtx"]
    scale = size / upm
    pen = SVGPathPen(glyphs, ntos=lambda v: ("%.1f" % v).rstrip("0").rstrip("."))
    cursor = x
    for ch in text:
        name = cmap.get(ord(ch))
        if name is None:
            raise SystemExit(f"glyph for {ch!r} missing in {font_path}")
        # font units (y up) -> scene (y down), with optional extra slant
        t = TransformPen(pen, (scale, 0, -skew * scale, -scale, cursor, baseline))
        glyphs[name].draw(t)
        cursor += hmtx[name][0] * scale + tracking
    return pen.getCommands(), cursor - x


def kr_font_index(path: str) -> int:
    coll = TTCollection(path)
    for i, f in enumerate(coll.fonts):
        names = {r.toUnicode() for r in f["name"].names if r.nameID == 1}
        if any(n.endswith(" KR") for n in names):
            return i
    return 0


# ---------------------------------------------------------------------------
# Writers
# ---------------------------------------------------------------------------

def _hex_argb(color: str, alpha: float = 1.0) -> str:
    a = round(alpha * 255)
    return "#%02X%s" % (a, color.lstrip("#").upper())


def vd_gradient(g) -> str:
    stops = "".join(f'\n                <item android:color="{_hex_argb(c)}" android:offset="{o}" />' for o, c in g[-1])
    if g[0] == "linear":
        _, x1, y1, x2, y2, _ = g
        head = (f'<gradient android:type="linear" android:startX="{x1}" android:startY="{y1}" '
                f'android:endX="{x2}" android:endY="{y2}">')
    else:
        _, cx, cy, r, _ = g
        head = f'<gradient android:type="radial" android:centerX="{cx}" android:centerY="{cy}" android:gradientRadius="{r}">'
    return f"""
        <aapt:attr name="android:fillColor">
            {head}{stops}
            </gradient>
        </aapt:attr>"""


def vd_path(s: dict) -> str:
    attrs = [f'android:pathData="{s["d"]}"']
    body = ""
    fill = s.get("fill")
    if isinstance(fill, tuple):
        body = vd_gradient(fill)
    elif fill:
        attrs.append(f'android:fillColor="{_hex_argb(fill)}"')
    if s.get("alpha") is not None and fill:
        attrs.append(f'android:fillAlpha="{s["alpha"]}"')
    if s.get("stroke"):
        attrs += [
            f'android:strokeColor="{_hex_argb(s["stroke"])}"',
            f'android:strokeWidth="{s["width"]}"',
            'android:strokeLineCap="round"',
            'android:strokeLineJoin="round"',
        ]
        if s.get("alpha") is not None:
            attrs.append(f'android:strokeAlpha="{s["alpha"]}"')
    joined = "\n        ".join(attrs)
    if body:
        return f"    <path\n        {joined}>{body}\n    </path>"
    return f"    <path\n        {joined} />"


def vd_group(shapes: list[dict], tx=0.0, ty=0.0, sc=1.0) -> str:
    inner = "\n".join("  " + line for p in shapes for line in vd_path(p).splitlines())
    return (f'    <group android:translateX="{tx}" android:translateY="{ty}" '
            f'android:scaleX="{sc}" android:scaleY="{sc}">\n{inner}\n    </group>')


def vector(width_dp: float, height_dp: float, vw: float, vh: float, groups: list[str], ignore: str = "") -> str:
    tools = (f'    xmlns:tools="http://schemas.android.com/tools"\n    tools:ignore="{ignore}"\n') if ignore else ""
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<!-- Generated by android/firesong-tv/branding/make_drawables.py; edit the script, not this file. -->\n"
        '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
        '    xmlns:aapt="http://schemas.android.com/aapt"\n'
        + tools +
        f'    android:width="{width_dp}dp"\n    android:height="{height_dp}dp"\n'
        f'    android:viewportWidth="{vw}"\n    android:viewportHeight="{vh}">\n'
        + "\n".join(groups)
        + "\n</vector>\n"
    )


def svg_shape(s: dict, gid: list[int], defs: list[str]) -> str:
    fill = s.get("fill")
    attrs = []
    if isinstance(fill, tuple):
        gid[0] += 1
        name = f"g{gid[0]}"
        stops = "".join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in fill[-1])
        if fill[0] == "linear":
            _, x1, y1, x2, y2, _ = fill
            defs.append(f'<linearGradient id="{name}" gradientUnits="userSpaceOnUse" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}">{stops}</linearGradient>')
        else:
            _, cx, cy, r, _ = fill
            defs.append(f'<radialGradient id="{name}" gradientUnits="userSpaceOnUse" cx="{cx}" cy="{cy}" r="{r}">{stops}</radialGradient>')
        attrs.append(f'fill="url(#{name})"')
    elif fill:
        attrs.append(f'fill="{fill}"')
    else:
        attrs.append('fill="none"')
    if s.get("stroke"):
        attrs.append(f'stroke="{s["stroke"]}" stroke-width="{s["width"]}" stroke-linecap="round" stroke-linejoin="round"')
    if s.get("alpha") is not None:
        attrs.append(f'opacity="{s["alpha"]}"')
    return f'<path d="{s["d"]}" {" ".join(attrs)}/>'


def svg(vw: float, vh: float, groups: list[tuple[list[dict], float, float, float]], px_w: int, px_h: int) -> str:
    defs: list[str] = []
    gid = [0]
    body = []
    for shapes, tx, ty, sc in groups:
        inner = "".join(svg_shape(s, gid, defs) for s in shapes)
        body.append(f'<g transform="translate({tx},{ty}) scale({sc})">{inner}</g>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{px_w}" height="{px_h}" viewBox="0 0 {vw} {vh}">'
            f'<defs>{"".join(defs)}</defs>{"".join(body)}</svg>\n')


# ---------------------------------------------------------------------------

def build() -> dict[str, tuple]:
    mark = mark_shapes()

    # Launcher icon background (108x108 adaptive canvas)
    icon_bg = [
        dict(d="M0,0 H108 V108 H0 Z", fill=("radial", 54, 46, 70, [(0.0, PLUM_LIGHT), (0.55, PLUM), (1.0, NIGHT)])),
    ]

    # Banner 320x180: ground, glow behind the mark, mark, wordmark, tagline
    banner_bg = [
        dict(d="M0,0 H320 V180 H0 Z", fill=("linear", 0, 0, 320, 180, [(0.0, PLUM), (0.6, NIGHT), (1.0, NIGHT_DEEP)])),
        dict(d="M78,90 m-70,0 a70,70 0 1,0 140,0 a70,70 0 1,0 -140,0", fill=("radial", 78, 90, 70, [(0.0, "#6A2E7A"), (1.0, PLUM)]), alpha=0.55),
    ]
    word_d, word_w = text_path("FireSong", LATIN_FONT, 50, 0, 0)
    kr_idx = kr_font_index(KR_FONT)
    tag_d, tag_w = text_path("노래방  KARAOKE", KR_FONT, 15, 0, 0, font_number=kr_idx, tracking=1.2)
    text_x = 150.0
    word_shapes = [dict(d=word_d, fill=("linear", 0, -40, 0, 4, [(0.0, GOLD), (1.0, EMBER)]))]
    tag_shapes = [dict(d=tag_d, fill=LAVENDER, alpha=0.9)]
    # Scale the wordmark to fit the space right of the mark.
    word_scale = min(1.0, (320 - text_x - 14) / word_w)
    tag_scale = min(1.0, (320 - text_x - 14) / tag_w)

    return {
        "mark": (100, 100, [(mark, 0, 0, 1.0)], 160, 160),
        "icon_fg": (108, 108, [(mark, 21, 20, 0.66)], 108, 108),
        "icon_bg": (108, 108, [(icon_bg, 0, 0, 1.0)], 108, 108),
        "banner": (
            320,
            180,
            [
                (banner_bg, 0, 0, 1.0),
                (mark, 18, 30, 1.2),
                (word_shapes, text_x, 98, word_scale),
                (tag_shapes, text_x + 2, 128, tag_scale),
            ],
            160,
            90,
        ),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--svg", help="also write SVG previews into this directory")
    args = ap.parse_args()
    scenes = build()
    outputs = {
        "mark": RES / "drawable" / "ic_firesong_mark.xml",
        "icon_fg": RES / "drawable" / "ic_launcher_foreground.xml",
        "icon_bg": RES / "drawable" / "ic_launcher_background.xml",
        "banner": RES / "drawable" / "banner.xml",
    }
    for key, (vw, vh, groups, w_dp, h_dp) in scenes.items():
        # The wordmark outlines are long paths; the banner is drawn once by the launcher.
        ignore = "VectorPath" if key == "banner" else ""
        xml = vector(w_dp, h_dp, vw, vh, [vd_group(s, tx, ty, sc) for s, tx, ty, sc in groups], ignore)
        outputs[key].parent.mkdir(parents=True, exist_ok=True)
        outputs[key].write_text(xml, encoding="utf-8")
        print("wrote", outputs[key].relative_to(HERE.parent))
        if args.svg:
            out = pathlib.Path(args.svg)
            out.mkdir(parents=True, exist_ok=True)
            scale = 4
            (out / f"{key}.svg").write_text(svg(vw, vh, groups, int(vw * scale), int(vh * scale)), encoding="utf-8")
    adaptive = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@drawable/ic_launcher_background" />\n'
        '    <foreground android:drawable="@drawable/ic_launcher_foreground" />\n'
        '    <monochrome android:drawable="@drawable/ic_launcher_foreground" />\n'
        "</adaptive-icon>\n"
    )
    for name in ("ic_launcher", "ic_launcher_round"):
        p = RES / "mipmap-anydpi-v26" / f"{name}.xml"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(adaptive, encoding="utf-8")
        print("wrote", p.relative_to(HERE.parent))


if __name__ == "__main__":
    main()
