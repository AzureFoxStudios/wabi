import os
import shutil
import tempfile
import uuid

import bpy

OUT_PATH = r"C:\Users\Willp\Documents\GitHub\Wabi\exports\auto save thankgod2_SKINFIX_SHOES.glb"
DOWNLOADS_COPY = r"C:\Users\Willp\Downloads\auto save thankgod2_SKINFIX_SHOES.glb"
USE_TEXTURE_INDEX_PATCH = False
USE_TEMP_IMAGE_ENCODER_PATCH = True


def get_output_node(mat):
    if not (mat and mat.use_nodes and mat.node_tree):
        return None
    for n in mat.node_tree.nodes:
        if n.type == 'OUTPUT_MATERIAL' and getattr(n, 'is_active_output', False):
            return n
    for n in mat.node_tree.nodes:
        if n.type == 'OUTPUT_MATERIAL':
            return n
    return None


def ensure_principled_pipeline(mat, image=None, fallback_color=(0.93, 0.76, 0.64, 1.0), use_existing_color_socket=False):
    if not (mat and mat.use_nodes and mat.node_tree):
        return

    nt = mat.node_tree
    out = get_output_node(mat)
    if out is None:
        out = nt.nodes.new('ShaderNodeOutputMaterial')

    existing_color_socket = None
    if out.inputs['Surface'].links:
        src = out.inputs['Surface'].links[0]
        if src.from_socket.type != 'SHADER':
            existing_color_socket = src.from_socket

    bsdf = nt.nodes.get('GLTF_Principled')
    if bsdf is None or bsdf.type != 'BSDF_PRINCIPLED':
        bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
        bsdf.name = 'GLTF_Principled'

    for l in list(out.inputs['Surface'].links):
        nt.links.remove(l)
    for l in list(bsdf.inputs['Base Color'].links):
        nt.links.remove(l)
    for l in list(bsdf.inputs['Alpha'].links):
        nt.links.remove(l)

    linked = False
    if image is not None:
        tex = nt.nodes.get('GLTF_BaseColor_Tex')
        if tex is None or tex.type != 'TEX_IMAGE':
            tex = nt.nodes.new('ShaderNodeTexImage')
            tex.name = 'GLTF_BaseColor_Tex'
        tex.image = image
        nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
        linked = True
    elif use_existing_color_socket and existing_color_socket is not None:
        nt.links.new(existing_color_socket, bsdf.inputs['Base Color'])
        linked = True

    if not linked:
        bsdf.inputs['Base Color'].default_value = fallback_color

    bsdf.inputs['Alpha'].default_value = 1.0
    bsdf.inputs['Roughness'].default_value = 0.6
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])

    try:
        mat.blend_method = 'OPAQUE'
    except Exception:
        pass
    try:
        mat.shadow_method = 'OPAQUE'
    except Exception:
        pass
    try:
        mat.use_backface_culling = False
    except Exception:
        pass


def debug_basecolor_link(mat):
    if not (mat and mat.use_nodes and mat.node_tree):
        print(f'MAT_DEBUG {getattr(mat, "name", "<none>")} no nodes')
        return

    nt = mat.node_tree
    bsdf = nt.nodes.get('GLTF_Principled')
    if not bsdf:
        print(f'MAT_DEBUG {mat.name} no GLTF_Principled')
        return

    links = list(bsdf.inputs['Base Color'].links)
    if not links:
        print(f'MAT_DEBUG {mat.name} baseColor CONST {tuple(round(v, 4) for v in bsdf.inputs["Base Color"].default_value)}')
        return

    src = links[0]
    info = f'{src.from_node.name}:{src.from_socket.name}'
    if src.from_node.type == 'TEX_IMAGE' and getattr(src.from_node, 'image', None):
        img = src.from_node.image
        info += f' image={img.name} source={img.source} packed={bool(img.packed_file)}'
    print(f'MAT_DEBUG {mat.name} baseColor LINK {info}')


def apply_mirror_modifier(obj_name):
    obj = bpy.data.objects.get(obj_name)
    if obj is None or obj.type != 'MESH':
        print(f'SHOE_MIRROR_SKIP no mesh named {obj_name}')
        return

    mirror_mods = [m for m in obj.modifiers if m.type == 'MIRROR']
    if not mirror_mods:
        print(f'SHOE_MIRROR_SKIP no mirror modifier on {obj_name}')
        return

    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    for idx, mod in enumerate(list(mirror_mods)):
        try:
            bpy.ops.object.modifier_apply(modifier=mod.name)
            print(f'SHOE_MIRROR_APPLIED {obj_name}:mirror#{idx}')
        except Exception as e:
            print(f'SHOE_MIRROR_APPLY_FAILED {obj_name}:mirror#{idx} err={e!r}')


def patch_gltf_exporter_for_invalid_texture_indexes():
    from io_scene_gltf2.io.com import gltf2_io

    orig_mat_to_dict = gltf2_io.Material.to_dict
    orig_tex_to_dict = gltf2_io.TextureInfo.to_dict
    orig_norm_to_dict = gltf2_io.MaterialNormalTextureInfoClass.to_dict
    orig_occ_to_dict = gltf2_io.MaterialOcclusionTextureInfoClass.to_dict

    def coerce(v):
        if isinstance(v, bool):
            raise ValueError
        if isinstance(v, int):
            return v
        if isinstance(v, float):
            return int(v)
        if isinstance(v, str):
            s = ''.join(ch for ch in v if ch.isdigit() or ch == '-')
            if s and s != '-':
                return int(s)
        if isinstance(v, (list, tuple)) and v:
            return coerce(v[0])
        if hasattr(v, 'index'):
            return coerce(getattr(v, 'index'))
        raise ValueError

    def sanitize_texture_info(tex_info, label):
        if tex_info is None:
            return None
        raw = getattr(tex_info, 'index', None)
        try:
            tex_info.index = coerce(raw)
            return tex_info
        except Exception:
            print(f'PATCH drop invalid {label}.index={raw!r}')
            return None

    def safe_mat_to_dict(self):
        pbr = getattr(self, 'pbr_metallic_roughness', None)
        if pbr is not None:
            pbr.base_color_texture = sanitize_texture_info(getattr(pbr, 'base_color_texture', None), 'pbr.baseColorTexture')
            pbr.metallic_roughness_texture = sanitize_texture_info(getattr(pbr, 'metallic_roughness_texture', None), 'pbr.metallicRoughnessTexture')

        self.normal_texture = sanitize_texture_info(getattr(self, 'normal_texture', None), 'normalTexture')
        self.occlusion_texture = sanitize_texture_info(getattr(self, 'occlusion_texture', None), 'occlusionTexture')
        et = getattr(self, 'emissive_texture', None)
        if et is not None:
            try:
                et.index = coerce(getattr(et, 'index', None))
            except Exception:
                print(f'PATCH drop invalid emissiveTexture index={getattr(et, "index", None)!r} mat={getattr(self, "name", "<unnamed>")}')
                self.emissive_texture = None

        return orig_mat_to_dict(self)

    def safe_tex_to_dict(self):
        if sanitize_texture_info(self, 'TextureInfo') is None:
            self.index = 0
        return orig_tex_to_dict(self)

    def safe_norm_to_dict(self):
        if sanitize_texture_info(self, 'NormalTextureInfo') is None:
            self.index = 0
        return orig_norm_to_dict(self)

    def safe_occ_to_dict(self):
        if sanitize_texture_info(self, 'OcclusionTextureInfo') is None:
            self.index = 0
        return orig_occ_to_dict(self)

    gltf2_io.Material.to_dict = safe_mat_to_dict
    gltf2_io.TextureInfo.to_dict = safe_tex_to_dict
    gltf2_io.MaterialNormalTextureInfoClass.to_dict = safe_norm_to_dict
    gltf2_io.MaterialOcclusionTextureInfoClass.to_dict = safe_occ_to_dict


def patch_gltf_temp_image_encoder():
    from io_scene_gltf2.blender.exp.material import encode_image as gltf_encode_image

    temp_root = r"C:\Users\Willp\Documents\GitHub\Wabi\exports\tmp\blender-temp"
    os.makedirs(temp_root, exist_ok=True)

    ext_by_format = {
        'PNG': '.png',
        'JPEG': '.jpg',
        'WEBP': '.webp',
    }

    def safe_encode_temp_image(tmp_image, file_format, export_settings):
        ext = ext_by_format.get(file_format, '.img')
        tmpfilename = os.path.join(temp_root, f'gltfimg_{uuid.uuid4().hex}{ext}')
        original_format = tmp_image.file_format
        try:
            tmp_image.file_format = file_format
            tmp_image.save_render(tmpfilename)
            with open(tmpfilename, 'rb') as f:
                return f.read()
        except Exception as e:
            export_settings['log'].error('Error while saving image (patched): %s' % e)
            return b''
        finally:
            tmp_image.file_format = original_format

    gltf_encode_image._encode_temp_image = safe_encode_temp_image


def prepare_external_face_image(image):
    if image is None:
        return None
    texture_dir = r"C:\Users\Willp\Documents\GitHub\Wabi\exports\tmp\textures"
    os.makedirs(texture_dir, exist_ok=True)
    texture_path = os.path.join(texture_dir, "head_uv_unpacked.png")
    try:
        image.save_render(texture_path)
        loaded = bpy.data.images.load(texture_path, check_existing=True)
        print("FACE_TEXTURE_EXTERNAL", texture_path)
        return loaded
    except Exception as error:
        print("FACE_TEXTURE_EXTERNAL_FAILED", repr(error))
        return image


# Build glTF-friendly skin materials
body_mat = bpy.data.materials.get('Body uv')
face_mat = bpy.data.materials.get('face uv')
face_skin = prepare_external_face_image(bpy.data.images.get('Head uv unwraped.png'))

if body_mat is not None:
    # Keep body tone stable (avoid broken UV/UDIM fallback that caused dark patches).
    ensure_principled_pipeline(body_mat, image=None, fallback_color=(0.92, 0.76, 0.67, 1.0), use_existing_color_socket=False)
    print('BODY_MAT_FIXED baseColor=const')
    debug_basecolor_link(body_mat)
else:
    print('BODY_MAT_MISSING')

if face_mat is not None:
    # Keep explicit head texture to avoid face disappearing.
    ensure_principled_pipeline(face_mat, image=face_skin, use_existing_color_socket=(face_skin is None))
    print('FACE_MAT_FIXED image=', getattr(face_skin, 'name', None))
    debug_basecolor_link(face_mat)
else:
    print('FACE_MAT_MISSING')

# Apply shoe mirror so both shoes are real geometry.
apply_mirror_modifier('Plane.001')

armatures = [o.name for o in bpy.data.objects if o.type == 'ARMATURE']
print('ARMATURES', armatures)

if USE_TEXTURE_INDEX_PATCH:
    patch_gltf_exporter_for_invalid_texture_indexes()
if USE_TEMP_IMAGE_ENCODER_PATCH:
    patch_gltf_temp_image_encoder()

os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)

result = bpy.ops.export_scene.gltf(
    filepath=OUT_PATH,
    export_format='GLB',
    use_selection=False,
    export_apply=False,
    export_materials='EXPORT',
    export_keep_originals=False,
    export_image_format='AUTO',
    export_skins=True,
    export_all_influences=True,
    export_animations=True,
    export_def_bones=False,
    export_force_sampling=True,
    export_rest_position_armature=True,
)
print('EXPORT_RESULT', result)
print('EXPORT_PATH', OUT_PATH)

if os.path.isfile(OUT_PATH):
    try:
        shutil.copy2(OUT_PATH, DOWNLOADS_COPY)
        print('COPIED_TO', DOWNLOADS_COPY)
    except Exception as e:
        print('COPY_FAILED', repr(e))
