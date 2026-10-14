"""Draws Readout's app icons: three lines of text, the middle one highlighted.

Run from the repo root:  python tools/make_icons.py   (needs Pillow)
A GitHub Action runs this automatically when the file changes.
"""
from pathlib import Path
from PIL import Image, ImageDraw

INK = (23, 32, 54, 255)
PAPER = (246, 247, 249, 255)
MARKER = (255, 228, 90, 255)
S = 4  # supersampling for smooth edges
OUT = Path(__file__).resolve().parent.parent / "icons"


def glyph(d, size, scale, cx, cy):
    u = size / 512 * scale

    def X(v):
        return cx + (v - 256) * u

    def Y(v):
        return cy + (v - 256) * u

    h = 30 * u

    def bar(x0, x1, yc, color):
        d.rounded_rectangle([X(x0), Y(yc) - h / 2, X(x1), Y(yc) + h / 2], radius=h / 2, fill=color)

    bar(118, 394, 168, PAPER)
    d.polygon([(X(96), Y(222)), (X(416), Y(217)), (X(421), Y(293)), (X(100), Y(297))], fill=MARKER)
    bar(128, 372, 257, INK)
    bar(118, 300, 346, PAPER)


def make(size, name, maskable=False, rounded=True):
    big = size * S
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable or not rounded:
        d.rectangle([0, 0, big, big], fill=INK)
        glyph(d, big, 0.74 if maskable else 0.86, big / 2, big / 2)
    else:
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=big * 0.22, fill=INK)
        glyph(d, big, 0.92, big / 2, big / 2)
    img = img.resize((size, size), Image.LANCZOS)
    OUT.mkdir(exist_ok=True)
    img.save(OUT / name, optimize=True)
    print("wrote", OUT / name)


if __name__ == "__main__":
    make(192, "icon-192.png")
    make(512, "icon-512.png")
    make(512, "icon-maskable-512.png", maskable=True)
    make(180, "apple-touch-icon.png", rounded=False)
