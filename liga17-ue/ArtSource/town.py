"""Assembles Pallet Town + the start of Route 1, renders previews and exports everything for Unreal.

    python town.py [--render] [--export] [--quick]

Outputs (ArtSource/Exports):
  PalletTown.glb      - terrain, water, buildings, props and town trees as a glTF scene (instanced meshes)
  Kit/<asset>.glb     - every kit asset on its own (used by the game for instanced foliage)
  layout.json         - markers, encounter zones and scattered foliage instances (Blender coordinates, metres)
"""
import json
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402  (must come before bmesh)
import bmesh  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402

import assets  # noqa: E402
import interiors  # noqa: E402
import render  # noqa: E402
from common import HERE, MB, clear_scene, get_mat, instance, load_image, tex_path  # noqa: E402

ARGS = set(sys.argv[1:])
QUICK = '--quick' in ARGS
OUTDIR = os.path.join(HERE, 'Exports')
SHOTS = os.environ.get('SHOTS', os.path.join(HERE, 'Previews'))
os.makedirs(os.path.join(OUTDIR, 'Kit'), exist_ok=True)
os.makedirs(SHOTS, exist_ok=True)

# ——— world shape ———
X0, X1, Y0, Y1 = -110.0, 110.0, -95.0, 150.0
PLATEAU = (-38.0, 38.0, -36.0, 46.0)  # flat town area
ROUTE = (-15.0, 15.0)  # Route 1 valley (x range) north of the town
SEA_LEVEL = -0.9

R = random.Random(17)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def value_noise(x, y, scale, seed):
    """Cheap smooth noise for numpy arrays (sum of sines with random phases)."""
    rs = np.random.default_rng(seed)
    out = np.zeros_like(x)
    for k in range(6):
        a = rs.uniform(0, math.tau)
        f = (1.3 ** k) / scale
        px = rs.uniform(0, math.tau)
        out += np.sin((x * math.cos(a) + y * math.sin(a)) * f + px) / (1.25 ** k)
    return out / 3.0


def height(x, y):
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    # distance to the nearest walkable area: the town plateau or the Route 1 valley to the north
    d_plateau = np.maximum(np.maximum(PLATEAU[0] - x, x - PLATEAU[1]), y - PLATEAU[3])
    d_route = np.where(y >= PLATEAU[3] - 8, np.abs(x - route_wiggle(y) * 0.6) - ROUTE[1], 1e6)
    d = np.minimum(d_plateau, d_route)
    hills = smoothstep(0, 34, d) * (9.0 + 5.0 * value_noise(x, y, 18, 3)) + smoothstep(0, 8, d) * 1.0
    base = 0.05 * value_noise(x, y, 6, 1)
    h = base + np.where(d > 0, hills, 0)
    # beach and sea to the south
    south = PLATEAU[2] - y
    beach = np.clip(south, 0, None)
    h = np.where(south > 0, base - beach * 0.09 - smoothstep(6, 30, beach) * 1.6 + np.where(np.abs(x) > 60, smoothstep(60, 90, np.abs(x)) * 6, 0), h)
    return h


# ——— layout: buildings and paths (Blender coordinates, metres; buildings face -Y unless rotated) ———
BUILDINGS = [
    # name, kit, x, y, rot, footprint (w, d) for exclusion
    ('PlayerHouse', 'house_player', -13.0, 15.0, 0.0, (11, 10)),
    ('RivalHouse', 'house_rival', 13.0, 15.0, 0.0, (13, 11)),
    ('OakLab', 'oak_lab', 9.0, -17.0, math.pi, (24, 14)),
    ('NeighbourHouse', 'house_small', -15.0, -17.0, math.pi, (9, 8)),
    ('PokeCenter', 'pokecenter', -29.0, -4.0, math.pi / 2, (13, 13)),
    ('PokeMart', 'mart', 28.5, -4.0, -math.pi / 2, (11, 11)),
]


def front_point(name, dist):
    """A point `dist` metres in front of a building's facade centre."""
    _, kit, x, y, rz, _ = next(b for b in BUILDINGS if b[0] == name)
    depth = {'pokecenter': 10.0, 'mart': 8.0}[kit]
    ly = -depth / 2 - dist
    return (round(x - ly * math.sin(rz), 3), round(y + ly * math.cos(rz), 3))


DOORS = {
    'PlayerHouse': (-14.62, 9.4),
    'RivalHouse': (11.38, 9.4),
    'RivalTower': (17.2, 8.9),
    'OakLab': (9.0, -9.6),
    'NeighbourHouse': (-13.74, -12.3),
    'PokeCenter': front_point('PokeCenter', 2.2),
    'PokeMart': front_point('PokeMart', 2.2),
}
ROAD_W = 2.6
PIER = (-6.0, -37.0, 20.0)  # x, y of the shore end, length (it runs south over the water)

# Rooms you can enter: far below the map, out of sight. door = the building door outside, out = where you appear outside.
INTERIOR_Z = -30.0
ROOMS = {
    'home': {'name': 'Дом героя', 'at': (200.0, 0.0), 'door': 'PlayerHouse', 'out_face': -math.pi / 2},
    'lab': {'name': 'Лаборатория Оука', 'at': (240.0, 0.0), 'door': 'OakLab', 'out_face': math.pi / 2},
    'center': {'name': 'Покецентр', 'at': (280.0, 0.0), 'door': 'PokeCenter', 'out_face': 0.0},
    'mart': {'name': 'Магазин', 'at': (320.0, 0.0), 'door': 'PokeMart', 'out_face': math.pi},
}


def path_segments():
    segs = [((0.0, -40.0), (0.0, 150.0), ROAD_W)]
    for k in ('PlayerHouse', 'RivalHouse', 'OakLab', 'NeighbourHouse'):
        x, y = DOORS[k]
        segs.append(((x, y), (x, 3.0 if y > 0 else -4.0), 1.3))
        segs.append(((x, 3.0 if y > 0 else -4.0), (0.0, 3.0 if y > 0 else -4.0), 1.3))
    segs.append((DOORS['RivalTower'], (DOORS['RivalTower'][0], 3.0), 1.0))
    for k in ('PokeCenter', 'PokeMart'):  # wide streets to the two shops
        segs.append((DOORS[k], (0.0, DOORS[k][1]), 1.8))
    segs.append(((PIER[0], PIER[1] + 1.0), (PIER[0], -33.0), 1.2))
    segs.append(((PIER[0], -33.0), (0.0, -33.0), 1.2))
    return segs


def seg_dist(px, py, a, b):
    ax, ay = a
    bx, by = b
    vx, vy = bx - ax, by - ay
    L2 = vx * vx + vy * vy
    t = np.clip(((px - ax) * vx + (py - ay) * vy) / max(L2, 1e-9), 0, 1)
    cx, cy = ax + t * vx, ay + t * vy
    return np.hypot(px - cx, py - cy)


def route_wiggle(y):
    return np.where(y > 46, np.sin((y - 46) / 14.0) * 3.0, 0.0)


def path_mask(x, y):
    m = np.zeros_like(np.asarray(x, dtype=np.float64))
    for a, b, w in path_segments():
        xx = x - (route_wiggle(y) if a[0] == 0.0 and b[1] > 100 else 0)
        d = seg_dist(xx, y, a, b)
        edge = w + 0.6 * value_noise(x, y, 2.5, 9)
        m = np.maximum(m, 1 - smoothstep(edge - 0.8, edge + 0.4, d))
    # plaza in the middle of town
    d = np.hypot(x - 0.0, y + 0.5) - (6.0 + 0.5 * value_noise(x, y, 2, 4))
    m = np.maximum(m, 1 - smoothstep(-0.6, 0.6, d))
    return np.clip(m, 0, 1)


def sand_mask(x, y):
    return smoothstep(PLATEAU[2] + 2, PLATEAU[2] - 5, y + 0.8 * value_noise(x, y, 4, 5))


def in_building(x, y, pad=0.0):
    for _, _, bx, by, rot, (w, d) in BUILDINGS:
        if abs(x - bx) < w / 2 + pad and abs(y - by) < d / 2 + pad:
            return True
    return False


# Wild Pokémon areas: tall grass on Route 1 and at the forest edge, the surf along the beach and the pier.
ZONES = [
    {'x0': -12.0, 'x1': -4.5, 'y0': 54.0, 'y1': 78.0, 'kind': 'tall_grass', 'route': 'route1', 'place': 'Маршрут 1', 'pad': 3.5, 'wiggle': True},
    {'x0': 4.5, 'x1': 12.5, 'y0': 62.0, 'y1': 92.0, 'kind': 'tall_grass', 'route': 'route1', 'place': 'Маршрут 1', 'pad': 3.5, 'wiggle': True},
    {'x0': -11.0, 'x1': -3.5, 'y0': 98.0, 'y1': 128.0, 'kind': 'tall_grass', 'route': 'route1_north', 'place': 'Маршрут 1', 'pad': 3.5, 'wiggle': True},
    {'x0': 5.0, 'x1': 12.0, 'y0': 112.0, 'y1': 140.0, 'kind': 'tall_grass', 'route': 'route1_north', 'place': 'Маршрут 1', 'pad': 3.5, 'wiggle': True},
    {'x0': -35.0, 'x1': -25.5, 'y0': 27.0, 'y1': 41.0, 'kind': 'tall_grass', 'route': 'forest', 'place': 'Опушка леса', 'pad': 0.6},
    {'x0': -46.0, 'x1': 46.0, 'y0': -48.0, 'y1': -40.5, 'kind': 'shore', 'route': 'shore', 'place': 'Берег Паллет-тауна', 'pad': 0.3},
    {'x0': PIER[0] - 1.6, 'x1': PIER[0] + 1.6, 'y0': PIER[1] - PIER[2], 'y1': -40.5, 'kind': 'shore', 'route': 'shore', 'place': 'Пристань', 'pad': 0.3},
]


def in_grass_zone(x, y, pad=0.0):
    return any(z['kind'] == 'tall_grass' and not z.get('wiggle') and z['x0'] - pad < x < z['x1'] + pad and z['y0'] - pad < y < z['y1'] + pad
               for z in ZONES)


# ——— terrain ———

def build_terrain(step=1.0):
    nx = int((X1 - X0) / step) + 1
    ny = int((Y1 - Y0) / step) + 1
    xs = np.linspace(X0, X1, nx)
    ys = np.linspace(Y0, Y1, ny)
    gx, gy = np.meshgrid(xs, ys)
    gz = height(gx, gy)
    pm = path_mask(gx, gy)
    sm = sand_mask(gx, gy)
    bm = bmesh.new()
    verts = [bm.verts.new((float(gx[j, i]), float(gy[j, i]), float(gz[j, i]))) for j in range(ny) for i in range(nx)]
    bm.verts.ensure_lookup_table()
    bm.verts.index_update()  # new verts have index -1 until this runs
    col = bm.loops.layers.color.new('Col')
    uv = bm.loops.layers.uv.new('UVMap')
    for j in range(ny - 1):
        for i in range(nx - 1):
            a = j * nx + i
            f = bm.faces.new((verts[a], verts[a + 1], verts[a + nx + 1], verts[a + nx]))
            for l in f.loops:
                vi = l.vert.index
                jj, ii = divmod(vi, nx)
                l[col] = (float(pm[jj, ii]), float(sm[jj, ii]), 0.0, 1.0)
                l[uv].uv = (l.vert.co.x / 5.0, l.vert.co.y / 5.0)
    me = bpy.data.meshes.new('Terrain')
    bm.to_mesh(me)
    bm.free()
    # Make 'Col' the active/render colour. Otherwise the glTF exporter writes a white placeholder
    # as COLOR_0 (the only set Unreal reads) and the masks as COLOR_1, and the whole ground turns to sand.
    me.color_attributes.active_color = me.color_attributes['Col']
    me.color_attributes.render_color_index = me.color_attributes.active_color_index
    for p in me.polygons:
        p.use_smooth = True
    me.materials.append(terrain_material())
    o = bpy.data.objects.new('Terrain', me)
    bpy.context.scene.collection.objects.link(o)
    return o


def sock(sockets, name, kind='RGBA'):
    """Mix nodes have several sockets with the same name (float/vector/colour); pick the colour one."""
    for x in sockets:
        if x.name == name and x.type == kind:
            return x
    raise KeyError(name)


def terrain_material():
    m = bpy.data.materials.new('terrain')
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    attr = nt.nodes.new('ShaderNodeVertexColor')
    attr.layer_name = 'Col'
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(attr.outputs['Color'], sep.inputs['Color'])

    def tex(name, kind, nc=False):
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = load_image(tex_path(name, kind), nc)
        return t

    g, d, s = tex('grass', 'albedo'), tex('dirt', 'albedo'), tex('sand', 'albedo')
    # macro variation so the grass does not look tiled
    noise = nt.nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 0.05
    tc = nt.nodes.new('ShaderNodeTexCoord')
    nt.links.new(tc.outputs['Object'], noise.inputs['Vector'])
    macro = nt.nodes.new('ShaderNodeMix')
    macro.data_type = 'RGBA'
    macro.blend_type = 'MULTIPLY'
    sock(macro.inputs, 'Factor', 'VALUE').default_value = 0.35
    nt.links.new(g.outputs['Color'], sock(macro.inputs, 'A'))
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (0.75, 0.82, 0.55, 1)
    ramp.color_ramp.elements[1].color = (1.25, 1.15, 0.9, 1)
    nt.links.new(noise.outputs['Fac'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], sock(macro.inputs, 'B'))
    mix1 = nt.nodes.new('ShaderNodeMix')
    mix1.data_type = 'RGBA'
    nt.links.new(sep.outputs['Red'], sock(mix1.inputs, 'Factor', 'VALUE'))
    nt.links.new(sock(macro.outputs, 'Result'), sock(mix1.inputs, 'A'))
    nt.links.new(d.outputs['Color'], sock(mix1.inputs, 'B'))
    mix2 = nt.nodes.new('ShaderNodeMix')
    mix2.data_type = 'RGBA'
    nt.links.new(sep.outputs['Green'], sock(mix2.inputs, 'Factor', 'VALUE'))
    nt.links.new(sock(mix1.outputs, 'Result'), sock(mix2.inputs, 'A'))
    nt.links.new(s.outputs['Color'], sock(mix2.inputs, 'B'))
    nt.links.new(sock(mix2.outputs, 'Result'), bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.9
    gn, dn = tex('grass', 'normal', True), tex('dirt', 'normal', True)
    nmix = nt.nodes.new('ShaderNodeMix')
    nmix.data_type = 'RGBA'
    nt.links.new(sep.outputs['Red'], sock(nmix.inputs, 'Factor', 'VALUE'))
    nt.links.new(gn.outputs['Color'], sock(nmix.inputs, 'A'))
    nt.links.new(dn.outputs['Color'], sock(nmix.inputs, 'B'))
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(sock(nmix.outputs, 'Result'), nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    return m


def build_water():
    m = bpy.data.materials.new('water')
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (0.02, 0.16, 0.24, 1)
    bsdf.inputs['Roughness'].default_value = 0.04
    bsdf.inputs['Coat Weight'].default_value = 0.6
    t = nt.nodes.new('ShaderNodeTexImage')
    t.image = load_image(tex_path('water', 'normal'), True)
    mp = nt.nodes.new('ShaderNodeMapping')
    mp.inputs['Scale'].default_value = (0.08, 0.08, 0.08)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    nt.links.new(tc.outputs['Object'], mp.inputs['Vector'])
    nt.links.new(mp.outputs['Vector'], t.inputs['Vector'])
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nm.inputs['Strength'].default_value = 0.6
    nt.links.new(t.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    me = bpy.data.meshes.new('Sea')
    bm = bmesh.new()
    vs = [bm.verts.new(v) for v in ((X0 - 200, Y0 - 200, SEA_LEVEL), (X1 + 200, Y0 - 200, SEA_LEVEL), (X1 + 200, PLATEAU[2] - 4, SEA_LEVEL), (X0 - 200, PLATEAU[2] - 4, SEA_LEVEL))]
    bm.faces.new(vs)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(m)
    o = bpy.data.objects.new('Sea', me)
    bpy.context.scene.collection.objects.link(o)
    return o


# ——— placement ———

def place_town(kit, coll):
    placed = []

    def put(name, kitname, x, y, rz=0.0, s=1.0):
        z = float(height(x, y)) if kitname not in ('fence',) else float(height(x, y)) - 0.05
        o = instance(kit[kitname], name, (x, y, z), rz, s, coll)
        placed.append(o)
        return o

    for name, k, x, y, rz, _ in BUILDINGS:
        o = put(name, k, x, y, rz)
        o.location.z = max(o.location.z, 0.0)
    # garden fences in front of the two family houses (gaps for the door paths)
    for (hx, door_x) in ((-13.0, DOORS['PlayerHouse'][0]), (13.0, DOORS['RivalHouse'][0])):
        x = hx - 8.0
        i = 0
        while x < hx + 8.0:
            cx = x + 1.0
            if abs(cx - door_x) > 1.8 and not (hx > 0 and abs(cx - DOORS['RivalTower'][0]) < 1.6):
                put(f'Fence_{hx:+.0f}_{i}', 'fence', cx, 6.4)
            x += 2.05
            i += 1
        for j in range(4):
            put(f'FenceSide_{hx:+.0f}_{j}', 'fence', hx - 8.0, 7.4 + j * 2.05, math.pi / 2)
            put(f'FenceSide2_{hx:+.0f}_{j}', 'fence', hx + 8.0, 7.4 + j * 2.05, math.pi / 2)
    put('Mailbox_Player', 'mailbox', DOORS['PlayerHouse'][0] + 2.2, 5.6)
    put('Mailbox_Rival', 'mailbox', DOORS['RivalHouse'][0] - 2.2, 5.6)
    put('Sign_Pallet', 'sign_pallet', -5.2, 1.2, 0.25)
    put('Sign_Route1', 'sign_route1', 4.6, 44.0, -0.15)
    for i, y in enumerate((-26, -12, 6, 22, 36)):
        put(f'Lamp_{i}', 'lamp_post', 3.6 if i % 2 else -3.6, y)
    put('Bench_1', 'bench', -4.5, -6.5, 0.6)
    put('Bench_2', 'bench', 4.8, -6.5, -0.6)
    put('FlowerBed_Plaza1', 'flower_bed', -7.5, 2.0, math.pi / 2)
    put('FlowerBed_Plaza2', 'flower_bed', 7.5, 2.0, math.pi / 2)
    put('FlowerBed_Player', 'flower_bed', -9.0, 8.4)
    put('FlowerBed_Rival', 'flower_bed', 7.0, 8.4)
    put('FlowerBed_Lab', 'flower_bed', 3.6, -9.5)
    for i in range(4):
        put(f'Hedge_Lab_{i}', 'hedge', 14.5 + i * 2.0, -8.6)
    for k in ('PokeCenter', 'PokeMart'):
        x, y = DOORS[k]
        for side in (-1, 1):
            put(f'Lamp_{k}_{side}', 'lamp_post', x + (2.6 if k == 'PokeCenter' else -2.6), y + side * 3.6)
    put('FlowerBed_Center', 'flower_bed', DOORS['PokeCenter'][0] - 0.6, DOORS['PokeCenter'][1] + 5.0, math.pi / 2)
    put('FlowerBed_Mart', 'flower_bed', DOORS['PokeMart'][0] + 0.6, DOORS['PokeMart'][1] - 5.0, math.pi / 2)
    put('Bench_Center', 'bench', DOORS['PokeCenter'][0] + 1.0, DOORS['PokeCenter'][1] - 4.6, math.pi)
    o = put('Pier', 'pier', PIER[0], PIER[1])
    o.location.z = -0.15
    put('Bench_Beach', 'bench', 6.0, -35.0, math.pi)
    return placed


def place_interiors(coll):
    """Builds the rooms, moves them to their spots and returns their markers in town coordinates."""
    rooms = interiors.build_interiors()
    out = {}
    for rid, (obj, meta) in rooms.items():
        ox, oy = ROOMS[rid]['at']
        oz = INTERIOR_Z
        obj.name = 'Interior_' + rid
        obj.location = (ox, oy, oz)
        bpy.context.scene.collection.objects.unlink(obj)
        coll.objects.link(obj)
        dims = obj.dimensions
        out[rid] = {'origin': (ox, oy, oz), 'meta': meta, 'half': (dims.x / 2, dims.y / 2)}
    return out


def scatter(kit, coll):
    """Trees around the town and on the hills, bushes, flower patches, rocks, grass."""
    inst = {k: [] for k in ('tree_a', 'tree_b', 'tree_c', 'pine', 'bush_a', 'bush_b', 'flower_patch', 'flower_patch_b', 'rock', 'grass_short', 'grass_tall', 'grass_tall_b')}
    rnd = random.Random(5)

    def ok(x, y, pad=1.0, path_lim=0.15):
        if in_building(x, y, pad):
            return False
        if float(path_mask(x, y)) > path_lim:
            return False
        if float(height(x, y)) < SEA_LEVEL + 0.3 or float(sand_mask(x, y)) > 0.5:
            return False
        return True

    def add(kind, x, y, rz=None, s=1.0):
        inst[kind].append((x, y, float(height(x, y)), rnd.uniform(0, math.tau) if rz is None else rz, s))

    # dense tree wall around the plateau (Pallet Town is enclosed by trees)
    for y in np.arange(PLATEAU[2] + 2, PLATEAU[3] + 2, 4.6):
        for side in (-1, 1):
            for row in range(3):
                x = side * (PLATEAU[1] - 1.5 + row * 4.2) + rnd.uniform(-1, 1)
                yy = y + rnd.uniform(-1.5, 1.5) + row * 2.0
                if ok(x, yy, 2.0):
                    add(rnd.choice(['tree_a', 'tree_b', 'tree_c']), x, yy, s=rnd.uniform(0.85, 1.25))
    for x in np.arange(PLATEAU[0], PLATEAU[1] + 1, 4.6):
        if abs(x) < ROUTE[1] + 1:
            continue
        for row in range(3):
            xx = x + rnd.uniform(-1.5, 1.5)
            yy = PLATEAU[3] - 1 + row * 4.0 + rnd.uniform(-1, 1)
            if ok(xx, yy, 2.0):
                add(rnd.choice(['tree_a', 'tree_b', 'tree_c']), xx, yy, s=rnd.uniform(0.85, 1.25))
    # Route 1 borders
    for y in np.arange(PLATEAU[3] + 4, Y1 - 4, 4.4):
        for side in (-1, 1):
            for row in range(2):
                x = side * (ROUTE[1] + 2 + row * 4.5) + rnd.uniform(-1, 1)
                if ok(x, y, 1):
                    add(rnd.choice(['tree_a', 'tree_b', 'pine']), x, y + rnd.uniform(-1.5, 1.5), s=rnd.uniform(0.9, 1.3))
    # hills: forests further out
    n_hill = 160 if QUICK else 420
    tries = 0
    while sum(len(inst[k]) for k in ('tree_a', 'tree_b', 'tree_c', 'pine')) < n_hill + 120 and tries < 20000:
        tries += 1
        x, y = rnd.uniform(X0 + 4, X1 - 4), rnd.uniform(PLATEAU[2] - 4, Y1 - 4)
        if float(height(x, y)) < 1.5 or not ok(x, y, 3):
            continue
        add(rnd.choice(['tree_a', 'tree_b', 'pine', 'pine']), x, y, s=rnd.uniform(0.9, 1.5))
    # a few trees inside the town for shade
    for x, y in ((-25, -24), (27, -26), (-22, 24), (22, 25), (-21, -30), (33, 30)):
        add(rnd.choice(['tree_a', 'tree_c']), x, y, s=rnd.uniform(0.95, 1.15))
    # bushes & flowers on lawns
    for _ in range(140 if QUICK else 260):
        x, y = rnd.uniform(PLATEAU[0] + 2, PLATEAU[1] - 2), rnd.uniform(PLATEAU[2] + 2, Y1 - 6)
        if abs(x) > ROUTE[1] + 6 and y > PLATEAU[3]:
            continue
        if not ok(x, y, 1.2, 0.05) or in_grass_zone(x, y, 1.0):
            continue
        r = rnd.random()
        if r < 0.3:
            add(rnd.choice(['bush_a', 'bush_b']), x, y, s=rnd.uniform(0.8, 1.2))
        elif r < 0.85:
            add(rnd.choice(['flower_patch', 'flower_patch_b']), x, y, s=rnd.uniform(0.8, 1.2))
        else:
            add('rock', x, y, s=rnd.uniform(0.4, 0.9))
    # short grass clumps everywhere on lawns
    n_short = 3500 if QUICK else 14000
    got = 0
    tries = 0
    while got < n_short and tries < n_short * 6:
        tries += 1
        x, y = rnd.uniform(PLATEAU[0] - 6, PLATEAU[1] + 6), rnd.uniform(PLATEAU[2] - 2, Y1 - 4)
        if abs(x) > ROUTE[1] + 10 and y > PLATEAU[3] + 6:
            continue
        if not ok(x, y, 0.4, 0.35):
            continue
        add('grass_short', x, y, s=rnd.uniform(0.7, 1.35))
        got += 1
    # tall grass in the encounter zones on Route 1 and at the forest edge
    for z in ZONES:
        if z['kind'] != 'tall_grass':
            continue
        x0, x1, y0, y1 = z['x0'], z['x1'], z['y0'], z['y1']
        area = (x1 - x0) * (y1 - y0)
        for _ in range(int(area * (0.9 if QUICK else 1.8))):
            x, y = rnd.uniform(x0, x1), rnd.uniform(y0, y1)
            if z.get('wiggle'):
                x += float(route_wiggle(np.array(y)))
            if float(path_mask(x, y)) > 0.3 or in_building(x, y, 0.5):
                continue
            add(rnd.choice(['grass_tall', 'grass_tall_b']), x, y, s=rnd.uniform(0.8, 1.2))
    zones_world = [{k: v for k, v in z.items() if k != 'wiggle'} for z in ZONES]

    # Blender preview instances: trees/bushes/rocks/flowers as linked duplicates, grass via geometry nodes.
    for kind, items in inst.items():
        if kind.startswith('grass'):
            point_instancer(kit[kind], kind, items, coll)
        else:
            for i, (x, y, z, rz, s) in enumerate(items):
                instance(kit[kind], f'{kind}_{i}', (x, y, z), rz, s, coll)
    return inst, zones_world


def point_instancer(src, name, items, coll):
    me = bpy.data.meshes.new(name + '_pts')
    me.vertices.add(len(items))
    me.vertices.foreach_set('co', [c for (x, y, z, _, _) in items for c in (x, y, z)])
    a_rot = me.attributes.new('rz', 'FLOAT', 'POINT')
    a_rot.data.foreach_set('value', [it[3] for it in items])
    a_s = me.attributes.new('sc', 'FLOAT', 'POINT')
    a_s.data.foreach_set('value', [it[4] for it in items])
    o = bpy.data.objects.new(name + '_scatter', me)
    coll.objects.link(o)
    ng = bpy.data.node_groups.new(name + '_gn', 'GeometryNodeTree')
    ng.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    ng.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    nodes, links = ng.nodes, ng.links
    gi = nodes.new('NodeGroupInput')
    go = nodes.new('NodeGroupOutput')
    m2p = nodes.new('GeometryNodeMeshToPoints')
    iop = nodes.new('GeometryNodeInstanceOnPoints')
    oi = nodes.new('GeometryNodeObjectInfo')
    oi.inputs['Object'].default_value = src
    oi.inputs['As Instance'].default_value = True
    rot = nodes.new('GeometryNodeInputNamedAttribute')
    rot.data_type = 'FLOAT'
    rot.inputs['Name'].default_value = 'rz'
    sc = nodes.new('GeometryNodeInputNamedAttribute')
    sc.data_type = 'FLOAT'
    sc.inputs['Name'].default_value = 'sc'
    comb = nodes.new('ShaderNodeCombineXYZ')
    links.new(rot.outputs['Attribute'], comb.inputs['Z'])
    links.new(gi.outputs['Geometry'], m2p.inputs['Mesh'])
    links.new(m2p.outputs['Points'], iop.inputs['Points'])
    links.new(oi.outputs['Geometry'], iop.inputs['Instance'])
    links.new(comb.outputs['Vector'], iop.inputs['Rotation'])
    links.new(sc.outputs['Attribute'], iop.inputs['Scale'])
    links.new(iop.outputs['Instances'], go.inputs['Geometry'])
    mod = o.modifiers.new('scatter', 'NODES')
    mod.node_group = ng
    return o


# ——— markers for the game (NPCs, doors, exits, player start) ———
def plaza_loop(r=4.2, n=6):
    return [[round(math.cos(a) * r, 2), round(-0.5 + math.sin(a) * r, 2)] for a in (i / n * math.tau for i in range(n))]


# NPCs in town. place: 'town' or a room id (then x, y come from the room). route: waypoints they walk along
# (loop=True: round and round, otherwise back and forth), speed in m/s, pause: seconds standing at each waypoint.
NPCS = [
    {'id': 'girl', 'name': 'Лиза', 'x': -2.4, 'y': -3.2, 'face': 2.2, 'look': 'girl',
     'lines': ['Я выращиваю цветы! Покемоны их очень любят.'], 'route': plaza_loop(), 'loop': True, 'speed': 0.9, 'pause': 2.5},
    {'id': 'rival', 'name': 'Гэри', 'x': 15.4, 'y': 6.6, 'face': -0.8, 'look': 'rival',
     'lines': ['Хе, наконец-то! Я выберу покемона сильнее твоего.', 'Мой дедушка — профессор Оук. Так что я всегда буду на шаг впереди!']},
    {'id': 'jogger', 'name': 'Спортсменка Аня', 'x': 1.3, 'y': -30.0, 'face': math.pi / 2, 'look': 'student',
     'lines': ['Бег по утрам — лучшая тренировка! Для покемонов тоже.'],
     'route': [[1.3, -30.0], [1.3, 40.0], [-1.3, 40.0], [-1.3, -30.0]], 'loop': True, 'speed': 3.2, 'pause': 0.5},
    {'id': 'walker', 'name': 'Горожанка Нина', 'x': -19.8, 'y': -4.0, 'face': 0.0, 'look': 'walker',
     'lines': ['Покецентр — на западе, магазин — на востоке. Очень удобно!', 'Сегодня отличная погода для прогулки.'],
     'route': [[-19.6, -4.0], [-6.0, -4.0], [6.0, -4.0], [20.0, -4.0]], 'loop': False, 'speed': 1.3, 'pause': 3.0},
    {'id': 'bugkid', 'name': 'Натуралистка Мила', 'x': -24.0, 'y': 30.0, 'face': math.pi, 'look': 'bugkid',
     'lines': ['В траве у леса живут покемоны-жуки: Катерпи, Видл, а иногда даже Парас!'],
     'route': [[-24.0, 30.0], [-24.0, 38.5]], 'loop': False, 'speed': 0.8, 'pause': 4.0},
    {'id': 'sailor', 'name': 'Морячка Рина', 'x': PIER[0], 'y': PIER[1] - PIER[2] + 2.0, 'face': -math.pi / 2, 'look': 'sailor',
     'lines': ['Говорят, за морем лежит остров Синнабар.', 'У берега водятся Тентакулы, Крабби и даже Старью!']},
    # inside
    {'id': 'mom', 'name': 'Мама', 'place': 'home', 'look': 'mom',
     'lines': ['Ты так вырос! Береги своих покемонов.', 'Если покемоны устанут, загляни домой или в Покецентр.']},
    {'id': 'oak', 'name': 'Профессор Оук', 'place': 'lab', 'look': 'oak',
     'lines': ['Мир полон покемонов. Изучай их!']},
    {'id': 'aide', 'name': 'Ассистентка Вита', 'place': 'lab', 'look': 'tech',
     'lines': ['Я помогаю профессору с исследованиями.', 'Покемонов, которым не хватило места в команде, хранят в компьютере. Он есть в Покецентре!']},
    {'id': 'nurse', 'name': 'Медсестра Джой', 'place': 'center', 'look': 'nurse',
     'lines': ['Добро пожаловать в Покецентр!']},
    {'id': 'visitor', 'name': 'Тренер Кай', 'place': 'center', 'look': 'sailor',
     'lines': ['Покецентр лечит покемонов бесплатно. Удобно, правда?', 'Компьютер в углу хранит покемонов, которые не поместились в команду.']},
    {'id': 'clerk', 'name': 'Продавщица Юки', 'place': 'mart', 'look': 'clerk',
     'lines': ['Добро пожаловать в магазин!']},
    {'id': 'shopper', 'name': 'Покупательница', 'place': 'mart', 'look': 'girl',
     'lines': ['Покеболы заканчиваются так быстро...', 'Суперболы ловят лучше обычных, но и стоят дороже.']},
]

# Pokémon living in town (shown when their 3D model is installed). quest: only while that quest needs them.
AMBIENT = [
    {'species': 16, 'x': 3.0, 'y': -2.5, 'radius': 3.5},
    {'species': 16, 'x': -3.5, 'y': 2.0, 'radius': 3.0},
    {'species': 19, 'x': 21.0, 'y': 29.0, 'radius': 4.0},
    {'species': 10, 'x': -29.0, 'y': 33.0, 'radius': 3.0},
    {'species': 54, 'x': 14.0, 'y': -41.5, 'radius': 3.0},
    {'species': 133, 'x': 35.0, 'y': -38.5, 'radius': 1.0, 'quest': 'lost_eevee'},
]


def markers(rooms):
    def room_pt(rid, x, y):
        ox, oy, oz = rooms[rid]['origin']
        return round(ox + x, 3), round(oy + y, 3), oz

    sx, sy, sf = rooms['home']['meta']['start']
    px, py, pz = room_pt('home', sx, sy)
    portals, places = [], []
    for rid, info in ROOMS.items():
        r = rooms[rid]
        m = r['meta']
        ox, oy, oz = r['origin']
        dx, dy = DOORS[info['door']]
        tx, ty, tz = room_pt(rid, m['spawn'][0], m['spawn'][1])
        portals.append({'id': info['door'], 'kind': 'enter', 'x': dx, 'y': dy, 'z': 0.0, 'title': info['name'],
                        'tx': tx, 'ty': ty, 'tz': tz, 'tface': m['spawn'][2]})
        ex, ey, ez = room_pt(rid, m['exit'][0], m['exit'][1])
        of = info['out_face']
        portals.append({'id': rid + '_exit', 'kind': 'exit', 'x': ex, 'y': ey, 'z': ez, 'title': 'Паллет-таун',
                        'tx': round(dx + math.cos(of) * 1.3, 3), 'ty': round(dy + math.sin(of) * 1.3, 3), 'tz': 0.0, 'tface': of})
        hx, hy = r['half']
        places.append({'id': rid, 'name': info['name'], 'indoor': True, 'x0': ox - hx, 'x1': ox + hx, 'y0': oy - hy, 'y1': oy + hy,
                       'z0': oz - 3.0, 'z1': oz + 8.0,
                       'lights': [[round(ox + x, 3), round(oy + y, 3), round(oz + z, 3), i] for (x, y, z, i) in m['lights']]})
        for key, (x, y) in m['spots'].items():
            qx, qy, qz = room_pt(rid, x, y)
            portals.append({'id': key, 'kind': key, 'x': qx, 'y': qy, 'z': qz, 'title': 'Компьютер'})
    fz = next(z for z in ZONES if z['route'] == 'forest')
    places += [
        {'id': 'pier', 'name': 'Пристань', 'x0': PIER[0] - 2.5, 'x1': PIER[0] + 2.5, 'y0': PIER[1] - PIER[2] - 1.0, 'y1': PIER[1] - 1.0},
        {'id': 'forest_edge', 'name': 'Опушка леса', 'x0': fz['x0'] - 4.0, 'x1': fz['x1'] + 2.0, 'y0': fz['y0'] - 3.0, 'y1': fz['y1'] + 4.0},
        {'id': 'shore', 'name': 'Берег Паллет-тауна', 'x0': X0, 'x1': X1, 'y0': Y0 - 50.0, 'y1': PLATEAU[2]},
        {'id': 'route1', 'name': 'Маршрут 1', 'x0': X0, 'x1': X1, 'y0': PLATEAU[3] + 1.0, 'y1': Y1 + 50.0},
    ]
    npcs = []
    for n in NPCS:
        n = dict(n)
        rid = n.pop('place', None)
        if rid:
            x, y, face = rooms[rid]['meta']['npcs'][n['id']]
            n['x'], n['y'], n['z'] = room_pt(rid, x, y)
            n['face'] = face
        else:
            n['z'] = float(height(n['x'], n['y']))
        npcs.append(n)
    out = {
        'player_start': {'x': px, 'y': py, 'z': pz, 'face': sf},
        'doors': {k: {'x': v[0], 'y': v[1]} for k, v in DOORS.items()},
        'portals': portals,
        'places': places,
        'npcs': npcs,
        'ambient': [dict(a, z=float(height(a['x'], a['y']))) for a in AMBIENT],
    }
    return out


def axis_markers(coll):
    """Three tiny cubes the game uses to work out how Blender coordinates map to the imported Unreal level."""
    mb = MB()
    mb.box('metal_dark', (0, 0, 0), (0.2, 0.2, 0.2))
    src = mb.build('MARKER_mesh')
    src.hide_render = True
    res = []
    for name, p in (('MARKER_ORIGIN', (0, 0, -20)), ('MARKER_PX', (50, 0, -20)), ('MARKER_PY', (0, 50, -20))):
        o = instance(src, name, p, 0, 1, coll)
        o.hide_render = True
        res.append(o)
    bpy.data.objects.remove(src)
    return res


def gltf_export(path):
    opts = dict(filepath=path, use_selection=True, export_format='GLB', export_apply=True, export_yup=True,
                export_image_format='JPEG', export_jpeg_quality=88, export_materials='EXPORT')
    try:
        bpy.ops.export_scene.gltf(export_vertex_color='ACTIVE', export_all_vertex_colors=False, **opts)
    except TypeError:
        bpy.ops.export_scene.gltf(**opts)


def export_all(kit, town_coll, inst, zones, marks):
    # individual kit assets (game instancing)
    for name, o in kit.items():
        bpy.ops.object.select_all(action='DESELECT')
        o.hide_render = False
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        loc = o.location.copy()
        o.location = (0, 0, 0)
        gltf_export(os.path.join(OUTDIR, 'Kit', f'{name}.glb'))
        o.location = loc
    # town scene
    bpy.ops.object.select_all(action='DESELECT')
    for o in town_coll.objects:
        o.select_set(True)
    gltf_export(os.path.join(OUTDIR, 'PalletTown.glb'))
    scene = []
    for o in town_coll.objects:
        if o.type != 'MESH':
            continue
        scene.append({'name': o.name, 'mesh': o.data.name, 'loc': [round(v, 4) for v in o.location],
                      'rot_z': round(o.rotation_euler.z, 5), 'scale': [round(v, 4) for v in o.scale]})
    with open(os.path.join(OUTDIR, 'scene.json'), 'w', encoding='utf-8') as f:
        json.dump(scene, f, ensure_ascii=False, indent=0)
    layout = {
        'units': 'metres, Blender axes (X east, Y north, Z up)',
        'sea_level': SEA_LEVEL,
        'markers': marks,
        'encounter_zones': zones,
        'instances': {k: [[round(v, 3) for v in it] for it in items] for k, items in inst.items()},
    }
    with open(os.path.join(OUTDIR, 'layout.json'), 'w', encoding='utf-8') as f:
        json.dump(layout, f, ensure_ascii=False, separators=(',', ':'))
    print('exported', OUTDIR)


def main():
    clear_scene()
    kit = assets.build_kit()
    for o in kit.values():
        o.hide_render = True
        o.location = (0, 0, -500)
    town = bpy.data.collections.new('Town')
    bpy.context.scene.collection.children.link(town)
    scat = bpy.data.collections.new('Scatter')
    bpy.context.scene.collection.children.link(scat)
    t = build_terrain(1.0 if not QUICK else 2.0)
    bpy.context.scene.collection.objects.unlink(t)
    town.objects.link(t)
    w = build_water()
    bpy.context.scene.collection.objects.unlink(w)
    town.objects.link(w)
    place_town(kit, town)
    rooms = place_interiors(town)
    inst, zones = scatter(kit, scat)
    axis_markers(town)
    marks = markers(rooms)
    if '--export' in ARGS:
        export_all(kit, town, inst, zones, marks)
    if '--render' in ARGS:
        render.setup_render(1280, 720, samples=16 if QUICK else 40)
        render.setup_sky(elev_deg=38, rot_deg=215, sun_strength=4.2)
        shots = [
            ('town_street', (16.5, 1.0, 1.75), (10.0, 12.0, 2.8), 26),
            ('town_overview', (34.0, -52.0, 26.0), (0.0, 4.0, 0.0), 24),
            ('route1', (0.5, 46.0, 2.0), (-2.0, 80.0, 1.0), 26),
            ('lab', (-2.0, -0.5, 2.2), (9.0, -16.0, 3.0), 26),
            ('pokecenter', (-11.0, -9.0, 2.4), (-27.0, -3.0, 3.2), 26),
            ('mart', (11.0, 0.5, 2.4), (27.0, -4.5, 3.0), 26),
            ('beach', (6.0, -31.0, 3.2), (-6.0, -52.0, 0.0), 24),
        ]
        # interiors: cameras near the entrance, plus Blender lights where the game puts its lamps
        for rid in ROOMS:
            ox, oy, oz = rooms[rid]['origin']
            m = rooms[rid]['meta']
            ex, ey = m['exit']
            for (x, y, z, i) in m['lights']:
                ld = bpy.data.lights.new(f'L_{rid}_{x}_{y}', 'POINT')
                ld.energy = i * 2.5
                ld.color = (1.0, 0.95, 0.88)
                ld.shadow_soft_size = 0.3
                lo = bpy.data.objects.new(ld.name, ld)
                lo.location = (ox + x, oy + y, oz + z)
                bpy.context.scene.collection.objects.link(lo)
            hx, hy = rooms[rid]['half']
            shots.append((f'int_{rid}', (ox + ex + (1.2 if ex < 0 else -1.2), oy + ey + 0.5, oz + 2.4), (ox, oy + hy * 0.45, oz + 0.9), 18))
        only = os.environ.get('SHOT')
        for name, loc, look, lens in shots:
            if only and only != name:
                continue
            cam = render.camera('cam_' + name, loc, look, lens)
            render.render(cam, os.path.join(SHOTS, f'{name}.png'))


main()
