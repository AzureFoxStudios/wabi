import bpy

output_path = r"C:\Users\Willp\Documents\GitHub\Wabi\exports\auto save thankgod2_character_materials_PATCHED.glb"

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


def coerce_int_like(value):
    if isinstance(value, bool):
        raise ValueError('bool is not a valid int index')
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        s = ''.join(ch for ch in value if ch.isdigit() or ch == '-')
        if s and s != '-':
            return int(s)
    if isinstance(value, (list, tuple)) and len(value) > 0:
        return coerce_int_like(value[0])
    if hasattr(value, 'index'):
        return coerce_int_like(getattr(value, 'index'))
    raise ValueError(f'cannot coerce {type(value).__name__} to int')


# Selective material retention
kept = []
stripped = []
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
    else:
        obj.data.materials.clear()
        stripped.append(obj.name)

print('---KEEP MATERIALS ON---')
for name, mats, has_armature in kept:
    print(f"{name} | armature={has_armature} | mats={mats}")
print('---STRIPPED MATERIALS FROM---')
for name in stripped:
    print(name)

# Runtime patch for Blender glTF serializer bug on emissiveTexture index type
from io_scene_gltf2.io.com import gltf2_io

orig_material_to_dict = gltf2_io.Material.to_dict


def safe_material_to_dict(self):
    et = getattr(self, 'emissive_texture', None)
    if et is not None:
        raw_index = getattr(et, 'index', None)
        try:
            et.index = coerce_int_like(raw_index)
        except Exception:
            print(f"PATCH: dropping invalid emissiveTexture index={raw_index!r} on material {getattr(self, 'name', '<unnamed>')}")
            self.emissive_texture = None
    return orig_material_to_dict(self)


gltf2_io.Material.to_dict = safe_material_to_dict

result = bpy.ops.export_scene.gltf(
    filepath=output_path,
    export_format='GLB',
    export_apply=True,
    export_materials='EXPORT',
    export_keep_originals=True
)
print('EXPORT_RESULT', result)
print('EXPORT_PATH', output_path)
