import bpy
print('SCENE', bpy.context.scene.name)
print('---MESH OBJECTS---')
for o in bpy.data.objects:
    if o.type!='MESH':
        continue
    mods=[m.type+(':'+m.name if m.name else '') for m in o.modifiers]
    mats=[m.name for m in o.data.materials if m]
    print(o.name, '| hidden_view=',o.hide_get(),'| hidden_render=',o.hide_render,'| verts=',len(o.data.vertices),'| mods=',mods,'| mats=',mats)
print('---HEAD CANDIDATES---')
for o in bpy.data.objects:
    if o.type!='MESH':
        continue
    n=o.name.lower()
    if any(t in n for t in ['head','face','body']):
        print('obj',o.name,'hidden',o.hide_get(),o.hide_render,'mats',[m.name for m in o.data.materials if m])
print('---MATERIAL SUMMARY---')
for m in bpy.data.materials:
    n=m.name.lower()
    if any(t in n for t in ['face','body','skin','hair','shoe']):
        print('mat',m.name,'blend',getattr(m,'blend_method',None),'shadow',getattr(m,'shadow_method',None),'nodes',m.use_nodes)
        if m.use_nodes and m.node_tree:
            for node in m.node_tree.nodes:
                if node.type=='TEX_IMAGE':
                    img=node.image
                    if img:
                        print('  img',img.name,'source',img.source,'packed',bool(img.packed_file),'filepath',img.filepath)
