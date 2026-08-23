# t_62ddc97f — Layer panel polish

Commit: a797dae (hy3-free worker, orchestrator-verified).

## What
- Segmented "+ Vector | + Paint" add control (.layer-add-seg) replacing two loose buttons.
- Inspector range input styled to match .wb-brush-slider (thin track, round accent thumb, hover scale, -moz variant).
- All inline SVGs normalized to stroke-width 1.5 / viewBox 0 0 20 20.
- Rename flow, drag-reorder, store calls, ARIA untouched.

## Verification
- svelte-check with ONLY peer WIP stashed: 0 errors. The 2 errors seen in the dirty tree are the peer session's in-flight ChannelSidebar.svelte glimpse work (uncommitted, restored intact after verification).
- STATIC_BUILD build green.
