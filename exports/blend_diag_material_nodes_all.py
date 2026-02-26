import bpy
for mat_name in ['Body uv','face uv']:
    m=bpy.data.materials.get(mat_name)
    if not m:
        continue
    print('===',m.name,'===')
    nt=m.node_tree
    for n in nt.nodes:
        print('NODE',n.name,'type',n.type)
        if n.type=='TEX_IMAGE' and n.image:
            i=n.image
            print('  IMAGE',i.name,'source',i.source,'packed',bool(i.packed_file),'filepath',i.filepath,'size',i.size[:])
    for l in nt.links:
        print('LINK',l.from_node.name,l.from_socket.name,'->',l.to_node.name,l.to_socket.name)
