import bpy
print('---IMAGES---')
for i in bpy.data.images:
    print(i.name,'| source',i.source,'| packed',bool(i.packed_file),'| size',i.size[:],'| filepath',i.filepath)
