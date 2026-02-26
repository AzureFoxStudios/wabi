import bpy
obj=bpy.data.objects.get('body')
if not obj:
    print('NO_BODY')
    raise SystemExit
print('BODY_MATERIAL_SLOTS')
for i,m in enumerate(obj.data.materials):
    print(i,m.name if m else None)
counts={i:0 for i in range(len(obj.data.materials))}
for p in obj.data.polygons:
    counts[p.material_index]=counts.get(p.material_index,0)+1
print('POLY_COUNTS')
for i,c in sorted(counts.items()):
    m=obj.data.materials[i].name if i<len(obj.data.materials) and obj.data.materials[i] else None
    print(i,m,c)
