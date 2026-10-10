"""Лига 17 — one-time project setup, run inside the Unreal Editor:
    Tools → Execute Python Script… → Content/Python/liga_setup.py
(or in the Output Log's "Python" console:  exec(open(r'<project>/Content/Python/liga_setup.py', encoding='utf-8').read()) )

What it does:
  1. imports the generated textures and the Pallet Town art kit (ArtSource/Exports/Kit/*.glb);
  2. builds materials: wind-animated foliage, vertex-colour terrain blend, sea, Pokémon billboard;
  3. finds the Third Person mannequin; downloads the anime (VRoid, CC0) cast listed in ArtSource/Characters/cast.json
     and imports it with the VRM4U plugin (your own <Role>.vrm in that folder replaces a model);
  4. creates /Game/Liga/Maps/PalletTown, imports the town scene into it, adds sky, sun, clouds, fog;
  5. downloads 3D models of the Pokémon the game can show (liga_pokemon3d.py) — on this computer only, one per frame;
  6. writes Content/Liga/Data/assets.json for the game code and saves everything.
Safe to run again: it rebuilds the level and replaces imported assets.
"""
import hashlib
import json
import math
import os
import shutil
import struct
import sys
import urllib.request

import unreal

PROJECT = os.path.abspath(unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir()))
ART = os.path.join(PROJECT, 'ArtSource')
EXPORTS = os.path.join(ART, 'Exports')
TEXTURES = os.path.join(ART, 'Textures')
DATA = os.path.join(PROJECT, 'Content', 'Liga', 'Data')
CHARACTERS = os.path.join(ART, 'Characters')
CHAR_STATE = os.path.join(PROJECT, 'Saved', 'Liga', 'characters.json')
CHAR_GUARD = os.path.join(PROJECT, 'Saved', 'Liga', 'character_importing.json')
VRM4U_CONVERT = os.path.join(PROJECT, 'Plugins', 'VRM4U', 'Source', 'VRM4ULoader', 'Private', 'VrmConvert.cpp')
VRM4U_URL = 'https://github.com/ruyo/VRM4U/archive/refs/heads/master.zip'

ROOT = '/Game/Liga'
TEX_PATH = ROOT + '/Textures'
KIT_PATH = ROOT + '/Kit'
MAT_PATH = ROOT + '/Materials'
TOWN_PATH = ROOT + '/Town'
MAP_PATH = ROOT + '/Maps/PalletTown'
VRM_ROOT = '/Game/Characters/VRoid'   # imported with animation retargeters (ULigaEditorTools)
VRM_ROOT_PLAIN = '/Game/Characters/VRM'  # earlier imports without retargeters; also used when the C++ helper is missing

asset_tools = unreal.AssetToolsHelpers.get_asset_tools()
eal = unreal.EditorAssetLibrary
mel = unreal.MaterialEditingLibrary
actors_sub = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
level_sub = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)

REPORT = []


def log(msg):
    unreal.log('[Liga] ' + msg)
    REPORT.append(msg)


def warn(msg):
    unreal.log_warning('[Liga] ' + msg)
    REPORT.append('ВНИМАНИЕ: ' + msg)


def step(name):
    def wrap(fn):
        def run(*a, **k):
            try:
                return fn(*a, **k)
            except Exception as e:  # keep going: later steps are still useful
                warn(f'{name}: {e}')
                return None
        return run
    return wrap


# ——— importing ———

def import_files(files, dest):
    tasks = []
    for f in files:
        t = unreal.AssetImportTask()
        t.filename = f
        t.destination_path = dest
        t.automated = True
        t.replace_existing = True
        t.save = True
        tasks.append(t)
    asset_tools.import_asset_tasks(tasks)
    paths = []
    for t in tasks:
        paths += [str(p) for p in t.imported_object_paths]
    return paths


def assets_in(path, cls=None):
    out = []
    if not eal.does_directory_exist(path):
        return out
    for p in eal.list_assets(path, recursive=True, include_folder=False):
        a = eal.load_asset(p)
        if a is not None and (cls is None or isinstance(a, cls)):
            out.append(a)
    return out


def short(name):
    n = str(name)
    for prefix in ('SM_', 'T_', 'MI_', 'M_'):
        if n.startswith(prefix):
            n = n[len(prefix):]
    return n.lower()


@step('импорт текстур')
def import_textures():
    files = [os.path.join(TEXTURES, f) for f in sorted(os.listdir(TEXTURES)) if f.endswith('.png')]
    import_files(files, TEX_PATH)
    textures = {}
    for t in assets_in(TEX_PATH, unreal.Texture2D):
        name = short(t.get_name())
        if name.endswith('_normal'):
            t.set_editor_property('compression_settings', unreal.TextureCompressionSettings.TC_NORMALMAP)
            t.set_editor_property('srgb', False)
            t.set_editor_property('flip_green_channel', True)  # Blender/glTF normals are OpenGL-style
        elif name.endswith('_rough'):
            t.set_editor_property('compression_settings', unreal.TextureCompressionSettings.TC_GRAYSCALE)
            t.set_editor_property('srgb', False)
        eal.save_loaded_asset(t)
        textures[name] = t
    log(f'текстуры: {len(textures)}')
    return textures


@step('импорт набора моделей')
def import_kit():
    kit_dir = os.path.join(EXPORTS, 'Kit')
    files = [os.path.join(kit_dir, f) for f in sorted(os.listdir(kit_dir)) if f.endswith('.glb')]
    import_files(files, KIT_PATH)
    wanted = {os.path.splitext(f)[0].lower() for f in os.listdir(kit_dir) if f.endswith('.glb')}
    meshes = {}
    for sm in assets_in(KIT_PATH, unreal.StaticMesh):
        key = short(sm.get_name())
        if key in wanted:
            meshes[key] = sm
    log(f'модели набора: {len(meshes)} из {len(wanted)}')
    return meshes


def set_collision(sm, complex_as_simple=True):
    body = sm.get_editor_property('body_setup')
    if body is not None:
        flag = unreal.CollisionTraceFlag.CTF_USE_COMPLEX_AS_SIMPLE if complex_as_simple else unreal.CollisionTraceFlag.CTF_USE_DEFAULT
        body.set_editor_property('collision_trace_flag', flag)


# ——— materials ———

def new_material(name):
    path = f'{MAT_PATH}/{name}'
    if eal.does_asset_exist(path):
        m = eal.load_asset(path)
        mel.delete_all_material_expressions(m)
        return m
    return asset_tools.create_asset(name, MAT_PATH, unreal.Material, unreal.MaterialFactoryNew())


def expr(m, cls, x, y, **props):
    e = mel.create_material_expression(m, cls, x, y)
    for k, v in props.items():
        e.set_editor_property(k, v)
    return e


def link(a, a_out, b, b_in):
    """Connects two nodes. An empty input name means the node's only input; its real name differs between nodes
    (Normalize calls it VectorInput), so the usual names are tried. A link that fails is reported: the material would
    not compile and Unreal would draw it grey."""
    for name in ([b_in] if b_in else ['', 'Input', 'VectorInput', 'A']):
        if mel.connect_material_expressions(a, a_out, b, name):
            return True
    warn(f'материал {b.get_outer().get_name()}: не удалось соединить {a.get_class().get_name()} → {b.get_class().get_name()} {b_in}')
    return False


def instanced_usage(m):
    """Trees, bushes, rocks, flowers and grass are drawn as instances (HISM), and meshes imported by UE 5.8 are Nanite.
    A material without these usage flags is drawn with the default grey material ("missing usage flag
    InstancedStaticMeshes / Nanite! Default Material will be used" in the log), and the editor cannot fix that during play."""
    set_props(m, m.get_name(), ((('used_with_instanced_static_meshes', 'b_used_with_instanced_static_meshes'), True),
                                (('used_with_nanite', 'b_used_with_nanite'), True)))


def const(m, v, x, y):
    return expr(m, unreal.MaterialExpressionConstant, x, y, r=v)


def scalar(m, name, v, x, y):
    return expr(m, unreal.MaterialExpressionScalarParameter, x, y, parameter_name=name, default_value=v)


def wind_offset(m, x0, y0):
    """WPO = sway(time, per-instance phase) * Amp * saturate(height above the mesh pivot / HeightRef)^2.
    Uses local position and PerInstanceRandom only: world-position math is double precision (LWC) in UE5
    and breaks some nodes, which made the whole foliage material fall back to the default grey."""
    lp = expr(m, unreal.MaterialExpressionLocalPosition, x0, y0)
    hz = expr(m, unreal.MaterialExpressionComponentMask, x0 + 200, y0 + 60, r=False, g=False, b=True, a=False)
    link(lp, '', hz, '')
    href = scalar(m, 'HeightRef', 100.0, x0 + 200, y0 + 160)
    div = expr(m, unreal.MaterialExpressionDivide, x0 + 360, y0 + 60)
    link(hz, '', div, 'A')
    link(href, '', div, 'B')
    sat = expr(m, unreal.MaterialExpressionSaturate, x0 + 500, y0 + 60)
    link(div, '', sat, '')
    sq = expr(m, unreal.MaterialExpressionMultiply, x0 + 640, y0 + 60)
    link(sat, '', sq, 'A')
    link(sat, '', sq, 'B')
    # phase = time * speed + random per instance + a little along the mesh so blades do not move in lockstep
    time = expr(m, unreal.MaterialExpressionTime, x0, y0 - 260)
    speed = scalar(m, 'WindSpeed', 1.6, x0, y0 - 340)
    tmul = expr(m, unreal.MaterialExpressionMultiply, x0 + 200, y0 - 280)
    link(time, '', tmul, 'A')
    link(speed, '', tmul, 'B')
    rnd = expr(m, unreal.MaterialExpressionPerInstanceRandom, x0, y0 - 160)
    rmul = expr(m, unreal.MaterialExpressionMultiply, x0 + 200, y0 - 160)
    link(rnd, '', rmul, 'A')
    link(const(m, 6.283, x0, y0 - 100), '', rmul, 'B')
    lx = expr(m, unreal.MaterialExpressionComponentMask, x0 + 200, y0 - 60, r=True, g=False, b=False, a=False)
    link(lp, '', lx, '')
    lxm = expr(m, unreal.MaterialExpressionMultiply, x0 + 340, y0 - 60)
    link(lx, '', lxm, 'A')
    link(const(m, 0.02, x0 + 200, y0), '', lxm, 'B')
    p1 = expr(m, unreal.MaterialExpressionAdd, x0 + 360, y0 - 240)
    link(tmul, '', p1, 'A')
    link(rmul, '', p1, 'B')
    phase = expr(m, unreal.MaterialExpressionAdd, x0 + 500, y0 - 200)
    link(p1, '', phase, 'A')
    link(lxm, '', phase, 'B')
    s = expr(m, unreal.MaterialExpressionSine, x0 + 640, y0 - 240)
    link(phase, '', s, '')
    c = expr(m, unreal.MaterialExpressionCosine, x0 + 640, y0 - 150)
    link(phase, '', c, '')
    app = expr(m, unreal.MaterialExpressionAppendVector, x0 + 780, y0 - 200)
    link(s, '', app, 'A')
    link(c, '', app, 'B')
    app3 = expr(m, unreal.MaterialExpressionAppendVector, x0 + 920, y0 - 160)
    link(app, '', app3, 'A')
    link(const(m, 0.0, x0 + 780, y0 - 100), '', app3, 'B')
    amp = scalar(m, 'Amp', 8.0, x0 + 920, y0 - 40)
    m1 = expr(m, unreal.MaterialExpressionMultiply, x0 + 1080, y0 - 100)
    link(app3, '', m1, 'A')
    link(amp, '', m1, 'B')
    m2 = expr(m, unreal.MaterialExpressionMultiply, x0 + 1220, y0)
    link(m1, '', m2, 'A')
    link(sq, '', m2, 'B')
    return m2


def check_compiled(m, what):
    """Warns when a material failed to compile (Unreal then silently renders the default grey material)."""
    try:
        st = mel.get_statistics(m)
        if st.get_editor_property('num_pixel_shader_instructions') <= 0:
            warn(f'{what}: материал не скомпилировался — откройте {m.get_path_name()} и пришлите скриншот ошибки')
    except Exception:
        pass


@step('материал листвы')
def make_foliage_material(textures):
    m = new_material('M_LigaFoliage')
    m.set_editor_property('two_sided', True)
    m.set_editor_property('shading_model', unreal.MaterialShadingModel.MSM_TWO_SIDED_FOLIAGE)
    instanced_usage(m)
    tex = expr(m, unreal.MaterialExpressionTextureSampleParameter2D, -700, -100, parameter_name='BaseColor')
    if 'leaves_albedo' in textures:
        tex.set_editor_property('texture', textures['leaves_albedo'])
    tint = expr(m, unreal.MaterialExpressionVectorParameter, -900, 140, parameter_name='Tint', default_value=unreal.LinearColor(1, 1, 1, 1))
    tint3 = expr(m, unreal.MaterialExpressionComponentMask, -700, 140, r=True, g=True, b=True, a=False)
    link(tint, '', tint3, '')
    mul = expr(m, unreal.MaterialExpressionMultiply, -420, -40)
    link(tex, 'RGB', mul, 'A')
    link(tint3, '', mul, 'B')
    mel.connect_material_property(mul, '', unreal.MaterialProperty.MP_BASE_COLOR)
    sss = expr(m, unreal.MaterialExpressionMultiply, -260, 160)
    link(mul, '', sss, 'A')
    k = const(m, 0.55, -420, 220)
    link(k, '', sss, 'B')
    mel.connect_material_property(sss, '', unreal.MaterialProperty.MP_SUBSURFACE_COLOR)
    rough = scalar(m, 'Roughness', 0.7, -420, 320)
    mel.connect_material_property(rough, '', unreal.MaterialProperty.MP_ROUGHNESS)
    wpo = wind_offset(m, -1800, 600)
    mel.connect_material_property(wpo, '', unreal.MaterialProperty.MP_WORLD_POSITION_OFFSET)
    mel.recompile_material(m)
    check_compiled(m, 'листва')
    eal.save_loaded_asset(m)
    return m


@step('материал деревьев, камней и цветов')
def make_kit_material(textures):
    """Opaque material for the parts of instanced kit models that are not leaves or grass: bark, stone, flowers.
    The importer's own glTF materials lack the instancing flag (see instanced_usage)."""
    m = new_material('M_LigaKit')
    instanced_usage(m)
    white = unreal.load_asset('/Engine/EngineResources/WhiteSquareTexture')
    tex = expr(m, unreal.MaterialExpressionTextureSampleParameter2D, -700, -200, parameter_name='BaseColor')
    if white:
        tex.set_editor_property('texture', white)
    tint = expr(m, unreal.MaterialExpressionVectorParameter, -900, 40, parameter_name='Tint', default_value=unreal.LinearColor(1, 1, 1, 1))
    tint3 = expr(m, unreal.MaterialExpressionComponentMask, -700, 40, r=True, g=True, b=True, a=False)
    link(tint, '', tint3, '')
    mul = expr(m, unreal.MaterialExpressionMultiply, -420, -120)
    link(tex, 'RGB', mul, 'A')
    link(tint3, '', mul, 'B')
    mel.connect_material_property(mul, '', unreal.MaterialProperty.MP_BASE_COLOR)
    nrm = expr(m, unreal.MaterialExpressionTextureSampleParameter2D, -700, 200, parameter_name='Normal',
               sampler_type=unreal.MaterialSamplerType.SAMPLERTYPE_NORMAL)
    if 'stone_normal' in textures:
        nrm.set_editor_property('texture', textures['stone_normal'])
    flat = expr(m, unreal.MaterialExpressionConstant3Vector, -700, 420, constant=unreal.LinearColor(0, 0, 1, 1))
    strength = scalar(m, 'NormalStrength', 1.0, -700, 520)
    lerp = expr(m, unreal.MaterialExpressionLinearInterpolate, -420, 300)
    link(flat, '', lerp, 'A')
    link(nrm, 'RGB', lerp, 'B')
    link(strength, '', lerp, 'Alpha')
    mel.connect_material_property(lerp, '', unreal.MaterialProperty.MP_NORMAL)
    mel.connect_material_property(scalar(m, 'Roughness', 0.8, -420, 520), '', unreal.MaterialProperty.MP_ROUGHNESS)
    mel.recompile_material(m)
    check_compiled(m, 'деревья, камни и цветы')
    eal.save_loaded_asset(m)
    return m


def kit_colors():
    """baseColorFactor of the kit's untextured glTF materials (flowers, stems), by material name."""
    out = {}
    kit_dir = os.path.join(EXPORTS, 'Kit')
    for f in sorted(os.listdir(kit_dir)):
        if not f.endswith('.glb'):
            continue
        with open(os.path.join(kit_dir, f), 'rb') as fh:
            data = fh.read()
        n = int.from_bytes(data[12:16], 'little')
        for mat in json.loads(data[20:20 + n]).get('materials', []):
            pbr = mat.get('pbrMetallicRoughness', {})
            if 'baseColorFactor' in pbr and 'baseColorTexture' not in pbr:
                out[mat.get('name', '').lower()] = pbr['baseColorFactor']
    return out


def make_instance(parent, name, scalars=None, textures=None, vectors=None):
    path = f'{MAT_PATH}/{name}'
    mi = eal.load_asset(path) if eal.does_asset_exist(path) else asset_tools.create_asset(name, MAT_PATH, unreal.MaterialInstanceConstant, unreal.MaterialInstanceConstantFactoryNew())
    mel.set_material_instance_parent(mi, parent)
    for k, v in (scalars or {}).items():
        mel.set_material_instance_scalar_parameter_value(mi, k, v)
    for k, v in (textures or {}).items():
        if v is not None:
            mel.set_material_instance_texture_parameter_value(mi, k, v)
    for k, v in (vectors or {}).items():
        mel.set_material_instance_vector_parameter_value(mi, k, v)
    mel.update_material_instance(mi)
    eal.save_loaded_asset(mi)
    return mi


@step('материал рельефа')
def make_terrain_material(textures):
    m = new_material('M_LigaTerrain')
    uv = expr(m, unreal.MaterialExpressionTextureCoordinate, -1300, 0, coordinate_index=0)
    vc = expr(m, unreal.MaterialExpressionVertexColor, -900, 500)
    samples = {}
    for i, name in enumerate(('grass', 'dirt', 'sand')):
        s = expr(m, unreal.MaterialExpressionTextureSample, -1000, -500 + i * 260)
        if f'{name}_albedo' in textures:
            s.set_editor_property('texture', textures[f'{name}_albedo'])
        link(uv, '', s, 'UVs')
        samples[name] = s
    # large-scale tint variation on grass so the tiling is not visible
    macro_uv = expr(m, unreal.MaterialExpressionTextureCoordinate, -1300, -800, coordinate_index=0, u_tiling=0.07, v_tiling=0.07)
    macro = expr(m, unreal.MaterialExpressionTextureSample, -1000, -800)
    if 'grass_albedo' in textures:
        macro.set_editor_property('texture', textures['grass_albedo'])
    link(macro_uv, '', macro, 'UVs')
    macro_mul = expr(m, unreal.MaterialExpressionMultiply, -700, -650)
    link(samples['grass'], 'RGB', macro_mul, 'A')
    link(macro, 'RGB', macro_mul, 'B')
    boost = const(m, 2.2, -700, -560)
    grass_col = expr(m, unreal.MaterialExpressionMultiply, -550, -620)
    link(macro_mul, '', grass_col, 'A')
    link(boost, '', grass_col, 'B')
    l1 = expr(m, unreal.MaterialExpressionLinearInterpolate, -350, -300)
    link(grass_col, '', l1, 'A')
    link(samples['dirt'], 'RGB', l1, 'B')
    link(vc, 'R', l1, 'Alpha')
    l2 = expr(m, unreal.MaterialExpressionLinearInterpolate, -150, -200)
    link(l1, '', l2, 'A')
    link(samples['sand'], 'RGB', l2, 'B')
    link(vc, 'G', l2, 'Alpha')
    mel.connect_material_property(l2, '', unreal.MaterialProperty.MP_BASE_COLOR)
    nrm = {}
    for i, name in enumerate(('grass', 'dirt')):
        s = expr(m, unreal.MaterialExpressionTextureSample, -1000, 300 + i * 260, sampler_type=unreal.MaterialSamplerType.SAMPLERTYPE_NORMAL)
        if f'{name}_normal' in textures:
            s.set_editor_property('texture', textures[f'{name}_normal'])
        link(uv, '', s, 'UVs')
        nrm[name] = s
    ln = expr(m, unreal.MaterialExpressionLinearInterpolate, -350, 400)
    link(nrm['grass'], 'RGB', ln, 'A')
    link(nrm['dirt'], 'RGB', ln, 'B')
    link(vc, 'R', ln, 'Alpha')
    mel.connect_material_property(ln, '', unreal.MaterialProperty.MP_NORMAL)
    mel.connect_material_property(const(m, 0.92, -150, 200), '', unreal.MaterialProperty.MP_ROUGHNESS)
    mel.recompile_material(m)
    check_compiled(m, 'рельеф')
    eal.save_loaded_asset(m)
    return m


@step('материал моря')
def make_water_material(textures):
    m = new_material('M_LigaSea')
    m.set_editor_property('two_sided', True)
    instanced_usage(m)
    wp = expr(m, unreal.MaterialExpressionLocalPosition, -1400, 0)  # not world position: see wind_offset
    xy = expr(m, unreal.MaterialExpressionComponentMask, -1200, 0, r=True, g=True, b=False, a=False)
    link(wp, '', xy, '')
    sc = const(m, 0.0006, -1200, 100)
    uv = expr(m, unreal.MaterialExpressionMultiply, -1050, 40)
    link(xy, '', uv, 'A')
    link(sc, '', uv, 'B')
    normals = []
    for i, (sx, sy) in enumerate(((0.02, 0.013), (-0.016, 0.021))):
        pan = expr(m, unreal.MaterialExpressionPanner, -850, -100 + i * 220, speed_x=sx, speed_y=sy)
        link(uv, '', pan, 'Coordinate')
        s = expr(m, unreal.MaterialExpressionTextureSample, -650, -100 + i * 220, sampler_type=unreal.MaterialSamplerType.SAMPLERTYPE_NORMAL)
        if 'water_normal' in textures:
            s.set_editor_property('texture', textures['water_normal'])
        link(pan, '', s, 'UVs')
        normals.append(s)
    add = expr(m, unreal.MaterialExpressionAdd, -420, 0)
    link(normals[0], 'RGB', add, 'A')
    link(normals[1], 'RGB', add, 'B')
    norm = expr(m, unreal.MaterialExpressionNormalize, -280, 0)
    link(add, '', norm, '')
    mel.connect_material_property(norm, '', unreal.MaterialProperty.MP_NORMAL)
    col = expr(m, unreal.MaterialExpressionConstant3Vector, -300, -250, constant=unreal.LinearColor(0.015, 0.13, 0.2, 1))
    mel.connect_material_property(col, '', unreal.MaterialProperty.MP_BASE_COLOR)
    mel.connect_material_property(const(m, 0.04, -300, 200), '', unreal.MaterialProperty.MP_ROUGHNESS)
    mel.connect_material_property(const(m, 0.9, -300, 280), '', unreal.MaterialProperty.MP_SPECULAR)
    mel.recompile_material(m)
    check_compiled(m, 'море')
    eal.save_loaded_asset(m)
    return m


@step('материал для картинок покемонов')
def make_billboard_material():
    m = new_material('M_Billboard')
    m.set_editor_property('blend_mode', unreal.BlendMode.BLEND_MASKED)
    m.set_editor_property('two_sided', True)
    m.set_editor_property('opacity_mask_clip_value', 0.35)
    tex = expr(m, unreal.MaterialExpressionTextureSampleParameter2D, -700, 0, parameter_name='Tex')
    default = unreal.load_asset('/Engine/EngineResources/WhiteSquareTexture')
    if default:
        tex.set_editor_property('texture', default)
    mel.connect_material_property(tex, 'RGB', unreal.MaterialProperty.MP_BASE_COLOR)
    mel.connect_material_property(tex, 'A', unreal.MaterialProperty.MP_OPACITY_MASK)
    glow = scalar(m, 'Glow', 0.35, -700, 260)
    flash = scalar(m, 'Flash', 0.0, -700, 360)
    em = expr(m, unreal.MaterialExpressionMultiply, -450, 200)
    link(tex, 'RGB', em, 'A')
    link(glow, '', em, 'B')
    em2 = expr(m, unreal.MaterialExpressionAdd, -300, 260)
    link(em, '', em2, 'A')
    link(flash, '', em2, 'B')
    mel.connect_material_property(em2, '', unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    mel.connect_material_property(const(m, 0.8, -300, 380), '', unreal.MaterialProperty.MP_ROUGHNESS)
    mel.recompile_material(m)
    check_compiled(m, 'картинки покемонов')
    eal.save_loaded_asset(m)
    return m


@step('материал эффектов боя')
def make_fx_material():
    """Translucent unlit material for battle effects (LigaBattleFx). Parameters: Color, Glow, Alpha and Shape:
    0 — solid shape, 1 — soft round puff, 2 — ring (both drawn on a camera-facing quad), 3 — sphere with soft edges."""
    m = new_material('M_LigaFx')
    m.set_editor_property('blend_mode', unreal.BlendMode.BLEND_TRANSLUCENT)
    m.set_editor_property('shading_model', unreal.MaterialShadingModel.MSM_UNLIT)
    m.set_editor_property('two_sided', True)
    color = expr(m, unreal.MaterialExpressionVectorParameter, -1200, -300, parameter_name='Color', default_value=unreal.LinearColor(1, 1, 1, 1))
    rgb = expr(m, unreal.MaterialExpressionComponentMask, -980, -300, r=True, g=True, b=True, a=False)
    link(color, '', rgb, '')
    glow = scalar(m, 'Glow', 3.0, -980, -180)
    em = expr(m, unreal.MaterialExpressionMultiply, -760, -260)
    link(rgb, '', em, 'A')
    link(glow, '', em, 'B')
    mel.connect_material_property(em, '', unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    # d = distance from the middle of the quad, 0 in the centre and 1 at the edge
    uv = expr(m, unreal.MaterialExpressionTextureCoordinate, -1400, 100)
    mid = expr(m, unreal.MaterialExpressionConstant2Vector, -1400, 220, r=0.5, g=0.5)
    dist = expr(m, unreal.MaterialExpressionDistance, -1200, 140)
    link(uv, '', dist, 'A')
    link(mid, '', dist, 'B')
    d = expr(m, unreal.MaterialExpressionMultiply, -1040, 140)
    link(dist, '', d, 'A')
    link(const(m, 2.0, -1200, 260), '', d, 'B')
    # soft puff: (1 - d)^2
    inv = expr(m, unreal.MaterialExpressionOneMinus, -880, 60)
    link(d, '', inv, '')
    sat1 = expr(m, unreal.MaterialExpressionSaturate, -740, 60)
    link(inv, '', sat1, '')
    disc = expr(m, unreal.MaterialExpressionMultiply, -600, 60)
    link(sat1, '', disc, 'A')
    link(sat1, '', disc, 'B')
    # ring: 1 - |d - 0.72| * 7
    sub = expr(m, unreal.MaterialExpressionSubtract, -880, 240)
    link(d, '', sub, 'A')
    link(const(m, 0.72, -1040, 300), '', sub, 'B')
    ab = expr(m, unreal.MaterialExpressionAbs, -740, 240)
    link(sub, '', ab, '')
    mul7 = expr(m, unreal.MaterialExpressionMultiply, -600, 240)
    link(ab, '', mul7, 'A')
    link(const(m, 7.0, -740, 320), '', mul7, 'B')
    inv2 = expr(m, unreal.MaterialExpressionOneMinus, -470, 240)
    link(mul7, '', inv2, '')
    ring = expr(m, unreal.MaterialExpressionSaturate, -340, 240)
    link(inv2, '', ring, '')
    # sphere: bright in the middle, fading to its outline
    fres = expr(m, unreal.MaterialExpressionFresnel, -740, 420, exponent=1.5)
    orb = expr(m, unreal.MaterialExpressionOneMinus, -600, 420)
    link(fres, '', orb, '')
    # pick the mask by Shape
    shape = scalar(m, 'Shape', 1.0, -1040, 560)
    s1 = expr(m, unreal.MaterialExpressionSaturate, -880, 560)
    link(shape, '', s1, '')
    shp2 = expr(m, unreal.MaterialExpressionSubtract, -880, 640)
    link(shape, '', shp2, 'A')
    link(const(m, 1.0, -1040, 680), '', shp2, 'B')
    s2 = expr(m, unreal.MaterialExpressionSaturate, -740, 640)
    link(shp2, '', s2, '')
    shp3 = expr(m, unreal.MaterialExpressionSubtract, -880, 740)
    link(shape, '', shp3, 'A')
    link(const(m, 2.0, -1040, 780), '', shp3, 'B')
    s3 = expr(m, unreal.MaterialExpressionSaturate, -740, 740)
    link(shp3, '', s3, '')
    l1 = expr(m, unreal.MaterialExpressionLinearInterpolate, -340, 60)
    link(const(m, 1.0, -470, 0), '', l1, 'A')
    link(disc, '', l1, 'B')
    link(s1, '', l1, 'Alpha')
    l2 = expr(m, unreal.MaterialExpressionLinearInterpolate, -200, 200)
    link(l1, '', l2, 'A')
    link(ring, '', l2, 'B')
    link(s2, '', l2, 'Alpha')
    l3 = expr(m, unreal.MaterialExpressionLinearInterpolate, -60, 340)
    link(l2, '', l3, 'A')
    link(orb, '', l3, 'B')
    link(s3, '', l3, 'Alpha')
    alpha = scalar(m, 'Alpha', 1.0, -200, 480)
    op = expr(m, unreal.MaterialExpressionMultiply, 80, 400)
    link(l3, '', op, 'A')
    link(alpha, '', op, 'B')
    mel.connect_material_property(op, '', unreal.MaterialProperty.MP_OPACITY)
    mel.recompile_material(m)
    check_compiled(m, 'эффекты боя')
    eal.save_loaded_asset(m)
    return m


@step('материалы набора')
def apply_kit_materials(meshes, foliage, textures, kit=None):
    if foliage is None:
        return
    colors = kit_colors() if kit is not None else {}
    kit_instances = {}

    def kit_instance(slot):
        """MI_Kit_<slot>: the slot's own textures from ArtSource/Textures, or its flat glTF colour."""
        if slot not in kit_instances:
            albedo, normal = textures.get(f'{slot}_albedo'), textures.get(f'{slot}_normal')
            color = colors.get(slot, [1.0, 1.0, 1.0, 1.0])
            kit_instances[slot] = make_instance(
                kit, f'MI_Kit_{slot}', {'NormalStrength': 1.0 if normal else 0.0, 'Roughness': 0.85 if albedo else 0.6},
                {'BaseColor': albedo, 'Normal': normal}, {'Tint': unreal.LinearColor(*color[:3], 1.0)})
        return kit_instances[slot]

    variants = {
        'grass_blade': make_instance(foliage, 'MI_Grass', {'Amp': 9.0, 'HeightRef': 100.0, 'Roughness': 0.6}, {'BaseColor': textures.get('grass_blade_albedo')}),
        'leaves': make_instance(foliage, 'MI_Leaves', {'Amp': 5.0, 'HeightRef': 700.0}, {'BaseColor': textures.get('leaves_albedo')}),
        'leaves_dark': make_instance(foliage, 'MI_LeavesDark', {'Amp': 5.0, 'HeightRef': 900.0}, {'BaseColor': textures.get('leaves_dark_albedo')}),
        'hedge': make_instance(foliage, 'MI_Hedge', {'Amp': 1.5, 'HeightRef': 150.0}, {'BaseColor': textures.get('hedge_albedo')}),
    }
    for name, sm in meshes.items():
        foliage_mesh = name.startswith(('grass', 'tree', 'pine', 'bush', 'hedge', 'flower'))
        instanced = name.startswith(('grass', 'tree', 'pine', 'bush', 'flower', 'rock'))  # placed by LigaWorldBuilder
        for i, slot in enumerate(sm.get_editor_property('static_materials')):
            slot_name = short(slot.get_editor_property('material_slot_name'))
            for key, mi in variants.items():
                if slot_name == key or slot_name.endswith(key):
                    sm.set_material(i, mi)
                    break
            else:
                if instanced and kit is not None:
                    sm.set_material(i, kit_instance(slot_name))
        set_collision(sm, complex_as_simple=not name.startswith(('grass', 'flower')))
        if instanced:  # small low-poly props drawn by the thousand: plain meshes are safer than Nanite here
            try:
                nanite = sm.get_editor_property('nanite_settings')
                if nanite.get_editor_property('enabled'):
                    nanite.set_editor_property('enabled', False)
                    sm.set_editor_property('nanite_settings', nanite)
            except Exception:
                pass
        if foliage_mesh:
            sm.set_editor_property('light_map_resolution', 32)
        eal.save_loaded_asset(sm)


# ——— characters ———

@step('поиск персонажей')
def find_characters():
    ar = unreal.AssetRegistryHelpers.get_asset_registry()
    result = {'character_mesh': '', 'character_anim': ''}
    meshes, anims = [], []
    for data in ar.get_assets_by_path('/Game', recursive=True):
        cls = asset_class(data)
        name = str(data.asset_name)
        pkg = str(data.package_name)
        if cls == 'SkeletalMesh' and name.startswith(('SKM_Manny', 'SKM_Quinn')):
            meshes.append((0 if name == 'SKM_Manny_Simple' else 1 if name == 'SKM_Manny' else 2, f'{pkg}.{name}'))
        elif cls == 'AnimBlueprint' and name in ('ABP_Unarmed', 'ABP_Manny', 'ABP_Quinn'):
            anims.append((0 if name == 'ABP_Unarmed' else 1, f'{pkg}.{name}_C'))
    if meshes:
        result['character_mesh'] = sorted(meshes)[0][1]
    else:
        warn('манекен не найден — добавьте Third Person: Content Browser → Add → Add Feature or Content Pack → Third Person')
    if anims:
        result['character_anim'] = sorted(anims)[0][1]
    log(f"манекен: {result['character_mesh'] or '—'}, анимации: {result['character_anim'] or '—'}")
    return result


def asset_class(data):
    return str(data.asset_class_path.asset_name) if hasattr(data, 'asset_class_path') else str(data.asset_class)


def assets_matching(folder, pred):
    ar = unreal.AssetRegistryHelpers.get_asset_registry()
    if hasattr(ar, 'scan_paths_synchronous'):
        ar.scan_paths_synchronous([folder], True)
    return [f'{d.package_name}.{d.asset_name}' for d in ar.get_assets_by_path(folder, recursive=True)
            if pred(asset_class(d), str(d.asset_name))]


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def download(url, dest, sha):
    tmp = dest + '.part'
    with urllib.request.urlopen(url, timeout=90) as r, open(tmp, 'wb') as f:
        shutil.copyfileobj(r, f, 1 << 20)
    if sha and file_sha256(tmp) != sha:
        os.remove(tmp)
        raise RuntimeError('файл повреждён (контрольная сумма не совпала)')
    os.replace(tmp, dest)


def vrm4u_too_old():
    """VRM4U before 23.09.2026 kept a pointer to options owned by a temporary factory in its scripted import, and the
    editor crashed in VRMConverter::ConvertHumanoid. Fixed builds copy the options (ImportOptionStorage)."""
    try:
        with open(VRM4U_CONVERT, encoding='utf-8', errors='ignore') as f:
            return 'ImportOptionStorage' not in f.read()
    except OSError:
        return False  # plugin without sources: cannot tell, try anyway


def enable_vrm4u_in_project():
    """Unreal switches a plugin off in the .uproject when it once failed to load (or after "Disable" in a dialog), and then
    never loads it again. Switches VRM4U back on; True if the file was changed."""
    try:
        path = os.path.abspath(unreal.Paths.convert_relative_path_to_full(unreal.Paths.get_project_file_path()))
        with open(path, encoding='utf-8-sig') as f:
            data = json.load(f)
        plugins = data.setdefault('Plugins', [])
        entry = next((p for p in plugins if p.get('Name') == 'VRM4U'), None)
        if entry is not None and entry.get('Enabled') is True:
            return False
        if entry is None:
            entry = {'Name': 'VRM4U'}
            plugins.append(entry)
        entry['Enabled'] = True
        entry['Optional'] = True
        shutil.copyfile(path, path + '.bak')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=True, indent='\t')
        log(f'VRM4U включён в {path} (старая версия — {os.path.basename(path)}.bak)')
        return True
    except Exception as e:
        warn(f'не удалось включить VRM4U в файле проекта: {e}')
        return False


def srgb_to_linear(c):
    return [((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c]


def recolor_vrm_hair(path, hair):
    """Makes a variant of a downloaded sample model with another hair colour (cast.json "hair"). Only the MToon colours
    of the hair and the brows change: the Sendagaya hair textures are greyscale and take their colour from the material."""
    with open(path, 'rb') as f:
        data = f.read()
    magic, ver, _total = struct.unpack('<III', data[:12])
    clen, ctype = struct.unpack('<II', data[12:20])
    if magic != 0x46546C67 or ctype != 0x4E4F534A:
        raise RuntimeError('не похоже на файл VRM')
    gltf = json.loads(data[20:20 + clen].decode('utf-8'))
    rest = data[20 + clen:]  # the binary chunk stays as it is
    hair = [float(c) for c in hair][:3]
    shade = [c * 0.72 for c in hair]
    brow = [c * 0.5 for c in hair]

    def is_hair(name):
        return '_HAIR' in name and not name.endswith('_02')  # *_HAIR_02 is the inner layer with its own coloured texture

    for mp in gltf['extensions']['VRM']['materialProperties']:
        vp = mp.setdefault('vectorProperties', {})
        name = mp.get('name', '')
        if is_hair(name):
            vp['_Color'], vp['_ShadeColor'] = hair + [1.0], shade + [1.0]
        elif 'FaceBrow' in name:
            vp['_Color'], vp['_ShadeColor'] = brow + [1.0], brow + [1.0]
    for m in gltf.get('materials', []):
        name = m.get('name', '')
        pbr = m.setdefault('pbrMetallicRoughness', {})
        if is_hair(name):
            pbr['baseColorFactor'] = srgb_to_linear(hair) + [1.0]
        elif 'FaceBrow' in name:
            pbr['baseColorFactor'] = srgb_to_linear(brow) + [1.0]
    js = json.dumps(gltf, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    js += b' ' * ((4 - len(js) % 4) % 4)
    out = struct.pack('<III', magic, ver, 12 + 8 + len(js) + len(rest)) + struct.pack('<II', len(js), ctype) + js + rest
    tmp = path + '.part'
    with open(tmp, 'wb') as f:
        f.write(out)
    os.replace(tmp, path)


def save_char_state(state):
    os.makedirs(os.path.dirname(CHAR_STATE), exist_ok=True)
    with open(CHAR_STATE, 'w', encoding='utf-8') as f:
        json.dump(state, f, indent=1)


@step('аниме-персонажи (VRoid)')
def import_characters():
    """Downloads the cast from cast.json and imports each model with VRM4U into /Game/Characters/VRoid/<Name>/,
    together with the IK retargeter from the UE5 mannequin (needs the C++ helper ULigaEditorTools).
    A model is re-imported only when its file changed, so running the setup again is quick."""
    result = {'player_vrm': '', 'player_rtg': '', 'npc_vrm': {}, 'npc_rtg': {}}
    if not hasattr(unreal, 'VrmImporterBPFunctionLibrary'):
        if os.path.exists(os.path.join(PROJECT, 'Plugins', 'VRM4U', 'VRM4U.uplugin')):
            fixed = enable_vrm4u_in_project()
            if fixed:
                warn('плагин VRM4U был выключен в файле проекта — скрипт включил его. Чтобы появились аниме-персонажи: закройте Unreal, '
                     'откройте Liga17.uproject снова (на вопрос о пересборке ответьте «Да») и запустите настройку ещё раз')
                REPORT.insert(0, 'ВАЖНО: перезапустите Unreal и запустите настройку ещё раз — плагин VRM4U только что включён.')
            elif os.path.exists(os.path.join(PROJECT, 'Plugins', 'VRM4U', 'Binaries', 'Win64', 'UnrealEditor-VRM4U.dll')):
                # After the project was rebuilt at start-up (Binaries deleted) Unreal has already picked its plugins: VRM4U
                # is built, but only the next start loads it.
                warn('плагин VRM4U собран, но в этом запуске Unreal ещё не подключил его (так бывает сразу после пересборки проекта)')
                REPORT.insert(0, 'ВАЖНО: закройте Unreal, откройте Liga17.uproject ещё раз и снова запустите настройку — '
                                 'тогда подключится плагин VRM4U и появятся аниме-персонажи.')
            else:
                warn('плагин VRM4U включён в проекте, но не загрузился: люди останутся манекенами. Закройте Unreal, удалите папки '
                     'Plugins/VRM4U/Binaries и Plugins/VRM4U/Intermediate, откройте Liga17.uproject, согласитесь пересобрать '
                     'и запустите настройку ещё раз. Если не поможет — пришлите Saved/Logs/Liga17.log')
        else:
            warn('плагин VRM4U не найден: люди останутся манекенами. Установка плагина — шаг 4 в Docs/README_RU.md')
        return result
    with open(os.path.join(CHARACTERS, 'cast.json'), encoding='utf-8') as f:
        cast = json.load(f)['roles']
    state = {}
    if os.path.exists(CHAR_STATE):
        with open(CHAR_STATE, encoding='utf-8') as f:
            state = json.load(f)
    if os.path.exists(CHAR_GUARD):  # the editor died while importing this model last time
        with open(CHAR_GUARD, encoding='utf-8') as f:
            g = json.load(f)
        state[g['role']] = 'crashed:' + g['sha']
        save_char_state(state)
        os.remove(CHAR_GUARD)
    can_import = not vrm4u_too_old()
    if not can_import:
        warn('плагин VRM4U устарел: в его версии есть ошибка, из-за которой падал редактор. Новые персонажи не импортируются, '
             f'пока его не обновить: {VRM4U_URL} (инструкция — в Docs/README_RU.md)')
    tools = getattr(unreal, 'LigaEditorTools', None)
    with_rtg = bool(tools) and tools.can_import_vrm_with_retargeter()
    root = VRM_ROOT if with_rtg else VRM_ROOT_PLAIN
    if not tools:  # Unreal does not rebuild the project by itself when only its source code changed
        warn('редактор работает со старой сборкой проекта, поэтому персонажи импортируются без ретаргетера анимаций. Закройте Unreal, '
             'удалите папку Binaries в папке проекта (не в Plugins), откройте Liga17.uproject, согласитесь пересобрать и запустите настройку ещё раз')
    elif not with_rtg:
        warn('проект собран без VRM4U, поэтому персонажи импортируются без ретаргетера анимаций. Плагин должен лежать в '
             'Plugins/VRM4U/VRM4U.uplugin; затем закройте Unreal, удалите папку Binaries в папке проекта, откройте Liga17.uproject и пересоберите')
    imported, ready, plain = 0, 0, 0
    with unreal.ScopedSlowTask(len(cast), 'Аниме-персонажи') as task:
        task.make_dialog(True)
        for role, info in cast.items():
            try:
                file = info['file']
                name = os.path.splitext(file)[0]
                path = os.path.join(CHARACTERS, file)
                folder = f'{root}/{name}'
                task.enter_progress_frame(1, f'{name}: {info.get("source", "")}')
                if not os.path.exists(path):
                    if not info.get('url'):
                        warn(f'{file}: файла нет в ArtSource/Characters')
                        continue
                    try:
                        log(f'скачиваю {file} ({info.get("source")})')
                        download(info['url'], path, info.get('sha256'))
                    except Exception as e:
                        warn(f'{file}: не удалось скачать ({e}). Скачайте вручную {info["url"]} и сохраните как ArtSource/Characters/{file}')
                        continue
                    if info.get('hair'):
                        try:
                            recolor_vrm_hair(path, info['hair'])
                        except Exception as e:
                            warn(f'{file}: не удалось перекрасить волосы ({e}) — будет исходная модель')
                sha = file_sha256(path)
                lists = assets_matching(folder, lambda c, n: 'VrmAssetList' in c)
                if state.get(role) == 'crashed:' + sha:
                    warn(f'{name}: эта модель в прошлый раз уронила редактор — пропущена (замените файл {file}, чтобы попробовать снова)')
                    continue
                if (not lists or state.get(role) != sha) and not can_import:
                    continue
                if not lists or state.get(role) != sha:
                    if eal.does_directory_exist(folder) and not eal.delete_directory(folder):
                        warn(f'{name}: не удалось удалить старый импорт {folder} — перезапустите редактор и запустите настройку ещё раз')
                        continue
                    opts = unreal.ImportOptionData()
                    for prop, value in (('mipmap_generate_mode', True), ('bc7_mode', True)):
                        try:
                            opts.set_editor_property(prop, value)
                        except Exception:
                            pass
                    os.makedirs(os.path.dirname(CHAR_GUARD), exist_ok=True)
                    with open(CHAR_GUARD, 'w', encoding='utf-8') as f:
                        json.dump({'role': role, 'sha': sha}, f)
                    obj = None
                    if with_rtg:
                        obj = tools.import_vrm_with_retargeter(path, f'{folder}/{name}', True)
                        if obj is None:  # better a model without the retargeter than none (see Saved/Logs/Liga17.log)
                            warn(f'{name}: импорт с ретаргетером не удался — импортирую без него')
                            plain += 1
                            folder = f'{VRM_ROOT_PLAIN}/{name}'
                            lists = assets_matching(folder, lambda c, n: 'VrmAssetList' in c)  # an earlier plain import, if any
                    if obj is None and not (with_rtg and lists and folder.startswith(VRM_ROOT_PLAIN)):
                        obj = unreal.VrmImporterBPFunctionLibrary.import_vrm_file_with_options(path, f'{folder}/{name}', opts)
                    os.remove(CHAR_GUARD)
                    if obj is None and not lists:
                        warn(f'{file}: VRM4U не смог импортировать модель')
                        continue
                    if obj is not None:
                        eal.save_directory(folder, only_if_is_dirty=False, recursive=True)
                        lists = [obj.get_path_name()]
                        imported += 1
                    state[role] = sha
                    save_char_state(state)
                rtg = f'{folder}/RTG_{name}.RTG_{name}'
                if not eal.does_asset_exist(rtg):
                    found = assets_matching(folder, lambda c, n: c == 'IKRetargeter' and n.startswith('RTG_') and not n.startswith(('RTG_UE4_', 'RTG_UEFN_')))
                    rtg = found[0] if found else ''
                if role == 'player':
                    result['player_vrm'], result['player_rtg'] = lists[0], rtg
                else:
                    result['npc_vrm'][role], result['npc_rtg'][role] = lists[0], rtg
                ready += 1
            except Exception as e:  # one broken model must not cost the whole cast
                warn(f'{info.get("file")}: {e}')

    save_char_state(state)
    if with_rtg and not plain and ready == len(cast) and eal.does_directory_exist(VRM_ROOT_PLAIN):
        ok = eal.delete_directory(VRM_ROOT_PLAIN)  # the old imports without retargeters; Unreal refuses while they are loaded
        log(f'старые персонажи {VRM_ROOT_PLAIN}: ' + ('удалены' if ok else 'пока не удалось удалить (попробую в следующий раз)'))
    no_rtg = [r for r, v in result['npc_rtg'].items() if not v] + (['player'] if result['player_vrm'] and not result['player_rtg'] else [])
    log(f'аниме-персонажи: готово {ready} из {len(cast)} (импортировано сейчас: {imported})')
    if no_rtg:
        warn('нет ретаргетера анимаций для: ' + ', '.join(no_rtg) + ' — они будут двигаться упрощённо')
    return result


_P3D = []


def pokemon3d_module():
    """liga_pokemon3d.py, freshly loaded once per run (the editor keeps Python modules between runs)."""
    if not _P3D:
        import importlib
        import sys
        here = os.path.join(PROJECT, 'Content', 'Python')
        if here not in sys.path:
            sys.path.insert(0, here)
        import liga_pokemon3d
        _P3D.append(importlib.reload(liga_pokemon3d))
    return _P3D[0]


def pokemon3d_job():
    """3D models for the Pokémon in the game (Kanto and the Johto Pokémon near New Bark Town), see liga_pokemon3d.py.
    The job imports one model per editor frame (run_frames below) so the graphics card memory is freed in between."""
    try:
        p3d = pokemon3d_module()
        if not p3d.quick_save():
            REPORT.insert(0, 'ВАЖНО: C++ часть проекта старая — 3D-покемоны сохраняются с миниатюрами, и может не хватить '
                             'памяти. Закройте Unreal, удалите папку Binaries, откройте Liga17.uproject, согласитесь '
                             'пересобрать и запустите настройку ещё раз.')
        return p3d.ImportJob(p3d.GAME_SPECIES, True, log, warn)
    except Exception as e:
        warn(f'3D-покемоны: {e}')
        return None


# ——— level ———

def spawn(cls, loc, rot=None):
    return actors_sub.spawn_actor_from_class(cls, unreal.Vector(*loc), rot or unreal.Rotator(0, 0, 0))


def set_props(obj, what, values):
    """Sets editor properties one at a time, so one renamed property does not skip the rest.
    A name can be a tuple of alternatives (Python names differ between engine versions)."""
    for names, value in values:
        names = (names,) if isinstance(names, str) else names
        for n in names:
            try:
                obj.set_editor_property(n, value)
                break
            except Exception:
                continue
        else:
            warn(f'{what}: свойство {names[0]} не найдено')


@step('освещение')
def add_lighting():
    sun = spawn(unreal.DirectionalLight, (0, 0, 5000), unreal.Rotator(roll=0, pitch=-38, yaw=215))
    set_props(sun.get_component_by_class(unreal.DirectionalLightComponent), 'солнце', (
        ('mobility', unreal.ComponentMobility.MOVABLE),
        ('intensity', 9.5),
        ('light_color', unreal.Color(r=255, g=242, b=219, a=255)),
        ('atmosphere_sun_light', True),
        ('dynamic_shadow_distance_movable_light', 20000.0),
        ('light_source_angle', 1.2),
    ))
    sky = spawn(unreal.SkyLight, (0, 0, 300))
    set_props(sky.get_component_by_class(unreal.SkyLightComponent), 'небесный свет', (
        ('mobility', unreal.ComponentMobility.MOVABLE),
        ('real_time_capture', True),
        ('intensity', 1.15),
    ))
    spawn(unreal.SkyAtmosphere, (0, 0, 0))
    clouds = spawn(unreal.VolumetricCloud, (0, 0, 0))
    cloud_mat = unreal.load_asset('/Engine/EngineSky/VolumetricClouds/m_SimpleVolumetricCloud_Inst')
    if cloud_mat:
        set_props(clouds.get_component_by_class(unreal.VolumetricCloudComponent), 'облака', (('material', cloud_mat),))
    fog = spawn(unreal.ExponentialHeightFog, (0, 0, -100))
    set_props(fog.get_component_by_class(unreal.ExponentialHeightFogComponent), 'туман', (
        ('fog_density', 0.006),
        ('fog_height_falloff', 0.12),
        (('enable_volumetric_fog', 'volumetric_fog'), True),
    ))
    ppv = spawn(unreal.PostProcessVolume, (0, 0, 0))
    set_props(ppv, 'пост-обработка', (('unbound', True),))
    s = ppv.get_editor_property('settings')
    for prop, value in (
        ('auto_exposure_bias', 0.4), ('bloom_intensity', 0.55), ('vignette_intensity', 0.25),
        ('ambient_occlusion_intensity', 0.6),
        ('color_saturation', unreal.Vector4(1.12, 1.12, 1.12, 1.0)), ('color_contrast', unreal.Vector4(1.04, 1.04, 1.04, 1.0)),
    ):
        try:
            s.set_editor_property('override_' + prop, True)
            s.set_editor_property(prop, value)
        except Exception as e:
            warn(f'пост-обработка {prop}: {e}')
    ppv.set_editor_property('settings', s)
    log('свет, небо, облака, туман и пост-обработка добавлены')


def blender_to_ue(p):
    return (p[0] * 100.0, -p[1] * 100.0, p[2] * 100.0)


@step('уровень')
def open_fresh_level():
    if eal.does_asset_exist(MAP_PATH):
        level_sub.load_level(MAP_PATH)
        doomed = [a for a in actors_sub.get_all_level_actors() if not isinstance(a, unreal.WorldSettings)]
        actors_sub.destroy_actors(doomed)
    else:
        level_sub.new_level(MAP_PATH)
    log('уровень ' + MAP_PATH)


def import_scene_interchange():
    """Imports PalletTown.glb straight into the open level (keeps every transform exactly as in Blender)."""
    mgr = unreal.InterchangeManager.get_interchange_manager_scripted()
    src = unreal.InterchangeManager.create_source_data(os.path.join(EXPORTS, 'PalletTown.glb'))
    params = unreal.ImportAssetParameters()
    params.is_automated = True
    try:
        params.replace_existing = True
    except Exception:
        pass
    return mgr, mgr.import_scene(TOWN_PATH, src, params)


def place_scene_fallback(meshes):
    """Imports the town meshes as assets and places them from scene.json."""
    import_files([os.path.join(EXPORTS, 'PalletTown.glb')], TOWN_PATH)
    town_meshes = {short(sm.get_name()): sm for sm in assets_in(TOWN_PATH, unreal.StaticMesh)}
    town_meshes.update(meshes)
    with open(os.path.join(EXPORTS, 'scene.json'), encoding='utf-8') as f:
        scene = json.load(f)
    placed = 0
    for o in scene:
        sm = town_meshes.get(o['mesh'].lower())
        if sm is None:
            warn('нет модели ' + o['mesh'])
            continue
        loc = blender_to_ue(o['loc'])
        rot = unreal.Rotator(roll=0, pitch=0, yaw=-math.degrees(o['rot_z']))
        a = actors_sub.spawn_actor_from_object(sm, unreal.Vector(*loc), rot)
        a.set_actor_scale3d(unreal.Vector(*o['scale']))
        a.set_actor_label(o['name'])
        placed += 1
    log(f'запасной вариант: размещено объектов {placed}')


def finish_level(terrain_mat, sea_mat):
    markers = 0
    for a in actors_sub.get_all_level_actors():
        label = a.get_actor_label()
        if label.startswith('MARKER_'):
            key = 'MARKER_ORIGIN' if 'ORIGIN' in label else 'MARKER_PX' if 'PX' in label else 'MARKER_PY'
            tags = [t for t in a.get_editor_property('tags')]
            if unreal.Name(key) not in tags:
                tags.append(unreal.Name(key))
            a.set_editor_property('tags', tags)
            a.set_actor_hidden_in_game(True)
            markers += 1
        comp = a.get_component_by_class(unreal.StaticMeshComponent) if hasattr(a, 'get_component_by_class') else None
        if comp is None:
            continue
        sm = comp.get_editor_property('static_mesh')
        if sm is None:
            continue
        name = short(sm.get_name())
        if name.startswith('terrain') and terrain_mat:  # Terrain, TerrainJohto
            comp.set_material(0, terrain_mat)
            set_collision(sm, True)
            eal.save_loaded_asset(sm)
        elif name.startswith('sea') and sea_mat:  # Sea, SeaPond, SeaJohto
            comp.set_material(0, sea_mat)
            comp.set_collision_enabled(unreal.CollisionEnabled.NO_COLLISION)
        else:
            set_collision(sm, True)
    if markers < 3:
        warn('метки осей не найдены — мир будет собран по стандартной ориентации glTF')
    with open(os.path.join(DATA, 'layout.json'), encoding='utf-8') as f:
        layout = json.load(f)
    start = layout['markers']['player_start']
    spawn(unreal.PlayerStart, blender_to_ue((start['x'], start['y'], start.get('z', 0.0) + 1.5)))  # the game starts at home
    add_lighting()
    level_sub.save_current_level()
    eal.save_directory(ROOT, only_if_is_dirty=True, recursive=True)
    log('уровень сохранён')


def write_assets_json(meshes, chars, billboard, models3d=None, fx=None):
    old = {}
    path = os.path.join(DATA, 'assets.json')
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            old = json.load(f)
    data = dict(chars or {})
    for key in ('player_vrm', 'player_rtg', 'npc_vrm', 'npc_rtg'):
        if not data.get(key) and old.get(key):
            data[key] = old[key]  # VRM4U not loaded in this run: the characters imported before stay
    try:  # keeps models added by liga_pokemon3d_all.py and those of an older converter until they are replaced
        kept = pokemon3d_module().current_entries(old.get('pokemon3d'))
    except Exception:
        kept = {}
    data['pokemon3d'] = dict(kept, **(models3d or {}))
    data['kit'] = {k: sm.get_path_name() for k, sm in (meshes or {}).items()}
    data['billboard_material'] = billboard.get_path_name() if billboard else ''
    data['fx_material'] = fx.get_path_name() if fx else ''
    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, 'assets.json'), 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    log('assets.json записан')


NEXT_STEPS = ('\n\nЧто дальше:\n'
              '1. Нажмите OK и подождите, пока справа внизу пропадёт счётчик «Compiling Shaders».\n'
              '2. Нажмите зелёный треугольник ▶ вверху экрана — игра запустится.\n'
              '3. Esc останавливает игру в редакторе; «назад» в меню — Backspace.')


def summary():
    text = '\n'.join(REPORT)
    unreal.log('[Liga] ===== Итог настройки =====\n' + text)
    important = '\n'.join(l for l in REPORT if l.startswith('ВАЖНО'))
    rest = '\n'.join(l for l in REPORT if not l.startswith('ВАЖНО'))
    head = important + '\n\n' if important else ''
    unreal.EditorDialog.show_message('Лига 17 — настройка', 'Готово!\n\n' + head + rest[-1500:] + NEXT_STEPS, unreal.AppMsgType.OK)


def wrong_project():
    """The script only works inside the downloaded liga17-ue project (next to ArtSource/ and Source/Liga17/)."""
    if os.path.isdir(ART) and os.path.isdir(os.path.join(PROJECT, 'Source', 'Liga17')):
        return False
    here = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))) if '__file__' in globals() else '?'
    msg = ('Открыт не тот проект.\n\n'
           f'Сейчас в редакторе: {PROJECT}\n'
           f'Нужен файл: {os.path.join(here, "Liga17.uproject")}\n\n'
           'Закройте Unreal и откройте Liga17.uproject, который лежит рядом с папками ArtSource, Source и Content. '
           'Папку с новым пустым проектом, созданную Unreal, можно удалить.')
    unreal.log_error('[Liga] ' + msg)
    unreal.EditorDialog.show_message('Лига 17 — настройка', msg, unreal.AppMsgType.OK)
    return True


VSM = 'r.Shadow.Virtual.Enable'


def shadows_off():
    """Virtual shadow maps are off while the setup runs. Every imported skeleton (3D Pokémon, VRoid characters) gets a
    thumbnail scene of its own, and with virtual shadow maps each took a 512 MB page pool on the graphics card: about
    thirty of them filled a 12 GB card and Windows reset it ("D3D device removed"). Returns the value to restore."""
    try:
        value = unreal.SystemLibrary.get_console_variable_int_value(VSM)
    except Exception:
        return 0
    if value:
        unreal.SystemLibrary.execute_console_command(None, f'{VSM} 0')
        log('виртуальные тени выключены на время настройки')
    return value


def shadows_back(value):
    if value:
        unreal.SystemLibrary.execute_console_command(None, f'{VSM} {value}')


def in_pie():
    try:
        return level_sub.is_in_play_in_editor()
    except Exception:
        return False


def run_frames(steps, then):
    """Runs (name, fn) steps from the editor's frame ticks, one after another: fn() is called once per frame until it
    returns True. Between frames the editor renders and frees memory, which one long Python call never lets it do."""
    state = {'handle': None, 'busy': False, 'i': 0}

    def on_tick(_dt):
        if state['busy'] or in_pie():  # a progress dialog inside a step ticks the editor's UI again; Play waits
            return
        state['busy'] = True
        try:
            if state['i'] < len(steps):
                name, fn = steps[state['i']]
                try:
                    finished = fn()
                except Exception as e:  # keep going: later steps are still useful
                    warn(f'{name}: {e}')
                    finished = True
                if finished:
                    state['i'] += 1
                return
            unreal.unregister_slate_post_tick_callback(state['handle'])
            try:
                then()
            finally:
                set_busy(False)
        finally:
            state['busy'] = False

    state['handle'] = unreal.register_slate_post_tick_callback(on_tick)


def busy():
    """True while an earlier run is still working in the background (the 3D Pokémon, the level)."""
    return bool(getattr(sys, 'liga17_busy', False))


def set_busy(value):
    sys.liga17_busy = value


def first_steps():
    """Textures, the art kit, materials and characters, in one go (they are few)."""
    os.makedirs(DATA, exist_ok=True)
    src_layout = os.path.join(EXPORTS, 'layout.json')
    if os.path.exists(src_layout):
        shutil.copyfile(src_layout, os.path.join(DATA, 'layout.json'))
    with unreal.ScopedSlowTask(5, 'Лига 17: настройка проекта') as task:
        task.make_dialog(True)
        task.enter_progress_frame(1, 'Текстуры')
        textures = import_textures() or {}
        task.enter_progress_frame(1, 'Модели')
        meshes = import_kit() or {}
        task.enter_progress_frame(1, 'Материалы')
        foliage = make_foliage_material(textures)
        terrain = make_terrain_material(textures)
        sea = make_water_material(textures)
        billboard = make_billboard_material()
        fx = make_fx_material()
        kit = make_kit_material(textures)
        apply_kit_materials(meshes, foliage, textures, kit)
        task.enter_progress_frame(1, 'Персонажи')
        chars = find_characters() or {}
        task.enter_progress_frame(1, 'Аниме-персонажи (первый раз — несколько минут)')
        chars.update(import_characters() or {})
        write_assets_json(meshes, chars, billboard, fx=fx)  # saved first: the 3D step below can be the slowest and riskiest
    return meshes, chars, billboard, fx, terrain, sea


def main():
    if wrong_project():
        return
    if busy():
        unreal.EditorDialog.show_message('Лига 17 — настройка', 'Настройка уже идёт — дождитесь окна «Готово!».\n\n'
                                         'Если оно так и не появилось, перезапустите Unreal и запустите настройку ещё раз.',
                                         unreal.AppMsgType.OK)
        return
    vsm = shadows_off()
    try:
        meshes, chars, billboard, fx, terrain, sea = first_steps()
    except Exception:
        shadows_back(vsm)
        raise

    # The rest runs from the editor's frame ticks (run_frames): the level first (the game needs it; the 3D models are
    # optional), then the 3D Pokémon, one model per frame.
    job = pokemon3d_job()
    scene = {'mgr': None, 'started': False, 'ticks': 0}

    def pokemon3d():
        if job is None:
            return True
        try:
            done = job.tick()
        except Exception:
            job.end()
            raise
        if done:
            write_assets_json(meshes, chars, billboard, job.result, fx=fx)
            if job.low_memory:
                REPORT.insert(0, f'ВАЖНО: Unreal не хватило памяти ({job.low_memory}), 3D-покемонов осталось '
                                 f'поставить: {job.left}. Закройте браузер и другие программы, перезапустите Unreal и '
                                 'запустите настройку ещё раз — импорт продолжится. Если снова остановится, увеличьте '
                                 'файл подкачки Windows (Docs/README_RU.md, «Не хватило памяти»). Играть можно и сейчас: '
                                 'эти покемоны пока картинками.')
        return done

    def level():
        with unreal.ScopedSlowTask(1, 'Лига 17: уровень') as task:
            task.make_dialog(False)
            task.enter_progress_frame(1, 'Уровень')
            open_fresh_level()
            try:
                scene['mgr'], scene['started'] = import_scene_interchange()
            except Exception as e:
                warn(f'Interchange import_scene недоступен ({e}) — использую запасной вариант')
            if scene['started']:
                log('импорт сцены запущен…')
        return True

    def town():
        # Interchange imports asynchronously: finish once it is done.
        if scene['started']:
            scene['ticks'] += 1
            if scene['mgr'].is_interchange_active() and scene['ticks'] < 20000:
                return False
            if not any(a.get_actor_label().startswith('MARKER_') for a in actors_sub.get_all_level_actors()):
                warn('сцена не появилась на уровне — использую запасной вариант')
                place_scene_fallback(meshes)
        else:
            place_scene_fallback(meshes)
        finish_level(terrain, sea)
        return True

    def free_memory():
        # The town takes gigabytes of memory; while the 3D Pokémon are imported an empty map is open instead.
        try:
            unreal.EditorLoadingAndSavingUtils.new_blank_map(False)
            unreal.SystemLibrary.collect_garbage()
            log('город выгружен на время импорта 3D-покемонов')
        except Exception as e:
            warn(f'не удалось выгрузить город ({e})')
        return True

    def town_again():
        level_sub.load_level(MAP_PATH)
        return True

    def wrap_up():
        shadows_back(vsm)
        summary()

    set_busy(True)
    run_frames([('уровень', level), ('сцена', town), ('память', free_memory), ('3D-покемоны', pokemon3d),
                ('уровень', town_again)], wrap_up)


main()
