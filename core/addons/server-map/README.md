# Maps addon (`server-map`)

Maps is a bundled frontend addon. Core Wabi keeps only navigation/reference seams; map feature UI lives under `frontend/src/lib/addons/server-map/`.

## Current surfaces

- OpenStreetMap place view
- Uploaded custom maps / floorplans
- Multiple map layers
- Points of interest
- Addon workspace in full, compact/right-panel, and detached surfaces
- Board tokens rendered on custom maps

## Board tokens

Tokens are deliberately separate from persistent POIs. A token is a movable collaborative object with normalized `(x, y)` coordinates, label, glyph, owner and visibility policy.

The initial implementation persists locally so the UI/data contract can settle without coupling the frontend to a transport. `MapTokenRealtimeAdapter` is the seam for a later STDB/WabiDB implementation. The intended realtime reducer is essentially:

`move_token(token_id, x, y)`

with subscribers receiving authoritative token rows for the current place/map.

## Privacy

Member/location presence must remain opt-in. Community maps should default to user-selected approximate location (city/region or arbitrary pin), never silently publish device GPS coordinates.

## Core boundary

`frontend/src/lib/components/MapWorkspace.svelte` is a compatibility shim only. New map feature work belongs in the addon namespace.
