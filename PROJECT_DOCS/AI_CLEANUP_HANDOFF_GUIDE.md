# AI Cleanup Handoff Guide

This is the handoff guide for continuing the Wabi cleanup campaign with another AI if you intentionally want another pass.

This is not a microtask guide.
It is the operating brief for continuing the same refactor and code-quality work that has already been happening in this repository.

## Mission

Continue the Wabi codebase cleanup campaign without breaking behavior.

Primary goals:

- keep the repo in a verified state at all times
- reduce `backend/src/server.ts` by extracting coherent runtime and handler clusters
- improve maintainability, typing, contracts, and runtime boundaries
- remove duplication and stale branches only when confidence is high
- prefer structural cleanup over cosmetic churn

## Current Verified State

As of this handoff:

- backend build passes with `npm --prefix backend run build`
- backend tests pass with `npm --prefix backend test`
- frontend check passes with `npm --prefix frontend run check`
- frontend status is `0 errors` and `0 warnings`
- `backend/src/server.ts` is down to `4703` lines

The current cleanup ledger is:

- [CODEBASE_CLEANUP_STATUS.md](/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/PROJECT_DOCS/CODEBASE_CLEANUP_STATUS.md)

Read that first before changing anything.

## What Has Already Been Done

Do not redo these passes.
Build on them.

- request parsing, upload support, role lookup, whiteboard runtime, presence mesh runtime, socket guards, message lifecycle, upload file serving, and safe external fetch are already extracted from `server.ts`
- voice recording runtime, voice channel runtime, group call runtime, group call lifecycle, direct call lifecycle, call signaling relay, peer relay handlers, voice socket handlers, voice breakout handlers, and channel mutation handlers are already extracted
- DM/group conversation handlers and role/moderation handlers are already extracted
- session rejoin/profile update/channel-entry handlers are already extracted
- message pinning/reactions/typing interaction handlers are already extracted
- join initialization is already extracted
- the core message pipeline is already extracted
- disconnect cleanup, socket asset handlers, and thin call socket wrappers are already extracted
- offline message delivery and user-channel hydration/enrichment helpers are already extracted
- plugin/admin/runtime HTTP routes and upload/resumable/telemetry HTTP routes are already extracted
- single-session enforcement, per-socket rate limiting, and role/emoji runtime support are already extracted into dedicated helper modules
- runtime/upload admin contracts and desktop-helper registration contracts are now shared instead of living in separate frontend/backend copies
- launch-page contracts are now shared instead of living in separate frontend/backend copies
- media runtime, TURN, LiveKit token, and media-gateway session contracts are now shared instead of living in separate frontend/backend copies
- auth/session responses, user-settings/follow payloads, relay admin-node metadata, and payment user-block contracts are now shared instead of living in separate frontend/backend copies
- album upload limit typing/defaults/sanitization now live in one backend helper instead of separate `server.ts` and `albumRoutes.ts` copies
- auth/follow/manual-settlement/media/theme/relay/dictionary/webhook/album request bodies now route through the shared `backend/src/utils/requestBodies.ts` utility instead of each file carrying its own JSON-object reader
- backend test coverage now exists for request-body parsing, album upload limit sanitization, and business-data/resource sanitizers
- frontend warning cleanup is complete
- business ingress validation and several backend route/runtime validation improvements are already landed
- payment/admin/business shared contracts have already been consolidated in important areas

## Primary Strategy

The working strategy for this repo is:

1. Keep behavior stable.
2. Extract one coherent runtime or handler cluster at a time.
3. Verify immediately after each pass.
4. Update the cleanup ledger after each stable pass.

Do not do broad repo-wide rewrites.
Do not mix many unrelated cleanup themes into one pass.

## Working Rules

### 1. Prefer structural seams over line-count chasing

Reducing `server.ts` line count matters, but only as a side effect.
The real objective is moving whole responsibilities into understandable modules.

Good extractions:

- one runtime
- one handler family
- one mutation block
- one policy/helper cluster

Bad extractions:

- moving random helper functions just to shrink the file
- mixing unrelated concerns into one module
- splitting logic so finely that behavior becomes harder to follow

### 2. Preserve behavior first

If an extraction changes behavior, delivery semantics, role checks, cleanup order, or persistence behavior, it is a regression unless intentionally justified and verified.

Watch especially for:

- socket delivery drift
- mesh delivery drift
- permission drift
- cleanup order drift
- persistence drift
- missing plugin/webhook side effects

### 3. Use wrappers instead of capturing unstable runtime state

Where `server.ts` uses mutable helper assignments or late-bound runtime functions, pass wrappers rather than early-capturing placeholder functions.

### 4. Keep event registration shape stable when possible

For socket code, prefer:

- extracted lifecycle functions called by existing listeners
- or extracted handler registration modules that still register the same event names

Do not redesign the event system unless absolutely necessary.

### 5. Only remove fallback paths with evidence

Delete fallback or legacy logic only when:

- there is a clear modern replacement
- the old path is no longer part of active behavior
- verification still passes after removal

## Required Verification

After each meaningful cleanup pass, run:

```bash
npm --prefix /home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/backend test
npm --prefix /home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/backend run build
npm --prefix /home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/frontend run check
```

Do not call a pass complete without all three succeeding, unless the task is strictly docs-only.

## Current Status

The cleanup campaign is effectively complete.

If another AI is used here, it should not assume there is still a large unfinished monolith rescue to perform. Any follow-on work is optional polish:

- more targeted tests around extracted runtime modules and sanitizer-heavy helpers
- residual DTO cleanup only where duplication clearly remains
- very small orchestration polish where a future change directly benefits from it

Treat this as maintenance work, not a mandatory continuation of the original campaign.

## What To Avoid Right Now

- redesigning presence or mesh delivery
- redesigning plugin architecture
- changing event names or payload formats casually
- bulk deleting migration/fallback code without tracing usage
- mixing cleanup with feature work
- introducing new dependencies just to make refactoring easier

## Recommended File-By-File Starting Set

Start with these if you intentionally want another cleanup-oriented pass:

- [CODEBASE_CLEANUP_STATUS.md](/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/PROJECT_DOCS/CODEBASE_CLEANUP_STATUS.md)
- [server.ts](/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/backend/src/server.ts)
- [runtimeAdminRoutes.ts](/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/backend/src/api/runtimeAdminRoutes.ts)
- [uploadRoutes.ts](/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/backend/src/api/uploadRoutes.ts)
- [runtimeAdminContracts.ts](/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/shared/runtimeAdminContracts.ts)
- [launchPageContracts.ts](/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/shared/launchPageContracts.ts)
- [mediaContracts.ts](/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/shared/mediaContracts.ts)
- [userContracts.ts](/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/shared/userContracts.ts)
- [relayContracts.ts](/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/shared/relayContracts.ts)
- [albumUploadLimits.ts](/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/backend/src/services/albumUploadLimits.ts)
- [requestBodies.ts](/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/backend/src/utils/requestBodies.ts)
- [requestBodies.test.ts](/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/backend/src/utils/requestBodies.test.ts)
- [validation.test.ts](/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/backend/src/business/validation.test.ts)
- [albumUploadLimits.test.ts](/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/backend/src/services/albumUploadLimits.test.ts)
- [offlineMessageDelivery.ts](/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/backend/src/services/offlineMessageDelivery.ts)
- [userChannelViews.ts](/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/backend/src/services/userChannelViews.ts)
- [registeredSocketSessions.ts](/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/backend/src/services/registeredSocketSessions.ts)
- [socketRateLimit.ts](/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/backend/src/services/socketRateLimit.ts)
- [roleRuntimeSupport.ts](/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/backend/src/services/roleRuntimeSupport.ts)
- [roleModerationHandlers.ts](/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/backend/src/services/roleModerationHandlers.ts)

## Completion Standard For A Pass

A pass is complete only when:

1. the extracted module is coherent
2. the old inline logic is removed
3. backend tests pass
4. backend build passes
5. frontend check passes
6. the cleanup ledger is updated

## Reporting Format

After each pass, report in this format:

```text
Changed:
- <high-level extraction or cleanup>
- <high-level extraction or cleanup>

Verified:
- npm --prefix backend run build
- npm --prefix frontend run check

Current state:
- server.ts line count: <number>

Next target:
- <next seam>
```

## Prompt To Give Another AI

Use this as the base prompt:

```text
You are continuing the Wabi cleanup campaign in:
/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi

Read first:
- PROJECT_DOCS/CODEBASE_CLEANUP_STATUS.md
- PROJECT_DOCS/AI_CLEANUP_HANDOFF_GUIDE.md

Mission:
- continue structural code cleanup without breaking behavior
- keep the repo in a verified state
- extract coherent handler/runtime clusters from backend/src/server.ts
- improve maintainability and typing
- do not do broad rewrites

Rules:
- preserve behavior first
- verify after each pass with:
  npm --prefix backend run build
  npm --prefix backend test
  npm --prefix frontend run check
- update PROJECT_DOCS/CODEBASE_CLEANUP_STATUS.md after each stable pass
- prefer one coherent extraction at a time

Best next target:
- targeted tests for extracted runtime/socket helpers, or a concrete DTO duplicate that is still worth sharing

After that:
- return to feature work

When reporting back, use:
Changed:
- ...

Verified:
- ...

Current state:
- server.ts line count: ...

Next target:
- ...
```

## Prompt For A Review-Only AI

If using a second model as reviewer rather than implementer:

```text
Read only:
- backend/src/server.ts
- the newly extracted module
- PROJECT_DOCS/CODEBASE_CLEANUP_STATUS.md

Task:
Review whether the extraction preserved behavior.

Focus only on:
- permission drift
- socket/mesh delivery drift
- cleanup order drift
- persistence side effects
- missing plugin/webhook notifications

Output:
REGRESSIONS:
- ...

RISKY ASSUMPTIONS:
- ...

SAFE NEXT STEP:
- ...
```

## Final Note

The repo is no longer in “repair random slop” mode.
It is in the last major cleanup phase:

- extracting the remaining central backend handler families
- consolidating contracts
- tightening boundaries

Treat it like modularization work on a live system, not a greenfield rewrite.
