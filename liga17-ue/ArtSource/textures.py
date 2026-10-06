"""Procedural, tileable PBR textures for the Pallet Town art kit.

Run with the Blender venv python (needs numpy, scipy, Pillow):
    python textures.py [out_dir]

Every material gets <name>_albedo.png (sRGB), <name>_normal.png (OpenGL / glTF convention)
and <name>_rough.png (linear, single channel). Everything tiles seamlessly.
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), 'Textures')
os.makedirs(OUT, exist_ok=True)
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'


def rng(seed):
    return np.random.default_rng(seed)


def noise(size, sigma, seed, aniso=(1.0, 1.0)):
    """Tileable smooth noise in [0, 1]."""
    n = rng(seed).standard_normal((size, size))
    n = ndimage.gaussian_filter(n, sigma=(sigma * aniso[0], sigma * aniso[1]), mode='wrap')
    n -= n.min()
    return n / (n.max() + 1e-9)


def fbm(size, seed, base=64.0, octaves=5, gain=0.5, aniso=(1.0, 1.0)):
    total = np.zeros((size, size))
    amp = 1.0
    norm = 0.0
    sigma = base
    for o in range(octaves):
        total += amp * noise(size, max(0.6, sigma), seed + o * 101, aniso)
        norm += amp
        amp *= gain
        sigma /= 2.0
    return total / norm


def hexcol(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)])


def colorize(t, stops):
    """Map scalar field t∈[0,1] through colour stops [(pos, '#rrggbb'), ...]."""
    t = np.clip(t, 0, 1)
    out = np.zeros(t.shape + (3,))
    pos = [p for p, _ in stops]
    cols = [hexcol(c) for _, c in stops]
    for ch in range(3):
        out[..., ch] = np.interp(t, pos, [c[ch] for c in cols])
    return out


def normal_from_height(h, strength):
    dx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * 0.5
    dy = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * 0.5
    nx = -dx * strength
    ny = dy * strength  # OpenGL convention (+Y up in tangent space, image rows go down)
    nz = np.ones_like(h)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    n = np.stack([nx / ln, ny / ln, nz / ln], axis=-1)
    return n * 0.5 + 0.5


def save(name, albedo, height=None, strength=4.0, rough=None):
    a = (np.clip(albedo, 0, 1) ** (1 / 1.0) * 255).astype(np.uint8)
    Image.fromarray(a, 'RGB').save(os.path.join(OUT, f'{name}_albedo.png'), optimize=True)
    if height is not None:
        n = (np.clip(normal_from_height(height, strength), 0, 1) * 255).astype(np.uint8)
        Image.fromarray(n, 'RGB').save(os.path.join(OUT, f'{name}_normal.png'), optimize=True)
    if rough is not None:
        rough = np.broadcast_to(np.asarray(rough, dtype=np.float64), albedo.shape[:2])
        r = (np.clip(rough, 0, 1) * 255).astype(np.uint8)
        Image.fromarray(r, 'L').save(os.path.join(OUT, f'{name}_rough.png'), optimize=True)
    print('wrote', name)


def shade(albedo, k):
    return albedo * k[..., None]


# ——— roofs: fish-scale shingles, like the reference screenshot ———

def shingles(name, base, seed, size=1024, across=8):
    r = rng(seed)
    W = size / across
    H = W * 0.62
    rows = int(round(size / H))
    H = size / rows
    ys, xs = np.mgrid[0:size, 0:size].astype(np.float64)
    tile_id = np.zeros((size, size), dtype=np.int64)
    local = np.zeros((size, size))
    edge = np.full((size, size), 9.0)
    best_r = np.full((size, size), 10 ** 6)
    R = W / 2
    for rr in range(-1, rows + 1):
        off = (rr % 2) * W / 2
        top = rr * H
        kx = np.floor((xs - off) / W)
        cx = (kx + 0.5) * W + off
        dx = xs - cx
        bulge = np.sqrt(np.clip(R * R - dx * dx, 0, None)) * 0.75
        bottom = top + H + bulge - R * 0.55
        yy = ys.copy()
        # vertical wrap
        for shift in (0, size, -size):
            y2 = yy + shift
            inside = (y2 >= top) & (y2 <= bottom) & (rr < best_r)
            if not inside.any():
                continue
            best_r = np.where(inside, rr, best_r)
            tid = (rr % rows) * 1000 + (kx.astype(np.int64) % across)
            tile_id = np.where(inside, tid, tile_id)
            t = (y2 - top) / np.maximum(1, bottom - top)
            local = np.where(inside, t, local)
            # distance to the rounded bottom edge and to the vertical joints
            d_bottom = bottom - y2
            d_side = (W / 2 - np.abs(dx))
            edge = np.where(inside, np.minimum(d_bottom, d_side + 3), edge)
    uniq = np.unique(tile_id)
    lut_v = {u: r.uniform(0.82, 1.12) for u in uniq}
    lut_h = {u: r.uniform(-0.04, 0.04) for u in uniq}
    vary = np.vectorize(lut_v.get)(tile_id)
    hue = np.vectorize(lut_h.get)(tile_id)
    grain = fbm(size, seed + 5, base=6, octaves=3)
    col = np.ones((size, size, 3)) * hexcol(base)
    col = col * vary[..., None]
    col[..., 0] += hue
    col[..., 2] -= hue
    # upper part of each tile sits in the shadow of the row above
    ao = 0.55 + 0.45 * np.clip(local * 1.6, 0, 1)
    rim = np.clip(edge / 5.0, 0, 1)
    ao *= 0.6 + 0.4 * rim
    col = shade(col, ao * (0.9 + 0.2 * grain))
    height = local * 0.6 + np.clip(edge / 7.0, 0, 1) * 0.4 + grain * 0.08
    rough = 0.55 + 0.25 * grain + 0.1 * (1 - rim)
    save(name, col, height, strength=10.0, rough=rough)


# ——— walls ———

def plaster(name, base, seed, size=1024):
    m = fbm(size, seed, base=90, octaves=6)
    g = fbm(size, seed + 9, base=2.0, octaves=2)
    col = np.ones((size, size, 3)) * hexcol(base)
    col = shade(col, 0.92 + 0.1 * m + 0.05 * (g - 0.5))
    height = m * 0.4 + g * 0.6
    save(name, col, height, strength=2.0, rough=0.8 + 0.15 * g)


def planks(name, base, seed, size=1024, count=8, vertical=True, painted=True):
    r = rng(seed)
    grain = fbm(size, seed, base=40, octaves=5, aniso=(6.0, 0.25) if vertical else (0.25, 6.0))
    ys, xs = np.mgrid[0:size, 0:size]
    coord = xs if vertical else ys
    w = size / count
    idx = (coord // w).astype(int)
    local = (coord % w) / w
    vary = np.array([r.uniform(0.9, 1.06) for _ in range(count + 1)])[idx]
    gap = np.clip(np.minimum(local, 1 - local) * w / 2.5, 0, 1)
    col = np.ones((size, size, 3)) * hexcol(base)
    k = vary * (0.95 + 0.1 * grain) if painted else vary * (0.75 + 0.45 * grain)
    col = shade(col, k * (0.55 + 0.45 * gap))
    height = gap * 0.7 + grain * 0.3
    save(name, col, height, strength=5.0, rough=(0.55 if painted else 0.75) + 0.2 * grain)


def stones(name, seed, size=1024, cells=60, base='#a39e94'):
    r = rng(seed)
    pts = r.uniform(0, size, (cells, 2))
    ys, xs = np.mgrid[0:size, 0:size].astype(np.float64)
    d1 = np.full((size, size), 1e9)
    d2 = np.full((size, size), 1e9)
    cid = np.zeros((size, size), dtype=int)
    for i, (px, py) in enumerate(pts):
        dx = np.abs(xs - px)
        dx = np.minimum(dx, size - dx)
        dy = np.abs(ys - py)
        dy = np.minimum(dy, size - dy)
        d = np.sqrt(dx * dx + dy * dy)
        closer = d < d1
        d2 = np.where(closer, d1, np.minimum(d2, d))
        cid = np.where(closer, i, cid)
        d1 = np.where(closer, d, d1)
    mortar = np.clip((d2 - d1) / 10.0, 0, 1)
    vary = np.array([r.uniform(0.8, 1.15) for _ in range(cells)])[cid]
    m = fbm(size, seed + 3, base=20, octaves=4)
    col = np.ones((size, size, 3)) * hexcol(base)
    col = shade(col, vary * (0.85 + 0.25 * m))
    col = col * mortar[..., None] + (1 - mortar[..., None]) * hexcol('#6f6a62')
    height = mortar * (0.7 + 0.3 * m)
    save(name, col, height, strength=8.0, rough=0.85 - 0.1 * mortar)


# ——— ground ———

def dirt(name, seed, size=1024):
    r = rng(seed)
    m = fbm(size, seed, base=120, octaves=7)
    fine = fbm(size, seed + 1, base=3, octaves=2)
    col = colorize(m * 0.8 + fine * 0.2, [(0, '#8a5a32'), (0.45, '#b97f4a'), (0.75, '#cf9a62'), (1, '#e0b07a')])
    height = m * 0.5 + fine * 0.5
    # pebbles
    ys, xs = np.mgrid[0:size, 0:size]
    peb = np.zeros((size, size))
    for _ in range(420):
        px, py = r.uniform(0, size, 2)
        rad = r.uniform(2.5, 8)
        dx = np.minimum(np.abs(xs - px), size - np.abs(xs - px))
        dy = np.minimum(np.abs(ys - py), size - np.abs(ys - py))
        d = np.sqrt(dx * dx + dy * dy) / rad
        peb = np.maximum(peb, np.clip(1 - d, 0, 1) ** 0.6)
    pc = colorize(fbm(size, seed + 7, base=8, octaves=2), [(0, '#7d6f62'), (1, '#c9bba8')])
    col = col * (1 - peb[..., None] * 0.85) + pc * peb[..., None] * 0.85
    height = height + peb * 0.8
    save(name, col, height, strength=6.0, rough=0.9 - 0.2 * peb)


def grass_ground(name, seed, size=1024):
    m = fbm(size, seed, base=150, octaves=7)
    blades = np.zeros((size, size))
    for i, ang in enumerate(np.linspace(0, np.pi, 6, endpoint=False)):
        a = (np.cos(ang), np.sin(ang))
        n = noise(size, 1.2, seed + 20 + i, aniso=(1 + 4 * abs(a[1]), 1 + 4 * abs(a[0])))
        blades = np.maximum(blades, n)
    col = colorize(m * 0.7 + blades * 0.3, [(0, '#3d7a26'), (0.35, '#5c9e34'), (0.65, '#79bb44'), (0.85, '#9ccd58'), (1, '#c3d977')])
    col = shade(col, 0.82 + 0.3 * blades)
    save(name, col, blades * 0.7 + m * 0.3, strength=5.0, rough=0.85 + 0.1 * blades)


def sand(name, seed, size=1024):
    m = fbm(size, seed, base=100, octaves=6)
    grain = fbm(size, seed + 4, base=1.2, octaves=2)
    ys, xs = np.mgrid[0:size, 0:size]
    ripple = 0.5 + 0.5 * np.sin((ys / size) * np.pi * 2 * 18 + m * 6)
    col = colorize(m * 0.6 + grain * 0.4, [(0, '#c9ae80'), (0.5, '#e2cc9c'), (1, '#f3e3bd')])
    col = shade(col, 0.95 + 0.08 * ripple)
    save(name, col, ripple * 0.3 + grain * 0.7, strength=3.0, rough=0.9)


# ——— nature ———

def bark(name, seed, size=512):
    f = fbm(size, seed, base=30, octaves=5, aniso=(5.0, 0.15))
    cr = fbm(size, seed + 2, base=8, octaves=3, aniso=(3.0, 0.3))
    cracks = np.clip((cr - 0.55) * 6, 0, 1)
    col = colorize(f, [(0, '#3e2b1d'), (0.5, '#6b4a30'), (1, '#8c6644')])
    col = shade(col, 1 - 0.55 * cracks)
    save(name, col, f * 0.6 - cracks * 0.6, strength=7.0, rough=0.9)


def leaves(name, seed, size=1024, palette=('#2f6b25', '#3f8a2c', '#56a83a', '#7cc24c', '#a6d968')):
    r = rng(seed)
    img = Image.new('RGB', (size, size), palette[0])
    hmap = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(img)
    dh = ImageDraw.Draw(hmap)
    for i in range(5200):
        x, y = r.uniform(0, size, 2)
        L = r.uniform(14, 30)
        Wd = L * r.uniform(0.38, 0.55)
        ang = r.uniform(0, np.pi * 2)
        c = palette[min(len(palette) - 1, int(r.uniform(0, len(palette)) * (0.5 + i / 5200)))]
        shade_k = 0.75 + 0.3 * (i / 5200)
        col = tuple(int(v * 255 * min(1.1, shade_k)) for v in hexcol(c))
        for ox in (-size, 0, size):
            for oy in (-size, 0, size):
                pts = []
                for t in np.linspace(0, np.pi * 2, 12, endpoint=False):
                    px = np.cos(t) * L / 2
                    py = np.sin(t) * Wd / 2 * (1 - 0.3 * np.cos(t))
                    pts.append((x + ox + px * np.cos(ang) - py * np.sin(ang), y + oy + px * np.sin(ang) + py * np.cos(ang)))
                d.polygon(pts, fill=col)
                dh.polygon(pts, fill=int(60 + 195 * i / 5200))
    a = np.asarray(img).astype(np.float64) / 255
    h = ndimage.gaussian_filter(np.asarray(hmap).astype(np.float64) / 255, 1.2, mode='wrap')
    save(name, a, h, strength=6.0, rough=0.6 + 0.2 * (1 - h))


def grass_blade(name, size=256):
    ys, xs = np.mgrid[0:size, 0:size]
    t = 1 - ys / (size - 1)  # v=0 at the root (bottom of the image), 1 at the tip
    col = colorize(t, [(0, '#2b5a1c'), (0.35, '#4f8f2f'), (0.75, '#86c24a'), (1, '#c8de7a')])
    vein = np.exp(-((xs - size / 2) / (size * 0.04)) ** 2) * 0.12
    col = shade(col, 1 + vein)
    save(name, col, None, rough=0.55 + 0 * t)


def water_normal(name, seed, size=1024):
    h = fbm(size, seed, base=40, octaves=5, aniso=(0.7, 1.4))
    save(name, np.ones((size, size, 3)) * hexcol('#2a7fb8'), h, strength=6.0)


def flat(name, base, rough=0.6, size=64):
    save(name, np.ones((size, size, 3)) * hexcol(base), np.zeros((size, size)), rough=np.full((size, size), rough))


def sign(name, lines, bg='#7a5233', fg='#fff4dc', size=(1024, 512)):
    img = Image.new('RGB', size, bg)
    grain = fbm(512, 77, base=30, octaves=4, aniso=(0.25, 6.0))
    g = Image.fromarray((grain * 255).astype(np.uint8)).resize(size)
    img = Image.blend(img, Image.merge('RGB', (g, g, g)), 0.12)
    d = ImageDraw.Draw(img)
    d.rectangle([10, 10, size[0] - 11, size[1] - 11], outline='#3d2817', width=12)
    y = 70
    for text, px in lines:
        font = ImageFont.truetype(FONT, px)
        w = d.textlength(text, font=font)
        d.text(((size[0] - w) / 2 + 3, y + 4), text, font=font, fill='#2a1a0e')
        d.text(((size[0] - w) / 2, y), text, font=font, fill=fg)
        y += px + 40
    img.save(os.path.join(OUT, f'{name}_albedo.png'), optimize=True)
    print('wrote', name)


def tiles(name, a='#f3efe6', b='#d9d2c3', grout='#b9b1a1', seed=70, size=1024, across=8):
    """Square floor tiles in a checker of two colours."""
    ys, xs = np.mgrid[0:size, 0:size]
    w = size / across
    ix, iy = (xs // w).astype(int), (ys // w).astype(int)
    lx, ly = (xs % w) / w, (ys % w) / w
    col = np.where(((ix + iy) % 2 == 0)[..., None], hexcol(a), hexcol(b))
    m = fbm(size, seed, base=60, octaves=4)
    edge = np.clip(np.minimum(np.minimum(lx, 1 - lx), np.minimum(ly, 1 - ly)) * w / 3.0, 0, 1)
    col = col * (0.95 + 0.07 * m)[..., None]
    col = col * edge[..., None] + hexcol(grout) * (1 - edge[..., None])
    save(name, col, edge * 0.8 + m * 0.2, strength=3.0, rough=0.35 + 0.4 * (1 - edge))


def stripes(name, colors, seed, size=512, count=16, vertical=True, base='#3b2a1d'):
    """Book spines / boxes on a shelf: random coloured strips with dark gaps."""
    r = rng(seed)
    ys, xs = np.mgrid[0:size, 0:size]
    coord = xs if vertical else ys
    edges = np.cumsum(r.uniform(0.6, 1.4, count * 2))
    edges = edges / edges[count - 1] * size
    idx = np.searchsorted(edges, coord)
    pal = [hexcol(colors[r.integers(len(colors))]) for _ in range(count * 2 + 1)]
    col = np.array(pal)[np.minimum(idx, len(pal) - 1)]
    prev = np.concatenate([[0], edges])[np.minimum(idx, len(edges))]
    local = (coord - prev)
    gap = np.clip(local / 3.0, 0, 1)
    col = col * gap[..., None] + hexcol(base) * (1 - gap[..., None])
    band = ((ys if vertical else xs) % (size // 4)) < 6
    col = np.where(band[..., None], col * 0.8, col)
    save(name, col, gap, strength=2.0, rough=0.7)


def emblem(name, bg, size=(1024, 512), lines=()):
    """Sign with a Poké Ball emblem on the left and text on the right (Poké Center / Poké Mart)."""
    img = Image.new('RGB', size, bg)
    d = ImageDraw.Draw(img)
    d.rectangle([10, 10, size[0] - 11, size[1] - 11], outline='#ffffff', width=14)
    cx, cy, rr = 230, size[1] // 2, 150
    d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill='#ffffff', outline='#20232b', width=14)
    d.pieslice([cx - rr, cy - rr, cx + rr, cy + rr], 180, 360, fill='#e2403a', outline='#20232b', width=14)
    d.rectangle([cx - rr, cy - 10, cx + rr, cy + 10], fill='#20232b')
    d.ellipse([cx - 52, cy - 52, cx + 52, cy + 52], fill='#ffffff', outline='#20232b', width=14)
    y = 140 if len(lines) > 1 else 190
    for text, px in lines:
        font = ImageFont.truetype(FONT, px)
        w = d.textlength(text, font=font)
        x = 420 + (size[0] - 420 - w) / 2
        d.text((x + 3, y + 4), text, font=font, fill='#1d2030')
        d.text((x, y), text, font=font, fill='#ffffff')
        y += px + 34
    img.save(os.path.join(OUT, f'{name}_albedo.png'), optimize=True)
    print('wrote', name)


def rug_ball(name, size=1024):
    """Square rug with a big Poké Ball (the floor emblem of the Poké Center)."""
    img = Image.new('RGB', (size, size), '#c8343a')
    d = ImageDraw.Draw(img)
    d.rectangle([24, 24, size - 25, size - 25], outline='#f4efe4', width=18)
    c, r = size // 2, int(size * 0.36)
    d.ellipse([c - r, c - r, c + r, c + r], fill='#f4efe4', outline='#22252d', width=22)
    d.pieslice([c - r, c - r, c + r, c + r], 180, 360, fill='#e2403a', outline='#22252d', width=22)
    d.rectangle([c - r, c - 16, c + r, c + 16], fill='#22252d')
    d.ellipse([c - 90, c - 90, c + 90, c + 90], fill='#f4efe4', outline='#22252d', width=22)
    img.save(os.path.join(OUT, f'{name}_albedo.png'), optimize=True)
    print('wrote', name)


def poster(name, size=(768, 1024)):
    """A wall poster: a simple map of the region with Pallet Town and Route 1."""
    img = Image.new('RGB', size, '#f3ead2')
    d = ImageDraw.Draw(img)
    d.rectangle([14, 14, size[0] - 15, size[1] - 15], outline='#6b4d2e', width=12)
    d.rectangle([60, 640, size[0] - 60, size[1] - 70], fill='#7cc0e8')
    d.rectangle([60, 140, size[0] - 60, 640], fill='#9fd38a')
    d.rectangle([size[0] // 2 - 34, 140, size[0] // 2 + 34, 600], fill='#d8c08a')
    d.rectangle([size[0] // 2 - 90, 520, size[0] // 2 + 90, 620], fill='#e9e1cf', outline='#6b4d2e', width=6)
    font = ImageFont.truetype(FONT, 64)
    small = ImageFont.truetype(FONT, 40)
    for text, y, f in (('КАНТО', 40, font), ('Маршрут 1', 300, small), ('Паллет', 540, small)):
        w = d.textlength(text, font=f)
        d.text(((size[0] - w) / 2, y), text, font=f, fill='#3b2a1d')
    img.save(os.path.join(OUT, f'{name}_albedo.png'), optimize=True)
    print('wrote', name)


def build_all():
    shingles('roof_red', '#c2453a', 1)
    shingles('roof_pink', '#b06a8c', 2)
    shingles('roof_blue', '#4f6f9e', 3)
    shingles('roof_green', '#4f8a5e', 4)
    plaster('wall_cream', '#efe4cc', 10)
    plaster('wall_teal', '#79b3a3', 11)
    plaster('wall_white', '#f2f1ec', 12)
    plaster('wall_peach', '#ebc3a2', 13)
    planks('wood_white', '#f1efe8', 20, count=6)
    planks('wood_brown', '#8a5d3b', 21, count=6, painted=False)
    planks('wood_blue', '#3f6fae', 22, count=5)
    planks('wood_red', '#a8423a', 23, count=5)
    planks('deck', '#a77a52', 24, count=7, vertical=False, painted=False)
    stones('stone', 30)
    stones('cobble', 31, cells=140, base='#b9b2a4')
    dirt('dirt', 40)
    grass_ground('grass', 41)
    sand('sand', 42)
    bark('bark', 50)
    leaves('leaves', 51)
    leaves('leaves_dark', 52, palette=('#1f4d1e', '#2c6427', '#3a7d31', '#4f9940', '#6db04f'))
    leaves('hedge', 53, palette=('#2a5f22', '#3a7a2b', '#4c9436', '#64ad45', '#86c55c'))
    grass_blade('grass_blade')
    water_normal('water', 60)
    flat('glass', '#20384f', 0.08)
    flat('metal_dark', '#3a3f47', 0.4)
    flat('metal_white', '#e8e8e6', 0.35)
    flat('red_paint', '#d03a32', 0.4)
    flat('lamp_glow', '#fff1c4', 0.5)
    sign('sign_pallet', [('ПАЛЛЕТ-ТАУН', 96), ('Оттенки невинности', 54)])
    sign('sign_lab', [('ЛАБОРАТОРИЯ', 92), ('ПРОФЕССОРА ОУКА', 74)], bg='#3b5f8f')
    sign('sign_route1', [('МАРШРУТ 1', 100), ('↑ Виридиан-Сити', 58)])
    emblem('sign_center', '#d93b3b', lines=[('ПОКЕЦЕНТР', 72), ('лечение покемонов', 44)])
    emblem('sign_mart', '#2f63b8', lines=[('МАГАЗИН', 86), ('всё для тренера', 44)])
    planks('floor_wood', '#b88a5c', 25, count=8, vertical=False, painted=False)
    tiles('floor_tile')
    tiles('floor_lab', a='#e8edf2', b='#cfd8e2', grout='#9aa7b6', seed=71)
    plaster('wall_inner', '#f3ead8', 14)
    plaster('wall_lab', '#e6edf3', 15)
    plaster('wall_pink', '#f6d6dc', 16)
    flat('carpet_red', '#b8433f', 0.95)
    flat('carpet_green', '#4f8a5e', 0.95)
    flat('counter_pink', '#f29fb5', 0.45)
    flat('screen', '#8fe0ff', 0.15)
    flat('cushion_blue', '#4f73c9', 0.9)
    stripes('books', ('#8b2e2e', '#2e4f8b', '#2e7a4f', '#b38a2e', '#5e3b8b', '#d0c9b8'), 80)
    stripes('goods', ('#e2403a', '#f2b33a', '#3a8ee2', '#4fbf6a', '#f2f2f2', '#b85ec2', '#8fd0ff'), 81, count=12)
    rug_ball('rug_ball')
    flat('window_day', '#cfe8ff', 0.2)
    flat('pokeball_red', '#e2403a', 0.25)
    poster('poster_kanto')


if __name__ == '__main__':
    only = set(sys.argv[2:])
    if only:
        # Re-run selected generators by name: python textures.py OUT bark leaves ...
        import inspect
        src = inspect.getsource(build_all).splitlines()[1:]
        for line in src:
            line = line.strip()
            if line and line.split("'")[1] in only:
                exec(line)
    else:
        build_all()
