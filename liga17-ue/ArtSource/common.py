"""Shared helpers for the Blender art scripts: materials, a small mesh builder, UVs, bevel/smoothing."""
import math
import os

import bmesh
import bpy
from mathutils import Matrix, Vector, noise

HERE = os.path.dirname(os.path.abspath(__file__))
TEX = os.path.join(HERE, 'Textures')

# name: (texture, metres per texture tile, two-sided, extra)
MATDEF = {
    'roof_red': ('roof_red', 2.4, False, {}),
    'roof_pink': ('roof_pink', 2.4, False, {}),
    'roof_blue': ('roof_blue', 2.4, False, {}),
    'roof_green': ('roof_green', 2.4, False, {}),
    'wall_cream': ('wall_cream', 3.0, False, {}),
    'wall_teal': ('wall_teal', 3.0, False, {}),
    'wall_white': ('wall_white', 3.0, False, {}),
    'wall_peach': ('wall_peach', 3.0, False, {}),
    'wood_white': ('wood_white', 1.2, False, {}),
    'wood_brown': ('wood_brown', 1.2, False, {}),
    'wood_blue': ('wood_blue', 1.4, False, {}),
    'wood_red': ('wood_red', 1.4, False, {}),
    'deck': ('deck', 2.0, False, {}),
    'stone': ('stone', 1.6, False, {}),
    'cobble': ('cobble', 2.5, False, {}),
    'dirt': ('dirt', 5.0, False, {}),
    'grass': ('grass', 5.0, False, {}),
    'sand': ('sand', 5.0, False, {}),
    'bark': ('bark', 1.4, False, {}),
    'leaves': ('leaves', 2.2, False, {'sss': 0.15}),
    'leaves_dark': ('leaves_dark', 2.2, False, {'sss': 0.15}),
    'hedge': ('hedge', 1.6, False, {'sss': 0.1}),
    'grass_blade': ('grass_blade', None, True, {'sss': 0.3}),
    'glass': ('glass', 1.0, False, {'metal': 0.0, 'spec': 0.9}),
    'metal_dark': ('metal_dark', 1.0, False, {'metal': 0.7}),
    'metal_white': ('metal_white', 1.0, False, {'metal': 0.2}),
    'red_paint': ('red_paint', 1.0, False, {}),
    'lamp_glow': ('lamp_glow', 1.0, False, {'emit': 6.0}),
    'sign_pallet': ('sign_pallet', None, False, {}),
    'sign_lab': ('sign_lab', None, False, {}),
    'sign_elmlab': ('sign_elmlab', None, False, {}),
    'sign_route1': ('sign_route1', None, False, {}),
    'sign_center': ('sign_center', None, False, {}),
    'sign_mart': ('sign_mart', None, False, {}),
    'poster_kanto': ('poster_kanto', None, False, {}),
    'rug_ball': ('rug_ball', None, False, {}),
    'floor_wood': ('floor_wood', 2.4, False, {}),
    'floor_tile': ('floor_tile', 4.0, False, {}),
    'floor_lab': ('floor_lab', 4.0, False, {}),
    'wall_inner': ('wall_inner', 3.0, False, {}),
    'wall_lab': ('wall_lab', 3.0, False, {}),
    'wall_pink': ('wall_pink', 3.0, False, {}),
    'carpet_red': ('carpet_red', 1.0, False, {}),
    'carpet_green': ('carpet_green', 1.0, False, {}),
    'counter_pink': ('counter_pink', 1.0, False, {}),
    'cushion_blue': ('cushion_blue', 1.0, False, {}),
    'books': ('books', 1.2, False, {}),
    'goods': ('goods', 1.6, False, {}),
    'pokeball_red': ('pokeball_red', 1.0, False, {}),
    'screen': ('screen', 1.0, False, {'emit': 1.6, 'emit_color': (0.55, 0.85, 1.0)}),
    'window_day': ('window_day', 1.0, False, {'emit': 2.5, 'emit_color': (0.82, 0.91, 1.0)}),
    'flower_red': (None, None, True, {'color': (0.85, 0.12, 0.12)}),
    'flower_yellow': (None, None, True, {'color': (0.98, 0.78, 0.12)}),
    'flower_white': (None, None, True, {'color': (0.95, 0.95, 0.92)}),
    'flower_pink': (None, None, True, {'color': (0.95, 0.45, 0.65)}),
    'flower_blue': (None, None, True, {'color': (0.35, 0.5, 0.95)}),
    'flower_center': (None, None, False, {'color': (0.95, 0.75, 0.15)}),
    'stem': (None, None, True, {'color': (0.18, 0.42, 0.12)}),
    # plain painted plastics and glowing panels for shop goods, machines and signs
    'plastic_yellow': (None, None, False, {'color': (0.98, 0.76, 0.1)}),
    'plastic_green': (None, None, False, {'color': (0.2, 0.68, 0.3)}),
    'plastic_blue': (None, None, False, {'color': (0.16, 0.38, 0.86)}),
    'plastic_purple': (None, None, False, {'color': (0.55, 0.28, 0.78)}),
    'plastic_orange': (None, None, False, {'color': (0.98, 0.5, 0.12)}),
    'plastic_teal': (None, None, False, {'color': (0.1, 0.66, 0.68)}),
    'paper': (None, None, False, {'color': (0.93, 0.91, 0.84)}),
    'tank_water': (None, None, False, {'color': (0.2, 0.55, 0.8), 'emit': 0.6, 'emit_color': (0.35, 0.7, 1.0)}),
    'panel_red': (None, None, False, {'color': (0.9, 0.18, 0.2), 'emit': 1.2, 'emit_color': (1.0, 0.3, 0.3)}),
    'panel_blue': (None, None, False, {'color': (0.2, 0.45, 0.95), 'emit': 1.2, 'emit_color': (0.4, 0.6, 1.0)}),
    'panel_green': (None, None, False, {'color': (0.2, 0.8, 0.35), 'emit': 1.0, 'emit_color': (0.4, 1.0, 0.5)}),
    'rail_steel': ('metal_dark', 1.0, False, {'metal': 0.9}),
    'train_body': (None, None, False, {'color': (0.92, 0.93, 0.95), 'metal': 0.3}),
    'train_stripe': (None, None, False, {'color': (0.12, 0.42, 0.85), 'metal': 0.2}),
    'painting': ('painting', None, False, {}),
    'poster_sale': ('poster_sale', None, False, {}),
    'sign_aisle_balls': ('sign_aisle_balls', None, False, {}),
    'sign_aisle_meds': ('sign_aisle_meds', None, False, {}),
    'sign_club': ('sign_club', None, False, {}),
    'sign_station': ('sign_station', None, False, {}),
    'sign_newbark': ('sign_newbark', None, False, {}),
    'sign_route29': ('sign_route29', None, False, {}),
    'sign_park': ('sign_park', None, False, {}),
    'sign_pond': ('sign_pond', None, False, {}),
    'roof_orange': (None, None, False, {'color': (0.86, 0.42, 0.16)}),
    'stripe_awning': ('awning', 1.2, False, {}),
    'water_fountain': (None, None, False, {'color': (0.35, 0.65, 0.9), 'spec': 1, 'emit': 0.3, 'emit_color': (0.5, 0.8, 1.0)}),
}


def tex_path(base, kind):
    p = os.path.join(TEX, f'{base}_{kind}.png')
    return p if os.path.exists(p) else None


def load_image(path, non_color):
    name = os.path.basename(path)
    img = bpy.data.images.get(name)
    if img is None:
        img = bpy.data.images.load(path)
        img.name = name
    if non_color:
        img.colorspace_settings.name = 'Non-Color'
    return img


def get_mat(name):
    m = bpy.data.materials.get(name)
    if m:
        return m
    texbase, _, two_sided, extra = MATDEF[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.use_backface_culling = not two_sided
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    out.location = (400, 0)
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.location = (100, 0)
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    if texbase:
        a = tex_path(texbase, 'albedo')
        if a:
            t = nt.nodes.new('ShaderNodeTexImage')
            t.image = load_image(a, False)
            t.location = (-400, 200)
            nt.links.new(t.outputs['Color'], bsdf.inputs['Base Color'])
        r = tex_path(texbase, 'rough')
        if r:
            t = nt.nodes.new('ShaderNodeTexImage')
            t.image = load_image(r, True)
            t.location = (-400, -100)
            nt.links.new(t.outputs['Color'], bsdf.inputs['Roughness'])
        n = tex_path(texbase, 'normal')
        if n:
            t = nt.nodes.new('ShaderNodeTexImage')
            t.image = load_image(n, True)
            t.location = (-600, -400)
            nm = nt.nodes.new('ShaderNodeNormalMap')
            nm.location = (-200, -400)
            nt.links.new(t.outputs['Color'], nm.inputs['Color'])
            nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    if 'color' in extra:
        bsdf.inputs['Base Color'].default_value = (*extra['color'], 1)
        bsdf.inputs['Roughness'].default_value = 0.55
    if 'metal' in extra:
        bsdf.inputs['Metallic'].default_value = extra['metal']
    if 'spec' in extra:
        bsdf.inputs['Roughness'].default_value = 0.06
    if 'emit' in extra:
        bsdf.inputs['Emission Color'].default_value = (*extra.get('emit_color', (1.0, 0.92, 0.7)), 1)
        bsdf.inputs['Emission Strength'].default_value = extra['emit']
    if 'sss' in extra:
        # Soft light transmission for foliage in the preview renders.
        bsdf.inputs['Subsurface Weight'].default_value = extra['sss']
        bsdf.inputs['Subsurface Radius'].default_value = (0.3, 0.6, 0.15)
    return m


def tex_scale(mat):
    s = MATDEF[mat][1]
    return s if s else 1.0


class MB:
    """Accumulates geometry with per-face material names into one bmesh."""

    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []
        self.uvmode = {}  # face index -> ('fit', (u0, v0, u1, v1)) for decals

    def mi(self, mat):
        if mat not in self.mats:
            self.mats.append(mat)
        return self.mats.index(mat)

    def face(self, mat, pts, fit=None):
        lay = self._fit_layer() if fit else None  # create the layer before the face: adding layers invalidates faces
        vs = [self.bm.verts.new(Vector(p)) for p in pts]
        f = self.bm.faces.new(vs)
        f.material_index = self.mi(mat)
        if lay is not None:
            f[lay] = 1
        return f

    def _fit_layer(self):
        lay = self.bm.faces.layers.int.get('fit')
        return lay or self.bm.faces.layers.int.new('fit')

    def box(self, mat, c, s, rz=0.0, m=None):
        """Axis box centred at c with full size s, rotated rz around Z (or by matrix m)."""
        hx, hy, hz = s[0] / 2, s[1] / 2, s[2] / 2
        mat4 = m if m is not None else Matrix.Translation(Vector(c)) @ Matrix.Rotation(rz, 4, 'Z')
        corners = [Vector((x, y, z)) for z in (-hz, hz) for y in (-hy, hy) for x in (-hx, hx)]
        vs = [self.bm.verts.new(mat4 @ p) for p in corners]
        idx = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
        flip = mat4.to_3x3().determinant() < 0
        mi = self.mi(mat)
        for f in idx:
            face = self.bm.faces.new([vs[i] for i in (reversed(f) if flip else f)])
            face.material_index = mi
        return vs

    def prism(self, mat, pts2d, z0, z1, m=None, cap=True):
        """Extrude a CCW 2D polygon (in XY) from z0 to z1."""
        m = m or Matrix()
        if m.to_3x3().determinant() < 0:
            pts2d = list(reversed(pts2d))
        bot = [self.bm.verts.new(m @ Vector((x, y, z0))) for x, y in pts2d]
        top = [self.bm.verts.new(m @ Vector((x, y, z1))) for x, y in pts2d]
        mi = self.mi(mat)
        n = len(pts2d)
        for i in range(n):
            j = (i + 1) % n
            f = self.bm.faces.new([bot[i], bot[j], top[j], top[i]])
            f.material_index = mi
        if cap:
            f = self.bm.faces.new(list(reversed(bot)))
            f.material_index = mi
            f = self.bm.faces.new(top)
            f.material_index = mi

    def cyl(self, mat, c, r, h, seg=16, r2=None, m=None, cap=True):
        r2 = r if r2 is None else r2
        m = m or Matrix.Translation(Vector(c))
        angs = [i / seg * math.tau for i in range(seg)]
        if m.to_3x3().determinant() < 0:
            angs = list(reversed(angs))
        bot = [self.bm.verts.new(m @ Vector((math.cos(a) * r, math.sin(a) * r, 0))) for a in angs]
        top = [self.bm.verts.new(m @ Vector((math.cos(a) * r2, math.sin(a) * r2, h))) for a in angs]
        mi = self.mi(mat)
        for i in range(seg):
            j = (i + 1) % seg
            f = self.bm.faces.new([bot[i], bot[j], top[j], top[i]])
            f.material_index = mi
        if cap:
            f = self.bm.faces.new(list(reversed(bot)))
            f.material_index = mi
            if r2 > 0.001:
                f = self.bm.faces.new(top)
                f.material_index = mi

    def sphere(self, mat, c, r, subdiv=2, scale=(1, 1, 1), displace=0.0, seed=0, freq=1.5):
        res = bmesh.ops.create_icosphere(self.bm, subdivisions=subdiv, radius=r)
        mi = self.mi(mat)
        vs = res['verts']
        for v in vs:
            p = v.co.copy()
            if displace:
                n = p.normalized()
                d = noise.fractal((p + Vector((seed * 7.3, seed * 1.9, seed * 3.1))) * freq / r, 0.5, 2.0, 3)
                p = p + n * d * displace * r
            v.co = Vector((p.x * scale[0], p.y * scale[1], p.z * scale[2])) + Vector(c)
        for f in {f for v in vs for f in v.link_faces}:
            f.material_index = mi
        return vs

    def build(self, name, bevel=0.0, bevel_segments=2, smooth_angle=40.0, flat_mats=()):
        bm = self.bm
        bm.normal_update()
        uv = bm.loops.layers.uv.new('UVMap')
        fit = bm.faces.layers.int.get('fit')
        for f in bm.faces:
            mat = self.mats[f.material_index]
            if fit is not None and f[fit]:
                # Decal faces (signs): stretch the whole texture over the face.
                n = f.normal
                ua = Vector((0, 0, 1)).cross(n)
                if ua.length < 1e-4:
                    ua = Vector((1, 0, 0))
                ua.normalize()
                va = n.cross(ua)
                if va.z < 0:
                    va = -va
                us = [l.vert.co.dot(ua) for l in f.loops]
                vv = [l.vert.co.dot(va) for l in f.loops]
                for l in f.loops:
                    l[uv].uv = ((l.vert.co.dot(ua) - min(us)) / max(1e-6, max(us) - min(us)), (l.vert.co.dot(va) - min(vv)) / max(1e-6, max(vv) - min(vv)))
                continue
            s = tex_scale(mat)
            n = f.normal
            if abs(n.z) > 0.999:
                ua, va = Vector((1, 0, 0)), Vector((0, 1, 0))
            else:
                ua = Vector((0, 0, 1)).cross(n).normalized()
                va = n.cross(ua)
                if va.z < 0:
                    va = -va
            for l in f.loops:
                p = l.vert.co
                l[uv].uv = (p.dot(ua) / s, p.dot(va) / s)
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        for mname in self.mats:
            me.materials.append(get_mat(mname))
        obj = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(obj)
        if bevel > 0:
            mod = obj.modifiers.new('bevel', 'BEVEL')
            mod.width = bevel
            mod.segments = bevel_segments
            mod.limit_method = 'ANGLE'
            mod.angle_limit = math.radians(30)
            mod.miter_outer = 'MITER_ARC'
            dg = bpy.context.evaluated_depsgraph_get()
            ev = obj.evaluated_get(dg)
            me2 = bpy.data.meshes.new_from_object(ev)
            obj.modifiers.clear()
            old = obj.data
            obj.data = me2
            bpy.data.meshes.remove(old)
            me2.name = name
        smooth(obj.data, smooth_angle, flat_mats)
        return obj


def smooth(me, angle, flat_mats=()):
    bm = bmesh.new()
    bm.from_mesh(me)
    lim = math.radians(angle)
    flat_idx = {i for i, m in enumerate(me.materials) if m and m.name in flat_mats}
    for f in bm.faces:
        f.smooth = f.material_index not in flat_idx
    for e in bm.edges:
        if len(e.link_faces) == 2:
            a = e.link_faces[0].normal.angle(e.link_faces[1].normal, 0)
            if a > lim or e.link_faces[0].material_index != e.link_faces[1].material_index:
                e.smooth = False
    bm.to_mesh(me)
    bm.free()


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.node_groups, bpy.data.collections, bpy.data.lights, bpy.data.cameras):
        for x in list(coll):
            try:
                coll.remove(x)
            except Exception:
                pass


def instance(src, name, loc, rz=0.0, scale=1.0, coll=None):
    o = bpy.data.objects.new(name, src.data)
    o.location = loc
    o.rotation_euler = (0, 0, rz)
    o.scale = (scale, scale, scale) if isinstance(scale, (int, float)) else scale
    (coll or bpy.context.scene.collection).objects.link(o)
    return o
