"""Лига 17 — one-time project setup, run inside the Unreal Editor:
    Tools → Execute Python Script… → Content/Python/liga_setup.py
(or in the Output Log's "Python" console:  exec(open(r'<project>/Content/Python/liga_setup.py', encoding='utf-8').read()) )

What it does:
  1. imports the generated textures and the Pallet Town art kit (ArtSource/Exports/Kit/*.glb);
  2. builds materials: wind-animated foliage, vertex-colour terrain blend, sea, Pokémon billboard;
  3. finds the Third Person mannequin and any VRoid (VRM4U) characters;
  4. creates /Game/Liga/Maps/PalletTown, imports the town scene into it, adds sky, sun, clouds, fog;
  5. writes Content/Liga/Data/assets.json for the game code and saves everything.
Safe to run again: it rebuilds the level and replaces imported assets.
"""
import json
import math
import os
import shutil

import unreal

PROJECT = os.path.abspath(unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir()))
ART = os.path.join(PROJECT, 'ArtSource')
EXPORTS = os.path.join(ART, 'Exports')
TEXTURES = os.path.join(ART, 'Textures')
DATA = os.path.join(PROJECT, 'Content', 'Liga', 'Data')

ROOT = '/Game/Liga'
TEX_PATH = ROOT + '/Textures'
KIT_PATH = ROOT + '/Kit'
MAT_PATH = ROOT + '/Materials'
TOWN_PATH = ROOT + '/Town'
MAP_PATH = ROOT + '/Maps/PalletTown'

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
    mel.connect_material_expressions(a, a_out, b, b_in)


def const(m, v, x, y):
    return expr(m, unreal.MaterialExpressionConstant, x, y, r=v)


def scalar(m, name, v, x, y):
    return expr(m, unreal.MaterialExpressionScalarParameter, x, y, parameter_name=name, default_value=v)


def wind_offset(m, x0, y0):
    """WPO = sway(time, world xy) * Amp * saturate(height above the instance pivot / HeightRef)^2."""
    wp = expr(m, unreal.MaterialExpressionWorldPosition, x0, y0)
    op = expr(m, unreal.MaterialExpressionObjectPositionWS, x0, y0 + 120)
    sub = expr(m, unreal.MaterialExpressionSubtract, x0 + 200, y0 + 60)
    link(wp, '', sub, 'A')
    link(op, '', sub, 'B')
    hz = expr(m, unreal.MaterialExpressionComponentMask, x0 + 360, y0 + 60, r=False, g=False, b=True, a=False)
    link(sub, '', hz, '')
    href = scalar(m, 'HeightRef', 100.0, x0 + 360, y0 + 160)
    div = expr(m, unreal.MaterialExpressionDivide, x0 + 520, y0 + 60)
    link(hz, '', div, 'A')
    link(href, '', div, 'B')
    sat = expr(m, unreal.MaterialExpressionSaturate, x0 + 660, y0 + 60)
    link(div, '', sat, '')
    sq = expr(m, unreal.MaterialExpressionMultiply, x0 + 800, y0 + 60)
    link(sat, '', sq, 'A')
    link(sat, '', sq, 'B')
    # phase = world.x * 0.004 + world.y * 0.006 + time * speed
    xy = expr(m, unreal.MaterialExpressionComponentMask, x0 + 200, y0 - 160, r=True, g=True, b=False, a=False)
    link(wp, '', xy, '')
    dirv = expr(m, unreal.MaterialExpressionConstant2Vector, x0 + 200, y0 - 60, r=0.004, g=0.006)
    dot = expr(m, unreal.MaterialExpressionDotProduct, x0 + 360, y0 - 160)
    link(xy, '', dot, 'A')
    link(dirv, '', dot, 'B')
    time = expr(m, unreal.MaterialExpressionTime, x0 + 200, y0 - 260)
    speed = scalar(m, 'WindSpeed', 1.6, x0 + 200, y0 - 340)
    tmul = expr(m, unreal.MaterialExpressionMultiply, x0 + 360, y0 - 280)
    link(time, '', tmul, 'A')
    link(speed, '', tmul, 'B')
    phase = expr(m, unreal.MaterialExpressionAdd, x0 + 520, y0 - 200)
    link(dot, '', phase, 'A')
    link(tmul, '', phase, 'B')
    s = expr(m, unreal.MaterialExpressionSine, x0 + 660, y0 - 240)
    link(phase, '', s, '')
    c = expr(m, unreal.MaterialExpressionCosine, x0 + 660, y0 - 150)
    link(phase, '', c, '')
    app = expr(m, unreal.MaterialExpressionAppendVector, x0 + 800, y0 - 200)
    link(s, '', app, 'A')
    link(c, '', app, 'B')
    zero = const(m, 0.0, x0 + 800, y0 - 100)
    app3 = expr(m, unreal.MaterialExpressionAppendVector, x0 + 940, y0 - 160)
    link(app, '', app3, 'A')
    link(zero, '', app3, 'B')
    amp = scalar(m, 'Amp', 8.0, x0 + 940, y0 - 40)
    m1 = expr(m, unreal.MaterialExpressionMultiply, x0 + 1100, y0 - 100)
    link(app3, '', m1, 'A')
    link(amp, '', m1, 'B')
    m2 = expr(m, unreal.MaterialExpressionMultiply, x0 + 1240, y0)
    link(m1, '', m2, 'A')
    link(sq, '', m2, 'B')
    return m2


@step('материал листвы')
def make_foliage_material(textures):
    m = new_material('M_LigaFoliage')
    m.set_editor_property('two_sided', True)
    m.set_editor_property('shading_model', unreal.MaterialShadingModel.MSM_TWO_SIDED_FOLIAGE)
    tex = expr(m, unreal.MaterialExpressionTextureSampleParameter2D, -700, -100, parameter_name='BaseColor')
    if 'leaves_albedo' in textures:
        tex.set_editor_property('texture', textures['leaves_albedo'])
    tint = expr(m, unreal.MaterialExpressionVectorParameter, -700, 140, parameter_name='Tint', default_value=unreal.LinearColor(1, 1, 1, 1))
    mul = expr(m, unreal.MaterialExpressionMultiply, -420, -40)
    link(tex, 'RGB', mul, 'A')
    link(tint, '', mul, 'B')
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
    eal.save_loaded_asset(m)
    return m


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
    eal.save_loaded_asset(m)
    return m


@step('материал моря')
def make_water_material(textures):
    m = new_material('M_LigaSea')
    m.set_editor_property('two_sided', True)
    wp = expr(m, unreal.MaterialExpressionWorldPosition, -1400, 0)
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
    eal.save_loaded_asset(m)
    return m


@step('материалы набора')
def apply_kit_materials(meshes, foliage, textures):
    if foliage is None:
        return
    variants = {
        'grass_blade': make_instance(foliage, 'MI_Grass', {'Amp': 9.0, 'HeightRef': 100.0, 'Roughness': 0.6}, {'BaseColor': textures.get('grass_blade_albedo')}),
        'leaves': make_instance(foliage, 'MI_Leaves', {'Amp': 5.0, 'HeightRef': 700.0}, {'BaseColor': textures.get('leaves_albedo')}),
        'leaves_dark': make_instance(foliage, 'MI_LeavesDark', {'Amp': 5.0, 'HeightRef': 900.0}, {'BaseColor': textures.get('leaves_dark_albedo')}),
        'hedge': make_instance(foliage, 'MI_Hedge', {'Amp': 1.5, 'HeightRef': 150.0}, {'BaseColor': textures.get('hedge_albedo')}),
    }
    for name, sm in meshes.items():
        foliage_mesh = name.startswith(('grass', 'tree', 'pine', 'bush', 'hedge', 'flower'))
        for i, slot in enumerate(sm.get_editor_property('static_materials')):
            slot_name = short(slot.get_editor_property('material_slot_name'))
            for key, mi in variants.items():
                if slot_name == key or slot_name.endswith(key):
                    sm.set_material(i, mi)
        set_collision(sm, complex_as_simple=not name.startswith(('grass', 'flower')))
        if foliage_mesh:
            sm.set_editor_property('light_map_resolution', 32)
        eal.save_loaded_asset(sm)


# ——— characters ———

@step('поиск персонажей')
def find_characters():
    ar = unreal.AssetRegistryHelpers.get_asset_registry()
    result = {'character_mesh': '', 'character_anim': '', 'player_vrm': '', 'npc_vrm': {}}
    meshes, anims, vrms = [], [], []
    for data in ar.get_assets_by_path('/Game', recursive=True):
        cls = str(data.asset_class_path.asset_name) if hasattr(data, 'asset_class_path') else str(data.asset_class)
        name = str(data.asset_name)
        pkg = str(data.package_name)
        if cls == 'SkeletalMesh' and name.startswith(('SKM_Manny', 'SKM_Quinn')):
            meshes.append((0 if name == 'SKM_Manny_Simple' else 1 if name == 'SKM_Manny' else 2, f'{pkg}.{name}'))
        elif cls == 'AnimBlueprint' and name in ('ABP_Unarmed', 'ABP_Manny', 'ABP_Quinn'):
            anims.append((0 if name == 'ABP_Unarmed' else 1, f'{pkg}.{name}_C'))
        elif cls == 'VrmAssetListObject':
            vrms.append((name, f'{pkg}.{name}'))
    if meshes:
        result['character_mesh'] = sorted(meshes)[0][1]
    else:
        warn('манекен не найден — добавьте Third Person: Content Browser → Add → Add Feature or Content Pack → Third Person')
    if anims:
        result['character_anim'] = sorted(anims)[0][1]
    looks = ('oak', 'mom', 'girl', 'man', 'rival', 'sailor')
    for name, path in vrms:
        low = name.lower()
        hit = next((l for l in looks if l in low), None)
        if hit:
            result['npc_vrm'][hit] = path
        elif not result['player_vrm'] or 'player' in low:
            result['player_vrm'] = path
    log(f"персонаж: {result['character_mesh'] or '—'}, анимации: {result['character_anim'] or '—'}, VRoid моделей: {len(vrms)}")
    return result


# ——— level ———

def spawn(cls, loc, rot=None):
    return actors_sub.spawn_actor_from_class(cls, unreal.Vector(*loc), rot or unreal.Rotator(0, 0, 0))


@step('освещение')
def add_lighting():
    sun = spawn(unreal.DirectionalLight, (0, 0, 5000), unreal.Rotator(roll=0, pitch=-38, yaw=215))
    lc = sun.get_component_by_class(unreal.DirectionalLightComponent)
    lc.set_editor_property('mobility', unreal.ComponentMobility.MOVABLE)
    lc.set_editor_property('intensity', 9.5)
    lc.set_editor_property('light_color', unreal.Color(r=255, g=242, b=219, a=255))
    lc.set_editor_property('atmosphere_sun_light', True)
    lc.set_editor_property('dynamic_shadow_distance_movable_light', 20000.0)
    lc.set_editor_property('light_source_angle', 1.2)
    sky = spawn(unreal.SkyLight, (0, 0, 300))
    sc = sky.get_component_by_class(unreal.SkyLightComponent)
    sc.set_editor_property('mobility', unreal.ComponentMobility.MOVABLE)
    sc.set_editor_property('real_time_capture', True)
    sc.set_editor_property('intensity', 1.15)
    spawn(unreal.SkyAtmosphere, (0, 0, 0))
    clouds = spawn(unreal.VolumetricCloud, (0, 0, 0))
    cloud_mat = unreal.load_asset('/Engine/EngineSky/VolumetricClouds/m_SimpleVolumetricCloud_Inst')
    if cloud_mat:
        clouds.get_component_by_class(unreal.VolumetricCloudComponent).set_editor_property('material', cloud_mat)
    fog = spawn(unreal.ExponentialHeightFog, (0, 0, -100))
    fc = fog.get_component_by_class(unreal.ExponentialHeightFogComponent)
    fc.set_editor_property('fog_density', 0.006)
    fc.set_editor_property('fog_height_falloff', 0.12)
    fc.set_editor_property('volumetric_fog', True)
    ppv = spawn(unreal.PostProcessVolume, (0, 0, 0))
    ppv.set_editor_property('unbound', True)
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
        if name == 'terrain' and terrain_mat:
            comp.set_material(0, terrain_mat)
            set_collision(sm, True)
            eal.save_loaded_asset(sm)
        elif name == 'sea' and sea_mat:
            comp.set_material(0, sea_mat)
            comp.set_collision_enabled(unreal.CollisionEnabled.NO_COLLISION)
        else:
            set_collision(sm, True)
    if markers < 3:
        warn('метки осей не найдены — мир будет собран по стандартной ориентации glTF')
    with open(os.path.join(DATA, 'layout.json'), encoding='utf-8') as f:
        layout = json.load(f)
    start = layout['markers']['player_start']
    spawn(unreal.PlayerStart, blender_to_ue((start['x'], start['y'], 1.5)))
    add_lighting()
    level_sub.save_current_level()
    eal.save_directory(ROOT, only_if_is_dirty=True, recursive=True)
    log('уровень сохранён')


def write_assets_json(meshes, chars, billboard):
    data = dict(chars or {})
    data['kit'] = {k: sm.get_path_name() for k, sm in (meshes or {}).items()}
    data['billboard_material'] = billboard.get_path_name() if billboard else ''
    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, 'assets.json'), 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    log('assets.json записан')


def summary():
    text = '\n'.join(REPORT)
    unreal.log('[Liga] ===== Итог настройки =====\n' + text)
    unreal.EditorDialog.show_message('Лига 17 — настройка', 'Готово!\n\n' + text[-1800:], unreal.AppMsgType.OK)


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


def main():
    if wrong_project():
        return
    os.makedirs(DATA, exist_ok=True)
    src_layout = os.path.join(EXPORTS, 'layout.json')
    if os.path.exists(src_layout):
        shutil.copyfile(src_layout, os.path.join(DATA, 'layout.json'))
    with unreal.ScopedSlowTask(6, 'Лига 17: настройка проекта') as task:
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
        apply_kit_materials(meshes, foliage, textures)
        task.enter_progress_frame(1, 'Персонажи')
        chars = find_characters()
        write_assets_json(meshes, chars, billboard)
        task.enter_progress_frame(1, 'Уровень')
        open_fresh_level()

    try:
        mgr, started = import_scene_interchange()
    except Exception as e:
        warn(f'Interchange import_scene недоступен ({e}) — использую запасной вариант')
        mgr, started = None, False
    if not started:
        place_scene_fallback(meshes)
        finish_level(terrain, sea)
        summary()
        return

    # Interchange imports asynchronously: finish once it is done.
    state = {'handle': None, 'ticks': 0}

    def on_tick(_dt):
        state['ticks'] += 1
        if mgr.is_interchange_active() and state['ticks'] < 20000:
            return
        unreal.unregister_slate_post_tick_callback(state['handle'])
        try:
            if not any(a.get_actor_label().startswith('MARKER_') for a in actors_sub.get_all_level_actors()):
                warn('сцена не появилась на уровне — использую запасной вариант')
                place_scene_fallback(meshes)
            finish_level(terrain, sea)
        except Exception as e:
            warn(f'завершение уровня: {e}')
        summary()

    state['handle'] = unreal.register_slate_post_tick_callback(on_tick)
    log('импорт сцены запущен…')


main()
