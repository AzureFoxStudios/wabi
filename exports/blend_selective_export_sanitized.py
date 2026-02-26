import bpy

output_path = r"C:\Users\Willp\Documents\GitHub\Wabi\exports\auto save thankgod2_character_materials_SANITIZED.glb"

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


def sanitize_emission(mat):
    if not mat or not mat.use_nodes or not mat.node_tree:
        return
    nt = mat.node_tree
    removed = 0
    for node in nt.nodes:
        if node.type != 'BSDF_PRINCIPLED':
            continue
        for socket_name in ('Emission Color', 'Emission Strength'):
            if socket_name not in node.inputs:
                continue
            sock = node.inputs[socket_name]
            while sock.links:
                nt.links.remove(sock.links[0])
                removed += 1
            try:
                if socket_name == 'Emission Color':
                    sock.default_value = (0.0, 0.0, 0.0, 1.0)
                else:
                    sock.default_value = 0.0
            except Exception:
                pass
    return removed

kept = []
stripped = []
kept_materials = set()

for obj in bpy.data.objects:
    if obj.type != 'MESH':
        continue

    mats = [m for m in obj.data.materials if m]
    mat_names = [m.name for m in mats]
    has_armature = any(mod.type == 'ARMATURE' for mod in obj.modifiers)

    keep = (
        has_armature
        or has_term(obj.name, obj_terms)
        or any(has_term(name, mat_terms) for name in mat_names)
    )

    if keep:
        kept.append((obj.name, mat_names, has_armature))
        for m in mats:
            kept_materials.add(m)
    else:
        obj.data.materials.clear()
        stripped.append(obj.name)

print('---KEEP MATERIALS ON---')
for name, mats, has_armature in kept:
    print(f"{name} | armature={has_armature} | mats={mats}")
print('---STRIPPED MATERIALS FROM---')
for name in stripped:
    print(name)

print('---SANITIZE EMISSION LINKS---')
for mat in sorted(kept_materials, key=lambda m: m.name.lower()):
    removed = sanitize_emission(mat) or 0
    print(f"{mat.name} | removed_emission_links={removed}")

result = bpy.ops.export_scene.gltf(
    filepath=output_path,
    export_format='GLB',
    export_apply=True,
    export_materials='EXPORT',
    export_keep_originals=True
)
print('EXPORT_RESULT', result)
print('EXPORT_PATH', output_path)
