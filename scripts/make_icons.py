"""Generate the app icons (gold coin with a lightning bolt) using numpy only.

    .venv/bin/python scripts/make_icons.py

Writes static/icons/{apple-touch-icon-180,icon-192,icon-512}.png. Icons are
full-bleed (iOS fills transparency with black) and keep the coin inside the
80% maskable safe zone.
"""
import struct
import zlib
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parent.parent / "static" / "icons"
SS = 4  # supersampling factor

BG = np.array([0x14, 0x17, 0x1f], float)
RIM = np.array([0xb8, 0x86, 0x0b], float)
FACE_HI = np.array([0xff, 0xd8, 0x4d], float)
FACE_LO = np.array([0xe0, 0xa8, 0x1a], float)
RING = np.array([0xc4, 0x8f, 0x12], float)
BOLT = np.array([0x14, 0x17, 0x1f], float)

# Lightning bolt in unit coordinates (centre 0,0; y down), roughly ±0.22 x ±0.32.
BOLT_PTS = np.array([(0.06, -0.33), (-0.17, 0.04), (-0.01, 0.04), (-0.07, 0.33),
                     (0.17, -0.05), (0.01, -0.05), (0.06, -0.33)]) * 0.82


def in_polygon(x, y, pts):
    """Even-odd point-in-polygon test, vectorised over grids x, y."""
    inside = np.zeros(x.shape, bool)
    for (x1, y1), (x2, y2) in zip(pts[:-1], pts[1:]):
        crosses = (y1 > y) != (y2 > y)
        xi = x1 + (y - y1) * (x2 - x1) / (y2 - y1 + 1e-12)
        inside ^= crosses & (x < xi)
    return inside


def render(size):
    n = size * SS
    c = (np.arange(n) + 0.5) / n - 0.5  # -0.5..0.5
    x, y = np.meshgrid(c, c)
    r = np.hypot(x, y)
    img = np.empty((n, n, 3))
    img[:] = BG
    coin_r = 0.38
    t = np.clip((x + y + 0.6) / 1.2, 0, 1)[..., None]  # diagonal shading
    face = FACE_HI * (1 - t) + FACE_LO * t
    img[r <= coin_r] = RIM
    img[r <= coin_r * 0.9] = face[r <= coin_r * 0.9]
    ring = (r <= coin_r * 0.8) & (r >= coin_r * 0.76)
    img[ring] = RING
    bolt = in_polygon(x / coin_r * 0.38, y / coin_r * 0.38, BOLT_PTS)
    img[bolt] = BOLT
    small = img.reshape(size, SS, size, SS, 3).mean(axis=(1, 3))
    return np.rint(small).astype(np.uint8)


def write_png(path, rgb):
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[i].tobytes() for i in range(h))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size in [("apple-touch-icon-180.png", 180), ("icon-192.png", 192),
                       ("icon-512.png", 512)]:
        write_png(OUT / name, render(size))
        print(OUT / name)
