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
DEST = '/Game/Liga/Pokemon'

# Starters with evolutions, Route 1, and Pikachu/Eevee lines.
GAME_SPECIES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 25, 26, 133, 134, 135, 136]

PROJECT = os.path.abspath(unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir()))
CACHE = os.path.join(PROJECT, 'Saved', 'Liga', 'Pokemon3D')
SITE = os.path.join(PROJECT, 'Content', 'Python', 'Lib', 'site-packages')

# Bump when convert() changes: models imported by an older converter are deleted and imported again.
CONVERTER_VERSION = 3
VERSION_FILE = os.path.join(CACHE, 'converter_version.txt')
GUARD = os.path.join(CACHE, 'importing.json')   # the model being imported right now
SKIP = os.path.join(CACHE, 'skip.json')         # models that crashed the editor once: they keep their picture

IDLE = re.compile(r'idle|wait|stand|loop|armatureaction|take ?0*1', re.I)
ATTACK = re.compile(r'attack|fight|atk', re.I)
FAINT = re.compile(r'\bko\b|faint|down|dead|_ko|\|ko|ko$', re.I)


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


def _merge_meshes(gltf, views, add_view):
    """Unreal makes a separate asset of every mesh in a glTF, and the battle shows one of them. Pokémon made of several
    meshes (eyes, wings, flames — Pikachu, Charizard, Eevee…) would lose all parts but one, so they become one mesh.
    Skinned parts are placed by their joints (the node transform does not count), static parts get it baked in."""
    import numpy as np
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
            if m is not None and not np.allclose(m, np.eye(4)):
                for name in ('POSITION', 'NORMAL'):
                    if name in prim['attributes']:
                        v = _accessor(gltf, views, prim['attributes'][name]).astype(np.float64)
                        if name == 'POSITION':
                            v = v @ m[:3, :3].T + m[:3, 3]
                        else:
                            v = v @ np.linalg.inv(m[:3, :3])
                            v /= np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-12)
                        v = np.ascontiguousarray(v, dtype=np.float32)
                        acc = {'bufferView': add_view(v.tobytes(), 34962), 'byteOffset': 0, 'componentType': 5126, 'count': int(len(v)), 'type': 'VEC3'}
                        if name == 'POSITION':
                            acc['min'], acc['max'] = [float(x) for x in v.min(axis=0)], [float(x) for x in v.max(axis=0)]
                        gltf['accessors'].append(acc)
                        prim['attributes'][name] = len(gltf['accessors']) - 1
                prim['attributes'].pop('TANGENT', None)
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
    _ensure_normals(gltf, views, add_view)
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
    """{'mesh': skeletal or static mesh, 'idle'/'attack'/'faint': animation sequences} found in an imported folder."""
    found = _assets(folder)
    skel = [p for c, n, p in found if c == 'SkeletalMesh']
    static = [p for c, n, p in found if c == 'StaticMesh' and 'icosphere' not in n.lower()]
    anims = [(n, p) for c, n, p in found if c == 'AnimSequence']
    if not skel and not static:
        return None
    out = {'mesh': skel[0] if skel else static[0]}
    for key, rx in (('idle', IDLE), ('attack', ATTACK), ('faint', FAINT)):
        hit = next((p for n, p in anims if rx.search(n)), None)
        if hit:
            out[key] = hit
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


def refresh_old_imports(log=print, warn=print):
    try:
        with open(VERSION_FILE, encoding='utf-8') as f:
            version = int(f.read().strip() or 0)
    except Exception:
        version = 0
    if version == CONVERTER_VERSION:
        return
    eal = unreal.EditorAssetLibrary
    if eal.does_directory_exist(DEST):
        log('удаляю 3D-модели, импортированные старой версией конвертера…')
        if not eal.delete_directory(DEST):
            warn(f'не удалось удалить {DEST}: перезапустите редактор и запустите настройку ещё раз')
            return
    for path in (GUARD, SKIP):
        if os.path.exists(path):
            os.remove(path)
    os.makedirs(CACHE, exist_ok=True)
    with open(VERSION_FILE, 'w', encoding='utf-8') as f:
        f.write(str(CONVERTER_VERSION))


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
    data.setdefault('pokemon3d', {}).update(models)
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

