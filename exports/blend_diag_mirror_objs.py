import bpy
for o in bpy.data.objects:
    if o.type!='MESH':
        continue
    mir=[m for m in o.modifiers if m.type=='MIRROR']
    if mir:
        print('MIRROR_OBJ',o.name,'mods',[m.name for m in mir],'location',tuple(round(v,4) for v in o.location),'scale',tuple(round(v,4) for v in o.scale))
        print('  mats',[m.name for m in o.data.materials if m])
        print('  vgroups_sample',[g.name for g in o.vertex_groups[:10]])
