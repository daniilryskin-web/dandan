"""Лига 17 — 3D Pokémon models for battles.

Models come from the public repository https://github.com/Pokemon-3D-api/assets (pinned commit below).
As that repository states, the models are the property of Nintendo / Creatures Inc. / GAME FREAK inc. —
they are downloaded on your own computer for a personal fan game, like the HOME pictures, and are not part of
this project's repository. Do not publish or sell a game that contains them.

The files use Draco mesh compression and WebP textures. Each one is converted to a plain .glb (DracoPy, Pillow):
the helper sphere every file carries is dropped, the parts are joined into one mesh, broken bones and animation
keys are repaired, and the result is imported with Unreal's glTF importer into /Game/Liga/Pokemon/P<id>.
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
import urllib.request

import unreal

COMMIT = '429de1288cea0d43f5b4f56305d2276e94239d65'
BASE = f'https://raw.githubusercontent.com/Pokemon-3D-api/assets/{COMMIT}/models/opt'

# Pokémon the game can show: starters, every wild Pokémon of Route 1, the forest edge and the shore, and what they
# evolve into early on.
GAME_SPECIES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
                28, 29, 30, 32, 33, 39, 43, 44, 46, 47, 48, 49, 52, 53, 54, 55, 56, 57, 60, 61, 69, 70, 72, 73, 79,
                80, 86, 87, 90, 98, 99, 116, 117, 118, 119, 120, 131, 133, 134, 135, 136]

PROJECT = os.path.abspath(unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir()))
CACHE = os.path.join(PROJECT, 'Saved', 'Liga', 'Pokemon3D')
SITE = os.path.join(PROJECT, 'Content', 'Python', 'Lib', 'site-packages')

# Bump when convert() changes: models are imported again into a new folder, and the old folders are deleted.
CONVERTER_VERSION = 6
DEST_ROOT = '/Game/Liga/Pokemon3D'
DEST = f'{DEST_ROOT}/V{CONVERTER_VERSION}'
OLD_DESTS = ['/Game/Liga/Pokemon']  # converter versions 1–3
VERSION_FILE = os.path.join(CACHE, 'converter_version.txt')
GUARD = os.path.join(CACHE, 'importing.json')   # the model being imported right now
SKIP = os.path.join(CACHE, 'skip.json')         # models that crashed the editor once: they keep their picture

IDLE = re.compile(r'idle|wait|stand|loop|armatureaction|take ?0*1', re.I)
ATTACK = re.compile(r'attack|fight|atk|impact|thunder|trueno|bolt|punch|bite|tackle|scratch', re.I)
FAINT = re.compile(r'\bko\b|faint|down|dead|_ko|\|ko|ko$', re.I)
WALK = re.compile(r'walk|(?<![a-z])run', re.I)


def clip_role(name):
    """'idle' / 'walk' / 'attack' / 'faint' / None for an animation name (the same rules for files and for assets)."""
    if WALK.search(name):
        return 'walk'
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
# straight out). The bones follow one naming scheme (Hips, Spine1, Head, LArm, RThigh, Tail1…), so simple clips can be
# made for any of them: idle (breathing, arms lowered, tail and head moving), walk, attack (wind-up and lunge), faint.
# Clips the file already has are kept; only missing roles are added, named liga_<role>.

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
                        ('thigh', ('thigh',)), ('shin', ('leg',)), ('foot', ('foot',)), ('toe', ('toe',)), ('finger', ('finger',)),
                        ('tail', ('tail',)), ('neck', ('neck',)), ('head', ('head',)), ('jaw', ('jaw', 'beak')), ('ear', ('ear',)),
                        ('wing', ('wing', 'wind')), ('spine', ('spine', 'chest')), ('pelvis', ('hips', 'waist', 'pelvis')),
                        ('feeler', ('feeler', 'hair'))):
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


def _procedural_clips(gltf, views, add_view):
    import numpy as np
    nodes = gltf.get('nodes', [])
    skins = gltf.get('skins', [])
    holders = [i for i, n in enumerate(nodes) if 'mesh' in n and 'skin' in n]
    if len(skins) != 1 or len(holders) != 1:
        return
    anims = gltf.get('animations', [])
    have = {clip_role(a.get('name', '')) for a in anims}
    missing = [r for r in ('idle', 'walk', 'attack', 'faint') if r not in have]
    if not missing:
        return
    joints = list(skins[0]['joints'])
    jset = set(joints)
    parent = {c: i for i, n in enumerate(nodes) for c in n.get('children', [])}
    root = skins[0].get('skeleton', joints[0])
    if parent.get(root) is not None:
        return  # not canonical (see _canonicalize): leave it

    # Base pose: the rest pose, or the first frame of the file's own idle (or first) clip — some rest poses are odd.
    base = {j: {p: np.array(nodes[j].get(p, _REST[p]), dtype=np.float64) for p in _REST} for j in joints}
    if anims:
        src = next((a for a in anims if clip_role(a.get('name', '')) == 'idle'), anims[0])
        t0 = min(float(_float_keys(gltf, views, s['input']).min()) for s in src['samplers'])
        for (j, p), v in _sample_anim(gltf, views, src, t0).items():
            if j in base:
                base[j][p] = v
    local = {j: _local_matrix({'translation': list(base[j]['translation']), 'rotation': list(base[j]['rotation']),
                               'scale': list(base[j]['scale'])}) for j in joints}
    world = {}

    def w(j):
        if j not in world:
            world[j] = (w(parent[j]) @ local[j]) if parent.get(j) in jset else local[j]
        return world[j]

    for j in joints:
        w(j)
    pos = {j: world[j][:3, 3] for j in joints}
    qworld = {}
    for j in joints:
        r = world[j][:3, :3]
        sc = np.linalg.norm(r, axis=0)
        qworld[j] = _quat_from_matrix(r / np.where(sc > 1e-12, sc, 1.0)) if (sc > 1e-12).all() else np.array([0, 0, 0, 1.0])
    children = {j: [c for c in nodes[j].get('children', []) if c in jset] for j in joints}
    info = {j: _bone_kind(nodes[j].get('name', '')) for j in joints}

    # body size from the mesh (bind pose = rest pose after _canonicalize)
    mesh = gltf['meshes'][nodes[holders[0]]['mesh']]
    pts = np.concatenate([_accessor(gltf, views, p['attributes']['POSITION']) for p in mesh['primitives']]).astype(np.float64)
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    height = max(hi[1] - lo[1], 1e-6)
    ground = lo[1]

    def deepest(j):
        best, stack = j, [j]
        while stack:
            k = stack.pop()
            if pos[k][1] < pos[best][1]:
                best = k
            stack.extend(children.get(k, []))
        return best

    def kind(j):
        return info[j][1]

    # upper arms: 'LArm' but not the 'LArm2' below it
    arms = [j for j in joints if kind(j) == 'arm' and info[j][0] != 0 and not (parent.get(j) in jset and kind(parent[j]) == 'arm')]
    thighs = [j for j in joints if kind(j) == 'thigh' and info[j][0] != 0]
    front_legs = [j for j in arms if pos[deepest(j)][1] < ground + 0.18 * height]  # quadrupeds walk on their arms
    hands_up = [j for j in arms if j not in front_legs]

    def lower_rotation(j):
        """World rotation (axis, degrees) that brings a raised arm (T-pose) down to 45° from vertical."""
        kids = children.get(j, [])
        if not kids:
            return None
        d = pos[kids[0]] - pos[j]
        if np.linalg.norm(d) < 1e-9:
            return None
        d = d / np.linalg.norm(d)
        down = np.array([0.0, -1.0, 0.0])
        ang = np.degrees(np.arccos(np.clip(d @ down, -1, 1)))
        if ang < 60:
            return None
        axis = np.cross(d, down)
        if np.linalg.norm(axis) < 1e-6:
            return None
        return axis / np.linalg.norm(axis), min(ang - 45.0, 70.0)

    lowering = {j: lower_rotation(j) for j in hands_up}
    tails = sorted([j for j in joints if kind(j) == 'tail' and info[j][0] == 0], key=lambda j: info[j][2])
    spines = sorted([j for j in joints if kind(j) == 'spine'], key=lambda j: info[j][2])
    necks = [j for j in joints if kind(j) == 'neck']
    heads = [j for j in joints if kind(j) == 'head']
    jaws = [j for j in joints if kind(j) == 'jaw' and info[j][0] == 0]
    ears = [j for j in joints if kind(j) == 'ear' and children.get(j)]
    shins = {info[j][0]: j for j in joints if kind(j) == 'shin' and info[j][0] != 0}
    legless = not thighs and not front_legs
    X, Y, Z = np.array([1.0, 0, 0]), np.array([0, 1.0, 0]), np.array([0, 0, 1.0])

    def smooth(a, b, t):
        x = np.clip((t - a) / (b - a), 0.0, 1.0)
        return x * x * (3 - 2 * x)

    wings = [j for j in joints if kind(j) == 'wing' and info[j][0] != 0 and not (parent.get(j) in jset and kind(parent[j]) == 'wing')]
    feet = {info[j][0]: j for j in joints if kind(j) == 'foot' and info[j][0] != 0}

    def pose_at(role, t, T):
        """{joint: [(axis, degrees), ...]} world rotations and a root offset for one moment of a clip.
        Every motion uses whole multiples of the clip's own frequency, so the loops are seamless; several frequencies
        on top of each other keep the idle from looking mechanical."""
        rot, off = {}, np.zeros(3)
        wv = 2 * np.pi * t / T

        def add(j, axis, deg):
            if abs(deg) > 1e-6:
                rot.setdefault(j, []).append((axis, deg))

        for j, low in lowering.items():
            if low is not None:
                add(j, low[0], low[1])
        if role == 'idle':
            breath = np.sin(2 * wv)                      # two breaths per loop
            for k, j in enumerate(spines):
                add(j, X, 3.0 * np.sin(2 * wv - 0.4 * k))
                add(j, Y, 2.0 * np.sin(wv + 0.3 * k))
            for j in necks:
                add(j, X, 2.5 * np.sin(2 * wv - 0.8))
                add(j, Y, 5.0 * np.sin(wv))
            for j in heads:                               # looks around now and then
                add(j, Y, 12.0 * np.sin(wv) + 4.0 * np.sin(3 * wv + 0.6))
                add(j, X, 4.0 * np.sin(2 * wv - 1.0) - 3.0 * max(0.0, np.sin(wv + 2.0)) ** 3)
                add(j, Z, 5.0 * np.sin(wv + 1.0))
            for j in jaws:
                add(j, X, 8.0 * max(0.0, np.sin(wv - 1.2)) ** 4)
            for j in hands_up:
                add(j, X, 6.0 * np.sin(2 * wv + info[j][0]))
                add(j, Z, 4.0 * info[j][0] * np.sin(2 * wv))
            for j in wings:
                add(j, Z, info[j][0] * (5.0 * np.sin(2 * wv) + 14.0 * max(0.0, np.sin(4 * wv)) ** 6))
            for k, j in enumerate(tails):
                add(j, Y, 14.0 * np.sin(2 * wv + 0.7 * k))
                add(j, X, 4.0 * np.sin(2 * wv + 0.5 * k + 1.0))
            for j in ears:                                # slow sway with quick twitches
                add(j, Z, info[j][0] * (4.0 * np.sin(2 * wv) + 10.0 * max(0.0, np.sin(6 * wv + info[j][0])) ** 8))
            add(root, Z, 1.8 * np.sin(wv))                # weight shifting from foot to foot
            off = off + Y * (0.012 * height * 0.5 * (1 + breath)) + X * (0.012 * height * np.sin(wv))
            if legless:                                   # blobs and floaters bob up and down
                off = off + Y * (0.04 * height * 0.5 * (1 + np.sin(2 * wv)))
        elif role == 'walk':
            for j in thighs:
                ph = 0.0 if info[j][0] > 0 else np.pi
                add(j, X, 32.0 * np.sin(wv + ph))
                shin = shins.get(info[j][0])
                if shin is not None:                      # knee bends while the leg swings forward
                    add(shin, X, -34.0 * max(0.0, np.sin(wv + ph + np.pi / 2)))
                foot = feet.get(info[j][0])
                if foot is not None:
                    add(foot, X, 14.0 * np.sin(wv + ph - 0.6))
            for j in front_legs:                          # diagonal pairs, like a trot
                ph = 0.0 if info[j][0] < 0 else np.pi
                add(j, X, 28.0 * np.sin(wv + ph))
            for j in hands_up:                            # arms swing against the legs
                ph = np.pi if info[j][0] > 0 else 0.0
                add(j, X, 22.0 * np.sin(wv + ph))
            for j in wings:
                add(j, Z, info[j][0] * 10.0 * np.sin(2 * wv))
            for k, j in enumerate(spines):
                if legless:
                    add(j, Y, 10.0 * np.sin(wv + 0.9 * k))   # slither
                else:
                    add(j, Y, 4.0 * np.sin(wv))
                    add(j, X, 2.5 * np.sin(2 * wv))
            for j in heads + necks:                       # keeps the head steady against the body's bob
                add(j, X, -3.0 * np.sin(2 * wv))
                add(j, Y, -3.0 * np.sin(wv))
            for k, j in enumerate(tails):
                add(j, Y, (12.0 if legless else 14.0) * np.sin(wv + 0.7 * k + (0.9 * len(spines) if legless else 0)))
                add(j, X, 4.0 * np.sin(2 * wv + 0.5 * k))
            for j in ears:
                add(j, X, 6.0 * np.sin(2 * wv + 0.5))
            if legless and not spines and not tails:      # no legs and no body to wiggle: little hops
                off = off + Y * (0.14 * height * abs(np.sin(wv)))
                add(root, X, 6.0 * np.sin(2 * wv))
            else:
                add(root, Z, 3.5 * np.sin(wv))            # side to side with every step
                off = off + Y * (0.045 * height * 0.5 * (1 - np.cos(2 * wv)))
        elif role == 'attack':
            a = smooth(0.0, 0.35, t) - smooth(0.35, 0.5, t)    # wind-up
            s = smooth(0.35, 0.5, t) - smooth(0.6, 1.0, t)     # strike
            for j in spines:
                add(j, X, -12.0 * a + 20.0 * s)
            for j in necks + heads:
                add(j, X, -8.0 * a + 14.0 * s)
            for j in jaws:
                add(j, X, 25.0 * s)
            for j in hands_up:
                add(j, X, 30.0 * a - 60.0 * s)
            for j in front_legs:
                add(j, X, -25.0 * s)
            for j in wings:
                add(j, Z, info[j][0] * (25.0 * a - 30.0 * s))
            for j in thighs:
                add(j, X, -10.0 * a + 12.0 * s)
            for k, j in enumerate(tails):
                add(j, Y, 16.0 * (a + s) * np.sin(np.pi * t / T * 3 + 0.6 * k))
            off = off + Z * (0.2 * height * s) + Y * (0.06 * height * a + 0.04 * height * s)
        elif role == 'faint':
            f = smooth(0.0, 0.6, t)
            add(root, Z, 80.0 * f)
            for j in necks + heads:
                add(j, X, 25.0 * f)
            for k, j in enumerate(tails):
                add(j, X, 15.0 * f)
            off = off - Y * (0.15 * height * f)
        return rot, off

    specs = {'idle': (4.0, 64, True), 'walk': (0.8, 24, True), 'attack': (1.0, 30, False), 'faint': (0.7, 16, False)}
    for role in missing:
        T, n, loop = specs[role]
        times = np.linspace(0.0, T, n + 1)
        rot_keys, root_keys = {}, []
        for t in times:
            rot, off = pose_at(role, t, T)
            for j in joints:
                q = base[j]['rotation']
                if j in rot:
                    qd = np.array([0, 0, 0, 1.0])
                    for axis, deg in rot[j]:
                        qd = _quat_mul(_axis_quat(axis, deg), qd)
                    # a world-axis turn about the bone's own pivot, written in the bone's local frame
                    q = _quat_mul(q, _quat_mul(_quat_conj(qworld[j]), _quat_mul(qd, qworld[j])))
                rot_keys.setdefault(j, []).append(q / np.linalg.norm(q))
            root_keys.append(base[root]['translation'] + off)
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
                if not np.allclose(base[j][p], nodes[j].get(p, _REST[p]), atol=1e-7):
                    channel(j, p, np.tile(base[j][p], (len(times), 1)))
        channel(root, 'translation', np.array(root_keys))
        gltf.setdefault('animations', []).append(anim)


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


def convert(data):
    """Draco + WebP .glb -> plain .glb with PNG textures, without the helper sphere."""
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

    _sanitize_transforms(gltf, views, add_view)
    _merge_meshes(gltf, views, add_view)
    used = sorted({n['mesh'] for n in gltf.get('nodes', []) if 'mesh' in n})  # unused meshes would become extra assets
    remap = {old: new for new, old in enumerate(used)}
    gltf['meshes'] = [gltf['meshes'][i] for i in used]
    for node in gltf.get('nodes', []):
        if 'mesh' in node:
            node['mesh'] = remap[node['mesh']]
    _canonicalize(gltf, views, add_view)
    _ensure_normals(gltf, views, add_view)
    _procedural_clips(gltf, views, add_view)
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


def note_previous_crash(warn=print):
    """If the editor died while importing a model last time, that model is skipped from now on."""
    tag = _load_json(GUARD, None)
    if tag:
        skip = _load_json(SKIP, [])
        if tag not in skip:
            skip.append(tag)
            _save_json(SKIP, skip)
        warn(f'3D-модель {tag} в прошлый раз уронила редактор при импорте — она пропущена, покемон останется картинкой')
        try:
            os.remove(GUARD)
        except OSError:
            pass


def import_one(species, shiny=False, log=print, warn=print):
    tag = f'{species}{"s" if shiny else ""}'
    folder = f'{DEST}/P{species:04d}{"S" if shiny else ""}'
    have = describe(folder) if unreal.EditorAssetLibrary.does_directory_exist(folder) else None
    if have:
        return have
    if tag in _load_json(SKIP, []):
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
        f.write(convert(raw))
    t = unreal.AssetImportTask()
    t.filename = path
    t.destination_path = folder
    t.automated = True
    t.replace_existing = True
    t.save = True
    _save_json(GUARD, tag)  # if the import or the save (it draws thumbnails on the GPU) kills the editor, the next run skips this model
    try:
        unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([t])
        unreal.EditorAssetLibrary.save_directory(folder, only_if_is_dirty=True, recursive=True)
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


def refresh_old_imports(log=print, warn=print):
    """A new converter imports into its own folder (DEST), so old models never stand in the way. The old folders are
    deleted when Unreal allows it (it refuses while their assets are loaded; then the next run tries again)."""
    try:
        with open(VERSION_FILE, encoding='utf-8') as f:
            version = int(f.read().strip() or 0)
    except Exception:
        version = 0
    if version != CONVERTER_VERSION:
        # The models that crashed the editor stay skipped (SKIP): trying them again would only crash it once more.
        os.makedirs(CACHE, exist_ok=True)
        with open(VERSION_FILE, 'w', encoding='utf-8') as f:
            f.write(str(CONVERTER_VERSION))
    for folder in old_folders():
        try:
            ok = unreal.EditorAssetLibrary.delete_directory(folder)
        except Exception:
            ok = False
        log(f'старые 3D-модели {folder}: ' + ('удалены' if ok else 'пока не удалось удалить (попробую в следующий раз)'))


def current_entries(entries):
    """assets.json entries that point into this converter's folder (older ones may be broken)."""
    return {k: v for k, v in (entries or {}).items() if isinstance(v, dict) and str(v.get('mesh', '')).startswith(DEST + '/')}


def import_species(ids, with_shiny=True, log=print, warn=print, task=None):
    refresh_old_imports(log, warn)  # a new converter gets a clean slate, including models that crashed before
    note_previous_crash(warn)
    ensure_packages(log)
    result = {}
    for sp in ids:
        if task is not None:
            task.enter_progress_frame(1, f'3D-модель #{sp}')
        for shiny in ((False, True) if with_shiny else (False,)):
            try:
                got = import_one(sp, shiny, log, warn)
            except Exception as e:
                warn(f'3D #{sp}{" shiny" if shiny else ""}: {e}')
                got = None
            if got:
                result[f'{sp}{"s" if shiny else ""}'] = got
    return result


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
    ids = list(range(1, 1026))
    with unreal.ScopedSlowTask(len(ids), 'Лига 17: все 3D-покемоны') as task:
        task.make_dialog(True)
        models = import_species(ids, with_shiny=False, log=unreal.log, warn=unreal.log_warning, task=task)
    merge_into_assets_json(models)
    unreal.EditorDialog.show_message('Лига 17 — 3D-покемоны', f'Готово: моделей {len(models)}.', unreal.AppMsgType.OK)

