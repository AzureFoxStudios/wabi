from io_scene_gltf2.io.com import gltf2_io
for n in dir(gltf2_io):
    if 'TextureInfo' in n or 'MaterialPBR' in n or n=='Material':
        obj=getattr(gltf2_io,n)
        if hasattr(obj,'to_dict'):
            print(n)
