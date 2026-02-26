import bpy
img=bpy.data.images.get('new')
if not img:
    print('NO_IMAGE')
    raise SystemExit
print('SOURCE',img.source,'PACKED',bool(img.packed_file),'SIZE',img.size[:],'tiles',len(getattr(img,'tiles',[])))
try:
    for t in img.tiles:
        print(' TILE',t.number,t.label)
except Exception:
    pass
px=img.pixels
print('LEN',len(px))
print('FIRST16',[round(float(v),4) for v in px[:16]])
mid=len(px)//2
print('MID16',[round(float(v),4) for v in px[mid:mid+16]])
