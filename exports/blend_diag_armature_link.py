import bpy
print('ARMATURES', [o.name for o in bpy.data.objects if o.type=='ARMATURE'])
body=bpy.data.objects.get('body')
if body:
    print('BODY_MODS', [(m.name,m.type, getattr(m,'object',None).name if getattr(m,'object',None) else None) for m in body.modifiers])
