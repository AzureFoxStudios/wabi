#!/usr/bin/env bash
# Bundle the GStreamer appsink plugin WebKit needs for media in the Linux AppImage.
set -euo pipefail

appimage="${1:?Usage: scripts/finalize-linux-appimage.sh path/to/Wabi.AppImage}"
plugin="${WABI_GST_APP_PLUGIN:-/usr/lib64/gstreamer-1.0/libgstapp.so}"
scanner="${WABI_GST_PLUGIN_SCANNER:-/usr/libexec/gstreamer-1.0/gst-plugin-scanner}"
for required in "$appimage" "$plugin" "$scanner"; do
  test -f "$required" || { echo "Missing: $required" >&2; exit 1; }
done
command -v mksquashfs >/dev/null || { echo 'mksquashfs is required' >&2; exit 1; }
appimage="$(realpath "$appimage")"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
offset="$("$appimage" --appimage-offset)"
(cd "$scratch" && "$appimage" --appimage-extract >/dev/null)
appdir="$scratch/squashfs-root"
mkdir -p "$appdir/usr/lib/gstreamer-1.0" "$appdir/usr/libexec/gstreamer-1.0"
cp "$plugin" "$appdir/usr/lib/gstreamer-1.0/libgstapp.so"
cp "$scanner" "$appdir/usr/libexec/gstreamer-1.0/gst-plugin-scanner"
python3 - "$appdir/AppRun" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
launch = 'exec "$this_dir"/AppRun.wrapped "$@"'
assert source.count(launch) == 1, 'Unexpected AppRun launch script'
if '# GStreamer searches this bundled plugin' not in source:
    source = source.replace(launch, '''# GStreamer searches this bundled plugin before starting WebKit media playback.
export GST_PLUGIN_PATH_1_0="$this_dir/usr/lib/gstreamer-1.0${GST_PLUGIN_PATH_1_0:+:$GST_PLUGIN_PATH_1_0}"
export GST_PLUGIN_SCANNER="$this_dir/usr/libexec/gstreamer-1.0/gst-plugin-scanner"
''' + launch)
path.write_text(source)
PY
head -c "$offset" "$appimage" > "$scratch/runtime"
mksquashfs "$appdir" "$scratch/filesystem.squashfs" -noappend -all-root -comp zstd -b 131072 -no-progress >/dev/null
cat "$scratch/runtime" "$scratch/filesystem.squashfs" > "$scratch/Wabi.AppImage"
chmod +x "$scratch/Wabi.AppImage"
test "$("$scratch/Wabi.AppImage" --appimage-offset)" = "$offset"
mv "$scratch/Wabi.AppImage" "$appimage"
echo "Bundled GStreamer appsink and plugin scanner in $appimage"
