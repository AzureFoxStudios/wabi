import bpy
for img in bpy.data.images:
    if img.source=='GENERATED':
        px=img.pixels
        ln=len(px)
        if ln>=4:
            # sample first 1000 pixels max
            step=max(4, (ln//4000)*4)
            vals=[]
            for i in range(0,min(ln,step*1000),step):
                vals.append((px[i],px[i+1],px[i+2],px[i+3]))
            avg=[sum(v[j] for v in vals)/len(vals) for j in range(4)]
            print('GEN',img.name,'size',img.size[:],'avg_rgba',avg[:])
        else:
            print('GEN',img.name,'EMPTY')
