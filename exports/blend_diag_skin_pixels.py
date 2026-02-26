import bpy
img=bpy.data.images.get('skin base ao')
if not img:
    print('NO_IMAGE')
    raise SystemExit
px=img.pixels
print('LEN',len(px),'SIZE',img.size[:],'SOURCE',img.source,'PACKED',bool(img.packed_file))
print('FIRST16', [round(float(v),4) for v in px[:16]])
# sample middle and end
mid=len(px)//2
print('MID16', [round(float(v),4) for v in px[mid:mid+16]])
print('END16', [round(float(v),4) for v in px[-16:]])
