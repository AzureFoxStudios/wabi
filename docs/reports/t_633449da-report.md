# t_633449da — Chrome positioning cleanup (CSS custom props)

Commit: 4cdbbd3 (hy3-free worker, orchestrator-verified).

## What
- .whiteboard-shell now defines --wb-toolbar-top / --wb-panel-top / --wb-chrome-gap (desktop 4.25rem) + mobile overrides; all magic-number tops in WhiteboardTab.svelte consume the props.
- .wb-toolbar-rail in WhiteboardToolbar.svelte uses var(--wb-chrome-top, fallback) for standalone use.

## Verification
- svelte-check: 0 errors with whiteboard changes in place. (17 transient errors during the check window were the peer session's in-progress calling refactor — deleted callingMediaGateway/callingStorefwd + modified calling_impl_core; verified by stashing peer WIP → 0 errors → restoring WIP.)
- Build: first run failed on the same peer-deleted files; restored them from git (git checkout --), clean rerun green. Peer's modified calling_impl_core.ts left untouched.

## Note
Shared-tree churn from the peer calling session is active in this worktree; whiteboard files themselves are all committed and clean.
