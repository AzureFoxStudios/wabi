import bpy
print('---MESH INVENTORY START---')
for o in bpy.data.objects:
    if o.type != 'MESH':
        continue
    mats = [m.name if m else '<None>' for m in o.data.materials]
    has_arm = any(mod.type == 'ARMATURE' for mod in o.modifiers)
    print(f"{o.name} | armature={has_arm} | mats={mats}")
print('---MESH INVENTORY END---')
