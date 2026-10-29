"""Turns an AI-generated mannequin GLB (one mesh, skin/shirt/pants materials) into a
web-ready mannequin: separate Body / Shirt / Pants meshes, real-world height, facing
the front, decimated, with only the normal and ORM maps kept (the gallery supplies the
marble, garment colour and artwork).

  blender -b --factory-startup --python process_ai_model.py -- in.glb out.glb preview.png
"""
import math
import sys

import bpy
import bmesh
from mathutils import Matrix, Vector

src, out, preview = sys.argv[sys.argv.index("--") + 1:][:3]
HEIGHT = 1.85
TARGET = {"Body": 70000, "Shirt": 22000, "Pants": 16000}
TEX_SIZE = 2048

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()
bpy.ops.import_scene.gltf(filepath=src)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
for o in bpy.data.objects:
    if o.type != "MESH":
        bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.object.select_all(action="DESELECT")
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.join()
obj = bpy.context.view_layer.objects.active
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# ---------- scale to height, feet on the ground ----------
me = obj.data
zs = [v.co.z for v in me.vertices]
s = HEIGHT / (max(zs) - min(zs))
obj.scale = (s, s, s)
bpy.ops.object.transform_apply(scale=True)

# ---------- face the front (-Y in Blender = +Z in glTF) ----------
# The shoulders are the widest horizontal span; the toes point forward.
# The feet point where the figure faces: the sole reaches well ahead of the ankles.
co = [v.co.copy() for v in me.vertices]
zmin = min(c.z for c in co)
sole = [c for c in co if c.z < zmin + 0.03]
ankle = [c for c in co if zmin + 0.08 < c.z < zmin + 0.12]
sx = sum(c.x for c in sole) / len(sole)
sy = sum(c.y for c in sole) / len(sole)
ax = sum(c.x for c in ankle) / len(ankle)
ay = sum(c.y for c in ankle) / len(ankle)
facing = math.atan2(sy - ay, sx - ax)
# rotate so the facing direction becomes -Y (glTF +Z)
angle = -math.pi / 2 - facing
me.transform(Matrix.Rotation(angle, 4, "Z"))
me.update()
print(f"[orient] toes ({sx - ax:.3f},{sy - ay:.3f}) facing={math.degrees(facing):.0f} rot={math.degrees(angle):.0f}")

co = [v.co for v in me.vertices]
cx = (max(c.x for c in co) + min(c.x for c in co)) / 2
cy = sum(c.y for c in co) / len(co)
zmin = min(c.z for c in co)
for v in me.vertices:
    v.co -= Vector((cx, cy, zmin))

# ---------- split by material ----------
def part_name(mat):
    n = mat.name.lower()
    return "Shirt" if "shirt" in n else "Pants" if ("pant" in n or "jogger" in n) else "Body"


bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.separate(type="MATERIAL")
bpy.ops.object.mode_set(mode="OBJECT")

parts = {}
for o in [o for o in bpy.data.objects if o.type == "MESH"]:
    if not o.data.polygons:
        bpy.data.objects.remove(o, do_unlink=True)
        continue
    mat = o.data.materials[o.data.polygons[0].material_index]
    name = part_name(mat)
    o.data.materials.clear()
    o.data.materials.append(mat)
    for p in o.data.polygons:
        p.material_index = 0
    parts[name] = o
for name, o in parts.items():
    o.name = o.data.name = name
print("[parts]", {k: len(v.data.polygons) for k, v in parts.items()})

# glTF duplicates vertices along UV seams; weld them (UVs stay per-corner in Blender) so
# decimation and the cloth lift below can't open cracks along the seams
for o in parts.values():
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0005)
    bm.to_mesh(o.data)
    bm.free()

def reclaim_trim(body, cloth, dist=0.005):
    """Moves "skin" faces lying on the cloth's surface (a white collar or sleeve trim the
    generator labelled as skin) into the cloth, so they take the garment colour."""
    from mathutils.bvhtree import BVHTree
    from mathutils.kdtree import KDTree

    cbm = bmesh.new()
    cbm.from_mesh(cloth.data)
    cbm.normal_update()
    tree = BVHTree.FromBMesh(cbm)
    rim = [v.co.copy() for v in cbm.verts if v.is_boundary]
    cbm.free()
    kd = KDTree(len(rim))
    for i, co in enumerate(rim):
        kd.insert(co, i)
    kd.balance()
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bm.normal_update()
    picked = 0
    for f in bm.faces:
        c = f.calc_center_median()
        f.select = False
        # trim sits at the garment's open edges, flush with it and facing the same way;
        # an arm or hand merely resting against the cloth doesn't qualify
        if kd.find(c)[2] > 0.025:
            continue
        hit = tree.find_nearest(c, dist)
        if hit[0] is None or f.normal.dot(hit[1]) < 0.6:
            continue
        f.select = True
        picked += 1
    bm.to_mesh(body.data)
    bm.free()
    if not picked:
        return
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.separate(type="SELECTED")
    bpy.ops.object.mode_set(mode="OBJECT")
    trim = next(o for o in bpy.context.selected_objects if o is not body)
    trim.data.materials.clear()
    bpy.ops.object.select_all(action="DESELECT")
    trim.select_set(True)
    cloth.select_set(True)
    bpy.context.view_layer.objects.active = cloth
    bpy.ops.object.join()
    print(f"[trim] {picked} faces moved from skin to {cloth.name}")


# Disabled: on this model the trim test also caught arm and neck skin resting against
# the cloth, and the extra faces threw off the chest measurement for the print.
# reclaim_trim(parts["Body"], parts["Shirt"])
# reclaim_trim(parts["Body"], parts["Pants"])
for o in parts.values():
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0005)
    bm.to_mesh(o.data)
    bm.free()

# ---------- decimate ----------
for name, o in parts.items():
    tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
    ratio = min(1.0, TARGET[name] / max(tris, 1))
    bpy.context.view_layer.objects.active = o
    dec = o.modifiers.new("dec", "DECIMATE")
    dec.ratio = ratio
    dec.use_collapse_triangulate = True
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.ops.object.modifier_apply(modifier=dec.name)
    after = sum(len(p.vertices) - 2 for p in o.data.polygons)
    print(f"[decimate] {name}: {tris} -> {after}")

    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if name in ("Shirt", "Pants"):
        # even out the lumpy, dented surface decimation leaves on the cloth, keeping the
        # big folds; the open hems are smoothed along their own line so they run straight
        inner = [v for v in bm.verts if not v.is_boundary]
        rim = [v for v in bm.verts if v.is_boundary]
        for _ in range(4):
            bmesh.ops.smooth_vert(bm, verts=inner, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
        for _ in range(6):
            bmesh.ops.smooth_vert(bm, verts=rim, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.to_mesh(o.data)
    bm.free()
    o.data.update()
    bpy.ops.object.shade_smooth()
    if name in ("Shirt", "Pants"):
        disp = o.modifiers.new("lift", "DISPLACE")
        disp.mid_level, disp.strength = 0.0, 0.006
        bpy.ops.object.modifier_apply(modifier=disp.name)


def tuck_skin_under(body, cloth, reach=0.02, depth=0.008):
    """Pushes skin that pokes through (or sits just outside) the cloth back underneath it.

    Only skin facing the same way as the cloth counts as "under" it: an arm hanging
    beside the shirt faces the shirt, and must not be pulled onto it.
    """
    from mathutils.bvhtree import BVHTree
    from mathutils.kdtree import KDTree

    bm = bmesh.new()
    bm.from_mesh(cloth.data)
    bm.normal_update()
    tree = BVHTree.FromBMesh(bm)
    rim = [v.co.copy() for v in bm.verts if v.is_boundary]
    kd = KDTree(len(rim))
    for i, co in enumerate(rim):
        kd.insert(co, i)
    kd.balance()
    hem_zone = 0.03
    moved = 0
    for v in body.data.vertices:
        # Near an open hem the nearest cloth point is the edge itself, which says
        # nothing about inside/outside; instead sink the skin a little along its own
        # normal so it sits back under the hem (fading out away from it).
        _, _, d_rim = kd.find(v.co)
        if d_rim < hem_zone:
            v.co -= v.normal * 0.007 * (1 - d_rim / hem_zone)
            moved += 1
            continue
        hit = tree.find_nearest(v.co, reach)
        if hit[0] is None:
            continue
        loc, normal = hit[0], hit[1]
        if v.normal.dot(normal) < 0.5:
            continue
        if (v.co - loc).dot(normal) > -depth:
            v.co = loc - normal * depth
            moved += 1
    bm.free()
    body.data.update()
    print(f"[tuck] {cloth.name}: {moved} skin vertices moved under the cloth")


tuck_skin_under(parts["Body"], parts["Shirt"])
tuck_skin_under(parts["Body"], parts["Pants"])

# ---------- textures: keep normal + ORM only, shrink ----------
for o in parts.values():
    mat = o.data.materials[0]
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    for link in list(bsdf.inputs["Base Color"].links):
        nt.links.remove(link)
    bsdf.inputs["Base Color"].default_value = (0.9, 0.9, 0.9, 1)
for img in bpy.data.images:
    if img.size[0] > TEX_SIZE:
        img.scale(TEX_SIZE, TEX_SIZE)
        img.pack()

# ---------- export ----------
bpy.ops.object.select_all(action="DESELECT")
for o in parts.values():
    o.select_set(True)
bpy.ops.export_scene.gltf(
    filepath=out,
    export_format="GLB",
    use_selection=True,
    export_apply=True,
    export_yup=True,
    export_animations=False,
    export_image_format="WEBP",
    export_materials="EXPORT",
)
print("[export]", out)

# ---------- preview ----------
scene = bpy.context.scene
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "MATERIAL"
scene.render.resolution_x, scene.render.resolution_y = 1200, 800
for o in parts.values():
    o.data.materials[0].diffuse_color = {
        "Body": (0.92, 0.9, 0.88, 1), "Shirt": (0.15, 0.2, 0.45, 1), "Pants": (0.1, 0.1, 0.12, 1)
    }[o.name]
for i, (label, ang) in enumerate((("front", 0), ("side", 90), ("back", 180))):
    cam_data = bpy.data.cameras.new(label)
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = 2.0
    cam = bpy.data.objects.new(label, cam_data)
    bpy.context.collection.objects.link(cam)
    a = math.radians(ang)
    cam.location = (5 * math.sin(a), -5 * math.cos(a), HEIGHT / 2)
    cam.rotation_euler = (math.radians(90), 0, a)
    scene.camera = cam
    scene.render.filepath = preview.replace(".png", f"-{label}.png")
    bpy.ops.render.render(write_still=True)
