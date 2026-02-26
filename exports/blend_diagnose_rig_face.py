import bpy
print('---ARMATURES---')
for o in bpy.data.objects:
    if o.type=='ARMATURE':
        print(o.name, 'bones=', len(o.data.bones), 'hidden=', o.hide_get())
print('---MESH ARMATURE LINKS---')
for o in bpy.data.objects:
    if o.type!='MESH':
        continue
    arms=[m.object.name if (m.type=='ARMATURE' and m.object) else None for m in o.modifiers if m.type=='ARMATURE']
    if arms:
        print(o.name, 'armatures=', arms, 'vgroups=', len(o.vertex_groups))
print('---FACE/BODY MATERIALS---')
for m in bpy.data.materials:
    n=m.name.lower()
    if 'face' in n or 'body' in n or 'skin' in n or 'hair' in n:
        blend=getattr(m,'blend_method',None)
        shadow=getattr(m,'shadow_method',None)
        print(m.name, 'blend=', blend, 'shadow=', shadow, 'use_nodes=', m.use_nodes)
        if m.use_nodes and m.node_tree:
            for node in m.node_tree.nodes:
                if node.type=='BSDF_PRINCIPLED':
                    alpha=node.inputs.get('Alpha')
                    if alpha:
                        linked=len(alpha.links)
                        print('  principled alpha default=', alpha.default_value, 'links=', linked)
