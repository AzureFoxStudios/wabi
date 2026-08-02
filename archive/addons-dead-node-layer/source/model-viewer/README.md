# Model Viewer Plugin

Non-essential UI plugin that enables inline 3D model viewing in chat.

## Install (first-time user)

This test plugin is not auto-loaded from `TEST/`.  
You must install it into `plugins/` first.

Any OS:

```bash
npm run plugin:install:test
```

Optional custom test plugin name:

```bash
npm run plugin:install:test -- my-plugin-name
```

Then restart backend (or full dev stack) so it loads the plugin.

## Scope

- View only (no modeling/editing)
- Supports `.glb`, `.gltf`, `.obj`, `.stl`
- Orbit controls: rotate, zoom, pan
- Threading toggle: `Auto`, `Always Multi-thread`, `Single-thread`
- `.blend` import settings modal (queue-only)

## Blend Queue API

- `GET /api/plugins/runtime/model-viewer/blend/capabilities`
- `GET /api/plugins/runtime/model-viewer/blend/jobs?limit=25`
- `POST /api/plugins/runtime/model-viewer/blend/jobs`
- `POST /api/plugins/runtime/model-viewer/blend/job/cancel`

Notes:
- This plugin queues validated conversion jobs but does not ship a Blender executor.
- Intended for pipeline testing and later worker integration.
