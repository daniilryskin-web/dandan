"""Лига 17 — the cast: anime (VRoid) models for the player and the NPCs.

All models are the official VRoid Studio sample characters that pixiv released under CC0
(the licence is also stored inside every .vrm file: meta.licenseName == "CC0").
They are mirrored in https://github.com/madjin/vrm-samples (vroid/beta), pinned below by commit and SHA-256.

The Unreal setup script (Content/Python/liga_setup.py) downloads them into ArtSource/Characters/ and imports
them with the VRM4U plugin. Oak.vrm is not downloaded: this script makes it from Sakurada Fumiriya
(silver hair, light coat, brown trousers) and it is shipped in the repository.

Run:  python characters.py        (needs Pillow; downloads the source model, writes Characters/Oak.vrm and cast.json)
"""
import hashlib
import io
import json
import os
import struct
import urllib.request

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'Characters')
COMMIT = 'e16eb187100149a315ad92c3c9968f1d5baa6c7d'
BASE = f'https://raw.githubusercontent.com/madjin/vrm-samples/{COMMIT}/vroid/beta/'

SOURCES = {
    'HairSample_Male': '7aeca142dabbc26ba0f5b9c998c8f3cb6df341287d67788427ac837223785a3f',
    'Sakurada_Fumiriya': 'd8fb05f33e377df028cb6b9d58c441ce68326c41fa23f6c735d40c65ae3dc710',
    'Victoria_Rubin': 'b1372131bdbf233f46320146d565f342a7e4f6f4b8f2aefb301f1a283ec07e1e',
    'Vivi': 'eaf902e041a7a810f1423599ae75682f61184ab6ef0206da9a8ed9caa8ec3a9d',
    'Vita': 'f2bf78f28a24e2f75f5ca0b6c3b646654c394e4b03592dfaa0d0633ef0972b4d',
    'Darkness_Shibu': '0b50573d2d054d98c0a6fc5a5ce872e1b2c8bff8718476ff72a9a68c48674fd8',
}

# role -> (file in Characters/, source model). The role keys match the NPC ids in town.py, plus 'player'.
CAST = {
    'player': ('Player.vrm', 'HairSample_Male'),
    'rival': ('Rival.vrm', 'Sakurada_Fumiriya'),
    'oak': ('Oak.vrm', None),
    'mom': ('Mom.vrm', 'Victoria_Rubin'),
    'girl': ('Girl.vrm', 'Vivi'),
    'tech': ('Tech.vrm', 'Vita'),
    'sailor': ('Sailor.vrm', 'Darkness_Shibu'),
}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def fetch(name):
    """Source model bytes (cached next to the outputs, checked against the pinned hash)."""
    cache = os.path.join(OUT, '_src', name + '.vrm')
    if os.path.exists(cache):
        data = open(cache, 'rb').read()
    else:
        with urllib.request.urlopen(BASE + name + '.vrm', timeout=120) as r:
            data = r.read()
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        open(cache, 'wb').write(data)
    if sha256(data) != SOURCES[name]:
        raise RuntimeError(f'{name}: unexpected SHA-256')
    return data


# ——— minimal GLB/VRM reader-writer ———

def read_glb(data):
    magic, _ver, _total = struct.unpack('<III', data[:12])
    assert magic == 0x46546C67, 'not a glb'
    clen = struct.unpack('<I', data[12:16])[0]
    gltf = json.loads(data[20:20 + clen])
    off = 20 + clen
    blen = struct.unpack('<I', data[off:off + 4])[0]
    return gltf, data[off + 8:off + 8 + blen]


def write_glb(gltf, views):
    """views: list of bytes, one per bufferView (rewritten with fresh 4-byte aligned offsets)."""
    blob = bytearray()
    for i, v in enumerate(views):
        while len(blob) % 4:
            blob.append(0)
        bv = gltf['bufferViews'][i]
        bv['byteOffset'] = len(blob)
        bv['byteLength'] = len(v)
        blob += v
    while len(blob) % 4:
        blob.append(0)
    gltf['buffers'][0]['byteLength'] = len(blob)
    js = json.dumps(gltf, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    js += b' ' * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(blob)
    return (struct.pack('<III', 0x46546C67, 2, total) + struct.pack('<II', len(js), 0x4E4F534A) + js
            + struct.pack('<II', len(blob), 0x004E4942) + bytes(blob))


def split_views(gltf, bin_):
    out = []
    for bv in gltf['bufferViews']:
        o = bv.get('byteOffset', 0)
        out.append(bin_[o:o + bv['byteLength']])
    return out


def image_index(gltf, name):
    return next(i for i, im in enumerate(gltf['images']) if im.get('name') == name)


def recolor(img, fn):
    """Applies fn(luminance 0..1) -> (r, g, b) 0..1 to every pixel, keeping alpha."""
    img = img.convert('RGBA')
    r, g, b, a = img.split()
    lum = Image.merge('RGB', (r, g, b)).convert('L')
    lut = [fn(i / 255.0) for i in range(256)]
    chans = [lum.point([max(0, min(255, int(round(c[k] * 255)))) for c in lut]) for k in range(3)]
    return Image.merge('RGBA', (*chans, a))


def srgb_to_linear(c):
    return [((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c]


def make_oak(src):
    gltf, bin_ = read_glb(src)
    views = split_views(gltf, bin_)
    vrm = gltf['extensions']['VRM']

    # Hair and brows: their textures are greyscale, the colour comes from the MToon material colours.
    silver, silver_shade = [0.86, 0.87, 0.9, 1.0], [0.5, 0.53, 0.62, 1.0]
    brow = [0.58, 0.58, 0.6, 1.0]
    for mp in vrm['materialProperties']:
        vp = mp['vectorProperties']
        if '_HAIR' in mp['name']:
            vp['_Color'], vp['_ShadeColor'] = list(silver), list(silver_shade)
        elif 'FaceBrow' in mp['name']:
            vp['_Color'], vp['_ShadeColor'] = list(brow), list(brow)
    for m in gltf['materials']:
        pbr = m.get('pbrMetallicRoughness', {})
        if '_HAIR' in m['name']:
            pbr['baseColorFactor'] = srgb_to_linear(silver[:3]) + [1.0]
        elif 'FaceBrow' in m['name']:
            pbr['baseColorFactor'] = srgb_to_linear(brow[:3]) + [1.0]

    def coat(l):  # navy vest + white shirt -> one light, slightly cool coat that keeps the seams
        v = 0.66 + 0.34 * min(1.0, l / 0.9) ** 0.6
        return (v * 0.97, v * 0.98, v)

    def trousers(l):  # near-black -> warm brown
        k = min(1.0, 0.55 + 1.5 * l)
        return (0.46 * k, 0.33 * k, 0.22 * k)

    def tie(l):  # neck accessory -> maroon
        k = min(1.0, 0.45 + 0.9 * l)
        return (0.56 * k, 0.12 * k, 0.15 * k)

    for name, fn in (('M00_001_Tops_01', coat), ('M00_001_Bottoms_01', trousers), ('M00_001_Accessory_01', tie)):
        i = image_index(gltf, name)
        bv = gltf['images'][i]['bufferView']
        img = recolor(Image.open(io.BytesIO(views[bv])), fn)
        buf = io.BytesIO()
        img.save(buf, 'PNG', optimize=True)
        views[bv] = buf.getvalue()

    meta = vrm['meta']
    meta['title'] = 'Professor (Liga 17)'
    meta['author'] = 'pixiv VRoid sample model, recoloured for Liga 17'
    meta['reference'] = 'VRoid Studio sample model "Sakurada Fumiriya" (CC0)'
    meta['licenseName'] = 'CC0'
    return write_glb(gltf, views)


def main():
    os.makedirs(OUT, exist_ok=True)
    oak = make_oak(fetch('Sakurada_Fumiriya'))
    open(os.path.join(OUT, 'Oak.vrm'), 'wb').write(oak)
    roles = {}
    for role, (file, src) in CAST.items():
        if src:
            roles[role] = {'file': file, 'source': src, 'url': BASE + src + '.vrm', 'sha256': SOURCES[src]}
        else:
            roles[role] = {'file': file, 'source': 'Sakurada_Fumiriya (recoloured by characters.py)', 'sha256': sha256(oak)}
    cast = {
        'about': 'VRoid Studio sample models by pixiv, CC0 (licence stored in each file). Mirror: github.com/madjin/vrm-samples',
        'commit': COMMIT,
        'roles': roles,
    }
    with open(os.path.join(OUT, 'cast.json'), 'w', encoding='utf-8') as f:
        json.dump(cast, f, ensure_ascii=False, indent=2)
    print('Oak.vrm', len(oak), 'bytes; cast.json written')


if __name__ == '__main__':
    main()
