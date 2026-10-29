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
TARGET = {"Body": 36000, "Shirt": 9000, "Pants": 9000}
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
    bpy.ops.object.shade_smooth()
    if name in ("Shirt", "Pants"):
        # decimation lets the skin poke through at hems; lift the cloth off it a little
        disp = o.modifiers.new("lift", "DISPLACE")
        disp.mid_level, disp.strength = 0.0, 0.012 if name == "Shirt" else 0.006
        bpy.ops.object.modifier_apply(modifier=disp.name)

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
