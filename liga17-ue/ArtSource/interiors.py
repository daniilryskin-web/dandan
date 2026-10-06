"""Interiors you can walk into: the hero's house, Professor Oak's lab, the Poké Center and the Poké Mart.

Each builder returns (object, meta). The room is centred on its origin with the floor at z = 0 and the entrance in the
south wall (-Y). meta holds points in the room's own coordinates (metres): where the player appears when entering
('spawn', with a facing angle), the exit door ('exit'), ceiling lights ('lights': x, y, z, intensity in candela),
NPC spots ('npcs': id -> (x, y, facing)) and other interaction points ('spots').
town.py places the rooms far below the map and turns these into layout.json markers.
"""
import math
import random

from mathutils import Matrix, Vector

from common import MB

T_WALL = 0.25


def at(x, y, rz=0.0, z=0.0):
    return Matrix.Translation(Vector((x, y, z))) @ Matrix.Rotation(rz, 4, 'Z')


def tb(mb, mat, T, c, s):
    """Box in the local space of T (centre c, size s)."""
    mb.box(mat, None, s, m=T @ Matrix.Translation(Vector(c)))


def face(mb, mat, pts, normal, fit=True):
    """A quad that faces `normal` whatever the order of the points."""
    p = [Vector(v) for v in pts]
    n = (p[1] - p[0]).cross(p[2] - p[0])
    if n.dot(Vector(normal)) < 0:
        p.reverse()
    return mb.face(mat, [tuple(v) for v in p], fit=fit)


def front_of(rz):
    """Direction a piece of furniture faces (its local -Y) after a rotation rz."""
    return Vector((math.sin(rz), -math.cos(rz), 0.0))


# ——— furniture (front = local -Y, pivot on the floor) ———

def table(mb, T, w=1.6, d=0.9, h=0.76, top='wood_brown', legs='wood_brown'):
    tb(mb, top, T, (0, 0, h - 0.03), (w, d, 0.06))
    for sx in (-1, 1):
        for sy in (-1, 1):
            tb(mb, legs, T, (sx * (w / 2 - 0.09), sy * (d / 2 - 0.09), (h - 0.06) / 2), (0.07, 0.07, h - 0.06))


def chair(mb, T, mat='wood_brown', seat=None):
    tb(mb, seat or mat, T, (0, 0, 0.45), (0.46, 0.46, 0.05))
    for sx in (-1, 1):
        for sy in (-1, 1):
            tb(mb, mat, T, (sx * 0.19, sy * 0.19, 0.21), (0.05, 0.05, 0.43))
    tb(mb, mat, T, (0, 0.21, 0.72), (0.46, 0.05, 0.5))


def sofa(mb, T, w=2.0, mat='cushion_blue'):
    tb(mb, 'wood_brown', T, (0, 0, 0.06), (w, 0.82, 0.12))
    tb(mb, mat, T, (0, -0.02, 0.27), (w - 0.3, 0.74, 0.3))
    tb(mb, mat, T, (0, 0.3, 0.62), (w, 0.22, 0.56))
    for sx in (-1, 1):
        tb(mb, mat, T, (sx * (w / 2 - 0.12), 0, 0.36), (0.24, 0.84, 0.5))


def shelf(mb, T, w=1.8, h=2.1, d=0.4, frame='wood_brown', fill='books', rows=4):
    tb(mb, frame, T, (0, d / 2 - 0.02, h / 2), (w, 0.04, h))
    for sx in (-1, 1):
        tb(mb, frame, T, (sx * (w / 2 - 0.025), 0, h / 2), (0.05, d, h))
    rh = (h - 0.1) / rows
    for i in range(rows + 1):
        tb(mb, frame, T, (0, 0, 0.05 + i * rh), (w, d, 0.04))
    rnd = random.Random(int(w * 100 + h * 10))
    for i in range(rows):
        z0 = 0.07 + i * rh
        fh = rh * rnd.uniform(0.62, 0.82)
        fw = (w - 0.12) * rnd.uniform(0.7, 0.98)
        tb(mb, fill, T, (rnd.uniform(-1, 1) * (w - 0.12 - fw) / 2, 0.02, z0 + fh / 2), (fw, d - 0.1, fh))


def tv(mb, T):
    tb(mb, 'wood_brown', T, (0, 0, 0.25), (1.6, 0.45, 0.5))
    tb(mb, 'metal_dark', T, (0, 0.05, 0.53), (0.4, 0.2, 0.06))
    tb(mb, 'metal_dark', T, (0, 0.05, 0.96), (1.3, 0.07, 0.78))
    p = [T @ Vector(v) for v in ((-0.6, -0.0, 0.62), (0.6, -0.0, 0.62), (0.6, -0.0, 1.3), (-0.6, -0.0, 1.3))]
    face(mb, 'screen', p, T.to_3x3() @ Vector((0, -1, 0)))


def plant(mb, T, s=1.0, seed=1):
    mb.cyl('red_paint', None, 0.22 * s, 0.42 * s, seg=14, r2=0.27 * s, m=T)
    mb.cyl('dirt', None, 0.25 * s, 0.02, seg=14, m=T @ Matrix.Translation(Vector((0, 0, 0.4 * s))))
    rnd = random.Random(seed)
    for i in range(4):
        a = i / 4 * math.tau + rnd.uniform(-0.4, 0.4)
        c = T @ Vector((math.cos(a) * 0.16 * s, math.sin(a) * 0.16 * s, (0.75 + rnd.uniform(0, 0.35)) * s))
        mb.sphere('leaves', c, 0.28 * s, subdiv=2, scale=(1, 1, 1.15), displace=0.18, seed=seed * 5 + i, freq=1.8)


def rug(mb, T, w, d, mat):
    tb(mb, mat, T, (0, 0, 0.01), (w, d, 0.02))


def decal_floor(mb, mat, T, w, d, z=0.025):
    p = [T @ Vector(v) for v in ((-w / 2, -d / 2, z), (w / 2, -d / 2, z), (w / 2, d / 2, z), (-w / 2, d / 2, z))]
    face(mb, mat, p, (0, 0, 1))


def kitchen(mb, T, w=3.6):
    """Counter with a sink and wall cupboards; the back rests against a wall (local +Y)."""
    tb(mb, 'wood_white', T, (0, 0, 0.44), (w, 0.6, 0.88))
    tb(mb, 'stone', T, (0, -0.02, 0.905), (w + 0.04, 0.64, 0.05))
    tb(mb, 'metal_white', T, (w * 0.18, -0.04, 0.9), (0.6, 0.42, 0.04))
    mb.cyl('metal_white', None, 0.025, 0.3, seg=8, m=T @ Matrix.Translation(Vector((w * 0.18, 0.2, 0.93))))
    tb(mb, 'wood_white', T, (0, 0.13, 1.85), (w, 0.34, 0.72))
    for i in range(int(w // 0.6)):
        x = -w / 2 + 0.3 + i * 0.6
        tb(mb, 'metal_dark', T, (x, -0.31, 0.78), (0.16, 0.02, 0.03))
        tb(mb, 'metal_dark', T, (x, -0.05, 1.56), (0.16, 0.02, 0.03))
    # fridge at the left end
    tb(mb, 'metal_white', T, (-w / 2 - 0.42, -0.05, 0.95), (0.8, 0.7, 1.9))
    tb(mb, 'metal_dark', T, (-w / 2 - 0.12, -0.41, 1.2), (0.04, 0.03, 0.5))


def lab_table(mb, T, w=2.8, d=1.1):
    table(mb, T, w, d, 0.92, top='metal_white', legs='metal_dark')
    for i, x in enumerate((-0.7, 0.0, 0.7)):
        pokeball(mb, T @ Vector((x, 0.0, 0.92 + 0.13)), 0.13, T)


def pokeball(mb, c, r, T=None):
    vs = mb.sphere('pokeball_red', c, r, subdiv=2)
    white = mb.mi('metal_white')
    for f in {f for v in vs for f in v.link_faces}:
        if f.calc_center_median().z < c[2]:
            f.material_index = white
    mb.cyl('metal_dark', (c[0], c[1], c[2] - r * 0.07), r * 1.02, r * 0.14, seg=20)
    d = (T.to_3x3() if T is not None else Matrix.Identity(3)) @ Vector((0, -1, 0))
    mb.cyl('metal_white', None, r * 0.25, r * 0.12, seg=12,
           m=Matrix.Translation(Vector(c) + d * r * 0.95) @ d.to_track_quat('Z', 'Y').to_matrix().to_4x4())


def machine(mb, T, w=1.2, h=1.9, d=0.7, body='metal_white'):
    tb(mb, body, T, (0, 0, h / 2), (w, d, h))
    tb(mb, 'metal_dark', T, (0, -d / 2 - 0.01, h * 0.7), (w * 0.78, 0.02, h * 0.36))
    p = [T @ Vector(v) for v in ((-w * 0.36, -d / 2 - 0.025, h * 0.55), (w * 0.36, -d / 2 - 0.025, h * 0.55),
                                 (w * 0.36, -d / 2 - 0.025, h * 0.85), (-w * 0.36, -d / 2 - 0.025, h * 0.85))]
    face(mb, 'screen', p, T.to_3x3() @ Vector((0, -1, 0)))
    for i in range(4):
        tb(mb, 'red_paint' if i % 2 else 'lamp_glow', T, (-w * 0.3 + i * w * 0.2, -d / 2 - 0.02, h * 0.38), (0.1, 0.04, 0.1))


def desk_pc(mb, T, w=1.4):
    table(mb, T, w, 0.7, 0.76, top='wood_white', legs='metal_dark')
    tb(mb, 'metal_dark', T, (0, 0.12, 0.85), (0.14, 0.12, 0.16))
    tb(mb, 'metal_dark', T, (0, 0.12, 1.12), (0.75, 0.06, 0.48))
    p = [T @ Vector(v) for v in ((-0.33, 0.085, 0.92), (0.33, 0.085, 0.92), (0.33, 0.085, 1.32), (-0.33, 0.085, 1.32))]
    face(mb, 'screen', p, T.to_3x3() @ Vector((0, -1, 0)))
    tb(mb, 'metal_dark', T, (0, -0.15, 0.77), (0.6, 0.18, 0.02))
    chair(mb, T @ at(0, -0.55, math.pi), mat='metal_dark', seat='cushion_blue')


def counter(mb, T, w, mat='counter_pink', top='metal_white', d=0.7):
    tb(mb, mat, T, (0, 0, 0.5), (w, d, 1.0))
    tb(mb, top, T, (0, -0.03, 1.03), (w + 0.1, d + 0.12, 0.06))


def heal_machine(mb, T):
    tb(mb, 'metal_white', T, (0, 0, 0.5), (1.5, 0.6, 1.0))
    tb(mb, 'counter_pink', T, (0, -0.02, 1.02), (1.4, 0.5, 0.04))
    for i in range(6):
        x = -0.4 + (i % 3) * 0.4
        y = -0.1 + (i // 3) * 0.2
        pokeball(mb, T @ Vector((x, y, 1.12)), 0.075, T)
    tb(mb, 'metal_white', T, (0, 0.22, 1.5), (1.5, 0.14, 0.95))
    p = [T @ Vector(v) for v in ((-0.6, 0.145, 1.2), (0.6, 0.145, 1.2), (0.6, 0.145, 1.85), (-0.6, 0.145, 1.85))]
    face(mb, 'screen', p, T.to_3x3() @ Vector((0, -1, 0)))


def mart_shelf(mb, T, w=4.0, h=1.6, d=0.9, double=True):
    tb(mb, 'metal_white', T, (0, 0, h / 2), (w, 0.06, h))
    for sx in (-1, 1):
        tb(mb, 'metal_white', T, (sx * (w / 2 - 0.03), 0, h / 2), (0.06, d, h))
    rows = 4
    rh = (h - 0.08) / rows
    sides = (-1, 1) if double else (-1,)
    for i in range(rows + 1):
        tb(mb, 'metal_white', T, (0, 0, 0.06 + i * rh), (w, d, 0.04))
    for i in range(rows):
        for sy in sides:
            tb(mb, 'goods', T, (0, sy * d / 4, 0.08 + i * rh + rh * 0.36), (w - 0.14, d / 2 - 0.1, rh * 0.68))


def fridge(mb, T, w=1.6, h=2.0, d=0.7):
    tb(mb, 'metal_white', T, (0, 0, h / 2), (w, d, h))
    tb(mb, 'goods', T, (0, -d / 2 + 0.02, h * 0.52), (w - 0.2, 0.06, h * 0.78))
    for sx in (-1, 0, 1):
        tb(mb, 'metal_white', T, (sx * (w / 2 - 0.05), -d / 2 - 0.02, h * 0.52), (0.08, 0.04, h * 0.8))
    tb(mb, 'lamp_glow', T, (0, -d / 2 - 0.02, h - 0.12), (w - 0.2, 0.04, 0.1))


def register(mb, T):
    tb(mb, 'metal_dark', T, (0, 0, 0.1), (0.45, 0.4, 0.2))
    tb(mb, 'metal_dark', T, (0, 0.1, 0.32), (0.4, 0.06, 0.26))
    p = [T @ Vector(v) for v in ((-0.16, 0.065, 0.24), (0.16, 0.065, 0.24), (0.16, 0.065, 0.42), (-0.16, 0.065, 0.42))]
    face(mb, 'screen', p, T.to_3x3() @ Vector((0, -1, 0)))


# ——— rooms ———

class Room:
    """Walls, floor and ceiling around the origin; entrance in the south wall at x = door_x."""

    def __init__(self, W, D, H, floor, wall, door_x=0.0, double_door=False):
        self.mb = MB()
        self.W, self.D, self.H = W, D, H
        self.door_x = door_x
        mb = self.mb
        t = T_WALL
        mb.box(floor, (0, 0, -0.15), (W, D, 0.3))
        mb.box(wall, (0, D / 2 + t / 2, (H - 0.3) / 2), (W + 2 * t, t, H + 0.3))
        mb.box(wall, (0, -D / 2 - t / 2, (H - 0.3) / 2), (W + 2 * t, t, H + 0.3))
        mb.box(wall, (W / 2 + t / 2, 0, (H - 0.3) / 2), (t, D, H + 0.3))
        mb.box(wall, (-W / 2 - t / 2, 0, (H - 0.3) / 2), (t, D, H + 0.3))
        mb.box('wall_white', (0, 0, H + 0.1), (W + 2 * t, D + 2 * t, 0.2))
        # skirting boards and a cornice
        for sy in (-1, 1):
            mb.box('wood_white', (0, sy * (D / 2 - 0.02), 0.06), (W, 0.04, 0.12))
            mb.box('wood_white', (0, sy * (D / 2 - 0.03), H - 0.05), (W, 0.06, 0.1))
        for sx in (-1, 1):
            mb.box('wood_white', (sx * (W / 2 - 0.02), 0, 0.06), (0.04, D, 0.12))
            mb.box('wood_white', (sx * (W / 2 - 0.03), 0, H - 0.05), (0.06, D, 0.1))
        # the door back outside, with a mat in front of it
        dw = 2.2 if double_door else 1.2
        y = -D / 2 + 0.03
        mb.box('wood_white', (door_x, y + 0.02, 2.3), (dw + 0.3, 0.08, 0.14))
        for sx in (-1, 1):
            mb.box('wood_white', (door_x + sx * (dw / 2 + 0.07), y + 0.02, 1.15), (0.14, 0.08, 2.3))
        if double_door:
            for sx in (-1, 1):
                mb.box('metal_white', (door_x + sx * dw / 4, y, 1.15), (dw / 2 - 0.02, 0.05, 2.3))
                mb.box('glass', (door_x + sx * dw / 4, y + 0.03, 1.35), (dw / 2 - 0.3, 0.02, 1.4))
        else:
            mb.box('wood_brown', (door_x, y, 1.15), (dw, 0.05, 2.3))
            mb.sphere('metal_white', (door_x + dw * 0.36, y + 0.06, 1.05), 0.05, subdiv=1)
        mb.box('carpet_red', (door_x, -D / 2 + 0.55, 0.01), (dw + 0.4, 0.9, 0.02))
        self.meta = {
            'spawn': (door_x, -D / 2 + 1.5, math.pi / 2),
            'exit': (door_x, -D / 2 + 0.35),
            'lights': [],
            'npcs': {},
            'spots': {},
        }

    def wall_frame(self, side):
        """Matrix for (u, w, z) on a wall: w points into the room, u along the wall."""
        W, D = self.W, self.D
        if side == 'north':
            return Matrix(((-1, 0, 0, 0), (0, -1, 0, D / 2), (0, 0, 1, 0), (0, 0, 0, 1)))
        if side == 'south':
            return Matrix(((1, 0, 0, 0), (0, 1, 0, -D / 2), (0, 0, 1, 0), (0, 0, 0, 1)))
        if side == 'east':
            return Matrix(((0, -1, 0, W / 2), (1, 0, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1)))
        return Matrix(((0, 1, 0, -W / 2), (-1, 0, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1)))

    def wall_quad(self, side, mat, u, z, w, h, depth=0.012):
        M = self.wall_frame(side)
        p = [M @ Vector(v) for v in ((u - w / 2, depth, z), (u + w / 2, depth, z), (u + w / 2, depth, z + h), (u - w / 2, depth, z + h))]
        face(self.mb, mat, p, M.to_3x3() @ Vector((0, 1, 0)))

    def window(self, side, u, z=1.0, w=1.4, h=1.3):
        """Bright 'daylight' pane with a white frame and a sill."""
        mb = self.mb
        M = self.wall_frame(side)
        self.wall_quad(side, 'window_day', u, z, w, h, 0.015)
        t = 0.09
        for c, s in (((u, 0.04, z + h + t / 2), (w + 2 * t, 0.08, t)), ((u, 0.04, z - t / 2), (w + 2 * t, 0.08, t)),
                     ((u - w / 2 - t / 2, 0.04, z + h / 2), (t, 0.08, h)), ((u + w / 2 + t / 2, 0.04, z + h / 2), (t, 0.08, h)),
                     ((u, 0.04, z + h / 2), (0.05, 0.06, h)), ((u, 0.1, z - t - 0.03), (w + 0.4, 0.2, 0.06))):
            tb(mb, 'wood_white', M, c, s)

    def poster(self, side, u, z=1.2, w=0.9, h=1.2):
        M = self.wall_frame(side)
        tb(self.mb, 'wood_brown', M, (u, 0.015, z + h / 2), (w + 0.1, 0.03, h + 0.1))
        self.wall_quad(side, 'poster_kanto', u, z, w, h, 0.035)

    def lamp(self, x, y, intensity=55.0):
        mb = self.mb
        H = self.H
        mb.cyl('metal_white', (x, y, H - 0.1), 0.42, 0.1, seg=20)
        mb.cyl('lamp_glow', (x, y, H - 0.13), 0.36, 0.04, seg=20)
        self.meta['lights'].append((x, y, H - 0.45, intensity))

    def build(self, name):
        obj = self.mb.build(name, bevel=0.0)
        return obj, self.meta


def home(name='int_home'):
    R = Room(12.0, 9.0, 3.2, 'floor_wood', 'wall_inner', door_x=-2.0)
    mb, W, D = R.mb, R.W, R.D
    kitchen(mb, at(-3.2, D / 2 - 0.32), 3.6)
    table(mb, at(-3.0, 0.6), 1.6, 0.9)
    for x in (-3.45, -2.55):
        chair(mb, at(x, 0.0, math.pi))
        chair(mb, at(x, 1.2, 0.0))
    rug(mb, at(3.2, 1.6), 3.4, 2.4, 'carpet_green')
    tv(mb, at(3.2, D / 2 - 0.28))
    sofa(mb, at(3.2, 0.2, math.pi), 2.2)
    shelf(mb, at(W / 2 - 0.22, -2.0, -math.pi / 2), 1.6, 2.0)
    table(mb, at(3.2, 1.55), 1.0, 0.5, 0.42, top='wood_white')
    for (x, y, s) in ((W / 2 - 0.45, -D / 2 + 0.45, 1.0), (-W / 2 + 0.45, -D / 2 + 0.45, 0.9), (W / 2 - 0.45, D / 2 - 0.45, 0.8)):
        plant(mb, at(x, y), s, seed=int(x * 7 + y))
    R.window('south', 1.4)
    R.window('south', 4.2)
    R.window('south', -4.6)
    R.window('east', 1.8)
    R.window('west', -0.8)
    R.poster('east', -0.9 + 0.0, 1.3, 0.8, 1.0)
    # a closed door to the upstairs rooms on the west wall
    M = R.wall_frame('west')
    tb(mb, 'wood_brown', M, (2.6, 0.03, 1.15), (1.0, 0.05, 2.3))
    tb(mb, 'wood_white', M, (2.6, 0.05, 2.36), (1.3, 0.08, 0.12))
    for lx, ly in ((-3.0, 0.8), (3.2, 1.2), (-1.5, -2.6)):
        R.lamp(lx, ly, 50.0)
    R.meta['npcs']['mom'] = (-1.3, 2.4, -math.pi / 2)
    R.meta['start'] = (0.6, 1.4, math.pi)
    return R.build(name)


def lab(name='int_lab'):
    R = Room(16.0, 12.0, 3.6, 'floor_lab', 'wall_lab', door_x=0.0, double_door=True)
    mb, W, D = R.mb, R.W, R.D
    for x in (-5.4, -3.9, 3.9, 5.4):
        machine(mb, at(x, D / 2 - 0.4), 1.3, 2.0)
    for y in (2.0, -1.4):
        desk_pc(mb, at(-W / 2 + 0.5, y, math.pi / 2))
    for y in (-3.6, -1.2, 1.2, 3.6):
        shelf(mb, at(W / 2 - 0.22, y, -math.pi / 2), 2.2, 2.4)
    lab_table(mb, at(0.0, 1.4), 2.8, 1.1)
    rug(mb, at(0.0, -1.6), 3.0, 4.2, 'carpet_red')
    for (x, y) in ((-W / 2 + 0.6, -D / 2 + 0.6), (W / 2 - 0.6, -D / 2 + 0.6), (-1.6, D / 2 - 0.5), (1.6, D / 2 - 0.5)):
        plant(mb, at(x, y), 1.0, seed=int(x * 3 + y * 5))
    R.poster('north', 0.0, 1.3, 1.0, 1.3)
    for u in (-4.5, 4.5):
        R.window('south', u, 1.1, 2.0, 1.5)
    R.window('west', -4.6, 1.2, 1.6, 1.4)
    R.window('west', 4.6, 1.2, 1.6, 1.4)
    for lx, ly in ((-4.0, 2.4), (4.0, 2.4), (-4.0, -3.0), (4.0, -3.0), (0.0, 0.0)):
        R.lamp(lx, ly, 60.0)
    R.meta['npcs']['oak'] = (0.0, 2.7, -math.pi / 2)
    R.meta['npcs']['aide'] = (-5.7, 0.3, math.pi)
    return R.build(name)


def center(name='int_center'):
    R = Room(14.0, 11.0, 3.6, 'floor_tile', 'wall_pink', door_x=0.0, double_door=True)
    mb, W, D = R.mb, R.W, R.D
    yc = D / 2 - 2.2
    counter(mb, at(0.0, yc), 5.0)
    for sx in (-1, 1):  # the counter wraps round to the back wall so the nurse's side stays closed
        tb(mb, 'counter_pink', at(sx * 2.85, (yc + D / 2) / 2 + 0.2), (0, 0, 0.5), (0.7, D / 2 - yc - 0.4, 1.0))
        tb(mb, 'metal_white', at(sx * 2.85, (yc + D / 2) / 2 + 0.2), (0, 0, 1.03), (0.8, D / 2 - yc - 0.3, 0.06))
    heal_machine(mb, at(1.4, D / 2 - 0.45))
    shelf(mb, at(-1.5, D / 2 - 0.22), 1.6, 1.9, fill='goods', rows=3)
    decal_floor(mb, 'rug_ball', at(0.0, -1.0), 3.4, 3.4)
    desk_pc(mb, at(W / 2 - 0.5, 1.4, -math.pi / 2), 1.4)
    for y in (-1.2, 1.6):
        sofa(mb, at(-W / 2 + 0.6, y, math.pi / 2), 2.0, 'carpet_red')
    table(mb, at(-W / 2 + 1.9, 0.2), 0.6, 1.2, 0.42, top='wood_white')
    for (x, y) in ((-W / 2 + 0.5, -D / 2 + 0.5), (W / 2 - 0.5, -D / 2 + 0.5), (-W / 2 + 0.5, D / 2 - 0.5), (W / 2 - 0.5, D / 2 - 0.5)):
        plant(mb, at(x, y), 1.0, seed=int(x * 5 - y))
    for u in (-4.0, 4.0):
        R.window('south', u, 1.0, 2.2, 1.6)
    R.window('west', -3.5, 1.1, 1.6, 1.4)
    R.poster('east', 2.6, 1.2, 0.9, 1.2)
    for lx, ly in ((-3.5, 2.0), (3.5, 2.0), (-3.5, -2.6), (3.5, -2.6), (0.0, 0.5)):
        R.lamp(lx, ly, 60.0)
    R.meta['npcs']['nurse'] = (0.0, D / 2 - 1.2, -math.pi / 2)
    R.meta['npcs']['visitor'] = (-3.6, -3.0, math.pi / 2)
    R.meta['spots']['pc'] = (W / 2 - 1.35, 1.4)
    return R.build(name)


def mart(name='int_mart'):
    R = Room(11.0, 9.0, 3.4, 'floor_lab', 'wall_inner', door_x=-3.0)
    mb, W, D = R.mb, R.W, R.D
    cx, cy = -W / 2 + 1.7, 0.9
    counter(mb, at(cx, cy, math.pi / 2), 3.0, mat='wood_blue')
    for sy in (-1, 1):
        tb(mb, 'wood_blue', at(-W / 2 + 0.85, cy + sy * 1.65), (0, 0, 0.5), (1.4, 0.3, 1.0))
        tb(mb, 'metal_white', at(-W / 2 + 0.85, cy + sy * 1.65), (0, 0, 1.03), (1.5, 0.4, 0.06))
    register(mb, at(cx, cy + 0.6, math.pi / 2) @ Matrix.Translation(Vector((0, 0, 1.06))))
    for x in (0.8, 3.6):
        mart_shelf(mb, at(x, 0.4, math.pi / 2), 4.0, 1.6)
    mart_shelf(mb, at(1.9, D / 2 - 0.3), 6.4, 2.0, 0.5, double=False)
    fridge(mb, at(W / 2 - 0.4, -2.4, -math.pi / 2), 1.8)
    plant(mb, at(-W / 2 + 0.5, -D / 2 + 0.5), 0.9, seed=3)
    R.window('south', 1.2, 1.0, 2.0, 1.5)
    R.window('south', 4.0, 1.0, 1.4, 1.5)
    R.window('east', 1.5, 1.1, 1.6, 1.3)
    for lx, ly in ((-3.2, 0.9), (2.2, 1.5), (2.2, -2.6), (-2.6, -2.8)):
        R.lamp(lx, ly, 50.0)
    R.meta['npcs']['clerk'] = (-W / 2 + 0.65, cy, 0.0)
    R.meta['npcs']['shopper'] = (2.2, -0.6, 0.0)
    return R.build(name)


def build_interiors():
    return {'home': home(), 'lab': lab(), 'center': center(), 'mart': mart()}
