import bpy
for mat_name in ['Body uv','face uv','hair']:
    m=bpy.data.materials.get(mat_name)
    if not m:
        print('MISSING_MAT',mat_name)
        continue
    print('---',m.name,'blend',getattr(m,'blend_method',None),'shadow',getattr(m,'shadow_method',None),'---')
    if not (m.use_nodes and m.node_tree):
        print('NO_NODES')
        continue
    nt=m.node_tree
    for n in nt.nodes:
        if n.type=='TEX_IMAGE':
            img=n.image
            if img:
                print('IMG_NODE',n.name,'image',img.name,'source',img.source,'packed',bool(img.packed_file),'filepath',img.filepath)
            else:
                print('IMG_NODE',n.name,'image NONE')
        elif n.type=='BSDF_PRINCIPLED':
            bc=n.inputs.get('Base Color')
            al=n.inputs.get('Alpha')
            if bc:
                if bc.links:
                    print('PRINCIPLED_BC_LINK',bc.links[0].from_node.name,bc.links[0].from_socket.name)
                else:
                    print('PRINCIPLED_BC_CONST',bc.default_value[:])
            if al:
                if al.links:
                    print('PRINCIPLED_ALPHA_LINK',al.links[0].from_node.name,al.links[0].from_socket.name)
                else:
                    print('PRINCIPLED_ALPHA_CONST',al.default_value)
    # print link summary
    for l in nt.links:
        if l.to_node.type=='BSDF_PRINCIPLED' and l.to_socket.name in ['Base Color','Alpha']:
            print('LINK',l.from_node.name,l.from_socket.name,'->',l.to_node.name,l.to_socket.name)
