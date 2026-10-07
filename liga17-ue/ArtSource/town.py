"""Assembles Pallet Town and Route 1 — and, far to the east and reached by train, New Bark Town and Route 29 —
renders previews and exports everything for Unreal.

    python town.py [--render] [--export] [--quick]

Outputs (ArtSource/Exports):
  PalletTown.glb      - terrain, water, buildings, props and town trees of both regions as a glTF scene
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
from common import HERE, MB, clear_scene, instance, load_image, tex_path  # noqa: E402

ARGS = set(sys.argv[1:])
QUICK = '--quick' in ARGS
OUTDIR = os.path.join(HERE, 'Exports')
SHOTS = os.environ.get('SHOTS', os.path.join(HERE, 'Previews'))
os.makedirs(os.path.join(OUTDIR, 'Kit'), exist_ok=True)
os.makedirs(SHOTS, exist_ok=True)

# ——— world shape: Kanto (Pallet Town, Route 1) around the origin ———
X0, X1, Y0, Y1 = -130.0, 130.0, -95.0, 150.0
PLATEAU = (-82.0, 82.0, -36.0, 46.0)  # flat town area
ROUTE = (-15.0, 15.0)  # Route 1 valley (x range) north of the town
SEA_LEVEL = -0.9
POND = (-56.0, 14.0, 12.0, 8.0)  # the town pond: centre x, y and radii
POND_Z = -0.3                    # its water surface
RAIL_X = 74.0                    # the railway runs north-south along the east edge of town
STATION_Y = 4.0

# ——— Johto (New Bark Town, Route 29): 1 km to the east, in its own coordinates (JX, JY added on export) ———
JX, JY = 1000.0, 0.0
J_BOUNDS = (-185.0, 95.0, -75.0, 85.0)
J_PLATEAU = (-42.0, 46.0, -34.0, 36.0)
J_ROUTE_Y = 4.0
J_RAIL_Y = -28.5
J_SEA_X = 46.0  # the beach starts here; the sea lies to the east

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


def pond_r(x, y):
    """0 at the pond's centre, 1 on its rim."""
    cx, cy, rx, ry = POND
    return np.sqrt(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2)


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
    # the railway cuts into the hill north of the station and disappears into a tunnel
    cut = smoothstep(7.5, 3.8, np.abs(x - RAIL_X)) * smoothstep(40.0, 44.0, y) * (1 - smoothstep(60.5, 63.0, y))
    h = h * (1 - cut) + base * cut
    # beach and sea to the south
    south = PLATEAU[2] - y
    beach = np.clip(south, 0, None)
    h = np.where(south > 0, base - beach * 0.09 - smoothstep(6, 30, beach) * 1.6 + np.where(np.abs(x) > 95, smoothstep(95, 125, np.abs(x)) * 6, 0), h)
    # the pond basin
    r = pond_r(x, y)
    h = h - smoothstep(1.15, 0.8, r) * (0.55 + 1.4 * np.clip(1 - r * r, 0, 1))
    return h


def j_route_y(x):
    """Route 29 winds west from New Bark Town."""
    x = np.asarray(x, dtype=np.float64)
    return J_ROUTE_Y + np.where(x < J_PLATEAU[0], np.sin((x - J_PLATEAU[0]) / 16.0) * 5.0, 0.0)


def height_j(x, y):
    """Johto ground in Johto coordinates."""
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    d_plateau = np.maximum(np.maximum(J_PLATEAU[0] - x, y - J_PLATEAU[3]), J_PLATEAU[2] - y)
    d_route = np.where(x <= J_PLATEAU[0] + 8, np.abs(y - j_route_y(x)) - 11.0, 1e6)
    d_route = d_route + np.clip(-165.0 - x, 0, None) * 1.5  # the valley ends in hills far to the west
    d = np.minimum(d_plateau, d_route)
    hills = smoothstep(0, 30, d) * (8.0 + 5.0 * value_noise(x, y, 16, 13)) + smoothstep(0, 8, d) * 1.0
    base = 0.05 * value_noise(x, y, 6, 11)
    h = base + np.where(d > 0, hills, 0)
    # the railway leaves to the west through a tunnel
    cut = smoothstep(7.5, 3.8, np.abs(y - J_RAIL_Y)) * smoothstep(-61.0, -58.5, x)
    h = h * (1 - cut) + base * cut
    # beach and sea to the east
    east = np.clip(x - J_SEA_X, 0, None)
    beach_h = base - east * 0.09 - smoothstep(6, 26, east) * 1.6
    t = smoothstep(J_SEA_X - 4.0, J_SEA_X + 2.0, x)
    return h * (1 - t) + beach_h * t


def front_of(x, y, rz, depth, dist):
    """A point `dist` metres in front of the facade centre of a building `depth` deep (front = -Y before rz)."""
    ly = -depth / 2 - dist
    return (round(x - ly * math.sin(rz), 3), round(y + ly * math.cos(rz), 3))


def house_door(x, y, rz, W, D, dist=0.7):
    """The door of a kit house: on the front facade, 18 % of the width left of the middle."""
    lx, ly = -W * 0.18, -D / 2 - dist
    return (round(x + lx * math.cos(rz) - ly * math.sin(rz), 3), round(y + lx * math.sin(rz) + ly * math.cos(rz), 3))


HOUSE_SIZE = {'house_small': (7.0, 6.0), 'house_a': (9.5, 7.5), 'house_b': (8.0, 6.5), 'house_c': (9.0, 7.0)}

# ——— layout: buildings and paths (Blender coordinates, metres; buildings face -Y unless rotated) ———
BUILDINGS = [
    # name, kit, x, y, rot, footprint (w, d) for exclusion
    ('PlayerHouse', 'house_player', -13.0, 15.0, 0.0, (11, 10)),
    ('RivalHouse', 'house_rival', 13.0, 15.0, 0.0, (13, 11)),
    ('OakLab', 'oak_lab', 9.0, -17.0, math.pi, (24, 14)),
    ('NeighbourHouse', 'house_small', -15.0, -17.0, math.pi, (9, 8)),
    ('PokeCenter', 'pokecenter', -29.0, -4.0, math.pi / 2, (13, 13)),
    ('PokeMart', 'mart', 28.5, -4.0, -math.pi / 2, (11, 11)),
    # the new districts
    ('HouseW1', 'house_a', -46.0, 36.0, 0.0, (11, 10)),
    ('HouseW2', 'house_b', -62.0, 36.0, 0.0, (10, 9)),
    ('HouseE1', 'house_c', 50.0, 36.0, 0.0, (11, 10)),
    ('HouseE2', 'house_b', 64.0, 36.0, 0.0, (10, 9)),
    ('HouseS1', 'house_c', -30.0, -23.5, 0.0, (11, 10)),
    ('HouseS2', 'house_a', 31.0, -23.5, 0.0, (11, 10)),
    ('Station', 'station', 58.0, STATION_Y, -math.pi / 2, (10, 17)),
    ('Platform', 'platform', 69.75, STATION_Y, 0.0, (5, 37)),
    ('Train', 'train', RAIL_X, STATION_Y, 0.0, (3.4, 44)),
    ('Lighthouse', 'lighthouse', 60.0, -45.0, 0.0, (8, 8)),
    ('Fountain', 'fountain', -58.0, -18.0, 0.0, (6.5, 6.5)),
    ('Playground', 'playground', -74.0, -16.0, math.pi / 2, (9.5, 12.5)),
    ('StallN1', 'market_stall', 47.0, -16.6, 0.0, (5, 3)),
    ('StallN2', 'market_stall_b', 54.0, -16.6, 0.0, (5, 3)),
    ('StallN3', 'market_stall', 61.0, -16.6, 0.0, (5, 3)),
    ('StallS1', 'market_stall_b', 50.5, -23.4, math.pi, (5, 3)),
    ('StallS2', 'market_stall', 57.5, -23.4, math.pi, (5, 3)),
]

# New Bark Town (Johto coordinates)
BUILDINGS_J = [
    ('J_ElmLab', 'elm_lab', 4.0, 18.0, 0.0, (24, 14)),
    ('J_PlayerHouse', 'house_small', -18.0, 17.0, 0.0, (9, 8)),
    ('J_House2', 'house_a', 30.0, 18.0, 0.0, (11, 10)),
    ('J_House3', 'house_b', -8.0, -14.0, math.pi, (10, 9)),
    ('J_Center', 'pokecenter', -27.0, -9.0, math.pi, (13, 13)),
    ('J_Mart', 'mart', 27.0, -9.0, math.pi, (11, 11)),
    ('J_Station', 'station', 4.0, -15.0, math.pi, (17, 10)),
    ('J_Platform', 'platform', 4.0, -24.25, -math.pi / 2, (37, 5)),
    ('J_Train', 'train', 4.0, J_RAIL_Y, -math.pi / 2, (44, 3.4)),
]


def building(name):
    return next(b for b in BUILDINGS + BUILDINGS_J if b[0] == name)


def service_door(name, dist):
    _, kit, x, y, rz, _ = building(name)
    return front_of(x, y, rz, {'pokecenter': 10.0, 'mart': 8.0, 'station': 9.0}[kit], dist)


def kit_house_door(name):
    _, kit, x, y, rz, _ = building(name)
    W, D = HOUSE_SIZE[kit]
    return house_door(x, y, rz, W, D)


DOORS = {
    'PlayerHouse': (-14.62, 9.4),
    'RivalHouse': (11.38, 9.4),
    'RivalTower': (17.2, 8.9),
    'OakLab': (9.0, -9.6),
    'NeighbourHouse': (-13.74, -12.3),
    'PokeCenter': service_door('PokeCenter', 2.2),
    'PokeMart': service_door('PokeMart', 2.2),
    'Station': service_door('Station', 0.9),
}
for _k in ('HouseW1', 'HouseW2', 'HouseE1', 'HouseE2', 'HouseS1', 'HouseS2'):
    DOORS[_k] = kit_house_door(_k)
DOORS_J = {
    'J_ElmLab': (4.0, 10.6),
    'J_PlayerHouse': kit_house_door('J_PlayerHouse'),
    'J_House2': kit_house_door('J_House2'),
    'J_House3': kit_house_door('J_House3'),
    'J_Center': service_door('J_Center', 2.2),
    'J_Mart': service_door('J_Mart', 2.2),
    'J_Station': service_door('J_Station', 0.9),
}
ROAD_W = 2.6
PIER = (-6.0, -37.0, 20.0)  # x, y of the shore end, length (it runs south over the water)
DOCK = (-56.0, 5.2, 8.0)    # the pond's jetty: shore end, length (runs north over the water)
PIER_J = (49.0, -6.0, 20.0)  # New Bark's jetty runs east over the sea

# Rooms you can enter: far below the map, out of sight. door = the building door outside, out_face = where you face outside.
INTERIOR_Z = -30.0
ROOMS = {
    'home': {'name': 'Дом героя', 'at': (200.0, 0.0), 'door': 'PlayerHouse', 'out_face': -math.pi / 2, 'town': 'Паллет-таун'},
    'lab': {'name': 'Лаборатория Оука', 'at': (240.0, 0.0), 'door': 'OakLab', 'out_face': math.pi / 2, 'town': 'Паллет-таун'},
    'center': {'name': 'Покецентр', 'at': (280.0, 0.0), 'door': 'PokeCenter', 'out_face': 0.0, 'town': 'Паллет-таун'},
    'mart': {'name': 'Магазин', 'at': (320.0, 0.0), 'door': 'PokeMart', 'out_face': math.pi, 'town': 'Паллет-таун'},
    'center_j': {'name': 'Покецентр Нью-Барка', 'at': (360.0, 0.0), 'door': 'J_Center', 'out_face': math.pi / 2, 'town': 'Нью-Барк'},
    'mart_j': {'name': 'Магазин Нью-Барка', 'at': (400.0, 0.0), 'door': 'J_Mart', 'out_face': math.pi / 2, 'town': 'Нью-Барк'},
    'elmlab': {'name': 'Лаборатория Элма', 'at': (440.0, 0.0), 'door': 'J_ElmLab', 'out_face': -math.pi / 2, 'town': 'Нью-Барк'},
}


def door_pos(key):
    """A door in world (Blender) coordinates: Johto doors are shifted by the region's offset."""
    if key in DOORS_J:
        x, y = DOORS_J[key]
        return (round(x + JX, 3), round(y + JY, 3))
    return DOORS[key]


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
    # streets of the new districts
    segs += [
        ((-82.0, 27.0), (82.0, 27.0), 2.2),      # north avenue
        ((-40.0, 27.0), (-40.0, -31.5), 2.0),    # west street
        ((40.0, 27.0), (40.0, -31.5), 2.0),      # east street
        ((-60.0, -31.5), (60.0, -31.5), 1.8),    # promenade along the beach
        ((-40.0, -18.0), (-51.0, -18.0), 1.6),   # to the park
        ((-65.0, -18.0), (-69.0, -18.0), 1.4),   # park to the playground
        ((-40.0, 2.0), (DOCK[0], 2.0), 1.4),     # to the pond
        ((DOCK[0], 2.0), (DOCK[0], DOCK[1]), 1.2),
        ((40.0, STATION_Y), (DOORS['Station'][0], STATION_Y), 2.2),  # station forecourt
        ((40.0, 15.5), (68.0, 15.5), 1.5),       # round the station to the platform
        ((40.0, -20.0), (66.0, -20.0), 2.0),     # market street
        ((40.0, -30.0), (55.5, -39.5), 1.2),     # down to the lighthouse
        ((-40.0, -4.0), (-36.0, -4.0), 1.6),     # behind the Poké Center
    ]
    for k in ('HouseW1', 'HouseW2', 'HouseE1', 'HouseE2'):  # front paths down to the north avenue
        x, y = DOORS[k]
        segs.append(((x, y), (x, 27.0), 1.1))
    for k in ('HouseS1', 'HouseS2'):  # and down to the promenade
        x, y = DOORS[k]
        segs.append(((x, y), (x, -31.5), 1.1))
    return segs


PLAZAS = [((0.0, -0.5), 6.0), ((-58.0, -18.0), 7.5), ((51.0, STATION_Y), 4.5)]


def path_segments_j():
    segs = [((J_PLATEAU[0], 2.0), (J_SEA_X + 3.0, 2.0), 2.4),   # New Bark's main street
            ((4.0, DOORS_J['J_Station'][1]), (4.0, DOORS_J['J_ElmLab'][1]), 2.0),
            ((PIER_J[0], PIER_J[1]), (J_SEA_X - 4.0, PIER_J[1]), 1.2),
            ((J_SEA_X - 4.0, PIER_J[1]), (J_SEA_X - 4.0, 2.0), 1.2)]
    for k in ('J_PlayerHouse', 'J_House2', 'J_House3', 'J_Center', 'J_Mart'):
        x, y = DOORS_J[k]
        segs.append(((x, y), (x, 2.0), 1.4 if k in ('J_Center', 'J_Mart') else 1.1))
    # round the station to the platform
    segs.append(((-8.0, 2.0), (-8.0, -21.0), 1.3))
    segs.append(((16.0, 2.0), (16.0, -21.0), 1.3))
    # Route 29: a dirt road along the winding valley
    xs = np.arange(J_PLATEAU[0], -172.0, -6.0)
    pts = [(float(x), float(j_route_y(x))) for x in xs]
    for a, b in zip(pts, pts[1:]):
        segs.append((a, b, 2.0))
    return segs


PLAZAS_J = [((4.0, 2.0), 5.0)]


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
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    m = np.zeros_like(x)
    for a, b, w in path_segments():
        xx = x - (route_wiggle(y) if a[0] == 0.0 and b[1] > 100 else 0)
        d = seg_dist(xx, y, a, b)
        edge = w + 0.6 * value_noise(x, y, 2.5, 9)
        m = np.maximum(m, 1 - smoothstep(edge - 0.8, edge + 0.4, d))
    # plazas: the town square, the park round the fountain, the station forecourt
    for (cx, cy), r in PLAZAS:
        d = np.hypot(x - cx, y - cy) - (r + 0.5 * value_noise(x, y, 2, 4))
        m = np.maximum(m, 1 - smoothstep(-0.6, 0.6, d))
    return np.clip(m, 0, 1)


def path_mask_j(x, y):
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    m = np.zeros_like(x)
    for a, b, w in path_segments_j():
        d = seg_dist(x, y, a, b)
        edge = w + 0.6 * value_noise(x, y, 2.5, 19)
        m = np.maximum(m, 1 - smoothstep(edge - 0.8, edge + 0.4, d))
    for (cx, cy), r in PLAZAS_J:
        d = np.hypot(x - cx, y - cy) - (r + 0.5 * value_noise(x, y, 2, 14))
        m = np.maximum(m, 1 - smoothstep(-0.6, 0.6, d))
    return np.clip(m, 0, 1)


def sand_mask(x, y):
    beach = smoothstep(PLATEAU[2] + 2, PLATEAU[2] - 5, y + 0.8 * value_noise(x, y, 4, 5))
    pond = smoothstep(1.2, 1.04, pond_r(x, y) + 0.05 * value_noise(x, y, 2, 6))
    return np.maximum(beach, pond)


def sand_mask_j(x, y):
    return smoothstep(J_SEA_X - 3.0, J_SEA_X + 3.0, x + 0.8 * value_noise(x, y, 4, 15))


def in_box_list(x, y, boxes, pad):
    for _, _, bx, by, rot, (w, d) in boxes:
        if abs(x - bx) < w / 2 + pad and abs(y - by) < d / 2 + pad:
            return True
    return False


def in_building(x, y, pad=0.0):
    return in_box_list(x, y, BUILDINGS, pad)


def reserved(x, y, pad=0.0):
    """Kanto ground kept clear of trees and bushes: buildings, the railway, the pond, the park square and the market."""
    if in_building(x, y, pad):
        return True
    if abs(x - RAIL_X) < 5.0 + pad and y > PLATEAU[2] - 4 and y < 66.0:
        return True
    if float(pond_r(x, y)) < 1.08 + pad * 0.1:
        return True
    if math.hypot(x + 58.0, y + 18.0) < 8.5 + pad:
        return True
    return 43.0 - pad < x < 66.0 + pad and -27.0 - pad < y < -13.0 + pad


def reserved_j(x, y, pad=0.0):
    if in_box_list(x, y, BUILDINGS_J, pad):
        return True
    if abs(y - J_RAIL_Y) < 5.0 + pad and -62.0 < x < 44.0:
        return True
    return False


# Wild Pokémon areas: tall grass on Route 1, at the forest edge and by the pond, the surf along the beach and the pier.
ZONES = [
    {'x0': -12.0, 'x1': -4.5, 'y0': 54.0, 'y1': 78.0, 'kind': 'tall_grass', 'route': 'route1', 'place': 'Маршрут 1', 'pad': 3.5, 'wiggle': True},
    {'x0': 4.5, 'x1': 12.5, 'y0': 62.0, 'y1': 92.0, 'kind': 'tall_grass', 'route': 'route1', 'place': 'Маршрут 1', 'pad': 3.5, 'wiggle': True},
    {'x0': -11.0, 'x1': -3.5, 'y0': 98.0, 'y1': 128.0, 'kind': 'tall_grass', 'route': 'route1_north', 'place': 'Маршрут 1', 'pad': 3.5, 'wiggle': True},
    {'x0': 5.0, 'x1': 12.0, 'y0': 112.0, 'y1': 140.0, 'kind': 'tall_grass', 'route': 'route1_north', 'place': 'Маршрут 1', 'pad': 3.5, 'wiggle': True},
    {'x0': -79.0, 'x1': -70.0, 'y0': 24.0, 'y1': 42.0, 'kind': 'tall_grass', 'route': 'forest', 'place': 'Опушка леса', 'pad': 0.6},
    {'x0': -77.0, 'x1': -69.5, 'y0': 6.0, 'y1': 20.0, 'kind': 'tall_grass', 'route': 'pond', 'place': 'Пруд', 'pad': 0.6},
    {'x0': -95.0, 'x1': 95.0, 'y0': -48.0, 'y1': -40.5, 'kind': 'shore', 'route': 'shore', 'place': 'Берег Паллет-тауна', 'pad': 0.3},
    {'x0': PIER[0] - 1.6, 'x1': PIER[0] + 1.6, 'y0': PIER[1] - PIER[2], 'y1': -40.5, 'kind': 'shore', 'route': 'shore', 'place': 'Пристань', 'pad': 0.3},
]

# Route 29 (Johto coordinates): grass beside the winding road, and the beach of New Bark Town.
ZONES_J = [
    {'x0': -64.0, 'x1': -52.0, 'y0': 3.0, 'y1': 10.0, 'kind': 'tall_grass', 'route': 'route29', 'place': 'Маршрут 29', 'pad': 0.6},
    {'x0': -96.0, 'x1': -84.0, 'y0': -6.0, 'y1': 0.5, 'kind': 'tall_grass', 'route': 'route29', 'place': 'Маршрут 29', 'pad': 0.6},
    {'x0': -132.0, 'x1': -118.0, 'y0': 11.5, 'y1': 18.0, 'kind': 'tall_grass', 'route': 'route29_west', 'place': 'Маршрут 29', 'pad': 0.6},
    {'x0': -150.0, 'x1': -138.0, 'y0': -2.0, 'y1': 4.5, 'kind': 'tall_grass', 'route': 'route29_west', 'place': 'Маршрут 29', 'pad': 0.6},
    {'x0': J_SEA_X + 1.0, 'x1': J_SEA_X + 14.0, 'y0': -26.0, 'y1': 30.0, 'kind': 'shore', 'route': 'newbark_shore', 'place': 'Берег Нью-Барка', 'pad': 0.3},
]


def in_grass_zone(x, y, pad=0.0, zones=ZONES):
    return any(z['kind'] == 'tall_grass' and not z.get('wiggle') and z['x0'] - pad < x < z['x1'] + pad and z['y0'] - pad < y < z['y1'] + pad
               for z in zones)


# ——— terrain ———

def build_terrain(name, hfun, pfun, sfun, bounds, offset=(0.0, 0.0), step=1.0):
    bx0, bx1, by0, by1 = bounds
    nx = int((bx1 - bx0) / step) + 1
    ny = int((by1 - by0) / step) + 1
    xs = np.linspace(bx0, bx1, nx)
    ys = np.linspace(by0, by1, ny)
    gx, gy = np.meshgrid(xs, ys)
    gz = hfun(gx, gy)
    pm = pfun(gx, gy)
    sm = sfun(gx, gy)
    ox, oy = offset
    bm = bmesh.new()
    verts = [bm.verts.new((float(gx[j, i] + ox), float(gy[j, i] + oy), float(gz[j, i]))) for j in range(ny) for i in range(nx)]
    bm.verts.ensure_lookup_table()
    bm.verts.index_update()  # new verts have index -1 until this runs
    col = bm.loops.layers.color.new('Col')
    uv = bm.loops.layers.uv.new('UVMap')
    for j in range(ny - 1):
        for i in range(nx - 1):
            a = j * nx + i
            f = bm.faces.new((verts[a], verts[a + 1], verts[a + nx + 1], verts[a + nx]))
            for lp in f.loops:
                vi = lp.vert.index
                jj, ii = divmod(vi, nx)
                lp[col] = (float(pm[jj, ii]), float(sm[jj, ii]), 0.0, 1.0)
                lp[uv].uv = (lp.vert.co.x / 5.0, lp.vert.co.y / 5.0)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    # Make 'Col' the active/render colour. Otherwise the glTF exporter writes a white placeholder
    # as COLOR_0 (the only set Unreal reads) and the masks as COLOR_1, and the whole ground turns to sand.
    me.color_attributes.active_color = me.color_attributes['Col']
    me.color_attributes.render_color_index = me.color_attributes.active_color_index
    for p in me.polygons:
        p.use_smooth = True
    me.materials.append(terrain_material())
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def sock(sockets, name, kind='RGBA'):
    """Mix nodes have several sockets with the same name (float/vector/colour); pick the colour one."""
    for x in sockets:
        if x.name == name and x.type == kind:
            return x
    raise KeyError(name)


def terrain_material():
    m = bpy.data.materials.get('terrain')
    if m:
        return m
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


def water_material():
    m = bpy.data.materials.get('water')
    if m:
        return m
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
    return m


def water_plane(name, pts, z):
    """A flat water surface; every mesh whose name starts with 'Sea' gets the animated sea material in Unreal."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    vs = [bm.verts.new((x, y, z)) for x, y in pts]
    bm.faces.new(vs)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(water_material())
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def build_water():
    out = [water_plane('Sea', ((X0 - 200, Y0 - 200), (X1 + 200, Y0 - 200), (X1 + 200, PLATEAU[2] - 4), (X0 - 200, PLATEAU[2] - 4)), SEA_LEVEL)]
    cx, cy, rx, ry = POND
    out.append(water_plane('SeaPond', [(cx + math.cos(a) * rx * 1.08, cy + math.sin(a) * ry * 1.08) for a in (i / 48 * math.tau for i in range(48))], POND_Z))
    x0 = JX + J_SEA_X + 4.0
    out.append(water_plane('SeaJohto', ((x0, JY - 300), (JX + 400, JY - 300), (JX + 400, JY + 300), (x0, JY + 300)), SEA_LEVEL))
    return out


# ——— placement ———

def place_town(kit, coll):
    placed = []

    def put(name, kitname, x, y, rz=0.0, s=1.0, z=None):
        if z is None:
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
    for k in ('HouseW1', 'HouseW2', 'HouseE1', 'HouseE2'):
        put(f'Mailbox_{k}', 'mailbox', DOORS[k][0] + 1.8, 28.9)
    put('Sign_Pallet', 'sign_pallet', -5.2, 1.2, 0.25)
    put('Sign_Route1', 'sign_route1', 4.6, 44.0, -0.15)
    put('Sign_Station', 'sign_station', 44.0, STATION_Y + 3.4, -math.pi / 2)
    for i, y in enumerate((-26, -12, 6, 22, 36)):
        put(f'Lamp_{i}', 'lamp_post', 3.6 if i % 2 else -3.6, y)
    for i, x in enumerate((-70, -52, -34, -20, 20, 34, 52, 70)):  # the north avenue
        put(f'LampN_{i}', 'lamp_post', x, 24.0 if i % 2 else 30.0)
    for i, y in enumerate((-24, -8, 8, 20)):  # the two side streets
        put(f'LampW_{i}', 'lamp_post', -42.8, y)
        put(f'LampE_{i}', 'lamp_post', 42.8, y + 4.0)
    for i, x in enumerate((-50, -26, 14, 26, 48)):  # the promenade
        put(f'LampS_{i}', 'lamp_post', x, -34.0)
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
    # the park: benches and flower beds round the fountain
    for i in range(4):
        a = i / 4 * math.tau + math.pi / 4
        put(f'Bench_Park_{i}', 'bench', -58.0 + math.cos(a) * 5.4, -18.0 + math.sin(a) * 5.4, a - math.pi / 2)
        a2 = i / 4 * math.tau
        put(f'FlowerBed_Park_{i}', 'flower_bed', -58.0 + math.cos(a2) * 9.2, -18.0 + math.sin(a2) * 9.2, a2 + math.pi / 2)
        put(f'Lamp_Park_{i}', 'lamp_post', -58.0 + math.cos(a) * 8.0, -18.0 + math.sin(a) * 8.0)
    # the pond: a jetty and benches on the bank
    o = put('Dock', 'dock', DOCK[0], DOCK[1], math.pi)
    o.location.z = 0.0
    put('Bench_Pond_1', 'bench', -46.0, 5.6, -0.4)
    put('Bench_Pond_2', 'bench', -66.5, 5.0, 0.4)
    # station: benches on the forecourt, the track with a buffer stop and the tunnel into the hill
    put('Bench_Station_1', 'bench', 47.0, STATION_Y + 5.6, math.pi)
    put('Bench_Station_2', 'bench', 47.0, STATION_Y - 5.6, 0.0)
    for i, y in enumerate(range(-25, 60, 10)):
        put(f'Rails_{i}', 'rails', RAIL_X, float(y), 0.0, z=float(height(RAIL_X, y)))
    put('BufferStop', 'buffer_stop', RAIL_X, -29.6, math.pi)
    o = put('Tunnel', 'tunnel', RAIL_X, 61.0, 0.0)
    o.location.z = float(height(RAIL_X, 58.0))
    put('Sign_Park', 'sign_park', -48.5, -15.0, -math.pi / 2)
    put('Sign_Pond', 'sign_pond', -44.0, 6.8, 0.0)
    return placed


def place_johto(kit, coll):
    placed = []

    def put(name, kitname, x, y, rz=0.0, s=1.0, z=None):
        if z is None:
            z = float(height_j(x, y))
        o = instance(kit[kitname], name, (x + JX, y + JY, z), rz, s, coll)
        placed.append(o)
        return o

    for name, k, x, y, rz, _ in BUILDINGS_J:
        o = put(name, k, x, y, rz)
        o.location.z = max(o.location.z, 0.0)
    put('J_Sign_NewBark', 'sign_newbark', 11.0, 5.0, 0.2)
    put('J_Sign_Route29', 'sign_route29', J_PLATEAU[0] - 1.0, 7.5, 0.1)
    put('J_Sign_Station', 'sign_station', -2.5, -9.0, 0.0)
    for i, x in enumerate((-36.0, -20.0, -4.0, 12.0, 28.0, 40.0)):
        put(f'J_Lamp_{i}', 'lamp_post', x, 5.0 if i % 2 else -1.0)
    for i, x in enumerate((-12.0, 20.0)):
        put(f'J_FlowerBed_{i}', 'flower_bed', x, 5.6)
    put('J_FlowerBed_Lab', 'flower_bed', -1.2, 9.6)
    put('J_Bench_1', 'bench', -2.5, -2.5, 0.5)
    put('J_Bench_2', 'bench', 10.5, -2.5, -0.5)
    put('J_Bench_Beach', 'bench', J_SEA_X - 2.0, 10.0, -math.pi / 2)
    for (hx, hy, dx) in ((-18.0, 17.0, DOORS_J['J_PlayerHouse'][0]), (30.0, 18.0, DOORS_J['J_House2'][0])):
        x = hx - 6.0
        i = 0
        while x < hx + 6.0:
            cx = x + 1.0
            if abs(cx - dx) > 1.8:
                put(f'J_Fence_{hx:+.0f}_{i}', 'fence', cx, hy - 6.2, z=float(height_j(cx, hy - 6.2)) - 0.05)
            x += 2.05
            i += 1
        put(f'J_Mailbox_{hx:+.0f}', 'mailbox', dx + 2.0, hy - 7.0)
    o = put('J_Pier', 'pier', PIER_J[0], PIER_J[1], math.pi / 2)
    o.location.z = -0.15
    for i, x in enumerate(range(-55, 40, 10)):
        put(f'J_Rails_{i}', 'rails', float(x), J_RAIL_Y, math.pi / 2, z=float(height_j(x, J_RAIL_Y)))
    put('J_BufferStop', 'buffer_stop', 40.6, J_RAIL_Y, -math.pi / 2)
    o = put('J_Tunnel', 'tunnel', -60.0, J_RAIL_Y, math.pi / 2)
    o.location.z = float(height_j(-56.0, J_RAIL_Y))
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


INSTANCE_KINDS = ('tree_a', 'tree_b', 'tree_c', 'pine', 'bush_a', 'bush_b', 'flower_patch', 'flower_patch_b', 'rock',
                  'grass_short', 'grass_tall', 'grass_tall_b', 'grass_reed')


def scatter(kit, coll):
    """Trees around both towns and on the hills, bushes, flower patches, rocks, grass, reeds by the pond."""
    inst = {k: [] for k in INSTANCE_KINDS}
    rnd = random.Random(5)

    def ok(x, y, pad=1.0, path_lim=0.15):
        if reserved(x, y, pad):
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
    n_hill = 220 if QUICK else 560
    tries = 0
    while sum(len(inst[k]) for k in ('tree_a', 'tree_b', 'tree_c', 'pine')) < n_hill + 160 and tries < 30000:
        tries += 1
        x, y = rnd.uniform(X0 + 4, X1 - 4), rnd.uniform(PLATEAU[2] - 4, Y1 - 4)
        if float(height(x, y)) < 1.5 or not ok(x, y, 3):
            continue
        add(rnd.choice(['tree_a', 'tree_b', 'pine', 'pine']), x, y, s=rnd.uniform(0.9, 1.5))
    # trees inside the town for shade: a few here and there, a ring round the park, a row along the north avenue
    for x, y in ((-25, -24), (27, -26), (-22, 24), (22, 25), (-21, -30), (33, 30), (-48, 22), (-36, 40), (36, 42), (58, 26)):
        if not reserved(x, y, 1.0):
            add(rnd.choice(['tree_a', 'tree_c']), x, y, s=rnd.uniform(0.95, 1.15))
    for i in range(10):
        a = i / 10 * math.tau + 0.2
        x, y = -58.0 + math.cos(a) * 12.5, -18.0 + math.sin(a) * 12.0
        if ok(x, y, 1.0):
            add(rnd.choice(['tree_a', 'tree_c']), x, y, s=rnd.uniform(0.9, 1.1))
    for x in np.arange(-76.0, 80.0, 11.0):
        for y in (31.0, 22.5):
            if abs(x) > 18 and ok(x, y, 1.5):
                add('tree_c', float(x), y, s=rnd.uniform(0.85, 1.0))
    # reeds round the pond, leaving the jetty clear
    for i in range(90 if QUICK else 160):
        a = rnd.uniform(0, math.tau)
        r = rnd.uniform(0.93, 1.06)
        x = POND[0] + math.cos(a) * POND[2] * r
        y = POND[1] + math.sin(a) * POND[3] * r
        if abs(x - DOCK[0]) < 2.2 and y < POND[1]:
            continue
        add('grass_reed', x, y, s=rnd.uniform(0.8, 1.2))
    # bushes & flowers on lawns
    for _ in range(260 if QUICK else 520):
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
    n_short = 6000 if QUICK else 24000
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
    # tall grass in the encounter zones on Route 1, at the forest edge and by the pond
    for z in ZONES:
        if z['kind'] != 'tall_grass':
            continue
        x0, x1, y0, y1 = z['x0'], z['x1'], z['y0'], z['y1']
        area = (x1 - x0) * (y1 - y0)
        for _ in range(int(area * (0.9 if QUICK else 1.8))):
            x, y = rnd.uniform(x0, x1), rnd.uniform(y0, y1)
            if z.get('wiggle'):
                x += float(route_wiggle(np.array(y)))
            if float(path_mask(x, y)) > 0.3 or reserved(x, y, 0.5):
                continue
            add(rnd.choice(['grass_tall', 'grass_tall_b']), x, y, s=rnd.uniform(0.8, 1.2))
    scatter_johto(inst, rnd)
    zones_world = [{k: v for k, v in z.items() if k != 'wiggle'} for z in ZONES]
    for z in ZONES_J:
        zones_world.append(dict(z, x0=z['x0'] + JX, x1=z['x1'] + JX, y0=z['y0'] + JY, y1=z['y1'] + JY))

    # Blender preview instances: trees/bushes/rocks/flowers as linked duplicates, grass via geometry nodes.
    for kind, items in inst.items():
        if kind.startswith('grass'):
            point_instancer(kit[kind], kind, items, coll)
        else:
            for i, (x, y, z, rz, s) in enumerate(items):
                instance(kit[kind], f'{kind}_{i}', (x, y, z), rz, s, coll)
    return inst, zones_world


def scatter_johto(inst, rnd):
    """The same for New Bark Town and Route 29 (positions are stored in world coordinates)."""

    def ok(x, y, pad=1.0, path_lim=0.15):
        if reserved_j(x, y, pad):
            return False
        if float(path_mask_j(x, y)) > path_lim:
            return False
        if float(height_j(x, y)) < SEA_LEVEL + 0.3 or float(sand_mask_j(x, y)) > 0.5:
            return False
        return True

    def add(kind, x, y, rz=None, s=1.0):
        inst[kind].append((x + JX, y + JY, float(height_j(x, y)), rnd.uniform(0, math.tau) if rz is None else rz, s))

    bx0, bx1, by0, by1 = J_BOUNDS
    trees = ['tree_a', 'tree_b', 'tree_c']
    # tree walls round the town (north, south and west sides; the sea is to the east)
    for x in np.arange(J_PLATEAU[0], J_SEA_X - 4.0, 4.6):
        for row in range(3):
            for side in (-1, 1):
                xx = x + rnd.uniform(-1.5, 1.5)
                yy = (J_PLATEAU[3] - 1 + row * 4.0) if side > 0 else (J_PLATEAU[2] + 1 - row * 4.0)
                if ok(xx, yy + rnd.uniform(-1, 1), 2.0):
                    add(rnd.choice(trees), xx, yy, s=rnd.uniform(0.85, 1.25))
    for y in np.arange(J_PLATEAU[2], J_PLATEAU[3] + 1, 4.6):
        for row in range(3):
            x = J_PLATEAU[0] + 1.5 - row * 4.2 + rnd.uniform(-1, 1)
            yy = y + rnd.uniform(-1.5, 1.5)
            if abs(yy - float(j_route_y(x))) < 12.0:
                continue
            if ok(x, yy, 2.0):
                add(rnd.choice(trees), x, yy, s=rnd.uniform(0.85, 1.25))
    # Route 29: trees along both sides of the valley
    for x in np.arange(J_PLATEAU[0] - 2, -175.0, -4.4):
        cy = float(j_route_y(x))
        for side in (-1, 1):
            for row in range(2):
                y = cy + side * (12.5 + row * 4.5) + rnd.uniform(-1, 1)
                if ok(x, y, 1):
                    add(rnd.choice(['tree_a', 'tree_b', 'pine']), x + rnd.uniform(-1.5, 1.5), y, s=rnd.uniform(0.9, 1.3))
    # forests on the hills
    n_hill = 200 if QUICK else 480
    got = 0
    tries = 0
    while got < n_hill and tries < 30000:
        tries += 1
        x, y = rnd.uniform(bx0 + 4, J_SEA_X - 2), rnd.uniform(by0 + 4, by1 - 4)
        if float(height_j(x, y)) < 1.5 or not ok(x, y, 3):
            continue
        add(rnd.choice(['tree_a', 'tree_b', 'pine', 'pine']), x, y, s=rnd.uniform(0.9, 1.5))
        got += 1
    for x, y in ((-34.0, 26.0), (20.0, 28.0), (38.0, -24.0), (-36.0, -26.0), (-30.0, 6.5), (36.0, 8.0)):
        if not reserved_j(x, y, 1.0):
            add(rnd.choice(['tree_a', 'tree_c']), x, y, s=rnd.uniform(0.95, 1.15))
    for _ in range(140 if QUICK else 300):
        x, y = rnd.uniform(-175.0, J_SEA_X - 2), rnd.uniform(J_PLATEAU[2] + 2, J_PLATEAU[3] - 2)
        if x < J_PLATEAU[0] and abs(y - float(j_route_y(x))) > 10.5:
            continue
        if not ok(x, y, 1.2, 0.05) or in_grass_zone(x, y, 1.0, ZONES_J):
            continue
        r = rnd.random()
        if r < 0.3:
            add(rnd.choice(['bush_a', 'bush_b']), x, y, s=rnd.uniform(0.8, 1.2))
        elif r < 0.85:
            add(rnd.choice(['flower_patch', 'flower_patch_b']), x, y, s=rnd.uniform(0.8, 1.2))
        else:
            add('rock', x, y, s=rnd.uniform(0.4, 0.9))
    n_short = 4000 if QUICK else 15000
    got = 0
    tries = 0
    while got < n_short and tries < n_short * 6:
        tries += 1
        x, y = rnd.uniform(-178.0, J_SEA_X), rnd.uniform(J_PLATEAU[2] - 2, J_PLATEAU[3] + 2)
        if x < J_PLATEAU[0] and abs(y - float(j_route_y(x))) > 12.0:
            continue
        if not ok(x, y, 0.4, 0.35):
            continue
        add('grass_short', x, y, s=rnd.uniform(0.7, 1.35))
        got += 1
    for z in ZONES_J:
        if z['kind'] != 'tall_grass':
            continue
        x0, x1, y0, y1 = z['x0'], z['x1'], z['y0'], z['y1']
        for _ in range(int((x1 - x0) * (y1 - y0) * (0.9 if QUICK else 1.8))):
            x, y = rnd.uniform(x0, x1), rnd.uniform(y0, y1)
            if float(path_mask_j(x, y)) > 0.3 or reserved_j(x, y, 0.5):
                continue
            add(rnd.choice(['grass_tall', 'grass_tall_b']), x, y, s=rnd.uniform(0.8, 1.2))


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
def plaza_loop(r=4.2, n=6, cx=0.0, cy=-0.5):
    return [[round(cx + math.cos(a) * r, 2), round(cy + math.sin(a) * r, 2)] for a in (i / n * math.tau for i in range(n))]


def trainer(team, prize, before, after, sight=6.0, cls=''):
    """A trainer NPC: team [[species, level], ...] (species -1: the rival's counter to your starter)."""
    return {'team': team, 'prize': prize, 'before': before, 'after': after, 'sight': sight, 'class': cls}


# NPCs. place: a room id (then x, y come from the room's slot), or 'johto' (x, y in Johto coordinates), or Kanto outdoors.
# route: waypoints they walk along (loop=True: round and round, otherwise back and forth), speed in m/s, pause in seconds.
NPCS = [
    {'id': 'girl', 'name': 'Лиза', 'x': -2.4, 'y': -3.2, 'face': 2.2, 'look': 'girl',
     'lines': ['Я выращиваю цветы! Покемоны их очень любят.'], 'route': plaza_loop(), 'loop': True, 'speed': 0.9, 'pause': 2.5},
    {'id': 'rival', 'name': 'Гэри', 'x': 15.4, 'y': 6.6, 'face': -0.8, 'look': 'rival',
     'lines': ['Хе, наконец-то! Я выберу покемона сильнее твоего.', 'Мой дедушка — профессор Оук. Так что я всегда буду на шаг впереди!'],
     'trainer': trainer([[-1, 6], [16, 5]], 300,
                        ['Эй! Ты тоже получил покемона?', 'Давай проверим, чей сильнее!'],
                        ['Что?! Не может быть!', 'Ладно, это была просто разминка. В следующий раз я тебя одолею!'], sight=0.0, cls='Соперник')},
    {'id': 'jogger', 'name': 'Спортсменка Аня', 'x': 1.3, 'y': -30.0, 'face': math.pi / 2, 'look': 'student',
     'lines': ['Бег по утрам — лучшая тренировка! Для покемонов тоже.'],
     'route': [[1.3, -30.0], [1.3, 25.0], [38.5, 25.0], [38.5, -29.5], [1.3, -29.5]], 'loop': True, 'speed': 3.2, 'pause': 0.5},
    {'id': 'walker', 'name': 'Горожанка Нина', 'x': -19.8, 'y': -4.0, 'face': 0.0, 'look': 'walker',
     'lines': ['Покецентр — на западе, магазин — на востоке. Очень удобно!', 'А за магазином — рынок и вокзал. Оттуда ходит поезд в Джото!'],
     'route': [[-19.6, -4.0], [-6.0, -4.0], [6.0, -4.0], [20.0, -4.0]], 'loop': False, 'speed': 1.3, 'pause': 3.0},
    {'id': 'bugkid', 'name': 'Натуралистка Мила', 'x': -68.8, 'y': 30.0, 'face': math.pi, 'look': 'bugkid',
     'lines': ['В траве у леса живут покемоны-жуки: Катерпи, Видл, а иногда даже Парас!'],
     'route': [[-68.8, 25.0], [-68.8, 41.0]], 'loop': False, 'speed': 0.8, 'pause': 4.0},
    {'id': 'sailor', 'name': 'Морячка Рина', 'x': PIER[0], 'y': PIER[1] - PIER[2] + 2.0, 'face': -math.pi / 2, 'look': 'sailor',
     'lines': ['Говорят, за морем лежит остров Синнабар.', 'У берега водятся Тентакулы, Крабби и даже Старью!', 'С конца пристани хорошо клюёт. Есть удочка?']},
    # the pond and the park
    {'id': 'fisher', 'name': 'Рыбак Фёдор', 'x': DOCK[0] + 0.7, 'y': DOCK[1] + 3.0, 'face': math.pi / 2, 'look': 'hiker',
     'lines': ['В пруду живут Мэджикарпы, Голдины и Поливаги.', 'Встань на краю мостков и закинь удочку — главное, не прозевай поклёвку!']},
    {'id': 'parkgran', 'name': 'Бабушка Зина', 'x': -58.0 + 5.4 * math.cos(math.pi / 4), 'y': -18.0 + 5.4 * math.sin(math.pi / 4) + 0.8,
     'face': -math.pi * 0.75, 'look': 'mom',
     'lines': ['Какой чудесный фонтан! Его построили, когда я была ещё девочкой.', 'В парке часто гуляет Пикачу. Он любит, когда его угощают ягодами.']},
    {'id': 'kid', 'name': 'Малыш Тёма', 'x': -58.0, 'y': -24.5, 'face': 0.0, 'look': 'youngster',
     'lines': ['Я обегу фонтан сто раз! Уже… восемь!'], 'route': plaza_loop(6.6, 8, -58.0, -18.0), 'loop': True, 'speed': 2.6, 'pause': 0.2},
    {'id': 'youngster', 'name': 'Юнец Бен', 'x': -50.0, 'y': -23.0, 'face': math.pi * 0.75, 'look': 'youngster',
     'lines': ['Мой Раттата самый быстрый в городе!'],
     'trainer': trainer([[19, 5], [16, 5]], 80, ['Эй, ты! Мы встретились взглядами — значит, бой!'],
                        ['Ух ты, какой сильный покемон!', 'Надо больше тренироваться в высокой траве.'], cls='Юнец')},
    {'id': 'lass', 'name': 'Девочка Ира', 'x': -67.5, 'y': -9.5, 'face': math.pi * 1.25, 'look': 'lass',
     'lines': ['На качелях лучше всего думается о покемонах!'],
     'trainer': trainer([[39, 6], [29, 5]], 90, ['Привет! Мои покемоны милые, но очень сильные!'],
                        ['Ой… Ты победил. Но мои покемоны всё равно самые милые!'], sight=5.0, cls='Девочка')},
    {'id': 'bugcatcher', 'name': 'Ловец жуков Рома', 'x': -72.5, 'y': 29.0, 'face': 0.0, 'look': 'bugkid',
     'lines': ['Жуки — самые лучшие покемоны! Скоро мой Катерпи станет Баттерфри.'],
     'trainer': trainer([[10, 5], [13, 5], [10, 6]], 60, ['Стой! Я поймал этих жуков сам. Сразимся?'],
                        ['Мои жуки… Ладно, пойду ловить новых!'], cls='Ловец жуков')},
    {'id': 'swimmer', 'name': 'Пловец Дима', 'x': -22.0, 'y': -39.5, 'face': math.pi / 2, 'look': 'sailor',
     'lines': ['Вода сегодня отличная! Тентакулы только мешают плавать.'],
     'trainer': trainer([[72, 7], [116, 7]], 120, ['Эй, на берегу! Проверим, кто сильнее — суша или море?'],
                        ['Море сегодня было не на моей стороне…'], cls='Пловец')},
    {'id': 'hiker', 'name': 'Турист Гоша', 'x': 10.5, 'y': 104.0, 'face': math.pi, 'look': 'hiker',
     'lines': ['Иду через Маршрут 1 в Виридиан-Сити. Горы зовут!'],
     'trainer': trainer([[74, 8], [27, 8]], 160, ['Ха! Мои покемоны крепки, как скалы!'],
                        ['Вот это удар! Мои камни раскололись.'], cls='Турист')},
    # the station, the market and the lighthouse
    {'id': 'conductor', 'name': 'Проводница Оля', 'x': 68.4, 'y': STATION_Y + 6.0, 'face': math.pi, 'look': 'clerk',
     'lines': ['Поезд «Паллет — Нью-Барк» отправляется по первому слову! Подойдите к дверям вагона.', 'В Джото живут совсем другие покемоны: Сентрет, Хутхут, Марилл…']},
    {'id': 'traveler', 'name': 'Путешественник Лёва', 'x': 47.5, 'y': STATION_Y + 6.6, 'face': -math.pi / 2, 'look': 'walker',
     'lines': ['Я только что из Джото! Там, в Нью-Барке, живёт профессор Элм.', 'Говорят, он дарит начинающим тренерам редких покемонов.']},
    {'id': 'clerk_market', 'name': 'Торговка Вера', 'x': 54.0, 'y': -14.9, 'face': -math.pi / 2, 'look': 'clerk',
     'lines': ['Свежие ягоды! Покеболы! Зелья! Подходите!']},
    {'id': 'keeper', 'name': 'Смотритель маяка', 'x': 57.0, 'y': -41.5, 'face': math.pi, 'look': 'hiker',
     'lines': ['Маяк светит морякам уже сто лет.', 'По ночам к нему приплывают Лапрасы — я сам видел!']},
    {'id': 'gardener', 'name': 'Садовница Оля', 'x': -30.0, 'y': 24.0, 'face': -math.pi / 2, 'look': 'student',
     'lines': ['На северной аллее я посадила новые деревья. Скоро здесь будет тень!'],
     'route': [[-34.0, 24.0], [-24.0, 24.0]], 'loop': False, 'speed': 0.7, 'pause': 5.0},
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
    {'id': 'clubgirl', 'name': 'Администратор клуба', 'place': 'center', 'look': 'student',
     'lines': ['Клуб тренеров скоро откроется! Здесь можно будет меняться покемонами и сражаться.', 'А пока потренируйтесь с тренерами в парке и у леса.']},
    {'id': 'clerk', 'name': 'Продавщица Юки', 'place': 'mart', 'look': 'clerk',
     'lines': ['Добро пожаловать в магазин!']},
    {'id': 'shopper', 'name': 'Покупательница', 'place': 'mart', 'look': 'girl',
     'lines': ['Покеболы заканчиваются так быстро...', 'Суперболы ловят лучше обычных, но и стоят дороже.']},
    # ——— New Bark Town and Route 29 ———
    {'id': 'conductor_j', 'name': 'Проводник Стас', 'place': 'johto', 'x': -8.0, 'y': -22.6, 'face': 0.0, 'look': 'clerk',
     'lines': ['Добро пожаловать в Нью-Барк! Поезд в Паллет-таун ждёт у платформы.']},
    {'id': 'teacher_j', 'name': 'Учительница Аня', 'place': 'johto', 'x': -2.0, 'y': 4.5, 'face': -0.5, 'look': 'student',
     'lines': ['Нью-Барк — город, где дуют ветра новых начинаний.', 'Профессор Элм изучает эволюцию покемонов. Его лаборатория — на севере.'],
     'route': plaza_loop(4.4, 6, 4.0, 2.0), 'loop': True, 'speed': 0.8, 'pause': 3.0},
    {'id': 'fisher_j', 'name': 'Рыбак Миша', 'place': 'johto', 'x': PIER_J[0] + 4.0, 'y': PIER_J[1] + 0.9, 'face': 0.0, 'look': 'hiker',
     'lines': ['В море у Нью-Барка клюют Чинчоу и Ремораиды.', 'Удочки нет? Её даёт рыбак у пруда в Паллет-тауне.']},
    {'id': 'youngster_j', 'name': 'Юнец Джоуи', 'place': 'johto', 'x': -70.0, 'y': 1.0, 'face': 0.0, 'look': 'youngster',
     'lines': ['Мой Раттата — в топ-процентах всех Раттат!'],
     'trainer': trainer([[19, 9], [161, 9]], 180, ['Ты нездешний? Тогда сразимся по-джотски!'],
                        ['Мой Раттата… Он всё ещё в топ-процентах, честно!'], cls='Юнец')},
    {'id': 'lass_j', 'name': 'Девочка Кира', 'place': 'johto', 'x': -110.0, 'y': 9.5, 'face': 0.0, 'look': 'lass',
     'lines': ['Хоппипы так смешно летают на ветру!'],
     'trainer': trainer([[187, 9], [183, 10]], 190, ['Ты тоже собираешь покемонов? Покажи, на что способен!'],
                        ['Какой ты сильный! Мне надо ещё поучиться.'], sight=5.0, cls='Девочка')},
    {'id': 'guard_j', 'name': 'Рабочий Петрович', 'place': 'johto', 'x': -160.0, 'y': float(j_route_y(-160.0)), 'face': 0.0, 'look': 'hiker',
     'lines': ['Дальше — Черригроув-Сити, но мост через реку ещё ремонтируют.', 'Приходи позже! А пока поищи покемонов в траве.']},
    {'id': 'girl_j', 'name': 'Соседка Лина', 'place': 'johto', 'x': 30.0, 'y': 4.5, 'face': math.pi, 'look': 'girl',
     'lines': ['Ты приехал на поезде? Здорово! Загляни к профессору Элму.'],
     'route': [[20.0, 4.5], [40.0, 4.5]], 'loop': False, 'speed': 1.0, 'pause': 3.0},
    {'id': 'elm', 'name': 'Профессор Элм', 'place': 'elmlab', 'slot': 'oak', 'look': 'elm',
     'lines': ['Покемоны Джото удивительны! Изучать их — одно удовольствие.']},
    {'id': 'elmaide', 'name': 'Ассистент Элма', 'place': 'elmlab', 'slot': 'aide', 'look': 'tech',
     'lines': ['Профессор Элм открыл, что покемоны откладывают яйца!', 'Правда, пока никто не знает, откуда они берутся…']},
    {'id': 'nurse_j', 'name': 'Медсестра Джой', 'place': 'center_j', 'slot': 'nurse', 'look': 'nurse',
     'lines': ['Добро пожаловать в Покецентр Нью-Барка!']},
    {'id': 'visitor_j', 'name': 'Тренер Сэм', 'place': 'center_j', 'slot': 'visitor', 'look': 'walker',
     'lines': ['На Маршруте 29 живут Сентреты и Хоппипы. А по ночам — Хутхуты!']},
    {'id': 'clerk_j', 'name': 'Продавец Кен', 'place': 'mart_j', 'slot': 'clerk', 'look': 'clerk',
     'lines': ['Добро пожаловать!']},
    {'id': 'shopper_j', 'name': 'Покупатель', 'place': 'mart_j', 'slot': 'shopper', 'look': 'sailor',
     'lines': ['Здесь те же товары, что и в Канто. Удобно!']},
]

# Pokémon living in town (shown when their 3D model is installed). quest: only while that quest needs them.
# swim_z: it swims at that water level. johto: x, y are Johto coordinates.
AMBIENT = [
    {'species': 16, 'x': 3.0, 'y': -2.5, 'radius': 3.5},
    {'species': 16, 'x': -3.5, 'y': 2.0, 'radius': 3.0},
    {'species': 19, 'x': 21.0, 'y': 29.0, 'radius': 4.0},
    {'species': 10, 'x': -74.0, 'y': 33.0, 'radius': 3.0},
    {'species': 54, 'x': 14.0, 'y': -41.5, 'radius': 3.0},
    {'species': 133, 'x': 35.0, 'y': -38.5, 'radius': 1.0, 'quest': 'lost_eevee'},
    {'species': 54, 'x': -45.5, 'y': 18.5, 'radius': 2.0},
    {'species': 60, 'x': -59.0, 'y': 16.0, 'radius': 3.0, 'swim_z': POND_Z},
    {'species': 129, 'x': -52.0, 'y': 12.5, 'radius': 3.0, 'swim_z': POND_Z},
    {'species': 118, 'x': -61.0, 'y': 11.0, 'radius': 2.5, 'swim_z': POND_Z},
    {'species': 79, 'x': 55.0, 'y': -40.5, 'radius': 1.5},
    {'species': 98, 'x': 38.0, 'y': -42.0, 'radius': 3.0},
    {'species': 120, 'x': -30.0, 'y': -42.5, 'radius': 2.0},
    {'species': 131, 'x': -14.0, 'y': -66.0, 'radius': 6.0, 'swim_z': SEA_LEVEL},
    {'species': 72, 'x': 20.0, 'y': -55.0, 'radius': 5.0, 'swim_z': SEA_LEVEL},
    {'species': 58, 'x': 47.0, 'y': STATION_Y - 1.0, 'radius': 2.5},
    {'species': 52, 'x': 57.0, 'y': -20.0, 'radius': 4.0},
    {'species': 25, 'x': -52.0, 'y': -11.0, 'radius': 3.5},
    {'species': 39, 'x': -71.0, 'y': -12.0, 'radius': 2.0},
    {'species': 29, 'x': -30.0, 'y': 30.0, 'radius': 3.0},
    {'species': 12, 'x': -63.0, 'y': -26.0, 'radius': 3.0},
    {'species': 43, 'x': -72.0, 'y': 22.0, 'radius': 1.5},
    # New Bark Town and Route 29
    {'species': 161, 'x': -60.0, 'y': -2.0, 'radius': 4.0, 'johto': True},
    {'species': 163, 'x': -100.0, 'y': 10.0, 'radius': 3.0, 'johto': True},
    {'species': 187, 'x': -126.0, 'y': 4.0, 'radius': 3.0, 'johto': True},
    {'species': 183, 'x': J_SEA_X + 3.0, 'y': 14.0, 'radius': 2.5, 'johto': True},
    {'species': 194, 'x': J_SEA_X + 8.0, 'y': -14.0, 'radius': 3.0, 'johto': True},
    {'species': 172, 'x': 10.0, 'y': 0.0, 'radius': 3.0, 'johto': True},
    {'species': 175, 'x': 16.0, 'y': 8.0, 'radius': 1.5, 'johto': True},
    {'species': 170, 'x': PIER_J[0] + 26.0, 'y': PIER_J[1] + 4.0, 'radius': 4.0, 'swim_z': SEA_LEVEL, 'johto': True},
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
        dx, dy = door_pos(info['door'])
        tx, ty, tz = room_pt(rid, m['spawn'][0], m['spawn'][1])
        portals.append({'id': info['door'], 'kind': 'enter', 'x': dx, 'y': dy, 'z': 0.0, 'title': info['name'],
                        'tx': tx, 'ty': ty, 'tz': tz, 'tface': m['spawn'][2]})
        ex, ey, ez = room_pt(rid, m['exit'][0], m['exit'][1])
        of = info['out_face']
        portals.append({'id': rid + '_exit', 'kind': 'exit', 'x': ex, 'y': ey, 'z': ez, 'title': info['town'],
                        'tx': round(dx + math.cos(of) * 1.3, 3), 'ty': round(dy + math.sin(of) * 1.3, 3), 'tz': 0.0, 'tface': of})
        hx, hy = r['half']
        places.append({'id': rid, 'name': info['name'], 'indoor': True, 'x0': ox - hx, 'x1': ox + hx, 'y0': oy - hy, 'y1': oy + hy,
                       'z0': oz - 3.0, 'z1': oz + 8.0,
                       'lights': [[round(ox + x, 3), round(oy + y, 3), round(oz + z, 3), i] for (x, y, z, i) in m['lights']]})
        for key, (x, y) in m['spots'].items():
            qx, qy, qz = room_pt(rid, x, y)
            portals.append({'id': key + ('' if rid == 'center' else '_' + rid), 'kind': key, 'x': qx, 'y': qy, 'z': qz, 'title': 'Компьютер'})

    # the train: step aboard at the carriage door, get off on the other platform
    kanto_door = (RAIL_X - 1.9, STATION_Y + 3.0)
    johto_door = (JX + 9.0, JY + J_RAIL_Y + 1.9)
    portals.append({'id': 'train_kanto', 'kind': 'train', 'x': kanto_door[0], 'y': kanto_door[1], 'z': 0.4, 'title': 'Поезд в Нью-Барк',
                    'tx': JX + 9.0, 'ty': JY + J_RAIL_Y + 4.5, 'tz': 0.4, 'tface': math.pi / 2})
    portals.append({'id': 'train_johto', 'kind': 'train', 'x': johto_door[0], 'y': johto_door[1], 'z': 0.4, 'title': 'Поезд в Паллет-таун',
                    'tx': RAIL_X - 4.5, 'ty': STATION_Y + 3.0, 'tz': 0.4, 'tface': math.pi})
    # fishing spots: the end of the sea pier, the pond's jetty, New Bark's jetty
    portals.append({'id': 'fish_sea', 'kind': 'fishing', 'x': PIER[0], 'y': PIER[1] - PIER[2] + 1.2, 'z': 0.0, 'title': 'Рыбалка в море'})
    portals.append({'id': 'fish_pond', 'kind': 'fishing', 'x': DOCK[0], 'y': DOCK[1] + DOCK[2] - 0.9, 'z': 0.0, 'title': 'Рыбалка в пруду'})
    portals.append({'id': 'fish_johto', 'kind': 'fishing', 'x': JX + PIER_J[0] + PIER_J[2] - 1.2, 'y': JY + PIER_J[1], 'z': 0.0,
                    'title': 'Рыбалка в море Джото'})
    # signs and houses you can knock at
    signs = [
        ('sign_pallet', -5.2, 0.6, 'Паллет-таун', ['ПАЛЛЕТ-ТАУН', '«Оттенки невинности». На севере — Маршрут 1, на востоке — вокзал.']),
        ('sign_route1', 4.6, 43.4, 'Маршрут 1', ['МАРШРУТ 1', 'Паллет-таун — Виридиан-Сити. Осторожно: в высокой траве дикие покемоны!']),
        ('sign_station', 43.4, STATION_Y + 3.4, 'Вокзал', ['ВОКЗАЛ ПАЛЛЕТ-ТАУНА', 'Поезд в Нью-Барк (регион Джото) — с платформы за вокзалом.']),
        ('sign_park', -47.9, -15.0, 'Парк', ['ГОРОДСКОЙ ПАРК', 'Не бросайте покеболы в фонтан!']),
        ('sign_pond', -44.0, 6.2, 'Пруд', ['ПРУД ПАЛЛЕТ-ТАУНА', 'Рыбалка разрешена с мостков.']),
        ('sign_newbark', JX + 11.0, JY + 4.4, 'Нью-Барк', ['НЬЮ-БАРК', '«Ветер новых начинаний». Здесь живёт профессор Элм.']),
        ('sign_route29', JX + J_PLATEAU[0] - 1.0, JY + 6.9, 'Маршрут 29', ['МАРШРУТ 29', 'Нью-Барк — Черригроув-Сити.']),
        ('sign_station_j', JX - 2.5, JY - 8.4, 'Вокзал', ['ВОКЗАЛ НЬЮ-БАРКА', 'Поезд в Паллет-таун (регион Канто) — с платформы за вокзалом.']),
    ]
    for sid, x, y, title, lines in signs:
        portals.append({'id': sid, 'kind': 'sign', 'x': x, 'y': y, 'z': 0.0, 'title': title, 'lines': lines})
    knock = {
        'RivalHouse': ('Дом Гэри', ['Дейзи: Гэри? Он где-то на улице, хвастается перед всеми.', 'Хочешь, я расскажу тебе о покемонах? В высокой траве живут дикие покемоны!']),
        'RivalTower': ('Башня', ['Заперто. На двери табличка: «Обсерватория. Не беспокоить».']),
        'NeighbourHouse': ('Дом соседей', ['Изнутри доносится: «Покемоны — лучшие друзья человека!»']),
        'HouseW1': ('Дом у пруда', ['Из-за двери: «Если увидите Псидака у пруда — не пугайте его, он и так всё время в растерянности!»']),
        'HouseW2': ('Дом лесника', ['Никто не отвечает. На двери записка: «Ушёл в лес. Вернусь к ужину».']),
        'HouseE1': ('Дом машиниста', ['Из-за двери: «Я двадцать лет вожу поезд в Джото. Там совсем другие покемоны!»']),
        'HouseE2': ('Дом у вокзала', ['Слышно, как громко тикают часы. Похоже, хозяева уехали на поезде.']),
        'HouseS1': ('Дом у моря', ['Из-за двери: «С пристани в бинокль иногда видно Лапраса!»']),
        'HouseS2': ('Дом рыбака', ['Из-за двери: «Удочку даёт Фёдор у пруда. Без удочки рыбу не поймаешь!»']),
        'J_PlayerHouse': ('Дом в Нью-Барке', ['Из-за двери: «Наш сын уехал путешествовать с Тотодайлом. Мы так скучаем!»']),
        'J_House2': ('Дом соседей', ['Из-за двери: «Профессор Элм опять засиделся в лаборатории до утра».']),
        'J_House3': ('Дом у вокзала', ['Никто не отвечает.']),
        'J_Station': ('Вокзал Нью-Барка', ['Двери вокзала открыты, внутри никого. Поезд ждёт у платформы.']),
        'Station': ('Вокзал', ['В зале ожидания тихо. Поезд в Нью-Барк стоит у платформы за вокзалом.']),
    }
    for key, (title, lines) in knock.items():
        x, y = door_pos(key)
        portals.append({'id': key, 'kind': 'house', 'x': x, 'y': y, 'z': 0.0, 'title': title, 'lines': lines})

    fz = next(z for z in ZONES if z['route'] == 'forest')
    places += [
        {'id': 'pier', 'name': 'Пристань', 'x0': PIER[0] - 2.5, 'x1': PIER[0] + 2.5, 'y0': PIER[1] - PIER[2] - 1.0, 'y1': PIER[1] - 1.0},
        {'id': 'forest_edge', 'name': 'Опушка леса', 'x0': fz['x0'] - 4.0, 'x1': fz['x1'] + 4.0, 'y0': fz['y0'] - 3.0, 'y1': fz['y1'] + 4.0},
        {'id': 'pond', 'name': 'Пруд', 'x0': -78.0, 'x1': -42.0, 'y0': 3.5, 'y1': 23.5},
        {'id': 'park', 'name': 'Городской парк', 'x0': -80.0, 'x1': -45.0, 'y0': -30.0, 'y1': -6.0},
        {'id': 'station', 'name': 'Вокзал Паллет-тауна', 'x0': 44.0, 'x1': 80.0, 'y0': -12.0, 'y1': 20.0},
        {'id': 'market', 'name': 'Рынок', 'x0': 42.0, 'x1': 68.0, 'y0': -27.0, 'y1': -13.0},
        {'id': 'lighthouse', 'name': 'Маяк', 'x0': 50.0, 'x1': 70.0, 'y0': -54.0, 'y1': -37.0},
        {'id': 'shore', 'name': 'Берег Паллет-тауна', 'x0': X0, 'x1': X1, 'y0': Y0 - 50.0, 'y1': PLATEAU[2]},
        {'id': 'route1', 'name': 'Маршрут 1', 'x0': X0, 'x1': X1, 'y0': PLATEAU[3] + 1.0, 'y1': Y1 + 50.0},
        {'id': 'pallet', 'name': 'Паллет-таун', 'x0': X0 - 50.0, 'x1': X1 + 50.0, 'y0': PLATEAU[2], 'y1': PLATEAU[3] + 1.0},
        # Johto
        {'id': 'station_j', 'name': 'Вокзал Нью-Барка', 'x0': JX - 16.0, 'x1': JX + 24.0, 'y0': JY - 34.0, 'y1': JY - 19.5},
        {'id': 'shore_j', 'name': 'Берег Нью-Барка', 'x0': JX + J_SEA_X, 'x1': JX + 400.0, 'y0': JY - 300.0, 'y1': JY + 300.0},
        {'id': 'route29', 'name': 'Маршрут 29', 'x0': JX - 200.0, 'x1': JX + J_PLATEAU[0], 'y0': JY - 90.0, 'y1': JY + 90.0},
        {'id': 'newbark', 'name': 'Нью-Барк', 'x0': JX + J_PLATEAU[0], 'x1': JX + J_SEA_X, 'y0': JY - 90.0, 'y1': JY + 90.0},
    ]
    npcs = []
    for n in NPCS:
        n = dict(n)
        rid = n.pop('place', None)
        slot = n.pop('slot', None)
        if rid == 'johto':
            x, y = n['x'], n['y']
            n['z'] = float(height_j(x, y))
            n['x'], n['y'] = round(x + JX, 3), round(y + JY, 3)
            if 'route' in n:
                n['route'] = [[round(a + JX, 2), round(b + JY, 2)] for a, b in n['route']]
        elif rid:
            x, y, face = rooms[rid]['meta']['npcs'][slot or n['id']]
            n['x'], n['y'], n['z'] = room_pt(rid, x, y)
            n['face'] = face
        else:
            n['z'] = float(height(n['x'], n['y']))
        npcs.append(n)
    ambient = []
    for a in AMBIENT:
        a = dict(a)
        if a.pop('johto', False):
            a['z'] = float(height_j(a['x'], a['y']))
            a['x'], a['y'] = a['x'] + JX, a['y'] + JY
        else:
            a['z'] = float(height(a['x'], a['y']))
        ambient.append(a)
    doors = {k: {'x': v[0], 'y': v[1]} for k, v in DOORS.items()}
    doors.update({k: {'x': door_pos(k)[0], 'y': door_pos(k)[1]} for k in DOORS_J})
    out = {
        'player_start': {'x': px, 'y': py, 'z': pz, 'face': sf},
        'doors': doors,
        'portals': portals,
        'places': places,
        'npcs': npcs,
        'ambient': ambient,
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
        'waters': [{'x': POND[0], 'y': POND[1], 'rx': round(POND[2] * 1.05, 3), 'ry': round(POND[3] * 1.05, 3), 'z': POND_Z}],
        'markers': marks,
        'encounter_zones': zones,
        'instances': {k: [[round(v, 3) for v in it] for it in items] for k, items in inst.items() if items},
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
    step = 1.0 if not QUICK else 2.0
    for t in (build_terrain('Terrain', height, path_mask, sand_mask, (X0, X1, Y0, Y1), step=step),
              build_terrain('TerrainJohto', height_j, path_mask_j, sand_mask_j, J_BOUNDS, (JX, JY), step=step)):
        bpy.context.scene.collection.objects.unlink(t)
        town.objects.link(t)
    for w in build_water():
        bpy.context.scene.collection.objects.unlink(w)
        town.objects.link(w)
    place_town(kit, town)
    place_johto(kit, town)
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
            ('town_wide', (0.0, -95.0, 70.0), (0.0, 0.0, 0.0), 22),
            ('route1', (0.5, 46.0, 2.0), (-2.0, 80.0, 1.0), 26),
            ('lab', (-2.0, -0.5, 2.2), (9.0, -16.0, 3.0), 26),
            ('pokecenter', (-11.0, -9.0, 2.4), (-27.0, -3.0, 3.2), 26),
            ('mart', (11.0, 0.5, 2.4), (27.0, -4.5, 3.0), 26),
            ('beach', (6.0, -31.0, 3.2), (-6.0, -52.0, 0.0), 24),
            ('pond', (-40.0, -2.0, 5.0), (-56.0, 14.0, 0.0), 24),
            ('park', (-44.0, -30.0, 6.0), (-62.0, -15.0, 1.0), 24),
            ('station', (40.0, -6.0, 6.0), (62.0, 8.0, 2.0), 22),
            ('platform', (66.0, -14.0, 3.0), (72.0, 20.0, 2.0), 24),
            ('market', (40.0, -27.0, 3.5), (58.0, -18.0, 1.5), 24),
            ('lighthouse', (40.0, -38.0, 4.0), (60.0, -45.0, 6.0), 24),
            ('newbark', (JX - 20.0, JY - 6.0, 6.0), (JX + 8.0, JY + 14.0, 2.0), 22),
            ('newbark_overview', (JX + 40.0, JY - 70.0, 40.0), (JX - 10.0, JY + 0.0, 0.0), 22),
            ('route29', (JX - 44.0, JY + 2.0, 3.0), (JX - 80.0, JY + 4.0, 1.0), 24),
            ('newbark_station', (JX - 20.0, JY - 22.0, 3.5), (JX + 10.0, JY - 27.0, 2.0), 22),
            ('newbark_beach', (JX + 30.0, JY + 12.0, 4.0), (JX + 60.0, JY - 6.0, 0.0), 24),
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
            if only and name not in only.split(','):
                continue
            cam = render.camera('cam_' + name, loc, look, lens)
            render.render(cam, os.path.join(SHOTS, f'{name}.png'))


main()
