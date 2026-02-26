import bpy
img=bpy.data.images.get('Head uv unwraped.png')
out=r'C:\Users\Willp\Documents\GitHub\Wabi\exports\tmp\head_test.png'
if img is None:
    print('NO_IMG')
    raise SystemExit
try:
    img.save_render(out)
    print('SAVE_RENDER_OK',out)
except Exception as e:
    print('SAVE_RENDER_FAIL',repr(e))
try:
    img.filepath_raw=out
    img.file_format='PNG'
    img.save()
    print('SAVE_OK',out)
except Exception as e:
    print('SAVE_FAIL',repr(e))
