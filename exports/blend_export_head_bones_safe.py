import bpy

out=r"C:\\Users\\Willp\\Documents\\GitHub\\Wabi\\exports\\auto save thankgod2_HEAD_BONES_SAFE.glb"

obj_terms=['body','shirt','skirt','dress','cloth','clothing','pants','jean','jacket','coat','hoodie','hair','shoe','boot','sock','glove','belt','accessory','ear','ring','necklace','bracelet','bag','hat','cap']
mat_terms=['body','skin','face','mouth','teeth','tongue','shirt','skirt','dress','cloth','fabric','hair','shoe','boot','sock','glove','belt','ear','ring','accessory']


def has_term(name, terms):
    n=(name or '').lower()
    return any(t in n for t in terms)

# Keep character materials; strip obvious scene planes/props only
for obj in bpy.data.objects:
    if obj.type!='MESH':
        continue
    mats=[m.name for m in obj.data.materials if m]
    has_arm=any(mod.type=='ARMATURE' for mod in obj.modifiers)
    keep=has_arm or has_term(obj.name,obj_terms) or any(has_term(x,mat_terms) for x in mats)
    if not keep:
        obj.data.materials.clear()

# Force face/body/hair mats to opaque-ish safety so head does not disappear
for m in bpy.data.materials:
    n=m.name.lower()
    if any(k in n for k in ['face','body','skin','hair']):
        try:
            m.blend_method='OPAQUE'
        except Exception:
            pass
        try:
            m.shadow_method='OPAQUE'
        except Exception:
            pass
        if m.use_nodes and m.node_tree:
            for node in m.node_tree.nodes:
                if node.type=='BSDF_PRINCIPLED':
                    alpha=node.inputs.get('Alpha')
                    if alpha:
                        while alpha.links:
                            m.node_tree.links.remove(alpha.links[0])
                        alpha.default_value=1.0

# Patch exporter crash on invalid emissiveTexture.index
from io_scene_gltf2.io.com import gltf2_io
orig=gltf2_io.Material.to_dict

def coerce(v):
    if isinstance(v,bool):
        raise ValueError
    if isinstance(v,int):
        return v
    if isinstance(v,float):
        return int(v)
    if isinstance(v,str):
        s=''.join(ch for ch in v if ch.isdigit() or ch=='-')
        if s and s!='-':
            return int(s)
    if isinstance(v,(list,tuple)) and v:
        return coerce(v[0])
    if hasattr(v,'index'):
        return coerce(getattr(v,'index'))
    raise ValueError

def safe_to_dict(self):
    et=getattr(self,'emissive_texture',None)
    if et is not None:
        try:
            et.index=coerce(getattr(et,'index',None))
        except Exception:
            self.emissive_texture=None
    return orig(self)

gltf2_io.Material.to_dict=safe_to_dict

res=bpy.ops.export_scene.gltf(
    filepath=out,
    export_format='GLB',
    export_apply=False,
    export_materials='EXPORT',
    export_keep_originals=True,
    export_skins=True,
    export_all_influences=True,
    export_animations=True,
    export_def_bones=False,
    export_force_sampling=True,
    export_rest_position_armature=True
)
print('EXPORT_RESULT', res)
print('EXPORT_PATH', out)
