import bpy

output_path = r"C:\Users\Willp\Documents\GitHub\Wabi\exports\auto save thankgod2_character_materials.glb"

obj_terms = [
    'body','shirt','skirt','dress','cloth','clothing','pants','jean','jacket','coat','hoodie',
    'hair','shoe','boot','sock','glove','belt','accessory','ear','ring','necklace','bracelet','bag','hat','cap'
]
mat_terms = [
    'body','skin','face','mouth','teeth','tongue','shirt','skirt','dress','cloth','fabric','hair',
    'shoe','boot','sock','glove','belt','ear','ring','accessory'
]


def has_term(name, terms):
    n = (name or '').lower()
    return any(t in n for t in terms)

kept = []
stripped = []

for obj in bpy.data.objects:
    if obj.type != 'MESH':
        continue

    mats = [m.name for m in obj.data.materials if m]
    has_armature = any(mod.type == 'ARMATURE' for mod in obj.modifiers)

    keep = (
        has_armature
        or has_term(obj.name, obj_terms)
        or any(has_term(m, mat_terms) for m in mats)
    )

    if keep:
        kept.append((obj.name, mats, has_armature))
    else:
        obj.data.materials.clear()
        stripped.append(obj.name)

print('---KEEP MATERIALS ON---')
for name, mats, has_armature in kept:
    print(f"{name} | armature={has_armature} | mats={mats}")
print('---STRIPPED MATERIALS FROM---')
for name in stripped:
    print(name)

# Attempt export with originals preference (helps avoid temp re-encode in many cases)
result = bpy.ops.export_scene.gltf(
    filepath=output_path,
    export_format='GLB',
    export_apply=True,
    export_materials='EXPORT',
    export_keep_originals=True
)
print('EXPORT_RESULT', result)
print('EXPORT_PATH', output_path)
