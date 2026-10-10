"""Лига 17 — 3D Pokémon models for battles.

Models come from the public repository https://github.com/Pokemon-3D-api/assets (pinned commit below).
As that repository states, the models are the property of Nintendo / Creatures Inc. / GAME FREAK inc. —
they are downloaded on your own computer for a personal fan game, like the HOME pictures, and are not part of
this project's repository. Do not publish or sell a game that contains them.

The files use Draco mesh compression and WebP textures. Each one is converted to a plain .glb (DracoPy, Pillow):
the helper sphere every file carries is dropped, the parts are joined into one mesh, broken bones and animation
keys are repaired, a model without a skeleton gets one (_autorig), the body is centred over the origin, grey flame
masks of Fire types are coloured, and idle / walk / attack / faint clips are made for the body plan (_Rig). The result
is imported with Unreal's glTF importer into /Game/Liga/Pokemon3D/V<converter version>/P<id>.
Pokémon without a model, or whose file cannot be repaired, keep their HOME picture.

Used by liga_setup.py for the Pokémon the game can show. To import every available model (about 1 GB and a long
wait), run liga_pokemon3d_all.py with Tools → Execute Python Script….
"""
import importlib
import io
import json
import os
import re
import struct
import subprocess
import sys
import time
import urllib.request

import unreal

COMMIT = '429de1288cea0d43f5b4f56305d2276e94239d65'
BASE = f'https://raw.githubusercontent.com/Pokemon-3D-api/assets/{COMMIT}/models/opt'

# Pokémon the game can show: the whole Pokédex of Kanto and Johto (No. 1–251) — the wild ones, and the ones that only
# come by evolution (Crobat, Espeon, Steelix…) or by trade.
GAME_SPECIES = list(range(1, 252))
# Shiny models are imported only for these (a shiny of another species shows its HOME picture): the starters of both
# regions, Pikachu and Eevee with their evolutions. Importing every shiny would double the first setup.
SHINY_SPECIES = {1, 2, 3, 4, 5, 6, 7, 8, 9, 25, 26, 133, 134, 135, 136, 152, 153, 154, 155, 156, 157, 158, 159, 160}

PROJECT = os.path.abspath(unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir()))
CACHE = os.path.join(PROJECT, 'Saved', 'Liga', 'Pokemon3D')
SITE = os.path.join(PROJECT, 'Content', 'Python', 'Lib', 'site-packages')

# Bump when convert() changes: models are imported again into a new folder, and the old folders are deleted.
CONVERTER_VERSION = 7
DEST_ROOT = '/Game/Liga/Pokemon3D'
DEST = f'{DEST_ROOT}/V{CONVERTER_VERSION}'
OLD_DESTS = ['/Game/Liga/Pokemon']  # converter versions 1–3
VERSION_FILE = os.path.join(CACHE, 'converter_version.txt')
GUARD = os.path.join(CACHE, 'importing.json')   # the model being imported right now
CRASHES = os.path.join(CACHE, 'crashes.json')   # {model: how many times the editor died while importing it}
OLD_SKIP = os.path.join(CACHE, 'skip.json')     # earlier versions skipped a model after one crash
CRASHES_TO_SKIP = 2  # one crash is often the whole editor running out of memory, not the model: it gets one more try
VSM = 'r.Shadow.Virtual.Enable'

IDLE = re.compile(r'idle|wait|stand|loop|armatureaction|take ?0*1', re.I)
ATTACK = re.compile(r'attack|fight|atk|impact|thunder|trueno|bolt|punch|bite|tackle|scratch', re.I)
FAINT = re.compile(r'\bko\b|faint|down|dead|_ko|\|ko|ko$', re.I)
WALK = re.compile(r'walk|(?<![a-z])run', re.I)
OTHER = re.compile(r'sleep|landing|jump|turn|dizzy|appear', re.I)  # loops that are no idle (Wigglytuff slept)


def clip_role(name):
    """'idle' / 'walk' / 'attack' / 'faint' / None for an animation name (the same rules for files and for assets)."""
    if WALK.search(name):
        return 'walk'
    if OTHER.search(name):
        return None
    for role, rx in (('idle', IDLE), ('attack', ATTACK), ('faint', FAINT)):
        if rx.search(name):
            return role
    return None


# ——— Python packages (installed into the project, not into the engine) ———

def ensure_packages(log=print):
    if SITE not in sys.path:
        sys.path.append(SITE)
    try:
        import DracoPy  # noqa: F401
        import numpy  # noqa: F401
        from PIL import Image  # noqa: F401
        return True
    except ImportError:
        pass
    candidates = [os.path.join(sys.base_prefix, 'python.exe'),
                  os.path.join(unreal.Paths.convert_relative_path_to_full(unreal.Paths.engine_dir()), 'Binaries', 'ThirdParty', 'Python3', 'Win64', 'python.exe')]
    py = next((p for p in candidates if os.path.exists(p)), None)
    if py is None:
        raise RuntimeError('не найден python.exe движка')
    log('устанавливаю пакеты Python для 3D-моделей (numpy, DracoPy, Pillow)…')
    os.makedirs(SITE, exist_ok=True)
    cmd = [py, '-m', 'pip', 'install', '--disable-pip-version-check', '--target', SITE, 'numpy', 'DracoPy', 'Pillow']
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError('pip: ' + (r.stderr or r.stdout)[-600:])
    importlib.invalidate_caches()
    import DracoPy  # noqa: F401
    import numpy  # noqa: F401
    from PIL import Image  # noqa: F401
    return True


# ——— .glb conversion ———

def _read_glb(data):
    if struct.unpack('<I', data[:4])[0] != 0x46546C67:
        raise ValueError('not a glb')
    clen = struct.unpack('<I', data[12:16])[0]
    gltf = json.loads(data[20:20 + clen])
    off = 20 + clen
    blen = struct.unpack('<I', data[off:off + 4])[0] if off + 8 <= len(data) else 0
    return gltf, data[off + 8:off + 8 + blen]


def _write_glb(gltf, views):
    blob = bytearray()
    for i, v in enumerate(views):
        while len(blob) % 4:
            blob.append(0)
        bv = gltf['bufferViews'][i]
        bv['byteOffset'] = len(blob)
        bv['byteLength'] = len(v)
        bv['buffer'] = 0
        blob += v
    while len(blob) % 4:
        blob.append(0)
    gltf['buffers'] = [{'byteLength': len(blob)}]
    js = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
    js += b' ' * ((4 - len(js) % 4) % 4)
    return (struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob)) + struct.pack('<II', len(js), 0x4E4F534A) + js
            + struct.pack('<II', len(blob), 0x004E4942) + bytes(blob))


_NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
_DTYPE = {5120: 'i1', 5121: 'u1', 5122: '<i2', 5123: '<u2', 5125: '<u4', 5126: '<f4'}


def _accessor(gltf, views, index):
    import numpy as np
    a = gltf['accessors'][index]
    bv = gltf['bufferViews'][a['bufferView']]
    n = _NCOMP[a['type']]
    dt = np.dtype(_DTYPE[a['componentType']])
    raw = views[a['bufferView']]
    stride = bv.get('byteStride') or n * dt.itemsize
    off = a.get('byteOffset', 0)
    rows = [np.frombuffer(raw, dtype=dt, count=n, offset=off + i * stride) for i in range(a['count'])] if stride != n * dt.itemsize else None
    if rows is not None:
        return np.array(rows)
    return np.frombuffer(raw, dtype=dt, count=a['count'] * n, offset=off).reshape(a['count'], n)


def _merge_skins(gltf, views, add_view):
    """Several skins in one file (e.g. Blastoise's body and cannons) -> one skin, so the importer sees one skeleton."""
    import numpy as np
    skins = gltf.get('skins', [])
    if len(skins) < 2:
        return
    users = {}
    for node in gltf.get('nodes', []):
        if 'mesh' in node and 'skin' in node:
            users.setdefault(node['mesh'], set()).add(node['skin'])
    if any(len(v) > 1 for v in users.values()):
        return  # a mesh shared by different skins: leave the file as it is
    joints, ibms = [], []
    luts = []
    for skin in skins:
        ibm = _accessor(gltf, views, skin['inverseBindMatrices']) if 'inverseBindMatrices' in skin else np.tile(np.eye(4, dtype=np.float32).reshape(1, 16), (len(skin['joints']), 1))
        lut = []
        for k, j in enumerate(skin['joints']):
            if j not in joints:
                joints.append(j)
                ibms.append(np.asarray(ibm[k], dtype=np.float32))
            lut.append(joints.index(j))
        luts.append(np.array(lut, dtype=np.uint16))
    for mesh_index, skin_set in users.items():
        lut = luts[next(iter(skin_set))]
        for prim in gltf['meshes'][mesh_index]['primitives']:
            for name, ai in list(prim['attributes'].items()):
                if name.startswith('JOINTS_'):
                    data = lut[np.minimum(_accessor(gltf, views, ai).astype(np.int64), len(lut) - 1)].astype(np.uint16)
                    gltf['accessors'].append({'bufferView': add_view(np.ascontiguousarray(data).tobytes(), 34962), 'byteOffset': 0,
                                              'componentType': 5123, 'count': int(data.shape[0]), 'type': 'VEC4'})
                    prim['attributes'][name] = len(gltf['accessors']) - 1
    ibm_data = np.ascontiguousarray(np.array(ibms, dtype=np.float32))
    gltf['accessors'].append({'bufferView': add_view(ibm_data.tobytes()), 'byteOffset': 0, 'componentType': 5126,
                              'count': int(ibm_data.shape[0]), 'type': 'MAT4'})
    merged = {'joints': joints, 'inverseBindMatrices': len(gltf['accessors']) - 1}
    if 'skeleton' in skins[0]:
        merged['skeleton'] = skins[0]['skeleton']
    gltf['skins'] = [merged]
    for node in gltf['nodes']:
        if 'skin' in node:
            node['skin'] = 0


_REST = {'translation': (0.0, 0.0, 0.0), 'rotation': (0.0, 0.0, 0.0, 1.0), 'scale': (1.0, 1.0, 1.0)}
_LIMIT = 1e5  # no bone of these models moves or scales this far; bigger values are garbage


def _float_keys(gltf, views, index):
    import numpy as np
    acc = gltf['accessors'][index]
    arr = _accessor(gltf, views, index).astype(np.float64)
    if acc['componentType'] != 5126 and acc.get('normalized'):
        arr = np.maximum(arr / {5120: 127.0, 5121: 255.0, 5122: 32767.0, 5123: 65535.0}[acc['componentType']], -1.0)
    return arr


def _fix_keys(path, arr, rest):
    """Non-finite or absurd keys -> the rest value; rotations normalised (a zero quaternion -> the rest rotation)."""
    import numpy as np
    arr = np.array(arr, dtype=np.float64)
    rest = np.array(rest, dtype=np.float64)
    bad = ~np.isfinite(arr).all(axis=1) | (np.abs(np.nan_to_num(arr)).max(axis=1) > _LIMIT)
    arr[bad] = rest
    if path == 'rotation':
        norm = np.linalg.norm(arr, axis=1, keepdims=True)
        arr = np.where(norm > 1e-6, arr / np.maximum(norm, 1e-12), rest)
    return arr.astype(np.float32)


def _local_matrix(node):
    import numpy as np
    if 'matrix' in node:
        return np.array(node['matrix'], dtype=np.float64).reshape(4, 4).T
    x, y, z, w = node.get('rotation', _REST['rotation'])
    rot = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    m = np.eye(4)
    m[:3, :3] = rot * np.array(node.get('scale', _REST['scale']), dtype=np.float64)
    m[:3, 3] = node.get('translation', _REST['translation'])
    return m


def _world_matrix(gltf, index):
    nodes = gltf['nodes']
    parent = {c: i for i, n in enumerate(nodes) for c in n.get('children', [])}
    m, seen = _local_matrix(nodes[index]), {index}
    while index in parent and parent[index] not in seen:
        index = parent[index]
        seen.add(index)
        m = _local_matrix(nodes[index]) @ m
    return m


def _sanitize_transforms(gltf, views, add_view):
    """Rest poses and animation keys that Unreal can turn into a crash: NaN, inf, huge values, zero quaternions,
    times going backwards. Bad keys get the bone's rest value; a track that cannot be repaired is dropped."""
    import numpy as np
    nodes = gltf.get('nodes', [])
    for node in nodes:
        if 'matrix' in node:
            m = np.array(node['matrix'], dtype=np.float64)
            if not np.isfinite(m).all() or np.abs(m).max() > _LIMIT:
                node.pop('matrix')
        for path, rest in _REST.items():
            if path in node:
                node[path] = [float(x) for x in _fix_keys(path, [node[path]], rest)[0]]

    # Bind poses: some unused bones (Bulbasaur's feelers) have inverse bind matrices that put them 30 000 km away.
    # Unreal builds the reference skeleton from them, and such bone matrices overflow on the GPU. A bind matrix that
    # is huge or not invertible is rebuilt from the bone's rest pose.
    for skin in gltf.get('skins', []):
        if 'inverseBindMatrices' not in skin:
            continue
        ibm = _accessor(gltf, views, skin['inverseBindMatrices']).astype(np.float64).reshape(-1, 4, 4)
        changed = False
        for k, j in enumerate(skin['joints'][:len(ibm)]):
            m = ibm[k]
            if np.isfinite(m).all() and np.abs(m).max() <= _LIMIT and abs(np.linalg.det(m)) > 1e-12:
                continue
            w = _world_matrix(gltf, j)
            ibm[k] = (np.linalg.inv(w) if abs(np.linalg.det(w)) > 1e-12 else np.eye(4)).T  # glTF stores columns first
            changed = True
        if changed:
            arr = np.ascontiguousarray(ibm.reshape(-1, 16), dtype=np.float32)
            gltf['accessors'].append({'bufferView': add_view(arr.tobytes()), 'byteOffset': 0, 'componentType': 5126,
                                      'count': int(arr.shape[0]), 'type': 'MAT4'})
            skin['inverseBindMatrices'] = len(gltf['accessors']) - 1

    def add_accessor(arr, kind):
        arr = np.ascontiguousarray(arr, dtype=np.float32)
        acc = {'bufferView': add_view(arr.tobytes()), 'byteOffset': 0, 'componentType': 5126, 'count': int(arr.shape[0]), 'type': kind}
        if kind == 'SCALAR':
            acc['min'], acc['max'] = [float(arr.min())], [float(arr.max())]
        gltf['accessors'].append(acc)
        return len(gltf['accessors']) - 1

    kept = []
    for anim in gltf.get('animations', []):
        samplers, channels, done = [], [], {}
        for ch in anim.get('channels', []):
            target = ch.get('target', {})
            path, ni = target.get('path'), target.get('node')
            si = ch.get('sampler')
            if ni is None or si is None or not (0 <= ni < len(nodes)) or not (0 <= si < len(anim.get('samplers', []))):
                continue
            key = (si, path, ni)   # the rest value depends on the bone
            if key not in done:
                s = dict(anim['samplers'][si])
                if path in _REST and s.get('interpolation', 'LINEAR') in ('LINEAR', 'STEP'):
                    t = _float_keys(gltf, views, s['input']).ravel()
                    out = _float_keys(gltf, views, s['output'])
                    if len(t) == 0 or len(out) != len(t) or not np.isfinite(t).all() or (np.diff(t) < 0).any():
                        done[key] = None   # broken track: the bone keeps its rest pose
                    else:
                        keep = np.concatenate([[True], np.diff(t) > 0])   # duplicate times -> one key
                        rest = nodes[ni].get(path, _REST[path])
                        fixed = _fix_keys(path, out[keep], rest)
                        if not keep.all():
                            s['input'] = add_accessor(t[keep].reshape(-1, 1), 'SCALAR')
                        if not keep.all() or not np.array_equal(fixed, out.astype(np.float32), equal_nan=True):
                            s['output'] = add_accessor(fixed, gltf['accessors'][s['output']]['type'])
                        samplers.append(s)
                        done[key] = len(samplers) - 1
                else:
                    samplers.append(s)
                    done[key] = len(samplers) - 1
            if done[key] is not None:
                channels.append(dict(ch, sampler=done[key]))
        if channels:
            anim['samplers'], anim['channels'] = samplers, channels
            kept.append(anim)
    if 'animations' in gltf:
        gltf['animations'] = kept
        if not kept:
            gltf.pop('animations')


def _set_attribute(gltf, add_view, prim, name, values):
    """Stores float VEC3 data as a new accessor for prim's attribute `name`."""
    import numpy as np
    v = np.ascontiguousarray(values, dtype=np.float32)
    acc = {'bufferView': add_view(v.tobytes(), 34962), 'byteOffset': 0, 'componentType': 5126, 'count': int(len(v)), 'type': 'VEC3'}
    if name == 'POSITION':
        acc['min'], acc['max'] = [float(x) for x in v.min(axis=0)], [float(x) for x in v.max(axis=0)]
    gltf['accessors'].append(acc)
    prim['attributes'][name] = len(gltf['accessors']) - 1


def _bake_transform(gltf, views, add_view, prim, m):
    """Moves a static primitive's vertices by the 4x4 matrix m."""
    import numpy as np
    if np.allclose(m, np.eye(4), atol=1e-7):
        return
    pos = _accessor(gltf, views, prim['attributes']['POSITION']).astype(np.float64)
    _set_attribute(gltf, add_view, prim, 'POSITION', pos @ m[:3, :3].T + m[:3, 3])
    if 'NORMAL' in prim['attributes']:
        nrm = _accessor(gltf, views, prim['attributes']['NORMAL']).astype(np.float64) @ np.linalg.inv(m[:3, :3])
        _set_attribute(gltf, add_view, prim, 'NORMAL', nrm / np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12))
    prim['attributes'].pop('TANGENT', None)


EFFECT_PART = re.compile(r'vine|whip|effect|_eff|beam|flame_fx', re.I)


def _drop_effect_parts(gltf):
    """Some models carry move effects as separate meshes that the games' own animations hide: Chikorita's vines stick
    out a metre on each side of it. A part named like an effect (vine, whip…) that reaches far outside the body is dropped."""
    import numpy as np
    nodes = gltf.get('nodes', [])
    holders = [i for i, n in enumerate(nodes) if 'mesh' in n]
    if len(holders) < 2:
        return []

    def box(i):
        lo = hi = None
        count = 0
        for prim in gltf['meshes'][nodes[i]['mesh']]['primitives']:
            acc = gltf['accessors'][prim['attributes']['POSITION']]
            if 'min' not in acc or 'max' not in acc:
                continue
            a, b = np.array(acc['min'][:3], dtype=np.float64), np.array(acc['max'][:3], dtype=np.float64)
            if 'skin' not in nodes[i]:  # static parts are placed by their node; skinned ones share the model space
                m = _world_matrix(gltf, i)
                corners = np.array([[x, y, z, 1.0] for x in (a[0], b[0]) for y in (a[1], b[1]) for z in (a[2], b[2])]) @ m.T
                a, b = corners[:, :3].min(axis=0), corners[:, :3].max(axis=0)
            lo = a if lo is None else np.minimum(lo, a)
            hi = b if hi is None else np.maximum(hi, b)
            count += acc['count']
        return lo, hi, count

    boxes = {i: box(i) for i in holders}
    boxes = {i: b for i, b in boxes.items() if b[0] is not None}
    if len(boxes) < 2:
        return []
    main = max(boxes, key=lambda i: boxes[i][2])
    mlo, mhi, _ = boxes[main]
    body = float(np.max(mhi - mlo))
    dropped = []
    for i, (lo, hi, _) in boxes.items():
        name = (nodes[i].get('name', '') + ' ' + gltf['meshes'][nodes[i]['mesh']].get('name', '')).lower()
        if i == main or body <= 0 or not EFFECT_PART.search(name):
            continue
        beyond = float(max(np.max(mlo - lo), np.max(hi - mhi), 0.0))
        if beyond > 0.6 * body:
            dropped.append(nodes[i].get('name') or gltf['meshes'][nodes[i]['mesh']].get('name', '?'))
            nodes[i].pop('mesh')
            nodes[i].pop('skin', None)
    return dropped


def _merge_meshes(gltf, views, add_view):
    """Unreal makes a separate asset of every mesh in a glTF, and the battle shows one of them. Pokémon made of several
    meshes (eyes, wings, flames — Pikachu, Charizard, Eevee…) would lose all parts but one, so they become one mesh.
    Skinned parts are placed by their joints (the node transform does not count), static parts get it baked in."""
    nodes = gltf.get('nodes', [])
    holders = [i for i, n in enumerate(nodes) if 'mesh' in n]
    if len(holders) < 2 or len({nodes[i].get('skin') for i in holders}) != 1:
        return  # one mesh already, or a mix of skeletons: left as it is
    skinned = 'skin' in nodes[holders[0]]
    prims = []
    for i in holders:
        m = None if skinned else _world_matrix(gltf, i)
        for prim in gltf['meshes'][nodes[i]['mesh']]['primitives']:
            prim = json.loads(json.dumps(prim))
            if m is not None:
                _bake_transform(gltf, views, add_view, prim, m)
            prims.append(prim)
    gltf['meshes'].append({'name': gltf['meshes'][nodes[holders[0]]['mesh']].get('name', 'Body'), 'primitives': prims})
    merged = len(gltf['meshes']) - 1
    for i in holders:
        nodes[i].pop('mesh')
        if skinned and i != holders[0]:
            nodes[i].pop('skin')
    if skinned:
        nodes[holders[0]]['mesh'] = merged
    else:
        nodes.append({'name': 'Body', 'mesh': merged})
        gltf['scenes'][gltf.get('scene', 0)]['nodes'].append(len(nodes) - 1)


def _quat_from_matrix(r):
    import numpy as np
    t = np.trace(r)
    if t > 0:
        k = 0.5 / np.sqrt(t + 1.0)
        q = [(r[2, 1] - r[1, 2]) * k, (r[0, 2] - r[2, 0]) * k, (r[1, 0] - r[0, 1]) * k, 0.25 / k]
    else:
        i = int(np.argmax([r[0, 0], r[1, 1], r[2, 2]]))
        j, k_ = (i + 1) % 3, (i + 2) % 3
        sq = np.sqrt(max(1.0 + r[i, i] - r[j, j] - r[k_, k_], 1e-12)) * 2
        q = [0.0, 0.0, 0.0, (r[k_, j] - r[j, k_]) / sq]
        q[i] = 0.25 * sq
        q[j] = (r[j, i] + r[i, j]) / sq
        q[k_] = (r[k_, i] + r[i, k_]) / sq
    q = np.array(q)
    return q / np.linalg.norm(q)


def _quat_mul(a, b):
    """Hamilton product of xyzw quaternions; b may be an (n, 4) array."""
    import numpy as np
    b = np.asarray(b, dtype=np.float64)
    ax, ay, az, aw = a
    bx, by, bz, bw = b[..., 0], b[..., 1], b[..., 2], b[..., 3]
    return np.stack([aw * bx + ax * bw + ay * bz - az * by,
                     aw * by - ax * bz + ay * bw + az * bx,
                     aw * bz + ax * by - ay * bx + az * bw,
                     aw * bw - ax * bx - ay * by - az * bz], axis=-1)


def _similarity(m):
    """(rotation 3x3, uniform scale) of a 4x4 matrix without shear or non-uniform scale, else None."""
    import numpy as np
    det = np.linalg.det(m[:3, :3])
    if not np.isfinite(det) or abs(det) < 1e-12:
        return None
    s = float(np.cbrt(det))
    rot = m[:3, :3] / s
    if not np.allclose(rot @ rot.T, np.eye(3), atol=1e-4):
        return None
    return rot, s


def _canonicalize(gltf, views, add_view):
    """One layout that every glTF importer reads the same way. The source files differ a lot: two or three root bones
    (Charmander, Pidgey…), a model turned or scaled by plain nodes above the skeleton or by the mesh node itself, a bind
    pose that differs from the rest pose. Unreal read some of that differently from the glTF rules — Pokémon came out
    upside down or twisted. After this the skeleton has a single root bone at the scene root, the mesh node has no
    transform, and the vertices are stored in the rest pose (bind pose = rest pose). What you see does not change."""
    import numpy as np
    nodes = gltf.get('nodes', [])
    holders = [i for i, n in enumerate(nodes) if 'mesh' in n]
    if len(holders) != 1:
        return
    mi = holders[0]
    parent = {c: i for i, n in enumerate(nodes) for c in n.get('children', [])}
    skins = gltf.get('skins', [])
    scene = gltf['scenes'][gltf.get('scene', 0)]

    def keep_only(keep, roots):
        """Drops every node outside `keep` and renumbers the references."""
        index = {old: new for new, old in enumerate(sorted(keep))}
        gltf['nodes'] = [nodes[i] for i in sorted(keep)]
        for n in gltf['nodes']:
            kids = [index[c] for c in n.get('children', []) if c in index]
            if kids:
                n['children'] = kids
            else:
                n.pop('children', None)
        for skin in gltf.get('skins', []):
            skin['joints'] = [index[j] for j in skin['joints']]
            if 'skeleton' in skin:
                skin['skeleton'] = index[skin['skeleton']]
        for anim in gltf.get('animations', []):
            used, samplers, channels = {}, [], []
            for ch in anim['channels']:
                if ch['target']['node'] not in index:
                    continue
                si = ch['sampler']
                if si not in used:
                    used[si] = len(samplers)
                    samplers.append(anim['samplers'][si])
                channels.append(dict(ch, sampler=used[si], target=dict(ch['target'], node=index[ch['target']['node']])))
            anim['samplers'], anim['channels'] = samplers, channels
        gltf['animations'] = [a for a in gltf.get('animations', []) if a['channels']]
        if not gltf['animations']:
            gltf.pop('animations')
        gltf['scenes'] = [{'name': scene.get('name', 'Scene'), 'nodes': [index[r] for r in roots]}]
        gltf['scene'] = 0

    if 'skin' not in nodes[mi] or len(skins) != 1:
        # static model: the node transforms go into the vertices
        world = _world_matrix(gltf, mi)
        for prim in gltf['meshes'][nodes[mi]['mesh']]['primitives']:
            _bake_transform(gltf, views, add_view, prim, world)
        for k in ('translation', 'rotation', 'scale', 'matrix', 'children', 'skin'):
            nodes[mi].pop(k, None)
        keep_only({mi}, [mi])
        return

    skin = skins[0]
    joints = list(skin['joints'])
    old_count = len(joints)
    jset = set(joints)
    for j in list(joints):  # plain nodes between two bones become bones too
        path, p = [], parent.get(j)
        while p is not None and p not in jset:
            path.append(p)
            p = parent.get(p)
        if p is not None:
            for q in path:
                if q not in jset:
                    joints.append(q)
                    jset.add(q)
    if mi in jset or any('matrix' in nodes[j] for j in joints):
        return
    tops = [j for j in joints if parent.get(j) not in jset]
    lift = {}
    for t in tops:
        above = _world_matrix(gltf, parent[t]) if t in parent else np.eye(4)
        sim = _similarity(above)
        if sim is None:
            return  # sheared or squashed above the skeleton: left as it is
        lift[t] = (above, sim)
    ancestors = set()
    for t in tops:
        p = parent.get(t)
        while p is not None:
            ancestors.add(p)
            p = parent.get(p)
    for anim in gltf.get('animations', []):
        for ch in anim['channels']:
            if ch['target']['node'] in ancestors and ch['target'].get('path') in _REST:
                s = anim['samplers'][ch['sampler']]
                out = _float_keys(gltf, views, s['output'])
                rest = np.array(nodes[ch['target']['node']].get(ch['target']['path'], _REST[ch['target']['path']]))
                moved = (1 - np.abs(out @ rest)) if ch['target']['path'] == 'rotation' else np.abs(out - rest).max(axis=1)
                if moved.max() > 1e-4:
                    return  # a node above the skeleton is animated: left as it is

    world = {j: _world_matrix(gltf, j) for j in joints}  # stays the same for every bone through the changes below
    if 'inverseBindMatrices' in skin:
        ibm = _accessor(gltf, views, skin['inverseBindMatrices']).astype(np.float64).reshape(-1, 4, 4).transpose(0, 2, 1)
    else:
        ibm = np.tile(np.eye(4), (old_count, 1, 1))
    bind_to_rest = np.array([world[j] @ ibm[k] for k, j in enumerate(joints[:old_count])])

    # the transforms above each top bone go into it, its animation keys included
    for t in tops:
        above, (rot, s) = lift[t]
        if np.allclose(above, np.eye(4), atol=1e-9):
            continue
        q_above = _quat_from_matrix(rot)
        node = nodes[t]
        node['translation'] = [float(x) for x in above[:3, :3] @ np.array(node.get('translation', _REST['translation'])) + above[:3, 3]]
        node['rotation'] = [float(x) for x in _quat_mul(q_above, node.get('rotation', _REST['rotation']))]
        node['scale'] = [float(x) * s for x in node.get('scale', _REST['scale'])]
        for anim in gltf.get('animations', []):
            for ci, ch in enumerate(anim['channels']):
                path = ch['target'].get('path')
                if ch['target']['node'] != t or path not in _REST:
                    continue
                sampler = dict(anim['samplers'][ch['sampler']])
                out = _float_keys(gltf, views, sampler['output'])
                if path == 'translation':
                    out = out @ above[:3, :3].T + above[:3, 3]
                elif path == 'rotation':
                    out = _quat_mul(q_above, out)
                else:
                    out = out * s
                arr = np.ascontiguousarray(out, dtype=np.float32)
                gltf['accessors'].append({'bufferView': add_view(arr.tobytes()), 'byteOffset': 0, 'componentType': 5126,
                                          'count': int(len(arr)), 'type': 'VEC4' if path == 'rotation' else 'VEC3'})
                sampler['output'] = len(gltf['accessors']) - 1
                anim['samplers'].append(sampler)
                anim['channels'][ci] = dict(ch, sampler=len(anim['samplers']) - 1)

    # one root bone
    if len(tops) > 1:
        nodes.append({'name': 'Root', 'children': list(tops)})
        root = len(nodes) - 1
        joints.append(root)
        world[root] = np.eye(4)
    else:
        root = tops[0]
    for n in nodes[:-1] if len(tops) > 1 else nodes:
        if 'children' in n:
            n['children'] = [c for c in n['children'] if c not in tops and c != mi]
    for k in ('translation', 'rotation', 'scale', 'matrix', 'children'):
        nodes[mi].pop(k, None)

    # Bind pose = rest pose. First the part common to all bones goes into the vertices (exact: often the source keeps
    # them lying on their back in Blender's Z-up and turns the skeleton upright).
    weight = np.zeros(old_count)
    prims = gltf['meshes'][nodes[mi]['mesh']]['primitives']
    for prim in prims:
        for set_no in range(4):
            if f'JOINTS_{set_no}' not in prim['attributes'] or f'WEIGHTS_{set_no}' not in prim['attributes']:
                break
            jj = np.minimum(_accessor(gltf, views, prim['attributes'][f'JOINTS_{set_no}']).astype(np.int64), old_count - 1)
            np.add.at(weight, jj.ravel(), _float_keys(gltf, views, prim['attributes'][f'WEIGHTS_{set_no}']).ravel())
    weighted = [k for k in range(old_count) if weight[k] > 1e-6]
    common = bind_to_rest[int(np.argmax(weight))]
    for prim in prims:
        _bake_transform(gltf, views, add_view, prim, common)
    ibm = ibm @ np.linalg.inv(common)
    bind = {j: (np.linalg.inv(ibm[k]) if k in weighted else world[j]) for k, j in enumerate(joints[:old_count])}
    for j in joints[old_count:]:
        bind[j] = world[j]
    scale = max(1e-6, max(np.abs(world[j][:3, 3]).max() for j in joints))
    differs = [j for j in joints if not np.allclose(bind[j], world[j], atol=1e-4 * scale + 1e-7)]
    keep_bind = False

    if differs and gltf.get('animations'):
        # Some bones are bound in another pose (Eevee, Thwackey: parts folded away at rest). The rest pose becomes
        # the bind pose, and every animation gets the old rest values as constant keys for whatever it leaves alone,
        # so the animations stay exact.
        new_parent = {c: i for i, n in enumerate(nodes) for c in n.get('children', []) if i in jset or i == root}
        trs = {}
        for j in joints:
            local = np.linalg.inv(bind[new_parent[j]]) @ bind[j] if j in new_parent else bind[j]
            if np.allclose(local, _local_matrix(nodes[j]), atol=1e-6 * scale + 1e-9):
                continue  # this bone keeps its rest transform
            trs[j] = _decompose(local)
            if trs[j] is None:
                keep_bind = True  # sheared bind pose (Thwackey): bones and vertices are left in their bind pose
                break
        else:
            old = {j: {p: list(nodes[j].get(p, _REST[p])) for p in _REST} for j in trs}
            for j, (t, q, sc) in trs.items():
                nodes[j]['translation'], nodes[j]['rotation'], nodes[j]['scale'] = t, q, sc
            for anim in gltf['animations']:
                animated = {(ch['target']['node'], ch['target']['path']) for ch in anim['channels']}
                t0 = None
                for j in trs:
                    for p in _REST:
                        a, b = np.array(old[j][p]), np.array(nodes[j][p])
                        same = abs(float(a @ b)) > 1 - 1e-9 if p == 'rotation' else np.allclose(a, b, atol=1e-6 * scale + 1e-9)
                        if (j, p) in animated or same:
                            continue
                        if t0 is None:
                            t0 = len(gltf['accessors'])
                            gltf['accessors'].append({'bufferView': add_view(np.zeros(1, dtype=np.float32).tobytes()), 'byteOffset': 0,
                                                      'componentType': 5126, 'count': 1, 'type': 'SCALAR', 'min': [0.0], 'max': [0.0]})
                        value = np.asarray([old[j][p]], dtype=np.float32)
                        gltf['accessors'].append({'bufferView': add_view(value.tobytes()), 'byteOffset': 0, 'componentType': 5126,
                                                  'count': 1, 'type': 'VEC4' if p == 'rotation' else 'VEC3'})
                        anim['samplers'].append({'input': t0, 'output': len(gltf['accessors']) - 1, 'interpolation': 'STEP'})
                        anim['channels'].append({'sampler': len(anim['samplers']) - 1, 'target': {'node': j, 'path': p}})
            world = bind
            differs = []
    if differs and not keep_bind:
        # no animations: the vertices go into the rest pose, the only pose ever shown
        rest_from_bind = np.array([world[j] @ ibm[k] for k, j in enumerate(joints[:old_count])])
        for prim in prims:
            attrs = prim['attributes']
            pos = _accessor(gltf, views, attrs['POSITION']).astype(np.float64)
            nrm = _accessor(gltf, views, attrs['NORMAL']).astype(np.float64) if 'NORMAL' in attrs else None
            new_pos, new_nrm, total = np.zeros_like(pos), (np.zeros_like(nrm) if nrm is not None else None), np.zeros(len(pos))
            normal_mats = np.linalg.inv(rest_from_bind[:, :3, :3]).transpose(0, 2, 1)
            for set_no in range(4):
                if f'JOINTS_{set_no}' not in attrs or f'WEIGHTS_{set_no}' not in attrs:
                    break
                jj = np.minimum(_accessor(gltf, views, attrs[f'JOINTS_{set_no}']).astype(np.int64), old_count - 1)
                ww = _float_keys(gltf, views, attrs[f'WEIGHTS_{set_no}'])
                for c in range(jj.shape[1]):
                    m, w = rest_from_bind[jj[:, c]], ww[:, c]
                    new_pos += w[:, None] * (np.einsum('nij,nj->ni', m[:, :3, :3], pos) + m[:, :3, 3])
                    if nrm is not None:
                        new_nrm += w[:, None] * np.einsum('nij,nj->ni', normal_mats[jj[:, c]], nrm)
                    total += w
            ok = total > 1e-8
            new_pos[ok] /= total[ok, None]
            new_pos[~ok] = pos[~ok]
            _set_attribute(gltf, add_view, prim, 'POSITION', new_pos)
            if nrm is not None:
                new_nrm[~ok] = nrm[~ok]
                _set_attribute(gltf, add_view, prim, 'NORMAL', new_nrm / np.maximum(np.linalg.norm(new_nrm, axis=1, keepdims=True), 1e-12))
            attrs.pop('TANGENT', None)
    if keep_bind:
        ibm_new = np.array([(ibm[k] if k < old_count else np.linalg.inv(world[j])).T for k, j in enumerate(joints)], dtype=np.float32).reshape(-1, 16)
    else:
        ibm_new = np.array([np.linalg.inv(world[j]).T for j in joints], dtype=np.float32).reshape(-1, 16)
    gltf['accessors'].append({'bufferView': add_view(np.ascontiguousarray(ibm_new).tobytes()), 'byteOffset': 0,
                              'componentType': 5126, 'count': len(joints), 'type': 'MAT4'})
    skin['inverseBindMatrices'] = len(gltf['accessors']) - 1
    skin['joints'] = joints
    skin['skeleton'] = root
    keep_only(set(joints) | {mi}, [root, mi])


def _decompose(m):
    """4x4 -> ([t], [quaternion xyzw], [scale]) when it is translation * rotation * scale (no shear), else None."""
    import numpy as np
    a = m[:3, :3]
    sc = np.linalg.norm(a, axis=0)
    if not np.isfinite(sc).all() or (sc < 1e-9).any():
        return None
    rot = a / sc
    if np.linalg.det(rot) < 0:
        sc[0], rot[:, 0] = -sc[0], -rot[:, 0]
    if not np.allclose(rot.T @ rot, np.eye(3), atol=1e-4):
        return None
    return [float(x) for x in m[:3, 3]], [float(x) for x in _quat_from_matrix(rot)], [float(x) for x in sc]


def _ensure_normals(gltf, views, add_view):
    """Smooth normals for parts that have none, so a merged mesh does not mix imported and generated normals."""
    import numpy as np
    for mesh in gltf.get('meshes', []):
        for prim in mesh.get('primitives', []):
            if 'NORMAL' in prim['attributes'] or prim.get('mode', 4) != 4:
                continue
            pos = _accessor(gltf, views, prim['attributes']['POSITION']).astype(np.float64)
            tri = (_accessor(gltf, views, prim['indices']).reshape(-1) if 'indices' in prim else np.arange(len(pos))).astype(np.int64)
            tri = tri[:len(tri) // 3 * 3].reshape(-1, 3)
            face = np.cross(pos[tri[:, 1]] - pos[tri[:, 0]], pos[tri[:, 2]] - pos[tri[:, 0]])
            nrm = np.zeros_like(pos)
            for k in range(3):
                np.add.at(nrm, tri[:, k], face)
            length = np.linalg.norm(nrm, axis=1, keepdims=True)
            nrm = np.where(length > 1e-12, nrm / np.maximum(length, 1e-12), [0.0, 0.0, 1.0])
            nrm = np.ascontiguousarray(nrm, dtype=np.float32)
            gltf['accessors'].append({'bufferView': add_view(nrm.tobytes(), 34962), 'byteOffset': 0, 'componentType': 5126,
                                      'count': int(len(nrm)), 'type': 'VEC3'})
            prim['attributes']['NORMAL'] = len(gltf['accessors']) - 1


# ——— procedural clips ———
# Most models in the repository have no animation at all, so a Pokémon would stand frozen in its bind pose (arms
# straight out). The bones follow one naming scheme (Hips, Spine1, Head, LArm, RThigh, Tail1…), so clips can be made
# for any of them. _Rig reads the skeleton (legs, arms, wings, tails, ears, antennae, by name and by where they are),
# picks a body plan (two legs, four legs, bird, flier, serpent, fish, blob — helped by the species' shape from
# species.json), gives it a natural stance (arms lowered with bent elbows, a tail held up off the ground, a bird's
# wings folded) and makes idle, walk, attack and faint clips for that plan. Clips the file already has are kept; only
# missing roles are added, named liga_<role>.
#
# Turns are world-axis rotations about each bone's own pivot. The model faces +Z, up is +Y and its left side is +X:
# +X swings a hanging limb backwards (and pitches a forward-looking head down, leans an upright spine forwards),
# +Y turns the front towards the model's left, +Z raises a left wing (side * angle raises either wing).

_SIDE = re.compile(r'^(?:L|R)(?=[A-Z_0-9])')


def _bone_kind(name):
    """(side -1/0/1, kind, index) from a bone name like 'LForeArm', '035 Spine2', 'Tail3_28'."""
    n = re.sub(r'_\d+$', '', re.sub(r'^\d+\s*', '', name or '')).replace('_end', '')
    side = 0
    m = _SIDE.match(n)
    if m:
        side = 1 if n[0] == 'L' else -1  # the model faces +Z, so its left side is +X
        n = n[1:].lstrip('_')
    idx = int(re.findall(r'\d+', n)[-1]) if re.findall(r'\d+', n) else 0
    low = n.lower()
    for kind, words in (('forearm', ('forearm',)), ('arm', ('arm',)), ('shoulder', ('shoulder', 'clavicle')), ('hand', ('hand',)),
                        ('thigh', ('thigh',)), ('shin', ('leg', 'calf')), ('foot', ('foot',)), ('toe', ('toe',)), ('finger', ('finger',)),
                        ('tail', ('tail',)), ('neck', ('neck',)), ('head', ('head',)), ('jaw', ('jaw', 'beak')), ('ear', ('ear',)),
                        ('wing', ('wing', 'wind')), ('spine', ('spine', 'chest')), ('pelvis', ('hips', 'waist', 'pelvis')),
                        ('feeler', ('feeler', 'hair', 'tentacle'))):
        if any(w in low for w in words):
            return side, kind, idx
    return side, None, idx


def _sample_anim(gltf, views, anim, t):
    """{(node, path): value} of an animation at time t (linear / step; slerp for rotations)."""
    import numpy as np
    out = {}
    for ch in anim['channels']:
        s = anim['samplers'][ch['sampler']]
        ts = _float_keys(gltf, views, s['input']).ravel()
        vals = _float_keys(gltf, views, s['output'])
        path = ch['target']['path']
        if path not in _REST:
            continue
        if t <= ts[0] or len(ts) == 1:
            v = vals[0]
        elif t >= ts[-1]:
            v = vals[-1]
        else:
            i = int(np.searchsorted(ts, t, side='right') - 1)
            u = (t - ts[i]) / max(ts[i + 1] - ts[i], 1e-9)
            a, b = vals[i], vals[i + 1]
            if s.get('interpolation') == 'STEP':
                v = a
            elif path == 'rotation':
                if float(a @ b) < 0:
                    b = -b
                v = a * (1 - u) + b * u
                v = v / np.linalg.norm(v)
            else:
                v = a * (1 - u) + b * u
        out[(ch['target']['node'], path)] = np.array(v, dtype=np.float64)
    return out


def _axis_quat(axis, deg):
    import numpy as np
    axis = np.asarray(axis, dtype=np.float64)
    axis = axis / max(np.linalg.norm(axis), 1e-12)
    h = np.radians(deg) * 0.5
    return np.array([*(axis * np.sin(h)), np.cos(h)])


def _quat_conj(q):
    import numpy as np
    return np.array([-q[0], -q[1], -q[2], q[3]])


def _unit(v):
    import numpy as np
    v = np.asarray(v, dtype=np.float64)
    n = np.linalg.norm(v)
    return v / n if n > 1e-12 else v


def _rot_between(a, b):
    """(axis, degrees) of the smallest turn taking direction a to b, or None when they already agree."""
    import numpy as np
    a, b = _unit(a), _unit(b)
    axis = np.cross(a, b)
    s, c = float(np.linalg.norm(axis)), float(np.clip(a @ b, -1.0, 1.0))
    if s < 1e-9:
        if c > 0:
            return None
        axis = np.cross(a, [1.0, 0.0, 0.0] if abs(a[0]) < 0.9 else [0.0, 1.0, 0.0])
        s = float(np.linalg.norm(axis))
    return axis / s, float(np.degrees(np.arctan2(s, c)))


def _rot_matrix(axis, deg):
    import numpy as np
    x, y, z = _unit(axis)
    a = np.radians(deg)
    c, s, t = np.cos(a), np.sin(a), 1 - np.cos(a)
    return np.array([[t * x * x + c, t * x * y - s * z, t * x * z + s * y],
                     [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
                     [t * x * z - s * y, t * y * z + s * x, t * z * z + c]])


def _smooth(a, b, t):
    import numpy as np
    x = np.clip((t - a) / (b - a), 0.0, 1.0)
    return float(x * x * (3 - 2 * x))


def _curve(keys, u):
    """A looping curve through (fraction, value) keys with eased moves between them and holds where values repeat."""
    for (u0, v0), (u1, v1) in zip(keys, keys[1:]):
        if u0 <= u <= u1:
            return v0 + (v1 - v0) * _smooth(u0, u1, u) if u1 > u0 else v1
    return keys[-1][1]


_SPECIES = {}


def species_info(species):
    """The game's data for a species (shape, types…), from Content/Liga/Data/species.json."""
    if not _SPECIES:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'Liga', 'Data', 'species.json')
        try:
            with open(path, encoding='utf-8-sig') as f:
                for s in json.load(f):
                    _SPECIES[s['id']] = s
        except Exception:
            _SPECIES[0] = {}
    return _SPECIES.get(species, {}) if species else {}


class _Rig:
    """What a skeleton is made of and how its body moves. See the notes above _bone_kind."""

    def __init__(self, gltf, views, info):
        import numpy as np
        self.gltf, self.views = gltf, views
        nodes = gltf['nodes']
        skin = gltf['skins'][0]
        self.joints = list(skin['joints'])
        jset = set(self.joints)
        self.parent = {c: i for i, n in enumerate(nodes) for c in n.get('children', []) if i in jset and c in jset}
        self.root = skin.get('skeleton', self.joints[0])
        self.children = {j: [c for c in nodes[j].get('children', []) if c in jset] for j in self.joints}
        self.kinds = {j: _bone_kind(nodes[j].get('name', '')) for j in self.joints}
        self.info = info or {}
        self.shape = self.info.get('shape', '')
        self.auto = nodes[self.root].get('name') == AUTO_ROOT  # a skeleton made by _autorig: rough legs, small steps

        # base pose: the rest pose, or the first frame of the file's own idle clip
        self.base = {j: {p: np.array(nodes[j].get(p, _REST[p]), dtype=np.float64) for p in _REST} for j in self.joints}
        idle = next((a for a in gltf.get('animations', []) if clip_role(a.get('name', '')) == 'idle'), None)
        if idle:
            t0 = min(float(_float_keys(gltf, views, s['input']).min()) for s in idle['samplers'])
            for (j, p), v in _sample_anim(gltf, views, idle, t0).items():
                if j in self.base:
                    self.base[j][p] = v
        world = {}

        def w(j):
            if j not in world:
                local = _local_matrix({p: list(self.base[j][p]) for p in _REST})
                world[j] = (w(self.parent[j]) @ local) if j in self.parent else local
            return world[j]

        for j in self.joints:
            w(j)
        self.pos = {j: world[j][:3, 3] for j in self.joints}
        self.qworld = {}
        for j in self.joints:
            r = world[j][:3, :3]
            sc = np.linalg.norm(r, axis=0)
            self.qworld[j] = _quat_from_matrix(r / np.where(sc > 1e-12, sc, 1.0)) if (sc > 1e-12).all() else np.array([0, 0, 0, 1.0])

        holder = next(n for n in nodes if 'mesh' in n and 'skin' in n)
        mesh = gltf['meshes'][holder['mesh']]
        pts = np.concatenate([_accessor(gltf, views, p['attributes']['POSITION']) for p in mesh['primitives']]).astype(np.float64)
        self.lo, self.hi = pts.min(axis=0), pts.max(axis=0)
        self.height = max(self.hi[1] - self.lo[1], 1e-6)
        self.ground = self.lo[1]
        self._find_parts()
        self._choose_plan()
        self._stance()

    # ——— reading the skeleton ———

    def kind(self, j):
        return self.kinds[j][1]

    def side(self, j):
        return self.kinds[j][0]

    def ancestors(self, j):
        out = []
        while j in self.parent:
            j = self.parent[j]
            out.append(j)
        return out

    def subtree(self, j):
        out, stack = [], [j]
        while stack:
            k = stack.pop()
            out.append(k)
            stack.extend(self.children[k])
        return out

    def chain(self, start, ok):
        """start and the descendants that pass ok, always following the child with the most of them below it."""
        def count(j):
            return sum(1 for k in self.subtree(j) if ok(k))
        out, j = [start], start
        while True:
            kids = [c for c in self.children[j] if ok(c)]
            if not kids:
                return out
            j = max(kids, key=count)
            out.append(j)

    def direction(self, j, nxt=None):
        """Where a bone points: to the next bone of its chain (or its first child), else on from its parent."""
        import numpy as np
        if nxt is None and self.children[j]:
            nxt = max(self.children[j], key=lambda c: len(self.subtree(c)))
        if nxt is not None and np.linalg.norm(self.pos[nxt] - self.pos[j]) > 1e-9:
            return _unit(self.pos[nxt] - self.pos[j])
        if j in self.parent and np.linalg.norm(self.pos[j] - self.pos[self.parent[j]]) > 1e-9:
            return _unit(self.pos[j] - self.pos[self.parent[j]])
        return np.array([0.0, -1.0, 0.0])

    def lowest(self, j):
        return min(self.pos[k][1] for k in self.subtree(j))

    def length(self, chain):
        import numpy as np
        tip = min(self.subtree(chain[-1]), key=lambda k: -np.linalg.norm(self.pos[k] - self.pos[chain[0]]))
        return float(np.linalg.norm(self.pos[tip] - self.pos[chain[0]]))

    def _find_parts(self):
        import numpy as np
        J, K, S, H = self.joints, self.kind, self.side, self.height
        top = lambda j, kinds: not (j in self.parent and K(self.parent[j]) in kinds)
        self.legs = []
        for j in J:
            if K(j) == 'thigh' and S(j) != 0 and top(j, ('thigh',)):
                ch = self.chain(j, lambda c, s=S(j): K(c) in ('thigh', 'shin', 'foot', 'toe') and S(c) == s)
                pick = lambda kind: next((c for c in ch if K(c) == kind), None)
                self.legs.append({'side': S(j), 'thigh': j, 'shin': pick('shin'), 'foot': pick('foot'), 'chain': ch,
                                  'low': self.lowest(j)})
        self.arms = []
        for j in J:
            if K(j) == 'arm' and S(j) != 0 and top(j, ('arm',)):
                ch = self.chain(j, lambda c, s=S(j): K(c) in ('arm', 'forearm', 'hand') and S(c) == s)
                fore = next((c for c in ch[1:] if K(c) in ('forearm', 'arm')), None)
                hand = next((c for c in ch if K(c) == 'hand'), None)
                shoulder = self.parent.get(j) if K(self.parent.get(j, j)) == 'shoulder' else None
                self.arms.append({'side': S(j), 'arm': j, 'fore': fore, 'hand': hand, 'shoulder': shoulder, 'chain': ch,
                                  'low': self.lowest(j), 'len': self.length(ch)})
        heads = [j for j in J if K(j) == 'head']
        self.head = min(heads, key=lambda j: len(self.ancestors(j))) if heads else None
        self.necks = sorted([j for j in J if K(j) == 'neck'], key=lambda j: len(self.ancestors(j)))
        self.jaws = [j for j in J if K(j) == 'jaw' and S(j) == 0 and 'upper' not in str(self.gltf['nodes'][j].get('name', '')).lower()]
        self.spines = sorted([j for j in J if K(j) == 'spine'], key=lambda j: len(self.ancestors(j)))
        self.pelvis = next((j for j in sorted(J, key=lambda j: len(self.ancestors(j))) if K(j) == 'pelvis'), None)
        on_head = lambda j: any(a == self.head or K(a) in ('head', 'neck', 'jaw') for a in [j] + self.ancestors(j))
        self.tails = [self.chain(j, lambda c: K(c) == 'tail' and S(c) == 0)
                      for j in J if K(j) == 'tail' and S(j) == 0 and top(j, ('tail',)) and not on_head(j)]
        self.ears = [self.chain(j, lambda c, s=S(j): K(c) == 'ear' and S(c) == s) for j in J if K(j) == 'ear' and top(j, ('ear',))]
        self.wings, self.loose = [], []
        for j in J:
            if K(j) in ('wing', 'feeler') and top(j, ('wing', 'feeler')):
                ch = self.chain(j, lambda c, s=S(j): K(c) in ('wing', 'feeler') and S(c) == s)
                if S(j) != 0 and not on_head(j) and (K(j) == 'wing' or self.length(ch) >= 0.22 * H):
                    self.wings.append({'side': S(j), 'chain': ch})
                else:
                    self.loose.append(ch)
        # The last bone of a leg often sits above the sole (the foot's mesh reaches lower), so a leg counts as one to
        # walk on when its lowest bone is in the lower third of the body.
        self.walking_legs = [l for l in self.legs if l['low'] < self.ground + 0.35 * H]
        self.front_legs = [a for a in self.arms if a['low'] < self.ground + 0.2 * H and self.walking_legs
                           and self.shape in ('quadruped', 'armor', 'legs', '')]
        self.hands = [a for a in self.arms if a not in self.front_legs]

    def _choose_plan(self):
        shape, H = self.shape, self.height
        legs = len(self.walking_legs) >= 2
        long_arms = [a for a in self.hands if a['len'] > 0.28 * H]
        if shape == 'wings' and len(long_arms) >= 2:
            # a bird's arms are its wings; feathery "feelers" on its back just flutter along
            self.loose += [wg['chain'] for wg in self.wings]
            self.wings = [{'side': a['side'], 'chain': a['chain'], 'arm': a} for a in long_arms]
            self.hands = [a for a in self.hands if a not in long_arms]
        if shape in ('tentacles', 'ball', 'blob', 'heads', 'arms', 'fish'):
            self.loose += [wg['chain'] for wg in self.wings]  # spikes, fins and tentacles are not wings
            self.wings = []
        long_body = len(self.spines) + sum(len(t) for t in self.tails) >= 8
        if self.front_legs and legs:
            plan = 'quadruped'
        elif shape == 'wings':
            plan = 'bird' if legs else 'flier'
        elif shape == 'bug-wings':
            grounded = legs and min(l['low'] for l in self.walking_legs) < self.ground + 0.2 * H
            plan = 'biped' if grounded else 'flier'
        elif shape in ('upright', 'humanoid', 'legs'):
            plan = 'biped' if legs else 'blob'
        elif shape == 'squiggle' or (shape == 'armor' and not legs and long_body):
            plan = 'serpent'
        elif shape in ('fish', 'tentacles'):
            plan = 'fish'
        elif shape in ('ball', 'blob', 'heads', 'arms'):
            plan = 'blob'
        elif legs:
            plan = 'biped'
        elif self.wings:
            plan = 'flier'
        elif long_body and not self.legs:
            plan = 'serpent'
        else:
            plan = 'blob'
        self.plan = plan
        # fliers and fish hover above the ground; serpents and fish carry their weight on the body
        self.hover = {'flier': 0.28, 'fish': 0.08}.get(plan, 0.0) * H

    # ——— stance: the pose every clip starts from ———

    def _stance(self):
        """Posture turns {joint: 3x3 matrix}, each in the frame before its parents' turns (see _aim)."""
        import numpy as np
        self.stance = {}
        if self.plan in ('biped', 'quadruped', 'bird', 'blob', 'flier'):
            for a in self.hands:
                if a['fore'] is None:
                    continue
                d = self.direction(a['arm'], a['fore'])
                if np.degrees(np.arccos(np.clip(d @ [0, -1, 0], -1, 1))) > 35.0:  # T-pose or arms out: lower them
                    self._aim(a['arm'], a['fore'], [a['side'] * 0.42, -1.0, 0.2], 80.0)
                    if a['hand'] is not None and a['hand'] != a['fore']:
                        self._aim(a['fore'], a['hand'], [a['side'] * 0.12, -0.55, 1.0], 70.0)
        if self.plan == 'bird':
            for wg in self.wings:
                a = wg.get('arm')
                if a and a['fore'] is not None:
                    # folded along the body: upper wing back, forewing forwards again, tips back
                    self._aim(a['arm'], a['fore'], [a['side'] * 0.45, -0.55, -1.0], 120.0)
                    if a['hand'] is not None and a['hand'] != a['fore']:
                        self._aim(a['fore'], a['hand'], [a['side'] * 0.2, -0.25, 1.0], 150.0)
        if self.plan == 'serpent':
            self._lie_down()
        if self.plan in ('biped', 'quadruped', 'bird'):
            for ch in self.tails:
                if len(ch) < 2 or self.lowest(ch[0]) > self.ground + 0.25 * self.height or self.length(ch) > 1.3 * self.height:
                    continue  # long thin tails (Raichu, Mankey) keep their curves
                # a tail lying on the ground is held up in a gentle curve
                for k, j in enumerate(ch[:-1]):
                    want = min(6.0 + 8.0 * k, 40.0)
                    cur = self._final_dir(j, ch[k + 1])
                    elev = np.degrees(np.arcsin(np.clip(cur[1], -1, 1)))
                    if elev < want and cur[2] < 0.5:
                        horiz = _unit([cur[0], 0.0, cur[2]]) if abs(cur[0]) + abs(cur[2]) > 1e-6 else np.array([0, 0, -1.0])
                        target = horiz * np.cos(np.radians(want)) + np.array([0, 1.0, 0]) * np.sin(np.radians(want))
                        self._aim(j, ch[k + 1], target, min(want - elev, 22.0))
        self.stance_q = {j: _quat_from_matrix(m) for j, m in self.stance.items()}
        # the stance can lift the body off the ground (a tail held up) or sink it (a snake laid down): every clip is
        # moved so that the stance stands where the bind pose stood, which is where the game puts the model
        self.lift = self.ground - self._posed_low() if self.stance else 0.0

    def _lie_down(self):
        """A snake standing straight up in its file (Ekans, Dratini) lies down: the tail coils on the ground and the front
        of the body rises in a curve to the head."""
        import numpy as np
        H = self.height
        tail = max(self.tails, key=len) if self.tails else []
        body = list(self.spines) + list(self.necks)
        if not tail or len(body) < 2 or self.head is None:
            return
        rise = self.pos[self.head] - self.pos[tail[-1]]
        if abs(rise[1]) < 0.6 * np.linalg.norm(rise):
            return  # already lying along the ground (Onix, Gyarados)
        n = len(tail)
        for k, j in enumerate(tail[:-1]):
            yaw = np.radians(180.0 + min(26.0 * (k + 1), 300.0) * (1 if n > 5 else 0.5))
            elev = -25.0 if k == 0 else -3.0
            target = np.array([np.sin(yaw) * np.cos(np.radians(elev)), np.sin(np.radians(elev)), np.cos(yaw) * np.cos(np.radians(elev))])
            self._aim(j, tail[k + 1], target, 180.0)
        m = len(body)
        for k, j in enumerate(body):
            nxt = body[k + 1] if k + 1 < m else self.head
            f = k / max(1, m - 1)
            elev = 8.0 + 70.0 * f * f if f > 0.25 else -10.0 + 30.0 * f
            yaw = np.radians(-14.0 * np.sin(np.pi * f))
            target = np.array([np.sin(yaw) * np.cos(np.radians(elev)), np.sin(np.radians(elev)), np.cos(yaw) * np.cos(np.radians(elev))])
            self._aim(j, nxt, target, 180.0)
        if self.head is not None and self.children[self.head]:
            self._aim(self.head, None, [0.0, -0.15, 1.0], 120.0)

    def _posed_low(self, motion=None):
        """The lowest vertex of the mesh in the stance, with the turns of `motion` ({joint: [(axis, degrees)…]}) on top
        (linear blend skinning of the bind-pose vertices)."""
        import numpy as np
        g, views = self.gltf, self.views
        nodes = g['nodes']
        skin = g['skins'][0]
        ibm = _accessor(g, views, skin['inverseBindMatrices']).astype(np.float64).reshape(-1, 4, 4).transpose(0, 2, 1)
        world = {}

        def w(j):
            if j not in world:
                q = self.base[j]['rotation']
                qd = self.stance_q.get(j, np.array([0, 0, 0, 1.0]))
                for axis, deg in (motion or {}).get(j, []):
                    qd = _quat_mul(_axis_quat(axis, deg), qd)
                if abs(abs(qd[3]) - 1.0) > 1e-12:
                    q = _quat_mul(q, _quat_mul(_quat_conj(self.qworld[j]), _quat_mul(qd, self.qworld[j])))
                local = _local_matrix({'translation': list(self.base[j]['translation']), 'rotation': list(q),
                                       'scale': list(self.base[j]['scale'])})
                world[j] = (w(self.parent[j]) @ local) if j in self.parent else local
            return world[j]

        mats = np.array([w(j) @ ibm[k] for k, j in enumerate(skin['joints'])])
        holder = next(n for n in nodes if 'mesh' in n and 'skin' in n)
        low = None
        for prim in g['meshes'][holder['mesh']]['primitives']:
            a = prim['attributes']
            if 'JOINTS_0' not in a or 'WEIGHTS_0' not in a:
                continue
            pos = _accessor(g, views, a['POSITION']).astype(np.float64)
            jj = np.minimum(_accessor(g, views, a['JOINTS_0']).astype(np.int64), len(mats) - 1)
            ww = _float_keys(g, views, a['WEIGHTS_0'])
            y = np.zeros(len(pos))
            for c in range(jj.shape[1]):
                m = mats[jj[:, c]]
                y += ww[:, c] * (np.einsum('nj,nj->n', m[:, 1, :3], pos) + m[:, 1, 3])
            total = ww.sum(axis=1)
            ok = total > 1e-6
            if ok.any():
                v = float((y[ok] / total[ok]).min())
                low = v if low is None else min(low, v)
        return self.ground if low is None else low

    def _acc(self, j):
        import numpy as np
        m = np.eye(3)
        for a in reversed(self.ancestors(j)):
            if a in self.stance:
                m = m @ self.stance[a]
        return m

    def _final_dir(self, j, nxt):
        return self._acc(j) @ self.stance.get(j, __import__('numpy').eye(3)) @ self.direction(j, nxt)

    def _aim(self, j, nxt, target, limit):
        """Turns bone j so that it points to target after its parents' turns (limited to `limit` degrees)."""
        import numpy as np
        acc = self._acc(j)
        cur = self.stance.get(j, np.eye(3)) @ self.direction(j, nxt)
        r = _rot_between(cur, acc.T @ _unit(target))
        if r is None:
            return
        self.stance[j] = _rot_matrix(r[0], min(r[1], limit)) @ self.stance.get(j, np.eye(3))

    # ——— motion ———

    def pose(self, role, t, T):
        """{joint: [(axis, degrees), …]} world turns on top of the stance, and the root offset, at time t of a clip."""
        import numpy as np
        X, Y, Z = np.array([1.0, 0, 0]), np.array([0, 1.0, 0]), np.array([0, 0, 1.0])
        H = self.height
        rot, off = {}, np.zeros(3)
        wv = 2 * np.pi * t / T
        u = t / T

        def add(j, axis, deg):
            if j is not None and abs(deg) > 1e-6:
                rot.setdefault(j, []).append((axis, deg))

        def wave(chain, axis, amp, freq, lag, phase=0.0, grow=0.15):
            for k, j in enumerate(chain[:-1] if len(chain) > 1 else chain):
                add(j, axis, amp * (1 + grow * k) * np.sin(freq * wv - lag * k + phase))

        plan = self.plan
        legs = {l['side']: l for l in self.walking_legs}
        if role == 'idle':
            breath = np.sin(2 * wv)
            look = _curve([(0, 0), (.12, 0), (.24, 16), (.42, 16), (.56, -11), (.72, -11), (.86, 0), (1, 0)], u)
            nod = _curve([(0, 0), (.3, 0), (.38, -5), (.5, -5), (.58, 3), (.66, 0), (1, 0)], u)
            for k, j in enumerate(self.spines):
                add(j, X, 1.6 * breath)
                add(j, Y, 1.5 * np.sin(wv + 0.3 * k))
            for j in self.necks:
                add(j, Y, 0.35 * look / max(1, len(self.necks)))
                add(j, X, 0.4 * nod / max(1, len(self.necks)))
            add(self.head, Y, 0.65 * look if self.necks else look)
            add(self.head, X, (0.6 if self.necks else 1.0) * nod + 1.5 * np.sin(2 * wv - 1.0))
            add(self.head, Z, 3.0 * np.sin(wv + 1.0))
            for j in self.jaws:
                add(j, X, 7.0 * _smooth(0.62, 0.68, u) * (1 - _smooth(0.74, 0.82, u)))
            for a in self.hands:
                add(a['arm'], X, 3.0 * np.sin(2 * wv + a['side']))
                add(a['arm'], Z, -a['side'] * 2.0 * breath)
                add(a['fore'], X, -3.0 * np.sin(2 * wv + 0.6))
            for ch in self.tails:
                wave(ch, Y, 5.0, 1, 0.55)
                wave(ch, X, -1.5, 2, 0.5, 1.0)
            for ch in self.ears:
                twitch = _smooth(0.45, 0.48, u) * (1 - _smooth(0.5, 0.56, u))
                wave(ch, Z, self.side(ch[0]) * 2.5, 2, 0.4)
                add(ch[0], X, -12.0 * twitch)
            for ch in self.loose:
                wave(ch, X, 3.0, 2, 0.6, 0.5)
                wave(ch, Z, 2.0, 3, 0.5)
            if plan == 'flier':
                for wg in self.wings:
                    wave(wg['chain'], Z, wg['side'] * 26.0, 10, 0.35, 0.0, 0.05)
                off += Y * (self.hover + 0.04 * H * np.sin(10 * wv - 0.6))
            else:
                for wg in self.wings:
                    ruffle = _smooth(0.55, 0.6, u) * (1 - _smooth(0.62, 0.7, u))
                    wave(wg['chain'], Z, wg['side'] * (2.0 * breath + 12.0 * ruffle), 1, 0.3, 0.0, 0.0)
                off += Y * (self.hover + 0.006 * H * (1 + breath))
            if plan == 'serpent':
                body = list(reversed(self.spines)) + [j for ch in self.tails for j in ch]
                wave(body, Y, 3.0, 1, 0.5, 0.0, 0.0)
            elif plan == 'fish':
                for ch in self.tails:
                    wave(ch, Y, 9.0, 3, 0.6)
                for a in self.arms:
                    add(a['arm'], Z, a['side'] * 10.0 * np.sin(4 * wv))
                add(self.root, Y, 4.0 * np.sin(wv))
            elif plan == 'blob':
                add(self.root, Z, 2.5 * np.sin(wv))
                for k, j in enumerate(self.spines):
                    add(j, X, 3.0 * np.sin(2 * wv - 0.5 * k))
            else:
                add(self.root, Z, 1.2 * np.sin(wv))
                off += X * (0.006 * H * np.sin(wv))
        elif role == 'walk':
            if plan == 'biped' and len(legs) >= 2:
                stride = 0.45 if self.auto else 1.0
                if self.auto:
                    add(self.root, Z, 4.0 * np.sin(wv))           # a rough skeleton waddles more than it steps
                for s, l in legs.items():
                    x = wv + (0.0 if s > 0 else np.pi)
                    swing = 28.0 * stride * np.sin(x)              # + back, - forward
                    knee = 44.0 * stride * max(0.0, -np.cos(x)) ** 1.3  # bends while the foot is in the air
                    add(l['thigh'], X, swing)
                    add(l['shin'], X, knee)
                    add(l['foot'], X, -0.75 * (swing + knee) + 8.0 * max(0.0, np.sin(x)) ** 2)
                off += Y * (0.03 * H * 0.5 * (1 + np.cos(2 * wv))) + X * (0.012 * H * np.cos(wv))
                add(self.pelvis or self.root, Y, -5.0 * np.sin(wv))
                add(self.pelvis or self.root, Z, -2.5 * np.sin(wv))
                for k, j in enumerate(self.spines):
                    add(j, Y, 4.0 * np.sin(wv) / max(1, len(self.spines)))
                    add(j, X, 1.5 + 1.2 * np.cos(2 * wv))
                for a in self.hands:
                    x = wv + (np.pi if a['side'] > 0 else 0.0)
                    add(a['arm'], X, 16.0 * np.sin(x))
                    add(a['fore'], X, -8.0 * max(0.0, -np.sin(x - 0.5)))
                for ch in self.tails:
                    wave(ch, Y, 5.0, 1, 0.5, np.pi / 2)
                    wave(ch, X, -1.5, 2, 0.5)
                add(self.head, X, -2.0 * np.cos(2 * wv))
                add(self.head, Y, 2.0 * np.sin(wv))
            elif plan == 'quadruped':
                stride = 0.55 if self.auto else 1.0
                for s, l in legs.items():
                    x = wv + (0.0 if s > 0 else np.pi)
                    add(l['thigh'], X, 24.0 * stride * np.sin(x))
                    add(l['shin'], X, 30.0 * stride * max(0.0, -np.cos(x)) ** 1.3)
                    add(l['foot'], X, -14.0 * stride * np.sin(x - 0.6))
                for a in self.front_legs:
                    x = wv + (0.0 if a['side'] < 0 else np.pi)      # diagonal pairs, like a trot
                    add(a['arm'], X, 22.0 * stride * np.sin(x))
                    add(a['fore'], X, 22.0 * stride * max(0.0, -np.cos(x)) ** 1.3)
                    add(a['hand'], X, 30.0 * stride * max(0.0, -np.cos(x - 0.3)) ** 2)
                off += Y * (0.035 * H * 0.5 * (1 - np.cos(2 * wv)))
                add(self.root, Z, 2.5 * np.sin(wv))
                for k, j in enumerate(self.spines):
                    add(j, Y, 3.0 * np.sin(wv - 0.4 * k))
                    add(j, X, 2.0 * np.sin(2 * wv - 0.5))
                for j in self.necks + [self.head]:
                    add(j, X, -2.5 * np.sin(2 * wv - 0.4))
                for ch in self.tails:
                    wave(ch, Y, 7.0, 1, 0.6)
                    wave(ch, X, 2.0, 2, 0.5)
                for a in self.hands:
                    add(a['arm'], X, 10.0 * np.sin(wv))
            elif plan in ('bird', 'blob') or (plan == 'biped' and len(legs) < 2):
                hop = abs(np.sin(wv))                               # two hops per loop
                land = max(0.0, np.cos(2 * wv)) ** 3                # knees bend as it lands
                off += Y * (0.08 * H * hop)
                for l in legs.values():
                    add(l['thigh'], X, -14.0 * land)
                    add(l['shin'], X, 26.0 * land)
                    add(l['foot'], X, -12.0 * land)
                for wg in self.wings:
                    wave(wg['chain'], Z, wg['side'] * 9.0 * hop, 0, 0.3, np.pi / 2, 0.0)
                add(self.head, X, 6.0 * np.sin(2 * wv + 0.8))
                if plan == 'blob':
                    add(self.root, Z, 6.0 * np.sin(wv))
                    for k, j in enumerate(self.spines):
                        add(j, X, 5.0 * land)
                for ch in self.tails:
                    wave(ch, X, -6.0 * hop, 0, 0.4, np.pi / 2)
                for a in self.hands:
                    add(a['arm'], Z, -a['side'] * 8.0 * hop)
            elif plan == 'flier':
                for wg in self.wings:
                    wave(wg['chain'], Z, wg['side'] * 34.0, 2, 0.4, 0.0, 0.05)
                off += Y * (self.hover + 0.05 * H * np.sin(2 * wv - 0.8))
                add(self.root, X, 8.0)
                add(self.head, X, -6.0)
                for l in self.legs:
                    add(l['thigh'], X, 12.0 + 5.0 * np.sin(2 * wv))
                for ch in self.tails + self.loose:
                    wave(ch, X, 4.0, 2, 0.5)
            elif plan == 'serpent':
                body = list(reversed(self.spines)) + [j for ch in self.tails for j in ch]
                wave(body, Y, 11.0, 1, 0.75, 0.0, 0.0)
                add(self.head, Y, -6.0 * np.sin(wv + 0.3))
                for j in self.spines[-2:]:
                    add(j, X, -4.0)
            elif plan == 'fish':
                for ch in self.tails:
                    wave(ch, Y, 16.0, 2, 0.7)
                add(self.root, Y, 6.0 * np.sin(2 * wv))
                for a in self.arms:
                    add(a['arm'], Z, a['side'] * 16.0 * np.sin(2 * wv + 1.0))
                off += Y * (self.hover + 0.03 * H * np.sin(2 * wv))
            for ch in self.ears:
                wave(ch, X, 6.0, 2, 0.5)
            for ch in self.loose:
                wave(ch, X, 5.0, 2, 0.6)
        elif role == 'attack':
            a = _smooth(0.0, 0.35, t) - _smooth(0.35, 0.48, t)     # wind-up
            s = _smooth(0.35, 0.48, t) - _smooth(0.62, 1.0, t)      # strike
            for j in self.spines:
                add(j, X, (-10.0 * a + 16.0 * s) / max(1, len(self.spines)) * 2)
            for j in self.necks:
                add(j, X, -5.0 * a + 8.0 * s)
            add(self.head, X, -6.0 * a + 10.0 * s)
            for j in self.jaws:
                add(j, X, 8.0 * a + 26.0 * s)
            for arm in self.hands:
                main = arm['side'] < 0 or len(self.hands) == 1
                add(arm['arm'], X, (-75.0 * a + 30.0 * s) if main else (15.0 * a - 10.0 * s))
                add(arm['fore'], X, -30.0 * a if main else 0.0)
                add(arm['arm'], Z, arm['side'] * (10.0 * s if main else 0.0))
            for arm in self.front_legs:
                add(arm['arm'], X, 10.0 * a - 35.0 * s)
            for l in self.walking_legs:
                add(l['thigh'], X, -10.0 * a + 8.0 * s)
                add(l['shin'], X, 18.0 * a)
            for wg in self.wings:
                wave(wg['chain'], Z, wg['side'] * (38.0 * a - 26.0 * s), 0, 0.3, np.pi / 2, 0.0)
            for ch in self.tails:
                wave(ch, Y, 12.0 * (a + s), 0, 0.5, np.pi / 2)
                wave(ch, X, -8.0 * a, 0, 0.3, np.pi / 2)
            if plan == 'serpent':
                # rears back and strikes: the raised front of the body coils and uncoils
                front = self.spines + self.necks
                for k, j in enumerate(front):
                    add(j, X, (-28.0 * a + 30.0 * s) / max(1, len(front)))
            off += Z * (-0.05 * H * a + 0.22 * H * s) + Y * (self.hover - 0.04 * H * a + 0.05 * H * s)
        elif role == 'faint':
            f = _smooth(0.0, 0.75, t)
            buckle = _smooth(0.0, 0.35, t)
            for l in self.walking_legs:
                add(l['thigh'], X, -28.0 * buckle)
                add(l['shin'], X, 45.0 * buckle)
            if plan != 'serpent':
                for j in self.spines:
                    add(j, X, 14.0 * f / max(1, len(self.spines)) * 2)
                for j in self.necks:
                    add(j, X, 12.0 * f)
            add(self.head, X, (10.0 if plan == 'serpent' else 22.0) * f)
            for j in self.jaws:
                add(j, X, 10.0 * f)
            for arm in self.hands:
                add(arm['arm'], X, 12.0 * f)
            for wg in self.wings:
                wave(wg['chain'], Z, -wg['side'] * 20.0 * f, 0, 0.0, np.pi / 2, 0.0)
            for ch in self.tails:
                wave(ch, X, 6.0 * f, 0, 0.0, np.pi / 2)
            if plan == 'serpent':
                # a snake goes limp: the raised front of the body sinks to the ground, no rolling over
                front = self.spines + self.necks
                for k, j in enumerate(front):
                    add(j, X, 60.0 * f / max(1, len(front)))
                roll = 12.0 * _smooth(0.15, 0.85, t)
            else:
                roll = (95.0 if plan == 'fish' else 78.0) * _smooth(0.15, 0.85, t)  # fish turn belly up
            add(self.root, Z, roll)
            if not getattr(self, '_measuring', False):
                if not hasattr(self, '_lying'):
                    # where the body ends up: the lowest vertex of the last pose goes onto the ground
                    self._measuring = True
                    end, _ = self.pose('faint', T, T)
                    self._measuring = False
                    self._lying = self.ground - self._posed_low(end) - self.lift
                off += Y * (self.hover * (1 - f) + self._lying * _smooth(0.15, 0.85, t))
        return rot, off


def _procedural_clips(gltf, views, add_view, info=None):
    import numpy as np
    nodes = gltf.get('nodes', [])
    skins = gltf.get('skins', [])
    holders = [i for i, n in enumerate(nodes) if 'mesh' in n and 'skin' in n]
    if len(skins) != 1 or len(holders) != 1:
        return None
    anims = gltf.get('animations', [])
    have = {clip_role(a.get('name', '')) for a in anims}
    missing = [r for r in ('idle', 'walk', 'attack', 'faint') if r not in have]
    if not missing:
        return None
    root = skins[0].get('skeleton', skins[0]['joints'][0])
    if any(root in n.get('children', []) for n in nodes):
        return None  # not canonical (see _canonicalize): leave it
    rig = _Rig(gltf, views, info)
    joints = rig.joints
    specs = {'idle': (4.0, 96, True), 'walk': (0.8, 24, True), 'attack': (1.0, 30, False), 'faint': (1.1, 26, False)}
    for role in missing:
        T, n, loop = specs[role]
        times = np.linspace(0.0, T, n + 1)
        rot_keys, root_keys = {}, []
        for t in times:
            rot, off = rig.pose(role, t, T)
            for j in joints:
                q = rig.base[j]['rotation']
                qd = rig.stance_q.get(j, np.array([0, 0, 0, 1.0]))
                for axis, deg in rot.get(j, []):
                    qd = _quat_mul(_axis_quat(axis, deg), qd)
                if abs(abs(qd[3]) - 1.0) > 1e-12:
                    # a world-axis turn about the bone's own pivot, written in the bone's local frame
                    q = _quat_mul(q, _quat_mul(_quat_conj(rig.qworld[j]), _quat_mul(qd, rig.qworld[j])))
                rot_keys.setdefault(j, []).append(q / np.linalg.norm(q))
            root_keys.append(rig.base[root]['translation'] + off + np.array([0.0, rig.lift, 0.0]))
        anim = {'name': f'liga_{role}', 'samplers': [], 'channels': []}
        tarr = np.ascontiguousarray(times.reshape(-1, 1), dtype=np.float32)
        gltf['accessors'].append({'bufferView': add_view(tarr.tobytes()), 'byteOffset': 0, 'componentType': 5126,
                                  'count': len(times), 'type': 'SCALAR', 'min': [0.0], 'max': [float(T)]})
        t_acc = len(gltf['accessors']) - 1

        def channel(j, path, values):
            arr = np.ascontiguousarray(values, dtype=np.float32)
            gltf['accessors'].append({'bufferView': add_view(arr.tobytes()), 'byteOffset': 0, 'componentType': 5126,
                                      'count': len(arr), 'type': 'VEC4' if path == 'rotation' else 'VEC3'})
            anim['samplers'].append({'input': t_acc, 'output': len(gltf['accessors']) - 1, 'interpolation': 'LINEAR'})
            anim['channels'].append({'sampler': len(anim['samplers']) - 1, 'target': {'node': j, 'path': path}})

        for j in joints:
            keys = np.array(rot_keys[j])
            rest_q = np.array(nodes[j].get('rotation', _REST['rotation']))
            if np.abs(np.abs(keys @ rest_q) - 1).max() > 1e-7:
                channel(j, 'rotation', keys)
            for p in ('translation', 'scale'):
                if j == root and p == 'translation':
                    continue
                if not np.allclose(rig.base[j][p], nodes[j].get(p, _REST[p]), atol=1e-7):
                    channel(j, p, np.tile(rig.base[j][p], (len(times), 1)))
        channel(root, 'translation', np.array(root_keys))
        gltf.setdefault('animations', []).append(anim)
    return rig


# ——— fire, auto-rig, centring ———

def _fire_materials(gltf, views, info):
    """The flames of Charizard, Rapidash or Magmar come as grey masks that the original games tint in a shader: here they
    became grey smoke. For Fire-type Pokémon a grey texture (not an eye) becomes a glowing orange-to-yellow flame whose
    dark parts are cut away."""
    import numpy as np
    from PIL import Image
    if 'fire' not in (info or {}).get('types', []):
        return
    textures, images = gltf.get('textures', []), gltf.get('images', [])
    done = {}
    for mat in gltf.get('materials', []):
        ref = mat.get('pbrMetallicRoughness', {}).get('baseColorTexture')
        if not ref or ref.get('index') is None or ref['index'] >= len(textures):
            continue
        src = textures[ref['index']].get('source')
        if src is None or src >= len(images) or 'bufferView' not in images[src]:
            continue
        name = (images[src].get('name') or '') + (mat.get('name') or '')
        if re.search(r'iris|eye', name, re.I):
            continue
        if src not in done:
            img = Image.open(io.BytesIO(views[images[src]['bufferView']])).convert('RGB')
            a = np.asarray(img).astype(np.float64) / 255.0
            if (a.max(axis=2) - a.min(axis=2)).mean() > 0.012:
                done[src] = False
                continue
            lum = a.mean(axis=2)
            hot = np.clip((lum - 0.15) / 0.75, 0.0, 1.0)[..., None]
            rgb = np.array([1.0, 0.32, 0.06]) * (1 - hot) + np.array([1.0, 0.86, 0.32]) * hot
            alpha = np.clip((lum - 0.12) / 0.35, 0.0, 1.0)
            out = Image.fromarray(np.dstack([rgb * 255, alpha * 255]).round().astype(np.uint8), 'RGBA')
            buf = io.BytesIO()
            out.save(buf, 'PNG')
            views[images[src]['bufferView']] = buf.getvalue()
            images[src]['mimeType'] = 'image/png'
            done[src] = True
        if done[src]:
            mat['alphaMode'] = 'MASK'
            mat['alphaCutoff'] = 0.3
            mat['doubleSided'] = True
            mat['emissiveTexture'] = {'index': ref['index']}
            mat['emissiveFactor'] = [1.0, 1.0, 1.0]
            mat.setdefault('pbrMetallicRoughness', {})['metallicFactor'] = 0.0


AUTO_ROOT = 'LigaAutoRoot'  # names the root of a skeleton made by _autorig


def _autorig(gltf, views, add_view, info):
    """A skeleton for a model that came without one, so it can breathe, look around and walk instead of standing still.
    The bones follow the body plan of its shape (two legs, four legs, wings, a long body, or a blob) and the same names
    as the real skeletons (Hips, Spine1, Head, LThigh…), so _Rig animates them like any other; every vertex is weighted
    smoothly along the body and, low down, to the leg under it."""
    import numpy as np
    nodes = gltf.get('nodes', [])
    holders = [i for i, n in enumerate(nodes) if 'mesh' in n]
    if len(holders) != 1 or gltf.get('skins') or 'skin' in nodes[holders[0]]:
        return
    mi = holders[0]
    if any(k in nodes[mi] for k in ('translation', 'rotation', 'scale', 'matrix')):
        return
    prims = gltf['meshes'][nodes[mi]['mesh']]['primitives']
    if any(p.get('mode', 4) != 4 or 'POSITION' not in p['attributes'] for p in prims):
        return
    pts = np.concatenate([_accessor(gltf, views, p['attributes']['POSITION']) for p in prims]).astype(np.float64)
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    W, H, L = hi - lo
    if min(H, W, L) <= 1e-6:
        return
    cx, cz = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2
    y = lambda f: lo[1] + f * H
    z = lambda f: lo[2] + f * L
    shape = (info or {}).get('shape', '')
    if shape in ('quadruped',):
        plan = 'quadruped'
    elif shape in ('fish', 'squiggle'):
        plan = 'long'
    elif shape in ('wings', 'bug-wings'):
        plan = 'winged'
    elif shape in ('upright', 'humanoid', 'legs'):
        plan = 'biped'
    else:
        plan = 'blob'

    bones = []  # (name, parent index, position)

    def bone(name, parent, at):
        bones.append((name, parent, np.array(at, dtype=np.float64)))
        return len(bones) - 1

    root = bone(AUTO_ROOT, None, [cx, lo[1], cz])
    limbs = []  # (bone indices top to bottom, membership function of the points)
    smooth = lambda a, b, v: np.clip((v - a) / (b - a), 0.0, 1.0) ** 2 * (3 - 2 * np.clip((v - a) / (b - a), 0.0, 1.0))
    if plan == 'quadruped':
        hips = bone('Hips', root, [cx, y(0.5), z(0.3)])
        s1 = bone('Spine1', hips, [cx, y(0.55), z(0.5)])
        s2 = bone('Spine2', s1, [cx, y(0.58), z(0.68)])
        neck = bone('Neck', s2, [cx, y(0.68), z(0.8)])
        head = bone('Head', neck, [cx, y(0.78), z(0.9)])
        body = [(hips, z(0.3)), (s1, z(0.5)), (s2, z(0.68)), (neck, z(0.8)), (head, z(0.92))]
        body_axis = 2
        below = smooth(y(0.38), y(0.26), pts[:, 1])
        front = smooth(cz - 0.04 * L, cz + 0.04 * L, pts[:, 2])
        for s, sign in ((1, 1.0), (-1, -1.0)):
            side = smooth(-0.04 * W, 0.04 * W, sign * (pts[:, 0] - cx))
            p = 'L' if s > 0 else 'R'
            x = cx + sign * 0.22 * W
            t = bone(f'{p}Thigh', hips, [x, y(0.36), z(0.28)])
            k = bone(f'{p}Leg', t, [x, y(0.18), z(0.28)])
            f = bone(f'{p}Foot', k, [x, y(0.03), z(0.28)])
            limbs.append(([t, k, f], below * side * (1 - front)))
            a = bone(f'{p}Arm', s2, [x, y(0.36), z(0.72)])
            fa = bone(f'{p}ForeArm', a, [x, y(0.18), z(0.72)])
            h = bone(f'{p}Hand', fa, [x, y(0.03), z(0.72)])
            limbs.append(([a, fa, h], below * side * front))
    elif plan == 'long':
        hips = bone('Hips', root, [cx, y(0.5), z(0.45)])
        s1 = bone('Spine1', hips, [cx, y(0.5), z(0.62)])
        s2 = bone('Spine2', s1, [cx, y(0.5), z(0.78)])
        head = bone('Head', s2, [cx, y(0.5), z(0.92)])
        t1 = bone('Tail1', hips, [cx, y(0.5), z(0.3)])
        t2 = bone('Tail2', t1, [cx, y(0.5), z(0.16)])
        t3 = bone('Tail3', t2, [cx, y(0.5), z(0.04)])
        body = [(t3, z(0.04)), (t2, z(0.16)), (t1, z(0.3)), (hips, z(0.45)), (s1, z(0.62)), (s2, z(0.78)), (head, z(0.92))]
        body_axis = 2
    else:
        hips = bone('Hips', root, [cx, y(0.3), cz])
        s1 = bone('Spine1', hips, [cx, y(0.5), cz])
        s2 = bone('Spine2', s1, [cx, y(0.66), cz])
        head = bone('Head', s2, [cx, y(0.8), cz])
        body = [(hips, y(0.3)), (s1, y(0.5)), (s2, y(0.66)), (head, y(0.82))]
        body_axis = 1
        if plan == 'biped':
            below = smooth(y(0.3), y(0.2), pts[:, 1])
            arms = _t_pose_arms(pts, lo, hi)
            for s, sign in ((1, 1.0), (-1, -1.0)):
                side = smooth(-0.04 * W, 0.04 * W, sign * (pts[:, 0] - cx))
                p = 'L' if s > 0 else 'R'
                x = cx + sign * 0.2 * W
                t = bone(f'{p}Thigh', hips, [x, y(0.26), cz])
                k = bone(f'{p}Leg', t, [x, y(0.13), cz])
                f = bone(f'{p}Foot', k, [x, y(0.02), cz])
                limbs.append(([t, k, f], below * side))
                if arms:
                    at, shoulder, reach, band = arms
                    a = bone(f'{p}Arm', s2, [cx + sign * shoulder, at, cz])
                    fa = bone(f'{p}ForeArm', a, [cx + sign * (shoulder + reach) / 2, at, cz])
                    h = bone(f'{p}Hand', fa, [cx + sign * reach * 0.92, at, cz])
                    out = smooth(shoulder * 0.85, shoulder * 1.1, sign * (pts[:, 0] - cx))
                    near = smooth(at - band, at - band * 0.6, pts[:, 1]) * smooth(at + band, at + band * 0.6, pts[:, 1])
                    limbs.append(([a, fa, h], out * near, 0))
        elif plan == 'winged':
            for s, sign in ((1, 1.0), (-1, -1.0)):
                out = smooth(0.18 * W, 0.3 * W, sign * (pts[:, 0] - cx))
                p = 'L' if s > 0 else 'R'
                w1 = bone(f'{p}Wing1', s1, [cx + sign * 0.18 * W, y(0.55), cz])
                w2 = bone(f'{p}Wing2', w1, [cx + sign * 0.36 * W, y(0.55), cz])
                w3 = bone(f'{p}Wing3', w2, [cx + sign * 0.5 * W, y(0.55), cz])
                limbs.append(([w1, w2, w3], out))
    if len(bones) > 60:
        return

    def along(chain, coord):
        """Weights (n, len(chain)) blending linearly between the bones placed at the given coordinates."""
        idx = [b for b, _ in chain]
        at = np.array([c for _, c in chain])
        order = np.argsort(at)
        at, idx = at[order], [idx[i] for i in order]
        wts = np.zeros((len(coord), len(idx)))
        c = np.clip(coord, at[0], at[-1])
        k = np.clip(np.searchsorted(at, c, side='right') - 1, 0, len(at) - 2) if len(at) > 1 else np.zeros(len(c), int)
        if len(at) == 1:
            wts[:, 0] = 1.0
            return idx, wts
        span = np.maximum(at[k + 1] - at[k], 1e-9)
        f = (c - at[k]) / span
        wts[np.arange(len(c)), k] = 1 - f
        wts[np.arange(len(c)), k + 1] += f
        return idx, wts

    full = np.zeros((len(pts), len(bones)))
    used = np.zeros(len(pts))
    for limb in limbs:
        chain, member = limb[0], np.clip(limb[1], 0.0, 1.0)
        axis = limb[2] if len(limb) > 2 else 1  # legs blend by height, arms held out by the distance from the body
        coord = np.abs(pts[:, 0] - cx) if axis == 0 else pts[:, axis]
        place = (lambda b: abs(bones[b][2][0] - cx)) if axis == 0 else (lambda b: bones[b][2][axis])
        idx, wts = along([(b, place(b)) for b in chain], coord)
        for col, b in enumerate(idx):
            full[:, b] += member * wts[:, col]
        used += member
    idx, wts = along(body, pts[:, body_axis])
    rest = np.clip(1.0 - used, 0.0, 1.0)
    for col, b in enumerate(idx):
        full[:, b] += rest * wts[:, col]
    top4 = np.argsort(-full, axis=1)[:, :4]
    w4 = np.take_along_axis(full, top4, axis=1)
    w4 = w4 / np.maximum(w4.sum(axis=1, keepdims=True), 1e-9)
    w4[w4.sum(axis=1) < 1e-6, 0] = 1.0

    # nodes, skin, attributes
    base = len(nodes)
    for name, parent, at in bones:
        rel = at - (bones[parent][2] if parent is not None else np.zeros(3))
        nodes.append({'name': name, 'translation': [float(v) for v in rel]})
    for b, (name, parent, at) in enumerate(bones):
        if parent is not None:
            nodes[base + parent].setdefault('children', []).append(base + b)
    ibm = np.array([np.linalg.inv(np.array([[1, 0, 0, at[0]], [0, 1, 0, at[1]], [0, 0, 1, at[2]], [0, 0, 0, 1.0]])).T
                    for _, _, at in bones], dtype=np.float32).reshape(-1, 16)
    gltf['accessors'].append({'bufferView': add_view(np.ascontiguousarray(ibm).tobytes()), 'byteOffset': 0,
                              'componentType': 5126, 'count': len(bones), 'type': 'MAT4'})
    gltf['skins'] = [{'joints': [base + b for b in range(len(bones))], 'skeleton': base,
                      'inverseBindMatrices': len(gltf['accessors']) - 1}]
    nodes[mi]['skin'] = 0
    start = 0
    for p in prims:
        n = gltf['accessors'][p['attributes']['POSITION']]['count']
        jj = np.ascontiguousarray(top4[start:start + n], dtype=np.uint16)
        ww = np.ascontiguousarray(w4[start:start + n], dtype=np.float32)
        start += n
        gltf['accessors'].append({'bufferView': add_view(jj.tobytes(), 34962), 'byteOffset': 0, 'componentType': 5123,
                                  'count': int(n), 'type': 'VEC4'})
        p['attributes']['JOINTS_0'] = len(gltf['accessors']) - 1
        gltf['accessors'].append({'bufferView': add_view(ww.tobytes(), 34962), 'byteOffset': 0, 'componentType': 5126,
                                  'count': int(n), 'type': 'VEC4'})
        p['attributes']['WEIGHTS_0'] = len(gltf['accessors']) - 1
    scene = gltf['scenes'][gltf.get('scene', 0)]
    scene['nodes'] = [base] + [r for r in scene['nodes'] if r != base]


def _t_pose_arms(pts, lo, hi):
    """(height, shoulder distance, hand distance, half band) of arms held straight out from a model without a skeleton,
    or None. They show as a band of the body much wider than the hips (Hypno, Electabuzz, Magmar)."""
    import numpy as np
    H = hi[1] - lo[1]
    cx = (lo[0] + hi[0]) / 2
    half = []
    for f in np.arange(0.15, 0.9, 0.05):
        band = np.abs(pts[(pts[:, 1] >= lo[1] + f * H) & (pts[:, 1] < lo[1] + (f + 0.05) * H), 0] - cx)
        half.append((f, float(np.percentile(band, 99)) if len(band) > 20 else 0.0))
    body = np.median([w for f, w in half if 0.2 <= f <= 0.45 and w > 0] or [0.0])
    top = max(((f, w) for f, w in half if 0.4 <= f <= 0.85), key=lambda fw: fw[1], default=(0, 0))
    if body <= 0 or top[1] < 1.8 * body or top[1] < 0.18 * H:
        return None
    return lo[1] + (top[0] + 0.025) * H, body * 1.05, top[1], 0.18 * H


def _strip_root_motion(gltf, views, add_view):
    """Walk and run clips from the games move the body forwards (root motion). The game moves the Pokémon itself and
    loops the clip, so it jumped back at every loop (Dragonite, Mewtwo, Feraligatr): the forward drift of the top bones
    is taken out, their bobbing and swaying stay."""
    import numpy as np
    nodes = gltf.get('nodes', [])
    if not gltf.get('skins'):
        return
    joints = gltf['skins'][0]['joints']
    parent = {c: i for i, n in enumerate(nodes) for c in n.get('children', [])}
    depth = lambda j: 0 if j not in parent else 1 + depth(parent[j])
    top = {j for j in joints if depth(j) <= 3}
    for anim in gltf.get('animations', []):
        if clip_role(anim.get('name', '')) != 'walk':
            continue
        for ci, ch in enumerate(anim['channels']):
            if ch['target']['node'] not in top or ch['target'].get('path') != 'translation':
                continue
            sampler = dict(anim['samplers'][ch['sampler']])
            ts = _float_keys(gltf, views, sampler['input']).ravel()
            out = _float_keys(gltf, views, sampler['output']).astype(np.float64)
            if len(ts) < 2 or ts[-1] <= ts[0]:  # a steady forward glide has just two keys
                continue
            drift = out[-1] - out[0]
            spread = np.abs(out - out[0]).max(axis=0)
            if np.hypot(drift[0], drift[2]) < 0.5 * max(spread[0], spread[2], 1e-9) or np.hypot(drift[0], drift[2]) < 1e-6:
                continue
            ramp = ((ts - ts[0]) / (ts[-1] - ts[0]))[:, None] * np.array([drift[0], 0.0, drift[2]])
            arr = np.ascontiguousarray(out - ramp, dtype=np.float32)
            gltf['accessors'].append({'bufferView': add_view(arr.tobytes()), 'byteOffset': 0, 'componentType': 5126,
                                      'count': int(len(arr)), 'type': 'VEC3'})
            sampler['output'] = len(gltf['accessors']) - 1
            anim['samplers'].append(sampler)
            anim['channels'][ci] = dict(ch, sampler=len(anim['samplers']) - 1)


def _recenter(gltf, views, add_view):
    """Puts the body over the origin and the feet at height 0. Some files have the Pokémon a third of its height to the
    side (Charmander, Flareon): in the game it then turned around a point beside itself."""
    import numpy as np
    nodes = gltf.get('nodes', [])
    holders = [i for i, n in enumerate(nodes) if 'mesh' in n]
    if len(holders) != 1 or any(k in nodes[holders[0]] for k in ('translation', 'rotation', 'scale', 'matrix')):
        return
    prims = gltf['meshes'][nodes[holders[0]]['mesh']]['primitives']
    pts = np.concatenate([_accessor(gltf, views, p['attributes']['POSITION']) for p in prims]).astype(np.float64)
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    d = np.array([-(lo[0] + hi[0]) / 2, -lo[1], -(lo[2] + hi[2]) / 2])
    skins = gltf.get('skins', [])
    skinned = 'skin' in nodes[holders[0]] and len(skins) == 1
    if skinned:
        skin = skins[0]
        joints = skin['joints']
        root = skin.get('skeleton', joints[0])
        if any(root in n.get('children', []) for n in nodes) or 'matrix' in nodes[root]:
            return
        parent = {c: i for i, n in enumerate(nodes) for c in n.get('children', [])}
        depth = lambda j: 0 if j not in parent else 1 + depth(parent[j])
        pelvis = [j for j in joints if _bone_kind(nodes[j].get('name', ''))[1] == 'pelvis']
        if pelvis:
            d[2] = -_world_matrix(gltf, min(pelvis, key=depth))[2, 3]  # turn about the hips, not the middle of a long tail
    if np.abs(d).max() < 1e-6 * max(1.0, np.abs(hi - lo).max()):
        return
    for p in prims:
        pos = _accessor(gltf, views, p['attributes']['POSITION']).astype(np.float64)
        _set_attribute(gltf, add_view, p, 'POSITION', pos + d)
    if not skinned:
        return
    nodes[root]['translation'] = [float(v) for v in np.array(nodes[root].get('translation', _REST['translation'])) + d]
    ibm = _accessor(gltf, views, skin['inverseBindMatrices']).astype(np.float64).reshape(-1, 4, 4).transpose(0, 2, 1)
    back = np.eye(4)
    back[:3, 3] = -d
    ibm = np.array([m @ back for m in ibm]).transpose(0, 2, 1).reshape(-1, 16).astype(np.float32)
    gltf['accessors'].append({'bufferView': add_view(np.ascontiguousarray(ibm).tobytes()), 'byteOffset': 0,
                              'componentType': 5126, 'count': len(joints), 'type': 'MAT4'})
    skin['inverseBindMatrices'] = len(gltf['accessors']) - 1
    for anim in gltf.get('animations', []):
        for ci, ch in enumerate(anim['channels']):
            if ch['target']['node'] != root or ch['target'].get('path') != 'translation':
                continue
            sampler = dict(anim['samplers'][ch['sampler']])
            out = np.ascontiguousarray(_float_keys(gltf, views, sampler['output']) + d, dtype=np.float32)
            gltf['accessors'].append({'bufferView': add_view(out.tobytes()), 'byteOffset': 0, 'componentType': 5126,
                                      'count': int(len(out)), 'type': 'VEC3'})
            sampler['output'] = len(gltf['accessors']) - 1
            anim['samplers'].append(sampler)
            anim['channels'][ci] = dict(ch, sampler=len(anim['samplers']) - 1)


def _validate(gltf, views):
    """Last check before Unreal sees the file: anything still broken is refused, and the Pokémon keeps its picture."""
    import numpy as np
    for i, acc in enumerate(gltf.get('accessors', [])):
        if 'bufferView' not in acc or 'sparse' in acc:
            raise ValueError(f'accessor {i}: no plain data')
        arr = _accessor(gltf, views, i)
        if acc['componentType'] == 5126 and not np.isfinite(arr).all():
            raise ValueError(f'accessor {i}: NaN/inf')
    for mesh in gltf.get('meshes', []):
        for prim in mesh.get('primitives', []):
            pos = _accessor(gltf, views, prim['attributes']['POSITION'])
            if len(pos) == 0 or np.abs(pos).max() > _LIMIT:
                raise ValueError(f'mesh {mesh.get("name")}: bad vertex positions')
            for name, ai in prim['attributes'].items():
                if gltf['accessors'][ai]['count'] != len(pos):
                    raise ValueError(f'mesh {mesh.get("name")}: {name} does not match the vertices')
            if 'indices' in prim:
                idx = _accessor(gltf, views, prim['indices'])
                if len(idx) and int(idx.max()) >= len(pos):
                    raise ValueError(f'mesh {mesh.get("name")}: index out of range')
    skins = gltf.get('skins', [])
    for skin in skins:
        if 'inverseBindMatrices' in skin:
            ibm = _accessor(gltf, views, skin['inverseBindMatrices']).reshape(-1, 4, 4)
            if len(ibm) != len(skin['joints']) or np.abs(ibm).max() > _LIMIT or (np.abs(np.linalg.det(ibm.astype(np.float64))) < 1e-12).any():
                raise ValueError('skin: bad bind pose')
    for node in gltf.get('nodes', []):
        if 'mesh' in node and 'skin' in node:
            joints = len(skins[node['skin']]['joints'])
            for prim in gltf['meshes'][node['mesh']]['primitives']:
                for name, ai in prim['attributes'].items():
                    if name.startswith('JOINTS_') and int(_accessor(gltf, views, ai).max(initial=0)) >= joints:
                        raise ValueError(f'{name}: joint out of range')


def convert(data, species=0):
    """Draco + WebP .glb -> plain .glb with PNG textures, without the helper sphere, with clips for the species."""
    import DracoPy
    import numpy as np
    from PIL import Image

    gltf, bin_ = _read_glb(data)
    views = []
    for bv in gltf.get('bufferViews', []):
        o = bv.get('byteOffset', 0)
        views.append(bin_[o:o + bv['byteLength']])

    def add_view(raw, target=None):
        gltf['bufferViews'].append({'buffer': 0, 'byteLength': len(raw)})
        if target:
            gltf['bufferViews'][-1]['target'] = target
        views.append(raw)
        return len(views) - 1

    # geometry: decode every Draco primitive into ordinary accessors
    for mesh in gltf.get('meshes', []):
        for prim in mesh.get('primitives', []):
            ext = prim.get('extensions', {}).pop('KHR_draco_mesh_compression', None)
            if not prim.get('extensions'):
                prim.pop('extensions', None)
            if ext is None:
                continue
            dv = gltf['bufferViews'][ext['bufferView']]
            decoded = DracoPy.decode(views[ext['bufferView']][:dv['byteLength']])
            for name, uid in ext['attributes'].items():
                if name not in prim['attributes']:
                    continue
                arr = np.asarray(decoded.get_attribute_by_unique_id(uid)['data'])
                acc = gltf['accessors'][prim['attributes'][name]]
                if acc.get('normalized') and np.issubdtype(arr.dtype, np.integer) and not name.startswith('JOINTS_'):
                    arr = arr.astype(np.float64) / {5120: 127.0, 5121: 255.0, 5122: 32767.0, 5123: 65535.0}.get(acc['componentType'], 1.0)
                if name.startswith('JOINTS_'):
                    ct, arr = 5123, arr.astype(np.uint16)
                else:
                    ct, arr = 5126, arr.astype(np.float32)
                    acc.pop('normalized', None)
                    if name.startswith('WEIGHTS_'):
                        s = arr.sum(axis=1, keepdims=True)
                        arr = np.where(s > 0, arr / np.maximum(s, 1e-8), arr).astype(np.float32)
                arr = np.ascontiguousarray(arr)
                acc.update(bufferView=add_view(arr.tobytes(), 34962), byteOffset=0, componentType=ct, count=int(arr.shape[0]))
                if name == 'POSITION':
                    acc['min'] = [float(x) for x in arr.min(axis=0)]
                    acc['max'] = [float(x) for x in arr.max(axis=0)]
                else:
                    acc.pop('min', None)
                    acc.pop('max', None)
            faces = np.ascontiguousarray(np.asarray(decoded.faces, dtype=np.uint32).reshape(-1))
            if 'indices' in prim:
                acc = gltf['accessors'][prim['indices']]
                acc.update(bufferView=add_view(faces.tobytes(), 34963), byteOffset=0, componentType=5125, count=int(faces.size))
                acc.pop('min', None)
                acc.pop('max', None)

    # Sparse accessors ("zeros except these N entries", used by the source files for JOINTS_0) crash Unreal's glTF
    # importer (it read joint 21060 out of 2). Expand every sparse accessor into a plain array.
    for i, acc in enumerate(gltf.get('accessors', [])):
        sp = acc.get('sparse')
        if not sp:
            continue
        n = _NCOMP[acc['type']]
        dt = np.dtype(_DTYPE[acc['componentType']])
        base = _accessor(gltf, views, i).copy() if 'bufferView' in acc else np.zeros((acc['count'], n), dtype=dt)
        si, sv = sp['indices'], sp['values']
        idx = np.frombuffer(views[si['bufferView']], dtype=np.dtype(_DTYPE[si['componentType']]), count=sp['count'], offset=si.get('byteOffset', 0))
        vals = np.frombuffer(views[sv['bufferView']], dtype=dt, count=sp['count'] * n, offset=sv.get('byteOffset', 0)).reshape(sp['count'], n)
        base[idx.astype(np.int64)] = vals
        acc.pop('sparse')
        acc.update(bufferView=add_view(np.ascontiguousarray(base).tobytes()), byteOffset=0)

    # Accessors without a bufferView mean "all zeros" in glTF. The source files use that for JOINTS_0 when every vertex
    # follows joint 0, and for animation keys (still root translations, the time of one-key tracks). Unreal's importer
    # reads garbage from them: a crash for meshes, NaN or huge bone transforms for animations, which then took the
    # GPU down while the editor drew the thumbnail. Write the zeros out explicitly.
    for mesh in gltf.get('meshes', []):
        for prim in mesh.get('primitives', []):
            count = gltf['accessors'][prim['attributes']['POSITION']]['count']
            for name, ai in prim['attributes'].items():
                acc = gltf['accessors'][ai]
                if 'bufferView' in acc or 'sparse' in acc:
                    continue
                n = _NCOMP[acc['type']]
                joints = name.startswith('JOINTS_')
                arr = np.zeros((count, n), dtype=np.uint16 if joints else np.float32)
                if name.startswith('WEIGHTS_'):
                    arr[:, 0] = 1.0
                acc.update(bufferView=add_view(arr.tobytes(), 34962), byteOffset=0, componentType=5123 if joints else 5126, count=count)
                for k in ('normalized', 'min', 'max'):
                    acc.pop(k, None)
    for acc in gltf.get('accessors', []):
        if 'bufferView' not in acc and 'sparse' not in acc:
            arr = np.zeros((acc['count'], _NCOMP[acc['type']]), dtype=np.dtype(_DTYPE[acc['componentType']]))
            acc.update(bufferView=add_view(arr.tobytes()), byteOffset=0)

    _merge_skins(gltf, views, add_view)

    # textures: WebP -> PNG
    for img in gltf.get('images', []):
        if img.get('mimeType') == 'image/webp' and 'bufferView' in img:
            buf = io.BytesIO()
            Image.open(io.BytesIO(views[img['bufferView']])).save(buf, 'PNG')
            views[img['bufferView']] = buf.getvalue()
            img['mimeType'] = 'image/png'
    for tex in gltf.get('textures', []):
        webp = tex.get('extensions', {}).pop('EXT_texture_webp', None)
        if webp is not None:
            tex['source'] = webp['source']
        if 'extensions' in tex and not tex['extensions']:
            tex.pop('extensions')

    # the helper sphere: an unmaterialed 'Icosphere' mesh attached to the scene
    for node in gltf.get('nodes', []):
        m = node.get('mesh')
        if m is not None:
            mesh = gltf['meshes'][m]
            if node.get('name', '').startswith('Icosphere') or mesh.get('name', '').startswith('Icosphere'):
                node.pop('mesh')
                node.pop('skin', None)

    _drop_effect_parts(gltf)
    _sanitize_transforms(gltf, views, add_view)
    _merge_meshes(gltf, views, add_view)
    used = sorted({n['mesh'] for n in gltf.get('nodes', []) if 'mesh' in n})  # unused meshes would become extra assets
    remap = {old: new for new, old in enumerate(used)}
    gltf['meshes'] = [gltf['meshes'][i] for i in used]
    for node in gltf.get('nodes', []):
        if 'mesh' in node:
            node['mesh'] = remap[node['mesh']]
    info = species_info(species)
    _fire_materials(gltf, views, info)
    _canonicalize(gltf, views, add_view)
    _ensure_normals(gltf, views, add_view)
    _autorig(gltf, views, add_view, info)
    _strip_root_motion(gltf, views, add_view)
    _recenter(gltf, views, add_view)
    _procedural_clips(gltf, views, add_view, info)
    _validate(gltf, views)

    for key in ('extensionsUsed', 'extensionsRequired'):
        if key in gltf:
            gltf[key] = [e for e in gltf[key] if e not in ('KHR_draco_mesh_compression', 'EXT_texture_webp')]
            if not gltf[key]:
                gltf.pop(key)
    return _write_glb(gltf, views)


# ——— Unreal import ———

def _asset_class(d):
    return str(d.asset_class_path.asset_name) if hasattr(d, 'asset_class_path') else str(d.asset_class)


def _assets(folder):
    ar = unreal.AssetRegistryHelpers.get_asset_registry()
    if hasattr(ar, 'scan_paths_synchronous'):
        ar.scan_paths_synchronous([folder], True)
    return [(_asset_class(d), str(d.asset_name), f'{d.package_name}.{d.asset_name}') for d in ar.get_assets_by_path(folder, recursive=True)]


def describe(folder):
    """{'mesh': skeletal or static mesh, 'idle'/'walk'/'attack'/'faint'/'pose': animation sequences} found in an imported folder."""
    found = _assets(folder)
    skel = [p for c, n, p in found if c == 'SkeletalMesh']
    static = [p for c, n, p in found if c == 'StaticMesh' and 'icosphere' not in n.lower()]
    anims = [(n, p) for c, n, p in found if c == 'AnimSequence']
    if not skel and not static:
        return None
    out = {'mesh': skel[0] if skel else static[0]}
    anims.sort(key=lambda a: ('run' in a[0].lower() and 'walk' not in a[0].lower(), a[0]))  # walk before run
    for n, p in anims:
        role = clip_role(n)
        if role and role not in out:
            out[role] = p
    if anims and 'attack' not in out:  # a clip with another name (Pikachu's "Impactrueno") serves as the attack
        other = [p for n, p in anims if p not in (out.get('idle'), out.get('faint'))]
        if other:
            out['attack'] = other[0]
    if anims and 'idle' not in out:  # no idle clip: the battle shows the first frame of this one, not the rest pose
        out['pose'] = out.get('attack') or anims[0][1]
    return out


def _load_json(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


def _save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f)


def crash_counts():
    counts = _load_json(CRASHES, None)
    if not isinstance(counts, dict):
        counts = {tag: 1 for tag in _load_json(OLD_SKIP, [])}
    return counts


def is_skipped(tag):
    return crash_counts().get(tag, 0) >= CRASHES_TO_SKIP


def note_previous_crash(warn=print):
    """If the editor died while importing a model last time, that model is tried once more; after a second crash it is
    skipped from now on (it keeps its picture)."""
    tag = _load_json(GUARD, None)
    if tag:
        counts = crash_counts()
        counts[tag] = counts.get(tag, 0) + 1
        _save_json(CRASHES, counts)
        if counts[tag] >= CRASHES_TO_SKIP:
            warn(f'3D-модель {tag} уже {counts[tag]} раза роняла редактор при импорте — она пропущена, покемон останется картинкой')
        else:
            warn(f'в прошлый раз редактор упал на 3D-модели {tag} — пробую её ещё раз')
        try:
            os.remove(GUARD)
        except OSError:
            pass


def model_folder(species, shiny=False):
    return f'{DEST}/P{species:04d}{"S" if shiny else ""}'


def imported_model(species, shiny=False):
    """The assets of a model imported earlier, or None."""
    folder = model_folder(species, shiny)
    return describe(folder) if unreal.EditorAssetLibrary.does_directory_exist(folder) else None


def quick_save():
    """ULigaEditorTools.save_packages_without_thumbnails, or None when the C++ part is older than this script."""
    tools = getattr(unreal, 'LigaEditorTools', None)
    return getattr(tools, 'save_packages_without_thumbnails', None) if tools else None


def save_model(folder):
    """Saves the new model's packages without thumbnails. The editor's own save draws a thumbnail for the skeleton, the
    mesh and every animation, and keeps a preview scene for each of them in RAM and video memory for good: a hundred
    models filled 16 GB of RAM. Whatever is left unsaved (or everything, without the C++ helper) is saved the usual way."""
    save = quick_save()
    if save:
        try:
            names = [str(pk.get_name()) for pk in unreal.EditorLoadingAndSavingUtils.get_dirty_content_packages()]
        except Exception:
            names = sorted({p.split('.')[0] for _c, _n, p in _assets(folder)})
        names = [n for n in names if n.startswith(folder + '/')]
        if names:
            save(names)
    unreal.EditorAssetLibrary.save_directory(folder, only_if_is_dirty=True, recursive=True)


def free_memory_mb():
    """(free RAM, free commit charge) in MB, or None where it cannot be read (not Windows)."""
    try:
        import ctypes

        class MemoryStatus(ctypes.Structure):
            _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong),
                        ('total_phys', ctypes.c_ulonglong), ('avail_phys', ctypes.c_ulonglong),
                        ('total_page', ctypes.c_ulonglong), ('avail_page', ctypes.c_ulonglong),
                        ('total_virtual', ctypes.c_ulonglong), ('avail_virtual', ctypes.c_ulonglong),
                        ('avail_extended', ctypes.c_ulonglong)]

        st = MemoryStatus()
        st.length = ctypes.sizeof(MemoryStatus)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
            return None
        return st.avail_phys / 2 ** 20, st.avail_page / 2 ** 20
    except Exception:
        return None


MIN_FREE_RAM_MB = 1000     # below this the next model waits for the next run: the graphics driver needs RAM too, and
MIN_FREE_COMMIT_MB = 1500  # when it got none (0.4 GB left) it reset the card ("DXGI_ERROR_DRIVER_INTERNAL_ERROR")


def low_memory():
    """A short text when RAM runs low, else ''."""
    free = free_memory_mb()
    if not free:
        return ''
    ram, commit = free
    if ram < MIN_FREE_RAM_MB or commit < MIN_FREE_COMMIT_MB:
        return f'свободно {ram / 1024:.1f} ГБ оперативной памяти'
    return ''


def frame_count():
    try:
        return int(unreal.SystemLibrary.get_frame_count())
    except Exception:
        return None


def import_one(species, shiny=False, log=print, warn=print):
    """Downloads, converts and imports one model. Heavy for the graphics card: import one model per editor frame (ImportJob)."""
    tag = f'{species}{"s" if shiny else ""}'
    folder = model_folder(species, shiny)
    have = imported_model(species, shiny)
    if have:
        return have
    if is_skipped(tag):
        return None
    url = f'{BASE}/{"shiny" if shiny else "regular"}/{species}.glb'
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            raw = r.read()
    except Exception as e:
        if '404' not in str(e):
            warn(f'3D {tag}: не удалось скачать ({e})')
        return None
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f'P{species:04d}{"S" if shiny else ""}.glb')
    with open(path, 'wb') as f:
        f.write(convert(raw, species))
    t = unreal.AssetImportTask()
    t.filename = path
    t.destination_path = folder
    t.automated = True
    t.replace_existing = True
    t.save = False  # save_model() saves it, without thumbnails
    _save_json(GUARD, tag)  # if the import or the save kills the editor, the next run counts it
    try:
        unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([t])
        save_model(folder)
        got = describe(folder)
    finally:
        os.remove(GUARD)
    if not got:
        warn(f'3D {tag}: импорт не дал модели')
    return got


def old_folders():
    eal = unreal.EditorAssetLibrary
    found = [d for d in OLD_DESTS if eal.does_directory_exist(d)]
    if eal.does_directory_exist(DEST_ROOT):
        for path in eal.list_assets(DEST_ROOT, recursive=True, include_folder=True):
            parts = str(path).rstrip('/').split('/')
            if len(parts) > 4 and parts[4].startswith('V') and parts[4] != f'V{CONVERTER_VERSION}':
                folder = '/'.join(parts[:5])
                if folder not in found:
                    found.append(folder)
    return found


def refresh_old_imports(log=print, warn=print, delete=True):
    """A new converter imports into its own folder (DEST), so old models never stand in the way. The old folders are
    deleted once every new model is in (until then the game keeps showing the old ones), when Unreal allows it (it
    refuses while their assets are loaded; then the next run tries again)."""
    try:
        with open(VERSION_FILE, encoding='utf-8') as f:
            version = int(f.read().strip() or 0)
    except Exception:
        version = 0
    if version != CONVERTER_VERSION:
        # The crash counts (CRASHES) stay: a model that crashed the editor twice would only crash it once more.
        os.makedirs(CACHE, exist_ok=True)
        with open(VERSION_FILE, 'w', encoding='utf-8') as f:
            f.write(str(CONVERTER_VERSION))
    for folder in old_folders() if delete else []:
        try:
            ok = unreal.EditorAssetLibrary.delete_directory(folder)
        except Exception:
            ok = False
        log(f'старые 3D-модели {folder}: ' + ('удалены' if ok else 'пока не удалось удалить (попробую в следующий раз)'))


def current_entries(entries):
    """assets.json entries of models that are still there: this converter's, and older ones not replaced yet."""
    out = {}
    for k, v in (entries or {}).items():
        mesh = str(v.get('mesh', '')) if isinstance(v, dict) else ''
        if mesh.startswith(DEST + '/'):
            out[k] = v
        elif mesh.startswith(DEST_ROOT + '/V'):
            folder = '/'.join(mesh.split('/')[:6])  # /Game/Liga/Pokemon3D/V6/P0004
            try:
                if unreal.EditorAssetLibrary.does_directory_exist(folder):
                    out[k] = v
            except Exception:
                pass
    return out


class ImportJob:
    """Imports the models one at a time, one per editor frame, driven by tick() (run_in_background, or liga_setup.py).

    Imported in one long Python call, as before, the models never let the editor finish a frame, so it could not free
    what each import leaves on the graphics card. Now the editor renders a few frames and collects garbage between two
    imports; the models are saved without thumbnails (save_model); virtual shadow maps are off while the job runs
    (restored when it ends); and when free RAM runs low the job stops and the next run carries on, instead of the
    graphics driver failing ("D3D device removed")."""

    PAUSE_FRAMES = 3    # engine frames between two imports: the editor renders them and frees what the last import left
    SCAN_SECONDS = 0.3  # per frame, for finding the models imported earlier
    MAX_PAUSE_TICKS = 600

    def __init__(self, ids, with_shiny=True, log=print, warn=print, title='3D-покемоны'):
        self.todo = [(sp, shiny) for sp in ids for shiny in ((False, True) if with_shiny and sp in SHINY_SPECIES else (False,))]
        self.total = len(self.todo)
        self.result = {}
        self.imported = 0
        self.pause = 0
        self.resume_at = None
        self.low_memory = ''  # why the job stopped early, if it did
        self.left = 0         # models not imported because of that
        self.stopped = False  # cancelled in the progress dialog
        self.vsm = 0
        self.started = False
        self.finished = False
        self.log, self.warn, self.title = log, warn, title

    def begin(self):
        self.started = True
        try:
            self.vsm = unreal.SystemLibrary.get_console_variable_int_value(VSM)
        except Exception:
            self.vsm = 0
        if self.vsm:
            unreal.SystemLibrary.execute_console_command(None, f'{VSM} 0')
        refresh_old_imports(self.log, self.warn, delete=False)  # the old models go once the new ones are all in
        note_previous_crash(self.warn)
        ensure_packages(self.log)
        if not quick_save():
            self.warn('3D-модели сохраняются с миниатюрами (C++ часть проекта старая) — может не хватить памяти. '
                      'Закройте Unreal, удалите папку Binaries, откройте Liga17.uproject и согласитесь пересобрать')

    def end(self):
        """Restores the shadows. Safe to call more than once."""
        if self.vsm:
            unreal.SystemLibrary.execute_console_command(None, f'{VSM} {self.vsm}')
            self.vsm = 0
        if not self.finished:
            self.finished = True
            if self.started and not self.todo and not self.low_memory and not self.stopped:
                refresh_old_imports(self.log, self.warn)  # every new model is in: the old folders can go
            self.log(f'3D-покемоны: моделей {len(self.result)}, импортировано сейчас {self.imported} (остальные покемоны — картинками)')

    def tick(self):
        """Does the next piece of work; True once every model is done or the import was cancelled."""
        if self.finished:
            return True
        if not self.started:
            self.begin()
            return False
        if self.pause > 0 or self.resume_at is not None:
            # The post-tick callback runs several times per engine frame, so real frames are counted (the callback count
            # is the fallback, with a cap in case the frame counter stands still).
            self.pause -= 1
            frame = frame_count()
            if frame is None or self.resume_at is None:
                if self.pause > 0:
                    return False
            elif frame < self.resume_at and self.pause > -self.MAX_PAUSE_TICKS:
                return False
            self.pause, self.resume_at = 0, None
        t0 = time.time()
        while self.todo:
            sp, shiny = self.todo[0]
            tag = f'{sp}{"s" if shiny else ""}'
            have = imported_model(sp, shiny)
            if have or is_skipped(tag):
                self.todo.pop(0)
                if have:
                    self.result[tag] = have
                if time.time() - t0 > self.SCAN_SECONDS:
                    return False
                continue
            low = low_memory()
            if low:
                self.low_memory, self.left = low, len(self.todo)
                self.todo = []
                self.warn(f'3D-покемоны: {low} — остальные {self.left} моделей поставятся при следующем запуске '
                          '(перезапустите Unreal и запустите настройку ещё раз), пока они картинками')
                break
            done = self.total - len(self.todo)
            with unreal.ScopedSlowTask(self.total, f'{self.title}: {done + 1} из {self.total} (№{sp}{" shiny" if shiny else ""})') as task:
                task.make_dialog(True)
                task.enter_progress_frame(done)
                task.enter_progress_frame(1)
                try:
                    got = import_one(sp, shiny, self.log, self.warn)
                except Exception as e:
                    self.warn(f'3D №{tag}: {e}')
                    got = None
                cancelled = task.should_cancel()
            self.todo.pop(0)
            self.imported += 1
            if got:
                self.result[tag] = got
            unreal.SystemLibrary.collect_garbage()  # runs at the start of the next frame
            frame = frame_count()
            self.resume_at = None if frame is None else frame + self.PAUSE_FRAMES
            self.pause = self.PAUSE_FRAMES
            if cancelled:
                self.todo = []
                self.stopped = True
                self.warn('импорт 3D-моделей остановлен — остальные покемоны пока картинками; запустите настройку ещё раз, чтобы продолжить')
                break
            return False
        self.end()
        return True


def run_in_background(job, then=None):
    """Drives job from the editor's frame ticks; then(models) runs when it is finished."""
    state = {'handle': None, 'busy': False}

    def on_tick(_dt):
        if state['busy']:  # the progress dialog of an import ticks the editor's UI again from inside tick()
            return
        state['busy'] = True
        try:
            try:
                done = job.tick()
            except Exception as e:
                job.warn(f'3D: {e}')
                job.end()
                done = True
            if done:
                unreal.unregister_slate_post_tick_callback(state['handle'])
                set_busy(False)
                if then:
                    then(job.result)
        finally:
            state['busy'] = False

    set_busy(True)
    state['handle'] = unreal.register_slate_post_tick_callback(on_tick)


def busy():
    """True while liga_setup.py or liga_pokemon3d_all.py is still working in the background."""
    return bool(getattr(sys, 'liga17_busy', False))


def set_busy(value):
    sys.liga17_busy = value


def merge_into_assets_json(models):
    path = os.path.join(PROJECT, 'Content', 'Liga', 'Data', 'assets.json')
    data = {}
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    data['pokemon3d'] = dict(current_entries(data.get('pokemon3d')), **models)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def import_all():
    """Every regular model in the repository (≈970). Takes long; already imported ones are skipped."""
    if busy():
        unreal.EditorDialog.show_message('Лига 17 — 3D-покемоны', 'Импорт уже идёт — дождитесь окна «Готово».', unreal.AppMsgType.OK)
        return
    job = ImportJob(list(range(1, 1026)), with_shiny=False, log=unreal.log, warn=unreal.log_warning, title='Все 3D-покемоны')

    def done(models):
        merge_into_assets_json(models)
        more = (f'\n\nНе хватило памяти ({job.low_memory}): перезапустите Unreal и запустите liga_pokemon3d_all.py ещё раз, '
                f'осталось моделей: {job.left}.') if job.low_memory else ''
        unreal.EditorDialog.show_message('Лига 17 — 3D-покемоны', f'Готово: моделей {len(models)}.' + more, unreal.AppMsgType.OK)

    run_in_background(job, done)
