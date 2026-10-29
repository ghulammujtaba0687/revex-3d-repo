"""Builds a display mannequin (body + tee + trousers) with MPFB2 and exports a web GLB.

Run with Blender in background mode:
  blender -b --factory-startup --python build_mannequin.py -- \
      --gender male --shirt <tee.mhclo> --pants <pants.mhclo> --out male.glb --preview male.png

Assets: MPFB2 base mesh and the MakeHuman "Shirts 01" / "Pants 01" packs, all CC0.
The exported meshes are named Body, Shirt and Pants so the web app can find them.
"""
import argparse
import math
import sys

import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--gender", choices=["male", "female"], required=True)
ap.add_argument("--shirt", required=True)
ap.add_argument("--pants", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--preview", default="")
ap.add_argument("--pose", default="relaxed")
ap.add_argument("--hair", default="", help="optional hair .mhclo")
ap.add_argument("--debug-stage", default="", help="render a preview at 'rest' or 'posed' and stop")
args = ap.parse_args(argv)


def debug_render(path):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.color_type = "OBJECT"
    scene.render.resolution_x, scene.render.resolution_y = 700, 700
    cam_data = bpy.data.cameras.new("dbg")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = 2.6
    cam = bpy.data.objects.new("dbg", cam_data)
    bpy.context.collection.objects.link(cam)
    cam.location = (0, -6, 1.0)
    cam.rotation_euler = (math.radians(90), 0, 0)
    scene.camera = cam
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print("[debug]", path)

bpy.ops.preferences.addon_enable(module="bl_ext.user_default.mpfb")
from bl_ext.user_default.mpfb.services.humanservice import HumanService  # noqa: E402
from bl_ext.user_default.mpfb.services.targetservice import TargetService  # noqa: E402

# start from an empty scene
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()

macro = TargetService.get_default_macro_info_dict()
if args.gender == "male":
    macro.update(gender=1.0, age=0.5, muscle=0.62, weight=0.48, height=0.62, proportions=0.7)
else:
    macro.update(gender=0.0, age=0.5, muscle=0.5, weight=0.45, height=0.55, proportions=0.7,
                 cupsize=0.45, firmness=0.6)

# detailed helpers carry the joint-* vertex groups the rig uses to place its bones
basemesh = HumanService.create_human(mask_helpers=True, detailed_helpers=True,
                                     extra_vertex_groups=True, feet_on_ground=True,
                                     scale=0.1, macro_detail_dict=macro)
rig = HumanService.add_builtin_rig(basemesh, "default", import_weights=True)
shirt = HumanService.add_mhclo_asset(args.shirt, basemesh, asset_type="Clothes", subdiv_levels=0)
pants = HumanService.add_mhclo_asset(args.pants, basemesh, asset_type="Clothes", subdiv_levels=0)
hair = (HumanService.add_mhclo_asset(args.hair, basemesh, asset_type="Hair", subdiv_levels=0)
        if args.hair else None)

if args.debug_stage == "rest":
    debug_render(args.out.replace(".glb", "-rest.png"))
    sys.exit(0)

# ---------------------------------------------------------------- pose
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode="POSE")
to_arm = rig.matrix_world.inverted().to_3x3()


def aim_bone(name, world_dir):
    """Rotates a pose bone about its head so it points along world_dir (children follow)."""
    pb = rig.pose.bones[name]
    bpy.context.view_layer.update()
    head = pb.head.copy()
    current = (pb.tail - pb.head).normalized()
    target = (to_arm @ Vector(world_dir)).normalized()
    rot = current.rotation_difference(target).to_matrix().to_4x4()
    pb.matrix = Matrix.Translation(head) @ rot @ Matrix.Translation(-head) @ pb.matrix
    bpy.context.view_layer.update()


def rot_bone(name, axis, degrees):
    """Rotates a pose bone about its head around a world axis (children follow)."""
    pb = rig.pose.bones[name]
    bpy.context.view_layer.update()
    head = pb.head.copy()
    rot = Matrix.Rotation(math.radians(degrees), 4, (to_arm @ Vector(axis)).normalized())
    pb.matrix = Matrix.Translation(head) @ rot @ Matrix.Translation(-head) @ pb.matrix
    bpy.context.view_layer.update()


def down(side, out_deg, fwd_deg=0.0):
    a, f = math.radians(out_deg), math.radians(fwd_deg)
    return (side * math.sin(a), -math.sin(f), -math.cos(a) * math.cos(f))


# MakeHuman faces -Y; the character's left (.L) is +X.
# Bring the A-pose legs in to a natural stance for every pose.
leg_out = 3.5 if args.gender == "male" else 1.2
for side, s in (("L", 1), ("R", -1)):
    aim_bone(f"upperleg01.{side}", down(s, leg_out, 0))
    aim_bone(f"lowerleg01.{side}", down(s, 1.5, 0))

if args.pose == "relaxed":
    for side, s in (("L", 1), ("R", -1)):
        aim_bone(f"upperarm01.{side}", down(s, 9, 4))
        aim_bone(f"lowerarm01.{side}", down(s, 5, 14))
elif args.pose == "hand_on_hip":
    # elbow out to the side, hand resting on the front of the hip (MakeHuman faces -Y)
    aim_bone("upperarm01.L", down(1, 38, 10))
    aim_bone("lowerarm01.L", (-0.6, -0.32, -0.73))
    aim_bone("upperarm01.R", down(-1, 9, 4))
    aim_bone("lowerarm01.R", down(-1, 5, 14))
    rot_bone("spine01", (0, 1, 0), -3)
elif args.pose == "pocket":
    # right hand slid into the front pocket, weight off the left leg, head turned
    aim_bone("upperarm01.R", down(-1, 13, -4))
    aim_bone("lowerarm01.R", (0.32, -0.42, -0.85))
    aim_bone("upperarm01.L", down(1, 9, 4))
    aim_bone("lowerarm01.L", down(1, 5, 14))
    aim_bone("upperleg01.L", down(1, leg_out, 7))
    aim_bone("lowerleg01.L", down(1, 1.5, -7))
    rot_bone("neck01", (0, 0, 1), 14)

bpy.ops.object.mode_set(mode="OBJECT")
if args.debug_stage == "posed":
    debug_render(args.out.replace(".glb", "-posed.png"))
    sys.exit(0)

# ---------------------------------------------------------------- bake to static meshes


def apply_all_modifiers(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    # bake the MPFB morph targets first; modifiers can't be applied over shape keys
    if obj.data.shape_keys:
        bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
    for mod in list(obj.modifiers):
        try:
            bpy.ops.object.modifier_apply(modifier=mod.name)
        except RuntimeError as err:  # e.g. a disabled modifier
            print("could not apply", obj.name, mod.name, err)
            obj.modifiers.remove(mod)


parts = [o for o in (basemesh, shirt, pants, hair) if o]
for obj in parts:
    obj.parent = None
    apply_all_modifiers(obj)


def loosen(obj, offset, smooth_factor, repeat):
    """Smooths away body detail showing through the cloth, then pushes it out along normals."""
    bpy.context.view_layer.objects.active = obj
    sm = obj.modifiers.new("smooth", "SMOOTH")
    sm.factor, sm.iterations = smooth_factor, repeat
    disp = obj.modifiers.new("loose", "DISPLACE")
    disp.mid_level, disp.strength = 0.0, offset
    apply_all_modifiers(obj)


# drop-shoulder tees sit loose; baggy trousers shouldn't cling at the crotch
loosen(shirt, 0.014, 0.6, 4)
loosen(pants, 0.008, 0.8, 10)

# drop the rig and anything else MPFB added
keep = set(parts)
for obj in list(bpy.data.objects):
    if obj not in keep:
        bpy.data.objects.remove(obj, do_unlink=True)

# remove any remaining helper geometry (vertex groups named helper-*/joint-*)
bpy.context.view_layer.objects.active = basemesh
groups = [g.index for g in basemesh.vertex_groups if g.name.startswith(("helper-", "joint-"))]
if groups:
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="DESELECT")
    bpy.ops.object.mode_set(mode="OBJECT")
    for v in basemesh.data.vertices:
        if any(g.group in groups for g in v.groups):
            v.select = True
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.delete(type="VERT")
    bpy.ops.object.mode_set(mode="OBJECT")

basemesh.name = basemesh.data.name = "Body"
shirt.name = shirt.data.name = "Shirt"
pants.name = pants.data.name = "Pants"
if hair:
    hair.name = hair.data.name = "Hair"

# simple named materials; the web app replaces them at runtime


def flat_material(name, rgba, rough):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Roughness"].default_value = rough
    return mat


def hair_material(mhclo_path):
    """Hair cards: the strand texture's alpha cuts out the strands (glTF alphaMode MASK)."""
    import glob
    import os
    folder = os.path.dirname(mhclo_path)
    png = (glob.glob(os.path.join(folder, "*diffuse*.png")) or glob.glob(os.path.join(folder, "*.png")))[0]
    mat = bpy.data.materials.new("Hair")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(png)
    # 512px is plenty for a figure seen from a few metres, and keeps the GLB small
    if tex.image.size[0] > 512:
        tex.image.scale(512, 512)
        tex.image.pack()
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
    bsdf.inputs["Roughness"].default_value = 0.6
    mat.blend_method = "CLIP"
    mat.alpha_threshold = 0.5
    return mat


materials = [
    (basemesh, flat_material("Marble", (0.93, 0.92, 0.9, 1), 0.35)),
    (shirt, flat_material("Shirt", (0.85, 0.85, 0.85, 1), 0.8)),
    (pants, flat_material("Pants", (0.08, 0.08, 0.09, 1), 0.8)),
]
if hair:
    materials.append((hair, hair_material(args.hair)))
for obj, mat in materials:
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    obj.vertex_groups.clear()
    # keep only the first UV map
    while len(obj.data.uv_layers) > 1:
        obj.data.uv_layers.remove(obj.data.uv_layers[-1])
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.ops.object.shade_smooth()

for obj in keep:
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    print(f"[stats] {obj.name}: {len(obj.data.vertices)} verts, {tris} tris")
dims = basemesh.dimensions
print(f"[stats] body size: {dims.x:.2f} x {dims.y:.2f} x {dims.z:.2f} m")

# ---------------------------------------------------------------- export
bpy.ops.object.select_all(action="DESELECT")
for obj in keep:
    obj.select_set(True)
bpy.ops.export_scene.gltf(
    filepath=args.out,
    export_format="GLB",
    use_selection=True,
    export_apply=True,
    export_yup=True,
    export_animations=False,
    export_skins=False,
    export_morph=False,
    export_materials="EXPORT",
)
print("[export]", args.out)

if args.preview:
    # the shirt's UV layout, used as the print template
    bpy.ops.object.select_all(action="DESELECT")
    shirt.select_set(True)
    bpy.context.view_layer.objects.active = shirt
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    # SVG needs no GPU, unlike PNG, so it works in background mode
    uv_path = args.preview.replace(".png", "-shirt-uv.svg")
    try:
        bpy.ops.uv.export_layout(filepath=uv_path, size=(1024, 1024), mode="SVG", export_all=True)
    except RuntimeError as err:
        print("[uv] export failed:", err)
    bpy.ops.object.mode_set(mode="OBJECT")
    print("[uv]", uv_path)

# ---------------------------------------------------------------- preview render
if args.preview:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "TEXTURE"
    scene.display.shading.show_shadows = True
    scene.render.resolution_x, scene.render.resolution_y = 900, 900
    scene.render.film_transparent = False
    cams = []
    for label, angle in (("front", 0), ("side", 90)):
        cam_data = bpy.data.cameras.new(label)
        cam_data.type = "ORTHO"
        cam_data.ortho_scale = 2.05
        cam = bpy.data.objects.new(label, cam_data)
        bpy.context.collection.objects.link(cam)
        a = math.radians(angle)
        cam.location = (5 * math.sin(a), -5 * math.cos(a), dims.z / 2)
        cam.rotation_euler = (math.radians(90), 0, a)
        scene.camera = cam
        scene.render.filepath = args.preview.replace(".png", f"-{label}.png")
        bpy.ops.render.render(write_still=True)
        print("[preview]", scene.render.filepath)
