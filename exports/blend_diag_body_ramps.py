import bpy
m=bpy.data.materials.get('Body uv')
if not m or not (m.use_nodes and m.node_tree):
    print('NO_BODY_MAT')
    raise SystemExit
for n in m.node_tree.nodes:
    if n.type=='VALTORGB':
        print('RAMP',n.name)
        for e in n.color_ramp.elements:
            print('  stop',e.position,'color',tuple(round(c,4) for c in e.color))
    if n.type=='MIX':
        print('MIX',n.name)
        for s in n.inputs:
            if s.name in ['Factor','A','B']:
                dv=s.default_value
                try:
                    if hasattr(dv,'__len__'):
                        dv=tuple(round(x,4) for x in dv)
                    else:
                        dv=round(float(dv),4)
                except Exception:
                    pass
                print('  input',s.name,'default',dv,'linked',bool(s.links))
