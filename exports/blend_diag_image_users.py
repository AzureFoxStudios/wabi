import bpy
img_name='new'
img=bpy.data.images.get(img_name)
if not img:
    print('NO_IMAGE',img_name)
    raise SystemExit
for m in bpy.data.materials:
    if not (m.use_nodes and m.node_tree):
        continue
    for n in m.node_tree.nodes:
        if n.type=='TEX_IMAGE' and n.image==img:
            print('MATERIAL_USES_IMAGE',m.name,'node',n.name)
