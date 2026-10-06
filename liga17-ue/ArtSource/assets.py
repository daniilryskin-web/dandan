"""Pallet Town art kit: houses, Oak's lab, fences, props, trees, bushes, flowers and grass.

Every builder returns a Blender object at the origin with its pivot on the ground (z = 0),
front facade facing -Y. Units are metres.
"""
import math
import random

from mathutils import Matrix, Vector

from common import MB


def facade(side, W, D):
    """Matrix mapping local (u, w, z) -> world, u along the wall (left→right seen from outside), w outward."""
    if side == 'front':
        return Matrix(((1, 0, 0, 0), (0, -1, 0, -D / 2), (0, 0, 1, 0), (0, 0, 0, 1)))
    if side == 'back':
        return Matrix(((-1, 0, 0, 0), (0, 1, 0, D / 2), (0, 0, 1, 0), (0, 0, 0, 1)))
    if side == 'right':
        return Matrix(((0, 1, 0, W / 2), (1, 0, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1)))
    return Matrix(((0, -1, 0, -W / 2), (-1, 0, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1)))


def fbox(mb, mat, F, c, s):
    """Box in facade space: c=(u, w, z) centre, s=(su, sw, sz)."""
    m = F @ Matrix.Translation(Vector(c))
    # Facade matrices may mirror; boxes are symmetric so only the centre matters, but keep axes.
    mb.box(mat, None, s, m=m)


def window(mb, F, u, z, w=1.3, h=1.5, trim='wood_white', shutter=None, cross=True):
    t = 0.12
    fbox(mb, 'glass', F, (u, 0.02, z + h / 2), (w, 0.04, h))
    fbox(mb, trim, F, (u, 0.07, z + h + t / 2), (w + 2 * t, 0.12, t))
    fbox(mb, trim, F, (u, 0.07, z - t / 2), (w + 2 * t, 0.12, t))
    fbox(mb, trim, F, (u - w / 2 - t / 2, 0.07, z + h / 2), (t, 0.12, h))
    fbox(mb, trim, F, (u + w / 2 + t / 2, 0.07, z + h / 2), (t, 0.12, h))
    fbox(mb, trim, F, (u, 0.13, z - t - 0.04), (w + 0.42, 0.24, 0.09))
    if cross:
        fbox(mb, trim, F, (u, 0.06, z + h / 2), (0.06, 0.07, h))
        fbox(mb, trim, F, (u, 0.06, z + h * 0.55), (w, 0.07, 0.06))
    if shutter:
        for s in (-1, 1):
            fbox(mb, shutter, F, (u + s * (w / 2 + t + 0.26), 0.06, z + h / 2), (0.48, 0.06, h + 0.1))


def door(mb, F, u, z, w=1.15, h=2.25, mat='wood_blue', trim='wood_white', canopy=None, steps=2, double=False):
    t = 0.14
    if double:
        fbox(mb, mat, F, (u - w / 4, 0.04, z + h / 2), (w / 2 - 0.02, 0.08, h))
        fbox(mb, mat, F, (u + w / 4, 0.04, z + h / 2), (w / 2 - 0.02, 0.08, h))
        fbox(mb, 'glass', F, (u - w / 4, 0.085, z + h * 0.62), (w / 2 - 0.3, 0.02, h * 0.5))
        fbox(mb, 'glass', F, (u + w / 4, 0.085, z + h * 0.62), (w / 2 - 0.3, 0.02, h * 0.5))
    else:
        fbox(mb, mat, F, (u, 0.04, z + h / 2), (w, 0.08, h))
        # raised panels
        fbox(mb, mat, F, (u, 0.09, z + h * 0.72), (w * 0.62, 0.03, h * 0.32))
        fbox(mb, mat, F, (u, 0.09, z + h * 0.3), (w * 0.62, 0.03, h * 0.36))
        mb.sphere('metal_white', F @ Vector((u + w * 0.36, 0.14, z + h * 0.47)), 0.05, subdiv=1)
    fbox(mb, trim, F, (u, 0.08, z + h + t / 2), (w + 2 * t, 0.16, t))
    fbox(mb, trim, F, (u - w / 2 - t / 2, 0.08, z + h / 2), (t, 0.16, h))
    fbox(mb, trim, F, (u + w / 2 + t / 2, 0.08, z + h / 2), (t, 0.16, h))
    for i in range(steps):
        fbox(mb, 'stone', F, (u, 0.3 + (steps - 1 - i) * 0.32, z - 0.18 * (i + 1) + 0.09), (w + 0.9 - i * 0.1, 0.6 + i * 0.32, 0.18))
    if canopy:
        cw = w + 1.0
        dep = 1.1
        p = math.radians(28)
        rise = dep * math.tan(p)
        zc = z + h + 0.35
        L = dep / math.cos(p)
        # slab sloping down away from the wall
        m = F @ Matrix.Translation(Vector((u, dep / 2, zc + rise / 2))) @ Matrix.Rotation(-p, 4, 'X')
        mb.box(canopy, None, (cw, L, 0.12), m=m)
        for s in (-1, 1):
            m = F @ Matrix.Translation(Vector((u + s * (cw / 2 - 0.1), dep * 0.55, zc - 0.25))) @ Matrix.Rotation(-0.75, 4, 'X')
            mb.box(trim, None, (0.1, 0.9, 0.1), m=m)


def gable_roof(mb, W, D, zE, roof, trim, pitch_deg=35, o=0.5, t=0.2, attic=None):
    p = math.radians(pitch_deg)
    d = D / 2 + o
    rise = (D / 2) * math.tan(p)
    zR = zE + rise
    zEo = zE - o * math.tan(p)
    L = d / math.cos(p)
    for side in (-1, 1):
        ang = p if side < 0 else -p
        n = Vector((0, side * math.sin(p), math.cos(p)))
        mid = Vector((0, side * d / 2, (zEo + zR) / 2)) + n * (t / 2 + 0.01)
        mb.box(roof, None, (W + 2 * o, L, t), m=Matrix.Translation(mid) @ Matrix.Rotation(ang, 4, 'X'))
        # fascia along the eave
        mb.box(trim, (0, side * (d + 0.02), zEo - 0.04), (W + 2 * o + 0.08, 0.1, 0.26))
        # barge boards on the gable ends
        for sx in (-1, 1):
            mid2 = Vector((sx * (W / 2 + o + 0.04), side * d / 2, (zEo + zR) / 2 + 0.02))
            mb.box(trim, None, (0.1, L + 0.08, 0.3), m=Matrix.Translation(mid2) @ Matrix.Rotation(ang, 4, 'X'))
    # ridge cap
    mb.box(roof, (0, 0, zR + t + 0.06), (W + 2 * o + 0.1, 0.36, 0.2))
    # gable triangles
    for sx in (-1, 1):
        m = Matrix(((0, 0, 1, sx * W / 2 - 0.1), (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
        pts = [(-D / 2, zE), (D / 2, zE), (0, zR)]
        mb.prism(attic or 'wall_white', pts, 0, 0.2, m=m)
    return zR, rise


def round_window(mb, c, axis_rz, r=0.5):
    m = Matrix.Translation(Vector(c)) @ Matrix.Rotation(axis_rz, 4, 'Z') @ Matrix.Rotation(math.pi / 2, 4, 'Y')
    mb.cyl('wood_white', None, r, 0.14, seg=24, m=m)
    m2 = m @ Matrix.Translation(Vector((0, 0, 0.1)))
    mb.cyl('glass', None, r * 0.78, 0.08, seg=24, m=m2)
    m3 = m @ Matrix.Translation(Vector((0, 0, 0.14)))
    mb.box('wood_white', None, (0.06, r * 1.56, 0.05), m=m3)
    mb.box('wood_white', None, (r * 1.56, 0.06, 0.05), m=m3)


def house(name, W=9.0, D=7.0, H=5.6, wall='wall_cream', roof='roof_red', trim='wood_white', doormat='wood_blue',
          shutter=None, pitch=36, tower=None, chimney=True, floors=2, seed=1):
    random.seed(seed)
    mb = MB()
    Fh = 0.45
    mb.box('stone', (0, 0, Fh / 2), (W + 0.24, D + 0.24, Fh))
    mb.box(wall, (0, 0, Fh + H / 2), (W, D, H))
    for sx in (-1, 1):
        for sy in (-1, 1):
            mb.box(trim, (sx * W / 2, sy * D / 2, Fh + H / 2), (0.24, 0.24, H))
    zb = Fh + H * 0.5
    if floors > 1:
        for sy in (-1, 1):
            mb.box(trim, (0, sy * (D / 2 + 0.03), zb), (W + 0.06, 0.12, 0.16))
        for sx in (-1, 1):
            mb.box(trim, (sx * (W / 2 + 0.03), 0, zb), (0.12, D + 0.06, 0.16))
    zR, rise = gable_roof(mb, W, D, Fh + H, roof, trim, pitch_deg=pitch, attic=wall)
    # round attic windows on the gable ends
    for sx in (-1, 1):
        round_window(mb, (sx * (W / 2 + 0.08), 0, Fh + H + rise * 0.42), 0 if sx > 0 else math.pi, r=0.5)
    F = facade('front', W, D)
    door(mb, F, -W * 0.18, Fh, mat=doormat, trim=trim, canopy=roof)
    z1 = Fh + 0.95
    z2 = Fh + H * 0.5 + 0.55
    upper = floors > 1
    if not tower:
        window(mb, F, W * 0.26, z1, shutter=shutter)
    window(mb, F, -W * 0.36, z1, w=0.9, shutter=shutter)
    if upper:
        for u in ((-W * 0.26,) if tower else (-W * 0.26, W * 0.26)):
            window(mb, F, u, z2, shutter=shutter)
    B = facade('back', W, D)
    for u in (-W * 0.25, W * 0.25):
        window(mb, B, u, z1)
        if upper:
            window(mb, B, u, z2)
    for side in ('left', 'right'):
        S = facade(side, W, D)
        window(mb, S, -D * 0.2, z1, w=1.0)
        window(mb, S, D * 0.2, z2 if upper else z1, w=1.0)
    if chimney:
        cx, cy = W * 0.28, D * 0.18
        zc = zR + 1.0
        mb.box('stone', (cx, cy, (Fh + H + zc) / 2), (0.8, 0.8, zc - Fh - H))
        mb.box('stone', (cx, cy, zc + 0.08), (1.0, 1.0, 0.16))
        mb.box('metal_dark', (cx, cy, zc + 0.3), (0.35, 0.35, 0.3))
    if tower:
        # round tower on the front-right corner, like the reference screenshot
        tr = 1.9
        tx, ty = W / 2 - 0.4, -D / 2 + 0.7
        th = Fh + H + 1.4
        mb.cyl('stone', (tx, ty, 0), tr + 0.12, Fh, seg=28)
        mb.cyl(tower, (tx, ty, Fh), tr, th - Fh, seg=28)
        mb.cyl('wood_white', (tx, ty, th), tr + 0.12, 0.2, seg=28)
        mb.cyl(roof, (tx, ty, th + 0.2), tr + 0.45, 2.6, seg=28, r2=0.02)
        mb.sphere('metal_white', (tx, ty, th + 2.9), 0.16, subdiv=2)
        # tower door facing front, windows around
        TF = Matrix.Translation(Vector((tx, ty, 0))) @ Matrix.Rotation(-0.35, 4, 'Z') @ Matrix(((1, 0, 0, 0), (0, -1, 0, -tr + 0.02), (0, 0, 1, 0), (0, 0, 0, 1)))
        door(mb, TF, 0, Fh, w=1.1, mat=doormat, trim='wood_white', canopy=roof, steps=1)
        for k, a in enumerate((0.9, -1.3, 2.4)):
            WF = Matrix.Translation(Vector((tx, ty, 0))) @ Matrix.Rotation(a, 4, 'Z') @ Matrix(((1, 0, 0, 0), (0, -1, 0, -tr + 0.02), (0, 0, 1, 0), (0, 0, 0, 1)))
            window(mb, WF, 0, Fh + H * 0.5 + 0.6, w=0.8, h=1.2)
    return mb.build(name, bevel=0.025)


def oak_lab(name='oak_lab', W=17.0, D=10.0, H=5.0):
    mb = MB()
    Fh = 0.5
    mb.box('stone', (0, 0, Fh / 2), (W + 0.3, D + 0.3, Fh))
    mb.box('wall_white', (0, 0, Fh + H / 2), (W, D, H))
    for sx in (-1, 0, 1):
        for sy in (-1, 1):
            mb.box('wood_blue', (sx * W / 2, sy * D / 2, Fh + H / 2), (0.3, 0.3, H))
    mb.box('wood_blue', (0, -D / 2 - 0.03, Fh + H - 0.2), (W + 0.06, 0.12, 0.4))
    mb.box('wood_blue', (0, D / 2 + 0.03, Fh + H - 0.2), (W + 0.06, 0.12, 0.4))
    zR, rise = gable_roof(mb, W, D, Fh + H, 'roof_blue', 'wood_white', pitch_deg=22, o=0.7, attic='wall_white')
    F = facade('front', W, D)
    door(mb, F, 0, Fh, w=2.4, h=2.6, mat='metal_white', trim='wood_blue', canopy=None, steps=3, double=True)
    # flat entrance canopy on posts
    mb.box('wood_white', (0, -D / 2 - 1.3, Fh + 3.1), (4.6, 2.8, 0.22))
    for sx in (-1, 1):
        mb.cyl('wood_white', (sx * 2.0, -D / 2 - 2.4, 0), 0.13, Fh + 3.0, seg=12)
    # sign above the canopy
    mb.box('wood_blue', (0, -D / 2 - 0.12, Fh + 3.95), (4.4, 0.16, 1.35))
    mb.face('sign_lab', [(-2.05, -D / 2 - 0.21, Fh + 3.35), (2.05, -D / 2 - 0.21, Fh + 3.35), (2.05, -D / 2 - 0.21, Fh + 4.55), (-2.05, -D / 2 - 0.21, Fh + 4.55)], fit=True)
    for u in (-6.2, -3.7, 3.7, 6.2):
        window(mb, F, u, Fh + 1.1, w=1.8, h=2.2, trim='wood_blue')
    B = facade('back', W, D)
    for u in (-6, -2, 2, 6):
        window(mb, B, u, Fh + 1.1, w=1.8, h=2.2, trim='wood_blue')
    for side in ('left', 'right'):
        S = facade(side, W, D)
        for u in (-2.5, 2.5):
            window(mb, S, u, Fh + 1.1, w=1.6, h=2.2, trim='wood_blue')
    # roof equipment: satellite dish, solar panels, weather vane
    dish = Matrix.Translation(Vector((-W * 0.3, D * 0.15, zR + 0.2)))
    mb.cyl('metal_dark', None, 0.08, 1.2, seg=10, m=dish)
    dm = dish @ Matrix.Translation(Vector((0, 0, 1.25))) @ Matrix.Rotation(0.9, 4, 'X')
    mb.cyl('metal_white', None, 0.9, 0.3, seg=24, r2=0.15, m=dm @ Matrix.Translation(Vector((0, 0, -0.3))))
    p = math.radians(22)
    for i in range(3):
        m = Matrix.Translation(Vector((W * 0.05 + i * 2.1, D * 0.25, Fh + H + rise * 0.5 + 0.25))) @ Matrix.Rotation(-p, 4, 'X')
        mb.box('metal_dark', None, (1.9, 2.4, 0.08), m=m)
        mb.box('glass', None, (1.75, 2.25, 0.03), m=m @ Matrix.Translation(Vector((0, 0, 0.05))))
    mb.cyl('metal_dark', (W * 0.38, 0, zR + 0.2), 0.05, 2.0, seg=8)
    mb.box('red_paint', (W * 0.38 + 0.3, 0, zR + 2.0), (0.6, 0.04, 0.3))
    # glass annex (greenhouse) on the right
    ax = W / 2 + 2.6
    mb.box('stone', (ax, 1.0, 0.25), (5.4, 6.4, 0.5))
    mb.box('glass', (ax, 1.0, 0.5 + 1.5), (5.0, 6.0, 3.0))
    gx0, gx1, gy0, gy1 = ax - 2.5, ax + 2.5, -2.0, 4.0
    for i in range(5):
        x = gx0 + i * 1.25
        for y in (gy0, gy1):
            mb.box('wood_white', (x, y, 2.0), (0.1, 0.1, 3.0))
    for i in range(1, 5):
        y = gy0 + i * 1.2
        mb.box('wood_white', (gx1, y, 2.0), (0.1, 0.1, 3.0))
    for z in (0.55, 2.0, 3.45):
        mb.box('wood_white', (ax, gy0, z), (5.1, 0.1, 0.1))
        mb.box('wood_white', (ax, gy1, z), (5.1, 0.1, 0.1))
        mb.box('wood_white', (gx1, 1.0, z), (0.1, 6.1, 0.1))
    mb.box('wood_white', (ax, 1.0, 3.55), (5.3, 6.3, 0.14))
    obj = mb.build(name, bevel=0.03)
    return obj


def service_building(name, W, D, H, roof, band, sign, door_mat='metal_white'):
    """Poké Center / Poké Mart: white walls with a coloured band, low roof, glass double door, a big sign over the canopy.
    The door is in the middle of the front facade; the door marker is 0.7 m in front of it."""
    mb = MB()
    Fh = 0.4
    mb.box('stone', (0, 0, Fh / 2), (W + 0.3, D + 0.3, Fh))
    mb.box('wall_white', (0, 0, Fh + H / 2), (W, D, H))
    zt = Fh + H
    mb.box(band, (0, 0, zt - 0.35), (W + 0.12, D + 0.12, 0.7))
    mb.box(band, (0, 0, Fh + 0.15), (W + 0.08, D + 0.08, 0.3))
    for sx in (-1, 1):
        for sy in (-1, 1):
            mb.box(band, (sx * W / 2, sy * D / 2, Fh + H / 2), (0.32, 0.32, H))
    gable_roof(mb, W, D, zt, roof, 'wood_white', pitch_deg=18, o=0.6, attic='wall_white')
    F = facade('front', W, D)
    door(mb, F, 0, Fh, w=2.4, h=2.6, mat=door_mat, trim=band, canopy=None, steps=2, double=True)
    # entrance canopy on two posts
    mb.box(band, (0, -D / 2 - 0.95, Fh + 3.0), (4.6, 1.9, 0.22))
    mb.box('metal_white', (0, -D / 2 - 1.9, Fh + 3.0), (4.7, 0.06, 0.3))
    for sx in (-1, 1):
        mb.cyl('metal_white', (sx * 2.05, -D / 2 - 1.75, 0), 0.09, Fh + 2.9, seg=12)
    # sign board above the canopy
    sw, sh = 3.6, 1.8
    zs = Fh + 3.3
    yb = -D / 2 - 0.1
    mb.box(band, (0, yb, zs + sh / 2), (sw + 0.3, 0.16, sh + 0.3))
    yf = yb - 0.085
    mb.face(sign, [(-sw / 2, yf, zs), (sw / 2, yf, zs), (sw / 2, yf, zs + sh), (-sw / 2, yf, zs + sh)], fit=True)
    for u in (-W * 0.33, W * 0.33):
        window(mb, F, u, Fh + 0.9, w=min(2.2, W * 0.2), h=1.7, trim='metal_white', cross=False)
    B = facade('back', W, D)
    for u in (-W * 0.25, W * 0.25):
        window(mb, B, u, Fh + 1.1, w=1.4, h=1.4, trim='metal_white', cross=False)
    for side in ('left', 'right'):
        S = facade(side, W, D)
        for u in (-D * 0.22, D * 0.22):
            window(mb, S, u, Fh + 1.0, w=1.4, h=1.6, trim='metal_white', cross=False)
    return mb.build(name, bevel=0.025)


def pier(name='pier', L=20.0, w=3.0):
    """Wooden jetty: deck top at z = 0, starting at y = 0 and running towards -Y over the water."""
    mb = MB()
    mb.box('deck', (0, -L / 2, -0.1), (w, L, 0.2))
    for sx in (-1, 1):
        mb.box('wood_brown', (sx * (w / 2 - 0.05), -L / 2, -0.28), (0.12, L, 0.22))
    n = int(L // 2.5)
    for i in range(n + 1):
        y = -0.6 - i * (L - 0.9) / n
        for sx in (-1, 1):
            top = 1.05 if i > 0 else 0.25
            mb.cyl('wood_brown', (sx * (w / 2 - 0.12), y, -4.5), 0.13, 4.5 + top, seg=10)
    # hand rails along both sides (open at the shore end) and across the far end
    y0, y1 = -1.6, -L + 0.3
    for sx in (-1, 1):
        mb.box('wood_white', (sx * (w / 2 - 0.12), (y0 + y1) / 2, 1.0), (0.1, y0 - y1, 0.09))
        mb.box('wood_white', (sx * (w / 2 - 0.12), (y0 + y1) / 2, 0.55), (0.06, y0 - y1, 0.07))
    mb.box('wood_white', (0, y1, 1.0), (w - 0.2, 0.1, 0.09))
    mb.box('wood_white', (0, y1, 0.55), (w - 0.2, 0.06, 0.07))
    for sx in (-1, 1):
        mb.cyl('metal_dark', (sx * 0.8, -L + 1.2, 0), 0.14, 0.45, seg=12, r2=0.11)
    # lantern at the end
    mb.cyl('metal_dark', (w / 2 - 0.12, -L + 0.6, 1.05), 0.05, 1.5, seg=8)
    mb.box('lamp_glow', (w / 2 - 0.12, -L + 0.6, 2.75), (0.24, 0.24, 0.36))
    mb.box('metal_dark', (w / 2 - 0.12, -L + 0.6, 2.97), (0.34, 0.34, 0.06))
    return mb.build(name, bevel=0.01)


def fence(name='fence', length=2.0, h=1.0, mat='wood_white'):
    mb = MB()
    for sx in (-1, 1):
        mb.box(mat, (sx * length / 2, 0, h / 2), (0.12, 0.12, h + 0.1))
        mb.prism(mat, [(-0.07, -0.07), (0.07, -0.07), (0.07, 0.07), (-0.07, 0.07)], h + 0.1, h + 0.16, m=Matrix.Translation(Vector((sx * length / 2, 0, 0))))
    for z in (0.32, 0.78):
        mb.box(mat, (0, 0.05, z), (length, 0.04, 0.09))
    n = 8
    for i in range(n):
        x = -length / 2 + (i + 0.75) * length / (n + 0.5)
        pts = [(-0.045, 0), (0.045, 0), (0.045, h * 0.85), (0, h * 0.95), (-0.045, h * 0.85)]
        m = Matrix.Translation(Vector((x, 0.09, 0.05))) @ Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
        mb.prism(mat, pts, -0.015, 0.015, m=m)
    return mb.build(name, bevel=0.008)


def mailbox(name='mailbox'):
    mb = MB()
    mb.box('wood_brown', (0, 0, 0.55), (0.12, 0.12, 1.1))
    mb.box('red_paint', (0, 0, 1.18), (0.36, 0.55, 0.26))
    m = Matrix.Translation(Vector((0, -0.275, 1.31))) @ Matrix.Rotation(-math.pi / 2, 4, 'X')
    mb.cyl('red_paint', None, 0.18, 0.55, seg=16, m=m)
    mb.box('metal_white', (0.2, 0.1, 1.38), (0.03, 0.04, 0.3))
    mb.box('red_paint', (0.2, 0.02, 1.48), (0.03, 0.16, 0.1))
    return mb.build(name, bevel=0.01)


def town_sign(name, decal, w=2.0, h=1.0):
    mb = MB()
    for sx in (-1, 1):
        mb.box('wood_brown', (sx * (w / 2 + 0.05), 0, (h + 0.8) / 2), (0.16, 0.16, h + 0.8))
    mb.box('wood_brown', (0, 0, 0.8 + h / 2), (w + 0.1, 0.12, h + 0.08))
    z0, z1 = 0.84, 0.8 + h - 0.04
    mb.face(decal, [(-w / 2, -0.065, z0), (w / 2, -0.065, z0), (w / 2, -0.065, z1), (-w / 2, -0.065, z1)], fit=True)
    mb.face(decal, [(w / 2, 0.065, z0), (-w / 2, 0.065, z0), (-w / 2, 0.065, z1), (w / 2, 0.065, z1)], fit=True)
    return mb.build(name, bevel=0.015)


def lamp_post(name='lamp_post'):
    mb = MB()
    mb.cyl('metal_dark', (0, 0, 0), 0.2, 0.3, seg=12, r2=0.14)
    mb.cyl('metal_dark', (0, 0, 0.3), 0.07, 3.0, seg=12, r2=0.05)
    mb.box('metal_dark', (0, 0, 3.35), (0.42, 0.42, 0.06))
    mb.box('lamp_glow', (0, 0, 3.62), (0.3, 0.3, 0.5))
    for sx in (-1, 1):
        for sy in (-1, 1):
            mb.box('metal_dark', (sx * 0.18, sy * 0.18, 3.62), (0.04, 0.04, 0.52))
    mb.cyl('metal_dark', (0, 0, 3.88), 0.32, 0.25, seg=4, r2=0.02)
    return mb.build(name, bevel=0.008)


def bench(name='bench'):
    mb = MB()
    for i in range(4):
        mb.box('deck', (0, -0.18 + i * 0.12, 0.46), (1.8, 0.1, 0.05))
    for i in range(2):
        mb.box('deck', (0, 0.22, 0.65 + i * 0.16), (1.8, 0.05, 0.11))
    for sx in (-1, 1):
        mb.box('metal_dark', (sx * 0.75, 0, 0.23), (0.06, 0.46, 0.46))
        mb.box('metal_dark', (sx * 0.75, 0.22, 0.6), (0.06, 0.05, 0.5))
    return mb.build(name, bevel=0.01)


def trunk(mb, h, r0, seed, lean=0.3):
    random.seed(seed)
    rings = 7
    seg = 10
    prev = None
    ax = Vector((random.uniform(-lean, lean), random.uniform(-lean, lean), 0))
    for i in range(rings + 1):
        t = i / rings
        r = r0 * (1.0 - 0.55 * t) * (1.5 if i == 0 else 1.0)
        c = Vector((ax.x * t * t * h * 0.25, ax.y * t * t * h * 0.25, t * h))
        ring = [mb.bm.verts.new(c + Vector((math.cos(a) * r * (1 + 0.08 * math.sin(a * 3 + seed)), math.sin(a) * r, 0))) for a in [k / seg * math.tau for k in range(seg)]]
        if prev:
            for k in range(seg):
                f = mb.bm.faces.new([prev[k], prev[(k + 1) % seg], ring[(k + 1) % seg], ring[k]])
                f.material_index = mb.mi('bark')
        prev = ring
    return Vector((ax.x * h * 0.25, ax.y * h * 0.25, h))


def tree(name, seed=1, h=6.5, r=2.6, leaves='leaves', blobs=8):
    random.seed(seed)
    mb = MB()
    top = trunk(mb, h * 0.72, 0.3, seed)
    for i in range(3):
        a = random.uniform(0, math.tau)
        base = Vector((top.x * 0.6, top.y * 0.6, h * random.uniform(0.42, 0.6)))
        d = Vector((math.cos(a), math.sin(a), 1.1)).normalized()
        m = Matrix.Translation(base) @ d.to_track_quat('Z', 'Y').to_matrix().to_4x4()
        mb.cyl('bark', None, 0.11, 1.8, seg=6, r2=0.04, m=m, cap=False)
    cz = h * 0.72
    centers = [Vector((top.x, top.y, cz + r * 0.25))]
    for i in range(blobs - 1):
        a = i / (blobs - 1) * math.tau + random.uniform(-0.3, 0.3)
        rr = r * random.uniform(0.45, 0.7)
        centers.append(Vector((top.x + math.cos(a) * rr, top.y + math.sin(a) * rr, cz + random.uniform(-0.5, 0.9))))
    for i, c in enumerate(centers):
        rad = r * (0.62 if i == 0 else random.uniform(0.42, 0.55))
        mb.sphere(leaves, c, rad, subdiv=3, scale=(1, 1, 0.86), displace=0.16, seed=seed * 13 + i, freq=1.6)
    return mb.build(name, smooth_angle=80)


def pine(name, seed=1, h=9.0, r=2.4):
    random.seed(seed)
    mb = MB()
    trunk(mb, h * 0.5, 0.28, seed, lean=0.05)
    tiers = 5
    for i in range(tiers):
        t = i / tiers
        z = h * (0.25 + 0.68 * t)
        rr = r * (1 - t * 0.78)
        mb.cyl('leaves_dark', (0, 0, z), rr, h * 0.26, seg=14, r2=0.05)
    return mb.build(name, smooth_angle=70)


def bush(name, seed=1, r=0.9, blobs=4, mat='hedge'):
    random.seed(seed)
    mb = MB()
    for i in range(blobs):
        a = random.uniform(0, math.tau)
        d = 0 if i == 0 else r * 0.55
        c = (math.cos(a) * d, math.sin(a) * d, r * 0.62 + random.uniform(-0.1, 0.15))
        mb.sphere(mat, c, r * random.uniform(0.62, 0.85), subdiv=3, scale=(1, 1, 0.85), displace=0.14, seed=seed * 7 + i, freq=2.0)
    return mb.build(name, smooth_angle=80)


def hedge(name='hedge', length=2.0, h=1.0, d=0.8):
    mb = MB()
    mb.box('hedge', (0, 0, h / 2), (length, d, h))
    return mb.build(name, bevel=0.22, bevel_segments=3, smooth_angle=60)


def flower(mb, c, color, scale=1.0, rnd=random):
    h = rnd.uniform(0.18, 0.34) * scale
    mb.cyl('stem', c, 0.008 * scale, h, seg=4, cap=False)
    top = Vector(c) + Vector((0, 0, h))
    petals = 5
    rot = rnd.uniform(0, math.tau)
    pr = 0.045 * scale
    for i in range(petals):
        a = rot + i / petals * math.tau
        pc = top + Vector((math.cos(a) * pr * 1.1, math.sin(a) * pr * 1.1, 0.005))
        mb.sphere(color, pc, pr, subdiv=1, scale=(1.0, 0.6, 0.25))
    mb.sphere('flower_center', top + Vector((0, 0, 0.012)), pr * 0.55, subdiv=1, scale=(1, 1, 0.5))


def flower_bed(name='flower_bed', w=3.0, d=1.2, seed=1, colors=('flower_red', 'flower_yellow', 'flower_white', 'flower_pink')):
    rnd = random.Random(seed)
    mb = MB()
    mb.box('wood_white', (0, -d / 2, 0.15), (w + 0.12, 0.1, 0.3))
    mb.box('wood_white', (0, d / 2, 0.15), (w + 0.12, 0.1, 0.3))
    mb.box('wood_white', (-w / 2, 0, 0.15), (0.1, d, 0.3))
    mb.box('wood_white', (w / 2, 0, 0.15), (0.1, d, 0.3))
    mb.box('dirt', (0, 0, 0.12), (w - 0.05, d - 0.05, 0.24))
    n = int(w * d * 22)
    for i in range(n):
        c = (rnd.uniform(-w / 2 + 0.12, w / 2 - 0.12), rnd.uniform(-d / 2 + 0.12, d / 2 - 0.12), 0.24)
        flower(mb, c, colors[(i // 3) % len(colors)], 1.0, rnd)
    for i in range(int(w * 6)):
        c = (rnd.uniform(-w / 2 + 0.1, w / 2 - 0.1), rnd.uniform(-d / 2 + 0.1, d / 2 - 0.1), 0.24)
        mb.sphere('hedge', c, 0.09, subdiv=1, scale=(1, 1, 0.6))
    return mb.build(name, smooth_angle=60)


def flower_patch(name='flower_patch', seed=1, r=0.8, n=14, colors=('flower_yellow', 'flower_white')):
    rnd = random.Random(seed)
    mb = MB()
    for i in range(n):
        a = rnd.uniform(0, math.tau)
        d = math.sqrt(rnd.uniform(0, 1)) * r
        flower(mb, (math.cos(a) * d, math.sin(a) * d, 0), colors[i % len(colors)], 0.9, rnd)
    return mb.build(name, smooth_angle=60)


def grass_clump(name, seed=1, blades=36, hmin=0.55, hmax=1.05, spread=0.45, width=0.05):
    rnd = random.Random(seed)
    mb = MB()
    bm = mb.bm
    mi = mb.mi('grass_blade')
    for b in range(blades):
        a = rnd.uniform(0, math.tau)
        d = math.sqrt(rnd.uniform(0, 1)) * spread
        base = Vector((math.cos(a) * d, math.sin(a) * d, 0))
        h = rnd.uniform(hmin, hmax)
        yaw = rnd.uniform(0, math.tau)
        lean = rnd.uniform(0.15, 0.55) * (0.6 + d / spread)
        lean_dir = Vector((math.cos(a + rnd.uniform(-0.6, 0.6)), math.sin(a + rnd.uniform(-0.6, 0.6)), 0))
        side = Vector((math.cos(yaw), math.sin(yaw), 0))
        segs = 4
        prev = None
        for s in range(segs + 1):
            t = s / segs
            w = width * (1 - t) ** 0.8 + 0.002
            c = base + Vector((0, 0, h * t)) + lean_dir * (lean * h * t * t)
            v1 = bm.verts.new(c - side * w)
            v2 = bm.verts.new(c + side * w)
            if prev:
                f = bm.faces.new([prev[0], prev[1], v2, v1])
                f.material_index = mi
            prev = (v1, v2)
    obj = mb.build(name, smooth_angle=89)
    # Gradient UVs: u across the blade, v from the root (0) to the tip (1).
    me = obj.data
    import bmesh as _b
    bmx = _b.new()
    bmx.from_mesh(me)
    uvlay = bmx.loops.layers.uv[0]
    for f in bmx.faces:
        for i, l in enumerate(f.loops):
            l[uvlay].uv = (0.0 if i in (0, 3) else 1.0, l.vert.co.z / hmax)
    bmx.to_mesh(me)
    bmx.free()
    return obj


def rock(name, seed=1, r=0.8):
    mb = MB()
    mb.sphere('stone', (0, 0, r * 0.35), r, subdiv=3, scale=(1.2, 1, 0.7), displace=0.25, seed=seed, freq=1.2)
    return mb.build(name, smooth_angle=50)


def build_kit():
    kit = {}
    kit['house_player'] = house('house_player', wall='wall_cream', roof='roof_red', doormat='wood_red', shutter='wood_red', seed=1)
    kit['house_rival'] = house('house_rival', wall='wall_teal', roof='roof_pink', doormat='wood_blue', shutter=None, tower='wood_blue', chimney=False, seed=2)
    kit['house_small'] = house('house_small', W=7.0, D=6.0, H=3.4, wall='wall_peach', roof='roof_green', doormat='wood_brown', shutter='wood_brown', pitch=38, floors=1, seed=3)
    kit['oak_lab'] = oak_lab()
    kit['pokecenter'] = service_building('pokecenter', 12.0, 10.0, 5.2, 'roof_red', 'red_paint', 'sign_center')
    kit['mart'] = service_building('mart', 10.0, 8.0, 5.0, 'roof_blue', 'wood_blue', 'sign_mart')
    kit['pier'] = pier()
    kit['fence'] = fence()
    kit['mailbox'] = mailbox()
    kit['sign_pallet'] = town_sign('sign_pallet', 'sign_pallet')
    kit['sign_route1'] = town_sign('sign_route1', 'sign_route1', w=1.6, h=0.8)
    kit['lamp_post'] = lamp_post()
    kit['bench'] = bench()
    kit['tree_a'] = tree('tree_a', seed=1)
    kit['tree_b'] = tree('tree_b', seed=2, h=7.5, r=3.0, leaves='leaves_dark', blobs=9)
    kit['tree_c'] = tree('tree_c', seed=3, h=5.5, r=2.2)
    kit['pine'] = pine('pine', seed=4)
    kit['bush_a'] = bush('bush_a', seed=1)
    kit['bush_b'] = bush('bush_b', seed=2, r=0.7, blobs=3, mat='leaves')
    kit['hedge'] = hedge()
    kit['flower_bed'] = flower_bed()
    kit['flower_patch'] = flower_patch()
    kit['flower_patch_b'] = flower_patch('flower_patch_b', seed=2, colors=('flower_pink', 'flower_red', 'flower_white'))
    kit['grass_tall'] = grass_clump('grass_tall', seed=1)
    kit['grass_tall_b'] = grass_clump('grass_tall_b', seed=2, blades=30)
    kit['grass_short'] = grass_clump('grass_short', seed=3, blades=22, hmin=0.18, hmax=0.4, spread=0.35, width=0.035)
    kit['rock'] = rock('rock', seed=1)
    return kit
