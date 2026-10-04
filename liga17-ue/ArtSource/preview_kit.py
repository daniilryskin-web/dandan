"""Builds the art kit and renders a line-up of every asset (quick visual check)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402

import assets  # noqa: E402
import render  # noqa: E402
from common import MB, clear_scene, instance  # noqa: E402

OUT = sys.argv[-1] if len(sys.argv) > 1 and sys.argv[-1].endswith('.png') else '/tmp/kit.png'

clear_scene()
kit = assets.build_kit()
for o in kit.values():
    o.hide_render = True
mb = MB()
mb.box('grass', (0, 0, -0.05), (120, 80, 0.1))
mb.build('ground')

row1 = ['house_player', 'house_rival', 'oak_lab', 'house_small']
x = -30
for n in row1:
    o = kit[n]
    w = o.dimensions.x
    instance(o, n + '_i', (x + w / 2, 6, 0))
    x += w + 4
row2 = ['fence', 'mailbox', 'sign_pallet', 'sign_route1', 'lamp_post', 'bench', 'tree_a', 'tree_b', 'tree_c', 'pine', 'bush_a', 'bush_b',
        'hedge', 'flower_bed', 'flower_patch', 'flower_patch_b', 'grass_tall', 'grass_tall_b', 'grass_short', 'rock']
x = -34
for n in row2:
    o = kit[n]
    w = max(1.2, o.dimensions.x)
    instance(o, n + '_i', (x + w / 2, -8, 0))
    x += w + 1.0

render.setup_render(1280, 720, samples=24)
render.setup_sky()
cam = render.camera('cam', (2, -40, 16), (2, 0, 3), lens=30)
render.render(cam, OUT)
cam2 = render.camera('cam2', (-14, -17, 3.2), (-14, -8, 0.6), lens=24)
render.render(cam2, OUT.replace('.png', '_props.png'))
cam3 = render.camera('cam3', (-6, -9, 4.0), (-12, 6, 4), lens=30)
render.render(cam3, OUT.replace('.png', '_front.png'))
for n, o in kit.items():
    print(n, len(o.data.polygons), 'faces', tuple(round(v, 2) for v in o.dimensions))
